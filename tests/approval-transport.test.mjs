/**
 * Offline tests for the official Node approval transport (item B).
 *
 * Every Host/packages surface is mocked: no real Host, no network, no profile,
 * no real approval. The mocks reproduce the official contract this module
 * depends on: `/connect` 302 + host-only Cookie, the Cordis client tree
 * (`installConnection` + typert registry + gateway Remote `$on`), the Agent
 * Context adapter filter, and the connection state channel.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  ApprovalTransportError,
  createApprovalTransport,
  DEFAULT_CONNECT_TIMEOUT_MS,
  HOST_MODULE_SPECIFIERS,
  loadHostModules,
  TRANSPORT_UNAVAILABLE,
} from '../approval-transport.js'

const ORIGIN = 'http://127.0.0.1:45123'
const SESSION = 'session-a'
const OTHER_SESSION = 'session-b'
const LAUNCH_TOKEN = 'launch-token-abcdef0123456789'
const COOKIE_PAIR = 'dsh-session=v1.abc-def_ghi'
const SET_COOKIE = `${COOKIE_PAIR}; Max-Age=2592000; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict`
const NEXT = Symbol('waterfall-next')

// ---------------------------------------------------------------------------
// Mock Host (public services only)
// ---------------------------------------------------------------------------

function createFakeHost(options = {}) {
  return {
    webServer: {
      getOrigin: () => options.origin ?? ORIGIN,
    },
    connection: {
      authenticatedUrl: (origin) =>
        options.authenticatedUrl ? options.authenticatedUrl(origin) : `${origin}/?token=${LAUNCH_TOKEN}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Mock official client stack (Cordis + connection + typert + gateway)
// ---------------------------------------------------------------------------

class FakeContext {
  constructor(parent = null) {
    this.parent = parent
    // Cordis exposes services provided by any fiber to the shared root registry.
    this.services = parent === null ? new Map() : parent.services
    this.children = []
    this.disposers = []
    this.disposed = false
    this.fiber = { dispose: () => this.disposeTree() }
  }

  get(name) {
    return this.services.get(name)
  }

  provide(name, value) {
    this.services.set(name, value)
    return () => this.services.delete(name)
  }

  effect(fn) {
    const dispose = fn()
    this.disposers.push(dispose)
    return dispose
  }

  async plugin(plugin) {
    const apply = typeof plugin === 'function' ? plugin : plugin?.apply
    if (typeof apply !== 'function') throw new TypeError('fake cordis: invalid plugin')
    const child = new FakeContext(this)
    this.children.push(child)
    await apply(child)
    return child
  }

  async disposeTree() {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children].reverse()) await child.disposeTree()
    for (const dispose of [...this.disposers].reverse()) {
      try {
        await dispose?.()
      } catch {
        // Teardown must not throw.
      }
    }
    if (this.parent === null) this.services.clear()
  }
}

function createFakeConnection({ autoConnect = true } = {}) {
  let snapshot = 'connecting'
  const listeners = new Set()
  const connection = {
    state: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        if (autoConnect && snapshot === 'connecting') {
          queueMicrotask(() => setState('connected'))
        }
        return () => listeners.delete(listener)
      },
    },
    listenerCount: () => listeners.size,
    setState,
  }
  function setState(next) {
    if (snapshot === next) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return connection
}

function createFakeModules(options = {}) {
  const connection = options.connection ?? createFakeConnection(options)
  const captured = {
    connectionOptions: undefined,
    adapterKey: undefined,
    adapter: undefined,
    listener: undefined,
    event: undefined,
    adapterDisposed: false,
    listenerDisposed: false,
    socket: undefined,
  }
  const installConnection = (root, config) => {
    captured.connectionOptions = config
    root.provide('connection', connection)
    return connection
  }
  const typertClient = {
    apply(ctx) {
      ctx.provide('typert', {
        contexts: {
          registerClient(key, adapter) {
            captured.adapterKey = key
            captured.adapter = adapter
            return () => {
              captured.adapterDisposed = true
            }
          },
        },
      })
    },
  }
  const gatewayClient = {
    apply(ctx) {
      ctx.provide('remote', {
        $on(event, listener) {
          captured.event = event
          captured.listener = listener
          return () => {
            captured.listenerDisposed = true
          }
        },
      })
    },
  }
  class FakeWebSocket {
    constructor(url, init) {
      this.url = String(url)
      this.init = init
      captured.socket = this
    }
  }
  return {
    modules: {
      Context: FakeContext,
      installConnection,
      typertClient,
      gatewayClient,
      WebSocket: FakeWebSocket,
      versions: {},
    },
    captured,
    connection,
  }
}

// ---------------------------------------------------------------------------
// connect exchange mock
// ---------------------------------------------------------------------------

function connectResponse({ status = 302, location = './api/remote.mux', setCookie = SET_COOKIE } = {}) {
  const headers = {}
  if (location !== undefined && location !== null) headers.location = location
  if (setCookie !== undefined && setCookie !== null) headers['set-cookie'] = setCookie
  return new Response(null, { status, headers })
}

function createFetchMock(respond = () => connectResponse()) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : String(input)
    calls.push({ url, init })
    if (new URL(url).pathname === '/connect') return respond(url, init)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

// ---------------------------------------------------------------------------
// transport helpers
// ---------------------------------------------------------------------------

async function openTransport(harness, overrides = {}) {
  const fetchMock = overrides.fetchMock ?? createFetchMock()
  const host = overrides.host ?? createFakeHost(overrides.hostOptions)
  const transport =
    overrides.transport ??
    createApprovalTransport({
      host,
      modules: harness.modules,
      fetch: fetchMock.fetch,
      connectTimeoutMs: overrides.connectTimeoutMs ?? 1000,
      ...overrides.transportOptions,
    })
  const requests = []
  const disconnects = []
  const prompt = overrides.prompt
  const onRequest =
    overrides.onRequest ??
    ((request) => {
      requests.push(request)
      return prompt ? prompt.promise : (overrides.outcome ?? 'allowed-once')
    })
  const handle = await transport({
    sessionId: overrides.sessionId ?? SESSION,
    onRequest,
    onDisconnect: (reason) => disconnects.push(reason),
  })
  return { handle, transport, host, fetchMock, calls: fetchMock.calls, requests, disconnects }
}

function makeNext() {
  let calls = 0
  return {
    next: () => {
      calls += 1
      return NEXT
    },
    calls: () => calls,
  }
}

/** Reproduce the gateway Client's delivery: adapter filter first, then listener. */
async function deliver(captured, { agentId = SESSION, request = {}, next = makeNext() } = {}) {
  const resolved = captured.adapter?.resolve(agentId)
  if (resolved === undefined) {
    return { result: await next.next(), nextCalls: 1 }
  }
  const result = await captured.listener.call(resolved, { ...request, agent: resolved }, next.next)
  return { result, nextCalls: next.calls() }
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ApprovalTransportError, `expected ApprovalTransportError, got ${error?.name}`)
    assert.equal(error.code, code)
    return true
  }
}

