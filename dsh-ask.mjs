#!/usr/bin/env node
/**
 * dsh-ask / dsh-connect / dsh-history - talk to the Harness instance that is
 * already running.
 *
 * The sibling `local-cli` plugin registers a loopback-only endpoint inside the
 * Desktop/Web Host process, so nothing here boots a second profile: a Session
 * this command touches is the one the app already holds.
 *
 *   dsh-ask "text"            one prompt, one answer
 *   dsh-ask -l                list recent Sessions
 *   dsh-history [session]     print a Session's conversation
 *   dsh-connect [session]     pick a Session, read its history, keep chatting
 */

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

import {
  MAX_IMAGES as MEDIA_MAX_IMAGES,
  MAX_TOTAL_BYTES as MEDIA_MAX_TOTAL_BYTES,
  MediaError,
  formatBytes,
  loadImages,
  previewImage,
  readClipboardImage,
  sanitizeTerminalText,
  splitDragPaths,
} from './dsh-media.mjs'
import { createTranslator, DEFAULT_LANGUAGE, INVALID_LANGUAGE_CODE, resolveLanguage } from './dsh-i18n.mjs'
import { CLI_CATALOG } from './dsh-cli-messages.mjs'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DIR = join(HOME, 'local-cli')
const WIDTH = Math.max(40, Math.min(process.stdout.columns || 100, 120))

const COLOR_AUTO =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb'
let COLOR = COLOR_AUTO

/** `--color` overrides the terminal sniffing for shells that hide the tty. */
function setColorMode(mode) {
  if (mode === 'always') COLOR = true
  else if (mode === 'never') COLOR = false
  else COLOR = COLOR_AUTO
}

/** JSON output must stay machine-readable even when `--color always` is given. */
function applyColor(options) {
  setColorMode(options.color)
  if (options.json === true) COLOR = false
}

/**
 * Resolved on parse (`--lang`, `DSH_ASK_LANG`, the locale) and re-resolved once
 * the Host answers, which is when the Desktop plugin's own setting becomes
 * available. Nothing is printed in between that would need the new value.
 */
let LANGUAGE = DEFAULT_LANGUAGE

/** The translator for every string the CLI itself prints. */
let msg = createTranslator(LANGUAGE, CLI_CATALOG)

/** An invalid DSH_ASK_LANG must be reported once, not once per parse. */
let warnedAboutLanguageEnv = false

/**
 * Resolve and apply the language before the first message is printed.
 *
 * `--lang` is authoritative and a bad value is a usage error (exit 2); an
 * unusable `DSH_ASK_LANG` only warns and is ignored, so one stray environment
 * variable never blocks a whole session. Called from `parseCli`, i.e. every
 * subcommand entry, and again as soon as `--lang` is parsed so a later option
 * error already speaks the requested language.
 *
 * `pluginLanguage` is the Desktop plugin's setting, which only exists after
 * `connectToHost` succeeded; it ranks below the two explicit sources and is
 * ignored when absent or unusable (see `resolveLanguage`).
 */
function applyLanguage(options = {}, pluginLanguage) {
  const warnings = []
  try {
    LANGUAGE = resolveLanguage({ lang: options.lang, pluginLanguage, warn: (message) => warnings.push(message) })
  } catch (error) {
    if (error?.code === INVALID_LANGUAGE_CODE) {
      throw new UsageError(msg('--lang must be zh or en (got {value})', { value: JSON.stringify(String(options.lang)) }))
    }
    throw error
  }
  msg = createTranslator(LANGUAGE, CLI_CATALOG)
  if (warnings.length > 0 && warnedAboutLanguageEnv === false) {
    warnedAboutLanguageEnv = true
    const value = String(process.env.DSH_ASK_LANG ?? '')
    process.stderr.write(`${yellow(msg('warning'))}: ${msg('ignoring DSH_ASK_LANG={value}: expected zh or en', { value })}\n`)
  }
  return LANGUAGE
}

/**
 * Adopt the language the Desktop plugin reports in the health payload.
 *
 * The payload was already downloaded by the single probe `connectToHost` needs,
 * so this adds no request and touches no file. Only an exact `zh`/`en` string
 * counts: `auto`, a Host that predates the field and any other value leave the
 * existing resolution (`--lang`, `DSH_ASK_LANG`, locale) in place.
 *
 * `options` is deliberately left untouched: the parsed options are the user's
 * input, and storing the resolved language in `options.lang` would make it look
 * like an explicit `--lang` on a later re-resolution. Consumers of the final
 * value read the module-level `LANGUAGE` - `runTui` already receives it as its
 * `lang` - so nothing needs to be written back here.
 */
function adoptHostLanguage(options, instance) {
  const reported = instance?.cliPreferences?.language
  const pluginLanguage = typeof reported === 'string' ? reported : undefined
  return applyLanguage(options, pluginLanguage)
}

/**
 * Parse one argv, applying the language first. Every subcommand entry uses this
 * instead of `parseArgs`, so help and errors never fall back to another
 * language than the one the user asked for.
 */
function parseCli(argv) {
  const parsed = parseArgs(argv)
  applyLanguage(parsed.options)
  return parsed
}

/**
 * A status-block label padded to a fixed column. CJK counts as two cells, so
 * the Chinese labels keep the same column as their English counterparts.
 */
function labelCell(key, width = 12) {
  const text = msg(key)
  let used = 0
  for (const point of text) {
    const code = point.codePointAt(0) ?? 0
    used += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 || code >= 0xac00) ? 2 : 1
  }
  return text + ' '.repeat(Math.max(0, width - used))
}

/** "{what} failed" with the operation label translated (`list failed`, ...). */
function failedMessage(what) {
  return msg('{what} failed', { what: msg(what) })
}

const PREVIEW_MODES = new Set(['auto', 'never', 'iterm', 'kitty'])

/** Bad syntax or an unusable option value: exit 2, never becomes prompt text. */
class CliError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 1
    this.showUsage = options.showUsage === true
  }
}

class UsageError extends CliError {
  constructor(message) {
    super(message, { exitCode: 2, showUsage: true })
  }
}

/** The upgrade hint shown whenever the Host cannot take images. */
const imageUpgradeHint = () =>
  msg(
    'this Host does not advertise image support: its DSH Ask Terminal is older than this CLI. Update DeepSeek Harness (or the local-cli plugin) and retry; text prompts still work.',
  )

function hostImageCapabilities(host) {
  const images = host?.instance?.capabilities?.images
  return images !== null && typeof images === 'object' && images.supported === true ? images : undefined
}

function imageBytes(image) {
  return Buffer.from(String(image.data ?? ''), 'base64').length
}

function totalImageBytes(images) {
  return images.reduce((sum, image) => sum + imageBytes(image), 0)
}

/** The effective limits: the Host may be stricter than the CLI's own ceilings. */
function imageLimits(caps) {
  const maxImages = Number.isFinite(caps?.maxImages) ? caps.maxImages : MEDIA_MAX_IMAGES
  const maxTotalBytes = Number.isFinite(caps?.maxTotalBytes) ? caps.maxTotalBytes : MEDIA_MAX_TOTAL_BYTES
  return {
    maxImages: Math.min(MEDIA_MAX_IMAGES, maxImages),
    maxTotalBytes: Math.min(MEDIA_MAX_TOTAL_BYTES, maxTotalBytes),
    mediaTypes: Array.isArray(caps?.mediaTypes) ? caps.mediaTypes : undefined,
  }
}

/**
 * Turn loaded images into the wire form, rejecting anything this Host cannot
 * accept before a request is made. Reaching this without image capabilities
 * means the bridge predates image input, hence the upgrade hint.
 */
function prepareImageBatch(images, caps) {
  if (caps === undefined) throw new CliError(imageUpgradeHint())
  const limits = imageLimits(caps)
  if (images.length > limits.maxImages) {
    throw new CliError(
      msg('too many images: {count} (this Host accepts {max})', { count: images.length, max: limits.maxImages }),
    )
  }
  const bytes = totalImageBytes(images)
  if (bytes > limits.maxTotalBytes) {
    throw new CliError(
      msg('attached images are too large: {bytes} (this Host accepts {max})', {
        bytes: formatBytes(bytes),
        max: formatBytes(limits.maxTotalBytes),
      }),
    )
  }
  for (const image of images) {
    const mediaType = image?.mediaType
    if (typeof mediaType !== 'string' || mediaType === '') throw new CliError(msg('an attached image has no media type'))
    if (limits.mediaTypes !== undefined && !limits.mediaTypes.includes(mediaType)) {
      throw new CliError(msg('this Host does not accept {mediaType} images', { mediaType }))
    }
  }
  return images.map((image) => ({
    mediaType: image.mediaType,
    data: image.data,
    name: image.name,
    bytes: imageBytes(image),
  }))
}

const IMAGE_LABELS = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WEBP' }

function imageLabel(image) {
  return IMAGE_LABELS[image.mediaType] ?? image.mediaType
}

/** A file name is untrusted text: strip control characters before printing. */
function safeImageName(image) {
  const name = sanitizeTerminalText(typeof image?.name === 'string' ? image.name : '', { max: 120 })
  return name === '' ? 'image' : name
}

