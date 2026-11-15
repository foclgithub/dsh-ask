/**
 * Business-layer tests for the full-screen TUI (`dsh-tui.mjs`).
 *
 * The TUI is driven directly: a fake screen factory captures every rendered
 * `view` and hands back the `onKey` callback, so no terminal, no real TTY and no
 * escape-sequence parsing is involved. Session data, clipboard and streaming
 * turns come from a plain mock adapter that records every request body; that is
 * what the assertions look at, never internal helpers.
 *
 * `dsh-ask.mjs` is spawned as a real subprocess only for the non-TTY /
 * `--plain` / `--json` parity checks, pointed at a local `node:http` Host double
 * exactly like tests/cli.test.mjs. `--no-start` and `DSH_ASK_NO_START=1` keep the
 * desktop app out of it, and the fixtures never touch the real clipboard.
 *
 * Timing contract used below: `renderDelayMs: 0` renders synchronously after
 * every state change, so `views.at(-1)` is current once an awaited `onKey`
 * settles. Disk-local `ask` mocks settle immediately; tests that need a pending
 * turn install their own promise.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { runTui, tuiEligible } from '../dsh-tui.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
const FAKE_TTY = join(HERE, 'fixtures', 'fake-tty.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-tui-test-'))
const BASE_CWD = '/tmp/dsh-tui-test-workspace'

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

// A tiny but valid PNG header: the module only measures and labels bytes.
const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-tui-test'),
]).toString('base64')

const image = (name = 'clip.png') => ({ mediaType: 'image/png', data: PNG_B64, name })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll a predicate against the live state; disk-local, so a few ms is plenty. */
async function until(predicate, { label = 'condition', timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(2)
  }
}

const VIEW_KEYS = [
  'attachments',
  'cwd',
  'hint',
  'input',
  'inputCursor',
  'messages',
  'modal',
  'model',
  'project',
  'scrollOffset',
  'sessionId',
  'sessionTitle',
  'status',
  'statusLines',
  'ui',
]

function sessionRow(sessionId, title, cwd) {
  return {
    sessionId,
    title,
    preview: '',
    blank: false,
    running: false,
    updatedAt: 1,
    cwd,
  }
}

/**
 * A plain adapter double: every method is async and every call is recorded.
 * `overrides.ask` / `overrides.loadClipboard` may replace single methods; tests
 * that need it also swap a method after construction.
 */
function makeAdapter(overrides = {}) {
  const requests = {
    listSessions: [],
    fetchTranscript: [],
    newConversationForDirectory: [],
    newConversationWithOptions: [],
    ask: [],
    askBlocking: [],
    fetchQueue: [],
    fetchStatus: [],
    mutateQueue: [],
    listWorkspaces: 0,
    loadPaths: [],
    loadClipboard: 0,
    validateBatch: [],
  }
  const rows =
    overrides.rows ??
    [
      sessionRow('sess-a', 'Conversation A', '/work/a'),
      sessionRow('sess-b', 'Conversation B', '/work/b'),
    ]
  const transcripts = overrides.transcripts ?? {}
  const adapter = {
    endpoint: 'http://127.0.0.1:65535',
    pid: 4242,
    images: 'images' in overrides ? overrides.images : { supported: true, maxImages: 4 },
    async listSessions(limit) {
      requests.listSessions.push(limit)
      return rows.map((row) => ({ ...row }))
    },
    async fetchTranscript(sessionId, limit) {
      requests.fetchTranscript.push({ sessionId, limit })
      const source = transcripts[sessionId]
      if (source === undefined) return { ok: true, sessionId, running: false, more: false, items: [] }
      return typeof source === 'function' ? source(sessionId) : source
    },
    async newConversationForDirectory(cwd) {
      requests.newConversationForDirectory.push(cwd)
      return { sessionId: 'sess-new' }
    },
    async newConversationWithOptions(cwd) {
      requests.newConversationWithOptions.push(cwd)
      return { sessionId: 'sess-new-options' }
    },
    async ask(body, extra) {
      requests.ask.push({ body, signal: extra?.signal })
      extra?.onFrame?.({ t: 'delta', text: 'ok' })
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    },
    async askBlocking(body, extra) {
      requests.askBlocking.push({ body, signal: extra?.signal })
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    },
    async fetchQueue(sessionId) {
      requests.fetchQueue.push(sessionId)
      return { ok: true, sessionId, running: false, items: [] }
    },
    async fetchStatus(sessionId) {
      requests.fetchStatus.push(sessionId)
      if (typeof overrides.fetchStatus === 'function') return overrides.fetchStatus(sessionId)
      const status = overrides.statuses?.[sessionId]
      return { ok: true, sessionId, status: status ?? null }
    },
    async mutateQueue(sessionId, itemId, action, text) {
      requests.mutateQueue.push({ sessionId, itemId, action, text })
      return { ok: true, sessionId, running: false, items: [] }
    },
    async listWorkspaces() {
      requests.listWorkspaces += 1
      return overrides.workspaces ?? []
    },
    async loadPaths(text, cwd) {
      requests.loadPaths.push({ text, cwd })
      return []
    },
    async loadClipboard() {
      requests.loadClipboard += 1
      if (overrides.loadClipboard !== undefined) return overrides.loadClipboard()
      return image()
    },
    validateBatch(images) {
      requests.validateBatch.push(images)
      return images.slice()
    },
  }
  if (typeof overrides.ask === 'function') adapter.ask = overrides.ask
  if (typeof overrides.askBlocking === 'function') adapter.askBlocking = overrides.askBlocking
  return { adapter, requests, rows }
}

/**
 * Boot `runTui` with a capturing screen. `press` is the module's own `onKey`
 * promise, so handlers that await their work are settled when it resolves;
 * fire-and-forget handlers (modal Enter, chat Enter) are covered by `untilView`.
 */
function boot(adapter, options = {}) {
  const views = []
  const output = []
  const screen = { started: 0, stopped: 0 }
  let onKey
  const createScreen = async ({ onKey: handler }) => {
    onKey = handler
    return {
      start() {
        screen.started += 1
      },
      render(view) {
        views.push(view)
      },
      stop() {
        screen.stopped += 1
      },
    }
  }
  const running = runTui({
    adapter,
    createScreen,
    output: { write: (chunk) => output.push(String(chunk)) },
    // Most tests drive an already-selected Session or the picker; the Codex
    // "start a new conversation immediately" default has its own test below.
    options: { cwd: BASE_CWD, renderDelayMs: 0, initialPicker: true, ...options },
  })
  // Keep a rejected run from surfacing as an unhandled rejection before a test
  // awaits it; the original promise still rejects for `await`/`stopTui`.
  running.catch(() => {})
  const last = () => views[views.length - 1]
  const press = (str = '', key) => {
    assert.equal(typeof onKey, 'function', 'the screen factory never received onKey')
    return onKey(str, key)
  }
  const untilView = (predicate, label, timeoutMs = 3000) =>
    until(
      () => {
        const view = last()
        if (view === undefined || predicate(view) !== true) return undefined
        return view
      },
      { label, timeoutMs },
    )
  return { views, output, screen, running, last, press, untilView }
}