function assertRedacted(error, secrets = [LAUNCH_TOKEN, COOKIE_PAIR, ORIGIN, 'api/remote.mux']) {
  for (const secret of secrets) {
    assert.ok(!error.message.includes(secret), `error message leaked ${secret}`)
  }
}

// ---------------------------------------------------------------------------
// identity exchange and in-memory Cookie
// ---------------------------------------------------------------------------

test('opens the official /connect interactions=answer exchange and keeps the Cookie in memory', async () => {
  const harness = createFakeModules()
  const { handle, calls, host } = await openTransport(harness)

  const exchange = calls.find((call) => new URL(call.url).pathname === '/connect')
  assert.ok(exchange, 'expected one /connect request')
  const exchangeUrl = new URL(exchange.url)
  assert.equal(exchangeUrl.origin, ORIGIN)
  assert.equal(exchangeUrl.searchParams.get('token'), LAUNCH_TOKEN)
  assert.equal(exchangeUrl.searchParams.get('interactions'), 'answer')
  assert.equal(exchange.init.method, 'GET')
  assert.equal(exchange.init.redirect, 'manual')

  const hooks = harness.captured.connectionOptions
  assert.equal(hooks.interactions, 'answer')
  assert.equal(hooks.transport.streamBaseUrl, ORIGIN)

  // HTTP RPC calls resolve against the Host origin and carry the minted Cookie.
  const before = calls.length
  await hooks.transport.fetch('api/$events/result', { method: 'POST', body: '{}' })
  const rpc = calls.at(-1)
  assert.equal(calls.length, before + 1)
  assert.equal(new URL(rpc.url).origin, ORIGIN)
  assert.equal(new Headers(rpc.init.headers).get('cookie'), COOKIE_PAIR)
  assert.equal(rpc.init.redirect, 'error')

  // The WebSocket factory uses the same Host origin and Cookie.
  const socket = hooks.transport.createWebSocket('ws://127.0.0.1:45123/api/remote.mux')
  assert.equal(socket.url, 'ws://127.0.0.1:45123/api/remote.mux')
  assert.equal(socket.init.headers.cookie, COOKIE_PAIR)

  // The launch token never reaches the client hooks.
  assert.ok(!JSON.stringify(hooks.transport.streamBaseUrl).includes(LAUNCH_TOKEN))
  assert.ok(!JSON.stringify(socket.init).includes(LAUNCH_TOKEN))

  await handle.close()
})