function formatDuration(ms) {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`
}

const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (text) => paint('2', text)
const bold = (text) => paint('1', text)
const cyan = (text) => paint('36', text)
const yellow = (text) => paint('33', text)
const green = (text) => paint('32', text)
const red = (text) => paint('31', text)

/** The help text (see `dsh-cli-messages.mjs`); `--lang` is documented there. */
function usageText() {
  return msg('usage')
}

function previewModeOf(value) {
  const mode = String(value).trim()
  if (!PREVIEW_MODES.has(mode)) {
    throw new UsageError(
      msg('--preview must be auto, never, iterm or kitty (got {value})', {
        value: mode === '' ? msg('nothing') : mode,
      }),
    )
  }
  return mode
}

function positiveIntegerOf(value, flag) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(msg('{flag} needs a positive integer (got {value})', { flag, value }))
  }
  return number
}

function parseArgs(argv) {
  const options = { json: false, images: [], paste: false, preview: 'auto', selections: [], customs: [], skips: [], yes: false, allowOnce: false, reject: false, confirm: false }
  const words = []
  let literal = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (literal === true) {
      words.push(arg)
      continue
    }
    if (arg === '--') {
      literal = true
      continue
    }
    const next = () => {
      index += 1
      if (index >= argv.length) throw new UsageError(msg('{flag} needs a value', { flag: arg }))
      return argv[index]
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-s':
      case '--session':
        options.sessionId = next()
        break
      case '-c':
      case '--cwd':
        options.cwd = next()
        break
      case '-w':
      case '--workspace':
        options.workspace = next()
        break
      case '--create-workspace':
        options.createWorkspace = true
        break
      case '--workspaces':
        options.workspaces = true
        break
      case '-l':
      case '--list':
        options.list = true
        if (index + 1 < argv.length && /^\d+$/.test(argv[index + 1])) {
          index += 1
          options.listCount = Number(argv[index])
        }
        break
      case '-n':
      case '--tail':
        options.tail = positiveIntegerOf(next(), arg)
        break
      case '-t':
      case '--timeout':
        options.timeoutMs = positiveIntegerOf(next(), arg)
        break
      case '-u':
      case '--url':
        options.url = next()
        break
      case '--json':
        options.json = true
        break
      case '--plain':
        options.plain = true
        break
      case '--no-history':
        options.noHistory = true
        break
      case '--color':
        options.color = next()
        break
      case '--lang':
        options.lang = next()
        applyLanguage(options)
        break
      case '--stream':
        options.stream = true
        break
      case '--no-stream':
        options.stream = false
        break
      case '--no-start':
        options.noStart = true
        break
      case '--start-timeout':
        options.startTimeoutMs = positiveIntegerOf(next(), arg)
        break
      case '--app':
        options.appPath = next()
        break
      case '--image':
        options.images.push(next())
        break
      case '--yes':
        options.yes = true
        break
      case '--select':
        options.selections.push(next())
        break
      case '--custom':
        options.customs.push(next())
        break
      case '--skip':
        options.skips.push(next())
        break
      case '--lease':
        options.leaseMs = positiveIntegerOf(next(), arg)
        break
      case '--allow-once':
        options.allowOnce = true
        break
      case '--reject':
        options.reject = true
        break
      case '--confirm':
        options.confirm = true
        break
      case '--paste':
        options.paste = true
        break
      case '--preview':
        options.preview = previewModeOf(next())
        break
      case '--remove':
      case '--steer':
      case '--edit':
        options.queueAction = arg.slice(2)
        options.itemId = next()
        break
      default:
        if (arg.startsWith('--color=')) options.color = arg.slice(8)
        else if (arg.startsWith('--lang=')) {
          options.lang = arg.slice(7)
          applyLanguage(options)
        }
        else if (arg.startsWith('--preview=')) options.preview = previewModeOf(arg.slice(10))
        else if (arg.startsWith('--image=')) options.images.push(arg.slice(8))
        else if (arg.startsWith('-') && arg !== '-') throw new UsageError(msg('unknown option: {option}', { option: arg }))
        else words.push(arg)
    }
  }
  return { options, words }
}


async function readText(path) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return undefined
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

/**
 * Files named on the command line, then the clipboard when --paste was given.
 * A broken path or an unreadable clipboard is a usage error (exit 2), never
 * prompt text, and nothing is sent when this throws.
 */
async function loadCliImages(options) {
  const cwd = options.cwd ?? process.cwd()
  const images = []
  try {
    // Each --image value is exactly one path: the shell already did its word
    // splitting, so a value containing spaces stays one path. Only bare
    // /attach input is split as a drag-and-drop list.
    for (const value of options.images) images.push(...(await loadImages([value], { cwd })))
    if (options.paste === true) images.push(await readClipboardImage())
  } catch (error) {
    if (error instanceof MediaError) {
      throw new CliError(msg('cannot attach image: {error}', { error: error.message }), { exitCode: 2 })
    }
    throw error
  }
  if (images.length > MEDIA_MAX_IMAGES) {
    throw new UsageError(
      msg('too many images: {count} (max {max}); use /attach inside connect for more turns', {
        count: images.length,
        max: MEDIA_MAX_IMAGES,
      }),
    )
  }
  if (totalImageBytes(images) > MEDIA_MAX_TOTAL_BYTES) {
    throw new UsageError(
      msg('attached images are too large: {bytes} (max {max})', {
        bytes: formatBytes(totalImageBytes(images)),
        max: formatBytes(MEDIA_MAX_TOTAL_BYTES),
      }),
    )
  }
  return images
}

/** Show each attachment in the terminal; JSON output stays untouched. */
function showImages(images, options, output = process.stderr) {
  if (options.json === true) return
  for (const image of images) {
    try {
      previewImage(image, { mode: options.preview ?? 'auto', output })
    } catch {
      // A preview is a courtesy: never let it block the prompt.
    }
  }
}


function ageOf(ms) {
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

const shortId = (sessionId) => String(sessionId).slice(0, 17)

function labelOf(row) {
  if (typeof row.title === 'string' && row.title !== '') return row.title
  if (row.blank === true) return msg('(empty)')
  return row.preview === '' ? msg('(no prompt)') : row.preview
}

function describe(row) {
  const flags = [row.running === true ? msg('running') : '', row.blank === true ? msg('blank') : '']
    .filter(Boolean)
    .join(',')
  return `${shortId(row.sessionId).padEnd(18)} ${ageOf(Date.now() - Number(row.updatedAt ?? Date.now())).padStart(6)}  ${flags.padEnd(8)} ${labelOf(row)}`
}

/** Word-wrap one block of text to the terminal width. */
function wrap(text, indent = '') {
  const width = Math.max(20, WIDTH - indent.length)
  const out = []
  for (const paragraph of String(text).split('\n')) {
    if (paragraph.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (line.length + word.length > width && line.trim() !== '') {
        out.push(indent + line.trimEnd())
        line = word.trimStart()
      } else {
        line += word
      }
    }
    if (line.trim() !== '') out.push(indent + line.trimEnd())
  }
  return out
}

function firstLine(text, limit = 100) {
  const line = String(text).split('\n').find((part) => part.trim() !== '') ?? ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

function toolCallLine(item) {
  let summary = ''
  try {
    const args = JSON.parse(item.arguments || '{}')
    summary =
      args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.name ?? ''
    if (typeof summary !== 'string') summary = JSON.stringify(summary)
  } catch {
    summary = item.arguments ?? ''
  }
  const short = summary.length > 70 ? `${summary.slice(0, 70)}…` : summary
  return `  ${yellow('⚙')} ${bold(item.name ?? '?')}${short === '' ? '' : dim(` ${short}`)}`
}

/**
 * Render a transcript payload the way the chat pane reads: your turns first,
 * the assistant's prose under them, and tool traffic folded to one dim line.
 */
function renderTranscript(payload, header) {
  const lines = []
  if (header !== undefined) {
    lines.push(dim(`── ${header} ──`), '')
  }
  const items = payload.items ?? []
  if (items.length === 0) {
    lines.push(dim(msg('(no messages yet)')))
    return lines.join('\n')
  }
  let previous = ''
  for (const item of items) {
    if (item.kind === 'user') {
      if (previous !== '' ) lines.push('')
      lines.push(cyan('❯ ') + wrap(item.text, '  ').join('\n').replace(/^ {2}/, ''))
      previous = 'user'
    } else if (item.kind === 'assistant') {
      lines.push(renderMarkdownBlock(item.text, '  '))
      previous = 'assistant'
    } else if (item.kind === 'tool-call') {
      lines.push(toolCallLine(item))
      previous = 'tool'
    } else if (item.kind === 'tool-result') {
      const text = firstLine(item.text)
      if (text === '') continue
      lines.push(dim(`  ${item.ok === false ? red('✗') : green('✓')} ${text}`))
      previous = 'tool'
    }
  }
  return lines.join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const defaultAppPath = () =>
  process.env.DSH_DESKTOP_APP ?? '/Applications/DeepSeek Harness.app'

/**
 * Is that bundle already running? Scans `ps` instead of `pgrep -f`: on macOS the
 * pgrep pattern for a path containing ".app" does not match its own processes,
 * which would make the caller launch a second copy.
 */
function appIsRunning(appPath) {
  try {
    const listed = execFileSync('ps', ['-ax', '-o', 'command'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    // The executable is named after the bundle, so a --app override still works.
    const bundleName = appPath.replace(/\/+$/, '').split('/').pop().replace(/\.app$/u, '')
    const needle = `${appPath.replace(/\/+$/, '')}/Contents/MacOS/${bundleName}`
    // Anchor at the start: a process only matches when it IS that executable,
    // not merely when some other command line mentions the path.
    return listed.split('\n').some((line) => line.startsWith(needle))
  } catch {
    return false
  }
}

/** One readiness probe; undefined means "not answering yet". */
async function probeHost(origin, token) {
  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/local-cli/health`, {
      headers: { 'x-local-cli-token': token },
      signal: AbortSignal.timeout(1_500),
    })
    if (response.ok !== true) return undefined
    const body = await response.json().catch(() => undefined)
    return body?.ok === true ? body : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a live Host, launching the Desktop app when nothing answers.
 *
 * Launching is the one side effect this CLI allows itself, so it stays narrow:
 * macOS only, background activation (no focus steal), never a second copy when
 * the process already exists, and switchable off with --no-start or
 * DSH_ASK_NO_START=1 for scripts.
 *
 * Every successful return adopts the language the Host reports in that same
 * health payload (`cliPreferences.language`), so it also covers the retry after
 * an auto-start. Help output and failures before this point stay in the offline
 * language: nothing is read from the Host before it answers.
 */
async function connectToHost(options) {
  const tokenFile = join(DIR, 'token')
  const endpointFile = join(DIR, 'endpoint')

  const attempt = async () => {
    const endpoint = options.url ?? (await readText(endpointFile))
    const token = await readText(tokenFile)
    if (endpoint === undefined || token === undefined) return undefined
    const instance = await probeHost(endpoint, token)
    if (instance === undefined) return undefined
    return { base: endpoint.replace(/\/+$/, ''), token, instance }
  }

  const alive = await attempt()
  if (alive !== undefined) {
    adoptHostLanguage(options, alive.instance)
    return alive
  }

  const disabled = options.noStart === true || process.env.DSH_ASK_NO_START === '1'
  if (options.url !== undefined || disabled) {
    throw new Error(
      msg('no Host answers at {endpoint}', {
        endpoint: options.url ?? (await readText(endpointFile)) ?? join(DIR, 'endpoint'),
      }) + (disabled ? msg(' (auto-start disabled)') : ''),
    )
  }
  if (process.platform !== 'darwin') {
    throw new Error(msg('the Desktop app cannot be launched from this CLI on this platform'))
  }

  const appPath = options.appPath ?? defaultAppPath()
  if (appIsRunning(appPath) === true) {
    throw new Error(
      msg(
        'the Desktop app is running but its local-cli endpoint is not answering - the plugin row may be disabled or the app is still starting. Check Plugins for "DSH Ask Terminal", or wait and retry.',
      ),
    )
  }

  process.stderr.write(`${dim(msg('starting'))} ${appPath} …\n`)
  try {
    execFileSync('open', ['-g', '-a', appPath], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(msg('could not launch {path}: {error}', { path: appPath, error: String(error?.message ?? error) }))
  }

  const timeoutMs = Math.min(Math.max(options.startTimeoutMs ?? 60_000, 5_000), 300_000)
  const deadline = Date.now() + timeoutMs
  let announced = false
  while (Date.now() < deadline) {
    await sleep(500)
    const ready = await attempt()
    if (ready !== undefined) {
      // Connected: the ready line and everything after it speak the language the
      // Desktop plugin reports, not the offline one.
      adoptHostLanguage(options, ready.instance)
      process.stderr.write(`${dim(msg('ready'))} ${ready.base}\n`)
      return ready
    }
    if (announced === false) {
      announced = true
      process.stderr.write(`${dim(msg('waiting for the Host to answer'))} …\n`)
    }
  }
  throw new Error(msg('DeepSeek Harness did not answer within {seconds}s', { seconds: Math.round(timeoutMs / 1000) }))
}

async function callJson(url, init, what) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new Error(msg('cannot reach {url}: {error} ({what})', { url, error: String(error?.message ?? error), what }))
  }
  return response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
}

const authHeaders = (host) => ({ 'x-local-cli-token': host.token })

async function fetchSessions(host, limit) {
  const payload = await callJson(
    `${host.base}/local-cli/sessions?limit=${limit}`,
    { headers: authHeaders(host) },
    'list',
  )
  if (payload.ok !== true) throw new Error(payload.error ?? failedMessage('list'))
  return payload.sessions ?? []
}

/** Whitelist/validate the Host sessions scope marker; old Hosts have none. */
const SESSION_SCOPE_TYPES = new Set(['all', 'workspace', 'cwd', 'session'])

function normalizeSessionScope(scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  if (typeof scope.type !== 'string' || !SESSION_SCOPE_TYPES.has(scope.type)) return null
  if (scope.type === 'workspace') {
    if (scope.workspace === null || typeof scope.workspace !== 'object' || Array.isArray(scope.workspace)) return null
    if (typeof scope.workspace.id !== 'string' || typeof scope.workspace.path !== 'string') return null
  }
  if (scope.type === 'cwd' && typeof scope.cwd !== 'string') return null
  if (scope.type === 'session' && typeof scope.sessionId !== 'string') return null
  return scope
}

/**
 * Scoped Host session list. `supported:false` means the Host response has no
 * scope marker (older Host): callers must not claim the filter was applied.
 */
async function fetchSessionsScoped(host, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50)
  const params = new URLSearchParams({ limit: String(limit) })
  if (options.all === true) params.set('all', '1')
  if (options.workspace !== undefined) params.set('workspace', String(options.workspace))
  if (options.cwd !== undefined) params.set('cwd', String(options.cwd))
  if (options.sessionId !== undefined) params.set('sessionId', String(options.sessionId))
  const payload = await callHost(
    `${host.base}/local-cli/sessions?${params.toString()}`,
    { headers: authHeaders(host) },
    'sessions',
  )
  const scope = normalizeSessionScope(payload.scope)
  const rows = Array.isArray(payload.sessions) ? payload.sessions : []
  return { rows, scope, supported: scope !== null }
}

/** Exact/unique-prefix Session metadata lookup, independent of the list limit. */
async function fetchSessionContext(host, sessionId) {
  const reference = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
  if (reference === '') throw new CliError(msg('fetchSessionContext needs a Session id'))
  const params = new URLSearchParams({ limit: '1', sessionId: reference })
  const payload = await callHost(
    `${host.base}/local-cli/sessions?${params.toString()}`,
    { headers: authHeaders(host) },
    'sessions',
  )
  const scope = normalizeSessionScope(payload.scope)
  if (scope === null || scope.type !== 'session') {
    const error = new CliError(msg('this Host does not expose workspace session scope; Session context is unavailable'))
    error.code = 'workspace-scope-unsupported'
    throw error
  }
  const row = Array.isArray(payload.sessions) ? payload.sessions[0] : undefined
  const context = {
    sessionId: typeof row?.sessionId === 'string' && row.sessionId !== '' ? row.sessionId : scope.sessionId,
    cwd: typeof row?.cwd === 'string' && row.cwd !== '' ? row.cwd : null,
  }
  if (scope.workspace !== null && scope.workspace !== undefined) context.workspace = scope.workspace
  return context
}

async function fetchTranscript(host, reference, tail) {
  const payload = await callJson(
    `${host.base}/local-cli/transcript?session=${encodeURIComponent(reference)}&limit=${tail}`,
    { headers: authHeaders(host) },
    'transcript',
  )
  if (payload.ok !== true) throw new Error(payload.error ?? failedMessage('transcript'))
  return payload
}

async function fetchStatus(host, reference) {
  const payload = await callJson(
    `${host.base}/local-cli/status?sessionId=${encodeURIComponent(reference)}`,
    { headers: authHeaders(host) },
    'status',
  )
  if (payload.ok !== true) {
    if (payload.code === 'no-such-session') throw new Error(payload.error ?? msg('no such Session'))
    // An older Host has no /local-cli/status route; callJson reports that as
    // `HTTP 404` with no JSON body. Say so instead of guessing values.
    throw new Error(msg('{message} (the Host may be older than this CLI)', { message: payload.error ?? msg('status unavailable') }))
  }
  return payload
}

/**
 * Turn a bridge rejection into one CLI error carrying the Host error code.
 *
 * The full-screen TUI decides what to do from `error.code` and `error.status`
 * (docs/permissions.md), so those fields are preserved verbatim. A bare
 * `HTTP 404` predates the route on an older Host and says so.
 */
function hostFailure(payload, what, status) {
  const code = typeof payload?.code === 'string' && payload.code !== '' ? payload.code : undefined
  let message = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : failedMessage(what)
  if (code === undefined && /^HTTP \d+$/.test(message)) {
    message = msg('{message} (the Host may be older than this CLI: no /local-cli/{route} route)', {
      message,
      route: what,
    })
  }
  const error = new CliError(code === undefined ? message : msg('{code}: {message}', { code, message }))
  error.code = code ?? (status === undefined ? 'unknown-error' : `http-${status}`)
  if (status !== undefined) error.status = status
  return error
}