/** Wait for the first real picker paint (items arrive one render after the modal). */
async function initialPicker(tui) {
  return tui.untilView(
    (view) =>
      view.modal !== null &&
      view.modal.title === '选择会话' &&
      view.modal.items.length >= 2,
    'initial picker with items',
  )
}

/** Open a Session from the picker by moving the selection to its item. */
async function pickSession(tui, sessionId) {
  await initialPicker(tui)
  const modal = tui.last().modal
  const index = modal.items.findIndex((item) => item.detail.split(' · ')[0] === sessionId)
  assert.notEqual(index, -1, `picker must list ${sessionId}: ${JSON.stringify(modal.items)}`)
  while (tui.last().modal.selected !== index) {
    await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
  }
  await tui.press('', 'enter')
  await tui.untilView(
    (view) => view.modal === null && view.sessionId === sessionId && view.status === 'ready',
    `session ${sessionId} to open`,
  )
}

/** Open the chat picker and switch to a Session that is already listed. */
async function pickerSwitchTo(tui, sessionId) {
  await tui.press('', 'ctrl-p')
  await tui.untilView(
    (view) => view.modal !== null && view.modal.title === '切换会话' && view.modal.items.length >= 2,
    'chat picker',
  )
  const index = tui.last().modal.items.findIndex((item) => item.detail.split(' · ')[0] === sessionId)
  assert.notEqual(index, -1, `chat picker must list ${sessionId}`)
  while (tui.last().modal.selected !== index) {
    await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
  }
  await tui.press('', 'enter')
  await tui.untilView(
    (view) => view.modal === null && view.sessionId === sessionId && view.status === 'ready',
    `switch to ${sessionId}`,
  )
}

/** Type a whole string as one text event (the renderer buffering is not under test). */
const type = (tui, text) => tui.press(text, 'text')

/**
 * Always leave a runTui call settled, even when an assertion failed mid-test:
 * abort a pending turn first, then quit. Returns the exit code.
 */
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
    const view = tui.last()
    const busy = view !== undefined && (view.status === 'waiting' || view.status === 'streaming')
    await tui.press('', busy ? 'ctrl-c' : 'ctrl-q')
  }
}

// ---------------------------------------------------------------------------
// 1. Per-session isolation
// ---------------------------------------------------------------------------

test('per-session isolation: draft, attachment, messages and cwd never leak between Sessions', async () => {
  const { adapter, requests } = makeAdapter({
    transcripts: {
      'sess-a': {
        ok: true,
        sessionId: 'sess-a',
        running: false,
        more: false,
        items: [
          { kind: 'user', text: 'hello A' },
          { kind: 'assistant', text: 'reply A' },
        ],
      },
      'sess-b': {
        ok: true,
        sessionId: 'sess-b',
        running: false,
        more: false,
        items: [{ kind: 'user', text: 'hello B' }],
      },
    },
  })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await type(tui, 'draft A')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'attachment on A')
    const aSnapshot = tui.last()
    assert.equal(aSnapshot.input, 'draft A')
    assert.equal(aSnapshot.inputCursor, 'draft A'.length)
    assert.deepEqual(aSnapshot.attachments.map((entry) => entry.name), ['clip.png'])
    assert.deepEqual(
      aSnapshot.messages.slice(0, 2).map((message) => message.text),
      ['hello A', 'reply A'],
    )
    assert.match(aSnapshot.messages[2].text, /^已附加 clip\.png \(PNG, \d+ B\)$/)
    assert.equal(aSnapshot.cwd, '/work/a')

    // Switch to B: B must start blank and show only B's transcript.
    await pickerSwitchTo(tui, 'sess-b')
    const bView = tui.last()
    assert.equal(bView.input, '', 'B must not inherit A draft')
    assert.equal(bView.inputCursor, 0)
    assert.deepEqual(bView.attachments, [], 'B must not inherit A attachment')
    assert.deepEqual(
      bView.messages.map((message) => message.text),
      ['hello B'],
    )
    assert.equal(bView.cwd, '/work/b')

    await type(tui, 'draft B')
    await pickerSwitchTo(tui, 'sess-a')

    // Everything A held is restored exactly, including the pending image.
    const restored = tui.last()
    assert.equal(restored.input, 'draft A')
    assert.equal(restored.inputCursor, 'draft A'.length)
    assert.deepEqual(restored.attachments.map((entry) => entry.name), ['clip.png'])
    assert.deepEqual(
      restored.messages.map((message) => message.text),
      aSnapshot.messages.map((message) => message.text),
    )
    assert.equal(restored.cwd, '/work/a')

    // A's turn carries A's cwd and the pending image.
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 1,
      'A turn to settle',
    )
    const aBody = requests.ask[0].body
    assert.equal(aBody.sessionId, 'sess-a')
    assert.equal(aBody.cwd, '/work/a')
    assert.equal(aBody.text, 'draft A')
    assert.equal(aBody.images.length, 1)
    assert.equal(aBody.images[0].name, 'clip.png')

    // B keeps its own draft and its turn uses B's cwd with no image field.
    await pickerSwitchTo(tui, 'sess-b')
    assert.equal(tui.last().input, 'draft B')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 2,
      'B turn to settle',
    )
    const bBody = requests.ask[1].body
    assert.equal(bBody.sessionId, 'sess-b')
    assert.equal(bBody.cwd, '/work/b')
    assert.equal(bBody.text, 'draft B')
    assert.equal('images' in bBody, false, 'A pending image must never ride B turn')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    assert.equal(tui.screen.stopped, 1)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 2. Busy guard
// ---------------------------------------------------------------------------