test('rejects cross-origin HTTP and WebSocket targets without calling the carrier', async () => {
  const harness = createFakeModules()
  const { handle, calls, fetchMock } = await openTransport(harness)
  const hooks = harness.captured.connectionOptions.transport

  const before = calls.length
  await assert.rejects(hooks.fetch('http://evil.example/api', {}), expectCode('transport-auth-failed'))
  assert.equal(calls.length, before, 'cross-origin fetch must not reach the carrier')
  assert.throws(
    () => hooks.createWebSocket('ws://evil.example/api/remote.mux'),
    expectCode('transport-auth-failed'),
  )
  assert.equal(fetchMock.calls.length, before)

  await handle.close()
})

// ---------------------------------------------------------------------------
// Agent Context filtering
// ---------------------------------------------------------------------------

test('maps only the claimed session Context and delegates every other request', async () => {
  const harness = createFakeModules()
  const { handle, requests } = await openTransport(harness)

  assert.equal(harness.captured.adapterKey, 'agent')
  assert.equal(harness.captured.adapter.resolve(OTHER_SESSION), undefined)
  assert.notEqual(harness.captured.adapter.resolve(SESSION), undefined)

  const foreign = await deliver(harness.captured, {
    agentId: OTHER_SESSION,
    request: { toolName: 'bash', callId: 'call-1', reason: 'rm -rf', signal: new AbortController().signal },
  })
  assert.equal(foreign.result, NEXT)
  assert.equal(requests.length, 0, 'foreign sessions must never reach onRequest')

  await handle.close()
})

test('defensively delegates a request whose Agent Context is not the local root', async () => {
  const harness = createFakeModules()
  const { handle, requests } = await openTransport(harness)
  const root = harness.captured.adapter.resolve(SESSION)
  const next = makeNext()
  const result = await harness.captured.listener.call(root, { toolName: 'bash', agent: {} }, next.next)
  assert.equal(result, NEXT)
  assert.equal(next.calls(), 1)
  assert.equal(requests.length, 0)
  await handle.close()
})

// ---------------------------------------------------------------------------
// waterfall outcome mapping
// ---------------------------------------------------------------------------

for (const outcome of ['allowed-once', 'rejected']) {
  test(`maps onRequest ${outcome} to the waterfall result`, async () => {
    const harness = createFakeModules()
    const { handle, requests } = await openTransport(harness, { outcome })
    const delivered = await deliver(harness.captured, {
      request: { toolName: 'bash', callId: 'call-9', reason: 'needs approval', displayReason: 'display' },
    })
    assert.equal(delivered.result, outcome)
    assert.equal(delivered.nextCalls, 0)
    assert.deepEqual(requests[0].details, {
      toolName: 'bash',
      callId: 'call-9',
      reason: 'needs approval',
      displayReason: 'display',
    })
    assert.equal(requests[0].sessionId, SESSION)
    await handle.close()
  })
}

test('maps delegate, unknown outcomes, and handler failures to next()', async () => {
  const harness = createFakeModules()
  const { handle } = await openTransport(harness, { outcome: 'delegate' })
  assert.equal((await deliver(harness.captured)).result, NEXT)
  await handle.close()

  const unknown = createFakeModules()
  const unknownOpen = await openTransport(unknown, { outcome: 'cancelled' })
  assert.equal((await deliver(unknown.captured)).result, NEXT)
  await unknownOpen.handle.close()

  const throwing = createFakeModules()
  const throwingOpen = await openTransport(throwing, {
    onRequest: () => {
      throw new Error(`boom ${LAUNCH_TOKEN}`)
    },
  })
  const delivered = await deliver(throwing.captured)
  assert.equal(delivered.result, NEXT)
  await throwingOpen.handle.close()
})

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test('never registers an already-aborted request', async () => {
  const harness = createFakeModules()
  const { handle, requests } = await openTransport(harness)
  const controller = new AbortController()
  controller.abort()
  const delivered = await deliver(harness.captured, { request: { toolName: 'bash', signal: controller.signal } })
  assert.equal(delivered.result, NEXT)
  assert.equal(requests.length, 0)
  await handle.close()
})

