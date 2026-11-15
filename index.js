/**
 * Local CLI bridge: a loopback-only HTTP endpoint that drives this running
 * Harness instance, plus the `dsh-ask` command that talks to it.
 *
 * The whole point is to reach *this* Host process - the one the Desktop app
 * already runs - instead of booting a second profile. It therefore drives
 * `sessionController`, the same service the Web GUI calls: create or adopt a
 * Session, admit one prompt, then wait for the turn to go quiet and hand the
 * assistant text back.
 *
 * Security posture:
 * - every route is registered under `/local-cli`
 * - a request must arrive from a loopback socket address
 * - and must carry the token from `$DSH_HOME/local-cli/token` (0600)
 * The token file is created on first use; nothing listens off-machine.
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildPromptContent, IMAGE_BODY_LIMIT_BYTES, imageCapabilities, validateImages } from './images.js'
import { registerPermissionRoutes } from './permissions.js'
import { createApprovalChannel } from './approval-channel.js'
import { registerApprovalRoutes } from './approval-routes.js'
import { createApprovalTransport } from './approval-transport.js'
import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin config schema. A normal `dependencies` entry supplies schemastery, so
 * the loader validates the profile value and can serialize the schema for the
 * plugin's settings page - a missing dependency is a hard load failure, never a
 * silent "no settings" mode.
 *
 * `language` is volatile: the settings service may write it without remounting
 * the plugin, and `apply` receives a live reference whose `get()` always yields
 * the value currently committed. The locale keys follow schemastery's `i18n`
 * contract: a `{ locale: ... }` map keyed by config field, with the three union
 * members localized by position, which is the shape a schema-driven form reads.
 */
export const Config = Schema.object({
  language: Schema.union([Schema.const('auto'), Schema.const('zh'), Schema.const('en')])
    .default('auto')
    .volatile()
    .description({
      '': 'dsh-ask interface language; auto follows the CLI flags and the locale.',
      zh: 'dsh-ask 的界面语言：auto 跟随 CLI 参数与系统 locale，zh/en 固定中文或英文。',
      en: 'dsh-ask interface language: auto follows the CLI flags and the locale; zh/en pin Chinese or English.',
    }),
}).i18n({
  zh: { language: ['自动：跟随 CLI 参数与系统 locale', '中文界面', '英文界面'] },
  en: {
    language: [
      'Automatic: follow the CLI flags and the locale',
      'Chinese interface',
      'English interface',
    ],
  },
})

export const name = 'local-cli'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
// One JSON body for /local-cli/ask and /local-cli/stream: 18 MiB, enough for
// 12 MiB of decoded images (about 16 MiB of base64) plus envelope overhead.
const BODY_LIMIT = IMAGE_BODY_LIMIT_BYTES
const DEFAULT_TIMEOUT = 180_000
const MAX_TIMEOUT = 900_000

function stateDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'local-cli')
}

function warn(ctx, message) {
  try {
    ctx.logger('local-cli').warn(message)
  } catch {
    console.error('[local-cli]', message)
  }
}

async function ensureToken() {
  const dir = stateDir()
  const file = join(dir, 'token')
  try {
    const current = (await readFile(file, 'utf8')).trim()
    if (current.length >= 32) return current
  } catch {
    // Missing or unreadable: mint a fresh one below.
  }
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return token
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      throw new Error(`request body exceeds ${BODY_LIMIT} bytes (${BODY_LIMIT / (1024 * 1024)} MiB)`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function reply(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function lastSeq(records) {
  let seq = 0
  for (const record of records) {
    if (record?.type === 'event' && typeof record.event?.seq === 'number') {
      seq = Math.max(seq, record.event.seq)
    }
  }
  return seq
}

function collect(records) {
  const texts = []
  const failures = []
  let toolCalls = 0
  for (const record of records) {
    if (record?.type !== 'event') continue
    const event = record.event
    if (event?.type === 'tool/call') toolCalls += 1
    if (event?.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          texts.push(block.text)
        }
      }
    }
    if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      failures.push(String(event.data.reason.error?.message ?? 'model error'))
    }
  }
  return { text: texts.join('\n\n').trim(), toolCalls, failures }
}