test('busy turn refuses switch/new (Ctrl+P, Ctrl+N, /new, /switch) until Ctrl+C aborts it', async () => {
  const { adapter, requests } = makeAdapter()
  adapter.ask = (body, extra) => {
    requests.ask.push({ body, signal: extra?.signal })
    return new Promise((resolve, reject) => {
      extra.signal.addEventListener('abort', () => {
        reject(
          Object.assign(new Error('local wait stopped (the remote Session may still be running)'), {
            name: 'AbortError',
          }),
        )
      })
    })
  }
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, 'hold it open')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'waiting', 'busy turn')
    assert.equal(requests.ask.length, 1)

    const counters = {
      listSessions: requests.listSessions.length,
      create: requests.newConversationForDirectory.length,
      createOptions: requests.newConversationWithOptions.length,
    }

    await tui.press('', 'ctrl-p')
    assert.equal(tui.last().modal, null, 'Ctrl+P must not open the picker while busy')
    assert.match(tui.last().hint, /Ctrl\+C/)

    await tui.press('', 'ctrl-n')
    assert.equal(tui.last().modal, null, 'Ctrl+N must not open/start anything while busy')
    assert.equal(requests.newConversationForDirectory.length, counters.create)
    assert.match(tui.last().hint, /Ctrl\+C/)

    // Send /new: submitInput refuses while busy and keeps the draft.
    await type(tui, '/new')
    await tui.press('', 'enter')
    assert.equal(
      requests.newConversationForDirectory.length,
      counters.create,
      '/new must not create a Session while busy',
    )
    assert.match(tui.last().hint, /Ctrl\+C/)

    // Replace the draft with /switch <id> and try again.
    await tui.press('', 'ctrl-u')
    await type(tui, '/switch sess-b')
    await tui.press('', 'enter')
    assert.equal(tui.last().sessionId, 'sess-a', '/switch must not switch while busy')
    assert.match(tui.last().hint, /Ctrl\+C/)
    assert.equal(requests.listSessions.length, counters.listSessions, 'no picker refresh happened')

    // Codex Ctrl+C priority: the non-empty draft is cleared first, then the
    // next press stops the local wait; only then is switching allowed again.
    await tui.press('', 'ctrl-c')
    await tui.untilView((view) => view.input === '', 'draft cleared before interrupt')
    await tui.press('', 'ctrl-c')
    await tui.untilView(
      (view) => view.status === 'ready' && view.messages.some((message) => message.text.includes('已停止本地等待')),
      'aborted turn to settle',
    )

    await tui.press('', 'ctrl-p')
    await tui.untilView(
      (view) => view.modal !== null && view.modal.title === '切换会话',
      'picker after abort',
    )
    assert.equal(requests.listSessions.length, counters.listSessions + 1)

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    assert.equal(tui.screen.stopped, 1)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 3. Streaming error payload
// ---------------------------------------------------------------------------

test('a stream-error payload keeps partial assistant text and the error, without claiming a cancel', async () => {
  const { adapter, requests } = makeAdapter()
  adapter.ask = async (body, extra) => {
    requests.ask.push({ body, signal: extra?.signal })
    extra.onFrame({ t: 'delta', text: 'partial one ' })
    extra.onFrame({ t: 'delta', text: 'partial two' })
    return { ok: false, code: 'stream-error', error: 'boom', accepted: undefined }
  }
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, 'go')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'ready' && requests.ask.length === 1, 'failed turn')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('stream-error')),
      'error message',
    )

    const messages = tui.last().messages.map((message) => message.text)
    assert.ok(
      messages.includes('partial one partial two'),
      `partial assistant text must stay visible: ${JSON.stringify(messages)}`,
    )
    assert.ok(
      messages.some((text) => text.includes('stream-error') && text.includes('boom')),
      `the error must be visible: ${JSON.stringify(messages)}`,
    )
    const joined = messages.join('\n')
    assert.doesNotMatch(joined, /remote (turn|request) (was )?cancelled/i)
    assert.doesNotMatch(joined, /远端(已经|已)取消/)
    assert.match(tui.last().hint, /Enter 发送/)

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 4. Ctrl+C cancellation
// ---------------------------------------------------------------------------

test('Ctrl+C aborts only the local wait, marks attachments unconfirmed and never resends them', async () => {
  const { adapter, requests } = makeAdapter()
  let calls = 0
  adapter.ask = (body, extra) => {
    requests.ask.push({ body, signal: extra?.signal })
    calls += 1
    if (calls === 1) {
      return new Promise((resolve, reject) => {
        extra.signal.addEventListener('abort', () => {
          reject(
            Object.assign(new Error('local wait stopped (the remote Session may still be running)'), {
              name: 'AbortError',
            }),
          )
        })
      })
    }
    extra.onFrame({ t: 'delta', text: 'ok' })
    return Promise.resolve({ ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 })
  }
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'pending image')
    await type(tui, 'turn with image')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'waiting' && requests.ask.length === 1, 'busy turn')
    assert.equal(requests.ask[0].body.images.length, 1)

    await tui.press('', 'ctrl-c')
    await tui.untilView(
      (view) => view.status === 'ready' && view.messages.some((message) => message.text.includes('已停止本地等待')),
      'cancel to settle',
    )

    const joined = tui.last().messages.map((message) => message.text).join('\n')
    assert.match(joined, /远端可能仍在运行/)
    assert.doesNotMatch(joined, /remote (turn|request) (was )?cancelled/i)
    assert.doesNotMatch(joined, /远端(已经|已)取消/)
    assert.deepEqual(tui.last().attachments, [], 'the in-flight image must leave the pending list')

    // The sent-but-unconfirmed image is reported instead of silently re-queued.
    await type(tui, '/attachments')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('已发送/未确认')),
      '/attachments output',
    )
    const attachmentsText = tui.last().messages.map((message) => message.text).join('\n')
    assert.match(attachmentsText, /0 待发 · 1 已发送\/未确认/)
    assert.match(attachmentsText, /不会自动重发/)

    // The next text turn carries no image field at all.
    await type(tui, 'after the abort')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 2,
      'next text turn',
    )
    const nextBody = requests.ask[1].body
    assert.equal(nextBody.text, 'after the abort')
    assert.equal('images' in nextBody, false, 'an aborted image must not be attached again')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 5. Non-TTY / --plain / --json parity (real subprocess against a Host double)
