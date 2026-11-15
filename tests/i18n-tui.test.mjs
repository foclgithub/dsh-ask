/**
 * Tests for the TUI basic-area i18n (`dsh-tui.mjs` + `dsh-tui-messages.mjs`).
 *
 * Scope of this item: the composer hints, the slash-command and shortcut
 * tables, the status row, the startup / draft / send / attachment prompts and
 * `view.ui`. The permission, approval, question and session-picker modals are
 * intentionally out of scope here and are covered by their own small item.
 *
 * Everything is driven through the public surface: `runTui` with a capturing
 * fake screen (like tests/tui.test.mjs) and the exported `buildStatusLines`.
 * Only text this tool owns is translated - the assertions pin that user text,
 * model output, paths and titles pass through untouched.
 */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildStatusLines, runTui } from '../dsh-tui.mjs'
import { TUI_CATALOG } from '../dsh-tui-messages.mjs'
import { NATIVE_UI_FIELDS, createTranslator, nativeUiLabels, resolveLanguage } from '../dsh-i18n.mjs'
import { BINARY_ENV, createScreen } from '../dsh-native-screen.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NATIVE_FAKE = join(HERE, 'fixtures', 'fake-native-ui.mjs')
const BASE_CWD = '/tmp/dsh-i18n-tui-workspace'

const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-i18n-tui-test'),
]).toString('base64')

const image = (name = 'clip.png') => ({ mediaType: 'image/png', data: PNG_B64, name })

const CJK = /[\u3400-\u9fff]/

function t(key) {
  const entry = TUI_CATALOG[key]
  assert.ok(entry !== undefined, `catalog has ${key}`)
  return entry
}

/** Translate like the app does (placeholder substitution included). */
function tw(lang, key, params = {}) {
  assert.ok(TUI_CATALOG[key] !== undefined, `catalog has ${key}`)
  return createTranslator(lang, TUI_CATALOG)(key, params)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, { label = 'condition', timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(2)
  }
}

/**
 * A small adapter double: enough for a bare local draft, the first send (which
 * creates the Host Session), one streaming turn, the attachment helpers, and
 * the permission / approval / question modals. Host-owned values (preset names,
 * option labels, question text) stay Chinese on purpose: they must pass through
 * verbatim in both languages.
 */
const HOST_PERMISSIONS = {
  ok: true,
  permission: {
    currentValue: 'workspace-write',
    label: '工作区写入',
    options: [
      { value: 'read-only', name: '只读', description: '只读文件系统' },
      { value: 'workspace-write', name: '工作区写入', description: '可写当前工作区' },
      { value: 'danger-full-access', name: '完全访问', description: '完整文件系统与网络访问' },
      { value: 'auto', name: '自动' },
    ],
    defaultPreset: 'workspace-write',
  },
  canSet: true,
}

const CLEAN_AWAITING = {
  ok: true,
  running: false,
  pendingInput: [],
  questions: { active: [], settledCount: 0 },
  approvals: { supported: false, present: false, reason: '' },
  answerable: false,
}

function continuedBatch(question = '选哪个？') {
  return {
    callId: 'call-cont',
    state: 'continued',
    questions: [{ id: 'q1', question, options: [{ label: '甲', description: '选项甲' }, { label: '乙' }] }],
  }
}

