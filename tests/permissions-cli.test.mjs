/**
 * End-to-end tests for the `permissions`, `awaiting` and `answer` CLI commands.
 *
 * A local `node:http` server plays the bridge; nothing here talks to the
 * desktop app. The tests assert both the wire request the CLI makes and the
 * explicit refusals: no high-impact preset without --yes, no answer for an open
 * question, no invented label, and error codes preserved for the TUI adapter.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-permissions-cli-'))

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

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
    requests.push({ method: req.method, path: url.pathname, query: url.search, body })
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

function healthRoute() {
  return ({ res, host }) =>
    json(res, 200, { ok: true, origin: host.origin, pid: 4242, capabilities: {} })
}

async function makeHome() {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
  return home
}

function cliEnv(home) {
  return {
    ...process.env,
    DSH_HOME: home,
    DSH_ASK_LANG: 'en',
    DSH_ASK_NO_START: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  }
}

function runCli(home, origin, args, timeoutMs = 15_000) {
  const subcommands = new Set(['permissions', 'permission', 'awaiting', 'answer'])
  const argv = subcommands.has(args[0])
    ? [args[0], '--no-start', '-u', origin, ...args.slice(1)]
    : ['--no-start', '-u', origin, ...args]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASK, ...argv], {
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
 * Run the CLI with exactly the argv given, so a test can put global flags
 * before the subcommand (the shape that once fell back to a prompt).
 */
function runRaw(home, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASK, ...args], {
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

const PERMISSIONS = {
  ok: true,
  sessionId: 's-1',
  permission: {
    currentValue: 'workspace-write',
    label: 'Workspace write',
    options: [
      { value: 'read-only', name: 'Read only', description: 'No writes' },
      { value: 'workspace-write', name: 'Workspace write', description: 'Write in the workspace' },
      { value: 'danger-full-access', name: 'Full access', description: 'No approval prompts' },
    ],
    defaultPreset: 'workspace-write',
  },
  canSet: true,
  source: 'projections+permissionPresets.catalog',
}

function awaitingPayload() {
  return {
    ok: true,
    sessionId: 's-1',
    running: true,
    pendingInput: ['question'],
    questions: {
      active: [
        {
          callId: 'call-1',
          state: 'continued',
          questions: [
            {
              id: 'q1',
              question: 'Approve the change?',
              options: [{ label: 'Approve' }, { label: 'Reject', description: 'Keep it unchanged' }],
            },
          ],
        },
      ],
      settledCount: 1,
    },
    approvals: { supported: false, present: false, reason: 'confirm in the desktop app' },
    answerable: true,
  }
}

test('permissions prints the current preset and its options', async () => {
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/permissions': ({ res }) => json(res, 200, PERMISSIONS),
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['permissions', 's-1'])
    assert.equal(run.code, 0)
    assert.match(run.stdout, /current\s+workspace-write \(Workspace write\)/)
    assert.match(run.stdout, /presets\s+read-only, workspace-write, danger-full-access/)
    assert.match(run.stdout, /default\s+workspace-write/)
    assert.match(run.stdout, /set\s+available/)

    const asJson = await runCli(home, host.origin, ['permissions', 's-1', '--json'])
    assert.equal(asJson.code, 0)
    assert.equal(JSON.parse(asJson.stdout).permission.currentValue, 'workspace-write')
  } finally {
    await host.close()
  }
})

test('permissions set posts the exact preset with confirmed:false for a normal switch', async () => {
  const requests = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/permissions': ({ res, body }) => {
      requests.push(body)
      json(res, 200, { ok: true, sessionId: 's-1', preset: body.preset, matched: true, text: `preset ${body.preset}` })
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['permissions', 'set', 'read-only', 's-1'])
    assert.equal(run.code, 0)
    assert.match(run.stdout, /preset read-only on s-1/)
    assert.deepEqual(requests, [{ sessionId: 's-1', preset: 'read-only', confirmed: false }])
  } finally {
    await host.close()
  }
})

test('a high-impact preset needs --yes and sends no request without it', async () => {
  const requests = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/permissions': ({ res, body }) => {
      requests.push(body)
      json(res, 200, { ok: true, sessionId: 's-1', preset: body.preset, matched: true, text: `preset ${body.preset}` })
    },
  })
  const home = await makeHome()
  try {
    const denied = await runCli(home, host.origin, ['permissions', 'set', 'danger-full-access', 's-1'])
    assert.equal(denied.code, 2)
    assert.match(denied.stderr, /--yes/)
    assert.equal(requests.length, 0)

    const allowed = await runCli(home, host.origin, ['permissions', 'set', 'danger-full-access', 's-1', '--yes'])
    assert.equal(allowed.code, 0)
    assert.deepEqual(requests, [{ sessionId: 's-1', preset: 'danger-full-access', confirmed: true }])
  } finally {
    await host.close()
  }
})

test('bridge error codes are preserved for the TUI adapter', async () => {
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/permissions': ({ res }) =>
      json(res, 409, { ok: false, code: 'confirmation-required', error: 'needs an explicit decision' }),
    'GET /local-cli/permissions': ({ res }) =>
      json(res, 409, { ok: false, code: 'no-such-session', error: 'no Session matches "nope"' }),
  })
  const home = await makeHome()
  try {
    const denied = await runCli(home, host.origin, ['permissions', 'set', 'danger-full-access', 's-1', '--yes'])
    assert.equal(denied.code, 1)
    assert.match(denied.stderr, /confirmation-required: needs an explicit decision/)

    const unknown = await runCli(home, host.origin, ['permissions', 'nope'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.stderr, /no-such-session: no Session matches "nope"/)
  } finally {
    await host.close()
  }
})

