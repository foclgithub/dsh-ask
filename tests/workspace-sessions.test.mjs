/**
 * Tests for workspace-scoped Session filtering.
 *
 * Part 1 drives the real `/local-cli/sessions` route through `apply(ctx)` with
 * fake Host services. Part 2 drives the CLI adapter against a fake HTTP bridge.
 * Nothing here touches the desktop app, a real Session, or a workspace registry.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { apply } from '../index.js'
import { createTuiAdapter } from '../dsh-ask.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-workspace-sessions-'))
process.env.DSH_HOME = await mkdtemp(join(ROOT, 'home-'))

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function waitForToken() {
  const file = join(process.env.DSH_HOME, 'local-cli', 'token')
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const token = (await readFile(file, 'utf8')).trim()
      if (token !== '') return token
    } catch {
      // apply() mints the token asynchronously on first use.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('local-cli token was not created')
}

function makeResponse() {
  const res = {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
      this.ended = true
    },
  }
  Object.defineProperty(res, 'text', { get() { return this.chunks.join('') } })
  return res
}

function makeRequest({ token, url }) {
  return {
    method: 'GET',
    url,
    headers: { 'x-local-cli-token': token },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this },
    async *[Symbol.asyncIterator]() {},
  }
}

async function createEnv({ items = [], workspaces = [] } = {}) {
  const routes = new Map()
  const calls = { create: 0, list: 0 }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    logger() {
      return { warn() {} }
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
      getOrigin() {
        return 'http://127.0.0.1:49188'
      },
    },
    workspaceRegistry: {
      list() {
        return workspaces
      },
      create() {
        calls.create += 1
        return { id: 'created-workspace', path: '/never-created' }
      },
    },
    sessionController: {
      async list() {
        calls.list += 1
        return { items }
      },
      async projections(request) {
        return { values: { title: `title:${request.sessionId}` } }
      },
      async events() {
        return { records: [] }
      },
      async state() {
        return { running: false }
      },
    },
  }
  apply(ctx)
  const token = await waitForToken()
  return { routes, calls, token }
}

async function callSessions(env, query = '') {
  const handler = env.routes.get('/local-cli/sessions')
  assert.equal(typeof handler, 'function', 'sessions route must be registered')
  const res = makeResponse()
  await handler(makeRequest({ token: env.token, url: `/local-cli/sessions${query}` }), res)
  return { res, body: JSON.parse(res.text) }
}

function sessionRow(sessionId, cwd, extra = {}) {
  return { sessionId, cwd, blank: false, running: false, updatedAt: 1, ...extra }
}

/** Fake HTTP Host for adapter-level tests; every request is recorded. */
async function startHttpHost(handler) {
  const requests = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: url.search })
    const payload = await handler({ url })
    res.writeHead(payload.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload.body))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    requests,
    host: { base: origin, token: 'test-token', instance: { capabilities: {} } },
    close: () => new Promise((done) => {
      server.closeAllConnections?.()
      server.close(done)
    }),
  }
}

test('workspace filter finds a Session pushed out of the global top 50', async () => {
  const realDir = join(ROOT, 'work-a')
  const otherDir = join(ROOT, 'other-project')
  await mkdir(realDir, { recursive: true })
  await mkdir(otherDir, { recursive: true })
  const items = []
  for (let index = 0; index < 50; index += 1) items.push(sessionRow(`s-other-${index}`, otherDir))
  items.push(sessionRow('s-target', realDir))
  const env = await createEnv({
    items,
    workspaces: [{ id: 'ws-a', title: 'Project A', path: await realpath(realDir), sessionIds: ['s-target'] }],
  })

  const { res, body } = await callSessions(env, '?workspace=ws-a')
  assert.equal(res.status, 200)
  assert.deepEqual(body.sessions.map((row) => row.sessionId), ['s-target'])
  assert.equal(body.scope.type, 'workspace')
  assert.equal(body.scope.workspace.id, 'ws-a')
  assert.equal(body.scope.workspace.path, await realpath(realDir))
})