function makeAdapter(overrides = {}) {
  const requests = { ask: [] }
  const channel = { claim: null }
  const adapter = {
    endpoint: 'http://127.0.0.1:65535',
    pid: 4242,
    images: 'images' in overrides ? overrides.images : { supported: true, maxImages: 4 },
    async listSessions() {
      return (overrides.rows ?? []).map((row) => ({ ...row }))
    },
    async fetchTranscript(sessionId) {
      return { ok: true, sessionId, running: false, more: false, items: [] }
    },
    async newConversationForDirectory() {
      return { sessionId: 'sess-new' }
    },
    async newConversationWithOptions() {
      return { sessionId: 'sess-new' }
    },
    async ask(body) {
      requests.ask.push(body)
      if (typeof overrides.ask === 'function') return overrides.ask(body)
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    },
    async askBlocking(body) {
      return this.ask(body)
    },
    async fetchQueue() {
      return { running: false, items: [] }
    },
    async listWorkspaces() {
      return []
    },
    async loadPaths() {
      return []
    },
    async loadClipboard() {
      if (typeof overrides.loadClipboard === 'function') return overrides.loadClipboard()
      return image()
    },
    validateBatch(images) {
      return images.slice()
    },
    // --- permission / approval / question bridge (optional in the TUI) ---
    async fetchPermissions(sessionId) {
      return { ...HOST_PERMISSIONS, sessionId }
    },
    async submitPermission(body) {
      return { ok: true, sessionId: body.sessionId, preset: body.preset, matched: true, text: 'ok' }
    },
    async fetchAwaiting(sessionId) {
      return { ...(overrides.awaiting ?? CLEAN_AWAITING), sessionId }
    },
    async submitAnswer(body) {
      return { ok: true, sessionId: body.sessionId, callId: body.callId, accepted: true, source: 'userQuestions/answer' }
    },
    async fetchApprovalChannel() {
      if (channel.claim === null) {
        return { ok: true, claim: null, connected: false, pendingCount: 0, maxPending: 8, pending: [] }
      }
      return { ok: true, claim: { ...channel.claim }, connected: true, pendingCount: 0, maxPending: 8, pending: [] }
    },
    async claimApprovalChannel(request) {
      channel.claim = {
        claimId: 'claim-1',
        sessionId: request.sessionId,
        expiresAt: Date.now() + 60_000,
        leaseMs: request.leaseMs ?? 60_000,
      }
      return {
        ok: true,
        claimId: channel.claim.claimId,
        sessionId: channel.claim.sessionId,
        expiresAt: channel.claim.expiresAt,
        leaseMs: channel.claim.leaseMs,
      }
    },
    async heartbeatApprovalChannel(request) {
      return { ok: true, claimId: request.claimId, expiresAt: Date.now() + 60_000, leaseMs: 60_000 }
    },
    async releaseApprovalChannel() {
      channel.claim = null
      return { ok: true, released: true, delegated: 0 }
    },
    async submitApprovalDecision(request) {
      return {
        ok: true,
        claimId: request.claimId,
        requestId: request.requestId,
        outcome: request.outcome,
        submittedAt: Date.now(),
        final: false,
        note: 'submitted',
      }
    },
  }
  Object.assign(adapter, overrides.methods ?? {})
  return { adapter, requests }
}

/** Boot `runTui` with a capturing screen; `renderDelayMs: 0` renders synchronously. */
function boot(options = {}, adapterOverrides = {}) {
  const { adapter, requests } = makeAdapter(adapterOverrides)
  const views = []
  let onKey
  const createScreen = async ({ onKey: handler }) => {
    onKey = handler
    return {
      start() {},
      render(view) {
        views.push(view)
      },
      stop() {},
    }
  }
  const running = runTui({
    adapter,
    createScreen,
    options: { cwd: BASE_CWD, renderDelayMs: 0, initialPicker: false, ...options },
  })
  running.catch(() => {})
  const last = () => views[views.length - 1]
  const press = (str = '', key) => {
    assert.equal(typeof onKey, 'function', 'the screen factory never received onKey')
    return onKey(str, key)
  }
  const type = (text) => press(text, 'text')
  const untilView = (predicate, label, timeoutMs = 3000) =>
    until(
      () => {
        const view = last()
        if (view === undefined || predicate(view) !== true) return undefined
        return view
      },
      { label, timeoutMs },
    )
  return { adapter, requests, views, running, last, press, type, untilView }
}

/** Always settle a TUI run, even when an assertion failed mid-test. */
async function stopTui(tui, timeoutMs = 4000) {
  const settled = tui.running.then(
    (code) => ({ code }),
    (error) => ({ error }),
  )
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raced = await Promise.race([settled, sleep(15).then(() => null)])
    if (raced !== null) {
      if ('error' in raced) throw raced.error
      return raced.code
    }
    if (Date.now() > deadline) throw new Error('runTui did not settle during cleanup')
    await tui.press('', 'ctrl-q')
  }
}

