/**
 * dsh-native-screen.mjs - Node adapter for the native Rust UI binary `dsh-ask-ui`.
 *
 * The native UI owns the terminal (raw mode, alternate screen, cursor,
 * bracketed paste, SIGWINCH and stdin). This module only:
 *
 *   - locates and spawns the binary;
 *   - forwards every `view` the business layer renders over fd3;
 *   - turns the binary's fd4 JSON lines into `onKey` / `onResize` calls;
 *   - stops the binary and reaps it so no child process is left behind.
 *
 * Process contract (fixed with the Rust side):
 *
 *   spawn(binary, [], { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] })
 *
 *   fd3 (Node -> child), one JSON object per line:
 *     {"type":"render","view":{...}}   render this view (latest wins)
 *     {"type":"stop"}                  restore the terminal and exit 0
 *
 *   fd4 (child -> Node), one JSON object per line:
 *     {"type":"ready"}                                   terminal is owned
 *     {"type":"key","str":"a","key":{"name":"a","ctrl":false,"meta":false,"shift":false,"sequence":"a"}}
 *     {"type":"resize","columns":120,"rows":40}
 *     {"type":"error","message":"..."}
 *
 * The `view` is exactly the object `dsh-tui.mjs` builds; the only addition is
 * `modal.kind` ("commands" | "sessions" | "help"; a renderer without support
 * may treat a missing/unknown kind as "sessions").
 *
 * Failure policy:
 *   - No usable binary at creation time: throws NativeScreenUnavailable so the
 *     CLI can fall back to the line-based `--plain` UI with a clear message.
 *   - The child dies or the protocol breaks while running: reports through
 *     `onError` exactly once; the business layer exits instead of hanging on a
 *     dead terminal.
 *   - stop() sends {"type":"stop"}, waits for the child, then escalates to
 *     SIGTERM/SIGKILL and resolves only after the process is gone (or killed).
 *
 * Nothing in this module writes to stdout/stderr except a last-resort human
 * diagnostic on stderr when `onError` is missing; the fd protocol lives only on
 * fd3/fd4 so terminal output can never be polluted.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only this variable overrides the binary path; it exists for tests. */
export const BINARY_ENV = 'DSH_ASK_UI_BINARY'

/** Longest single fd4 line accepted from the child (defensive cap). */
export const MAX_FD4_LINE = 256 * 1024

/** Largest render line sent to the child; older messages are dropped first. */
export const MAX_RENDER_BYTES = 8 * 1024 * 1024

const STDIO = ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']
const STOP_GRACE_MS = 2000
const KILL_GRACE_MS = 500

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** Thrown when no native binary is installed; the CLI falls back to --plain. */
export class NativeScreenUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'NativeScreenUnavailable'
    this.code = 'native-ui-unavailable'
  }
}

/**
 * Candidate binary paths in priority order.
 *
 * The environment override is exclusive: when DSH_ASK_UI_BINARY is set it is
 * the only candidate, so a broken test path can never silently fall through to
 * a developer build. Without it: the installed layout puts the binary next to
 * this module, a source checkout keeps it in native/bin/.
 * (An installer may override its own copy variable, DSH_UI_BINARY; the JS
 * runtime deliberately does not read it.)
 */
export function binaryCandidates(env = process.env) {
  const override = typeof env?.[BINARY_ENV] === 'string' ? env[BINARY_ENV].trim() : ''
  if (override !== '') return [{ path: override, source: BINARY_ENV }]
  return [
    { path: join(MODULE_DIR, 'dsh-ask-ui'), source: 'installed-sibling' },
    { path: join(MODULE_DIR, 'native', 'bin', 'dsh-ask-ui'), source: 'source-native-bin' },
  ]
}

