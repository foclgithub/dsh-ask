/**
 * Interactive-startup tests: the connect picker's "new conversation" entry and
 * the workspace-by-cwd flow it starts.
 *
 * dsh-ask is spawned as a real subprocess; a `--import` preload flips
 * `process.stdin.isTTY` so the production picker path runs while input arrives
 * over a pipe (no PTY required). A local `node:http` server plays the loopback
 * bridge, exactly like tests/cli.test.mjs, so nothing touches the desktop app.
 *
 * Covered here: workspace reuse vs creation by normalized absolute path, a
 * same-name directory that must not be chosen, an empty Session list, EOF and
 * Ctrl+C cancellation (no Session may be created), choosing an existing
 * Session, --cwd override, and an explicit -w that must not be replaced by the
 * cwd.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
const FAKE_TTY = join(HERE, 'fixtures', 'fake-tty.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-connect-ws-'))

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** A loopback bridge double that records every request. */
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

const transcriptRoute = (sessionId) => ({ res }) =>
  json(res, 200, { ok: true, sessionId, running: false, more: false, items: [] })

const queueRoute = (sessionId) => ({ res }) =>
  json(res, 200, { ok: true, sessionId, running: false, items: [] })

function sessionRow(sessionId, title = 'existing conversation') {
  return {
    sessionId,
    title,
    preview: '',
    blank: false,
    running: false,
    updatedAt: Date.now(),
  }
}

async function makeHome() {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
  return home
}

async function makeDir(name) {
  const directory = await mkdtemp(join(ROOT, name))
  return directory
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

/**
 * Drive a real dsh-ask subprocess with a faked TTY stdin. `lines` are written
 * one per readline prompt (the picker question first, then the chat prompt).
 */
function runInteractive(home, origin, args, lines, options = {}) {
  const { timeoutMs = 20_000, onFirstPrompt } = options
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', FAKE_TTY, ASK, ...args, '--no-start', '-u', origin], {
      cwd: home,
      env: cliEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let seen = ''
    let sent = 0
    let firstPrompt = false
    let scheduledEnd = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const prompts = () => (seen.match(/which one\?/g) ?? []).length + (seen.match(/❯ /g) ?? []).length
    const feed = () => {
      const count = prompts()
      if (firstPrompt === false && count > 0) {
        firstPrompt = true
        onFirstPrompt?.(child)
      }
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
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

/** Run dsh-ask with stdin closed (the ordinary non-interactive path). */
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

const createRequests = (host) => host.requests.filter((entry) => entry.path === '/local-cli/create')

test('picker: Enter reuses the workspace whose normalized path is the cwd, never a same-name directory', async () => {
  const home = await makeHome()
  const cwd = realpathSync(home)
  const decoy = join(ROOT, 'decoy', basename(home))
  const workspaces = [
    { id: 'w-decoy', title: 'decoy', path: decoy, sessions: 0 },
    { id: 'w-home', title: 'home', path: cwd, sessions: 2 },
  ]
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute(workspaces),
    'GET /local-cli/queue': queueRoute('s-new'),
    'POST /local-cli/create': ({ res }) =>
      json(res, 200, {
        ok: true,
        sessionId: 's-new',
        created: false,
        workspace: workspaces[1],
      }),
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], ['', '/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)

    // The list states the new-conversation entry in the requested words.
    assert.match(result.stdout, /Enter \/ n for a new conversation in this directory/)
    assert.match(result.stdout, /which one\?/)
    assert.match(result.stdout, /\(reused\)/)

    const creates = createRequests(host)
    assert.equal(creates.length, 1)
    assert.equal(creates[0].body.workspace, 'w-home', 'must pick the full-path match, not the same basename')
    assert.notEqual(creates[0].body.workspace, 'w-decoy')
    assert.equal(creates[0].body.createWorkspace, false)
    assert.equal(creates[0].body.cwd, undefined)
    // A new Session has no history to print.
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/transcript').length, 0)
    assert.match(result.stdout, /s-new/)
  } finally {
    await host.close()
  }
})

test('picker: creates a workspace when no workspace matches the effective cwd', async () => {
  const home = await makeHome()
  const cwd = realpathSync(home)
  const workspaces = [{ id: 'w-other', title: 'other', path: join(ROOT, 'not-this-one'), sessions: 0 }]
  let createBody
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute(workspaces),
    'GET /local-cli/queue': queueRoute('s-new'),
    'POST /local-cli/create': ({ res, body }) => {
      createBody = body
      json(res, 200, {
        ok: true,
        sessionId: 's-new',
        created: true,
        workspace: { id: 'w-new', title: basename(home), path: cwd, sessions: 0 },
      })
    },
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], ['', '/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /\(created\)/)
    assert.equal(createBody.workspace, cwd, 'the workspace is registered under the normalized absolute cwd')
    assert.equal(createBody.createWorkspace, true)
    assert.equal(createBody.cwd, undefined)
  } finally {
    await host.close()
  }
})

test('picker: an empty Session list starts the new conversation without asking or failing', async () => {
  const home = await makeHome()
  const cwd = realpathSync(home)
  let createBody
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([]),
    'GET /local-cli/workspaces': workspacesRoute([]),
    'GET /local-cli/queue': queueRoute('s-first'),
    'POST /local-cli/create': ({ res, body }) => {
      createBody = body
      json(res, 200, {
        ok: true,
        sessionId: 's-first',
        created: true,
        workspace: { id: 'w-first', title: basename(home), path: cwd, sessions: 0 },
      })
    },
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], ['/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.doesNotMatch(result.stdout, /which one\?/, 'there is nothing to pick, so no question is asked')
    assert.doesNotMatch(result.stdout, /no Sessions yet - run/)
    assert.match(result.stdout, /no Sessions yet/)
    assert.match(result.stdout, /new conversation/)
    assert.equal(createRequests(host).length, 1)
    assert.equal(createBody.workspace, cwd)
    assert.equal(createBody.createWorkspace, true)
  } finally {
    await host.close()
  }
})

