import test from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalChannel } from '../approval-channel.js'
import { registerApprovalRoutes } from '../approval-routes.js'

const PATHS = [
  '/local-cli/approval',
  '/local-cli/approval/claim',
  '/local-cli/approval/heartbeat',
  '/local-cli/approval/release',
  '/local-cli/approval/answer',
]

const SECRET = 'SECRET-ROUTE-VALUE'

/**
 * Fake bridge context + real approval channel (fake transport/clock/timers).
 * The transport's onRequest is driven directly from the test.
 */
function harness(options = {}) {
  const sessions = options.sessions ?? new Map([
    ['abc', 's-canonical'],
    ['s-canonical', 's-canonical'],
  ])
  const liveAgents = options.liveAgents ?? new Set(['s-canonical'])
  const withAgents = options.withAgents ?? true
  const secret = options.secret ?? SECRET

  const routes = new Map()
  const logs = []
  const handles = []
  const clock = { now: 1_000_000 }
  const timers = new Map()
  let timerSeq = 0
  let idSeq = 0
  let resolveCalls = 0

  const channel = createApprovalChannel({
    transport: async (openOptions) => {
      const handle = {
        options: openOptions,
        closed: 0,
        secret,
        close() {
          this.closed += 1
        },
      }
      handles.push(handle)
      return handle
    },
    now: () => clock.now,
    setTimeout: (fn, ms) => {
      const id = ++timerSeq
      timers.set(id, { fn, at: clock.now + ms })
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
    randomId: () => `id-${++idSeq}`,
  })

  const ctx = {
    get(name) {
      if (name !== 'agents' || withAgents !== true) return undefined
      return {
        get: (sessionId) => (liveAgents.has(sessionId) ? { id: sessionId } : undefined),
      }
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    logger() {
      return { warn: (message) => logs.push(String(message)) }
    },
  }

  const helpers = {
    authorize: async (request) => (request.authorized === false ? 'missing x-local-cli-token header' : undefined),
    reply: (res, status, payload) => {
      res.status = status
      res.body = payload
    },
    readJsonBody: async (request) => {
      if (request.bodyError !== undefined) throw new Error(request.bodyError)
      return request.body ?? {}
    },
    resolveSession: async (reference) => {
      resolveCalls += 1
      if (sessions.has(reference)) return { sessionId: sessions.get(reference) }
      const matches = [...sessions.keys()].filter((key) => key.startsWith(reference))
      if (matches.length === 1) return { sessionId: sessions.get(matches[0]) }
      return { error: `no Session matches ${JSON.stringify(reference)}` }
    },
    abort: new AbortController().signal,
    channel,
  }

  const registered = registerApprovalRoutes(ctx, helpers)

  async function call(path, method, requestOptions = {}) {
    const route = routes.get(path)
    assert.ok(route, `route ${path} must be registered`)
    const query = requestOptions.query === undefined ? '' : `?${requestOptions.query}`
    const request = {
      method,
      url: `${path}${query}`,
      headers: {},
      authorized: requestOptions.authorized,
      body: requestOptions.body,
      bodyError: requestOptions.bodyError,
    }
    const res = {}
    await route.handler(request, res)
    return res
  }

  function advance(ms) {
    clock.now += ms
    for (let guard = 0; guard < 100; guard += 1) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock.now)
      if (due.length === 0) break
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    }
  }

  async function claim(sessionId = 'abc', extra = {}) {
    const res = await call('/local-cli/approval/claim', 'POST', { body: { sessionId, ...extra } })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    return res.body
  }

  /** Simulate the future Node Client transport delivering one approval request. */
  function request() {
    const handle = handles[handles.length - 1]
    assert.ok(handle, 'claim must have opened a transport handle')
    const source = {
      sessionId: 's-canonical',
      details: { toolName: 'bash', callId: 'call-1', reason: 'needs escalation' },
      signal: new AbortController().signal,
    }
    const settled = handle.options.onRequest(source)
    return { source, settled }
  }

  return {
    channel,
    routes,
    logs,
    handles,
    registered,
    call,
    claim,
    request,
    advance,
    clock,
    resolveCalls: () => resolveCalls,
  }
}

test('registers five exact routes and returns their paths', () => {
  const h = harness()
  assert.deepEqual([...h.routes.keys()].sort(), [...PATHS].sort())
  assert.deepEqual([...h.registered.paths].sort(), [...PATHS].sort())
  for (const route of h.routes.values()) assert.equal(route.kind, 'exact')
})

test('every route rejects unauthenticated requests before touching the channel', async () => {
  const h = harness()
  const methods = {
    '/local-cli/approval': 'GET',
    '/local-cli/approval/claim': 'POST',
    '/local-cli/approval/heartbeat': 'POST',
    '/local-cli/approval/release': 'POST',
    '/local-cli/approval/answer': 'POST',
  }
  for (const [path, method] of Object.entries(methods)) {
    const res = await h.call(path, method, { authorized: false, body: {} })
    assert.equal(res.status, 401, path)
    assert.equal(res.body.ok, false)
    assert.equal(typeof res.body.error, 'string')
  }
  assert.equal(h.resolveCalls(), 0)
  assert.equal(h.handles.length, 0)
  assert.equal(h.channel.status().claim, null)
})