/**
 * One bridge call that keeps the HTTP status for `hostFailure` and returns the
 * parsed success payload only. A transport failure is a `network-error`, never
 * a guessed answer.
 */
async function callHost(url, init, what) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const failure = new CliError(msg('cannot reach {url}: {error} ({what})', { url, error: String(error?.message ?? error), what }))
    failure.code = 'network-error'
    throw failure
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = { ok: false, error: `HTTP ${response.status}` }
  }
  if (payload?.ok !== true) throw hostFailure(payload, what, response.status)
  return payload
}

async function fetchPermissions(host, reference) {
  return callHost(
    `${host.base}/local-cli/permissions?sessionId=${encodeURIComponent(reference)}`,
    { headers: authHeaders(host) },
    'permissions',
  )
}

async function submitPermission(host, request) {
  const body = { sessionId: request.sessionId, preset: request.preset, confirmed: request.confirmed === true }
  return callHost(
    `${host.base}/local-cli/permissions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify(body),
    },
    'permissions',
  )
}

async function fetchAwaiting(host, reference) {
  return callHost(
    `${host.base}/local-cli/awaiting?sessionId=${encodeURIComponent(reference)}`,
    { headers: authHeaders(host) },
    'awaiting',
  )
}

async function submitAnswer(host, request) {
  return callHost(
    `${host.base}/local-cli/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify({ sessionId: request.sessionId, callId: request.callId, answers: request.answers }),
    },
    'answer',
  )
}

// ------------------------------------------------ approval channel (routes contract)

/** GET /local-cli/approval; `claimId` is an exact wire value when given. */
async function fetchApprovalChannel(host, claimId) {
  const query = claimId === undefined ? '' : `?claimId=${encodeURIComponent(claimId)}`
  return callHost(`${host.base}/local-cli/approval${query}`, { headers: authHeaders(host) }, 'approval')
}

/** POST /local-cli/approval/claim; `sessionId` is passed through byte-for-byte. */
async function claimApprovalChannel(host, request) {
  const body = { sessionId: request.sessionId }
  if (request.leaseMs !== undefined) body.leaseMs = request.leaseMs
  return callHost(
    `${host.base}/local-cli/approval/claim`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify(body),
    },
    'approval/claim',
  )
}

async function heartbeatApprovalChannel(host, request) {
  return callHost(
    `${host.base}/local-cli/approval/heartbeat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify({ claimId: request.claimId }),
    },
    'approval/heartbeat',
  )
}

async function releaseApprovalChannel(host, request) {
  const body = { claimId: request.claimId }
  if (request.reason !== undefined) body.reason = request.reason
  return callHost(
    `${host.base}/local-cli/approval/release`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify(body),
    },
    'approval/release',
  )
}

async function submitApprovalDecision(host, request) {
  return callHost(
    `${host.base}/local-cli/approval/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify({ claimId: request.claimId, requestId: request.requestId, outcome: request.outcome }),
    },
    'approval/answer',
  )
}

async function fetchWorkspaces(host) {
  const payload = await callJson(`${host.base}/local-cli/workspaces`, { headers: authHeaders(host) }, 'workspaces')
  if (payload.ok !== true) throw new Error(payload.error ?? failedMessage('workspaces'))
  return payload.workspaces ?? []
}

function workspaceView(workspace) {
  if (workspace === undefined) return ''
  return `${dim('[ws]')} ${workspace.title ?? ''} ${dim(workspace.path ?? '')}`.trim()
}

async function createSession(host, options) {
  const body = { createWorkspace: options.createWorkspace === true }
  if (options.workspace !== undefined) body.workspace = options.workspace
  if (options.cwd !== undefined) body.cwd = options.cwd
  const payload = await callJson(
    `${host.base}/local-cli/create`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(host) }, body: JSON.stringify(body) },
    'create',
  )
  if (payload.ok !== true) {
    const error = new Error(payload.error ?? failedMessage('create'))
    error.payload = payload
    throw error
  }
  return payload
}

// ------------------------------------------------ workspace by directory
// The picker's "new conversation" entry keeps one workspace per directory. Paths
// are compared as normalized absolute paths, never by a directory's display
// name, so two directories called the same thing can never be confused.

function expandHomePath(value) {
  const text = String(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Absolute, dot-free form of a path, with symlinks resolved when the directory
 * exists. Both sides of a comparison go through this, so a cwd reported as
 * /private/var/... still matches a workspace recorded as /var/...
 */
function normalizedWorkspacePath(value) {
  const absolute = resolve(expandHomePath(value))
  try {
    return realpathSync(absolute)
  } catch {
    // A directory that is about to be created has no real path yet.
    return absolute
  }
}

/** The workspace registered for exactly this directory, if any. */
function workspaceForDirectory(workspaces, directory) {
  const wanted = normalizedWorkspacePath(directory)
  return workspaces.find(
    (workspace) =>
      typeof workspace?.path === 'string' &&
      workspace.path !== '' &&
      normalizedWorkspacePath(workspace.path) === wanted,
  )
}

/** Effective cwd: --cwd wins, otherwise the directory the command runs in. */
function effectiveCwdOf(options) {
  return typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
}

/**
 * Start the conversation behind the picker's "new conversation" entry.
 *
 * An explicit -w is authoritative: it goes straight to the bridge and is never
 * replaced by the cwd. Otherwise the effective cwd names the workspace; an
 * existing one is reused by id, and a missing one is registered by the bridge
 * in the same request that creates the Session (createWorkspace).
 */
async function startConversation(host, options, cwd) {
  if (options.workspace !== undefined) {
    const payload = await createSession(host, {
      workspace: options.workspace,
      createWorkspace: options.createWorkspace === true,
    })
    return { payload, reused: payload.created !== true }
  }
  const directory = normalizedWorkspacePath(cwd)
  let matched
  try {
    matched = workspaceForDirectory(await fetchWorkspaces(host), directory)
  } catch {
    // A listing failure must not block the conversation: the bridge still
    // reuses or registers the same directory through createWorkspace.
    matched = undefined
  }
  if (matched !== undefined) {
    const payload = await createSession(host, { workspace: String(matched.id) })
    return { payload, reused: true }
  }
  const payload = await createSession(host, { workspace: directory, createWorkspace: true })
  return { payload, reused: false }
}

/**
 * Classify delivery from a prompt route response.
 *
 * true      - the Host took the prompt (timeout, input-required, model error)
 * false     - an explicit refusal made before any prompt was queued
 * undefined - unknown; the request may have been accepted before it failed
 */
function responseAccepted(status, payload) {
  const code = typeof payload?.code === 'string' ? payload.code : undefined
  if (payload?.accepted === false || code === 'image-model-unsupported') return false
  if (payload?.accepted === true) return true
  if (payloadAccepted(payload)) return true
  // A plain 4xx answer (bad body, unknown Session, validation) is a refusal
  // before a prompt is queued. 409 is input-required (accepted) and 422 is the
  // image-model refusal, both handled above.
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 409 && status !== 422) {
    return false
  }
  return undefined
}

async function askOnce(host, body, extra = {}) {
  const signal = extra.signal
  let response
  try {
    response = await fetch(`${host.base}/local-cli/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortFailure()
    throw new Error(msg('cannot reach {url}: {error} ({what})', { url: host.base, error: String(error?.message ?? error), what: msg('answer') }))
  }
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  // Keep the verdict non-enumerable: JSON output still prints exactly what the
  // bridge returned, while sendTurn can tell an explicit refusal apart from an
  // unknown delivery.
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Object.prototype.hasOwnProperty.call(payload, 'accepted')
  ) {
    const accepted = responseAccepted(response.status, payload)
    if (accepted !== undefined) {
      Object.defineProperty(payload, 'accepted', { value: accepted, enumerable: false, configurable: true })
    }
  }
  return payload
}

/** A payload that came back after the Host already took the prompt. */
function payloadAccepted(payload) {
  if (payload === undefined || payload === null) return false
  if (payload.ok === true || payload.accepted === true) return true
  return payload.code === 'timeout' || payload.code === 'input-required' || payload.code === 'model-error'
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

/** Ctrl+C in connect: stop waiting locally, never claim the turn was cancelled. */
function abortFailure() {
  const error = new Error(msg('local wait stopped (the remote Session may still be running)'))
  error.name = 'AbortError'
  return error
}


// ---------------------------------------------------------------- markdown
// Terminal rendering is line-oriented: a stream is buffered until a newline so
// inline markers such as **bold** never split across chunks.

function inlineCode(text) {
  return cyan(text)
}

function formatInline(line) {
  const codes = []
  let out = String(line).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, text) => bold(text))
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, lead, text) => lead + paint('3', text))
  out = out.replace(/__([^_]+)__/g, (_, text) => bold(text))
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `${text} ${dim(`(${url})`)}`)
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => inlineCode(codes[Number(index)]))
  return out
}

function formatLine(line) {
  if (/^\s*```/.test(line)) return dim(line)
  if (/^\s*#{1,6}\s/.test(line)) return bold(line.replace(/^\s*#{1,6}\s*/, ''))
  if (/^\s*[-*+]\s/.test(line)) return line.replace(/^(\s*)[-*+]\s/, '$1• ')
  if (/^\s*>\s?/.test(line)) return dim(`│ ${line.replace(/^\s*>\s?/, '')}`)
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) return dim('─'.repeat(46))
  return formatInline(line)
}

/** Render a complete block of Markdown one line at a time. */
function renderMarkdownBlock(text, prefix = '  ') {
  let inCode = false
  const lines = []
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      lines.push(prefix + dim(line))
      continue
    }
    lines.push(prefix + (inCode ? dim(line) : formatLine(line)))
  }
  return lines.join('\n')
}

/** Render streamed Markdown: buffer a partial line, emit complete ones. */
function createMarkdownStream(output) {
  let buffer = ''
  let inCode = false
  const emit = (line) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      output(`${dim(line)}\n`)
      return
    }
    output(`${inCode ? dim(line) : formatLine(line)}\n`)
  }
  return {
    push(chunk) {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    },
    flush() {
      if (buffer !== '') {
        emit(buffer)
        buffer = ''
      }
    },
    get pending() {
      return buffer !== ''
    },
  }
}

function argSummary(raw) {
  let value = raw
  try {
    const args = JSON.parse(raw || '{}')
    const picked =
      args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.name ?? ''
    value = typeof picked === 'string' ? picked : JSON.stringify(picked)
  } catch {
    value = String(raw ?? '')
  }
  return value.length > 70 ? `${value.slice(0, 70)}…` : value
}

/**
 * Ask through the streaming endpoint: text arrives as it is produced, with tool
 * traffic printed as one dim line per call. Falls back to the blocking payload
 * when the stream reports a failure frame.
 */