// ---------------------------------------------------------------------------

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function startHost(routes) {
  const requests = []
  const host = { origin: '', requests }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw === '' ? undefined : JSON.parse(raw)
    } catch {
      body = undefined
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, raw })
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler === undefined) {
      json(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` })
      return
    }
    await handler({ req, res, url, body, host })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host.origin = `http://127.0.0.1:${server.address().port}`
  host.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  return host
}

const healthRoute = () => ({ res, host }) =>
  json(res, 200, { ok: true, origin: host.origin, pid: 4242, capabilities: {} })

const sessionsRoute = (rows) => ({ res }) => json(res, 200, { ok: true, sessions: rows })

const workspacesRoute = (rows) => ({ res }) => json(res, 200, { ok: true, workspaces: rows })

const queueRoute = (sessionId) => ({ res }) =>
  json(res, 200, { ok: true, sessionId, running: false, items: [] })

function startNdjson(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
}

async function makeHome() {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
  return home
}

function cliEnv(home, extra = {}) {
  return {
    ...process.env,
    DSH_HOME: home,
    DSH_ASK_LANG: 'en',
    DSH_ASK_NO_START: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  }
}

/** Run dsh-ask with stdin closed (so a stdin read can never hang the test). */
function runCli(home, origin, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASK, ...args, '--no-start', '-u', origin], {
      cwd: home,
      env: cliEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 'timeout' : (code ?? signal),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

/**
 * Drive a fake-TTY subprocess: each line is written only after the previous
 * readline question appeared (`which one?` in the picker, `❯ ` in the chat).
 */
function runFakeTty(home, origin, args, lines, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', FAKE_TTY, ASK, ...args, '--no-start', '-u', origin], {
      cwd: home,
      env: cliEnv(home, { TERM: 'xterm-256color' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let seen = ''
    let sent = 0
    let scheduledEnd = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const promptCount = () => (seen.match(/which one\?/g) ?? []).length + (seen.match(/❯ /g) ?? []).length
    const feed = () => {
      const count = promptCount()
      while (sent < lines.length && count > sent) {
        try {
          child.stdin.write(`${lines[sent]}\n`)
        } catch {
          // The child may have exited between prompts.
        }
        sent += 1
      }
      if (scheduledEnd === false && sent >= lines.length && count >= Math.max(lines.length, 1)) {
        scheduledEnd = true
        setTimeout(() => {
          try {
            child.stdin.end()
          } catch {
            // Already gone.
          }
        }, 400)
      }
    }
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      seen += String(chunk)
      stdout.push(chunk)
      feed()
    })
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 'timeout' : (code ?? signal),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

test('piped stdin: connect without a Session still refuses and creates nothing', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old', 'old', '/work/old')]),
  })
  try {
    const result = await runCli(home, host.origin, ['connect'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no Session given and stdin is not a terminal/)
    assert.doesNotMatch(result.stdout, /recent Sessions/)
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/create').length, 0)
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/transcript').length, 0)
  } finally {
    await host.close()
  }
})

test('--plain on a fake TTY keeps the line-based picker and emits no full-screen escapes', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old', 'old conversation', '/work/old')]),
    'GET /local-cli/workspaces': workspacesRoute([]),
    'GET /local-cli/queue': queueRoute('s-plain'),
    'POST /local-cli/create': ({ res }) =>
      json(res, 200, {
        ok: true,
        sessionId: 's-plain',
        created: true,
        workspace: { id: 'w-plain', title: 'plain', path: '/work/plain' },
      }),
  })
  try {
    const result = await runFakeTty(home, host.origin, ['connect', '--plain'], ['', '/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /recent Sessions/)
    assert.match(result.stdout, /which one\?/)
    assert.match(result.stdout, /Enter \/ n for a new conversation in this directory/)
    // No alternate-screen / raw-mode full-screen TUI sequences anywhere.
    assert.equal(result.stdout.includes('\x1b[?1049'), false, 'no alternate screen')
    assert.doesNotMatch(result.stdout, /\x1b\[\?25[lh]/, 'no cursor-hiding full-screen TUI')
    assert.equal(result.stdout.includes('\x1b[?1000'), false, 'no mouse tracking')
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/create').length, 1)
    assert.match(result.stdout, /s-plain/)
  } finally {
    await host.close()
  }
})

test('non-TTY one-shot prompt still prints the answer and exits 0 (stream and --json)', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-pipe"}\n')
      res.write('{"t":"delta","text":"answer from the mock host"}\n')
      res.end('{"t":"done","ok":true,"sessionId":"s-pipe","text":"answer from the mock host"}')
    },
    'POST /local-cli/ask': ({ res }) =>
      json(res, 200, { ok: true, sessionId: 's-json', text: 'json answer', running: false }),
  })
  try {
    const streamed = await runCli(home, host.origin, ['hello from a pipe'])
    assert.equal(streamed.timedOut, false)
    assert.equal(streamed.code, 0)
    assert.match(streamed.stdout, /answer from the mock host/)
    assert.equal(streamed.stdout.includes('\x1b'), false, 'piped output must stay plain')

    const asJson = await runCli(home, host.origin, ['--json', 'hello json'])
    assert.equal(asJson.timedOut, false)
    assert.equal(asJson.code, 0)
    const payload = JSON.parse(asJson.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.text, 'json answer')
    assert.equal(asJson.stdout.includes('\x1b'), false)
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// 6. CJK / surrogate-aware editing
// ---------------------------------------------------------------------------

test('CJK editing: insert, cursor, line-aware Home/End, code-point Backspace and one whole emoji', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await type(tui, '你')
    await type(tui, '好')
    assert.equal(tui.last().input, '你好')
    assert.equal(tui.last().inputCursor, 2)

    await tui.press('', 'left')
    await tui.press('', 'left')
    assert.equal(tui.last().inputCursor, 0)
    await type(tui, 'X')
    assert.equal(tui.last().input, 'X你好')
    assert.equal(tui.last().inputCursor, 1)

    // Multi-line draft: Home/End move within the current line only.
    await tui.press('', 'ctrl-c') // Codex: Ctrl+C clears the draft (Esc does not)
    await tui.untilView((view) => view.input === '', 'draft cleared')
    await type(tui, 'line1')
    await tui.press('', 'alt-enter')
    await type(tui, 'line2')
    assert.equal(tui.last().input, 'line1\nline2')
    assert.equal(tui.last().inputCursor, 11)

    await tui.press('', 'home')
    assert.equal(tui.last().inputCursor, 6, 'Home goes to the start of the current line')
    await tui.press('', 'end')
    assert.equal(tui.last().inputCursor, 11, 'End goes to the end of the current line')
    await tui.press('', 'home')
    await tui.press('', 'left')
    await tui.press('', 'end')
    assert.equal(tui.last().inputCursor, 5, 'End stops before the newline of line 1')
    await tui.press('', 'home')
    assert.equal(tui.last().inputCursor, 0, 'Home on line 1 reaches 0')

    // Backspace removes exactly one code point.
    await tui.press('', 'ctrl-c')
    await tui.untilView((view) => view.input === '', 'draft cleared again')
    await type(tui, 'abc')
    await tui.press('', 'left')
    await tui.press('', 'backspace')
    assert.equal(tui.last().input, 'ac')
    assert.equal(tui.last().inputCursor, 1)

    // A surrogate pair is one unit: the cursor never splits it and one
    // Backspace deletes the whole emoji.
    await tui.press('', 'ctrl-c')
    await tui.untilView((view) => view.input === '', 'draft cleared before emoji')
    await type(tui, '😀')
    assert.equal(tui.last().input, '😀')
    assert.equal(tui.last().inputCursor, 2)
    await tui.press('', 'left')
    assert.equal(tui.last().inputCursor, 0, 'left must jump the whole surrogate pair')
    assert.notEqual(tui.last().inputCursor, 1, 'the cursor must not land inside the pair')
    await tui.press('', 'right')
    assert.equal(tui.last().inputCursor, 2)
    await tui.press('', 'backspace')
    assert.equal(tui.last().input, '')
    assert.equal(tui.last().inputCursor, 0)

    // Editing never submits a turn.
    assert.equal(requests.ask.length, 0)

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 7. Bracketed paste
// ---------------------------------------------------------------------------

test('bracketed paste inserts every line without submitting; Enter then sends the whole draft', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await tui.press('line1\nline2', 'paste')
    assert.equal(tui.last().input, 'line1\nline2')
    assert.equal(tui.last().inputCursor, 11)
    assert.equal(requests.ask.length, 0, 'a paste must never be mistaken for Enter')

    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 1,
      'pasted draft to be sent',
    )
    const body = requests.ask[0].body
    assert.equal(body.text, 'line1\nline2')
    assert.ok(body.text.includes('\n'), 'the newline must reach the Host intact')
    assert.ok(
      tui.last().messages.some((message) => message.role === 'user' && message.text === 'line1\nline2'),
      'the user message keeps the multi-line text',
    )

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 8. Tab completion
// ---------------------------------------------------------------------------

test('Tab completes the selected slash-menu item instead of the common prefix (Codex behavior)', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, '/at')

    const menu = await tui.untilView(
      (view) => view.modal !== null && view.modal.kind === 'commands' && view.modal.items.length >= 2,
      '/at command menu',
    )
    assert.deepEqual(
      menu.modal.items.map((item) => item.label),
      ['/attach', '/attachments'],
      'prefix matches keep declaration order',
    )

    await tui.press('', 'tab')
    const view = tui.last()
    assert.equal(view.input, '/attach ', 'Tab completes the selected item and closes the menu')
    assert.equal(view.modal, null, 'the popup closes once the composed text has a space')
    assert.equal(requests.ask.length, 0, 'completion must not submit')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 9. Alt+Enter
// ---------------------------------------------------------------------------

test('Alt+Enter inserts a newline and Enter submits the whole multi-line draft', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, 'first line')
    await tui.press('', 'alt-enter')
    assert.equal(tui.last().input, 'first line\n')
    await type(tui, 'second line')
    assert.equal(tui.last().input, 'first line\nsecond line')
    assert.equal(requests.ask.length, 0, 'Alt+Enter must not submit')

    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 1,
      'multi-line turn',
    )
    assert.equal(requests.ask[0].body.text, 'first line\nsecond line')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 10. Ctrl+V clipboard
// ---------------------------------------------------------------------------

test('Ctrl+V attaches a clipboard image, and a clipboard failure adds nothing', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'clipboard image attached')
    const attached = tui.last()
    assert.deepEqual(attached.attachments.map((entry) => entry.name), ['clip.png'])
    assert.match(attached.hint, /已从剪贴板附加/)
    assert.ok(
      attached.messages.some((message) => message.text.includes('已附加')),
      'a system note records the attachment',
    )

    adapter.loadClipboard = async () => {
      throw new Error('no clipboard helper')
    }
    await tui.press('', 'ctrl-v')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('无法读取剪贴板')),
      'clipboard error',
    )
    assert.match(
      tui.last().messages.map((message) => message.text).join('\n'),
      /无法读取剪贴板 · no clipboard helper/,
    )
    assert.equal(tui.last().attachments.length, 1, 'a failed read must not add or drop attachments')
    assert.deepEqual(tui.last().attachments.map((entry) => entry.name), ['clip.png'])

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 11. Lifecycle keys
// ---------------------------------------------------------------------------