test('picker: EOF at the question exits without creating a Session', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute([]),
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], [], {
      onFirstPrompt: (child) => child.stdin.end(),
    })
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /nothing picked/)
    assert.doesNotMatch(result.stdout, /^new conversation /m)
    assert.equal(createRequests(host).length, 0, 'EOF must never fall through to creation')
  } finally {
    await host.close()
  }
})

test('picker: Ctrl+C at the question exits without creating a Session', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute([]),
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], [], {
      onFirstPrompt: (child) => child.kill('SIGINT'),
    })
    assert.equal(result.timedOut, false)
    assert.equal(createRequests(host).length, 0, 'Ctrl+C must never fall through to creation')
  } finally {
    await host.close()
  }
})

test('picker: choosing an existing Session keeps the old behavior', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old', 'old conversation')]),
    'GET /local-cli/transcript': transcriptRoute('s-old'),
    'GET /local-cli/queue': queueRoute('s-old'),
  })
  try {
    const result = await runInteractive(home, host.origin, ['connect'], ['1', '/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.equal(createRequests(host).length, 0)
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/transcript').length, 1)
    assert.match(result.stdout, /s-old/)
    assert.doesNotMatch(result.stdout, /^new conversation /m)
  } finally {
    await host.close()
  }
})

test('picker: --cwd overrides the process cwd when resolving the workspace', async () => {
  const home = await makeHome()
  const override = await makeDir('override-')
  await mkdir(join(override, 'nested'))
  const workspaces = [
    { id: 'w-home', title: 'home', path: realpathSync(home), sessions: 0 },
    { id: 'w-override', title: 'override', path: realpathSync(override), sessions: 0 },
  ]
  let createBody
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute(workspaces),
    'GET /local-cli/queue': queueRoute('s-new'),
    'POST /local-cli/create': ({ res, body }) => {
      createBody = body
      json(res, 200, { ok: true, sessionId: 's-new', created: false, workspace: workspaces[1] })
    },
  })
  try {
    // A dot-segment path still names the same directory once normalized.
    const result = await runInteractive(
      home,
      host.origin,
      ['connect', '--cwd', join(override, 'nested', '..')],
      ['', '/exit'],
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.equal(createBody.workspace, 'w-override', '--cwd, not process.cwd, names the workspace')
    assert.equal(createBody.createWorkspace, false)
  } finally {
    await host.close()
  }
})