test('wrong methods return 405, and auth still wins over the method check', async () => {
  const h = harness()
  const wrongGet = await h.call('/local-cli/approval', 'POST')
  assert.equal(wrongGet.status, 405)
  assert.equal(wrongGet.body.error, 'use GET')

  for (const path of PATHS.slice(1)) {
    const wrong = await h.call(path, 'GET')
    assert.equal(wrong.status, 405, path)
    assert.equal(wrong.body.error, 'use POST')
  }

  const unauth = await h.call('/local-cli/approval/claim', 'GET', { authorized: false })
  assert.equal(unauth.status, 401)
})

test('claim resolves a canonical session id and arms the channel', async () => {
  const h = harness()
  const body = await h.claim('abc', { leaseMs: 60_000 })
  assert.deepEqual(Object.keys(body).sort(), ['claimId', 'expiresAt', 'leaseMs', 'ok', 'sessionId'].sort())
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 's-canonical')
  assert.equal(body.leaseMs, 60_000)
  assert.equal(h.resolveCalls(), 1)

  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(status.status, 200)
  assert.equal(status.body.claim.claimId, body.claimId)
  assert.equal(status.body.claim.sessionId, 's-canonical')
  assert.equal(status.body.pendingCount, 0)
  assert.deepEqual(status.body.pending, [])
})

test('claim rejects unknown sessions, sessions without a live agent, and a missing agents service', async () => {
  const unknown = harness()
  const unknownRes = await unknown.call('/local-cli/approval/claim', 'POST', { body: { sessionId: 'nope' } })
  assert.equal(unknownRes.status, 404)
  assert.equal(unknownRes.body.code, 'no-such-session')
  assert.equal(unknown.channel.status().claim, null)

  const notLive = harness({ liveAgents: new Set() })
  const notLiveRes = await notLive.call('/local-cli/approval/claim', 'POST', { body: { sessionId: 'abc' } })
  assert.equal(notLiveRes.status, 409)
  assert.equal(notLiveRes.body.code, 'session-not-live')
  assert.equal(notLive.channel.status().claim, null)

  const noAgents = harness({ withAgents: false })
  const noAgentsRes = await noAgents.call('/local-cli/approval/claim', 'POST', { body: { sessionId: 'abc' } })
  assert.equal(noAgentsRes.status, 501)
  assert.equal(noAgentsRes.body.code, 'agent-registry-unavailable')
  assert.equal(noAgents.channel.status().claim, null)
})