test('drops a late outcome after the request signal aborts', async () => {
  const harness = createFakeModules()
  const prompt = deferred()
  let seenSignal
  const { handle } = await openTransport(harness, {
    onRequest: (request) => {
      seenSignal = request.signal
      return prompt.promise
    },
  })
  const controller = new AbortController()
  const next = makeNext()
  const pending = deliver(harness.captured, { request: { toolName: 'bash', signal: controller.signal }, next })

  // The Host cancels the pending waterfall (for example the desktop answered).
  await tick()
  assert.equal(seenSignal, controller.signal)
  controller.abort()

  // A late answer must not become a waterfall result.
  prompt.resolve('allowed-once')
  const delivered = await pending
  assert.equal(delivered.result, NEXT)
  assert.equal(next.calls(), 1)
  await handle.close()
})

// ---------------------------------------------------------------------------
// disconnect and close
// ---------------------------------------------------------------------------

test('notifies onDisconnect once per lost connection and again after reconnect', async () => {
  const harness = createFakeModules()
  const { handle, disconnects } = await openTransport(harness)
  harness.connection.setState('connecting')
  assert.deepEqual(disconnects, ['connection-lost'])
  harness.connection.setState('connecting')
  assert.deepEqual(disconnects, ['connection-lost'])
  harness.connection.setState('connected')
  harness.connection.setState('connecting')
  assert.deepEqual(disconnects, ['connection-lost', 'connection-lost'])
  await handle.close()
})

test('close is idempotent and tears down the client tree and credentials', async () => {
  const harness = createFakeModules()
  const { handle, calls } = await openTransport(harness)
  const root = harness.captured.adapter.resolve(SESSION)
  const hooks = harness.captured.connectionOptions.transport

  await Promise.all([handle.close(), handle.close()])
  await handle.close()

  assert.equal(harness.captured.listenerDisposed, true)
  assert.equal(harness.captured.adapterDisposed, true)
  assert.equal(harness.connection.listenerCount(), 0)
  assert.equal(root.disposed, true)

  // Closed transport cannot reach the carrier any more.
  const before = calls.length
  await assert.rejects(hooks.fetch('api/$events/result', {}), expectCode('transport-auth-failed'))
  assert.throws(() => hooks.createWebSocket('ws://127.0.0.1:45123/api/remote.mux'), expectCode('transport-auth-failed'))
  assert.equal(calls.length, before)

  // A closed listener delegates rather than answering.
  const delivered = await deliver(harness.captured)
  assert.equal(delivered.result, NEXT)
})

// ---------------------------------------------------------------------------
// credential redaction and same-origin Cookie validation
// ---------------------------------------------------------------------------