test('Esc at the resume picker starts a new conversation (Codex "esc start new")', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    const picker = await initialPicker(tui)
    assert.equal(picker.modal.kind, 'sessions', 'the resume list is a sessions page, not a command popup')

    await tui.press('', 'escape')
    const view = await tui.untilView(
      (view) => view.sessionId === '' && view.modal === null && view.status === 'draft',
      'local draft after esc',
    )
    assert.equal(requests.newConversationForDirectory.length, 0, 'Esc at the resume picker must not create immediately')
    assert.equal(view.model, 'unknown', 'the model is still never guessed')
    assert.equal(view.hint.includes('发送时创建会话'), true)
    assert.equal(tui.screen.started, 1)
    await type(tui, 'after esc')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.sessionId === 'sess-new' && view.status === 'ready',
      'first send after esc creates',
    )
    assert.deepEqual(requests.newConversationForDirectory, [BASE_CWD])

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    assert.equal(tui.screen.stopped, 1, 'the screen must be stopped so the terminal is restored')
  } finally {
    await stopTui(tui)
  }
})

test('chat keys: F1 help modal, Esc closes it, PgUp/PgDn scroll, Ctrl+Q quits and stops the screen', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await tui.press('', 'f1')
    const help = await tui.untilView(
      (view) => view.modal !== null && view.modal.title.includes('帮助'),
      'help modal',
    )
    assert.match(help.modal.title, /帮助/)
    assert.ok(help.modal.items.length > 0)

    await tui.press('', 'escape')
    await tui.untilView((view) => view.modal === null, 'help closed')

    assert.equal(tui.last().scrollOffset, 0)
    // Keyboard paging = one viewport (24-row fallback in tests minus the
    // reserved header/composer/hint rows = 16 visual lines).
    await tui.press('', 'pageup')
    assert.equal(tui.last().scrollOffset, 16, 'PageUp pages by one viewport')
    await tui.press('', 'pageup')
    assert.equal(tui.last().scrollOffset, 32)
    await tui.press('', 'pagedown')
    assert.equal(tui.last().scrollOffset, 16, 'PageDown must decrease by one viewport')
    await tui.press('', 'escape')
    assert.equal(tui.last().scrollOffset, 0, 'Esc returns to the newest message')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    assert.equal(tui.screen.stopped, 1)
  } finally {
    await stopTui(tui)
  }
})

test('mouse wheel scrolls one line while PageUp/PageDown page one viewport', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    assert.equal(tui.last().scrollOffset, 0)

    await tui.press('', 'wheelup')
    assert.equal(tui.last().scrollOffset, 1, 'one wheel notch = one visual line')
    await tui.press('', 'wheelup')
    assert.equal(tui.last().scrollOffset, 2)
    await tui.press('', 'wheeldown')
    assert.equal(tui.last().scrollOffset, 1)
    await tui.press('', 'wheeldown')
    assert.equal(tui.last().scrollOffset, 0)

    await tui.press('', 'pageup')
    const page = tui.last().scrollOffset
    assert.ok(page > 1, `PageUp must page, not scroll one line (got ${page})`)
    await tui.press('', 'pageup')
    assert.equal(tui.last().scrollOffset, page * 2, 'each PageUp adds exactly one viewport')
    await tui.press('', 'pagedown')
    assert.equal(tui.last().scrollOffset, page)

    await tui.press('', 'wheelup')
    assert.equal(tui.last().scrollOffset, page + 1, 'the wheel still moves a single line while scrolled')
    await tui.press('', 'escape')
    assert.equal(tui.last().scrollOffset, 0, 'Esc returns to the newest message')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 12. Slash commands
// ---------------------------------------------------------------------------

test('/sessions, /switch <full id>, /new and /status and /help act on the right Session', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')

    await type(tui, '/sessions')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.modal !== null && view.modal.title === '切换会话',
      '/sessions picker',
    )
    await tui.press('', 'escape')
    await tui.untilView((view) => view.modal === null, 'picker closed')

    await type(tui, '/switch sess-b')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.modal === null && view.sessionId === 'sess-b' && view.status === 'ready',
      '/switch full id',
    )

    await type(tui, '/new')
    await tui.press('', 'enter')
    const draft = await tui.untilView(
      (view) => view.sessionId === '' && view.status === 'draft',
      '/new opens a local draft',
    )
    assert.equal(draft.modal, null)
    assert.equal(requests.newConversationForDirectory.length, 0, '/new must not create a Host Session')
    assert.equal(requests.newConversationWithOptions.length, 0)

    await type(tui, 'create from /new')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.sessionId === 'sess-new' && view.status === 'ready',
      '/new draft creates on first send',
    )
    assert.deepEqual(requests.newConversationForDirectory, [BASE_CWD], '/new uses the current cwd')

    await type(tui, '/status')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('session     sess-new')),
      '/status output',
    )
    const status = tui.last().messages.map((message) => message.text).join('\n')
    assert.match(status, /session     sess-new/)
    assert.match(status, /model       —/, 'no model is reported for a Host without status')

    await type(tui, '/help')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.modal !== null && view.modal.title.includes('帮助'),
      '/help modal',
    )

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 13. Unknown delivery
// ---------------------------------------------------------------------------

