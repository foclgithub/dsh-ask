/**
 * Protocol tests for the native UI adapter (`dsh-native-screen.mjs`).
 *
 * These spawn tests/fixtures/fake-native-ui.mjs, a Node process that speaks the
 * real fd3/fd4 contract without a TTY. Nothing here needs a built Rust binary:
 * the contract is what the adapter must uphold, so the test double behaves like
 * the real `dsh-ask-ui` (ready on start, renders in on fd3, keys out on fd4,
 * exit on stop / EOF). A separate test uses the real binary when it is built.
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import {
  BINARY_ENV,
  MAX_FD4_LINE,
  NativeScreenUnavailable,
  binaryCandidates,
  createScreen,
  nativeUnavailableMessage,
  resolveNativeBinary,
} from '../dsh-native-screen.mjs'
import { resolveScreenFactory } from '../dsh-tui.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fixtures', 'fake-native-ui.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-native-screen-test-'))
const REAL = join(HERE, '..', 'native', 'bin', 'dsh-ask-ui')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, { label = 'condition', timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(5)
  }
}

let logPath
let logIndex = 0
before(async () => {
  await chmod(FAKE, 0o755)
})
after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

/** A fresh log file plus the env object a screen needs to find the test double. */
function harness(extraEnv = {}) {
  logIndex += 1
  logPath = join(ROOT, `ui-${logIndex}.log`)
  return {
    logPath,
    env: { ...process.env, [BINARY_ENV]: FAKE, FAKE_UI_LOG: logPath, ...extraEnv },
  }
}