async function askStream(host, body, print = true, extra = {}) {
  const signal = extra.signal
  // The full-screen TUI consumes frames through onFrame instead of stdout: the
  // protocol (and its `accepted` verdicts) stay exactly the ones verified here.
  const onFrame = typeof extra.onFrame === 'function' ? extra.onFrame : undefined
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(`${host.base}/local-cli/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(host) },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw abortFailure()
    throw new Error(msg('cannot reach {url}: {error} ({what})', { url: host.base, error: String(error?.message ?? error), what: msg('answer') }))
  }
  if (response.ok !== true || response.body === null) {
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
    return {
      ...payload,
      ok: payload?.ok === true,
      accepted: responseAccepted(response.status, payload),
      elapsedMs: Date.now() - startedAt,
      tools: 0,
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let sessionId
  let failure
  let done
  let toolCalls = 0
  let printedText = false
  let lineStart = true

  const write = (text) => {
    if (print !== true) return
    process.stdout.write(text)
    lineStart = text.endsWith('\n')
  }
  const breakLine = () => {
    if (print === true && lineStart === false) write('\n')
  }

  const markdown = createMarkdownStream((text) => write(text))
  const stopWith = (next) => {
    if (failure === undefined) failure = next
  }
  const handle = (frame) => {
    switch (frame.t) {
      case 'session':
        sessionId = frame.sessionId
        break
      case 'delta':
        answer += frame.text
        if (frame.text !== '') {
          printedText = true
          markdown.push(frame.text)
        }
        break
      case 'tool':
        toolCalls += 1
        markdown.flush()
        breakLine()
        write(dim(`  ⚙ ${frame.name} ${argSummary(frame.arguments)}`) + '\n')
        break
      case 'tool-result': {
        const line = firstLine(frame.text ?? '')
        if (line !== '') {
          markdown.flush()
          breakLine()
          write(dim(`  ${frame.ok === false ? red('✗') : green('✓')} ${line}`) + '\n')
        }
        break
      }
      case 'input-required':
        stopWith({
          ok: false,
          code: 'input-required',
          error: msg('the turn waits for a human answer'),
          pending: frame.pending,
          sessionId,
          text: answer,
          accepted: true,
        })
        break
      case 'timeout':
        stopWith({
          ok: false,
          code: 'timeout',
          error: msg('no settled turn in time'),
          sessionId,
          text: answer,
          accepted: true,
        })
        break
      case 'error': {
        // The worker reports an explicit refusal (for example an image prompt
        // against a text-only model) with a stable code and accepted:false.
        // Without an explicit verdict the delivery is unknown.
        const code = typeof frame.code === 'string' && frame.code !== '' ? frame.code : 'stream-error'
        let accepted
        if (frame.accepted === false || code === 'image-model-unsupported') accepted = false
        else if (frame.accepted === true) accepted = true
        else accepted = undefined
        stopWith({
          ok: false,
          code,
          error: frame.error ?? (code === 'stream-error' ? msg('the turn failed') : code),
          sessionId: frame.sessionId ?? sessionId,
          text: answer,
          accepted,
        })
        break
      }
      case 'turn-end': {
        const reason = frame.reason
        if (reason !== undefined && reason !== 'complete' && reason !== 'completed' && reason !== 'done') {
          stopWith({
            ok: false,
            code: 'turn-end',
            error: msg('the turn ended with reason: {reason}', { reason: String(reason) }),
            sessionId,
            text: answer,
            accepted: true,
          })
        }
        break
      }
      case 'done':
        done = frame
        break
      default:
        break
    }
  }

  const consume = (raw) => {
    const line = raw.trim()
    if (line === '') return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // A partial or unknown frame is skipped; the stream continues.
      return
    }
    if (onFrame !== undefined) {
      try {
        onFrame(frame)
      } catch {
        // A broken UI hook must never break the protocol or the turn.
      }
    }
    handle(frame)
  }

  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        consume(line)
      }
    }
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      markdown.flush()
      throw abortFailure()
    }
    // A socket reset keeps whatever arrived: the caller still prints the
    // partial answer and the Session id instead of pretending nothing happened.
    stopWith({
      ok: false,
      code: 'stream-interrupted',
      error: msg('the stream was cut before the turn settled: {error}', { error: String(error?.message ?? error) }),
      sessionId,
      text: answer,
      accepted: undefined,
    })
  }
  // A server that ends the body without a final newline still owes us its last
  // frame: NDJSON readers must flush the tail buffer at EOF.
  buffer += decoder.decode()
  if (buffer.trim() !== '') consume(buffer)
  buffer = ''

  const elapsedMs = Date.now() - startedAt
  if (failure !== undefined) {
    markdown.flush()
    return {
      ...failure,
      sessionId: failure.sessionId ?? sessionId,
      text: failure.text !== undefined ? failure.text : answer,
      elapsedMs,
      tools: toolCalls,
    }
  }
  if (done === undefined) {
    markdown.flush()
    return {
      ok: false,
      code: 'incomplete-stream',
      error: msg('the stream ended before the done frame; the turn may still be running in the app'),
      sessionId,
      text: answer,
      accepted: undefined,
      elapsedMs,
      tools: toolCalls,
    }
  }
  if (done.ok === false) {
    markdown.flush()
    return {
      ok: false,
      code: typeof done.code === 'string' && done.code !== '' ? done.code : 'turn-error',
      error: done.error ?? msg('the turn failed'),
      sessionId: done.sessionId ?? sessionId,
      text: typeof done.text === 'string' ? done.text : answer,
      accepted: done.accepted === false ? false : done.accepted === true ? true : undefined,
      elapsedMs,
      tools: toolCalls,
    }
  }
  const finalText = answer !== '' ? answer : typeof done.text === 'string' ? done.text : ''
  if (print === true && printedText === false && finalText !== '') {
    process.stdout.write(`${renderMarkdownBlock(finalText, '  ')}\n`)
  } else if (print === true) {
    markdown.flush()
    breakLine()
  }
  return { ok: true, sessionId: done.sessionId ?? sessionId, text: finalText, elapsedMs, tools: toolCalls }
}

/** Shown when the current model cannot accept images. */
const imageModelHint = () =>
  msg(
    'the current model does not support image input. Choose a vision-capable model in the DeepSeek Harness app and retry; this CLI will not switch models for you.',
  )

function isImageModelUnsupported(payload) {
  if (payload === undefined || payload === null) return false
  if (payload.code === 'image-model-unsupported') return true
  return typeof payload.error === 'string' && payload.error.includes('image-model-unsupported')
}

function printFailure(payload) {
  process.stderr.write(`${red(msg('error'))}: ${payload.code ?? ''} ${payload.error ?? msg('unknown failure')}\n`)
  if (typeof payload.text === 'string' && payload.text !== '') {
    process.stderr.write(`\n${msg('partial answer:')}\n${payload.text}\n`)
  }
  if (payload.pending !== undefined) {
    process.stderr.write(`${msg('waiting for a human in the app: {pending}', { pending: JSON.stringify(payload.pending) })}\n`)
  }
  if (payload.sessionId !== undefined) process.stderr.write(`${msg('session: {id}', { id: payload.sessionId })}\n`)
  if (payload.accepted === true) {
    process.stderr.write(
      msg(
        'the prompt was accepted by the Host; it will not be resent automatically. Check /status and /history in connect before prompting again.',
      ) + '\n',
    )
  }
  if (isImageModelUnsupported(payload)) {
    process.stderr.write(`${yellow(msg('hint'))}: ${imageModelHint()}\n`)
  }
  if (payload.code === 'stream-interrupted' || payload.code === 'incomplete-stream') {
    process.stderr.write(
      msg(
        'the remote Session may still be running; check the app before resending so the prompt is not queued twice.',
      ) + '\n',
    )
  }
}

/** The picker's first row, kept in one place because two pickers print it. */
const newConversationLabel = () => msg('Enter / n for a new conversation in this directory')
const PICK_CANCELLED = Symbol('pick cancelled')

/**
 * Read one picker line. A closed or ended stdin is a cancellation, never a
 * default: Ctrl+C / Ctrl+D must not fall through to creating a conversation.
 */
function questionOrCancelled(rl, prompt) {
  return new Promise((settle) => {
    let done = false
    const finish = (value) => {
      if (done === true) return
      done = true
      rl.off('close', onClose)
      settle(value)
    }
    const onClose = () => finish(PICK_CANCELLED)
    rl.once('close', onClose)
    rl.question(prompt).then(
      (answer) => finish(answer),
      () => finish(PICK_CANCELLED),
    )
  })
}

/**
 * Pick the connect destination: an existing Session, or the "new conversation"
 * entry. Unlike pickSession (history/queue, which need an existing Session),
 * this entry is offered first and an empty list goes straight to the new flow
 * instead of failing with "no Sessions yet".
 */
async function pickConnectDestination(host, options) {
  const rows = await fetchSessions(host, 20)
  const detail =
    options.workspace === undefined
      ? normalizedWorkspacePath(effectiveCwdOf(options))
      : msg('workspace {name}', { name: options.workspace })
  if (rows.length === 0) {
    process.stdout.write(`${dim(msg('no Sessions yet · a new conversation will be created in {detail}', { detail }))}\n`)
    return { action: 'new' }
  }
  process.stdout.write(`${bold(msg('recent Sessions'))}\n`)
  process.stdout.write(`  ${cyan(' 0')}) ${newConversationLabel()} ${dim(`· ${detail}`)}\n`)
  rows.forEach((row, index) => {
    process.stdout.write(`  ${String(index + 1).padStart(2)}) ${describe(row)}\n`)
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    rl.on('SIGINT', () => rl.close())
    const answer = await questionOrCancelled(
      rl,
      `\n${bold(msg('which one?'))} ${msg('number, id prefix, or Enter / n for a new conversation')} ${dim('>')} `,
    )
    if (answer === PICK_CANCELLED) return { action: 'cancel' }
    const text = String(answer).trim()
    if (text === '' || text === '0' || /^(n|new)$/i.test(text)) return { action: 'new' }
    if (/^\d+$/.test(text)) {
      const row = rows[Number(text) - 1]
      if (row === undefined) throw new Error(msg('no entry {text}', { text }))
      return { action: 'session', row }
    }
    const matches = rows.filter((row) => String(row.sessionId).startsWith(text))
    if (matches.length === 1) return { action: 'session', row: matches[0] }
    if (matches.length === 0) throw new Error(msg('no Session starts with {text}', { text }))
    throw new Error(msg('{count} Sessions start with {text}', { count: matches.length, text }))
  } finally {
    rl.close()
  }
}

async function pickSession(host) {
  const rows = await fetchSessions(host, 20)
  if (rows.length === 0) throw new Error(msg('no Sessions yet - run `dsh-ask "text"` first'))
  process.stdout.write(`${bold(msg('recent Sessions'))}\n`)
  rows.forEach((row, index) => {
    process.stdout.write(`  ${String(index + 1).padStart(2)}) ${describe(row)}\n`)
  })
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (
    await rl.question(`\n${bold(msg('which one?'))} ${msg('number or id prefix')} ${dim('>')} `)
  ).trim()
    if (answer === '') return undefined
    if (/^\d+$/.test(answer)) {
      const picked = rows[Number(answer) - 1]
      if (picked === undefined) throw new Error(msg('no entry {text}', { text: answer }))
      return picked
    }
    const matches = rows.filter((row) => String(row.sessionId).startsWith(answer))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) throw new Error(msg('no Session starts with {text}', { text: answer }))
    throw new Error(msg('{count} Sessions start with {text}', { count: matches.length, text: answer }))
  } finally {
    rl.close()
  }
}

/** Look a Session's display title up once, without failing the render. */
async function titleOf(host, sessionId) {
  try {
    const rows = await fetchSessions(host, 50)
    const hit = rows.find((row) => row.sessionId === sessionId)
    return hit === undefined ? '' : labelOf(hit)
  } catch {
    return ''
  }
}

function headerOf(payload, title) {
  const parts = []
  if (typeof title === 'string' && title !== '') parts.push(title)
  parts.push(shortId(payload.sessionId))
  if (payload.running === true) parts.push(msg('running'))
  // Only claim truncation when the window really starts mid-conversation.
  if (payload.more === true && payload.items?.[0]?.kind !== 'user') parts.push(msg('earlier messages omitted'))
  return parts.join(' · ')
}

async function showHistory(host, reference, tail, options, knownTitle) {
  const payload = await fetchTranscript(host, reference, tail)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return payload
  }
  const title = knownTitle ?? (await titleOf(host, payload.sessionId))
  process.stdout.write(`${renderTranscript(payload, headerOf(payload, title))}\n`)
  return { ...payload, title }
}

const CONNECT_COMMANDS = [
  ['/attach', msg('attach images: /attach <path> [path ...] (quoted drag-drops work)')],
  ['/paste', msg('attach the clipboard image (macOS)')],
  ['/attachments', msg('list pending and already-sent attachments')],
  ['/detach', msg('remove attachments: /detach <n> | /detach all')],
  ['/preview', msg('render an attachment in this terminal: /preview <n>')],
  ['/send', msg('send the pending attachments with no text')],
  ['/multiline', msg('compose one prompt over several lines, ending with /end')],
  ['/status', msg('Session, cwd, queue, attachments and the last turn')],
  ['/clear', msg('clear the screen only; the conversation is untouched')],
  ['/history', msg('reprint the conversation')],
  ['/pending', msg('queued prompts: /edit <n> <text>, /drop <n>, /steer <n>')],
  ['/id', msg('print the full Session id')],
  ['/help', msg('this list')],
  ['/exit', msg('leave (also /quit or Ctrl+D)')],
]

const CONNECT_COMMAND_WORDS = [
  ...new Set([...CONNECT_COMMANDS.map(([name]) => name), '/end', '/quit', '/queue']),
]

/** Tab completion for command names only; arguments are free text. */
function completeConnectCommand(line) {
  if (line.startsWith('/') !== true) return [[], line]
  const head = line.split(/\s+/)[0]
  const hits = CONNECT_COMMAND_WORDS.filter((word) => word.startsWith(head))
  return [hits.length === 0 ? [] : hits, head]
}

function renderConnectHelp() {
  const lines = [bold(msg('connect commands'))]
  for (const [name, summary] of CONNECT_COMMANDS) lines.push(`  ${name.padEnd(13)} ${summary}`)
  lines.push(dim(`  ${msg('Ctrl+C stops only the local wait; the remote Session may keep running.')}`))
  lines.push(dim(`  ${msg('Tab completes a command name.')}`))
  return lines.join('\n')
}

function renderAttachments(attachments) {
  const { pending, sent } = attachments
  const lines = [
    dim(msg('attachments · {pending} pending · {sent} sent', { pending: pending.length, sent: sent.length })),
  ]
  if (pending.length === 0 && sent.length === 0) {
    lines.push(dim(`  ${msg('(none) · /attach <path> or /paste adds one')}`))
    return lines.join('\n')
  }
  pending.forEach((image, index) => {
    lines.push(`  ${String(index + 1).padStart(2)}) ${safeImageName(image)} (${imageLabel(image)}, ${formatBytes(image.bytes)})`)
  })
  if (sent.length > 0) {
    lines.push(
      dim(`  ${msg('sent / unconfirmed - kept for reference, never queued again automatically:')}`),
    )
    sent.forEach((image, index) => {
      const at = new Date(image.at).toLocaleTimeString()
      const session =
        image.sessionId === undefined ? '' : ` · ${msg('session: {id}', { id: image.sessionId })}`
      lines.push(
        `  ${String(pending.length + index + 1).padStart(2)}) ${safeImageName(image)} (${imageLabel(image)}, ${formatBytes(image.bytes)}) · ${image.reason ?? msg('accepted')} ${at}${session}`,
      )
    })
  }
  return lines.join('\n')
}

/**
 * The adapter is the whole bridge surface the full-screen TUI is allowed to
 * touch. It reuses the calls already verified above: no second protocol, no
 * direct stdout printing, and the same accepted/delivery semantics.
 */
function createTuiAdapter(host, options) {
  const caps = hostImageCapabilities(host)
  const tail = Math.min(Math.max(options.tail ?? 60, 1), 300)

  // The interactive UI must keep its lease alive while a claim is active.
  // One loop per adapter; a failed heartbeat stops the loop (no retry, no
  // implicit re-claim), and release always stops it.
  let approvalHeartbeat
  const stopApprovalHeartbeat = () => {
    if (approvalHeartbeat === undefined) return
    clearInterval(approvalHeartbeat.timer)
    approvalHeartbeat = undefined
  }
  const startApprovalHeartbeat = (claim) => {
    stopApprovalHeartbeat()
    const leaseMs = Number(claim?.leaseMs)
    const interval = Math.max(250, Math.min(15_000, Math.floor((Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 60_000) / 3)))
    const timer = setInterval(() => {
      heartbeatApprovalChannel(host, { claimId: claim.claimId }).catch(() => stopApprovalHeartbeat())
    }, interval)
    timer.unref?.()
    approvalHeartbeat = { timer }
  }

  return {
    endpoint: host.base,
    pid: host.instance?.pid,
    images: caps,
    listSessions: (limit) => fetchSessions(host, Math.min(Math.max(Number(limit) || 20, 1), 50)),
    listSessionsScoped: (request) => fetchSessionsScoped(host, request),
    fetchSessionContext: (sessionId) => fetchSessionContext(host, sessionId),
    fetchTranscript: (sessionId, limit) =>
      fetchTranscript(host, sessionId, Math.min(Math.max(Number(limit) || tail, 1), 300)),
    newConversationForDirectory: async (cwd) => {
      const started = await startConversation(host, { createWorkspace: options.createWorkspace === true }, cwd)
      return { sessionId: started.payload.sessionId, workspace: started.payload.workspace }
    },
    newConversationWithOptions: async (cwd) => {
      const started = await startConversation(host, options, cwd)
      return { sessionId: started.payload.sessionId, workspace: started.payload.workspace }
    },
    ask: (body, extra) => askStream(host, body, false, extra),
    askBlocking: (body, extra) => askOnce(host, body, extra),
    fetchQueue: (sessionId) => fetchQueue(host, sessionId),
    fetchStatus: (sessionId) => fetchStatus(host, sessionId),
    fetchPermissions: (sessionId) => fetchPermissions(host, sessionId),
    submitPermission: (request) => submitPermission(host, request),
    fetchAwaiting: (sessionId) => fetchAwaiting(host, sessionId),
    submitAnswer: (request) => submitAnswer(host, request),
    fetchApprovalChannel: (claimId) => fetchApprovalChannel(host, claimId),
    claimApprovalChannel: async (request) => {
      const payload = await claimApprovalChannel(host, request)
      if (typeof payload?.claimId === 'string' && payload.claimId !== '') startApprovalHeartbeat(payload)
      return payload
    },
    heartbeatApprovalChannel: (request) => heartbeatApprovalChannel(host, request),
    releaseApprovalChannel: async (request) => {
      try {
        return await releaseApprovalChannel(host, request)
      } finally {
        stopApprovalHeartbeat()
      }
    },
    submitApprovalDecision: (request) => submitApprovalDecision(host, request),
    mutateQueue: (sessionId, itemId, action, text) => mutateQueue(host, sessionId, itemId, action, text),
    listWorkspaces: () => fetchWorkspaces(host),
    loadPaths: async (text, cwd) => {
      const paths = splitDragPaths(text, { cwd })
      return loadImages(paths, { cwd })
    },
    loadClipboard: () => readClipboardImage(),
    validateBatch: (images) => prepareImageBatch(images, caps),
  }
}

/**
 * Try the full-screen TUI first. Returns undefined when the caller must fall
 * back to the line-based connect flow (no TTY, --plain, --json, TERM=dumb, or a
 * missing native UI binary), so the old behaviour is never lost.
 */
async function runTuiConnect(options, words, { initialPicker = false } = {}) {
  // Cheap opt-outs first: a piped connect, --plain, --json or TERM=dumb must not
  // even load the TUI modules (the old path is the only one that runs).
  if (
    options.plain === true ||
    options.json === true ||
    process.env.DSH_ASK_PLAIN === '1' ||
    process.env.TERM === 'dumb' ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    return undefined
  }
  let tui
  try {
    tui = await import('./dsh-tui.mjs')
  } catch (error) {
    process.stderr.write(
      `${dim(msg('full-screen TUI unavailable'))} · ${String(error?.message ?? error)} · ${msg('using the line-based UI')}\n`,
    )
    return undefined
  }
  if (
    tui.tuiEligible({
      json: options.json,
      plain: options.plain,
      stdin: process.stdin,
      stdout: process.stdout,
      env: process.env,
    }) !== true
  ) {
    return undefined
  }
  let createScreen
  try {
    createScreen = await tui.resolveScreenFactory()
  } catch (error) {
    process.stderr.write(
      `${dim(msg('full-screen TUI unavailable'))} · ${String(error?.message ?? error)} · ${msg('falling back to the line-based UI (--plain)')}\n`,
    )
    return undefined
  }
  const host = await connectToHost(options)
  try {
    return await tui.runTui({
      adapter: createTuiAdapter(host, options),
      createScreen,
      options: {
        initialSession: options.sessionId ?? (words.length > 0 ? words.join(' ') : undefined),
        initialPicker,
        cwd: effectiveCwdOf(options),
        workspace: options.workspace,
        createWorkspace: options.createWorkspace === true,
        timeoutMs: options.timeoutMs ?? 180_000,
        tail: Math.min(Math.max(options.tail ?? 60, 1), 300),
        stream: options.stream,
        lang: LANGUAGE,
        noHistory: options.noHistory === true,
      },
    })
  } catch (error) {
    // The binary exists but could not be spawned (removed mid-start, wrong
    // architecture, ...): never leave the user without a UI. Nothing has been
    // created yet, so the line-based path is a clean fallback.
    if (error?.code === 'native-ui-unavailable') {
      process.stderr.write(
        `${dim(msg('native UI unavailable'))} · ${String(error?.message ?? error)} · ${msg('falling back to the line-based UI (--plain)')}\n`,
      )
      return undefined
    }
    throw error
  }
}

async function runConnect(argv, { initialPicker = false } = {}) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const tuiCode = await runTuiConnect(options, words, { initialPicker })
  if (tuiCode !== undefined) return tuiCode
  const host = await connectToHost(options)
  const tail = Math.min(Math.max(options.tail ?? 60, 1), 300)
  let sessionCwd = effectiveCwdOf(options)
  const caps = hostImageCapabilities(host)

  let target = options.sessionId ?? (words.length > 0 ? words.join(' ') : undefined)
  let picked
  let startingNew = false
  if (target === undefined) {
    if (process.stdin.isTTY !== true) {
      throw new Error(msg('no Session given and stdin is not a terminal - pass a Session id'))
    }
    const destination = await pickConnectDestination(host, options)
    if (destination.action === 'cancel') {
      process.stdout.write(`${dim(msg('nothing picked'))} · ${msg('no conversation was created')}\n`)
      return 0
    }
    if (destination.action === 'new') {
      startingNew = true
    } else {
      picked = destination.row
      target = picked.sessionId
    }
  }

  if (startingNew === true) {
    let started
    try {
      started = await startConversation(host, options, sessionCwd)
    } catch (error) {
      if (error.payload !== undefined) {
        printFailure(error.payload)
        return 1
      }
      throw error
    }
    target = started.payload.sessionId
    const workspace = started.payload.workspace
    if (typeof workspace?.path === 'string' && workspace.path !== '') sessionCwd = workspace.path
    const title = typeof workspace?.title === 'string' && workspace.title !== '' ? `${workspace.title} · ` : ''
    process.stdout.write(`${dim(msg('new conversation'))} ${target}\n`)
    process.stdout.write(
      `${labelCell('workspace')}${title}${sessionCwd} ${dim(started.reused ? msg('(reused)') : msg('(created)'))}\n\n`,
    )
  } else if (options.noHistory !== true) {
    const payload = await fetchTranscript(host, target, tail)
    target = payload.sessionId
    const title = picked === undefined ? await titleOf(host, target) : labelOf(picked)
    process.stdout.write(`${renderTranscript(payload, headerOf(payload, title))}\n\n`)
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completeConnectCommand,
  })

  const attachments = { pending: [], sent: [] }
  let multiline = null
  let active = null
  let lastTurn
  let lastFailure

  const print = (text = '') => process.stdout.write(`${text}\n`)

  const addImages = (images) => {
    if (caps === undefined) {
      print(`${red(msg('images unavailable'))} · ${imageUpgradeHint()}`)
      return []
    }
    try {
      const combined = prepareImageBatch([...attachments.pending, ...images], caps)
      const added = combined.slice(attachments.pending.length)
      attachments.pending.push(...added)
      return added
    } catch (error) {
      print(`${red(msg('cannot attach'))} · ${String(error?.message ?? error)}`)
      return []
    }
  }

  const describeAdded = (added) => {
    for (const image of added) {
      print(
        msg('attached {name} ({label}, {bytes})', {
          name: safeImageName(image),
          label: imageLabel(image),
          bytes: formatBytes(image.bytes),
        }),
      )
    }
  }

  const addPaths = async (raw) => {
    if (caps === undefined) {
      print(`${red(msg('images unavailable'))} · ${imageUpgradeHint()}`)
      return
    }
    try {
      // splitDragPaths is what understands a Terminal drag: quoted paths and
      // backslash-escaped spaces, several paths in one paste.
      const paths = splitDragPaths(raw, { cwd: sessionCwd })
      const images = await loadImages(paths, { cwd: sessionCwd })
      describeAdded(addImages(images))
    } catch (error) {
      print(`${red(msg('cannot attach'))} · ${String(error?.message ?? error)}`)
    }
  }

  const addClipboard = async () => {
    if (caps === undefined) {
      print(`${red(msg('images unavailable'))} · ${imageUpgradeHint()}`)
      return
    }
    try {
      const image = await readClipboardImage()
      describeAdded(addImages([image]))
    } catch (error) {
      print(`${red(msg('cannot paste'))} · ${String(error?.message ?? error)}`)
    }
  }

  const markSent = (batch, reason, sessionId) => {
    const at = Date.now()
    for (const image of batch) attachments.sent.push({ ...image, reason, sessionId, at })
    if (attachments.sent.length > 30) attachments.sent.splice(0, attachments.sent.length - 30)
  }

  const combinedAttachments = () => [...attachments.pending, ...attachments.sent]

  const detach = (argument) => {
    if (argument === 'all') {
      const count = combinedAttachments().length
      attachments.pending = []
      attachments.sent = []
      print(dim(msg('detached {count} attachment(s)', { count })))
      return
    }
    if (!/^\d+$/.test(argument)) {
      print(msg('usage: /detach <n> | /detach all'))
      return
    }
    const index = Number(argument)
    if (index >= 1 && index <= attachments.pending.length) {
      const [removed] = attachments.pending.splice(index - 1, 1)
      print(dim(msg('detached {name}', { name: safeImageName(removed) })))
      return
    }
    const sentIndex = index - attachments.pending.length - 1
    if (sentIndex >= 0 && sentIndex < attachments.sent.length) {
      const [removed] = attachments.sent.splice(sentIndex, 1)
      print(dim(msg('detached {name}', { name: safeImageName(removed) })))
      return
    }
    print(msg('no attachment {argument}', { argument }))
  }

  const previewAttached = (argument) => {
    const images = combinedAttachments()
    if (images.length === 0) {
      print(dim(msg('no attachments · /attach <path> or /paste adds one')))
      return
    }
    let image
    if (argument === '') image = images[0]
    else if (/^\d+$/.test(argument)) image = images[Number(argument) - 1]
    else {
      print(msg('usage: /preview <n>'))
      return
    }
    if (image === undefined) {
      print(msg('no attachment {argument}', { argument }))
      return
    }
    try {
      previewImage(image, { mode: options.preview ?? 'auto', output: process.stdout })
    } catch (error) {
      print(`${red(msg('cannot preview'))} · ${String(error?.message ?? error)}`)
    }
  }

  const sendTurn = async (text, { onlyAttachments = false } = {}) => {
    if (text === '' && attachments.pending.length === 0) {
      print(dim(onlyAttachments ? msg('nothing to send: no pending attachments') : msg('nothing to send')))
      return false
    }
    if (attachments.pending.length > 0 && caps === undefined) {
      print(`${red(msg('cannot send images'))} · ${imageUpgradeHint()}`)
      return false
    }
    // Take ownership of the pending batch before the request: a second /send
    // during the wait can never queue the same files twice.
    const batch = attachments.pending.slice()
    attachments.pending = []
    const body = {
      sessionId: target,
      text,
      timeoutMs: options.timeoutMs ?? 180_000,
      cwd: sessionCwd,
    }
    if (batch.length > 0) {
      body.images = batch.map(({ mediaType, data, name }) => ({ mediaType, data, name }))
    }
    const controller = new AbortController()
    active = controller
    if (process.stdout.isTTY === true && options.json !== true) {
      print(dim(msg('… waiting for the turn · Ctrl+C stops only this local wait · the remote Session may keep running')))
    }
    const startedAt = Date.now()
    let payload
    try {
      payload =
        options.stream === false
          ? await askOnce(host, body, { signal: controller.signal })
          : await askStream(host, body, true, { signal: controller.signal })
    } catch (error) {
      active = null
      if (isAbortError(error)) {
        if (batch.length > 0) markSent(batch, msg('local wait stopped'), target)
        print(
          `${yellow(msg('stopped local wait'))} · ${dim(msg('the remote Session may still be running; the turn was not cancelled remotely'))}`,
        )
        if (batch.length > 0) {
          print(dim(msg('the {count} attachment(s) are listed as unconfirmed and will not be resent automatically', { count: batch.length })))
        }
        lastFailure = { code: 'aborted' }
      } else {
        // The POST may have reached the Host before the connection failed, so
        // never put the files back in pending: the next plain text turn would
        // attach them a second time. Keep them visible as unconfirmed instead.
        if (batch.length > 0) markSent(batch, msg('delivery unknown'), target)
        process.stderr.write(`${red(msg('error'))}: ${String(error?.message ?? error)}\n`)
        print(
          dim(
            msg('delivery is unknown · session {session} · check /history before resending; the prompt may already be queued', {
              session: target,
            }),
          ),
        )
        if (batch.length > 0) {
          print(
            dim(
              msg('the {count} attachment(s) are listed as unconfirmed and will not be attached to later text automatically', {
                count: batch.length,
              }),
            ),
          )
        }
        lastFailure = { code: 'delivery-unknown' }
      }
      return false
    }
    active = null
    const elapsedMs = payload.elapsedMs ?? Date.now() - startedAt
    const tools = payload.tools ?? 0
    const shownSession = payload.sessionId ?? target
    lastTurn = { elapsedMs, tools, sessionId: shownSession, ok: payload.ok === true }
    const summary = dim(
      `· ${formatDuration(elapsedMs)} · ${tools} ${msg(tools === 1 ? 'tool call' : 'tool calls')} · ${msg(
        'session: {id}',
        { id: shownSession },
      )}`,
    )
    if (payload.ok === true) {
      if (options.stream === false) {
        // With piped input readline never echoed the line, so start on a fresh row.
        if (process.stdin.isTTY !== true) process.stdout.write('\n')
        print(renderMarkdownBlock(payload.text ?? '', '  '))
      }
      print(summary)
      return true
    }
    lastFailure = payload
    printFailure(payload)
    // Only an explicit refusal may return the files to pending. An unknown
    // outcome keeps them out of the next request: the Host may already hold
    // the image prompt.
    const accepted = payload.accepted
    if (batch.length > 0) {
      if (accepted === false) {
        attachments.pending = [...batch, ...attachments.pending]
        print(dim(msg('attachments kept locally: the Host explicitly did not accept this prompt, so nothing was queued')))
      } else {
        markSent(batch, accepted === true ? (payload.code ?? 'accepted') : (payload.code ?? 'unconfirmed'), payload.sessionId ?? target)
        if (accepted !== true) {
          print(
            dim(
              msg('attachments marked unconfirmed · session {session} · check /history before resending; the prompt may already be queued', {
                session: payload.sessionId ?? target,
              }),
            ),
          )
        }
      }
    }
    if (isImageModelUnsupported(payload)) {
      print(
        `${yellow(msg('model cannot see images'))} · ${dim(msg('choose a vision-capable model in the app, then /send again; the CLI never switches models for you'))}`,
      )
    }
    print(summary)
    return false
  }

  const showStatus = async () => {
    let running = msg('unknown')
    let queued = msg('unknown')
    try {
      const queue = await fetchQueue(host, target)
      running = queue.running === true ? msg('running') : msg('idle')
      queued = String((queue.items ?? []).length)
    } catch {
      // A status read must not fail the interactive loop.
    }
    print(`${dim(labelCell('session'))}${target}`)
    print(`${dim(labelCell('cwd'))}${sessionCwd}`)
    print(`${dim(labelCell('state'))}${running} · ${queued} ${msg('queued')}`)
    print(
      `${dim(labelCell('attachments'))}${attachments.pending.length} ${msg('pending')} · ${attachments.sent.length} ${msg('sent')}`,
    )
    print(
      `${dim(labelCell('images'))}${
        caps === undefined
          ? msg('not supported by this Host (update DeepSeek Harness)')
          : msg('supported (up to {count})', { count: imageLimits(caps).maxImages })
      }`,
    )
    print(`${dim(labelCell('endpoint'))}${host.base}${host.instance?.pid === undefined ? '' : dim(` · pid ${host.instance.pid}`)}`)
    if (lastTurn !== undefined) {
      print(
        `${dim(labelCell('last turn'))}${lastTurn.ok ? msg('ok') : msg('failed')} · ${formatDuration(lastTurn.elapsedMs)} · ${lastTurn.tools} ${msg('tool calls')} · ${msg('session: {id}', { id: lastTurn.sessionId })}`,
      )
    }
    if (lastFailure !== undefined) {
      print(`${dim(labelCell('last error'))}${lastFailure.code ?? msg('unknown')}`)
    }
  }

  print(dim(msg('── connected ──')))
  print(`${dim(labelCell('session'))}${target}`)
  print(`${dim(labelCell('cwd'))}${sessionCwd}`)
  print(
    dim(
      caps === undefined
        ? msg('images  not supported by this Host · update DeepSeek Harness for attachments')
        : msg('images  supported · up to {count} attached per prompt', { count: imageLimits(caps).maxImages }),
    ),
  )
  print(dim(msg('commands /help · /attach /paste /attachments · Ctrl+C stops only the local wait')))
  try {
    const pending = await fetchQueue(host, target)
    if ((pending.items ?? []).length > 0) {
      print(
        yellow(msg('{count} pending', { count: pending.items.length })) +
          dim(msg(' · /pending to see, /edit <n> <text>, /drop <n>, /steer <n>')),
      )
    }
  } catch {
    // A queue read is a convenience; a failure must not block chatting.
  }

  rl.on('SIGINT', () => {
    if (multiline !== null) {
      multiline = null
      process.stdout.write(`\n${dim(msg('multiline cancelled'))}\n`)
      return
    }
    if (active !== null) {
      active.abort()
      return
    }
    rl.close()
  })

  try {
    for (;;) {
      let line
      try {
        line = await rl.question(multiline !== null ? dim('… ') : cyan('❯ '))
      } catch {
        break
      }
      if (line === undefined) break

      if (multiline !== null) {
        if (line.trim() === '/end') {
          const text = multiline.join('\n').trim()
          multiline = null
          if (text !== '' || attachments.pending.length > 0) await sendTurn(text)
          else print(dim(msg('multiline was empty: nothing sent')))
        } else {
          multiline.push(line)
        }
        continue
      }

      const text = line.trim()
      if (text === '') continue
      if (text === '/exit' || text === 'exit' || text === '/quit') break

      if (text.startsWith('/') !== true) {
        await sendTurn(text)
        continue
      }

      const command = text.split(/\s+/)[0]
      const argument = text.slice(command.length).trim()
      switch (command) {
        case '/id':
          print(target)
          continue
        case '/help':
          print(renderConnectHelp())
          continue
        case '/status':
          await showStatus()
          continue
        case '/history':
          await showHistory(host, target, tail, options)
          continue
        case '/pending':
        case '/queue':
          print(renderQueue(await fetchQueue(host, target)))
          continue
        case '/attach':
          if (argument === '') print(msg('usage: /attach <path> [path ...]'))
          else await addPaths(argument)
          continue
        case '/paste':
          await addClipboard()
          continue
        case '/attachments':
          print(renderAttachments(attachments))
          continue
        case '/detach':
          detach(argument)
          continue
        case '/preview':
          previewAttached(argument)
          continue
        case '/send':
          await sendTurn('', { onlyAttachments: true })
          continue
        case '/multiline':
          multiline = []
          print(dim(msg('multiline: compose one prompt, finish with a line that is exactly /end · Ctrl+C cancels')))
          continue
        case '/clear':
          // Screen only: the Session and its history are untouched.
          if (process.stdout.isTTY === true) process.stdout.write('\x1b[2J\x1b[H')
          else print(dim(msg('clear needs a TTY; nothing was deleted')))
          continue
        case '/end':
          print(dim(msg('/end is only meaningful inside /multiline')))
          continue
        default:
          break
      }

      const pendingCommand = text.match(/^\/(edit|drop|steer)\s+(\d+)\s*([\s\S]*)$/)
      if (pendingCommand !== null) {
        const [, verb, rawIndex, remainder] = pendingCommand
        const listing = await fetchQueue(host, target)
        const item = (listing.items ?? []).find((entry) => entry.index === Number(rawIndex))
        if (item === undefined) {
          process.stderr.write(`${msg('no pending item {index}', { index: rawIndex })}\n`)
          continue
        }
        const action = verb === 'drop' ? 'remove' : verb === 'steer' ? 'steer' : 'edit'
        const replacement = remainder.trim()
        if (action === 'edit' && replacement === '') {
          process.stderr.write(`${msg('usage: /edit <n> <new text>')}\n`)
          continue
        }
        const updated = await mutateQueue(host, target, item.id, action, action === 'edit' ? replacement : undefined)
        process.stdout.write(`${renderQueue(updated)}\n`)
        continue
      }

      print(dim(msg('unknown command {command} · /help for the command list', { command })))
    }
  } finally {
    rl.close()
  }
  return 0
}


async function fetchQueue(host, reference) {
  const payload = await callJson(
    `${host.base}/local-cli/queue?session=${encodeURIComponent(reference)}`,
    { headers: authHeaders(host) },
    'queue',
  )
  if (payload.ok !== true) throw new Error(payload.error ?? failedMessage('queue'))
  return payload
}

async function mutateQueue(host, reference, itemId, action, text) {
  const body = { session: reference, itemId, action }
  if (text !== undefined) body.text = text
  const payload = await callJson(
    `${host.base}/local-cli/queue`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(host) }, body: JSON.stringify(body) },
    'queue',
  )
  if (payload.ok !== true) throw new Error(payload.error ?? failedMessage('queue update'))
  return payload
}

function renderQueue(payload) {
  const lines = []
  const items = payload.items ?? []
  const state = payload.running === true ? msg('running') : msg('idle')
  lines.push(dim(`${shortId(payload.sessionId)} · ${state} · ${items.length} ${msg('pending')}`))
  if (items.length === 0) {
    lines.push(dim(`  ${msg('(nothing queued)')}`))
    return lines.join('\n')
  }
  for (const item of items) {
    const tag =
      item.placement === 'steering'
        ? yellow(msg('steering'))
        : item.placement === 'context'
          ? dim(msg('context'))
          : cyan(msg('queued'))
    lines.push(`  ${String(item.index).padStart(2)}) ${tag.padEnd(10)} ${firstLine(item.text, 90)}`)
    lines.push(dim(`      id ${item.id}`))
  }
  return lines.join('\n')
}

async function runQueue(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)
  // First bare word is the Session; the rest is the replacement text for --edit.
  let target = options.sessionId ?? words[0]
  const editText = words.slice(1).join(' ').trim()
  if (target === undefined) {
    if (process.stdin.isTTY !== true) throw new Error(msg('no Session given and stdin is not a terminal'))
    const picked = await pickSession(host)
    if (picked === undefined) {
      process.stdout.write(`${msg('nothing picked')}\n`)
      return 0
    }
    target = picked.sessionId
  }

  if (options.queueAction === undefined) {
    const payload = await fetchQueue(host, target)
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${renderQueue(payload)}\n`)
    return 0
  }

  const text = options.queueAction === 'edit' ? editText : undefined
  if (options.queueAction === 'edit' && (text === undefined || text === '')) {
    process.stderr.write(`dsh-ask: ${msg('--edit needs the replacement text')}\n`)
    return 2
  }
  // Accept the list index as well as the item id.
  let itemId = options.itemId
  if (/^\d+$/.test(itemId)) {
    const listing = await fetchQueue(host, target)
    const item = (listing.items ?? []).find((entry) => entry.index === Number(itemId))
    if (item === undefined) {
      process.stderr.write(`dsh-ask: ${msg('no pending item {index}', { index: itemId })}\n`)
      return 1
    }
    itemId = item.id
  }
  const payload = await mutateQueue(host, target, itemId, options.queueAction, text)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${renderQueue(payload)}\n`)
  return 0
}

/** What a status line shows for a value the Host does not report. */
const STATUS_UNKNOWN = '—'

/** One Host-supplied label: control characters stripped, spaces collapsed, capped. */
function statusClean(value, max = 64) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, max)
}

const statusNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Desktop `formatTokens`: raw below 1k, K/M with the same rounding rule. */
function compactTokens(value) {
  const count = statusNumber(value)
  if (count === null) return null
  const scaled = (candidate) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${scaled(count / 1_000)}K`
  return `${scaled(count / 1_000_000)}M`
}

