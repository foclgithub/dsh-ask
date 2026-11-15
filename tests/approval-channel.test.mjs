import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApprovalChannelError,
  LEASE_DEFAULT_MS,
  MAX_PENDING_DEFAULT,
  USER_OUTCOMES,
  createApprovalChannel,
} from '../approval-channel.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Deterministic fake harness: fake clock, fake timers, and a transport factory
 * whose handle can be driven from the test (onRequest / onDisconnect).
 */
function harness(overrides = {}) {
  const clock = { now: 1_000_000 }
  const timers = new Map()
  const handles = []
  let timerSeq = 0
  let idSeq = 0

  const transport =
    overrides.transport ??
    (async (options) => {
      const handle = {
        options,
        closed: 0,
        secret: 'SECRET-CREDENTIAL-VALUE',
        close(reason) {
          this.closed += 1
          this.closeReason = reason
        },
      }
      handles.push(handle)
      return handle
    })

  const channel = createApprovalChannel({
    transport,
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
    ...overrides.deps,
  })

  function advance(ms) {
    clock.now += ms
    for (let guard = 0; guard < 200; guard += 1) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock.now)
      if (due.length === 0) break
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    }
  }

  function open(index = 0, request = {}) {
    const handle = handles[index]
    assert.ok(handle, `transport handle ${index} was not opened`)
    const source = {
      sessionId: 'session-a',
      details: {
        toolName: 'bash',
        callId: 'call-abcdef',
        reason: 'needs sandbox escalation',
        displayReason: 'command needs approval',
      },
      ...request,
    }
    const settled = handle.options.onRequest(source)
    return { handle, source, settled }
  }

  return { channel, clock, timers, handles, advance, open }
}

test('claim arms the channel without auto-answering; explicit answer settles once', async () => {
  const { channel, handles, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  assert.equal(claim.leaseMs, LEASE_DEFAULT_MS)
  assert.equal(handles.length, 1)
  assert.equal(handles[0].options.sessionId, 'session-a')

  const { source, settled } = open()
  assert.equal(typeof source.requestId, 'string')
  assert.equal(typeof source.answer, 'function')
  assert.equal(typeof source.delegate, 'function')

  let resolved = 0
  settled.then(() => {
    resolved += 1
  })
  await tick()
  assert.equal(resolved, 0, 'claim/onRequest must not auto-answer')
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 1)

  const result = channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome: 'allowed-once' })
  assert.equal(result.outcome, 'allowed-once')
  assert.equal(await settled, 'allowed-once')
  await tick()
  assert.equal(resolved, 1)

  assert.throws(
    () => channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome: 'rejected' }),
    (error) => error instanceof ApprovalChannelError && error.code === 'request-not-pending',
  )
  assert.equal(source.answer('rejected'), false)
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 0)
})

test('a request for another session is delegated and never exposed', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })

  const { source, settled } = open(0, { sessionId: 'session-b', details: { toolName: 'secret-tool', reason: 'session-b reason' } })
  assert.equal(await settled, 'delegate')
  assert.equal(source.requestId, undefined)

  const snapshot = channel.status({ claimId: claim.claimId })
  assert.equal(snapshot.pendingCount, 0)
  const text = JSON.stringify(snapshot)
  assert.equal(text.includes('session-b'), false)
  assert.equal(text.includes('secret-tool'), false)
})

test('the desktop cancelling a request rejects a later stale answer', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  const controller = new AbortController()
  const { source, settled } = open(0, { signal: controller.signal })

  controller.abort()
  assert.equal(await settled, 'delegate', 'abort must fail closed to next')

  assert.throws(
    () => channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome: 'allowed-once' }),
    (error) => error.code === 'request-not-pending',
  )
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 0)
})