test('claim bodies are strict: unknown fields and wrong types are refused', async () => {
  const h = harness()
  const cases = [
    { sessionId: 'abc', confirmed: true },
    { sessionId: 'abc', leaseMs: true },
    { sessionId: 'abc', leaseMs: '60000' },
    { sessionId: 'abc', leaseMs: Number.NaN },
    { sessionId: true },
    { sessionId: 42 },
    [],
    {},
  ]
  for (const body of cases) {
    const res = await h.call('/local-cli/approval/claim', 'POST', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal(res.body.ok, false)
    assert.equal(typeof res.body.code, 'string')
  }
  assert.equal(h.channel.status().claim, null)

  const broken = await h.call('/local-cli/approval/claim', 'POST', { bodyError: 'invalid JSON' })
  assert.equal(broken.status, 400)
  assert.equal(broken.body.code, 'invalid-body')
})

test('a second claim conflicts', async () => {
  const h = harness()
  await h.claim('abc')
  const conflict = await h.call('/local-cli/approval/claim', 'POST', { body: { sessionId: 'abc' } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'claim-conflict')
})

test('a claim id from another scope is refused on every write route and on status', async () => {
  const h = harness()
  const body = await h.claim('abc')
  const wrong = 'id-does-not-match'

  const heartbeat = await h.call('/local-cli/approval/heartbeat', 'POST', { body: { claimId: wrong } })
  assert.equal(heartbeat.status, 403)
  assert.equal(heartbeat.body.code, 'claim-mismatch')

  const answer = await h.call('/local-cli/approval/answer', 'POST', { body: { claimId: wrong, requestId: 'id-9', outcome: 'allowed-once' } })
  assert.equal(answer.status, 403)
  assert.equal(answer.body.code, 'claim-mismatch')

  const release = await h.call('/local-cli/approval/release', 'POST', { body: { claimId: wrong } })
  assert.equal(release.status, 403)
  assert.equal(release.body.code, 'claim-mismatch')

  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${wrong}` })
  assert.equal(status.status, 403)
  assert.equal(status.body.code, 'claim-mismatch')

  const own = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(own.status, 200)
  assert.equal(own.body.claim.claimId, body.claimId)
})

test('an expired claim fails closed on heartbeat, answer, and release; status reports no claim', async () => {
  const h = harness()
  const body = await h.claim('abc', { leaseMs: 10_000 })
  h.advance(10_000)

  const heartbeat = await h.call('/local-cli/approval/heartbeat', 'POST', { body: { claimId: body.claimId } })
  assert.equal(heartbeat.status, 410)
  assert.equal(heartbeat.body.code, 'claim-expired')

  const answer = await h.call('/local-cli/approval/answer', 'POST', { body: { claimId: body.claimId, requestId: 'id-1', outcome: 'allowed-once' } })
  assert.equal(answer.status, 410)
  assert.equal(answer.body.code, 'claim-expired')

  const release = await h.call('/local-cli/approval/release', 'POST', { body: { claimId: body.claimId } })
  assert.equal(release.status, 410)

  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(status.status, 200)
  assert.equal(status.body.claim, null)
})

test('heartbeat extends the lease through the route', async () => {
  const h = harness()
  const body = await h.claim('abc', { leaseMs: 10_000 })
  h.advance(5_000)
  const beat = await h.call('/local-cli/approval/heartbeat', 'POST', { body: { claimId: body.claimId, leaseMs: 20_000 } })
  assert.equal(beat.status, 200)
  assert.equal(beat.body.expiresAt, h.clock.now + 20_000)
  assert.equal(beat.body.leaseMs, 20_000)

  h.advance(10_000)
  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(status.status, 200)
  assert.equal(status.body.claim.claimId, body.claimId)
})

test('answer records a local submission only (final:false) and cannot be repeated', async () => {
  const h = harness()
  const body = await h.claim('abc')
  const { source, settled } = h.request()

  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(status.body.pendingCount, 1)
  assert.deepEqual(
    Object.keys(status.body.pending[0]).sort(),
    ['callId', 'displayReason', 'reason', 'requestId', 'requestedAt', 'sessionId', 'toolName'].sort(),
  )
  assert.equal(status.body.pending[0].sessionId, 's-canonical')

  const answered = await h.call('/local-cli/approval/answer', 'POST', {
    body: { claimId: body.claimId, requestId: source.requestId, outcome: 'allowed-once' },
  })
  assert.equal(answered.status, 200)
  assert.equal(answered.body.ok, true)
  assert.equal(answered.body.final, false)
  assert.equal(typeof answered.body.note, 'string')
  assert.equal(answered.body.outcome, 'allowed-once')
  assert.equal(await settled, 'allowed-once')

  const again = await h.call('/local-cli/approval/answer', 'POST', {
    body: { claimId: body.claimId, requestId: source.requestId, outcome: 'rejected' },
  })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'request-not-pending')
})

test('invalid outcomes are refused and leave the request pending', async () => {
  const h = harness()
  const body = await h.claim('abc')
  const { source, settled } = h.request()

  for (const outcome of ['cancelled', 'unavailable', 'always', true]) {
    const res = await h.call('/local-cli/approval/answer', 'POST', { body: { claimId: body.claimId, requestId: source.requestId, outcome } })
    assert.equal(res.status, 400, String(outcome))
    assert.equal(res.body.code, 'outcome-not-supported')
  }
  const status = await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })
  assert.equal(status.body.pendingCount, 1)

  const ok = await h.call('/local-cli/approval/answer', 'POST', {
    body: { claimId: body.claimId, requestId: source.requestId, outcome: 'rejected' },
  })
  assert.equal(ok.status, 200)
  assert.equal(await settled, 'rejected')
})

test('release delegates pending work and a repeated release is claim-expired', async () => {
  const h = harness()
  const body = await h.claim('abc')
  const { settled } = h.request()

  const released = await h.call('/local-cli/approval/release', 'POST', { body: { claimId: body.claimId, reason: 'user' } })
  assert.equal(released.status, 200)
  assert.deepEqual(released.body, { ok: true, released: true, delegated: 1 })
  assert.equal(await settled, 'delegate')

  const status = await h.call('/local-cli/approval', 'GET')
  assert.equal(status.body.claim, null)

  const again = await h.call('/local-cli/approval/release', 'POST', { body: { claimId: body.claimId } })
  assert.equal(again.status, 410)
  assert.equal(again.body.code, 'claim-expired')
})

test('status query is strict', async () => {
  const h = harness()
  await h.claim('abc')

  const unknown = await h.call('/local-cli/approval', 'GET', { query: 'foo=1' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'invalid-body')

  const duplicate = await h.call('/local-cli/approval', 'GET', { query: 'claimId=a&claimId=b' })
  assert.equal(duplicate.status, 400)

  const empty = await h.call('/local-cli/approval', 'GET', { query: 'claimId=' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'invalid-request')
})

test('no response or log carries a transport credential', async () => {
  const h = harness({ secret: SECRET })
  const body = await h.claim('abc')
  const { source } = h.request()
  const responses = [
    body,
    (await h.call('/local-cli/approval', 'GET', { query: `claimId=${body.claimId}` })).body,
    (await h.call('/local-cli/approval/answer', 'POST', {
      body: { claimId: body.claimId, requestId: source.requestId, outcome: 'allowed-once' },
    })).body,
  ]
  assert.equal(h.handles[0].secret, SECRET)
  for (const response of responses) {
    assert.equal(JSON.stringify(response).includes(SECRET), false)
  }
  assert.equal(JSON.stringify(h.logs).includes(SECRET), false)
})