/** Desktop `formatTokensPerSecond`: whole numbers at 10+, one decimal below. */
function compactSpeed(value) {
  const tps = statusNumber(value)
  if (tps === null) return null
  return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)
}

const statusMs = (value) => (statusNumber(value) === null ? null : formatDuration(statusNumber(value)))

/** Render the whitelisted status payload for humans; unknown stays "—". */
function renderStatus(payload) {
  const status = payload?.status ?? {}
  const text = (value, max) => statusClean(value, max) ?? STATUS_UNKNOWN
  const model = status.model
  const context = status.context
  const usage = status.usage
  const stats = status.stats
  const lines = []

  lines.push(`${labelCell('session')}${text(payload?.sessionId)}`)
  if (model === null || model === undefined) {
    lines.push(`${labelCell('model')}${STATUS_UNKNOWN}`)
  } else {
    const effort = statusClean(model.effort)
    lines.push(
      `${labelCell('model')}${text(model.provider)} / ${text(model.model)}${effort === null ? '' : ` · ${msg('effort')} ${effort}`}`,
    )
  }
  if (context === null || context === undefined) {
    lines.push(`${labelCell('context')}${STATUS_UNKNOWN}`)
  } else {
    const percent = statusNumber(context.percent) === null ? STATUS_UNKNOWN : `${context.percent}%`
    const used = compactTokens(context.usedTokens) ?? STATUS_UNKNOWN
    const limit = compactTokens(context.contextWindow) ?? STATUS_UNKNOWN
    const source =
      statusNumber(context.projectedTokens) !== null
        ? 'projected'
        : statusNumber(context.pressureTokens) !== null
          ? 'pressure'
          : null
    lines.push(
      `${labelCell('context')}${percent} · ${used} / ${limit} ${msg('tokens')}${source === null ? '' : ` (${msg(source)})`}`,
    )
  }
  if (usage === null || usage === undefined) {
    lines.push(`${labelCell('tokens')}${STATUS_UNKNOWN}`)
  } else {
    const hit = statusNumber(usage.cacheHitPercent)
    lines.push(
      `${labelCell('tokens')}${msg('in')} ${usage.uncachedInputTokens} · ${msg('out')} ${usage.outputTokens} · ${msg('cache read')} ${usage.cacheReadTokens} · ${msg('cache write')} ${usage.cacheWriteTokens} · ${msg('total')} ${usage.totalTokens}${hit === null ? '' : ` · ${msg('cache hit')} ${hit}%`}`,
    )
  }
  if (stats === null || stats === undefined) {
    lines.push(`${labelCell('stats')}${STATUS_UNKNOWN}`)
  } else {
    const ttftSteps = statusNumber(stats.ttftSteps)
    const ttft = statusNumber(stats.ttftMs)
    const ttftAvg = ttftSteps === null || ttftSteps === 0 || ttft === null ? null : ttft / ttftSteps
    const speed = compactSpeed(stats.tokensPerSecond)
    const parts = [
      msg('{turns} turns · {steps} steps', { turns: stats.turns, steps: stats.steps }),
      msg('cumulative llm {value}', { value: statusMs(stats.llmMs) ?? STATUS_UNKNOWN }),
      msg('tool {value}', { value: statusMs(stats.toolMs) ?? STATUS_UNKNOWN }),
      ttftAvg === null ? null : msg('ttft avg {value}', { value: statusMs(ttftAvg) }),
      statusMs(stats.decodeMs) === null ? null : msg('decode {value}', { value: statusMs(stats.decodeMs) }),
      speed === null ? null : msg('{speed} tok/s', { speed }),
    ].filter((part) => part !== null)
    lines.push(`${labelCell('stats')}${parts.join(' · ')}`)
  }
  lines.push(`${labelCell('permission')}${text(status.permission, 32)}`)
  const pending = Array.isArray(status.pendingInput) && status.pendingInput.length > 0
    ? status.pendingInput.map((kind) => statusClean(kind, 16)).filter(Boolean).join(',')
    : msg('none')
  lines.push(
    `${labelCell('state')}${status.running === true ? msg('running') : msg('idle')} · ${msg('queue')} ${statusNumber(status.queue) ?? 0} · ${msg('pending')} ${pending}`,
  )
  return lines.join('\n')
}

