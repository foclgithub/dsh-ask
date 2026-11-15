/**
 * Loopback HTTP adapter for the approval channel (item C).
 *
 * This module only translates five local-cli routes onto the already-verified
 * `approval-channel.js` state machine. It does not open connections, does not
 * answer real approvals, and never creates or disposes the channel.
 *
 * Contract: docs/permissions.md (HTTP routes) and docs/architecture.md.
 */

import { ApprovalChannelError } from './approval-channel.js'

const IDENTIFIER_MAX = 200
const RELEASE_REASONS = new Set(['user', 'shutdown', 'timeout'])

/** HTTP status per channel error code. */
const CHANNEL_STATUS = {
  'invalid-request': 400,
  'invalid-session': 400,
  'invalid-lease': 400,
  'outcome-not-supported': 400,
  'claim-conflict': 409,
  'session-not-live': 409,
  'request-not-pending': 409,
  'already-settled': 409,
  'claim-mismatch': 403,
  'claim-expired': 410,
  'agent-registry-unavailable': 501,
  'channel-unavailable': 501,
  'channel-disposed': 503,
}

class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Exact wire identifier: non-empty, no control characters, capped length. */
function exactText(value, max = IDENTIFIER_MAX) {
  if (typeof value !== 'string' || value === '' || value.length > max) return null
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return null
  return value
}

function assertKeys(body, allowed, label) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new RouteError(400, 'invalid-body', `${label} has an unknown field ${JSON.stringify(key)}`)
    }
  }
}

function channelFailure(error) {
  if (error instanceof ApprovalChannelError) {
    const status = CHANNEL_STATUS[error.code] ?? 500
    const code = status === 500 ? 'internal-error' : error.code
    return new RouteError(status, code, error.message)
  }
  return new RouteError(500, 'internal-error', 'approval channel failed')
}

function agentsService(ctx) {
  let service
  try {
    service = ctx.get('agents')
  } catch {
    service = undefined
  }
  if (service === undefined || service === null) {
    throw new RouteError(501, 'agent-registry-unavailable', 'agents is not available in this Host profile')
  }
  return service
}

/**
 * Register the five approval routes on the Host's loopback listener.
 * @param ctx - the bridge plugin context.
 * @param helpers - `{authorize, reply, readJsonBody, resolveSession, abort, channel}`.
 * @returns `{ paths }` for wiring/tests.
 */