test('redacts every rejected connect exchange', async () => {
  const cases = [
    {
      name: 'unauthorized',
      respond: () => new Response(`bad token ${LAUNCH_TOKEN}`, { status: 401 }),
    },
    {
      name: 'cross-origin redirect',
      respond: () => connectResponse({ location: 'https://evil.example/api/remote.mux' }),
    },
    {
      name: 'redirect to another path',
      respond: () => connectResponse({ location: './not-the-mux' }),
    },
    {
      name: 'missing cookie',
      respond: () => connectResponse({ setCookie: null }),
    },
    {
      name: 'cookie without HttpOnly',
      respond: () => connectResponse({ setCookie: `${COOKIE_PAIR}; Path=/; SameSite=Strict` }),
    },
    {
      name: 'cookie without SameSite=Strict',
      respond: () => connectResponse({ setCookie: `${COOKIE_PAIR}; Path=/; HttpOnly` }),
    },
    {
      name: 'cookie without Path=/',
      respond: () => connectResponse({ setCookie: `${COOKIE_PAIR}; Path=/elsewhere; HttpOnly; SameSite=Strict` }),
    },
    {
      name: 'domain-scoped cookie',
      respond: () => connectResponse({ setCookie: `${COOKIE_PAIR}; Domain=evil.example; Path=/; HttpOnly; SameSite=Strict` }),
    },
    {
      name: 'Secure cookie over HTTP',
      respond: () => connectResponse({ setCookie: `${SET_COOKIE}; Secure` }),
    },
  ]

  for (const testCase of cases) {
    const harness = createFakeModules()
    const fetchMock = createFetchMock(testCase.respond)
    const transport = createApprovalTransport({
      host: createFakeHost(),
      modules: harness.modules,
      fetch: fetchMock.fetch,
    })
    await assert.rejects(
      transport({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
      (error) => {
        assert.ok(error instanceof ApprovalTransportError, testCase.name)
        assert.equal(error.code, 'transport-auth-failed', testCase.name)
        assertRedacted(error)
        return true
      },
      testCase.name,
    )
  }
})

test('redacts a carrier failure that contains the target URL and token', async () => {
  const harness = createFakeModules()
  const transport = createApprovalTransport({
    host: createFakeHost(),
    modules: harness.modules,
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED ${ORIGIN}/connect?token=${LAUNCH_TOKEN}`)
    },
  })
  await assert.rejects(
    transport({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
    (error) => {
      assert.equal(error.code, 'transport-auth-failed')
      assertRedacted(error)
      return true
    },
  )
})

test('rejects an authentication URL that is not the Host origin or carries no single token', async () => {
  for (const authenticatedUrl of [
    (origin) => `${origin}/?token=`,
    (origin) => `${origin}/?token=one&token=two`,
    () => 'http://127.0.0.1:9/?token=elsewhere',
  ]) {
    const harness = createFakeModules()
    const transport = createApprovalTransport({
      host: createFakeHost({ authenticatedUrl }),
      modules: harness.modules,
      fetch: createFetchMock().fetch,
    })
    await assert.rejects(
      transport({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
      (error) => {
        assert.equal(error.code, 'transport-auth-failed')
        assertRedacted(error, [LAUNCH_TOKEN, COOKIE_PAIR, '127.0.0.1'])
        return true
      },
    )
  }
})

// ---------------------------------------------------------------------------
// startup failures and option validation
// ---------------------------------------------------------------------------

test('fails closed when official modules are unavailable or incomplete', async () => {
  const host = createFakeHost()

  const resolving = createApprovalTransport({
    host,
    resolveModules: async () => {
      throw new Error(`cannot find /private/secret/${LAUNCH_TOKEN}`)
    },
    fetch: createFetchMock().fetch,
  })
  await assert.rejects(
    resolving({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
    (error) => {
      assert.equal(error.code, TRANSPORT_UNAVAILABLE)
      assertRedacted(error, [LAUNCH_TOKEN, '/private/secret'])
      return true
    },
  )

  const incomplete = createApprovalTransport({
    host,
    modules: {},
    fetch: createFetchMock().fetch,
  })
  await assert.rejects(
    incomplete({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
    expectCode(TRANSPORT_UNAVAILABLE),
  )
})

test('rejects invalid options with invalid-request', async () => {
  assert.throws(() => createApprovalTransport(), expectCode('invalid-request'))
  assert.throws(() => createApprovalTransport({}), expectCode('invalid-request'))
  assert.throws(
    () => createApprovalTransport({ host: createFakeHost(), connectTimeoutMs: 0 }),
    expectCode('invalid-request'),
  )

  const harness = createFakeModules()
  const transport = createApprovalTransport({ host: createFakeHost(), modules: harness.modules, fetch: createFetchMock().fetch })
  assert.equal(typeof transport, 'function')

  await assert.rejects(transport(), expectCode('invalid-request'))
  await assert.rejects(transport({ sessionId: '', onRequest: () => 'rejected' }), expectCode('invalid-request'))
  await assert.rejects(transport({ sessionId: SESSION }), expectCode('invalid-request'))
  await assert.rejects(transport({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: 'nope' }), expectCode('invalid-request'))
})

test('fails closed when the official client never reaches connected', async () => {
  const harness = createFakeModules({ autoConnect: false })
  const transport = createApprovalTransport({
    host: createFakeHost(),
    modules: harness.modules,
    fetch: createFetchMock().fetch,
    connectTimeoutMs: 5,
  })

  await assert.rejects(
    transport({ sessionId: SESSION, onRequest: () => 'rejected', onDisconnect: () => {} }),
    expectCode(TRANSPORT_UNAVAILABLE),
  )
  assert.equal(harness.captured.listenerDisposed, true, 'a failed startup disposes the client tree')
  assert.equal(harness.captured.adapterDisposed, true)
  assert.equal(harness.connection.listenerCount(), 0)
})

// ---------------------------------------------------------------------------
// Host module resolution policy (mock resolve/import/read)
// ---------------------------------------------------------------------------

const RUNTIME = 'file:///runtime/dsh'
const PACKAGE_URLS = {
  cordis: `${RUNTIME}/node_modules/@deepseek-ai/cordis/lib/index.js`,
  clientConnection: `${RUNTIME}/node_modules/@deepseek-ai/dsh-client-connection/lib/client.node.js`,
  typertClient: `${RUNTIME}/node_modules/@deepseek-ai/dsh-typert-registry/lib/client.node.js`,
  gatewayClient: `${RUNTIME}/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js`,
  websocket: `${RUNTIME}/node_modules/ws/index.js`,
}

function createHostLoaderMock({ versions = {}, missing } = {}) {
  const resolvedUrls = {
    [HOST_MODULE_SPECIFIERS.cordis]: PACKAGE_URLS.cordis,
    [HOST_MODULE_SPECIFIERS.clientConnection]: PACKAGE_URLS.clientConnection,
    [HOST_MODULE_SPECIFIERS.typertClient]: PACKAGE_URLS.typertClient,
    [HOST_MODULE_SPECIFIERS.gatewayClient]: PACKAGE_URLS.gatewayClient,
    [HOST_MODULE_SPECIFIERS.websocket]: PACKAGE_URLS.websocket,
  }
  const manifests = {
    '@deepseek-ai/cordis': '4.1.0',
    '@deepseek-ai/dsh-client-connection': '0.2.2-rc.1',
    '@deepseek-ai/dsh-typert-registry': '0.2.2-rc.1',
    '@deepseek-ai/dsh-api-gateway': '0.2.2-rc.1',
    ...versions,
  }
  return {
    resolveSpecifier(specifier) {
      if (specifier === missing) throw new Error('missing from this runtime')
      const url = resolvedUrls[specifier]
      if (url === undefined) throw new Error('unexpected specifier')
      return url
    },
    async importModule(url) {
      if (url === PACKAGE_URLS.cordis) return { Context: class FakeCordisContext {} }
      if (url === PACKAGE_URLS.clientConnection) return { installConnection() {} }
      if (url === PACKAGE_URLS.typertClient) return { apply() {} }
      if (url === PACKAGE_URLS.gatewayClient) return { apply() {} }
      if (url === PACKAGE_URLS.websocket) return { WebSocket: class FakeWebSocket {} }
      throw new Error('unexpected module')
    },
    async readFile(url) {
      for (const [name, version] of Object.entries(manifests)) {
        if (url.includes(`/node_modules/${name}/package.json`)) return JSON.stringify({ name, version })
      }
      throw new Error('missing manifest')
    },
  }
}

test('loads the official Host packages from one runtime with split version policy', async () => {
  const loader = createHostLoaderMock()
  const modules = await loadHostModules({
    resolveSpecifier: loader.resolveSpecifier,
    importModule: loader.importModule,
    readFile: loader.readFile,
  })
  assert.equal(typeof modules.Context, 'function')
  assert.equal(typeof modules.installConnection, 'function')
  assert.equal(typeof modules.typertClient, 'object')
  assert.equal(typeof modules.gatewayClient, 'object')
  assert.equal(typeof modules.WebSocket, 'function')
  assert.deepEqual(modules.versions, {
    cordis: '4.1.0',
    clientConnection: '0.2.2-rc.1',
    typertClient: '0.2.2-rc.1',
    gatewayClient: '0.2.2-rc.1',
  })
})

test('rejects inconsistent DSH versions but accepts a Cordis 4.1 patch level', async () => {
  const patch = createHostLoaderMock({ versions: { '@deepseek-ai/cordis': '4.1.4' } })
  await loadHostModules(patch)

  const mismatch = createHostLoaderMock({ versions: { '@deepseek-ai/dsh-api-gateway': '0.2.1' } })
  await assert.rejects(
    loadHostModules(mismatch),
    expectCode(TRANSPORT_UNAVAILABLE),
    'three DSH client packages must share one version',
  )
})

test('rejects an incompatible Cordis line and a mismatched expected Host version', async () => {
  const incompatible = createHostLoaderMock({
    versions: { '@deepseek-ai/cordis': '3.9.0', '@deepseek-ai/dsh-client-connection': '0.2.2-rc.1' },
  })
  await assert.rejects(loadHostModules(incompatible), expectCode(TRANSPORT_UNAVAILABLE))

  const loader = createHostLoaderMock()
  await assert.rejects(
    loadHostModules({
      resolveSpecifier: loader.resolveSpecifier,
      importModule: loader.importModule,
      readFile: loader.readFile,
      expectedVersion: '0.1.0',
    }),
    expectCode(TRANSPORT_UNAVAILABLE),
  )
})

test('reports a missing official package as unavailable without leaking its path', async () => {
  const loader = createHostLoaderMock({ missing: HOST_MODULE_SPECIFIERS.typertClient })
  await assert.rejects(
    loadHostModules({
      resolveSpecifier: loader.resolveSpecifier,
      importModule: loader.importModule,
      readFile: loader.readFile,
    }),
    (error) => {
      assert.equal(error.code, TRANSPORT_UNAVAILABLE)
      assertRedacted(error, ['/runtime/dsh', 'node_modules'])
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// real official client module smoke (mock carriers, dummy credentials)
// ---------------------------------------------------------------------------

const SMOKE_ORIGIN = 'http://127.0.0.1:45999'
const SMOKE_TOKEN = 'dummy-smoke-token-not-a-credential'
const SMOKE_COOKIE = 'dsh-smoke=dummy-value'
const SMOKE_SET_COOKIE = `${SMOKE_COOKIE}; Max-Age=600; Path=/; HttpOnly; SameSite=Strict`

/** Fixed, read-only runtime candidates; no filesystem scan. */
function findInstalledRuntimeAnchor() {
  const candidates = []
  const explicit = process.env.DSH_APPROVAL_SMOKE_RUNTIME
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit)
  const binDir = dirname(process.execPath)
  candidates.push(join(binDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  candidates.push(join(binDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const candidate of candidates) {
    const anchor = candidate.endsWith('package.json') ? candidate : join(candidate, 'package.json')
    if (!existsSync(anchor)) continue
    try {
      const require = createRequire(anchor)
      for (const specifier of [
        HOST_MODULE_SPECIFIERS.cordis,
        HOST_MODULE_SPECIFIERS.clientConnection,
        HOST_MODULE_SPECIFIERS.typertClient,
        HOST_MODULE_SPECIFIERS.gatewayClient,
        HOST_MODULE_SPECIFIERS.websocket,
      ]) {
        require.resolve(specifier)
      }
      return anchor
    } catch {
      // Try the next fixed candidate.
    }
  }
  return undefined
}

function createWireMock() {
  const captured = { sockets: [], fetchCalls: [], eventResults: [], events: [] }
  let counter = 0
  class MockSocket {
    constructor(url, init) {
      this.url = String(url)
      this.init = init
      this.readyState = 0
      this.listeners = new Map()
      this.eventsStreamId = undefined
      captured.sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.emit('open', {})
      })
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(listener)
    }
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener)
    }
    emit(type, event) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
    send(payload) {
      const frame = JSON.parse(String(payload))
      if (frame.type !== 'open') return
      this.eventsStreamId ??= frame.streamId
      queueMicrotask(() => {
        this.emit('message', {
          data: JSON.stringify({
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'ready', clientId: 'smoke-client', host: { home: '/tmp/smoke-home' } },
          }),
        })
      })
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close', { code, reason: String(reason) })
    }
    waterfall(agentId, request) {
      const eventId = `smoke-event-${++counter}`
      captured.events.push({ eventId, agentId, request })
      this.emit('message', {
        data: JSON.stringify({
          type: 'item',
          streamId: this.eventsStreamId,
          value: { type: 'waterfall', event: 'approval/request', eventId, agentId, request },
        }),
      })
      return eventId
    }
    cancel(eventId) {
      this.emit('message', {
        data: JSON.stringify({ type: 'item', streamId: this.eventsStreamId, value: { type: 'cancel', eventId } }),
      })
    }
  }
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input), SMOKE_ORIGIN)
    captured.fetchCalls.push({ url: url.href, init })
    if (url.pathname === '/connect') {
      return new Response(null, {
        status: 302,
        headers: { location: './api/remote.mux', 'set-cookie': SMOKE_SET_COOKIE },
      })
    }
    if (url.pathname === '/api/$events/result') {
      const body = JSON.parse(String(init.body))
      captured.eventResults.push(body.payload?.args)
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected smoke fetch ${url.pathname}`)
  }
  return { captured, fetch, MockSocket }
}

function findEventResult(captured, eventId) {
  return captured.eventResults.find((result) => result?.eventId === eventId)
}

async function waitFor(predicate, description, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timeout waiting for ${description}`)
}

test('real official modules: typert registry accepts the plain Context resolve shape', async (t) => {
  const anchor = findInstalledRuntimeAnchor()
  if (anchor === undefined) {
    t.skip('no installed official Host runtime found; set DSH_APPROVAL_SMOKE_RUNTIME to enable')
    return
  }
  const modules = await loadHostModules({ anchor })
  assert.equal(
    new Set([modules.versions.clientConnection, modules.versions.typertClient, modules.versions.gatewayClient]).size,
    1,
  )
  assert.match(modules.versions.cordis, /^4\.1\./)

  const root = new modules.Context()
  await root.plugin(modules.typertClient)
  const typert = root.get('typert')
  // `await ctx.plugin()` is enough: no root.start()/flush/service wait is needed.
  assert.equal(typeof typert?.contexts?.registerClient, 'function')
  const dispose = typert.contexts.registerClient('agent', {
    resolve: (agentId) => (agentId === SESSION ? root : undefined),
  })
  const adapter = typert.contexts.getClient('agent')
  // The registered target is the Context itself, returned as-is to the gateway.
  assert.equal(adapter.resolve(SESSION), root)
  assert.equal(adapter.resolve(OTHER_SESSION), undefined)
  dispose()
  assert.equal(typert.contexts.getClient('agent'), undefined)
  await root.fiber.dispose()
})

test('real official modules: approval waterfall is answered through mock carriers', async (t) => {
  const anchor = findInstalledRuntimeAnchor()
  if (anchor === undefined) {
    t.skip('no installed official Host runtime found; set DSH_APPROVAL_SMOKE_RUNTIME to enable')
    return
  }
  const realModules = await loadHostModules({ anchor })
  const wire = createWireMock()
  const requests = []
  const onRequest = (request) => {
    requests.push(request)
    if (request.details.toolName === 'cancel-me') {
      return new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => resolve('delegate'), { once: true })
      })
    }
    return 'allowed-once'
  }

  const transport = createApprovalTransport({
    host: {
      webServer: { getOrigin: () => SMOKE_ORIGIN },
      connection: { authenticatedUrl: (origin) => `${origin}/?token=${SMOKE_TOKEN}` },
    },
    // Real Cordis/connection/typert/gateway; only the physical socket is mocked.
    modules: { ...realModules, WebSocket: wire.MockSocket },
    fetch: wire.fetch,
    connectTimeoutMs: 5000,
    logger: { warn() {} },
  })

  const handle = await transport({ sessionId: SESSION, onRequest, onDisconnect: () => {} })

  // The default WebSocket carrier attached the dummy Cookie to the real mux URL.
  assert.equal(wire.captured.sockets.length, 1)
  const socket = wire.captured.sockets[0]
  assert.equal(socket.url, 'ws://127.0.0.1:45999/api/remote.mux')
  assert.equal(socket.init.headers.cookie, SMOKE_COOKIE)

  // Claimed session: real adapter -> real waterfall -> allowed-once through the wire.
  const allowed = socket.waterfall(SESSION, { toolName: 'bash', callId: 'call-1', reason: 'smoke' })
  await waitFor(() => findEventResult(wire.captured, allowed) !== undefined, 'allowed-once $events/result')
  assert.equal(findEventResult(wire.captured, allowed).outcome.kind, 'result')
  assert.equal(findEventResult(wire.captured, allowed).outcome.value, 'allowed-once')
  assert.equal(requests.length, 1)

  // Other session: adapter resolve undefined -> gateway posts `next`, no onRequest.
  const foreign = socket.waterfall(OTHER_SESSION, { toolName: 'bash' })
  await waitFor(() => findEventResult(wire.captured, foreign) !== undefined, 'foreign next $events/result')
  assert.equal(findEventResult(wire.captured, foreign).outcome.kind, 'next')
  assert.equal(requests.length, 1, 'foreign waterfall never reaches onRequest')

  // Host cancel: aborted delivery posts no late result.
  const cancelled = socket.waterfall(SESSION, { toolName: 'cancel-me' })
  await waitFor(() => requests.length === 2, 'cancelled request registration')
  socket.cancel(cancelled)
  await waitFor(() => requests[1].signal.aborted, 'cancel signal abort')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(findEventResult(wire.captured, cancelled), undefined, 'aborted request must not submit a result')

  await handle.close()
  assert.equal(socket.readyState, 3, 'close tears the physical socket down')
})

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('contract constants stay stable', () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 10_000)
  assert.equal(TRANSPORT_UNAVAILABLE, 'transport-unavailable')
  assert.equal(HOST_MODULE_SPECIFIERS.cordis, '@deepseek-ai/cordis')
  assert.equal(HOST_MODULE_SPECIFIERS.clientConnection, '@deepseek-ai/dsh-client-connection/client')
  assert.equal(HOST_MODULE_SPECIFIERS.typertClient, '@deepseek-ai/dsh-typert-registry/client')
  assert.equal(HOST_MODULE_SPECIFIERS.gatewayClient, '@deepseek-ai/dsh-api-gateway/client')
})