// ------------------------------------------------ permissions and pending answers

/** Presets whose desktop switch is confirmed; the CLI requires --yes as well. */
const HIGH_IMPACT_PRESETS = new Set(['danger-full-access', 'auto'])

/** A Session named on the command line, or the interactive picker on a TTY. */
async function resolveTargetSession(host, reference) {
  if (reference !== undefined) return reference
  if (process.stdin.isTTY !== true) throw new Error(msg('no Session given and stdin is not a terminal'))
  const picked = await pickSession(host)
  return picked === undefined ? undefined : picked.sessionId
}

function renderPermissions(payload) {
  const permission = payload.permission ?? {}
  const value = statusClean(permission.currentValue, 64)
  const label = statusClean(permission.label, 64)
  const lines = [`${labelCell('session')}${payload.sessionId}`]
  const current = value === null ? STATUS_UNKNOWN : label !== null && label !== value ? `${value} (${label})` : value
  lines.push(`${labelCell('current')}${current}`)
  const presets = (Array.isArray(permission.options) ? permission.options : [])
    .map((option) => statusClean(option?.value, 64))
    .filter(Boolean)
  lines.push(`${labelCell('presets')}${presets.length === 0 ? STATUS_UNKNOWN : presets.join(', ')}`)
  lines.push(`${labelCell('default')}${statusClean(permission.defaultPreset, 64) ?? STATUS_UNKNOWN}   ${msg('(new Sessions)')}`)
  lines.push(`${labelCell('set')}${payload.canSet === true ? msg('available') : msg('unavailable (this Host offers no /permission command)')}`)
  return lines.join('\n')
}