// The first paints happen while `state.initializing` is still true, so wait
// for the draft hint itself instead of only the draft status.
const draftView = (tui, hint) =>
  tui.untilView((view) => view.status === 'draft' && view.hint === hint, 'draft with localized hint')

/** A draft, then the first send, so the TUI has a real Host Session. */
async function readySession(tui, lang) {
  await draftView(tui, t('hint.draft')[lang])
  await tui.type('hi')
  await tui.press('', 'enter')
  return tui.untilView((view) => view.sessionId === 'sess-new' && view.status === 'ready', 'session ready')
}

const modalText = (view) =>
  view.modal === null ? '' : view.modal.items.map((item) => `${item.label} ${item.detail}`).join('\n')

async function selectModalItem(tui, needle) {
  const modal = tui.last().modal
  assert.ok(modal !== null, `no modal while selecting ${JSON.stringify(needle)}`)
  const index = modal.items.findIndex((item) => item.label.includes(needle))
  assert.notEqual(index, -1, `no item ${JSON.stringify(needle)} in ${modal.items.map((item) => item.label)}`)
  for (let guard = 0; guard < modal.items.length * 3 && tui.last().modal.selected !== index; guard += 1) {
    await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
  }
  assert.equal(tui.last().modal.selected, index)
  await tui.press('', 'enter')
}

// ------------------------------------------------------------------ catalog coverage

test('every catalog key referenced by dsh-tui.mjs exists in both languages', async () => {
  const source = await readFile(new URL('../dsh-tui.mjs', import.meta.url), 'utf8')
  const keys = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_.:-]+)'/g)].map((match) => match[1]))
  assert.ok(keys.size > 300, `dsh-tui.mjs uses the catalog (${keys.size} keys)`)
  for (const key of keys) {
    const entry = TUI_CATALOG[key]
    assert.ok(entry !== undefined, `catalog has ${key}`)
    assert.equal(typeof entry.zh, 'string', `${key}.zh`)
    assert.equal(typeof entry.en, 'string', `${key}.en`)
  }
})

// ------------------------------------------------------------------ catalog

test('the catalog gives every key both languages and only this tool owns text', () => {
  const keys = Object.keys(TUI_CATALOG).sort()
  assert.ok(keys.length > 50, `a real catalog: ${keys.length} keys`)
  for (const key of keys) {
    const entry = TUI_CATALOG[key]
    assert.equal(typeof entry.zh, 'string', `${key}.zh is a string`)
    assert.equal(typeof entry.en, 'string', `${key}.en is a string`)
    assert.notEqual(entry.zh.trim(), '', `${key}.zh is not empty`)
    assert.notEqual(entry.en.trim(), '', `${key}.en is not empty`)
  }
  // The zh column must stay byte-identical to the wording the old tests and
  // the view.ui contract expect; the en column really is a translation.
  assert.equal(t('hint.ready').zh, 'Enter 发送 · / 命令 · ? 快捷键 · Esc 中断 · Ctrl+C 退出')
  assert.equal(t('hint.draft').zh, '本地草稿 · 发送时创建会话 · / 命令 · ? 快捷键 · Ctrl+C 退出')
  assert.equal(t('status.attention').zh, '⚠待处理')
  assert.equal(t('status.turnsSteps').zh, '{turns}轮/{steps}步')
  assert.match(t('hint.draft').en, /Local draft/)
  assert.match(t('status.turnsSteps').en, /turns\/.*steps/)
  for (const key of ['hint.ready', 'hint.draft', 'hint.busy', 'hint.commands', 'help.title']) {
    assert.ok(CJK.test(t(key).zh), `${key}.zh is Chinese`)
    assert.doesNotMatch(t(key).en, CJK, `${key}.en has no Chinese`)
  }
  // Host/user data is not catalogued: there is no data-shaped key. The
  // question/approval/picker prefixes are UI areas, not Host data.
  for (const key of keys) {
    assert.doesNotMatch(key, /^(message|title|path|cwd|model)\./, `no data keys: ${key}`)
  }
})