export function registerApprovalRoutes(ctx, helpers) {
  const { authorize, reply, readJsonBody, resolveSession, channel } = helpers ?? {}
  if (typeof authorize !== 'function' || typeof reply !== 'function' || typeof readJsonBody !== 'function' || typeof resolveSession !== 'function') {
    throw new TypeError('registerApprovalRoutes requires the bridge helpers authorize/reply/readJsonBody/resolveSession')
  }
  if (channel === undefined || channel === null || typeof channel !== 'object') {
    throw new TypeError('registerApprovalRoutes requires an injected channel instance')
  }
  for (const method of ['claim', 'heartbeat', 'release', 'answer', 'status']) {
    if (typeof channel[method] !== 'function') {
      throw new TypeError(`registerApprovalRoutes channel is missing ${method}()`)
    }
  }
  if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function' || typeof ctx.webServer?.register !== 'function') {
    throw new TypeError('registerApprovalRoutes requires ctx.effect and ctx.webServer.register')
  }

  async function guard(req, res) {
    const refusal = await authorize(req)
    if (refusal !== undefined) {
      await reply(res, 401, { ok: false, error: refusal })
      return false
    }
    return true
  }

  function failed(res, error) {
    if (error instanceof RouteError) {
      return reply(res, error.status, { ok: false, code: error.code, error: error.message })
    }
    return reply(res, 500, { ok: false, code: 'internal-error', error: 'approval route failed' })
  }

  async function readBody(req, allowed, label) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      throw new RouteError(400, 'invalid-body', error instanceof Error ? error.message : String(error))
    }
    if (!isPlainObject(body)) throw new RouteError(400, 'invalid-body', 'request body must be a JSON object')
    assertKeys(body, allowed, label)
    return body
  }

  function readLease(value) {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RouteError(400, 'invalid-body', 'leaseMs must be a finite number')
    }
    return Math.floor(value)
  }

  function readId(value, field) {
    const id = exactText(value)
    if (id === null) throw new RouteError(400, 'invalid-request', `${field} must be a non-empty identifier`)
    return id
  }

  async function claimRoute(req) {
    const body = await readBody(req, ['sessionId', 'leaseMs'], 'claim request')
    const reference = readId(body.sessionId, 'sessionId')
    const leaseMs = readLease(body.leaseMs)

    let resolved
    try {
      resolved = await resolveSession(reference)
    } catch {
      throw new RouteError(500, 'route-failed', 'could not resolve the Session')
    }
    if (!isPlainObject(resolved)) throw new RouteError(500, 'route-failed', 'resolveSession returned no result')
    if (resolved.error !== undefined) throw new RouteError(404, 'no-such-session', String(resolved.error))
    const sessionId = readId(resolved.sessionId, 'resolved sessionId')

    // A claim only makes sense for a live Agent; the channel transport needs it.
    const agents = agentsService(ctx)
    const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) {
      throw new RouteError(409, 'session-not-live', 'this Session has no live Agent; open it before claiming its approvals')
    }

    let claim
    try {
      claim = await channel.claim(leaseMs === undefined ? { sessionId } : { sessionId, leaseMs })
    } catch (error) {
      throw channelFailure(error)
    }
    return {
      ok: true,
      claimId: claim.claimId,
      sessionId,
      expiresAt: claim.expiresAt,
      leaseMs: claim.leaseMs,
    }
  }

  async function heartbeatRoute(req) {
    const body = await readBody(req, ['claimId', 'leaseMs'], 'heartbeat request')
    const claimId = readId(body.claimId, 'claimId')
    const leaseMs = readLease(body.leaseMs)
    let beat
    try {
      beat = channel.heartbeat(leaseMs === undefined ? { claimId } : { claimId, leaseMs })
    } catch (error) {
      throw channelFailure(error)
    }
    return { ok: true, claimId: beat.claimId, expiresAt: beat.expiresAt, leaseMs: beat.leaseMs }
  }

  async function releaseRoute(req) {
    const body = await readBody(req, ['claimId', 'reason'], 'release request')
    const claimId = readId(body.claimId, 'claimId')
    let reason
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string' || !RELEASE_REASONS.has(body.reason)) {
        throw new RouteError(400, 'invalid-body', 'reason must be user, shutdown, or timeout')
      }
      reason = body.reason
    }
    let released
    try {
      released = await channel.release(reason === undefined ? { claimId } : { claimId, reason })
    } catch (error) {
      throw channelFailure(error)
    }
    return { ok: true, released: true, delegated: released.delegated }
  }

  async function answerRoute(req) {
    const body = await readBody(req, ['claimId', 'requestId', 'outcome'], 'answer request')
    const claimId = readId(body.claimId, 'claimId')
    const requestId = readId(body.requestId, 'requestId')
    if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') {
      throw new RouteError(400, 'outcome-not-supported', 'outcome must be allowed-once or rejected')
    }
    let settled
    try {
      settled = channel.answer({ claimId, requestId, outcome: body.outcome })
    } catch (error) {
      throw channelFailure(error)
    }
    // Deliberately not a Host acceptance: the local channel only recorded the
    // submission. The Host approval outcome is not observed by this route.
    return {
      ok: true,
      claimId,
      requestId,
      outcome: settled.outcome,
      submittedAt: settled.settledAt,
      final: false,
      note: 'submitted to the local channel; the Host result is not observed here',
    }
  }

  async function statusRoute(req) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    for (const key of url.searchParams.keys()) {
      if (key !== 'claimId') {
        throw new RouteError(400, 'invalid-body', `status query has an unknown field ${JSON.stringify(key)}`)
      }
    }
    const values = url.searchParams.getAll('claimId')
    if (values.length > 1) throw new RouteError(400, 'invalid-body', 'claimId may be given at most once')
    let claimId
    if (values.length === 1) claimId = readId(values[0], 'claimId')

    let snapshot
    try {
      if (claimId === undefined) {
        snapshot = channel.status({})
      } else {
        // Distinguish "the claim is already gone" (expired/released: report the
        // empty snapshot) from "a different claim is active" (403 mismatch).
        const base = channel.status({})
        if (base.claim === null) snapshot = base
        else if (base.claim.claimId !== claimId) {
          throw new RouteError(403, 'claim-mismatch', 'claimId does not match the active claim')
        } else snapshot = channel.status({ claimId })
      }
    } catch (error) {
      if (error instanceof RouteError) throw error
      throw channelFailure(error)
    }
    return { ok: true, ...snapshot }
  }

  const routes = [
    { path: '/local-cli/approval', method: 'GET', handler: statusRoute },
    { path: '/local-cli/approval/claim', method: 'POST', handler: claimRoute },
    { path: '/local-cli/approval/heartbeat', method: 'POST', handler: heartbeatRoute },
    { path: '/local-cli/approval/release', method: 'POST', handler: releaseRoute },
    { path: '/local-cli/approval/answer', method: 'POST', handler: answerRoute },
  ]

  for (const route of routes) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          if ((await guard(req, res)) !== true) return
          if (req.method !== route.method) {
            return reply(res, 405, { ok: false, error: `use ${route.method}` })
          }
          try {
            const payload = await route.handler(req)
            return reply(res, 200, payload)
          } catch (error) {
            return failed(res, error)
          }
        },
      }),
    )
  }

  return { paths: routes.map((route) => route.path) }
}