async function runPermissions(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)

  if (words[0] === 'set') {
    const preset = words[1]
    if (preset === undefined || preset === '') throw new UsageError(msg('permissions set needs a preset name'))
    if (HIGH_IMPACT_PRESETS.has(preset) && options.yes !== true) {
      throw new UsageError(
        msg('preset {preset} {effect}; pass --yes after deciding explicitly', {
          preset,
          effect: msg(
            preset === 'auto' ? 'adds an automatic reviewer and widens access' : 'removes approval prompts',
          ),
        }),
      )
    }
    const target = await resolveTargetSession(host, options.sessionId ?? words[2])
    if (target === undefined) {
      process.stdout.write(`${msg('nothing picked')}\n`)
      return 0
    }
    const payload = await submitPermission(host, { sessionId: target, preset, confirmed: options.yes === true })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${msg('preset {preset} on {sessionId}', { preset: statusClean(payload.preset, 64) ?? preset, sessionId: payload.sessionId })}\n`)
    const hostText = statusClean(payload.text, 120)
    if (hostText !== null) process.stdout.write(`${dim(hostText)}\n`)
    return 0
  }

  const target = await resolveTargetSession(host, options.sessionId ?? words[0])
  if (target === undefined) {
    process.stdout.write(`${msg('nothing picked')}\n`)
    return 0
  }
  const payload = await fetchPermissions(host, target)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${renderPermissions(payload)}\n`)
  return 0
}

function renderAwaiting(payload) {
  const lines = [`${labelCell('session')}${payload.sessionId}`]
  const kinds = Array.isArray(payload.pendingInput)
    ? payload.pendingInput.filter((kind) => typeof kind === 'string')
    : []
  lines.push(`${labelCell('state')}${payload.running === true ? msg('running') : msg('idle')} · ${msg('pending')} ${kinds.length === 0 ? msg('none') : kinds.join(',')}`)
  const active = Array.isArray(payload.questions?.active) ? payload.questions.active : []
  if (active.length === 0) {
    lines.push(`${labelCell('questions')}${msg('none')}`)
  } else {
    lines.push(labelCell('questions').trimEnd())
    for (const item of active) {
      const callId = statusClean(item.callId, 64) ?? '?'
      const state = statusClean(item.state, 16) ?? '?'
      const channel = state === 'continued' ? msg('answer from here') : msg('answer in the desktop app')
      lines.push(`  ${callId}  ${state}  (${channel})`)
      for (const question of Array.isArray(item.questions) ? item.questions : []) {
        const text = statusClean(question.question, 300) ?? '?'
        lines.push(`    ${text}${question.multiSelect === true ? `  ${msg('[multi-select]')}` : ''}`)
        const options = (Array.isArray(question.options) ? question.options : [])
          .map((option) => statusClean(option?.label, 128))
          .filter(Boolean)
        if (options.length > 0) {
          lines.push(`      ${msg('options: {options}', { options: options.join(' | ') })}`)
        }
      }
    }
  }
  const approval = payload.approvals
  if (approval?.present === true || kinds.includes('approval')) {
    lines.push(`${labelCell('approval')}${msg('present')} · ${statusClean(approval?.reason, 200) ?? msg('confirm in the desktop app')}`)
  } else {
    lines.push(`${labelCell('approval')}${msg('none')}`)
  }
  return lines.join('\n')
}

async function runAwaiting(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)
  const target = await resolveTargetSession(host, options.sessionId ?? words[0])
  if (target === undefined) {
    process.stdout.write(`${msg('nothing picked')}\n`)
    return 0
  }
  const payload = await fetchAwaiting(host, target)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${renderAwaiting(payload)}\n`)
  return 0
}

function splitAssignment(raw, flag) {
  const index = raw.indexOf('=')
  if (index <= 0) throw new UsageError(msg('{flag} needs <questionId>=<value>', { flag }))
  return [raw.slice(0, index).trim(), raw.slice(index + 1)]
}

/**
 * Build the answer batch from the user's explicit flags only. Nothing here
 * guesses a choice: an unmentioned question is a usage error, a label outside
 * the offered options is rejected, and `--skip` must be asked for by name.
 */
function answerBatchOf(request, options) {
  const ids = request.questions.map((question) => question.id)
  const offeredOf = (question) => (question.options ?? []).map((option) => option.label).join(' | ')

  const select = new Map()
  for (const raw of options.selections) {
    const [id, value] = splitAssignment(raw, '--select')
    if (id === '') throw new UsageError(msg('--select needs a question id before "="'))
    if (select.has(id)) {
      throw new UsageError(msg('--select for {id} was given twice', { id: JSON.stringify(id) }))
    }
    const labels = value.split(',').map((label) => label.trim()).filter((label) => label !== '')
    if (labels.length === 0) throw new UsageError(msg('--select {id}= needs at least one label', { id }))
    select.set(id, labels)
  }

  const custom = new Map()
  for (const raw of options.customs) {
    const [id, value] = splitAssignment(raw, '--custom')
    if (id === '') throw new UsageError(msg('--custom needs a question id before "="'))
    if (custom.has(id)) {
      throw new UsageError(msg('--custom for {id} was given twice', { id: JSON.stringify(id) }))
    }
    const text = value.trim()
    if (text === '') throw new UsageError(msg('--custom {id}= needs text', { id }))
    custom.set(id, text)
  }

  const skip = new Set()
  for (const raw of options.skips) {
    const id = String(raw).trim()
    if (id === '') throw new UsageError(msg('--skip needs a question id'))
    if (skip.has(id)) throw new UsageError(msg('--skip {id} was given twice', { id }))
    skip.add(id)
  }

  const unknown = [...select.keys(), ...custom.keys(), ...skip].filter((id) => !ids.includes(id))
  if (unknown.length > 0) {
    throw new UsageError(
      msg('no such question {unknown} in this request (ids: {ids})', {
        unknown: unknown.join(', '),
        ids: ids.join(', '),
      }),
    )
  }

  const answers = []
  for (const question of request.questions) {
    const id = question.id
    if (skip.has(id)) {
      if (select.has(id) || custom.has(id)) {
        throw new UsageError(msg('question {id} is both skipped and answered', { id }))
      }
      answers.push({ id, selected: [] })
      continue
    }
    const labels = select.get(id)
    const text = custom.get(id)
    if (labels !== undefined) {
      const allowed = new Set((question.options ?? []).map((option) => option.label))
      if (allowed.size > 0) {
        for (const label of labels) {
          if (!allowed.has(label)) {
            throw new UsageError(
              msg('label {label} is not offered by question {id} (offered: {offered})', {
                label: JSON.stringify(label),
                id,
                offered: offeredOf(question),
              }),
            )
          }
        }
      }
      if (question.multiSelect !== true && labels.length > 1) {
        throw new UsageError(msg('question {id} takes one label', { id }))
      }
    }
    if (labels !== undefined && text !== undefined) {
      if (question.multiSelect !== true) {
        throw new UsageError(msg('question {id} takes either --select or --custom, not both', { id }))
      }
      answers.push({ id, selected: labels, custom: text })
    } else if (labels !== undefined) {
      answers.push({ id, selected: labels })
    } else if (text !== undefined) {
      answers.push({ id, selected: [], custom: text })
    } else {
      const offered = offeredOf(question)
      throw new UsageError(
        msg('question {id} needs --select {id}=<label>, --custom {id}=<text> or --skip {id}', { id }) +
          (offered === '' ? '' : msg(' (offered: {offered})', { offered })),
      )
    }
  }
  return answers
}

async function runAnswer(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  if (options.selections.length === 0 && options.customs.length === 0 && options.skips.length === 0) {
    throw new UsageError(msg('answer needs at least one --select, --custom or --skip'))
  }
  let reference = options.sessionId
  let callId
  if (reference !== undefined) {
    if (words.length !== 1) throw new UsageError(msg('with --session give exactly one callId'))
    callId = words[0]
  } else if (words.length >= 2) {
    if (words.length > 2) throw new UsageError(msg('answer takes a Session, a callId and flags'))
    reference = words[0]
    callId = words[1]
  } else if (words.length === 1) {
    callId = words[0]
  } else {
    throw new UsageError(msg('answer needs a callId (run `dsh-ask awaiting <session>` to list them)'))
  }
  const host = await connectToHost(options)
  const target = await resolveTargetSession(host, reference)
  if (target === undefined) {
    process.stdout.write(`${msg('nothing picked')}\n`)
    return 0
  }
  const awaiting = await fetchAwaiting(host, target)
  const request = (Array.isArray(awaiting.questions?.active) ? awaiting.questions.active : []).find(
    (item) => item.callId === callId,
  )
  if (request === undefined) {
    const hint =
      awaiting.approvals?.present === true
        ? msg('; this Session has a pending approval, which can only be confirmed in the desktop app')
        : ''
    throw new CliError(
      msg('stale-request: no active question has callId {callId}{hint}', { callId: JSON.stringify(callId), hint }),
    )
  }
  if (request.state !== 'continued') {
    throw new CliError(
      msg(
        'not-answerable: this question is still blocking its tool call in the desktop Remote Event waterfall; answer it in the desktop app',
      ),
    )
  }
  const answers = answerBatchOf(request, options)
  const payload = await submitAnswer(host, { sessionId: awaiting.sessionId ?? target, callId, answers })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  const id = statusClean(payload.callId, 64) ?? callId
  process.stdout.write(
    `${msg('answered {id} ({questions})', {
      id,
      questions: msg(answers.length === 1 ? '{count} question' : '{count} questions', {
        count: answers.length,
      }),
    })}\n`,
  )
  return 0
}

// ------------------------------------------------ approval channel commands

function renderApprovalStatus(payload) {
  const claim = payload?.claim
  if (claim === null || claim === undefined) {
    return `${labelCell('claim')}${msg('none')}${
      payload?.pendingCount > 0 ? ` (${msg('pending')} ${payload.pendingCount})` : ''
    }`
  }
  const leaseMs = Number(claim.leaseMs) || 60_000
  const seconds = Math.max(1, Math.round(leaseMs / 1000))
  const expires = typeof claim.expiresAt === 'number' ? new Date(claim.expiresAt).toISOString() : STATUS_UNKNOWN
  const lines = [
    `${labelCell('claim')}${claim.claimId}`,
    `${labelCell('session')}${claim.sessionId}`,
    `${labelCell('lease')}${seconds}s (${leaseMs} ms) · ${msg('expires')} ${expires}`,
    `${labelCell('connected')}${payload.connected === true ? msg('yes') : msg('no')} · ${msg('pending')} ${payload.pendingCount ?? 0}/${payload.maxPending ?? '?'}`,
  ]
  for (const item of Array.isArray(payload.pending) ? payload.pending : []) {
    const tool = statusClean(item.toolName, 64) ?? '?'
    const callId = typeof item.callId === 'string' && item.callId !== '' ? ` (${item.callId})` : ''
    const reason = statusClean(item.reason, 160)
    lines.push(`  ${item.requestId}  ${tool}${callId}${reason === null ? '' : `  ${reason}`}`)
  }
  return lines.join('\n')
}

function renderApprovalClaim(payload) {
  const leaseMs = Number(payload.leaseMs) || 60_000
  const seconds = Math.max(1, Math.round(leaseMs / 1000))
  const expires = typeof payload.expiresAt === 'number' ? new Date(payload.expiresAt).toISOString() : STATUS_UNKNOWN
  return [
    `${labelCell('claim')}${payload.claimId}`,
    `${labelCell('session')}${payload.sessionId}`,
    `${labelCell('lease')}${seconds}s (${leaseMs} ms) · ${msg('expires')} ${expires}`,
    `${labelCell('note')}${msg('local claim only; the desktop UI may answer the same request first')}`,
  ].join('\n')
}

async function runApproval(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const action = words[0]
  if (action === undefined) {
    throw new UsageError(msg('approval needs an action: status, claim, release or answer'))
  }

  // Validate the whole command before touching the Host: an approval decision
  // must be explicit and confirmed, and a usage error must never reach the bridge.
  if (action === 'status') {
    if (words.length > 2) throw new UsageError(msg('approval status takes at most one claimId'))
  } else if (action === 'claim') {
    if (words.length !== 2) throw new UsageError(msg('approval claim needs exactly one Session'))
  } else if (action === 'release') {
    if (words.length !== 2) throw new UsageError(msg('approval release needs exactly one claimId'))
  } else if (action === 'answer') {
    if (words.length !== 3) throw new UsageError(msg('approval answer needs a claimId and a requestId'))
    if (options.allowOnce === options.reject) {
      throw new UsageError(msg('approval answer needs exactly one of --allow-once or --reject'))
    }
    if (options.confirm !== true) {
      throw new UsageError(
        msg('approval answer needs --confirm: the user must decide explicitly, and nothing was sent'),
      )
    }
  } else {
    throw new UsageError(
      msg('unknown approval action {action} (use status, claim, release or answer)', {
        action: JSON.stringify(action),
      }),
    )
  }

  const host = await connectToHost(options)

  if (action === 'status') {
    const payload = await fetchApprovalChannel(host, words[1])
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${renderApprovalStatus(payload)}\n`)
    return 0
  }

  if (action === 'claim') {
    const leaseMs = options.leaseMs ?? 60_000
    const payload = await claimApprovalChannel(host, { sessionId: words[1], leaseMs })
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${renderApprovalClaim(payload)}\n`)
    return 0
  }

  if (action === 'release') {
    const payload = await releaseApprovalChannel(host, { claimId: words[1], reason: 'user' })
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(
      `${msg('released {claimId}; delegated {count} pending request(s)', {
        claimId: words[1],
        count: payload.delegated ?? 0,
      })}\n`,
    )
    return 0
  }

  const outcome = options.allowOnce === true ? 'allowed-once' : 'rejected'
  const payload = await submitApprovalDecision(host, { claimId: words[1], requestId: words[2], outcome })
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  process.stdout.write(
    `${msg('submitted {outcome} for request {requestId} on claim {claimId}', {
      outcome: payload.outcome,
      requestId: payload.requestId,
      claimId: payload.claimId,
    })}\n` + `${dim(msg('waiting for the Host to confirm; not confirmed here'))}\n`,
  )
  return 0
}

async function runStatus(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)
  let target = options.sessionId ?? words[0]
  if (target === undefined) {
    if (process.stdin.isTTY !== true) throw new Error(msg('no Session given and stdin is not a terminal'))
    const picked = await pickSession(host)
    if (picked === undefined) {
      process.stdout.write(`${msg('nothing picked')}\n`)
      return 0
    }
    target = picked.sessionId
  }
  const payload = await fetchStatus(host, target)
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, sessionId: payload.sessionId, status: payload.status }, null, 2)}\n`,
    )
    return 0
  }
  process.stdout.write(`${renderStatus(payload)}\n`)
  return 0
}

