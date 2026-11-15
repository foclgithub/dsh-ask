/**
 * Approval channel core (item A).
 *
 * A session-scoped state machine for the terminal approval channel. It owns the
 * claim lease, registers pending approval requests, and settles each request at
 * most once. The real Owner Node Client connection is NOT implemented here: the
 * caller injects a transport factory and this module only drives its lifecycle.
 *
 * Contract: docs/permissions.md (approval channel) and docs/architecture.md.
 */

import { randomUUID } from 'node:crypto'

/** Outcomes a human may choose from the terminal. Nothing else is accepted. */
export const USER_OUTCOMES = Object.freeze(['allowed-once', 'rejected'])

/** Claim lease bounds (milliseconds). */
export const LEASE_DEFAULT_MS = 60_000
export const LEASE_MIN_MS = 10_000
export const LEASE_MAX_MS = 600_000

/** How many requests one claim may hold before new ones are delegated. */
export const MAX_PENDING_DEFAULT = 8

const DISPLAY_MAX = 400
const DETAIL_KEYS = ['toolName', 'callId', 'reason', 'displayReason']

/** Stable business error carrying a machine-readable `code`. */
export class ApprovalChannelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApprovalChannelError'
    this.code = code
  }
}

function raise(code, message) {
  throw new ApprovalChannelError(code, message)
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Display-only text: strip control characters, collapse spaces, cap length. */
function cleanDisplay(value) {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text.slice(0, DISPLAY_MAX)
}

/** Whitelist the request details; `callId` stays byte-exact for Host round-trip. */
function normalizeDetails(details) {
  const out = {}
  if (!isPlainObject(details)) return out
  for (const key of DETAIL_KEYS) {
    const value = details[key]
    if (typeof value !== 'string') continue
    if (key === 'callId') {
      if (value !== '') out.callId = value
      continue
    }
    const text = cleanDisplay(value)
    if (text !== undefined) out[key] = text
  }
  return out
}

function normalizeLease(value) {
  if (value === undefined || value === null) return LEASE_DEFAULT_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    raise('invalid-lease', 'leaseMs must be a finite number')
  }
  return Math.min(LEASE_MAX_MS, Math.max(LEASE_MIN_MS, Math.floor(value)))
}

function normalizeMaxPending(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return MAX_PENDING_DEFAULT
  return Math.floor(value)
}

/**
 * Create one channel instance. One instance owns at most one claim at a time.
 * @param {object} deps injected dependencies (see contract §2).
 * @returns channel instance
 */