function firstUserText(records) {
  for (const record of records) {
    if (record?.type !== 'event') continue
    const event = record.event
    if (event?.type !== 'user/message') continue
    const parts = []
    for (const block of event.data?.message?.content ?? event.data?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * Read one config field that may be a live volatile reference (the Host hands
 * volatile fields over as `{ get() }`) or a plain value (schema-less mount,
 * tests, profile overlays). Every call re-reads, so a settings write is visible
 * immediately without a plugin remount.
 */
function configFieldValue(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

/** The CLI-facing language preference: only zh/en are opinions; auto is none. */
function languagePreference(config) {
  const value = configFieldValue(config?.language, 'auto')
  return value === 'zh' || value === 'en' ? value : 'auto'
}

export function apply(ctx, config) {
  const pending = { token: ensureToken() }
  const abort = new AbortController()

  function registry() {
    const service = ctx.workspaceRegistry
    if (service === undefined) throw new Error('workspaceRegistry is not available in this profile')
    return service
  }

  function expandHome(reference) {
    if (reference === '~') return homedir()
    if (reference.startsWith('~/')) return join(homedir(), reference.slice(2))
    return reference
  }

  function workspaceView(workspace) {
    if (workspace === undefined) return undefined
    return {
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      sessions: (workspace.sessionIds ?? []).length,
    }
  }

  /**
   * Resolve a workspace by id, id prefix, title or path. With `create`, a value
   * that matches nothing and looks like a path becomes a new workspace: the
   * directory is created when missing, then registered (the registry is
   * idempotent on a canonical path).
   */
  async function resolveWorkspace(reference, create) {
    if (reference === undefined || reference === '') return { workspace: undefined }
    const all = registry().list()

    const byId = all.find((workspace) => String(workspace.id) === reference)
    if (byId !== undefined) return { workspace: byId }

    const prefixed = all.filter((workspace) => String(workspace.id).startsWith(reference))
    if (prefixed.length === 1) return { workspace: prefixed[0] }
    if (prefixed.length > 1) {
      return { error: `${prefixed.length} workspaces start with ${JSON.stringify(reference)}` }
    }

    const titled = all.filter((workspace) => workspace.title === reference)
    if (titled.length === 1) return { workspace: titled[0] }
    if (titled.length > 1) {
      return { error: `${titled.length} workspaces are titled ${JSON.stringify(reference)}; use an id` }
    }

    const byPath = all.find((workspace) => workspace.path === expandHome(reference))
    if (byPath !== undefined) return { workspace: byPath }

    if (create === true) {
      const target = expandHome(reference)
      await mkdir(target, { recursive: true })
      const created = await registry().create(target)
      return { workspace: created, created: true }
    }
    return {
      error: `no workspace matches ${JSON.stringify(reference)} (pass createWorkspace to register a path)`,
    }
  }

  /** Canonical absolute path for cwd/workspace comparisons; creates nothing. */
  function canonicalPath(reference) {
    const absolute = resolve(expandHome(String(reference)))
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }

  const SESSIONS_QUERY_KEYS = new Set(['limit', 'workspace', 'cwd', 'sessionId', 'all'])

  /** One non-empty, single-line query value; identifiers/paths stay byte-exact. */
  function exactQueryValue(value) {
    if (typeof value !== 'string' || value === '' || value.length > 1000) return undefined
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined
    return value
  }

  /** Visible Sessions only: subagent Sessions never consume list slots. */
  async function visibleSessionItems() {
    const listed = await ctx.sessionController.list({}, abort.signal)
    return (listed.items ?? []).filter((item) => item.origin !== 'subagent')
  }

  /** One whitelisted presentation row for a Host summary. */
  async function sessionRow(item) {
    // Prefer the durable title the GUI shows; it is derived from the first
    // eligible human message, which a paged event read does not reliably reach.
    let title = ''
    let preview = ''
    try {
      const projected = await ctx.sessionController.projections(
        { sessionId: item.sessionId },
        abort.signal,
      )
      const values = projected?.values ?? {}
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string' && value.trim() !== '' && /title/i.test(key)) {
          title = value.trim()
        }
      }
    } catch {
      // No projection source in this deployment: fall through to the preview.
    }
    if (item.blank !== true && title === '') {
      try {
        const page = await ctx.sessionController.events(
          { address: { kind: 'session', sessionId: item.sessionId }, maxMessages: 8 },
          abort.signal,
        )
        preview = firstUserText(page.records ?? []).slice(0, 160)
      } catch {
        // A session that cannot be read still lists, just without a preview.
      }
    }
    return {
      sessionId: item.sessionId,
      title,
      preview,
      blank: item.blank === true,
      running: item.running === true,
      updatedAt: item.updatedAt,
      cwd: item.cwd,
    }
  }

  /** Presentation rows for an already-filtered item list, capped by `limit`. */
  async function rowsFor(items, limit) {
    const rows = []
    for (const item of items.slice(0, limit)) rows.push(await sessionRow(item))
    return rows
  }

  /** Backward-compatible global recent list (array, as older callers expect). */
  async function listSessions(limit) {
    return rowsFor(await visibleSessionItems(), limit)
  }

  /** Resolve an explicit workspace reference, including a path alias (symlink). */
  async function workspaceForQuery(reference) {
    const resolved = await resolveWorkspace(reference, false)
    if (resolved.error === undefined && resolved.workspace !== undefined) return { workspace: resolved.workspace }
    if (typeof reference === 'string' && reference !== '') {
      const canonical = canonicalPath(reference)
      const matched = registry().list().find((workspace) => canonicalPath(workspace.path) === canonical)
      if (matched !== undefined) return { workspace: matched }
    }
    return { error: resolved.error ?? `no workspace matches ${JSON.stringify(reference)}` }
  }

  /** Canonical workspace identity used in the sessions response scope. */
  function workspaceScopeView(workspace) {
    return {
      id: String(workspace.id),
      path: canonicalPath(workspace.path),
      title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : null,
    }
  }

  /** The workspace that owns one Session, from the Host registry account. */
  function workspaceOfSession(sessionId) {
    try {
      return registry().list().find((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
    } catch {
      return undefined
    }
  }

  /** Accept a full id, or any unambiguous prefix of one. */
  async function resolveSession(reference) {
    const listed = await ctx.sessionController.list({}, abort.signal)
    const ids = (listed.items ?? []).map((item) => String(item.sessionId))
    if (ids.includes(reference)) return { sessionId: reference }
    const matches = ids.filter((id) => id.startsWith(reference))
    if (matches.length === 1) return { sessionId: matches[0] }
    if (matches.length === 0) return { error: `no Session matches ${JSON.stringify(reference)}` }
    return { error: `${matches.length} Sessions start with ${JSON.stringify(reference)}; use a longer prefix` }
  }

  /**
   * A presentation-ready slice of one Session's history.
   *
   * Only `user/message` events whose source kind is `user` are human turns; the
   * rest of that event type is injected context (runtime snapshot, skill
   * catalog, time context, agent instructions) and would drown the transcript.
   */
  function blocksToText(content) {
    const parts = []
    for (const block of content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  /** Pending input a Session is holding: queued prompts and steering messages. */
  async function queueOf(sessionId) {
    const state = await ctx.sessionController.state({ sessionId }, abort.signal)
    return {
      running: state.running === true,
      pendingInput: state.pendingInput ?? [],
      items: (state.queue ?? []).map((item, index) => ({
        index: index + 1,
        id: String(item.id),
        placement: String(item.placement),
        rpcId: item.rpcId === undefined ? undefined : String(item.rpcId),
        text: blocksToText(item.content),
      })),
    }
  }

  // ------------------------------------------------------------------ status

  /** Cap for the few Host strings the status line may carry. */
  const STATUS_TEXT_MAX = 64

  /** Strip control characters, collapse spaces and cap one Host-supplied label. */
  function statusLabel(value, max = STATUS_TEXT_MAX) {
    if (typeof value !== 'string') return null
    const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    return text === '' ? null : text.slice(0, max)
  }

  const statusCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

  function statusModel(values) {
    const selection = values?.modelSelection
    if (selection === null || typeof selection !== 'object') return null
    const chosen = selection.next ?? selection.lastUsed
    if (chosen === null || typeof chosen !== 'object') return null
    const model = statusLabel(chosen.model)
    if (model === null) return null
    return {
      provider: statusLabel(chosen.provider),
      model,
      effort: statusLabel(chosen.reasoningEffort, 32),
    }
  }

  function statusContext(values) {
    const pressure = values?.contextPressure
    if (pressure === null || typeof pressure !== 'object') return null
    const pressureTokens = statusCount(pressure.pressureTokens)
    const projectedTokens = statusCount(pressure.projectedTokens)
    const contextWindow = statusCount(pressure.contextWindow)
    const usedTokens = projectedTokens ?? pressureTokens
    const percent =
      usedTokens === null || contextWindow === null || contextWindow === 0
        ? null
        : Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    if (usedTokens === null && contextWindow === null) return null
    return { usedTokens, contextWindow, percent, pressureTokens, projectedTokens }
  }

  function statusUsage(values) {
    const usage = values?.tokenUsage
    if (usage === null || typeof usage !== 'object') return null
    const uncachedInputTokens = statusCount(usage.uncachedInputTokens) ?? 0
    const outputTokens = statusCount(usage.outputTokens) ?? 0
    const cacheReadTokens = statusCount(usage.cacheReadTokens) ?? 0
    const cacheWriteTokens = statusCount(usage.cacheWriteTokens) ?? 0
    const billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
    const totalTokens = billedInputTokens + outputTokens
    return {
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      billedInputTokens,
      totalTokens,
      cacheHitPercent: billedInputTokens === 0 ? null : Math.round((cacheReadTokens / billedInputTokens) * 100),
    }
  }

  function statusStats(values) {
    const stats = values?.sessionStats
    if (stats === null || typeof stats !== 'object') return null
    const decodeMs = statusCount(stats.decodeMs) ?? 0
    const decodeTokens = statusCount(stats.decodeTokens) ?? 0
    return {
      turns: statusCount(stats.turns) ?? 0,
      steps: statusCount(stats.steps) ?? 0,
      llmMs: statusCount(stats.llmMs) ?? 0,
      toolMs: statusCount(stats.toolMs) ?? 0,
      ttftMs: statusCount(stats.ttftMs) ?? 0,
      ttftSteps: statusCount(stats.ttftSteps) ?? 0,
      decodeMs,
      decodeTokens,
      tokensPerSecond: decodeMs === 0 ? null : decodeTokens / (decodeMs / 1000),
    }
  }

  /**
   * White-listed status snapshot for one Session.
   *
   * Only the projections the desktop status line reads (model selection,
   * context pressure, cumulative token buckets, session stats, permission
   * preset) and the passive run state are projected. The raw projection map,
   * Session header, provider config and credentials never cross this boundary,
   * and every Host-supplied string is stripped of control characters and
   * capped. A Host missing one of the reads, or missing values, yields `null`
   * fields so consumers render "—" instead of guessing.
   */
  async function statusOf(sessionId) {
    const status = {
      sessionId,
      model: null,
      context: null,
      usage: null,
      stats: null,
      permission: null,
      running: false,
      queue: 0,
      pendingInput: [],
    }
    const [projected, passive] = await Promise.allSettled([
      ctx.sessionController.projections({ sessionId }, abort.signal),
      ctx.sessionController.state({ sessionId }, abort.signal),
    ])
    if (projected.status === 'fulfilled') {
      const values = projected.value?.values ?? {}
      status.model = statusModel(values)
      status.context = statusContext(values)
      status.usage = statusUsage(values)
      status.stats = statusStats(values)
      status.permission = statusLabel(values?.permissions?.currentValue, 32)
    }
    if (passive.status === 'fulfilled') {
      status.running = passive.value?.running === true
      status.queue = Array.isArray(passive.value?.queue) ? passive.value.queue.length : 0
      status.pendingInput = (Array.isArray(passive.value?.pendingInput) ? passive.value.pendingInput : [])
        .map((kind) => statusLabel(kind, 16))
        .filter((kind) => kind === 'approval' || kind === 'question' || kind === 'other')
    }
    return status
  }

  /**
   * Validate one prompt body and build the content parts both prompt routes
   * send. A body that JSON-decoded to null or a primitive (string, number,
   * boolean) is not a request object at all, so it is rejected as
   * `invalid-body` instead of failing on a property read outside validation.
   * Image validation happens here, before any Session is resolved or created,
   * so a rejected payload leaves no session behind. Text alone keeps working
   * unchanged; images alone are allowed; both together keep text first.
   */
  function promptPayload(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { error: { code: 'invalid-body', error: 'request body must be a JSON object' } }
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const validated = validateImages(body.images)
    if (validated.ok !== true) return { error: validated.error }
    if (text === '' && validated.images.length === 0) {
      return { error: { code: 'text-required', error: 'text is required' } }
    }
    return {
      text,
      images: validated.images,
      content: buildPromptContent(text, validated.images),
    }
  }

  /** Structured 400 for a rejected prompt body; never echoes payload bytes. */
  function replyInvalidPayload(res, error) {
    const payload = { ok: false, code: error.code, error: error.error }
    if (error.index !== undefined) payload.index = error.index
    return reply(res, 400, payload)
  }

  function failureDetails(error) {
    if (error === null || typeof error !== 'object') return {}
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : undefined
    const details = error.details ?? error.data
    const reason =
      details !== null && typeof details === 'object' && typeof details.reason === 'string'
        ? details.reason
        : typeof error.reason === 'string'
          ? error.reason
          : undefined
    return { code, reason }
  }

  /**
   * Normalize a sessionController.prompt rejection into one structured payload
   * both routes return. Only the Host's explicit "model does not support image
   * input" rejection is marked `accepted: false`: a network, gateway or tool
   * failure may or may not have reached the model, so it must not tell a client
   * its images were left untouched. The message text is a fallback only for
   * that exact known rejection, in case a transport dropped the structured
   * details; no other failure is reclassified by its wording.
   */
  function promptFailurePayload(error, sessionId) {
    const { code: sourceCode, reason: sourceReason } = failureDetails(error)
    const message = error instanceof Error ? error.message : String(error)
    const imageUnsupported =
      sourceReason === 'MODEL_DOES_NOT_SUPPORT_IMAGES' ||
      /does not support image input\.?$/i.test(message.trim())

    if (imageUnsupported) {
      const diagnostic = message.trim().replace(/\.$/, '')
      return {
        code: 'image-model-unsupported',
        reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
        error: `${diagnostic}. Select a model that supports image input in the desktop session, then retry.`,
        sessionId,
        accepted: false,
      }
    }

    const payload = { code: sourceCode ?? 'prompt-failed', error: message, sessionId }
    if (sourceReason !== undefined) payload.reason = sourceReason
    return payload
  }

  /** Resolve or create the Session one request drives. */
  async function prepareSession(body) {
    if (typeof body.sessionId === 'string' && body.sessionId !== '') {
      const resolved = await resolveSession(body.sessionId)
      if (resolved.error !== undefined) return { error: resolved.error }
      return { sessionId: resolved.sessionId }
    }
    const reference =
      typeof body.workspace === 'string' && body.workspace !== ''
        ? body.workspace
        : typeof body.workspaceId === 'string' && body.workspaceId !== ''
          ? body.workspaceId
          : undefined
    const resolved = await resolveWorkspace(reference, body.createWorkspace === true)
    if (resolved.error !== undefined) return { error: resolved.error }
    const request = {}
    if (resolved.workspace !== undefined) request.workspaceId = resolved.workspace.id
    else request.cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : process.cwd()
    const created = await ctx.sessionController.create(request, abort.signal)
    return { sessionId: String(created.sessionId) }
  }

  async function transcriptOf(sessionId, maxMessages) {
    const page = await ctx.sessionController.events(
      { address: { kind: 'session', sessionId }, maxMessages },
      abort.signal,
    )
    const items = []
    for (const record of page.records ?? []) {
      if (record?.type !== 'event') continue
      const event = record.event
      const time = typeof event.time === 'number' ? event.time : undefined

      if (event.type === 'user/message') {
        const source = event.data?.source
        if (source?.kind !== 'user') continue
        const parts = []
        for (const block of event.data?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        const text = parts.join('\n').trim()
        if (text !== '') items.push({ kind: 'user', text, time })
        continue
      }

      if (event.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
            items.push({ kind: 'assistant', text: block.text, time })
          } else if (block?.type === 'tool-call') {
            items.push({ kind: 'tool-call', name: String(block.name ?? '?'), arguments: String(block.arguments ?? '').slice(0, 400), time })
          }
        }
        continue
      }

      if (event.type === 'tool/result') {
        const message = event.data?.message
        const parts = []
        for (const block of message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        items.push({
          kind: 'tool-result',
          ok: message?.isError !== true,
          text: parts.join('\n').trim().slice(0, 600),
          time,
        })
      }
    }
    return { items, more: page.hasMore === true }
  }

  const authorize = async (req) => {
    const remote = req.socket?.remoteAddress ?? ''
    if (!LOOPBACK.has(remote)) return 'not a loopback client'
    const supplied = String(req.headers['x-local-cli-token'] ?? '').trim()
    if (supplied === '') return 'missing x-local-cli-token header'
    let expected
    try {
      expected = await pending.token
    } catch (error) {
      return `token unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    if (supplied !== expected) return 'token mismatch'
    return undefined
  }

  // ---------------------------------------------------------- approval channel
  //
  // The official owner/answer Node Client is created lazily: building the
  // channel and registering its routes opens no connection and mints no
  // credential. Only an explicit user claim reaches the transport factory,
  // which is the first point that may talk to the Host. The channel dies with
  // the plugin fiber, so unload closes the client tree and any claim.
  const approvalChannel = createApprovalChannel({
    transport: createApprovalTransport({ host: ctx }),
  })
  const approvalRoutes = registerApprovalRoutes(ctx, {
    authorize,
    reply,
    readJsonBody,
    resolveSession,
    abort,
    channel: approvalChannel,
  })
  ctx.effect(() => async () => {
    await approvalChannel.dispose()
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/health',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        return reply(res, 200, {
          ok: true,
          origin: ctx.webServer.getOrigin(),
          // Enough to tell one Host apart from another on this machine.
          electron: process.versions.electron ?? null,
          node: process.versions.node,
          pid: process.pid,
          profile: process.env.DSH_PROFILE ?? null,
          profileDir: process.env.DSH_PROFILE_DIR ?? null,
          platform: process.platform,
          // Language this Host prefers for dsh-ask's own output; read from the
          // live config reference on every request, so a settings write is
          // visible without remounting the plugin.
          cliPreferences: { language: languagePreference(config) },
          // Intake vocabulary this bridge enforces before creating a Session.
          capabilities: {
            images: imageCapabilities(),
            // Explicit feature flag: this bridge serves the five
            // /local-cli/approval routes and owns the official owner/answer
            // Node Client, which is opened only by an explicit claim.
            approvalChannel: {
              feature: 'approval-channel',
              transport: 'official-node-client',
              routes: approvalRoutes.paths,
            },
          },
        })
      },
    }),
  )

  // Write the endpoint file so `dsh-ask` can find this instance. getOrigin()
  // throws until the listener is bound, hence the retry.
  ctx.effect(() => {
    const timer = setInterval(() => {
      let origin
      try {
        origin = ctx.webServer.getOrigin()
      } catch {
        return
      }
      clearInterval(timer)
      mkdir(stateDir(), { recursive: true, mode: 0o700 })
        .then(() => writeFile(join(stateDir(), 'endpoint'), `${origin}\n`, { mode: 0o600 }))
        .catch((error) => warn(ctx, `could not record endpoint: ${String(error)}`))
    }, 250)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/sessions',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const invalidQuery = (message) => reply(res, 400, { ok: false, code: 'invalid-query', error: message })
        for (const key of url.searchParams.keys()) {
          if (!SESSIONS_QUERY_KEYS.has(key)) {
            return invalidQuery(`unknown query parameter ${JSON.stringify(key)}`)
          }
        }
        for (const key of SESSIONS_QUERY_KEYS) {
          if (url.searchParams.getAll(key).length > 1) {
            return invalidQuery(`query parameter ${JSON.stringify(key)} may be given at most once`)
          }
        }
        const asked = Number(url.searchParams.get('limit') ?? '20')
        const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 20, 1), 50)
        const filters = ['workspace', 'cwd', 'sessionId'].filter((key) => url.searchParams.has(key))
        const allRaw = url.searchParams.get('all')
        const wantsAll = allRaw !== null
        if (wantsAll && filters.length > 0) {
          return invalidQuery('all cannot be combined with workspace, cwd or sessionId')
        }
        if (filters.length > 1) {
          return invalidQuery('workspace, cwd and sessionId are mutually exclusive')
        }
        if (wantsAll && allRaw !== '1' && allRaw !== 'true') {
          return invalidQuery('all must be 1 or true')
        }
        try {
          if (filters.length === 0 || wantsAll) {
            return reply(res, 200, {
              ok: true,
              sessions: await rowsFor(await visibleSessionItems(), limit),
              scope: { type: 'all' },
            })
          }
          const filter = filters[0]
          const reference = exactQueryValue(url.searchParams.get(filter))
          if (reference === undefined) {
            return invalidQuery(`${filter} must be a non-empty single-line string`)
          }
          if (filter === 'workspace') {
            const found = await workspaceForQuery(reference)
            if (found.error !== undefined) {
              return reply(res, 404, { ok: false, code: 'no-such-workspace', error: found.error })
            }
            const allowed = new Set((found.workspace.sessionIds ?? []).map((id) => String(id)))
            const items = (await visibleSessionItems()).filter((item) => allowed.has(String(item.sessionId)))
            return reply(res, 200, {
              ok: true,
              sessions: await rowsFor(items, limit),
              scope: { type: 'workspace', workspace: workspaceScopeView(found.workspace) },
            })
          }
          if (filter === 'cwd') {
            const canonical = canonicalPath(reference)
            const items = (await visibleSessionItems()).filter(
              (item) => typeof item.cwd === 'string' && item.cwd !== '' && canonicalPath(item.cwd) === canonical,
            )
            return reply(res, 200, {
              ok: true,
              sessions: await rowsFor(items, limit),
              scope: { type: 'cwd', cwd: canonical },
            })
          }
          const visible = await visibleSessionItems()
          const exact = visible.find((item) => String(item.sessionId) === reference)
          let matched = exact
          if (matched === undefined) {
            const prefixed = visible.filter((item) => String(item.sessionId).startsWith(reference))
            if (prefixed.length === 0) {
              return reply(res, 404, { ok: false, code: 'no-such-session', error: `no Session matches ${JSON.stringify(reference)}` })
            }
            if (prefixed.length > 1) {
              return reply(res, 409, {
                ok: false,
                code: 'ambiguous-session',
                error: `${prefixed.length} Sessions start with ${JSON.stringify(reference)}; use a longer prefix`,
              })
            }
            matched = prefixed[0]
          }
          const workspace = workspaceOfSession(String(matched.sessionId))
          return reply(res, 200, {
            ok: true,
            sessions: [await sessionRow(matched)],
            scope: {
              type: 'session',
              sessionId: String(matched.sessionId),
              workspace: workspace === undefined ? null : workspaceScopeView(workspace),
            },
          })
        } catch (error) {
          return reply(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/queue',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })

        let body = {}
        if (req.method === 'POST') {
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return reply(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
          }
        } else if (req.method !== 'GET') {
          return reply(res, 405, { ok: false, error: 'use GET or POST' })
        }

        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const reference =
          (req.method === 'POST' ? body.session : undefined) ??
          url.searchParams.get('session') ??
          ''
        if (reference === '') return reply(res, 400, { ok: false, error: 'session is required' })

        try {
          const resolved = await resolveSession(reference)
          if (resolved.error !== undefined) {
            return reply(res, 404, { ok: false, code: 'no-such-session', error: resolved.error })
          }
          const sessionId = resolved.sessionId

          if (req.method === 'GET') {
            return reply(res, 200, { ok: true, sessionId, ...(await queueOf(sessionId)) })
          }

          const action = String(body.action ?? '')
          const itemId = String(body.itemId ?? '')
          if (itemId === '') return reply(res, 400, { ok: false, error: 'itemId is required' })
          let queueAction
          if (action === 'remove') {
            queueAction = { kind: 'remove' }
          } else if (action === 'steer') {
            queueAction = { kind: 'steer' }
          } else if (action === 'edit') {
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            if (text === '') return reply(res, 400, { ok: false, error: 'edit needs text' })
            queueAction = { kind: 'edit', content: [{ type: 'text', text }] }
          } else {
            return reply(res, 400, { ok: false, error: 'action must be edit, remove or steer' })
          }

          await ctx.sessionController.updateQueue(
            { sessionId, itemId, action: queueAction },
            abort.signal,
          )
          return reply(res, 200, { ok: true, sessionId, ...(await queueOf(sessionId)) })
        } catch (error) {
          return reply(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/status',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'use GET' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const reference = String(url.searchParams.get('sessionId') ?? url.searchParams.get('session') ?? '').trim()
        if (reference === '') return reply(res, 400, { ok: false, error: 'sessionId is required' })
        try {
          const resolved = await resolveSession(reference)
          if (resolved.error !== undefined) {
            return reply(res, 404, { ok: false, code: 'no-such-session', error: resolved.error })
          }
          return reply(res, 200, {
            ok: true,
            sessionId: resolved.sessionId,
            status: await statusOf(resolved.sessionId),
          })
        } catch {
          // A status read never touches the Session; one fixed code keeps a
          // route failure from becoming a chat failure or leaking details.
          return reply(res, 500, { ok: false, code: 'status-unavailable', error: 'status read failed' })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/workspaces',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        try {
          return reply(res, 200, {
            ok: true,
            workspaces: registry().list().map(workspaceView),
          })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/create',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
        try {
          const reference =
            typeof body.workspace === 'string' && body.workspace !== ''
              ? body.workspace
              : typeof body.workspaceId === 'string' && body.workspaceId !== ''
                ? body.workspaceId
                : undefined
          const resolved = await resolveWorkspace(reference, body.createWorkspace === true)
          if (resolved.error !== undefined) {
            return reply(res, 404, { ok: false, code: 'no-such-workspace', error: resolved.error })
          }
          const request = {}
          if (resolved.workspace !== undefined) request.workspaceId = resolved.workspace.id
          else if (typeof body.cwd === 'string' && body.cwd !== '') request.cwd = body.cwd
          if (typeof body.agentPreset === 'string' && body.agentPreset !== '') {
            request.agentPreset = body.agentPreset
          }
          const created = await ctx.sessionController.create(request, abort.signal)
          return reply(res, 200, {
            ok: true,
            sessionId: String(created.sessionId),
            created: resolved.created === true,
            workspace: workspaceView(resolved.workspace),
          })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/transcript',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const reference = url.searchParams.get('session') ?? ''
        if (reference === '') return reply(res, 400, { ok: false, error: 'session is required' })
        const asked = Number(url.searchParams.get('limit') ?? '120')
        const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 120, 1), 300)
        try {
          const resolved = await resolveSession(reference)
          if (resolved.error !== undefined) {
            return reply(res, 404, { ok: false, code: 'no-such-session', error: resolved.error })
          }
          const state = await ctx.sessionController.state({ sessionId: resolved.sessionId }, abort.signal)
          const transcript = await transcriptOf(resolved.sessionId, limit)
          return reply(res, 200, {
            ok: true,
            sessionId: resolved.sessionId,
            running: state.running === true,
            ...transcript,
          })
        } catch (error) {
          return reply(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/stream',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
        const payload = promptPayload(body)
        if (payload.error !== undefined) return replyInvalidPayload(res, payload.error)
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT, 1_000), MAX_TIMEOUT)

        const prepared = await prepareSession(body)
        if (prepared.error !== undefined) {
          return reply(res, 404, { ok: false, code: 'no-such-session', error: prepared.error })
        }
        const sessionId = prepared.sessionId

        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        const send = (frame) => {
          try {
            res.write(`${JSON.stringify(frame)}\n`)
          } catch {
            // The client went away; the timeout or the abort closes the loop.
          }
        }
        const stop = new AbortController()
        req.on('close', () => stop.abort())

        send({ t: 'session', sessionId })
        const deadline = Date.now() + timeoutMs
        let answer = ''
        // A step whose text arrived as deltas must not be emitted again when its
        // assistant message commits.
        let deltaSeen = false
        try {
          // Which turn is ours? The one whose admitted user message carries the
          // request id minted below. `running` cannot answer this: a queued
          // prompt starts the moment the previous turn ends. The text is not a
          // key either, because a queued item can be edited before it is read.
          let ours = false
          const requestId = `local-cli-${randomUUID()}-${Date.now()}`
          const iterator = ctx.sessionController.follow(
            { address: { kind: 'session', sessionId }, assistantStream: true },
            stop.signal,
          )[Symbol.asyncIterator]()
          await iterator.next() // the opening snapshot
          try {
            await ctx.sessionController.prompt(
              {
                requestId,
                sessionId,
                mode: 'queue',
                content: payload.content,
              },
              stop.signal,
            )
          } catch (error) {
            // The opening snapshot is already on the wire. Answer with one
            // structured error frame; `accepted: false` appears only when the
            // Host explicitly refused the images, so the client knows it can
            // keep them instead of discarding the upload.
            send({ t: 'error', ...promptFailurePayload(error, sessionId) })
            try {
              res.end()
            } catch {
              // Already closed.
            }
            return
          }

          for (;;) {
            // Race the next frame against a heartbeat: a turn blocked on an
            // approval or a question produces no frames at all, so the deadline
            // and the pending-input probe must still run.
            const raced = await Promise.race([
              iterator.next().then((step) => ({ step })),
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ tick: true }), 1_000)
                timer.unref?.()
              }),
            ])
            if (raced.tick === true) {
              if (Date.now() > deadline) {
                send({ t: 'timeout' })
                break
              }
              const state = await ctx.sessionController.state({ sessionId }, stop.signal)
              if ((state.pendingInput ?? []).length > 0) {
                send({ t: 'input-required', pending: state.pendingInput })
                break
              }
              continue
            }
            const step = raced.step
            if (step.done === true) break
            const frame = step.value
            if (ours !== true) {
              if (frame.type === 'event' && frame.event?.type === 'user/message') {
                if (String(frame.event.data?.source?.rpcId ?? '') === requestId) ours = true
              }
              continue
            }
            if (frame.type === 'assistant-stream') {
              const inner = frame.frame
              if (inner.type === 'chunk') {
                const chunk = inner.chunk
                if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
                  deltaSeen = true
                  answer += chunk.text
                  send({ t: 'delta', text: chunk.text })
                }
              }
              continue
            }
            if (frame.type !== 'event') continue
            const event = frame.event

            if (event.type === 'tool/call') {
              send({
                t: 'tool',
                name: String(event.data?.name ?? '?'),
                arguments: String(event.data?.arguments ?? '').slice(0, 400),
              })
            } else if (event.type === 'tool/result') {
              const message = event.data?.message
              const parts = []
              for (const block of message?.content ?? []) {
                if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
              }
              send({
                t: 'tool-result',
                ok: message?.isError !== true,
                text: parts.join('\n').trim().slice(0, 400),
              })
            } else if (event.type === 'assistant/message') {
              const key = `${event.data?.turn}:${event.data?.step}`
              if (deltaSeen === true) {
                deltaSeen = false
              } else {
                const parts = []
                for (const block of event.data?.message?.content ?? []) {
                  if (block?.type === 'text' && block.text.trim() !== '') parts.push(block.text)
                }
                const whole = parts.join('\n\n').trim()
                if (whole !== '') {
                  const separator = answer === '' ? '' : '\n\n'
                  answer += separator + whole
                  send({ t: 'delta', text: separator + whole })
                }
              }
            } else if (event.type === 'turn/end') {
              // Our turn is over. A queued prompt may already have started the
              // next one, so `running` is not the signal here.
              send({ t: 'turn-end', reason: event.data?.reason?.kind })
              break
            }

          }
          send({ t: 'done', ok: true, sessionId, text: answer })
        } catch (error) {
          send({ t: 'error', error: error instanceof Error ? error.message : String(error) })
        }
        try {
          res.end()
        } catch {
          // Already closed.
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/ask',
      handler: async (req, res) => {
        const refusal = await authorize(req)
        if (refusal !== undefined) return reply(res, 401, { ok: false, error: refusal })
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })

        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }

        const payload = promptPayload(body)
        if (payload.error !== undefined) return replyInvalidPayload(res, payload.error)

        const timeoutMs = Math.min(
          Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT, 1_000),
          MAX_TIMEOUT,
        )

        try {
          let sessionId
          if (typeof body.sessionId === 'string' && body.sessionId !== '') {
            const resolved = await resolveSession(body.sessionId)
            if (resolved.error !== undefined) {
              return reply(res, 404, { ok: false, code: 'no-such-session', error: resolved.error })
            }
            sessionId = resolved.sessionId
          } else {
            const reference =
              typeof body.workspace === 'string' && body.workspace !== ''
                ? body.workspace
                : typeof body.workspaceId === 'string' && body.workspaceId !== ''
                  ? body.workspaceId
                  : undefined
            const resolved = await resolveWorkspace(reference, body.createWorkspace === true)
            if (resolved.error !== undefined) {
              return reply(res, 404, { ok: false, code: 'no-such-workspace', error: resolved.error })
            }
            const request = {}
            if (resolved.workspace !== undefined) request.workspaceId = resolved.workspace.id
            else request.cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : process.cwd()
            const created = await ctx.sessionController.create(request, abort.signal)
            sessionId = created.sessionId
          }

          const before = await ctx.sessionController.state({ sessionId }, abort.signal)
          try {
            await ctx.sessionController.prompt(
              {
                requestId: `local-cli-${randomUUID()}-${Date.now()}`,
                sessionId,
                mode: 'queue',
                content: payload.content,
              },
              abort.signal,
            )
          } catch (error) {
            const failure = promptFailurePayload(error, sessionId)
            // A model that cannot take images is a caller-visible 4xx, not a
            // server fault; every other prompt failure stays a 500 but keeps
            // the same structured code/reason/sessionId envelope.
            const status = failure.code === 'image-model-unsupported' ? 422 : 500
            return reply(res, status, { ok: false, ...failure })
          }

          const deadline = Date.now() + timeoutMs
          let afterSeq = before.cursor
          const records = []
          let reason = 'timeout'
          for (;;) {
            const remaining = deadline - Date.now()
            if (remaining <= 0) break
            const waited = await ctx.sessionController.wait(
              { sessionId, timeoutMs: remaining, afterSeq, maxMessages: 500 },
              abort.signal,
            )
            for (const record of waited.output?.records ?? []) records.push(record)
            afterSeq = Math.max(afterSeq, lastSeq(waited.output?.records ?? []))
            reason = waited.reason
            if (reason !== 'timeout') break
          }

          const { text: answer, toolCalls, failures } = collect(records)
          const session = await ctx.sessionController.state({ sessionId }, abort.signal)

          if (reason === 'input-required') {
            return reply(res, 409, {
              ok: false,
              code: 'input-required',
              error: 'the turn is waiting for a human answer (approval or question)',
              pending: session.pendingInput,
              sessionId,
              text: answer,
            })
          }
          if (reason === 'timeout') {
            return reply(res, 504, {
              ok: false,
              code: 'timeout',
              error: `no settled turn within ${timeoutMs} ms`,
              sessionId,
              text: answer,
            })
          }
          if (answer === '' && failures.length > 0) {
            return reply(res, 502, {
              ok: false,
              code: 'model-error',
              error: failures.join('; '),
              sessionId,
            })
          }
          const workspaceHint = typeof body.workspace === 'string' && body.workspace !== ''
            ? workspaceView(registry().list().find((workspace) => workspace.title === body.workspace || String(workspace.id) === body.workspace))
            : undefined
          return reply(res, 200, {
            ok: true,
            sessionId,
            text: answer,
            toolCalls,
            running: session.running,
            workspace: workspaceHint,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warn(ctx, `/local-cli/ask failed: ${message}`)
          return reply(res, 500, { ok: false, error: message })
        }
      },
    }),
  )

  // Permission presets and pending-input answers live in their own module so
  // the services they need stay optional: this Host profile composes
  // permissionPresets/userQuestions/commands today, and a future profile that
  // does not loses only these four routes instead of the whole bridge.
  registerPermissionRoutes(ctx, { authorize, reply, readJsonBody, resolveSession, abort })

  ctx.effect(() => () => abort.abort())
}