test('subagent Sessions never consume list slots', async () => {
  const env = await createEnv({
    items: [
      { sessionId: 'sub-1', origin: 'subagent', cwd: '/x' },
      { sessionId: 'sub-2', origin: 'subagent', cwd: '/x' },
      sessionRow('s-a', '/x'),
      sessionRow('s-b', '/y'),
    ],
  })
  const { body } = await callSessions(env, '?limit=2')
  assert.deepEqual(body.sessions.map((row) => row.sessionId), ['s-a', 's-b'])
  assert.deepEqual(body.scope, { type: 'all' })
})

test('a symlinked alias path matches the same workspace and cwd', async () => {
  const realDir = join(ROOT, 'real-b')
  const aliasDir = join(ROOT, 'alias-b')
  await mkdir(realDir, { recursive: true })
  await symlink(realDir, aliasDir)
  const canonical = await realpath(realDir)
  const env = await createEnv({
    items: [sessionRow('s-alias', canonical)],
    workspaces: [{ id: 'ws-b', title: 'B', path: canonical, sessionIds: ['s-alias'] }],
  })

  const byWorkspace = await callSessions(env, `?workspace=${encodeURIComponent(aliasDir)}`)
  assert.equal(byWorkspace.res.status, 200)
  assert.deepEqual(byWorkspace.body.sessions.map((row) => row.sessionId), ['s-alias'])
  assert.equal(byWorkspace.body.scope.workspace.path, canonical)

  const byCwd = await callSessions(env, `?cwd=${encodeURIComponent(aliasDir)}`)
  assert.equal(byCwd.res.status, 200)
  assert.deepEqual(byCwd.body.sessions.map((row) => row.sessionId), ['s-alias'])
  assert.deepEqual(byCwd.body.scope, { type: 'cwd', cwd: canonical })
})

test('an unknown cwd returns an empty list and creates no workspace', async () => {
  const env = await createEnv({ items: [sessionRow('s-a', '/x')] })
  const missing = join(ROOT, 'does-not-exist')
  const { res, body } = await callSessions(env, `?cwd=${encodeURIComponent(missing)}`)
  assert.equal(res.status, 200)
  assert.deepEqual(body.sessions, [])
  assert.equal(body.scope.type, 'cwd')
  assert.equal(body.scope.cwd, resolve(missing))
  assert.equal(env.calls.create, 0)
})

test('an explicit unknown -w is an error, never a silent global fallback', async () => {
  const env = await createEnv({ items: [sessionRow('s-a', '/x')] })
  const { res, body } = await callSessions(env, '?workspace=no-such-workspace')
  assert.equal(res.status, 404)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'no-such-workspace')
  assert.equal(body.sessions, undefined)
})

test('sessionId lookup ignores the list limit; exact, prefix, ambiguous and missing are distinct', async () => {
  const otherDir = join(ROOT, 'other-c')
  await mkdir(otherDir, { recursive: true })
  const items = []
  for (let index = 0; index < 50; index += 1) items.push(sessionRow(`s-other-${index}`, otherDir))
  items.push(sessionRow('s-target-ctx', otherDir))
  items.push(sessionRow('s-amb-1', otherDir))
  items.push(sessionRow('s-amb-2', otherDir))
  const env = await createEnv({
    items,
    workspaces: [{ id: 'ws-c', title: 'C', path: await realpath(otherDir), sessionIds: ['s-target-ctx'] }],
  })

  const exact = await callSessions(env, '?sessionId=s-target-ctx')
  assert.equal(exact.res.status, 200)
  assert.deepEqual(exact.body.sessions.map((row) => row.sessionId), ['s-target-ctx'])
  assert.equal(exact.body.scope.type, 'session')
  assert.equal(exact.body.scope.sessionId, 's-target-ctx')
  assert.equal(exact.body.scope.workspace.id, 'ws-c')

  const prefix = await callSessions(env, '?sessionId=s-target-ct')
  assert.equal(prefix.res.status, 200)
  assert.deepEqual(prefix.body.sessions.map((row) => row.sessionId), ['s-target-ctx'])

  const ambiguous = await callSessions(env, '?sessionId=s-amb')
  assert.equal(ambiguous.res.status, 409)
  assert.equal(ambiguous.body.code, 'ambiguous-session')

  const missing = await callSessions(env, '?sessionId=s-nope')
  assert.equal(missing.res.status, 404)
  assert.equal(missing.body.code, 'no-such-session')
})