export function createApprovalChannel(deps = {}) {
  if (typeof deps.transport !== 'function') {
    throw new TypeError('createApprovalChannel requires a transport factory')
  }
  const transport = deps.transport
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const schedule = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const cancel = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : (handle) => clearTimeout(handle)
  const randomId = typeof deps.randomId === 'function' ? deps.randomId : () => randomUUID()
  const maxPending = normalizeMaxPending(deps.maxPending)
  const logger = isPlainObject(deps.logger) && typeof deps.logger.warn === 'function' ? deps.logger : { warn() {} }

  let claim = null
  let disposed = false

  function assertActive() {
    if (disposed) raise('channel-disposed', 'the approval channel is disposed')
  }

  function recordView(record) {
    return {
      claimId: record.claimId,
      sessionId: record.sessionId,
      expiresAt: record.expiresAt,
      leaseMs: record.leaseMs,
    }
  }

  function pendingView(record, pending) {
    return {
      requestId: pending.requestId,
      sessionId: record.sessionId,
      toolName: pending.details.toolName ?? null,
      callId: pending.details.callId ?? null,
      reason: pending.details.reason ?? null,
      displayReason: pending.details.displayReason ?? null,
      requestedAt: pending.requestedAt,
    }
  }

  function cancelTimer(record) {
    if (record.timer === undefined) return
    cancel(record.timer)
    record.timer = undefined
  }

  function scheduleExpiry(record) {
    cancelTimer(record)
    const delay = Math.max(0, record.expiresAt - now())
    record.timer = schedule(() => {
      void expire(record)
    }, delay)
  }

  /** Delegate every pending request; used by release, expiry, dispose, disconnect. */
  function delegateAll(record, reason) {
    let delegated = 0
    for (const requestId of [...record.pending.keys()]) {
      if (settleDelegate(record, requestId, reason)) delegated += 1
    }
    return delegated
  }

  function settleDelegate(record, requestId, reason) {
    const pending = record.pending.get(requestId)
    if (pending === undefined) return false
    record.pending.delete(requestId)
    pending.cleanup()
    pending.settled = true
    pending.resolve('delegate')
    return true
  }

  function settleAnswer(record, requestId, outcome) {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      return { ok: false, code: 'outcome-not-supported' }
    }
    if (typeof requestId !== 'string' || requestId === '') {
      return { ok: false, code: 'invalid-request' }
    }
    const pending = record.pending.get(requestId)
    if (pending === undefined) return { ok: false, code: 'request-not-pending' }
    record.pending.delete(requestId)
    pending.cleanup()
    pending.settled = true
    pending.resolve(outcome)
    return { ok: true }
  }

  async function closeHandle(record, handle, reason) {
    if (handle === undefined || handle === null || record.closed) return
    record.closed = true
    try {
      await handle.close?.(reason)
    } catch {
      // Teardown must not throw or leak transport internals.
      logger.warn('approval-channel: transport close failed')
    }
  }

  /** Expire the current claim synchronously, then close its transport. */
  function expireNow(record) {
    if (claim !== record || !record.active) return false
    claim = null
    record.active = false
    cancelTimer(record)
    delegateAll(record, 'expired')
    void closeHandle(record, record.handle, 'expired')
    return true
  }

  async function expire(record) {
    if (claim !== record || !record.active) return
    if (now() < record.expiresAt) {
      scheduleExpiry(record)
      return
    }
    expireNow(record)
  }

  function requireClaim(claimId) {
    assertActive()
    if (typeof claimId !== 'string' || claimId === '') {
      raise('invalid-request', 'claimId must be a non-empty string')
    }
    if (claim === null) raise('claim-expired', 'no active claim')
    if (claimId !== claim.claimId) {
      raise('claim-mismatch', 'claimId does not match the active claim')
    }
    if (now() >= claim.expiresAt) {
      expireNow(claim)
      raise('claim-expired', 'the claim lease has expired')
    }
    return claim
  }

  function onRequest(record, request) {
    const source = request ?? {}
    if (!record.active || claim !== record) return Promise.resolve('delegate')
    if (now() >= record.expiresAt) {
      // An expired claim must not register new pending work.
      expireNow(record)
      return Promise.resolve('delegate')
    }
    if (source.sessionId !== record.sessionId) {
      // Missing, non-string, or another session: never register or expose.
      return Promise.resolve('delegate')
    }
    if (record.pending.size >= maxPending) return Promise.resolve('delegate')
    const signal = source.signal
    if (signal !== undefined && signal !== null && signal.aborted) return Promise.resolve('delegate')

    record.connected = true
    const requestId = randomId()
    const pending = {
      requestId,
      details: normalizeDetails(source.details),
      requestedAt: now(),
      resolve: undefined,
      cleanup: () => {},
      settled: false,
    }
    const settled = new Promise((resolve) => {
      pending.resolve = resolve
    })
    record.pending.set(requestId, pending)

    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        // Desktop answered or the turn was cancelled: fail closed to `next`.
        settleDelegate(record, requestId, 'cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.cleanup = () => signal.removeEventListener('abort', onAbort)
    }

    source.requestId = requestId
    source.answer = (outcome) => settleAnswer(record, requestId, outcome).ok
    source.delegate = () => settleDelegate(record, requestId, 'delegate')
    return settled
  }

  function onDisconnect(record, reason) {
    if (!record.active || claim !== record) return
    record.connected = false
    delegateAll(record, 'disconnect')
    logger.warn('approval-channel: transport disconnected; pending requests delegated')
  }

  async function claimSession({ sessionId, leaseMs } = {}) {
    assertActive()
    if (typeof sessionId !== 'string' || sessionId === '') {
      raise('invalid-session', 'sessionId must be a non-empty string')
    }
    if (claim !== null) raise('claim-conflict', 'another claim is already active')
    const lease = normalizeLease(leaseMs)
    const record = {
      claimId: randomId(),
      sessionId,
      leaseMs: lease,
      expiresAt: now() + lease,
      pending: new Map(),
      handle: undefined,
      timer: undefined,
      connected: true,
      active: true,
      closed: false,
    }
    claim = record
    let handle
    try {
      handle = await transport({
        sessionId,
        onRequest: (request) => onRequest(record, request),
        onDisconnect: (reason) => onDisconnect(record, reason),
      })
    } catch (error) {
      if (claim === record) claim = null
      record.active = false
      const code = error instanceof ApprovalChannelError
        ? error.code
        : typeof error === 'object' && error !== null && typeof error.code === 'string'
          ? error.code
          : 'channel-unavailable'
      throw new ApprovalChannelError(code, 'transport failed to open')
    }
    if (!record.active || claim !== record) {
      // Released or disposed while the transport was opening.
      if (claim === record) claim = null
      await closeHandle(record, handle, 'released')
      raise('claim-expired', 'the claim ended while the transport was opening')
    }
    record.handle = handle
    scheduleExpiry(record)
    return recordView(record)
  }

  function heartbeat({ claimId, leaseMs } = {}) {
    const record = requireClaim(claimId)
    const lease = leaseMs === undefined ? record.leaseMs : normalizeLease(leaseMs)
    record.leaseMs = lease
    record.expiresAt = now() + lease
    scheduleExpiry(record)
    return { claimId: record.claimId, expiresAt: record.expiresAt, leaseMs: lease }
  }

  async function release({ claimId, reason = 'user' } = {}) {
    const record = requireClaim(claimId)
    claim = null
    record.active = false
    cancelTimer(record)
    const delegated = delegateAll(record, 'released')
    await closeHandle(record, record.handle, reason)
    return { released: true, delegated }
  }

  function answer({ claimId, requestId, outcome } = {}) {
    const record = requireClaim(claimId)
    const result = settleAnswer(record, requestId, outcome)
    if (!result.ok) {
      if (result.code === 'request-not-pending' && typeof requestId === 'string') {
        raise('request-not-pending', 'the request is not pending (already settled or cancelled)')
      }
      if (result.code === 'invalid-request') raise('invalid-request', 'requestId must be a non-empty string')
      raise('outcome-not-supported', 'outcome must be allowed-once or rejected')
    }
    return { claimId: record.claimId, requestId, outcome, settledAt: now() }
  }

  function status({ claimId } = {}) {
    if (disposed) {
      return { claim: null, connected: false, pendingCount: 0, maxPending, pending: [] }
    }
    if (claim === null) {
      if (claimId !== undefined && claimId !== null) raise('claim-mismatch', 'no active claim')
      return { claim: null, connected: false, pendingCount: 0, maxPending, pending: [] }
    }
    if (claimId !== undefined && claimId !== null && claimId !== claim.claimId) {
      raise('claim-mismatch', 'claimId does not match the active claim')
    }
    if (now() >= claim.expiresAt) {
      expireNow(claim)
      return { claim: null, connected: false, pendingCount: 0, maxPending, pending: [] }
    }
    return {
      claim: recordView(claim),
      connected: claim.connected,
      pendingCount: claim.pending.size,
      maxPending,
      pending: [...claim.pending.values()].map((pending) => pendingView(claim, pending)),
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const record = claim
    claim = null
    if (record === null) return
    record.active = false
    cancelTimer(record)
    delegateAll(record, 'disposed')
    await closeHandle(record, record.handle, 'disposed')
  }

  return { claim: claimSession, heartbeat, release, answer, status, dispose }
}