test('a non-abort failure reports an unknown delivery and keeps the image off the next text turn', async () => {
  const { adapter, requests } = makeAdapter()
  adapter.ask = async (body, extra) => {
    requests.ask.push({ body, signal: extra?.signal })
    throw new Error('socket hang up')
  }
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'pending image')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) =>
        view.status === 'ready' &&
        view.messages.some((message) => message.text.includes('请求失败')),
      'unknown-delivery turn',
    )

    const joined = tui.last().messages.map((message) => message.text).join('\n')
    assert.match(joined, /请求失败 · socket hang up/)
    assert.match(joined, /投递结果未知/)
    assert.deepEqual(tui.last().attachments, [])

    await type(tui, '/attachments')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('delivery unknown')),
      '/attachments delivery state',
    )
    assert.match(
      tui.last().messages.map((message) => message.text).join('\n'),
      /已发送\/未确认[\s\S]*delivery unknown/,
    )

    adapter.ask = async (body, extra) => {
      requests.ask.push({ body, signal: extra?.signal })
      extra.onFrame({ t: 'delta', text: 'ok' })
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    }
    await type(tui, 'plain text after unknown')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && requests.ask.length === 2,
      'text turn after failure',
    )
    const body = requests.ask[1].body
    assert.equal(body.text, 'plain text after unknown')
    assert.equal('images' in body, false, 'an unconfirmed image must never be auto-resent')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 14. tuiEligible matrix
// ---------------------------------------------------------------------------

test('tuiEligible: json, plain, TERM=dumb, DSH_ASK_PLAIN and non-TTY stdin/stdout all opt out', () => {
  const tty = { isTTY: true }
  const notTty = { isTTY: false }
  const eligible = (extra) => tuiEligible({ stdin: tty, stdout: tty, env: {}, ...extra })

  assert.equal(eligible({}), true, 'a real terminal is the only true case')
  assert.equal(eligible({ json: true }), false)
  assert.equal(eligible({ plain: true }), false)
  assert.equal(eligible({ env: { TERM: 'dumb' } }), false)
  assert.equal(eligible({ stdin: notTty }), false)
  assert.equal(eligible({ stdout: notTty }), false)
  assert.equal(eligible({ env: { DSH_ASK_PLAIN: '1' } }), false)
  assert.equal(eligible({ env: { DSH_ASK_PLAIN: '0' } }), true)
})

// ---------------------------------------------------------------------------
// 15. View contract
// ---------------------------------------------------------------------------

function assertViewContract(view) {
  assert.ok(view !== null && typeof view === 'object')
  assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS, `documented view keys only: ${Object.keys(view)}`)
  assert.equal(typeof view.project, 'string')
  assert.equal(typeof view.cwd, 'string')
  assert.equal(typeof view.sessionTitle, 'string')
  assert.equal(typeof view.sessionId, 'string')
  assert.equal(view.model, 'unknown', 'the model is never guessed')
  assert.equal(typeof view.status, 'string')
  assert.ok(Array.isArray(view.messages))
  for (const message of view.messages) {
    assert.deepEqual(Object.keys(message).sort(), ['role', 'text'])
    assert.ok(['user', 'assistant', 'system', 'error'].includes(message.role), `role ${message.role}`)
    assert.equal(typeof message.text, 'string')
  }
  assert.equal(typeof view.input, 'string')
  assert.equal(typeof view.inputCursor, 'number')
  assert.ok(Array.isArray(view.attachments))
  for (const attachment of view.attachments) {
    assert.deepEqual(Object.keys(attachment).sort(), ['name'])
    assert.equal(typeof attachment.name, 'string')
  }
  assert.equal(typeof view.hint, 'string')
  assert.equal(typeof view.scrollOffset, 'number')
  if (view.modal !== null) {
    assert.deepEqual(Object.keys(view.modal).sort(), ['footer', 'items', 'kind', 'query', 'selected', 'title'])
    assert.equal(typeof view.modal.kind, 'string')
    assert.ok(['commands', 'sessions', 'help'].includes(view.modal.kind))
    assert.equal(typeof view.modal.title, 'string')
    assert.equal(typeof view.modal.selected, 'number')
    assert.equal(typeof view.modal.query, 'string')
    assert.equal(typeof view.modal.footer, 'string')
    assert.ok(Array.isArray(view.modal.items))
    for (const item of view.modal.items) {
      assert.deepEqual(Object.keys(item).sort(), ['detail', 'label'])
      assert.equal(typeof item.label, 'string')
      assert.equal(typeof item.detail, 'string')
    }
  }
}

test('every rendered view honours the documented shape, with a null-or-modal object and model unknown', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await initialPicker(tui)
    await tui.press('', 'f1')
    await tui.untilView((view) => view.modal !== null && view.modal.title.includes('帮助'), 'help modal')
    await tui.press('', 'escape')
    // Help sat on top of the initial picker, so closing it returns to the picker.
    await tui.untilView(
      (view) => view.modal !== null && view.modal.title === '选择会话',
      'picker restored after help',
    )
    await pickSession(tui, 'sess-a')
    await type(tui, '中文 draft')
    await tui.press('', 'pageup')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)

    assert.ok(tui.views.length > 3, 'several views were rendered')
    for (const view of tui.views) assertViewContract(view)
  } finally {
    await stopTui(tui)
  }
})


// ---------------------------------------------------------------------------
// 15. Codex-aligned behavior (default start, slash popup, history, help)
// ---------------------------------------------------------------------------