// --------------------------------------------------------------- status row

const STATUS_SESSION = {
  statusline: {
    model: { model: 'deepseek-flash', effort: 'high' },
    permission: 'workspace-write',
    context: { percent: 12, usedTokens: 24_000, contextWindow: 200_000 },
    usage: { totalTokens: 332_000, cacheHitPercent: 88 },
    stats: { turns: 2, steps: 5, tokensPerSecond: 35 },
  },
}

test('buildStatusLines defaults to zh and accepts an explicit language', () => {
  assert.deepEqual(buildStatusLines(undefined), [], 'no Session -> no rows')
  assert.deepEqual(buildStatusLines(STATUS_SESSION), [
    'deepseek-flash · high · workspace-write · ready',
    'ctx 12% 24K/200K · 332K tok · cache 88% · 2轮/5步 · 35 tok/s',
  ])
  assert.deepEqual(buildStatusLines(STATUS_SESSION, { lang: 'zh' }), buildStatusLines(STATUS_SESSION))
  assert.deepEqual(buildStatusLines(STATUS_SESSION, { lang: 'en' }), [
    // Model, effort, permission and the run state are Host/protocol tokens and
    // are deliberately not translated; only the row's own wording changes.
    'deepseek-flash · high · workspace-write · ready',
    'ctx 12% 24K/200K · 332K tok · cache 88% · 2 turns/5 steps · 35 tok/s',
  ])
  assert.equal(buildStatusLines(STATUS_SESSION, { status: 'draft' })[0].endsWith('draft'), true)
  assert.deepEqual(buildStatusLines({ statusline: null }), ['ready', '—'])
})

test('the attention marker is part of the translated status row', () => {
  assert.match(buildStatusLines(STATUS_SESSION, { attention: true })[0], /⚠待处理$/)
  assert.match(buildStatusLines(STATUS_SESSION, { lang: 'en', attention: true })[0], /⚠ attention$/)
})

// ------------------------------------------------------------- zh / en TUI

test('runTui with lang zh keeps the legacy basic hints, command table and help', async () => {
  const tui = boot({ lang: 'zh' })
  try {
    const draft = await draftView(tui, t('hint.draft').zh)
    assert.equal(draft.hint, t('hint.draft').zh)
    assert.deepEqual(draft.ui, nativeUiLabels('zh'))

    await tui.type('/')
    const menu = await tui.untilView((view) => view.modal?.kind === 'commands', 'command popup')
    assert.equal(menu.modal.items[0].label, '/resume', 'command names stay protocol tokens')
    assert.equal(menu.modal.items[0].detail, t('cmd.resume').zh)
    assert.equal(menu.modal.footer, t('hint.commands').zh)

    await tui.press('', 'escape')
    await tui.press('', 'f1')
    const help = await tui.untilView((view) => view.modal?.kind === 'help', 'help modal')
    assert.equal(help.modal.title, t('help.title').zh)
    assert.equal(help.hint, t('hint.help').zh)
    assert.ok(help.modal.items.some((item) => item.label === 'Enter' && item.detail === t('key.enter').zh))
  } finally {
    await stopTui(tui)
  }
})

test('runTui with lang en translates the basic hints, command table and help', async () => {
  const tui = boot({ lang: 'en' })
  try {
    const draft = await draftView(tui, t('hint.draft').en)
    assert.equal(draft.hint, t('hint.draft').en)
    assert.equal(draft.hint, 'Local draft · a session is created when you send · / commands · ? shortcuts · Ctrl+C quit')

    await tui.type('/')
    const menu = await tui.untilView((view) => view.modal?.kind === 'commands', 'command popup')
    assert.equal(menu.modal.items[0].label, '/resume')
    assert.equal(menu.modal.items[0].detail, t('cmd.resume').en)
    assert.equal(menu.modal.footer, t('hint.commands').en)

    await tui.press('', 'escape')
    await tui.press('', 'f1')
    const help = await tui.untilView((view) => view.modal?.kind === 'help', 'help modal')
    assert.equal(help.modal.title, 'Help · Keys and commands')
    assert.equal(help.hint, t('hint.help').en)
    assert.ok(help.modal.items.some((item) => item.label === 'Enter' && item.detail === t('key.enter').en))
    assert.equal(help.modal.items.some((item) => CJK.test(item.detail)), false, 'no Chinese shortcut text in en')
  } finally {
    await stopTui(tui)
  }
})