test('picker: explicit -w wins and is never replaced by the cwd', async () => {
  const home = await makeHome()
  const explicit = join(ROOT, 'explicit-workspace')
  await mkdir(explicit, { recursive: true })
  const resolved = realpathSync(explicit)
  let createBody
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([]),
    'GET /local-cli/workspaces': workspacesRoute([{ id: 'w-home', title: 'home', path: realpathSync(home), sessions: 0 }]),
    'GET /local-cli/queue': queueRoute('s-explicit'),
    'POST /local-cli/create': ({ res, body }) => {
      createBody = body
      json(res, 200, {
        ok: true,
        sessionId: 's-explicit',
        created: false,
        workspace: { id: 'w-explicit', title: 'explicit', path: resolved, sessions: 0 },
      })
    },
  })
  try {
    const result = await runInteractive(
      home,
      host.origin,
      ['connect', '-w', explicit, '--cwd', home],
      ['/exit'],
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.equal(createBody.workspace, explicit, '-w is passed through verbatim')
    assert.equal(createBody.createWorkspace, false)
    assert.equal(createBody.cwd, undefined, 'the cwd must not be substituted for -w')
    // -w does not need the workspace listing.
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/workspaces').length, 0)
    assert.match(result.stdout, /\(reused\)/)
    assert.match(result.stdout, /explicit/)
  } finally {
    await host.close()
  }
})

test('picker: explicit -w together with --create-workspace keeps the flag', async () => {
  const home = await makeHome()
  const newPath = join(ROOT, 'brand-new-workspace')
  let createBody
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([]),
    'GET /local-cli/queue': queueRoute('s-created'),
    'POST /local-cli/create': ({ res, body }) => {
      createBody = body
      json(res, 200, {
        ok: true,
        sessionId: 's-created',
        created: true,
        workspace: { id: 'w-created', title: 'brand new', path: newPath, sessions: 0 },
      })
    },
  })
  try {
    const result = await runInteractive(
      home,
      host.origin,
      ['connect', '-w', newPath, '--create-workspace'],
      ['/exit'],
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.equal(createBody.workspace, newPath)
    assert.equal(createBody.createWorkspace, true)
    assert.match(result.stdout, /\(created\)/)
  } finally {
    await host.close()
  }
})

test('bare dsh-ask with a picker answer starts a conversation (same flow as connect)', async () => {
  const home = await makeHome()
  const cwd = realpathSync(home)
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
    'GET /local-cli/workspaces': workspacesRoute([{ id: 'w-home', title: 'home', path: cwd, sessions: 0 }]),
    'GET /local-cli/queue': queueRoute('s-bare'),
    'POST /local-cli/create': ({ res }) =>
      json(res, 200, {
        ok: true,
        sessionId: 's-bare',
        created: false,
        workspace: { id: 'w-home', title: 'home', path: cwd, sessions: 0 },
      }),
  })
  try {
    const result = await runInteractive(home, host.origin, [], ['n', '/exit'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /Enter \/ n for a new conversation in this directory/)
    const creates = createRequests(host)
    assert.equal(creates.length, 1)
    assert.equal(creates[0].body.workspace, 'w-home')
    assert.match(result.stdout, /s-bare/)
  } finally {
    await host.close()
  }
})

test('non-interactive: connect without a Session still refuses and never creates', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/sessions': sessionsRoute([sessionRow('s-old')]),
  })
  try {
    const result = await runCli(home, host.origin, ['connect'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not a terminal/)
    assert.doesNotMatch(result.stdout, /new conversation/)
    assert.equal(createRequests(host).length, 0, 'piped stdin must not trigger the new-conversation flow')
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/workspaces').length, 0)
  } finally {
    await host.close()
  }
})
