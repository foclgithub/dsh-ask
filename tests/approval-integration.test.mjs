/**
 * Integration tests for the approval-channel bridge assembly (item F).
 *
 * These boot the real bridge plugin (`apply`) against a mocked Host context:
 * no Harness profile, no network, no real approval, no Host reload. They assert
 * the five approval routes are wired, the official transport is not touched
 * before an explicit claim, unload disposes the channel, and the pre-existing
 * health/status behavior is unchanged.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { imageCapabilities } from '../images.js'

// A throwaway DSH_HOME keeps the token/endpoint files out of the real profile.
const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-approval-integration-'))
process.env.DSH_HOME = DSH_HOME

const APPROVAL_PATHS = [
  '/local-cli/approval',
  '/local-cli/approval/claim',
  '/local-cli/approval/heartbeat',
  '/local-cli/approval/release',
  '/local-cli/approval/answer',
]

const ORIGINAL_PATHS = [
  '/local-cli/health',
  '/local-cli/status',
  '/local-cli/sessions',
  '/local-cli/ask',
  '/local-cli/stream',
]

async function waitForToken() {
  const file = join(DSH_HOME, 'local-cli', 'token')
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
  Object.defineProperty(res, 'text', {
    get() {
      return this.chunks.join('')
    },
  })
  return res
}

function makeRequest({ method = 'GET', token, url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {
      'x-local-cli-token': token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/**
 * Mock context with only the services the bridge injects. Approval services are
 * reached lazily through `ctx.get('agents')`, exactly like the real routes.
 */
async function createEnv(options = {}) {
  const routes = new Map()
  const disposers = []
  const sessions = options.sessions ?? ['session-1', 'session-2']
  const liveAgents = options.liveAgents ?? new Set(['session-1'])

  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: (sessionId) => (liveAgents.has(sessionId) ? { id: sessionId } : undefined),
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose ?? (() => {})
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
        return []
      },
    },
    sessionController: {
      async list() {
        return { items: sessions.map((sessionId) => ({ sessionId })) }
      },
      async projections() {
        return { kind: 'sequenced', asOfSeq: 4, values: {} }
      },
      async state() {
        return { cursor: 4, running: false, queue: [], pendingInput: [] }
      },
      async prompt() {},
      async create() {
        throw new Error('integration test never creates a Session')
      },
      async updateQueue() {},
    },
  }

  apply(ctx)
  const token = await waitForToken()
  return { ctx, routes, disposers, token }
}

/** Count and refuse any fetch so an unexpected transport open fails loudly. */
function createNetworkSpy() {
  const original = globalThis.fetch
  const calls = []
  const spy = async (input) => {
    calls.push(String(input))
    throw new Error('integration test must not reach the network')
  }
  globalThis.fetch = spy
  return {
    calls,
    restore() {
      if (globalThis.fetch === spy) globalThis.fetch = original
    },
  }
}

async function call(env, path, { method = 'GET', body, token } = {}) {
  const pathname = path.split('?', 1)[0]
  const handler = env.routes.get(pathname)
  assert.equal(typeof handler, 'function', `route ${pathname} must be registered`)
  const res = makeResponse()
  await handler(makeRequest({ method, token: token ?? env.token, url: path, body }), res)
  const text = res.text
  return { status: res.status, payload: text === '' ? undefined : JSON.parse(text) }
}

async function disposeAll(env) {
  for (const dispose of [...env.disposers].reverse()) await dispose()
}