async function runCreate(argv) {
  const { options } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)
  try {
    const payload = await createSession(host, options)
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${payload.sessionId}\n`)
    if (payload.workspace !== undefined) {
      process.stdout.write(
        `${workspaceView(payload.workspace)}${
          payload.created === true ? dim(` ${msg('(workspace created)')}`) : ''
        }\n`,
      )
    }
    return 0
  } catch (error) {
    if (error.payload !== undefined) {
      printFailure(error.payload)
      return 1
    }
    throw error
  }
}

async function runWorkspaces(argv) {
  const { options } = parseCli(argv)
  applyColor(options)
  const host = await connectToHost(options)
  const rows = await fetchWorkspaces(host)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, workspaces: rows }, null, 2)}\n`)
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write(`${msg('no workspaces yet')}\n`)
    return 0
  }
  for (const row of rows) {
    process.stdout.write(
      `${shortId(row.id).padEnd(18)} ${String(row.sessions ?? 0).padStart(3)}  ${String(row.title ?? '').padEnd(24)} ${dim(row.path ?? '')}\n`,
    )
  }
  return 0
}

async function runHistory(argv) {
  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }
  const host = await connectToHost(options)
  const tail = Math.min(Math.max(options.tail ?? 60, 1), 300)
  let target = options.sessionId ?? (words.length > 0 ? words.join(' ') : undefined)
  if (target === undefined) {
    if (process.stdin.isTTY !== true) throw new Error(msg('no Session given and stdin is not a terminal'))
    const picked = await pickSession(host)
    if (picked === undefined) {
      process.stdout.write(`${msg('nothing picked')}\n`)
      return 0
    }
    target = picked.sessionId
  }
  await showHistory(host, target, tail, options)
  return 0
}

/** Subcommands that own the whole command line, independent of flag order. */
const SUBCOMMANDS = new Set([
  'connect',
  'resume',
  'history',
  'create',
  'new',
  'workspaces',
  'queue',
  'pending',
  'status',
  'permissions',
  'permission',
  'awaiting',
  'answer',
  'approval',
  'list',
])

/** Global flags that consume one value, so the scanner never reads a value as a subcommand. */
const FLAG_VALUES = new Set([
  '-s',
  '--session',
  '-c',
  '--cwd',
  '-w',
  '--workspace',
  '-n',
  '--tail',
  '-t',
  '--timeout',
  '-u',
  '--url',
  '--color',
  '--lang',
  '--start-timeout',
  '--app',
  '--image',
  '--preview',
  '--remove',
  '--steer',
  '--select',
  '--custom',
  '--skip',
  '--lease',
])

/**
 * Locate the subcommand while allowing global flags before it, so
 * `dsh-ask -u URL status` runs `status` instead of prompting the words.
 *
 * Returns the name and its argv index, or undefined when the first positional
 * is prompt text. `--` forces everything after it to be prompt text, which is
 * how a caller asks literally for a word that is also a subcommand name.
 */
function findSubcommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--') return undefined
    if (arg === '--edit') {
      index += 2
      continue
    }
    if (FLAG_VALUES.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-') && arg !== '-') continue
    return SUBCOMMANDS.has(arg) ? { name: arg, index } : undefined
  }
  return undefined
}

async function main(argv = process.argv.slice(2)) {
  const invoked = basename(process.argv[1] ?? '')
  const found = findSubcommand(argv)
  const sub = found === undefined ? undefined : found.name
  // The subcommand may follow global flags; the handlers still receive every
  // flag, minus the subcommand token itself.
  const rest = found === undefined ? argv : argv.slice(0, found.index).concat(argv.slice(found.index + 1))
  if (invoked === 'dsh-connect' || sub === 'connect' || sub === 'resume') {
    // Codex habits: bare entry starts a new conversation in the cwd, while
    // `dsh-ask resume` opens the session list first.
    return runConnect(sub === 'connect' || sub === 'resume' ? rest : argv, {
      initialPicker: sub === 'resume' || invoked === 'dsh-resume',
    })
  }
  if (invoked === 'dsh-history' || sub === 'history') {
    return runHistory(sub === 'history' ? rest : argv)
  }
  if (invoked === 'dsh-new' || sub === 'create' || sub === 'new') {
    return runCreate(sub === 'create' || sub === 'new' ? rest : argv)
  }
  if (sub === 'workspaces') return runWorkspaces(rest)
  if (sub === 'queue' || sub === 'pending') return runQueue(rest)
  if (sub === 'status') return runStatus(rest)
  if (sub === 'permissions' || sub === 'permission') return runPermissions(rest)
  if (sub === 'awaiting') return runAwaiting(rest)
  if (sub === 'answer') return runAnswer(rest)
  if (sub === 'approval') return runApproval(rest)
  if (sub === 'list') return main(['-l', ...rest])

  const { options, words } = parseCli(argv)
  applyColor(options)
  if (options.help) {
    process.stdout.write(`${usageText()}\n`)
    return 0
  }

  const wantsList = options.workspaces === true || options.list === true
  const wantsAttachments = wantsList !== true && (options.images.length > 0 || options.paste === true)
  // Files are read before the Host probe: a bad --image is a usage error, must
  // never become prompt text, and must not launch the app or hit the bridge.
  const loadedImages = wantsAttachments === true ? await loadCliImages(options) : []

  const host = await connectToHost(options)

  if (options.workspaces === true) {
    const rows = await fetchWorkspaces(host)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, workspaces: rows }, null, 2)}\n`)
      return 0
    }
    for (const row of rows) {
      process.stdout.write(
        `${shortId(row.id).padEnd(18)} ${String(row.sessions ?? 0).padStart(3)}  ${String(row.title ?? '').padEnd(24)} ${dim(row.path ?? '')}\n`,
      )
    }
    return 0
  }

  if (options.list === true) {
    const limit = Math.min(Math.max(options.listCount ?? 15, 1), 50)
    const rows = await fetchSessions(host, limit)
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, sessions: rows }, null, 2)}\n`)
      return 0
    }
    if (rows.length === 0) {
      process.stdout.write(`${msg('no Sessions yet')}\n`)
      return 0
    }
    for (const row of rows) process.stdout.write(`${describe(row)}\n`)
    return 0
  }

  // Bare interactive entry keeps the original command line: options such as
  // -s, --no-history, -t or --preview must not be dropped on the way to connect.
  if (words.length === 0 && loadedImages.length === 0 && process.stdin.isTTY === true) {
    return runConnect(argv)
  }

  // Image-only prompts are legitimate: they never fall into connect and never
  // read stdin, so a terminal or an idle pipe cannot block them.
  let text = words.length > 0 ? words.join(' ') : ''
  if (words.length === 0 && loadedImages.length === 0) text = await readStdin()
  if (text === '' && loadedImages.length === 0) {
    process.stderr.write(`dsh-ask: ${msg('no text given')}\n`)
    return 2
  }

  let batch = []
  if (loadedImages.length > 0) {
    // Refuse images this Host cannot accept (old bridge, strict limits) before
    // any prompt reaches it, and say plainly that an upgrade is needed.
    batch = prepareImageBatch(loadedImages, hostImageCapabilities(host))
    showImages(loadedImages, options)
  }

  const body = { text, cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs ?? 180_000 }
  if (options.sessionId !== undefined) body.sessionId = options.sessionId
  if (options.workspace !== undefined) {
    body.workspace = options.workspace
    if (options.createWorkspace === true) body.createWorkspace = true
  }
  if (batch.length > 0) {
    body.images = batch.map(({ mediaType, data, name }) => ({ mediaType, data, name }))
  }

  const wantsStream = options.json !== true && options.stream !== false
  const payload = wantsStream ? await askStream(host, body) : await askOnce(host, body)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    // stdout stays pure JSON; the actionable hint goes to stderr.
    if (payload.ok !== true && isImageModelUnsupported(payload)) {
      process.stderr.write(`dsh-ask: ${imageModelHint()}\n`)
    }
    return payload.ok === true ? 0 : 1
  }
  if (payload.ok === true) {
    if (wantsStream === false) {
      process.stdout.write(`${renderMarkdownBlock(payload.text, '').trimStart()}\n`)
    }
    return 0
  }
  printFailure(payload)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const known = error instanceof CliError
      process.stderr.write(`dsh-ask: ${String(error?.message ?? error)}\n`)
      if (known && error.showUsage === true) process.stderr.write(`${msg('try `dsh-ask --help`')}\n`)
      process.exitCode = known ? error.exitCode : 1
    })
}

export { createTuiAdapter }