test('query whitelist rejects unknown, repeated, and mutually exclusive filters', async () => {
  const env = await createEnv({ items: [] })
  const cases = [
    '?foo=1',
    '?limit=1&limit=2',
    '?workspace=a&cwd=b',
    '?all=1&workspace=a',
    '?all=yes',
  ]
  for (const query of cases) {
    const { res, body } = await callSessions(env, query)
    assert.equal(res.status, 400, query)
    assert.equal(body.code, 'invalid-query')
  }
})

test('adapter listSessionsScoped marks old Hosts unsupported and forwards filters', async (t) => {
  let mode = 'new'
  const server = await startHttpHost(({ url }) => {
    if (mode === 'old') return { body: { ok: true, sessions: [sessionRow('s-old', '/x')] } }
    return {
      body: {
        ok: true,
        sessions: [sessionRow('s-new', '/x')],
        scope: { type: 'workspace', workspace: { id: 'ws-1', path: '/canonical', title: 'W' } },
      },
    }
  })
  t.after(() => server.close())
  const adapter = createTuiAdapter(server.host, {})

  const fresh = await adapter.listSessionsScoped({ limit: 10, workspace: 'ws-1' })
  assert.equal(fresh.supported, true)
  assert.equal(fresh.scope.type, 'workspace')
  assert.deepEqual(fresh.rows.map((row) => row.sessionId), ['s-new'])
  assert.equal(server.requests[0].query, '?limit=10&workspace=ws-1')

  mode = 'old'
  const old = await adapter.listSessionsScoped({ limit: 10 })
  assert.equal(old.supported, false)
  assert.equal(old.scope, null)
  assert.deepEqual(old.rows.map((row) => row.sessionId), ['s-old'])
})

test('adapter fetchSessionContext uses the session scope and rejects old Hosts', async (t) => {
  let old = false
  const server = await startHttpHost(() => {
    if (old) return { body: { ok: true, sessions: [sessionRow('s-ctx', '/x')] } }
    return {
      body: {
        ok: true,
        sessions: [sessionRow('s-ctx', '/ctx/path')],
        scope: { type: 'session', sessionId: 's-ctx', workspace: { id: 'ws-1', path: '/canonical', title: 'W' } },
      },
    }
  })
  t.after(() => server.close())
  const adapter = createTuiAdapter(server.host, {})

  const context = await adapter.fetchSessionContext('s-ctx')
  assert.deepEqual(context, {
    sessionId: 's-ctx',
    cwd: '/ctx/path',
    workspace: { id: 'ws-1', path: '/canonical', title: 'W' },
  })
  assert.match(server.requests[0].query, /sessionId=s-ctx/)

  old = true
  await assert.rejects(
    adapter.fetchSessionContext('s-ctx'),
    (error) => error.code === 'workspace-scope-unsupported',
  )
})

test('existing listSessions(limit) keeps returning an array and never sends a filter', async (t) => {
  const server = await startHttpHost(() => ({
    body: { ok: true, sessions: [sessionRow('s-1', '/x')], scope: { type: 'all' } },
  }))
  t.after(() => server.close())
  const adapter = createTuiAdapter(server.host, {})

  const rows = await adapter.listSessions(5)
  assert.ok(Array.isArray(rows))
  assert.deepEqual(rows.map((row) => row.sessionId), ['s-1'])
  assert.equal(server.requests[0].query, '?limit=5')
})