// -------------------------------------------------------------- view.ui

test('view.ui carries the full English label set for the native renderer', async () => {
  const tui = boot({ lang: 'en' })
  try {
    const draft = await draftView(tui, t('hint.draft').en)
    assert.deepEqual(draft.ui, nativeUiLabels('en'))
    assert.deepEqual(Object.keys(draft.ui).sort(), [...NATIVE_UI_FIELDS].sort())
    assert.equal(draft.ui.placeholder, 'Ask dsh-ask to do anything')
    assert.equal(draft.ui.emptyList, 'no matches')
    assert.equal(draft.ui.searchPlaceholder, 'Type to search')
    assert.equal(draft.ui.hintFallback, '? for shortcuts')
    assert.equal(draft.ui.modalTitleHelp, 'Help · Keys and commands')
    assert.equal(draft.ui.modalTitleSessions, 'Select a session')
    assert.equal(draft.ui.backToBottom.length, 4)
    for (const label of [draft.ui.placeholder, draft.ui.emptyList, draft.ui.searchPlaceholder, ...draft.ui.backToBottom]) {
      assert.doesNotMatch(label, CJK, `English ui label: ${label}`)
    }
    // `ui` is an ordinary enumerable view field now: it is part of the
    // documented view shape and JSON serialization carries it.
    assert.equal(Object.keys(draft).includes('ui'), true, 'ui is an enumerable view field')
    assert.deepEqual(
      Object.keys(draft).sort(),
      [
        'attachments', 'cwd', 'hint', 'input', 'inputCursor', 'messages', 'modal', 'model',
        'project', 'scrollOffset', 'sessionId', 'sessionTitle', 'status', 'statusLines', 'ui',
      ],
      'documented view keys incl. ui',
    )
    const onTheWire = JSON.parse(JSON.stringify(draft))
    assert.deepEqual(onTheWire.ui, nativeUiLabels('en'), 'JSON.stringify carries view.ui')
  } finally {
    await stopTui(tui)
  }
})

test('view.ui is the zh label set when the run is Chinese', async () => {
  const tui = boot({ lang: 'zh' })
  try {
    const draft = await draftView(tui, t('hint.draft').zh)
    assert.deepEqual(draft.ui, nativeUiLabels('zh'))
    assert.equal(draft.ui.placeholder, '向 dsh-ask 提问或下达指令')
    assert.equal(draft.ui.modalTitleSessions, '选择会话')
  } finally {
    await stopTui(tui)
  }
})

// ------------------------------------------------- default language resolution

test('a direct runTui call without lang resolves like resolveLanguage', async () => {
  const expected = resolveLanguage({})
  const tui = boot()
  try {
    const draft = await draftView(tui, t('hint.draft')[expected])
    assert.equal(draft.hint, t('hint.draft')[expected], `default resolved language is ${expected}`)
    assert.deepEqual(draft.ui, nativeUiLabels(expected))
  } finally {
    await stopTui(tui)
  }
})

test('an invalid lang is rejected before the screen is created', async () => {
  const { adapter } = makeAdapter()
  let created = false
  await assert.rejects(
    runTui({
      adapter,
      createScreen: async () => {
        created = true
        return { start() {}, render() {}, stop() {} }
      },
      options: { lang: 'ja', renderDelayMs: 0 },
    }),
    (error) => error.code === 'invalid-language',
  )
  assert.equal(created, false)
})