test('an older Host without the route says so instead of guessing', async () => {
  // A Host predating the route answers 404 without a JSON body; the CLI must
  // translate that into an upgrade hint instead of guessing a permission.
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/permissions': ({ res }) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['permissions', 's-1'])
    assert.equal(run.code, 1)
    assert.match(run.stderr, /older than this CLI/)
  } finally {
    await host.close()
  }
})

test('awaiting lists a continued question with its offered labels', async () => {
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, awaitingPayload()),
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['awaiting', 's-1'])
    assert.equal(run.code, 0)
    assert.match(run.stdout, /call-1\s+continued/)
    assert.match(run.stdout, /Approve the change\?/)
    assert.match(run.stdout, /options: Approve \| Reject/)
    assert.match(run.stdout, /pending question/)

    const asJson = await runCli(home, host.origin, ['awaiting', 's-1', '--json'])
    assert.equal(asJson.code, 0)
    assert.equal(JSON.parse(asJson.stdout).questions.active[0].callId, 'call-1')
  } finally {
    await host.close()
  }
})

test('answer posts exactly the labels the user chose', async () => {
  const posts = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, awaitingPayload()),
    'POST /local-cli/answer': ({ res, body }) => {
      posts.push(body)
      json(res, 200, {
        ok: true,
        sessionId: 's-1',
        callId: body.callId,
        accepted: true,
        source: 'userQuestions/answer',
      })
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, [
      'answer',
      's-1',
      'call-1',
      '--select',
      'q1=Reject',
    ])
    assert.equal(run.code, 0)
    assert.match(run.stdout, /answered call-1 \(1 question\)/)
    assert.deepEqual(posts, [
      { sessionId: 's-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Reject'] }] },
    ])
  } finally {
    await host.close()
  }
})

test('answer refuses an unknown label before any request is sent', async () => {
  const posts = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, awaitingPayload()),
    'POST /local-cli/answer': ({ res }) => {
      posts.push(1)
      json(res, 200, { ok: true })
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['answer', 's-1', 'call-1', '--select', 'q1=Maybe'])
    assert.equal(run.code, 2)
    assert.match(run.stderr, /not offered/)
    assert.equal(posts.length, 0)
  } finally {
    await host.close()
  }
})

test('answer refuses an open question and does not submit', async () => {
  const payload = awaitingPayload()
  payload.questions.active[0].state = 'open'
  const posts = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, payload),
    'POST /local-cli/answer': ({ res }) => {
      posts.push(1)
      json(res, 200, { ok: true })
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['answer', 's-1', 'call-1', '--select', 'q1=Approve'])
    assert.equal(run.code, 1)
    assert.match(run.stderr, /not-answerable/)
    assert.equal(posts.length, 0)
  } finally {
    await host.close()
  }
})

test('answer needs an explicit choice for every question of the batch', async () => {
  const posts = []
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, awaitingPayload()),
    'POST /local-cli/answer': ({ res }) => {
      posts.push(1)
      json(res, 200, { ok: true })
    },
  })
  const home = await makeHome()
  try {
    const run = await runCli(home, host.origin, ['answer', 's-1', 'call-1', '--skip', 'q1'])
    assert.equal(run.code, 0)
    const missing = await runCli(home, host.origin, ['answer', 's-1', 'call-1'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /--select/)
    assert.equal(posts.length, 1)
  } finally {
    await host.close()
  }
})

test('global flags before the subcommand still dispatch instead of prompting', async () => {
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/permissions': ({ res }) => json(res, 200, PERMISSIONS),
    'GET /local-cli/awaiting': ({ res }) => json(res, 200, awaitingPayload()),
    'POST /local-cli/ask': ({ res }) => json(res, 200, { ok: true, sessionId: 's-1', text: 'prompt!' }),
    'POST /local-cli/stream': ({ res }) => json(res, 200, { ok: true, sessionId: 's-1', text: 'prompt!' }),
  })
  const home = await makeHome()
  try {
    // The exact shape that once created a Session and prompted the words
    // "permissions <session>". It must now be a read-only permissions GET.
    const permissions = await runRaw(home, ['-u', host.origin, '--no-start', '--json', 'permissions', 's-1'])
    assert.equal(permissions.code, 0)
    assert.equal(JSON.parse(permissions.stdout).permission.currentValue, 'workspace-write')

    const awaiting = await runRaw(home, ['-u', host.origin, '--no-start', '--json', 'awaiting', 's-1'])
    assert.equal(awaiting.code, 0)
    assert.equal(JSON.parse(awaiting.stdout).questions.active[0].callId, 'call-1')

    const asked = host.requests.filter((request) => request.path.startsWith('/local-cli/ask'))
    const streamed = host.requests.filter((request) => request.path.startsWith('/local-cli/stream'))
    assert.deepEqual(asked, [], 'a permission command must never submit a prompt')
    assert.deepEqual(streamed, [], 'a permission command must never submit a prompt')
    assert.equal(
      host.requests.some((request) => request.path === '/local-cli/create'),
      false,
      'a permission command must never create a Session',
    )
  } finally {
    await host.close()
  }
})

test('a bare `--` forces a literal prompt instead of a subcommand', async () => {
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/ask': ({ res, body }) =>
      json(res, 200, { ok: true, sessionId: 's-1', text: `echo:${body?.text ?? ''}` }),
  })
  const home = await makeHome()
  try {
    const run = await runRaw(home, [
      '-u',
      host.origin,
      '--no-start',
      '--json',
      '--no-stream',
      '--',
      'permissions',
    ])
    assert.equal(run.code, 0)
    const ask = host.requests.find((request) => request.path === '/local-cli/ask')
    assert.equal(ask?.body?.text, 'permissions')
  } finally {
    await host.close()
  }
})