test('release delegates every pending request and closes the transport once', async () => {
  const { channel, handles, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  const first = open(0)
  const second = open(0, { details: { toolName: 'write' } })

  const released = await channel.release({ claimId: claim.claimId, reason: 'user' })
  assert.deepEqual(released, { released: true, delegated: 2 })
  assert.equal(await first.settled, 'delegate')
  assert.equal(await second.settled, 'delegate')
  assert.equal(handles[0].closed, 1)
  assert.equal(handles[0].closeReason, 'user')
  assert.equal(channel.status().claim, null)

  await assert.rejects(channel.release({ claimId: claim.claimId }), (error) => error.code === 'claim-expired')
})

test('lease expiry fails closed: pending delegate, later answer is claim-expired', async () => {
  const { channel, handles, advance, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a', leaseMs: 10_000 })
  const { settled } = open()

  advance(10_000)
  assert.equal(await settled, 'delegate')
  assert.equal(channel.status().claim, null)
  assert.equal(handles[0].closed, 1)

  assert.throws(() => channel.answer({ claimId: claim.claimId, requestId: 'id-x', outcome: 'allowed-once' }), (error) => error.code === 'claim-expired')
  assert.throws(() => channel.heartbeat({ claimId: claim.claimId }), (error) => error.code === 'claim-expired')
})

test('heartbeat extends the lease and the old timer no longer expires the claim', async () => {
  const { channel, advance, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a', leaseMs: 10_000 })
  const { settled } = open()

  advance(6_000)
  const beat = channel.heartbeat({ claimId: claim.claimId, leaseMs: 10_000 })
  assert.equal(beat.expiresAt, 1_016_000)

  advance(6_000)
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 1, 'heartbeat kept the claim armed')
  assert.equal(settled instanceof Promise, true)

  advance(5_000)
  assert.equal(await settled, 'delegate')
  assert.equal(channel.status().claim, null)
})

test('disconnect delegates pending requests but keeps the claim for reconnection', async () => {
  const { channel, handles, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  const first = open()

  handles[0].options.onDisconnect('closed')
  assert.equal(await first.settled, 'delegate')
  const afterDisconnect = channel.status({ claimId: claim.claimId })
  assert.equal(afterDisconnect.claim.claimId, claim.claimId)
  assert.equal(afterDisconnect.connected, false)
  assert.equal(afterDisconnect.pendingCount, 0)

  channel.heartbeat({ claimId: claim.claimId })
  const second = open(0, { details: { toolName: 'read' } })
  assert.equal(channel.status({ claimId: claim.claimId }).connected, true)
  channel.answer({ claimId: claim.claimId, requestId: second.source.requestId, outcome: 'rejected' })
  assert.equal(await second.settled, 'rejected')
})

test('dispose delegates pending work, closes the transport, and is idempotent', async () => {
  const { channel, handles, open } = harness()
  await channel.claim({ sessionId: 'session-a' })
  const { settled } = open()

  await channel.dispose()
  assert.equal(await settled, 'delegate')
  assert.equal(handles[0].closed, 1)
  await channel.dispose()
  assert.equal(handles[0].closed, 1)

  await assert.rejects(channel.claim({ sessionId: 'session-a' }), (error) => error.code === 'channel-disposed')
  assert.equal(channel.status().claim, null)
})

test('only allowed-once and rejected are accepted outcomes', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  const { source, settled } = open()

  for (const outcome of ['cancelled', 'unavailable', 'always', 'ALLOWED-ONCE', '']) {
    assert.throws(
      () => channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome }),
      (error) => error.code === 'outcome-not-supported',
      `outcome ${JSON.stringify(outcome)} must be refused`,
    )
    assert.equal(source.answer(outcome), false)
  }
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 1)

  channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome: 'allowed-once' })
  assert.equal(await settled, 'allowed-once')
})

test('a second claim conflicts, including while the transport is still opening', async () => {
  let release
  const transport = () =>
    new Promise((resolve) => {
      release = () => resolve({ close() {} })
    })
  const { channel } = harness({ transport })

  const first = channel.claim({ sessionId: 'session-a' })
  await assert.rejects(channel.claim({ sessionId: 'session-b' }), (error) => error.code === 'claim-conflict')
  release()
  const claim = await first
  assert.equal(claim.sessionId, 'session-a')
  await assert.rejects(channel.claim({ sessionId: 'session-b' }), (error) => error.code === 'claim-conflict')
})

test('a failing transport reports channel-unavailable without leaking its message', async () => {
  const transport = () => {
    const error = new Error('connect failed with SECRET-CREDENTIAL-VALUE')
    error.code = 'session-not-live'
    throw error
  }
  const { channel } = harness({ transport })

  await assert.rejects(channel.claim({ sessionId: 'session-a' }), (error) => {
    assert.equal(error instanceof ApprovalChannelError, true)
    assert.equal(error.code, 'session-not-live')
    assert.equal(error.message.includes('SECRET-CREDENTIAL-VALUE'), false)
    return true
  })
  assert.equal(channel.status().claim, null)
})