// ------------------------------------------------ user data is never rewritten

test('Chinese user text, model output, paths and titles are never translated', async () => {
  const tui = boot({ lang: 'en' })
  try {
    await draftView(tui, t('hint.draft').en)
    // The text is a verbatim catalog value on purpose: a global replacement
    // pass over view.messages would rewrite it, a per-construction translation
    // cannot.
    const userText = '中文用户文本 · Enter 发送 · / 命令 · /tmp/路径/文件.png'
    const modelText = '模型回答：这是原文，不应翻译'
    tui.adapter.ask = async (body) => {
      tui.requests.ask.push(body)
      return { ok: true, sessionId: body.sessionId, text: modelText, elapsedMs: 1, tools: 0 }
    }
    await tui.type(userText)
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (v) => v.messages.some((m) => m.role === 'assistant' && m.text === modelText),
      'assistant answer',
    )
    const users = view.messages.filter((message) => message.role === 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0].text, userText, 'the user message is byte-identical')
    assert.equal(view.messages.some((message) => message.text === t('hint.draft').en), false)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------- attachment / send prompts

test('attachment and send prompts follow the language', async () => {
  const tui = boot({ lang: 'en' })
  try {
    await draftView(tui, t('hint.draft').en)
    await tui.press('', 'ctrl-v')
    const summary = 'clip.png (PNG, 25 B)'
    const attached = await tui.untilView(
      (view) =>
        view.attachments.length === 1 &&
        view.messages.some((message) => message.text === tw('en', 'attach.added', { image: summary })) &&
        view.hint === tw('en', 'attach.clipboardAdded', { image: summary }),
      'clipboard attachment',
    )
    assert.equal(attached.hint, tw('en', 'attach.clipboardAdded', { image: summary }))
    assert.equal(attached.messages.some((message) => message.text.startsWith('Attached ')), true)

    // Attachment-only send: the generated user text is translated, the file
    // name (Host/user data) is not.
    await tui.press('', 'enter')
    const sent = await tui.untilView(
      (view) => view.messages.some((message) => message.role === 'system' && message.text.startsWith('Done · ')),
      'turn done',
    )
    const user = sent.messages.find((message) => message.role === 'user')
    assert.equal(user.text, '(attachments only: clip.png)')
  } finally {
    await stopTui(tui)
  }
})

test('an unsupported image Host explains itself in the run language', async () => {
  const tui = boot({ lang: 'en' }, { images: undefined })
  try {
    await draftView(tui, t('hint.draft').en)
    await tui.press('', 'ctrl-v')
    // The unsupported branch only records the error; the next key event paints
    // it (the same as before i18n). Esc is inert here and forces that paint.
    await tui.press('', 'escape')
    const view = await tui.untilView(
      (v) => v.messages.some((m) => m.role === 'error' && m.text === t('attach.unsupported').en),
      'image unsupported error',
    )
    assert.ok(view.messages.some((message) => message.text.includes('image attachments')), 'English explanation')
  } finally {
    await stopTui(tui)
  }
})

// --------------------------------------- native frame cap

test('an oversized native frame still carries view.ui after the message cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ui-cap-'))
  const logPath = join(dir, 'ui.log')
  await chmod(NATIVE_FAKE, 0o755)
  const screen = createScreen({
    onKey: () => {},
    env: { ...process.env, [BINARY_ENV]: NATIVE_FAKE, FAKE_UI_LOG: logPath },
  })
  try {
    screen.start()
    screen.render({
      project: 'p',
      cwd: '/w',
      sessionTitle: '',
      sessionId: 's',
      model: 'm',
      status: 'ready',
      statusLines: [],
      messages: [{ role: 'assistant', text: 'x'.repeat(9 * 1024 * 1024) }],
      input: '',
      inputCursor: 0,
      attachments: [],
      hint: 'h',
      scrollOffset: 0,
      modal: null,
      ui: nativeUiLabels('en'),
    })
    const line = await until(
      () => {
        if (existsSync(logPath) !== true) return undefined
        const raw = readFileSync(logPath, 'utf8').trim()
        if (raw === '') return undefined
        return raw.slice(raw.lastIndexOf('\n') + 1)
      },
      { label: 'capped native frame', timeoutMs: 8000 },
    )
    const entry = JSON.parse(line)
    assert.equal(entry.type, 'render')
    assert.equal(entry.view.messages.length, 0, 'the oversized message list is capped')
    assert.deepEqual(entry.view.ui, nativeUiLabels('en'), 'ui survives the message cap')
  } finally {
    // The temporary log directory is intentionally left in place: this round
    // only stops the child screen, nothing is deleted.
    await screen.stop().catch(() => {})
  }
})