test('bare startup opens a local draft and creates the Session only on first send', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialPicker: false })
  try {
    const view = await tui.untilView(
      (view) => view.sessionId === '' && view.status === 'draft',
      'local draft at startup',
    )
    assert.equal(view.modal, null, 'the picker must not delay the local draft')
    assert.equal(requests.newConversationForDirectory.length, 0, 'bare startup must not create a Host Session')
    assert.equal(requests.newConversationWithOptions.length, 0)
    assert.match(view.hint, /发送时创建会话/)
    await type(tui, 'first message')
    await tui.press('', 'enter')
    const created = await tui.untilView(
      (view) => view.sessionId === 'sess-new' && view.status === 'ready',
      'first send creates the Session',
    )
    assert.deepEqual(requests.newConversationForDirectory, [BASE_CWD])
    assert.equal(requests.newConversationWithOptions.length, 0)
    assert.deepEqual(requests.ask.map((entry) => entry.body.sessionId), ['sess-new'])
    assert.equal(created.messages.some((message) => message.text === 'first message'), true)
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('the first send of a bare draft honours an explicit -w', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialPicker: false, workspace: 'my-workspace' })
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'workspace draft')
    assert.equal(requests.newConversationWithOptions.length, 0, 'startup is still just a draft')
    await type(tui, 'create with -w')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.sessionId === 'sess-new-options' && view.status === 'ready',
      'first send creates with the CLI options',
    )
    assert.deepEqual(requests.newConversationWithOptions, [BASE_CWD])
    assert.equal(requests.newConversationForDirectory.length, 0)
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('typing / opens the inline commands popup (kind commands) glued to the composer, filtered live', async () => {
  const { adapter } = makeAdapter({ transcripts: { 'sess-a': { ok: true, sessionId: 'sess-a', running: false, items: [] } } })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, '/')

    const all = await tui.untilView(
      (view) => view.modal !== null && view.modal.kind === 'commands',
      'commands popup',
    )
    const labels = all.modal.items.map((item) => item.label)
    assert.deepEqual(labels.slice(0, 3), ['/resume', '/new', '/quit'], 'Codex-primary commands come first')
    assert.ok(labels.includes('/help'))
    assert.equal(all.modal.selected, 0)
    assert.equal(all.input, '/', 'the popup never eats the composer text')
    assert.match(all.hint, /Tab 补全/)

    await type(tui, 're')
    const filtered = await tui.untilView(
      (view) => view.modal !== null && view.modal.items.length === 1 && view.modal.items[0].label === '/resume',
      'filtered popup',
    )
    assert.equal(filtered.input, '/re')

    await tui.press('', 'down')
    assert.equal(tui.last().modal.selected, 0, 'a one-item menu keeps the selection at 0')
    await tui.press('', 'escape')
    await tui.untilView((view) => view.modal === null, 'popup closed by Esc')
    assert.equal(tui.last().input, '/re', 'Esc closes the popup without deleting the draft')

    await type(tui, 's')
    await tui.untilView((view) => view.modal !== null && view.modal.kind === 'commands', 'popup reopens on edit')
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('slash popup: Up/Down select, Tab completes, Enter executes the selected command', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, '/')
    await tui.untilView((view) => view.modal !== null && view.modal.kind === 'commands', 'commands popup')

    await tui.press('', 'down')
    assert.equal(tui.last().modal.selected, 1, 'Down moves the popup selection')
    await tui.press('', 'up')
    assert.equal(tui.last().modal.selected, 0)
    assert.equal(tui.last().input, '/', 'selection never modifies the draft')

    // Enter on a bare "/" accepts the completion instead of executing it.
    await tui.press('', 'enter')
    await tui.untilView((view) => view.modal === null && view.input === '/resume ', 'bare slash completion')
    assert.equal(requests.ask.length, 0)

    // Typing a prefix and pressing Enter executes the selected command.
    await tui.press('', 'ctrl-u')
    await type(tui, '/stat')
    await tui.untilView((view) => view.modal !== null && view.modal.items[0].label === '/status', '/stat popup')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('session     sess-a')),
      '/status executed from the popup',
    )
    assert.equal(tui.last().input, '', 'executing a command clears the composer')
    assert.equal(requests.ask.length, 0, 'a slash command is never sent as a prompt')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('/resume opens the session list; Esc closes it back to the chat; /quit exits', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, '/resume')
    await tui.press('', 'enter')
    const picker = await tui.untilView(
      (view) => view.modal !== null && view.modal.kind === 'sessions' && view.modal.title === '切换会话',
      '/resume picker',
    )
    assert.ok(picker.modal.items.length >= 3, 'the list offers new + existing conversations')

    await tui.press('', 'escape')
    await tui.untilView((view) => view.modal === null && view.sessionId === 'sess-a', 'picker closed to chat')

    await type(tui, '/quit')
    await tui.press('', 'enter')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('Up/Down recall sent inputs in this Session and restore the live draft at the newest', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, 'first request')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'ready' && requests.ask.length === 1, 'first send')
    await type(tui, 'second request')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'ready' && requests.ask.length === 2, 'second send')

    await type(tui, 'live draft')
    await tui.press('', 'up')
    assert.equal(tui.last().input, 'live draft', 'a live draft is never silently replaced (Codex boundary rule)')
    await tui.press('', 'ctrl-c')
    assert.equal(tui.last().input, '', 'Ctrl+C clears the draft')

    await tui.press('', 'up')
    assert.equal(tui.last().input, 'second request', 'Up recalls the newest input')
    await tui.press('', 'up')
    assert.equal(tui.last().input, 'first request')
    await tui.press('', 'down')
    assert.equal(tui.last().input, 'second request')
    await tui.press('', 'ctrl-c')
    await type(tui, 'live draft')
    await tui.press('', 'up')
    assert.equal(tui.last().input, 'live draft', 'editing exits history browsing')
    await tui.press('', 'ctrl-c')

    // With the recalled entry still in the composer, Down moves back to the draft.
    await tui.press('', 'up')
    assert.equal(tui.last().input, 'second request')
    await tui.press('', 'down')
    assert.equal(tui.last().input, '', 'Down past the newest entry restores the cleared draft')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('? opens the shortcuts overlay and F1 stays a compatible alias', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.press('?', 'text')
    const help = await tui.untilView(
      (view) => view.modal !== null && view.modal.kind === 'help' && view.modal.title.includes('帮助'),
      '? help overlay',
    )
    assert.match(help.hint, /关闭帮助/)
    await tui.press('', 'escape')
    await tui.untilView((view) => view.modal === null, 'help closed')

    await tui.press('', 'f1')
    const f1 = await tui.untilView(
      (view) => view.modal !== null && view.modal.kind === 'help',
      'F1 help overlay',
    )
    assert.equal(f1.modal.kind, 'help')
    assert.ok(f1.modal.items.some((item) => item.label === '/resume'))
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('Ctrl+C exits when the draft is empty and no turn is running', async () => {
  const { adapter } = makeAdapter()
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.press('', 'ctrl-c')
    assert.equal(await tui.running, 0)
    assert.equal(tui.screen.stopped, 1)
  } finally {
    await stopTui(tui)
  }
})