test('the pending cap delegates overflow instead of queuing it', async () => {
  const { channel, open } = harness({ deps: { maxPending: 2 } })
  const claim = await channel.claim({ sessionId: 'session-a' })
  const first = open(0)
  const second = open(0, { details: { toolName: 'write' } })
  const overflow = open(0, { details: { toolName: 'read' } })

  assert.equal(await overflow.settled, 'delegate')
  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 2)
  channel.answer({ claimId: claim.claimId, requestId: first.source.requestId, outcome: 'allowed-once' })
  channel.answer({ claimId: claim.claimId, requestId: second.source.requestId, outcome: 'rejected' })
  assert.equal(await first.settled, 'allowed-once')
  assert.equal(await second.settled, 'rejected')
})

test('status is a whitelisted snapshot with no transport credentials', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  open()

  const snapshot = channel.status({ claimId: claim.claimId })
  assert.deepEqual(Object.keys(snapshot).sort(), ['claim', 'connected', 'maxPending', 'pending', 'pendingCount'].sort())
  assert.deepEqual(Object.keys(snapshot.claim).sort(), ['claimId', 'expiresAt', 'leaseMs', 'sessionId'].sort())
  assert.deepEqual(Object.keys(snapshot.pending[0]).sort(), ['callId', 'displayReason', 'reason', 'requestId', 'requestedAt', 'sessionId', 'toolName'].sort())
  assert.equal(snapshot.maxPending, MAX_PENDING_DEFAULT)
  const text = JSON.stringify(snapshot)
  assert.equal(text.includes('SECRET-CREDENTIAL-VALUE'), false)
  assert.equal(text.includes('secret'), false)
  assert.deepEqual(USER_OUTCOMES, ['allowed-once', 'rejected'])
})

test('onRequest requires the exact session id; missing or non-string is delegated', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })

  for (const sessionId of [undefined, null, 42, { id: 'session-a' }, 'session-b']) {
    const { source, settled } = open(0, { sessionId, details: { toolName: 'secret-tool' } })
    assert.equal(await settled, 'delegate', `sessionId ${String(sessionId)} must delegate`)
    assert.equal(source.requestId, undefined)
  }

  const snapshot = channel.status({ claimId: claim.claimId })
  assert.equal(snapshot.pendingCount, 0)
  assert.equal(JSON.stringify(snapshot).includes('secret-tool'), false)
})

test('answer, heartbeat, and release require an explicit non-empty claimId', async () => {
  const { channel, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a' })
  const { source, settled } = open()

  for (const claimId of [undefined, null, '', 42]) {
    assert.throws(
      () => channel.answer({ claimId, requestId: source.requestId, outcome: 'allowed-once' }),
      (error) => error.code === 'invalid-request',
    )
    assert.throws(() => channel.heartbeat({ claimId }), (error) => error.code === 'invalid-request')
    await assert.rejects(channel.release({ claimId }), (error) => error.code === 'invalid-request')
  }
  await assert.rejects(channel.release(), (error) => error.code === 'invalid-request')

  assert.equal(channel.status({ claimId: claim.claimId }).pendingCount, 1)
  channel.answer({ claimId: claim.claimId, requestId: source.requestId, outcome: 'allowed-once' })
  assert.equal(await settled, 'allowed-once')
})

test('a request arriving after lease expiry is delegated without registration', async () => {
  const { channel, clock, handles, open } = harness()
  const claim = await channel.claim({ sessionId: 'session-a', leaseMs: 10_000 })

  // The timer has not fired yet, but the lease is logically over.
  clock.now += 10_000
  const { source, settled } = open()
  assert.equal(source.requestId, undefined)
  assert.equal(await settled, 'delegate')
  await tick()
  assert.equal(handles[0].closed, 1)
  assert.equal(channel.status().claim, null)
  assert.throws(
    () => channel.answer({ claimId: claim.claimId, requestId: 'id-x', outcome: 'allowed-once' }),
    (error) => error.code === 'claim-expired',
  )
})
