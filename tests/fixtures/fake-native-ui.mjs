#!/usr/bin/env node
/**
 * Fake native UI for protocol tests.
 *
 * Speaks the real dsh-ask-ui fd contract without touching a TTY:
 *   - reads fd3 (render/stop) as newline-delimited JSON;
 *   - writes fd4 (ready/key/resize/error) as newline-delimited JSON;
 *   - appends every received fd3 message to $FAKE_UI_LOG (one JSON line each);
 *   - after the first render, emits the messages from $FAKE_UI_EMIT (JSON array);
 *   - exits 0 on {"type":"stop"} or fd3 EOF.
 *
 * fd3/fd4 are wrapped with net.Socket on purpose: Node 26 on macOS hangs
 * process.exit() when an fs ReadStream is attached to an inherited extra fd
 * (the kqueue poll path), so the real binary's pipes are emulated with sockets
 * here. The Rust side uses plain read()/write() and is unaffected.
 *
 * Knobs: FAKE_UI_GARBAGE=1 writes a malformed fd4 line before ready;
 * FAKE_UI_EXIT_AFTER_MS=nn exits on its own to exercise child death;
 * FAKE_UI_NO_STOP_ACK=1 ignores stop (and EOF) so SIGTERM/SIGKILL escalation runs.
 */
import { appendFileSync } from 'node:fs'
import { Socket } from 'node:net'

const logPath = process.env.FAKE_UI_LOG ?? ''
function log(value) {
  if (logPath === '') return
  appendFileSync(logPath, `${JSON.stringify(value)}\n`)
}

const ignoreStop = process.env.FAKE_UI_NO_STOP_ACK === '1'
// Keep the event loop alive while the parent owns fd3: a socket over fd4 has
// no pending syscall, so without this the process could exit naturally and
// defeat both the child-death and the SIGTERM/SIGKILL tests.
const keepAlive = setInterval(() => {}, 60_000)

const output = new Socket({ fd: 4, readable: false, writable: true })
output.on('error', () => {})
function emit(value) {
  output.write(`${JSON.stringify(value)}\n`)
}

if (process.env.FAKE_UI_GARBAGE === '1') {
  output.write('not json at all\n')
  output.write('{"type":"key","str":"x","key":\n')
}

emit({ type: 'ready' })
emit({ type: 'resize', columns: 100, rows: 30 })

const emitOnFirstRender = (() => {
  const raw = process.env.FAKE_UI_EMIT ?? ''
  if (raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
})()

let rendered = 0
let buffer = ''
const input = new Socket({ fd: 3, readable: true, writable: false })
input.on('error', () => {})
input.setEncoding('utf8')
input.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      message = { type: 'garbage', raw: line }
    }
    log(message)
    if (message !== null && message.type === 'render') {
      rendered += 1
      if (rendered === 1) {
        for (const entry of emitOnFirstRender) emit(entry)
      }
    }
    if (message !== null && message.type === 'stop' && ignoreStop !== true) {
      clearInterval(keepAlive)
      process.exit(0)
    }
    newline = buffer.indexOf('\n')
  }
})
input.on('end', () => {
  if (ignoreStop !== true) {
    clearInterval(keepAlive)
    process.exit(0)
  }
})

if (process.env.FAKE_UI_EXIT_AFTER_MS !== undefined) {
  const delay = Number(process.env.FAKE_UI_EXIT_AFTER_MS) || 10
  setTimeout(() => process.exit(0), delay)
}