test('registers the approval routes, adds the explicit capability, and keeps health/status behavior', async () => {
  const network = createNetworkSpy()
  let env
  try {
    env = await createEnv()
    assert.equal(network.calls.length, 0, 'applying the bridge opens no network connection')

    for (const path of APPROVAL_PATHS) {
      assert.equal(env.routes.has(path), true, `${path} must be registered`)
    }
    for (const path of ORIGINAL_PATHS) {
      assert.equal(env.routes.has(path), true, `${path} must stay registered`)
    }

    const unauthorized = await call(env, '/local-cli/health', { token: 'wrong-token' })
    assert.equal(unauthorized.status, 401, 'health still requires the loopback token')

    const health = await call(env, '/local-cli/health')
    assert.equal(health.status, 200)
    assert.equal(health.payload.ok, true)
    assert.equal(health.payload.origin, 'http://127.0.0.1:49188')
    assert.equal(health.payload.node, process.versions.node)
    assert.equal(health.payload.pid, process.pid)
    assert.equal(health.payload.platform, process.platform)
    assert.deepEqual(health.payload.capabilities.images, imageCapabilities(), 'the image capability is unchanged')
    assert.deepEqual(
      health.payload.capabilities.approvalChannel,
      {
        feature: 'approval-channel',
        transport: 'official-node-client',
        routes: APPROVAL_PATHS,
      },
      'health explicitly advertises the approval channel and its routes',
    )

    const missing = await call(env, '/local-cli/status')
    assert.equal(missing.status, 400, 'status keeps its sessionId requirement')
    const status = await call(env, '/local-cli/status?sessionId=session-1')
    assert.equal(status.status, 200)
    assert.equal(status.payload.ok, true)
    assert.equal(status.payload.sessionId, 'session-1')
    assert.equal(typeof status.payload.status, 'object')
    assert.equal(status.payload.status.running, false)

    assert.equal(network.calls.length, 0, 'health/status reads never touch the approval transport')
  } finally {
    network.restore()
    if (env !== undefined) await disposeAll(env)
  }
})

test('creates no transport before a claim; a live claim is the first transport entry', async () => {
  const network = createNetworkSpy()
  let env
  try {
    env = await createEnv()

    const idle = await call(env, '/local-cli/approval')
    assert.equal(idle.status, 200)
    assert.equal(idle.payload.claim, null)
    assert.equal(idle.payload.connected, false)
    assert.deepEqual(idle.payload.pending, [])
    assert.equal(network.calls.length, 0, 'reading the unclaimed channel opens no connection')

    // No live Agent: refused by the route before the channel/transport is used.
    const notLive = await call(env, '/local-cli/approval/claim', {
      method: 'POST',
      body: { sessionId: 'session-2' },
    })
    assert.equal(notLive.status, 409)
    assert.equal(notLive.payload.code, 'session-not-live')
    assert.equal(network.calls.length, 0)

    // A live claim is the first path into the transport. This mocked Host has
    // no official runtime modules, so the open fails closed without network.
    const attempted = await call(env, '/local-cli/approval/claim', {
      method: 'POST',
      body: { sessionId: 'session-1' },
    })
    assert.equal(attempted.payload.ok, false, 'the transport open must fail closed here')
    assert.equal(network.calls.length, 0, 'no /connect or RPC may happen in this mocked Host')

    const after = await call(env, '/local-cli/approval')
    assert.equal(after.payload.claim, null, 'a failed transport open leaves no active claim')
    assert.equal(network.calls.length, 0)
  } finally {
    network.restore()
    if (env !== undefined) await disposeAll(env)
  }
})

test('plugin unload unregisters every route and disposes the channel', async () => {
  const network = createNetworkSpy()
  let env
  try {
    env = await createEnv()
    const claimHandler = env.routes.get('/local-cli/approval/claim')
    const approvalStatusHandler = env.routes.get('/local-cli/approval')
    assert.equal(typeof claimHandler, 'function')
    assert.equal(typeof approvalStatusHandler, 'function')

    await disposeAll(env)

    assert.equal(env.routes.size, 0, 'every route is unregistered on plugin unload')
    assert.equal(network.calls.length, 0)

    // The channel is disposed, not merely detached: the handler captured before
    // unload now fails closed instead of claiming.
    const claimRes = makeResponse()
    await claimHandler(makeRequest({ method: 'POST', token: env.token, body: { sessionId: 'session-1' } }), claimRes)
    assert.equal(claimRes.status, 503)
    assert.equal(JSON.parse(claimRes.text).code, 'channel-disposed')

    // The disposed channel still reports its closed snapshot instead of working.
    const statusRes = makeResponse()
    await approvalStatusHandler(makeRequest({ token: env.token, url: '/local-cli/approval' }), statusRes)
    assert.equal(statusRes.status, 200)
    const snapshot = JSON.parse(statusRes.text)
    assert.equal(snapshot.claim, null)
    assert.deepEqual(snapshot.pending, [])
  } finally {
    network.restore()
  }
})