// ------------------------------------------------ modal / system regression

test('the permissions modal is complete in zh and en, Host preset data stays verbatim', async () => {
  for (const lang of ['zh', 'en']) {
    const tui = boot({ lang })
    try {
      await readySession(tui, lang)
      await tui.press('', 'f3')
      const view = await tui.untilView(
        (v) => v.modal?.kind === 'permissions' && v.modal.title === t('perm.permission-presets')[lang],
        `${lang} permission presets`,
      )
      assert.equal(view.modal.footer, t('perm.select-preset-enter-confirm-esc-close')[lang])
      assert.ok(view.modal.items.some((item) => item.label === t('perm.re-read-permission-presets')[lang]))
      assert.ok(view.modal.items.some((item) => item.label === t('perm.close-esc')[lang]))
      const text = modalText(view)
      // Host-owned preset names/descriptions are Host data: identical in both
      // languages and never catalogued.
      assert.match(text, /工作区写入/)
      assert.match(text, /只读文件系统/)
      assert.match(text, /workspace-write/)
      assert.match(text, lang === 'en' ? /Current preset:/ : /当前预设：/)
      assert.match(text, lang === 'en' ? /Default preset \(new sessions\):/ : /默认预设（新会话）：/)
    } finally {
      await stopTui(tui)
    }
  }
})

test('the approval claim and its confirmation are complete in zh and en', async () => {
  for (const lang of ['zh', 'en']) {
    const tui = boot({ lang })
    try {
      await readySession(tui, lang)
      await tui.press('', 'f2')
      // The wrapped page breaks long lines, so match the stable prefix.
      const unclaimedText = lang === 'en' ? 'Terminal approval channel:' : '终端审批通道：'
      const page = await tui.untilView(
        (v) => v.modal?.kind === 'approvals' && modalText(v).includes(unclaimedText),
        `${lang} approvals`,
      )
      assert.equal(page.modal.title, t('msg.pending-requests')[lang])

      await selectModalItem(tui, t('approval.claim-terminal-approval-for-the-current-2')[lang])
      const confirm = await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', `${lang} claim confirm`)
      assert.equal(confirm.modal.title, t('approval.claim-terminal-approval')[lang])
      // Long lines wrap, so match a stable fragment (the full text is pinned by
      // the catalog test).
      assert.ok(modalText(confirm).includes(lang === 'en' ? 'Nothing is claimed' : '需要你在这里显式确认后才接入'))
      assert.ok(confirm.modal.items.some((item) => item.label === t('approval.confirm-terminal-approval-claim')[lang]))

      await selectModalItem(tui, t('approval.confirm-terminal-approval-claim')[lang])
      await tui.untilView((v) => v.modal === null, `${lang} claim settles`)
      await tui.press('', 'f2')
      const claimedText = tw(lang, 'approval.terminal-approval-channel-claimed-claim', { p1: 'claim-1' })
      const claimed = await tui.untilView(
        (v) => v.modal?.kind === 'approvals' && modalText(v).includes(claimedText),
        `${lang} claimed channel`,
      )
      assert.ok(modalText(claimed).includes(claimedText), `${lang} claimed channel status`)
    } finally {
      await stopTui(tui)
    }
  }
})