test('Esc interrupts only the local wait and says the remote turn was not cancelled', async () => {
  const { adapter, requests } = makeAdapter()
  adapter.ask = (body, extra) => {
    requests.ask.push({ body, signal: extra?.signal })
    return new Promise((resolve, reject) => {
      extra.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('local wait stopped'), { name: 'AbortError' }))
      })
    })
  }
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await type(tui, 'keep running')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'waiting', 'busy turn')

    await tui.press('', 'escape')
    const view = await tui.untilView(
      (view) => view.status === 'ready' && view.messages.some((message) => message.text.includes('已停止本地等待')),
      'Esc interrupted the local wait',
    )
    const notes = view.messages.map((message) => message.text).join('\n')
    assert.match(notes, /远端可能仍在运行/)
    assert.match(notes, /并没有被远端取消/)
    assert.equal(requests.ask.length, 1, 'Esc never re-sends the prompt')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 17. Desktop-style status line
// ---------------------------------------------------------------------------

const STATUS_A = {
  model: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
  context: { usedTokens: 24_000, contextWindow: 200_000, percent: 12 },
  usage: {
    uncachedInputTokens: 39_840,
    outputTokens: 160,
    cacheReadTokens: 291_840,
    cacheWriteTokens: 160,
    billedInputTokens: 331_840,
    totalTokens: 332_000,
    cacheHitPercent: 88,
  },
  stats: {
    turns: 2,
    steps: 5,
    llmMs: 12_300,
    toolMs: 900,
    ttftMs: 1_600,
    ttftSteps: 2,
    decodeMs: 9_400,
    decodeTokens: 329_000,
    tokensPerSecond: 35,
  },
  permission: 'workspace-write',
  running: false,
  queue: 0,
  pendingInput: [],
}

const STATUS_B = {
  model: { provider: 'deepseek', model: 'deepseek-pro', effort: 'medium' },
  context: { usedTokens: 60_000, contextWindow: 200_000, percent: 30 },
  usage: {
    uncachedInputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    billedInputTokens: 20,
    totalTokens: 30,
    cacheHitPercent: 50,
  },
  stats: {
    turns: 1,
    steps: 2,
    llmMs: 1_000,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 1_000,
    decodeTokens: 10,
    tokensPerSecond: 10,
  },
  permission: 'read-only',
  running: false,
  queue: 0,
  pendingInput: [],
}

test('statusLines mirror the desktop status line and never invent values', async () => {
  const { adapter } = makeAdapter({ statuses: { 'sess-a': STATUS_A } })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    const view = await tui.untilView(
      (view) => view.statusLines?.[1]?.includes('ctx 12%'),
      'status lines from the Host status',
    )
    assert.equal(view.statusLines.length, 2, 'at most two status lines')
    assert.equal(view.model, 'deepseek-flash', 'the view model comes from the projection')
    assert.equal(
      view.statusLines[0],
      'deepseek-flash · high · workspace-write · ready',
      'model + effort + permission + run state',
    )
    assert.equal(
      view.statusLines[1],
      'ctx 12% 24K/200K · 332K tok · cache 88% · 2轮/5步 · 35 tok/s',
      'context percent/values, cumulative tokens, cache, turns/steps, speed',
    )
    assert.doesNotMatch(view.statusLines[1], /\$|费用|cost/, 'the desktop has no cost row to copy')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('a Host without /local-cli/status degrades to — and chat keeps working', async () => {
  const { adapter, requests } = makeAdapter({
    fetchStatus: async () => {
      throw new Error('status unavailable (the Host may be older than this CLI)')
    },
  })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    const view = await tui.untilView(
      (view) => view.statusLines?.[0] === 'ready' && view.statusLines?.[1] === '—',
      'degraded status lines',
    )
    assert.equal(view.statusLines[0], 'ready', 'run state remains after the status read fails')
    assert.equal(view.statusLines[1], '—')
    assert.ok(requests.fetchStatus.length >= 1, 'the TUI did try the status endpoint')

    await type(tui, 'still works')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && view.messages.some((message) => message.text.includes('完成')),
      'chat still works after the status failure',
    )

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('a late status response never lands on the Session that was switched to', async () => {
  let releaseA
  const held = new Promise((resolve) => {
    releaseA = resolve
  })
  const { adapter } = makeAdapter({
    fetchStatus: async (sessionId) => {
      if (sessionId === 'sess-a') {
        await held
        return { ok: true, sessionId, status: STATUS_A }
      }
      return { ok: true, sessionId, status: STATUS_B }
    },
  })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await pickerSwitchTo(tui, 'sess-b')
    await tui.untilView(
      (view) => view.sessionId === 'sess-b' && view.statusLines?.[1]?.includes('ctx 30%'),
      'status B after the switch',
    )
    releaseA()
    await sleep(20)
    const view = tui.last()
    assert.equal(view.sessionId, 'sess-b')
    assert.match(view.statusLines[1], /ctx 30% 60K\/200K/)
    assert.doesNotMatch(view.statusLines[1], /ctx 12%/, 'the late A response never surfaces on B')
    assert.equal(view.model, 'deepseek-pro')

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('status refreshes on Session load and again after a turn', async () => {
  const { adapter, requests } = makeAdapter({ statuses: { 'sess-a': STATUS_A } })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.untilView((view) => view.statusLines?.[1]?.includes('35 tok/s'), 'initial status')
    const before = requests.fetchStatus.length
    assert.ok(before >= 1, 'load refreshes the status once')

    await type(tui, 'hi')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.status === 'ready' && view.messages.some((message) => message.text.includes('完成')),
      'turn end',
    )
    await until(() => requests.fetchStatus.length > before, { label: 'post-turn status refresh' })

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})

test('/status prints the detailed white-listed status fields', async () => {
  const { adapter } = makeAdapter({ statuses: { 'sess-a': STATUS_A } })
  const tui = boot(adapter)
  try {
    await pickSession(tui, 'sess-a')
    await tui.untilView((view) => view.statusLines?.[1]?.includes('ctx 12%'), 'status loaded')

    await type(tui, '/status')
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (view) => view.messages.some((message) => message.text.includes('context     12%')),
      '/status detail',
    )
    const text = view.messages.map((message) => message.text).join('\n')
    assert.match(text, /model       deepseek \/ deepseek-flash · effort high/)
    assert.match(text, /context     12% · 24K \/ 200K tokens/)
    assert.match(text, /tokens      in 39840 · out 160 · cache read 291840 · cache write 160 · total 332000 · cache hit 88%/)
    assert.match(text, /stats       2 turns · 5 steps · 累计 LLM 12\.3s · tool 900ms · ttft avg 800ms · decode 9\.4s · 35 tok\/s/)
    assert.match(text, /permission  workspace-write/)
    assert.match(text, /queue       0 queued · pending none/)
    assert.doesNotMatch(text, /\$|cost|费用/)

    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
  } finally {
    await stopTui(tui)
  }
})