function isExecutableFile(path, fs) {
  try {
    const info = fs.statSync(path)
    if (info.isFile() !== true) return false
    fs.accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the native binary.
 *
 * @returns {{path: string, source: string} | null}
 */
export function resolveNativeBinary({ env = process.env, fs = { statSync, accessSync } } = {}) {
  for (const candidate of binaryCandidates(env)) {
    if (isExecutableFile(candidate.path, fs)) return candidate
  }
  return null
}

/** Human-facing explanation used by the CLI before falling back to --plain. */
export function nativeUnavailableMessage({ env = process.env } = {}) {
  const candidates = binaryCandidates(env).map((candidate) => candidate.path)
  const override = typeof env?.[BINARY_ENV] === 'string' && env[BINARY_ENV].trim() !== ''
  const hint = override
    ? `${BINARY_ENV}=${env[BINARY_ENV].trim()} is not an executable file`
    : 'build it with ./scripts/build-ui.sh (it must be executable at one of the paths below)'
  return `native dsh-ask-ui binary not found · ${hint} · tried: ${candidates.join(' , ')} · pass --plain to keep the line-based UI`
}

function clampDimension(value) {
  const number = Number(value)
  if (Number.isFinite(number) !== true || number < 1) return null
  return Math.min(Math.floor(number), 10_000)
}

/**
 * Create the screen adapter. Same `{ start, render, stop }` contract as the
 * in-process renderer, plus an optional `onError(message)` for fatal native
 * failures. `input`/`output` are accepted for contract compatibility but never
 * touched: the child owns stdin/stdout, so the parent must not enable raw mode,
 * attach a keypress decoder or write frames itself.
 */
export function createScreen({
  input,
  output,
  onKey,
  onResize,
  onError,
  env = process.env,
  spawn = spawnProcess,
} = {}) {
  const binary = resolveNativeBinary({ env })
  if (binary === null) throw new NativeScreenUnavailable(nativeUnavailableMessage({ env }))
  // The child inherits the same environment the binary was resolved with; the
  // only difference tests rely on is the DSH_ASK_UI_BINARY override itself.
  const childEnv = env ?? process.env
  if (typeof onKey !== 'function') throw new TypeError('createScreen needs onKey(str, key)')

  // Referenced so the contract stays explicit; the native child owns both ends.
  void input
  void output

  let child = null
  let fd3 = null
  let fd4 = null
  let started = false
  let stopping = false
  let exited = false
  let pending = null
  let writing = false
  let readBuffer = ''
  let stopPromise = null
  let resolveStop = null
  let exitTimer = null
  let killTimer = null
  let failure = ''

  function reportFailure(message) {
    if (failure !== '') return
    failure = message
    if (typeof onError === 'function') {
      try {
        onError(message)
      } catch {
        // The business layer records its own errors.
      }
      return
    }
    try {
      process.stderr.write(`dsh-ask: ${message}\n`)
    } catch {
      // Nothing left to report to.
    }
  }

  function callSafely(callback, ...args) {
    if (typeof callback !== 'function') return
    try {
      const result = callback(...args)
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch(() => {
          // Serialized key handling reports its own failures.
        })
      }
    } catch {
      // A single bad key event must not tear the screen down.
    }
  }

  function encodeRender(view) {
    const base = view !== null && typeof view === 'object' ? view : {}
    const encode = (value) => JSON.stringify({ type: 'render', view: value })
    let line = encode(base)
    if (Buffer.byteLength(line, 'utf8') <= MAX_RENDER_BYTES) return line
    // Defensive cap: drop the oldest messages before giving up the protocol.
    let messages = Array.isArray(base.messages) ? base.messages.slice() : []
    while (messages.length > 0) {
      messages = messages.slice(Math.ceil(messages.length / 2))
      line = encode({ ...base, messages })
      if (Buffer.byteLength(line, 'utf8') <= MAX_RENDER_BYTES) return line
    }
    return encode({ ...base, messages: [], input: '', attachments: [], modal: null })
  }

  function flush() {
    if (!started || stopping || exited || writing || pending === null) return
    if (fd3 === null || fd3.destroyed === true || fd3.writableEnded === true) return
    const line = pending
    pending = null
    writing = true
    try {
      fd3.write(line, () => {
        writing = false
        flush()
      })
    } catch (error) {
      writing = false
      reportFailure(`native UI write failed: ${String(error?.message ?? error)}`)
    }
  }

  function handleProtocolLine(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // A malformed line is ignored: it must never pollute the UI or throw.
      return
    }
    if (message === null || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        return
      case 'key': {
        if (typeof message.str !== 'string') return
        const key = message.key !== null && typeof message.key === 'object' ? message.key : undefined
        callSafely(onKey, message.str, key)
        return
      }
      case 'resize': {
        const columns = clampDimension(message.columns)
        const rows = clampDimension(message.rows)
        if (columns === null || rows === null) return
        callSafely(onResize, { columns, rows })
        return
      }
      case 'error': {
        const detail = typeof message.message === 'string' && message.message !== '' ? message.message : 'unknown error'
        reportFailure(`native UI error: ${detail}`)
        return
      }
      default:
        return
    }
  }

  function onProtocolData(chunk) {
    if (failure !== '') return
    readBuffer += chunk
    let newline = readBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = readBuffer.slice(0, newline)
      readBuffer = readBuffer.slice(newline + 1)
      if (line.length > MAX_FD4_LINE) reportFailure('native UI sent an oversized protocol line')
      else handleProtocolLine(line)
      newline = readBuffer.indexOf('\n')
    }
    if (readBuffer.length > MAX_FD4_LINE) {
      readBuffer = ''
      reportFailure('native UI protocol buffer overflow')
    }
  }

  /**
   * Resolve the reap promise once the child is gone. Called on 'exit' and as a
   * last resort after SIGKILL so a stuck process can never keep the CLI alive.
   */
  function settleStop() {
    if (exitTimer !== null) {
      clearTimeout(exitTimer)
      exitTimer = null
    }
    if (killTimer !== null) {
      clearTimeout(killTimer)
      killTimer = null
    }
    if (resolveStop !== null) {
      const resolve = resolveStop
      resolveStop = null
      resolve(true)
    }
  }

  function onChildExit(code, signal) {
    exited = true
    if (stopping) {
      settleStop()
      return
    }
    const how = signal !== null && signal !== undefined ? `signal ${signal}` : `code ${code}`
    reportFailure(`native UI exited unexpectedly (${how})`)
    settleStop()
  }

  function onChildError(error) {
    if (stopping) return
    reportFailure(`native UI failed to start: ${String(error?.message ?? error)}`)
    settleStop()
  }

  function onParentExit() {
    // Node can only run synchronous work here: make sure the child never
    // outlives the CLI, even if the event loop is torn down mid-stop.
    if (child !== null && exited !== true) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    try {
      fd3?.destroy()
      fd4?.destroy()
    } catch {
      // Streams already closed.
    }
  }

  function start() {
    if (started) return
    let spawned
    try {
      spawned = spawn(binary.path, [], { stdio: STDIO, env: childEnv })
    } catch (error) {
      throw new NativeScreenUnavailable(
        `could not spawn native dsh-ask-ui (${binary.path}): ${String(error?.message ?? error)}`,
      )
    }
    child = spawned
    fd3 = child.stdio?.[3] ?? null
    fd4 = child.stdio?.[4] ?? null
    started = true
    if (fd3 === null || fd4 === null) {
      reportFailure('native UI process is missing the fd3/fd4 plumbing')
      return
    }
    fd3.on('error', (error) => {
      if (stopping !== true) reportFailure(`native UI stdin pipe failed: ${String(error?.message ?? error)}`)
    })
    fd4.setEncoding('utf8')
    fd4.on('data', onProtocolData)
    fd4.on('error', (error) => {
      if (stopping !== true) reportFailure(`native UI stdout pipe failed: ${String(error?.message ?? error)}`)
    })
    child.on('error', onChildError)
    child.on('exit', onChildExit)
    process.once('exit', onParentExit)
  }

  function render(view) {
    if (started !== true || stopping || exited) return
    let line
    try {
      line = `${encodeRender(view)}\n`
    } catch (error) {
      reportFailure(`cannot serialize a view: ${String(error?.message ?? error)}`)
      return
    }
    // Coalescing: only the newest view matters; an older queued frame is
    // dropped instead of growing a buffer while the pipe is backed up.
    pending = line
    flush()
  }

  function beginStop() {
    stopping = true
    stopPromise = new Promise((resolve) => {
      resolveStop = resolve
    })
    if (exited) {
      settleStop()
      return stopPromise
    }
    try {
      if (fd3 !== null && fd3.destroyed !== true && fd3.writableEnded !== true) {
        fd3.write(`${JSON.stringify({ type: 'stop' })}\n`)
        fd3.end()
      }
    } catch {
      // Escalate through the kill path below.
    }
    exitTimer = setTimeout(() => {
      exitTimer = null
      if (exited || child === null) {
        settleStop()
        return
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        killTimer = null
        if (exited !== true && child !== null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }
        settleStop()
      }, KILL_GRACE_MS)
    }, STOP_GRACE_MS)
    return stopPromise
  }

  function stop() {
    if (started !== true) return Promise.resolve(false)
    if (stopping) return stopPromise
    process.removeListener('exit', onParentExit)
    process.once('exit', onParentExit)
    return beginStop()
  }

  return {
    /** The child owns stdin/stdout; the business layer must not pause them. */
    ownsTerminal: true,
    binary,
    start,
    render,
    stop,
  }
}

export default createScreen