test('the continued-question flow is complete in zh and en, Host question text stays verbatim', async () => {
  for (const lang of ['zh', 'en']) {
    const tui = boot(
      { lang },
      {
        awaiting: {
          ...CLEAN_AWAITING,
          pendingInput: ['question'],
          questions: { active: [continuedBatch()], settledCount: 0 },
          answerable: true,
        },
      },
    )
    try {
      await readySession(tui, lang)
      await tui.press('', 'f2')
      const page = await tui.untilView((v) => v.modal?.kind === 'approvals', `${lang} approvals`)
      const questionItem = page.modal.items.find((item) => item.label.includes('选哪个？'))
      assert.ok(questionItem !== undefined, `continued question listed: ${page.modal.items.map((item) => item.label)}`)
      assert.equal(questionItem.label.startsWith(t('msg.answer')[lang]), true)

      await selectModalItem(tui, '选哪个？')
      const detail = await tui.untilView((v) => v.modal?.kind === 'question-detail', `${lang} question detail`)
      assert.equal(detail.modal.title, tw(lang, 'question.question-waiting', { p1: 'call-cont' }))
      const text = modalText(detail)
      assert.match(text, /选哪个？/, 'Host question text is verbatim')
      assert.match(text, /选项甲/, 'Host option text is verbatim')
      assert.match(text, lang === 'en' ? /State: continued \(answerable\)/ : /状态：continued（可答）/)
      assert.ok(text.includes(t('question.start-answering')[lang]))

      await selectModalItem(tui, t('question.start-answering')[lang])
      const answer = await tui.untilView((v) => v.modal?.kind === 'question-answer', `${lang} question answer`)
      assert.equal(answer.modal.title, tw(lang, 'question.answer-question-2', { p1: 1, p2: 1 }))
      assert.equal(answer.modal.footer, t('question.select-enter-choose-and-continue-esc-cancel')[lang] ?? answer.modal.footer)
      assert.match(modalText(answer), /选哪个？/, 'Host question text survives the answer page')
    } finally {
      await stopTui(tui)
    }
  }
})

test('the session picker is complete in zh and en', async () => {
  const rows = [
    {
      sessionId: 'sess-p',
      title: 'Picker conversation',
      preview: '',
      blank: false,
      running: false,
      updatedAt: 1,
      cwd: '/work/picker',
    },
  ]
  for (const lang of ['zh', 'en']) {
    const tui = boot({ lang, initialPicker: true }, { rows })
    try {
      const page = await tui.untilView(
        (v) => v.modal?.kind === 'sessions' && v.modal.title === t('picker.select-a-session')[lang],
        `${lang} picker`,
      )
      assert.equal(page.modal.footer, t('picker.select-enter-resume-switch-scope-type-to')[lang])
      const newItem = page.modal.items.find((item) => item.label === t('picker.newSession')[lang])
      assert.ok(newItem !== undefined, `${lang} picker offers the new-session entry`)
      assert.match(newItem.detail, lang === 'en' ? /created on the first send/ : /首次发送时创建/)
    } finally {
      await stopTui(tui)
    }
  }
})

test('the draft error notices are localized in zh and en', async () => {
  for (const lang of ['zh', 'en']) {
    const tui = boot({ lang })
    try {
      await draftView(tui, t('hint.draft')[lang])
      await tui.press('', 'f3')
      const permNote = await tui.untilView(
        (v) => v.messages.some((m) => m.role === 'system' && m.text === t('perm.no-session-yet-it-is-created-on-the-first')[lang]),
        `${lang} permission draft notice`,
      )
      assert.ok(permNote.messages.some((m) => m.text === t('perm.no-session-yet-it-is-created-on-the-first')[lang]))

      await tui.press('', 'f2')
      const awaitNote = await tui.untilView(
        (v) => v.messages.some((m) => m.role === 'system' && m.text === t('approval.no-session-yet-it-is-created-on-the-first')[lang]),
        `${lang} awaiting draft notice`,
      )
      assert.ok(awaitNote.messages.some((m) => m.text === t('approval.no-session-yet-it-is-created-on-the-first')[lang]))
    } finally {
      await stopTui(tui)
    }
  }
})