async function readLog() {
  if (existsSync(logPath) !== true) return []
  const raw = await readFile(logPath, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

function captureScreen(env) {
  const events = []
  const screen = createScreen({
    onKey: (str, key) => events.push({ kind: 'key', str, key }),
    onResize: (size) => events.push({ kind: 'resize', size }),
    onError: (message) => events.push({ kind: 'error', message }),
    env,
  })
  return { screen, events }
}

test('binary resolution honours the exclusivity of DSH_ASK_UI_BINARY', () => {
  const env = harness().env
  assert.equal(resolveNativeBinary({ env }).path, FAKE)
  // A set-but-missing override must not fall through to a sibling build.
  const broken = { ...env, [BINARY_ENV]: join(ROOT, 'missing-binary') }
  assert.equal(resolveNativeBinary({ env: broken }), null)
  const message = nativeUnavailableMessage({ env: broken })
  assert.match(message, /DSH_ASK_UI_BINARY=.*missing-binary/)
  assert.match(message, /--plain/)
  // The stable, generic message points at the packaging entry point.
  const generic = nativeUnavailableMessage({ env: { PATH: process.env.PATH } })
  assert.match(generic, /scripts\/build-ui\.sh/)
  assert.match(generic, /native\/bin\/dsh-ask-ui/)
})

test('candidate order: installed sibling first, then source native/bin', () => {
  const env = { PATH: process.env.PATH }
  const candidates = binaryCandidates(env)
  assert.equal(candidates.length, 2)
  assert.match(candidates[0].path, /dsh-ask-ui$/)
  assert.doesNotMatch(candidates[0].path, /native/)
  assert.match(candidates[1].path, /native\/bin\/dsh-ask-ui$/)
})

test('a missing binary fails with a typed, explicit error (CLI falls back to --plain)', () => {
  const env = { ...process.env, [BINARY_ENV]: join(ROOT, 'nope') }
  assert.throws(
    () => createScreen({ onKey: () => {}, env }),
    (error) => {
      assert.ok(error instanceof NativeScreenUnavailable)
      assert.equal(error.code, 'native-ui-unavailable')
      assert.match(error.message, /not found|not an executable file/)
      return true
    },
  )
})

test('start/render/stop: renders reach fd3, keys and resize reach the parent, child is reaped', async (t) => {
  const { env } = harness({
    FAKE_UI_EMIT: JSON.stringify([
      { type: 'key', str: 'a', key: { name: 'a', ctrl: false, meta: false, shift: false, sequence: 'a' } },
      { type: 'key', str: '\u001b', key: { name: 'escape' } },
      { type: 'key', str: 'hello', key: { name: 'paste' } },
      { type: 'resize', columns: 123, rows: 45 },
    ]),
  })
  const { screen, events } = captureScreen(env)
  t.after(() => screen.stop().catch(() => {}))
  screen.start()
  screen.render({ project: 'p', input: '/', inputCursor: 1, modal: { kind: 'commands', items: [] } })
  await until(() => events.some((event) => event.kind === 'key' && event.str === 'a'), { label: 'first key' })
  await until(() => events.some((event) => event.kind === 'resize'), { label: 'resize' })
  const keys = events.filter((event) => event.kind === 'key')
  assert.deepEqual(
    keys.map((event) => event.str),
    ['a', '\u001b', 'hello'],
  )
  assert.equal(keys[2].key.name, 'paste')
  const sizes = events.filter((event) => event.kind === 'resize').map((event) => event.size)
  assert.ok(
    sizes.some((size) => size.columns === 123 && size.rows === 45),
    `the emitted resize must reach onResize: ${JSON.stringify(sizes)}`,
  )

  const renders = (await readLog()).filter((message) => message.type === 'render')
  assert.ok(renders.length >= 1)
  assert.equal(renders.at(-1).view.project, 'p')
  assert.equal(renders.at(-1).view.modal.kind, 'commands')

  const start = Date.now()
  assert.equal(await screen.stop(), true)
  assert.ok(Date.now() - start < 2500, 'stop must reap the child without waiting for SIGKILL')
  const log = await readLog()
  assert.deepEqual(log.at(-1), { type: 'stop' })
  // stop() is idempotent and resolves the same promise.
  assert.equal(await screen.stop(), true)
})

test('render coalescing keeps the newest view and never drops into stdout', async (t) => {
  const { env } = harness()
  const { screen, events } = captureScreen(env)
  t.after(() => screen.stop().catch(() => {}))
  screen.start()
  for (let index = 0; index < 40; index += 1) {
    screen.render({ project: `p${index}`, messages: [], input: '', inputCursor: 0, modal: null })
  }
  // Give the coalescing loop time to drain everything it accepted.
  await sleep(200)
  const renders = (await readLog()).filter((message) => message.type === 'render')
  assert.ok(renders.length <= 40, 'coalescing must never exceed one render per call')
  assert.equal(renders.at(-1).view.project, 'p39', 'the newest view must win')
  assert.equal(events.filter((event) => event.kind === 'error').length, 0)
  await screen.stop()
})

test('malformed and oversized fd4 lines are ignored, never fatal', async (t) => {
  const { env } = harness({ FAKE_UI_GARBAGE: '1' })
  const { screen, events } = captureScreen(env)
  t.after(() => screen.stop().catch(() => {}))
  screen.start()
  await sleep(150)
  assert.equal(events.filter((event) => event.kind === 'error').length, 0)
  // The protocol line cap is a defensive constant, not a rendering limit.
  assert.equal(MAX_FD4_LINE, 256 * 1024)
  screen.render({ project: 'after-garbage', messages: [], input: '', inputCursor: 0, modal: null })
  await sleep(100)
  assert.equal(events.filter((event) => event.kind === 'error').length, 0)
  await screen.stop()
})

test('a child that dies unexpectedly reports one fatal error instead of hanging', async (t) => {
  const { env } = harness({ FAKE_UI_EXIT_AFTER_MS: '40' })
  const { screen, events } = captureScreen(env)
  t.after(() => screen.stop().catch(() => {}))
  screen.start()
  await until(() => events.some((event) => event.kind === 'error'), { label: 'fatal error', timeoutMs: 4000 })
  const errors = events.filter((event) => event.kind === 'error')
  assert.equal(errors.length, 1, 'only one fatal error is reported')
  assert.match(errors[0].message, /exited unexpectedly/)
  // stop() on an already-dead child still settles cleanly.
  assert.equal(await screen.stop(), true)
})

test('stop escalates to SIGKILL when the child ignores the stop message', async (t) => {
  const { env } = harness({ FAKE_UI_NO_STOP_ACK: '1' })
  const { screen, events } = captureScreen(env)
  t.after(() => screen.stop().catch(() => {}))
  screen.start()
  screen.render({ project: 'x', messages: [], input: '', inputCursor: 0, modal: null })
  await sleep(100)
  const start = Date.now()
  assert.equal(await screen.stop(), true)
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 1900, `SIGTERM grace should run first (took ${elapsed}ms)`)
  assert.ok(elapsed < 6000, `SIGKILL backstop must end the wait (took ${elapsed}ms)`)
  assert.equal(events.filter((event) => event.kind === 'error').length, 0, 'a requested stop is not an error')
})

test('the real built binary renders the integrated views and stops cleanly', async (t) => {
  if (existsSync(REAL) !== true) {
    t.skip('native/bin/dsh-ask-ui is not built yet (scripts/build-ui.sh)')
    return
  }
  const screen = createScreen({
    onKey: () => {},
    onResize: () => {},
    onError: (message) => {
      throw new Error(`real native UI reported ${message}`)
    },
    env: { ...process.env, [BINARY_ENV]: REAL },
  })
  screen.start()
  // Send the same view shapes the business layer produces, including the
  // commands popup (kind commands) and the sessions page, so the real renderer
  // is exercised against the integrated contract rather than a stub.
  screen.render({
    project: 'real',
    cwd: '/tmp',
    sessionTitle: 't',
    sessionId: 's',
    model: 'unknown',
    status: 'ready',
    messages: [{ role: 'assistant', text: '• hello' }],
    input: '/re',
    inputCursor: 3,
    attachments: [],
    hint: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
    scrollOffset: 0,
    modal: {
      kind: 'commands',
      title: '',
      items: [
        { label: '/resume', detail: '恢复会话' },
        { label: '/new', detail: '新建会话' },
      ],
      selected: 0,
      query: '/re',
      footer: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
    },
  })
  await sleep(120)
  screen.render({
    project: 'real',
    cwd: '/tmp',
    sessionTitle: 't',
    sessionId: 's',
    model: 'unknown',
    status: 'ready',
    messages: [],
    input: '',
    inputCursor: 0,
    attachments: [],
    hint: '↑↓ 选择 · Enter 恢复 · 输入过滤 · Esc 新建会话 · Ctrl+C 退出',
    scrollOffset: 0,
    modal: {
      kind: 'sessions',
      title: '选择会话',
      items: [{ label: '新建当前目录会话', detail: '/tmp' }],
      selected: 0,
      query: '',
      footer: '↑↓ 选择 · Enter 恢复 · 输入过滤 · Esc 新建会话 · Ctrl+C 退出',
    },
  })
  await sleep(300)
  assert.equal(await screen.stop(), true)
})


test('resolveScreenFactory defaults to the native adapter and fails explicitly when it is missing', async () => {
  const previous = process.env[BINARY_ENV]
  try {
    process.env[BINARY_ENV] = FAKE
    const create = await resolveScreenFactory()
    assert.equal(typeof create, 'function')
    // It is the native adapter, not the old in-process renderer: its screens
    // declare terminal ownership and expose the resolved binary.
    const screen = create({ onKey: () => {}, env: process.env })
    assert.equal(screen.ownsTerminal, true)
    assert.equal(screen.binary.path, FAKE)
    await screen.stop()

    process.env[BINARY_ENV] = join(ROOT, 'definitely-missing')
    await assert.rejects(resolveScreenFactory(), (error) => {
      assert.equal(error.code, 'native-ui-unavailable')
      assert.match(error.message, /not found|not an executable file/)
      assert.match(error.message, /--plain/)
      return true
    })
  } finally {
    if (previous === undefined) delete process.env[BINARY_ENV]
    else process.env[BINARY_ENV] = previous
  }
})
