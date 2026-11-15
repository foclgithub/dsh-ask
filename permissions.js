/**
 * Permission-preset and pending-answer routes for the loopback bridge.
 *
 * The contract lives in the repository at `docs/permissions.md`; it was derived
 * from the installed Harness 0.2.2-rc.1 sources (permission-presets,
 * user-approval, user-questions, session-controller, api-gateway, commands).
 *
 * Two rules shape this module:
 *
 * 1. Wire values are exact. Session ids, callIds, question ids and option
 *    labels are compared and returned byte-for-byte, because the Host matches
 *    them by identity. Nothing is trimmed, collapsed or truncated on its way to
 *    the Host; a value that cannot round-trip safely is rejected as
 *    `schema-invalid` instead. Only display-only text (question copy, detail,
 *    header, descriptions) is sanitized, and that text is never sent back.
 * 2. Answers are only what the user explicitly chose. The bridge forwards an
 *    answer batch to `ctx.userQuestions.answer` for a `continued` question and
 *    nothing else: open questions and tool approvals are held by the live
 *    Remote Event waterfall and have no host-side answer API in this build.
 *
 * Host-supplied strings that are not part of the whitelist never leave the
 * Host process; the route responses are the DTO in `docs/permissions.md`.
 */

/** Shipped presets that widen how broadly the agent may act; the desktop UI confirms both. */
export const CONFIRMED_PRESETS = new Set(['danger-full-access', 'auto'])

/** Cap for a free-text answer; longer text is rejected, never truncated. */
export const ANSWER_TEXT_MAX = 512

const PRESET_MAX = 64
const IDENTIFIER_MAX = 200
const QUESTION_MAX = 2000
const DETAIL_MAX = 4000
const HEADER_MAX = 64
const DESCRIPTION_MAX = 256
const TEXT_MAX = 4096

class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}

/**
 * Display-only copy: control characters stripped, spaces collapsed, capped and
 * trimmed. Never use the result as a wire identifier or an answer value.
 */
export function displayText(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return null
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  return text === '' ? null : text
}

/**
 * Exact wire value: a non-empty string within the cap that carries no control
 * characters. It is returned unchanged, never normalized, so a caller can send
 * it back and the Host will match the same identity.
 */
export function exactText(value, max) {
  if (typeof value !== 'string' || value === '') return null
  if (value.length > max) return null
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return null
  return value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject request bodies that carry keys this route does not understand. */
function assertKeys(body, allowed, label, code = 'invalid-body') {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new RouteError(400, code, `${label} has an unknown field ${JSON.stringify(key)}`)
    }
  }
}

/**
 * Read the process permission catalog through the Host service, normalizing it
 * to the client whitelist. Preset values are wire identities and stay exact;
 * names and descriptions are display copy. A missing service, a malformed
 * entry, or duplicate values are explicit failures instead of guessed options.
 */
export function catalogView(catalog) {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.options)) {
    throw new RouteError(502, 'schema-invalid', 'permission catalog has an unexpected shape')
  }
  const options = []
  const seen = new Set()
  for (const option of catalog.options) {
    if (!isPlainObject(option)) {
      throw new RouteError(502, 'schema-invalid', 'permission catalog option is not an object')
    }
    const value = exactText(option.value, PRESET_MAX)
    if (value === null) {
      throw new RouteError(502, 'schema-invalid', 'permission catalog option has no exact value')
    }
    if (seen.has(value)) {
      throw new RouteError(502, 'schema-invalid', `permission catalog repeats preset ${JSON.stringify(value)}`)
    }
    seen.add(value)
    const name = displayText(option.name, PRESET_MAX) ?? value
    const description = displayText(option.description, DESCRIPTION_MAX)
    options.push({ value, name, ...(description === null ? {} : { description }) })
  }
  return {
    options,
    defaultPreset: displayText(catalog.defaultPreset, PRESET_MAX),
  }
}

/** Wire view of one Session's current permission selection plus the catalog. */
export function permissionsPayload({ sessionId, currentValue, catalog }) {
  const view = catalogView(catalog)
  const value = exactText(currentValue, PRESET_MAX)
  const option = value === null ? undefined : view.options.find((item) => item.value === value)
  return {
    sessionId,
    permission: {
      currentValue: value,
      label: option === undefined ? null : option.name,
      options: view.options,
      defaultPreset: view.defaultPreset,
    },
  }
}

function cleanOption(option, questionId) {
  if (!isPlainObject(option)) {
    throw new RouteError(502, 'schema-invalid', `question ${JSON.stringify(questionId)} option is not an object`)
  }
  const label = exactText(option.label, IDENTIFIER_MAX)
  if (label === null) {
    throw new RouteError(
      502,
      'schema-invalid',
      `question ${JSON.stringify(questionId)} has an option label that cannot be answered exactly`,
    )
  }
  const description = displayText(option.description, DESCRIPTION_MAX)
  return { label, ...(description === null ? {} : { description }) }
}

/**
 * Normalize one projected pending question batch. Identifiers and labels stay
 * exact; display copy is sanitized; duplicate callIds, question ids or option
 * labels are ambiguous and rejected.
 */
export function questionView(item, seen) {
  if (!isPlainObject(item)) {
    throw new RouteError(502, 'schema-invalid', 'pending question is not an object')
  }
  const callId = exactText(item.callId, IDENTIFIER_MAX)
  if (callId === null) {
    throw new RouteError(502, 'schema-invalid', 'pending question has no exact callId')
  }
  if (seen.callIds.has(callId)) {
    throw new RouteError(502, 'schema-invalid', `pending question repeats callId ${JSON.stringify(callId)}`)
  }
  seen.callIds.add(callId)
  if (item.state !== 'open' && item.state !== 'continued') {
    throw new RouteError(502, 'schema-invalid', `pending question has unknown state ${JSON.stringify(item.state)}`)
  }
  if (!Array.isArray(item.questions) || item.questions.length === 0) {
    throw new RouteError(502, 'schema-invalid', `pending question ${JSON.stringify(callId)} has no questions`)
  }
  const questions = item.questions.map((question) => {
    if (!isPlainObject(question)) {
      throw new RouteError(502, 'schema-invalid', 'question entry is not an object')
    }
    const id = exactText(question.id, IDENTIFIER_MAX)
    if (id === null) {
      throw new RouteError(502, 'schema-invalid', `question in ${JSON.stringify(callId)} has no exact id`)
    }
    if (seen.questionIds.has(id)) {
      throw new RouteError(502, 'schema-invalid', `question id ${JSON.stringify(id)} is repeated`)
    }
    seen.questionIds.add(id)
    const text = displayText(question.question, QUESTION_MAX)
    if (text === null) {
      throw new RouteError(502, 'schema-invalid', `question ${JSON.stringify(id)} has no display text`)
    }
    let options
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) {
        throw new RouteError(502, 'schema-invalid', `question ${JSON.stringify(id)} options is not an array`)
      }
      options = question.options.map((option) => cleanOption(option, id))
      const labels = new Set()
      for (const option of options) {
        if (labels.has(option.label)) {
          throw new RouteError(
            502,
            'schema-invalid',
            `question ${JSON.stringify(id)} repeats option label ${JSON.stringify(option.label)}`,
          )
        }
        labels.add(option.label)
      }
    }
    const detail = displayText(question.detail, DETAIL_MAX)
    const header = displayText(question.header, HEADER_MAX)
    return {
      id,
      question: text,
      ...(detail === null ? {} : { detail }),
      ...(header === null ? {} : { header }),
      ...(options === undefined ? {} : { options }),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }
  })
  return { callId, state: item.state, questions }
}

/**
 * Build the pending-input view from the passive state and the `userQuestions`
 * projection. Missing projections mean "no pending questions" (older Host); a
 * projection that exists but does not match the schema is rejected.
 */
export function awaitingPayload({ sessionId, state, userQuestions }) {
  const kinds = Array.isArray(state?.pendingInput)
    ? [...new Set(state.pendingInput.filter((kind) => kind === 'approval' || kind === 'question' || kind === 'other'))]
    : []
  let active = []
  let settledCount = 0
  if (userQuestions !== undefined && userQuestions !== null) {
    if (!isPlainObject(userQuestions) || !Array.isArray(userQuestions.active) || !Array.isArray(userQuestions.settled)) {
      throw new RouteError(502, 'schema-invalid', 'userQuestions projection has an unexpected shape')
    }
    const seen = { callIds: new Set(), questionIds: new Set() }
    active = userQuestions.active.map((item) => questionView(item, seen))
    settledCount = userQuestions.settled.length
  }
  return {
    sessionId,
    running: state?.running === true,
    pendingInput: kinds,
    questions: { active, settledCount },
    approvals: {
      supported: false,
      present: kinds.includes('approval'),
      reason: 'this Harness build exposes no host-side approval read/answer API; confirm approvals in the desktop app',
    },
    answerable: active.some((item) => item.state === 'continued'),
  }
}

/**
 * Validate one answer against its projected question. The selected labels are
 * matched byte-for-byte against the offered labels; a question without options
 * accepts no label at all (only `custom` or an explicit skip). `custom` is
 * rejected when it exceeds the cap instead of being truncated.
 */
function answerItem(answer, question) {
  if (!isPlainObject(answer)) {
    throw new RouteError(400, 'invalid-answer', 'each answer must be an object')
  }
  assertKeys(answer, ['id', 'selected', 'custom'], 'answer', 'invalid-answer')
  if (typeof answer.id !== 'string' || answer.id === '') {
    throw new RouteError(400, 'invalid-answer', 'each answer needs a question id')
  }
  if (answer.id !== question.id) {
    throw new RouteError(400, 'invalid-answer', `answer id ${JSON.stringify(answer.id)} does not belong to this request`)
  }
  if (!Array.isArray(answer.selected) || answer.selected.some((label) => typeof label !== 'string')) {
    throw new RouteError(400, 'invalid-answer', `answer for ${JSON.stringify(answer.id)} needs a string selected array`)
  }
  if (answer.custom !== undefined && typeof answer.custom !== 'string') {
    throw new RouteError(400, 'invalid-answer', `answer for ${JSON.stringify(answer.id)} has a non-string custom field`)
  }
  const offered = new Set((question.options ?? []).map((option) => option.label))
  const selected = []
  for (const label of answer.selected) {
    if (selected.includes(label)) {
      throw new RouteError(400, 'invalid-answer', `answer for ${JSON.stringify(answer.id)} repeats label ${JSON.stringify(label)}`)
    }
    if (offered.size === 0) {
      throw new RouteError(
        400,
        'label-not-offered',
        `question ${JSON.stringify(answer.id)} offers no options; use custom text or skip it`,
      )
    }
    if (!offered.has(label)) {
      throw new RouteError(
        400,
        'label-not-offered',
        `label ${JSON.stringify(label)} is not offered by question ${JSON.stringify(answer.id)}`,
      )
    }
    selected.push(label)
  }
  if (question.multiSelect !== true && selected.length > 1) {
    throw new RouteError(400, 'invalid-answer', `question ${JSON.stringify(answer.id)} does not allow multiple selections`)
  }
  let custom
  if (answer.custom !== undefined) {
    if (answer.custom.length > ANSWER_TEXT_MAX) {
      throw new RouteError(
        400,
        'invalid-answer',
        `custom text for ${JSON.stringify(answer.id)} is ${answer.custom.length} characters; the limit is ${ANSWER_TEXT_MAX}`,
      )
    }
    if (answer.custom.trim() === '') {
      throw new RouteError(400, 'invalid-answer', `custom text for ${JSON.stringify(answer.id)} is empty`)
    }
    custom = answer.custom
  }
  return { id: answer.id, selected, ...(custom === undefined ? {} : { custom }) }
}

/**
 * Validate a whole answer batch against the projected question batch.
 *
 * The Host service checks the ids as well, but it does not check that a label
 * was offered, so the bridge does both here and the route re-reads the
 * projection immediately before submitting to keep the request fresh.
 */
export function validateAnswerBatch(input, target) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RouteError(400, 'invalid-answer', 'answers must be a non-empty array')
  }
  const questions = target.questions
  if (input.length !== questions.length) {
    throw new RouteError(
      400,
      'invalid-answer',
      `this request has ${questions.length} question(s); the answer batch names ${input.length}`,
    )
  }
  const byId = new Map(questions.map((question) => [question.id, question]))
  const answers = []
  const answered = new Set()
  for (const answer of input) {
    if (!isPlainObject(answer) || typeof answer.id !== 'string') {
      throw new RouteError(400, 'invalid-answer', 'each answer must name a question id')
    }
    const question = byId.get(answer.id)
    if (question === undefined) {
      throw new RouteError(400, 'invalid-answer', `answer id ${JSON.stringify(answer.id)} does not belong to this request`)
    }
    if (answered.has(question.id)) {
      throw new RouteError(400, 'invalid-answer', `question ${JSON.stringify(question.id)} is answered twice`)
    }
    answered.add(question.id)
    answers.push(answerItem(answer, question))
  }
  if (answers.length !== questions.length) {
    throw new RouteError(400, 'invalid-answer', 'every question of the request must be answered exactly once')
  }
  return answers
}

/** Normalize a thrown service failure into a status/code pair. */
export function answerFailure(error) {
  if (error instanceof RouteError) return error
  const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'BAD_ANSWER') return new RouteError(400, 'invalid-answer', message)
  if (code === 'REPLY_QUEUED') return new RouteError(409, 'reply-queued', message)
  if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') {
    return new RouteError(409, 'session-not-live', message)
  }
  if (code === 'ASK_ABORTED' || code === 'ASK_TIMED_OUT') {
    return new RouteError(409, 'not-answerable', message)
  }
  if (code === 'NO_PROVIDER') return new RouteError(501, 'answer-unavailable', message)
  return new RouteError(500, 'answer-failed', message)
}

/** Resolve one Host service or fail with an explicit availability code. */
function serviceOf(ctx, name, code = 'permission-unavailable') {
  let service
  try {
    service = ctx.get(name)
  } catch {
    service = undefined
  }
  if (service === undefined || service === null) {
    throw new RouteError(501, code, `${name} is not available in this Host profile`)
  }
  return service
}

/**
 * Read one Session's projection values. The read is the same passive call the
 * status route uses; a failing read degrades to an empty map so callers decide
 * what is missing instead of surfacing a transport error as a permission fact.
 */
async function projectionValues(ctx, sessionId, signal) {
  const projected = await ctx.sessionController.projections({ sessionId }, signal)
  return isPlainObject(projected?.values) ? projected.values : {}
}

/** A request Session reference; it is never normalized, only checked. */
function exactReference(value) {
  return exactText(value, IDENTIFIER_MAX)
}

/**
 * Register the three routes on the Host's loopback listener.
 *
 * @param ctx - the bridge plugin context.
 * @param helpers - the bridge's own authorize/reply/readJsonBody/resolveSession/abort helpers,
 *   passed in so this module shares one auth and JSON boundary with the other routes.
 */
export function registerPermissionRoutes(ctx, helpers) {
  const { authorize, reply, readJsonBody, resolveSession, abort } = helpers

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
    const message = error instanceof Error ? error.message : String(error)
    return reply(res, 500, { ok: false, code: 'internal-error', error: message })
  }

  async function readSession(url) {
    const reference = exactReference(url.searchParams.get('sessionId') ?? url.searchParams.get('session') ?? '')
    if (reference === null) {
      throw new RouteError(400, 'invalid-body', 'sessionId is required')
    }
    const resolved = await resolveSession(reference)
    if (resolved.error !== undefined) {
      throw new RouteError(404, 'no-such-session', resolved.error)
    }
    return resolved.sessionId
  }

  async function getPermissions(url) {
    const sessionId = await readSession(url)
    const permissionPresets = serviceOf(ctx, 'permissionPresets')
    let catalog
    try {
      catalog = permissionPresets.catalog()
    } catch (error) {
      throw new RouteError(501, 'permission-unavailable', error instanceof Error ? error.message : String(error))
    }
    const values = await projectionValues(ctx, sessionId, abort.signal)
    return {
      ok: true,
      ...permissionsPayload({ sessionId, currentValue: values?.permissions?.currentValue, catalog }),
      canSet: ctx.get('commands') !== undefined,
      source: 'projections+permissionPresets.catalog',
    }
  }

  async function setPermission(req) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      throw new RouteError(400, 'invalid-body', error instanceof Error ? error.message : String(error))
    }
    if (!isPlainObject(body)) throw new RouteError(400, 'invalid-body', 'request body must be a JSON object')
    assertKeys(body, ['sessionId', 'preset', 'confirmed'], 'permission request')
    const reference = exactReference(body.sessionId)
    if (reference === null) throw new RouteError(400, 'invalid-body', 'sessionId is required')
    // The preset is compared byte-for-byte against the catalog: no trimming,
    // collapsing or truncation can turn a different name into a valid one.
    if (typeof body.preset !== 'string' || body.preset === '') {
      throw new RouteError(400, 'unknown-preset', 'preset is required')
    }
    const preset = body.preset
    if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
      throw new RouteError(400, 'invalid-body', 'confirmed must be a boolean')
    }
    const permissionPresets = serviceOf(ctx, 'permissionPresets')
    const catalog = catalogView(permissionPresets.catalog())
    if (!catalog.options.some((item) => item.value === preset)) {
      throw new RouteError(
        400,
        'unknown-preset',
        `unknown preset ${JSON.stringify(preset)} (available: ${catalog.options.map((item) => item.value).join(', ')})`,
      )
    }
    if (CONFIRMED_PRESETS.has(preset) && body.confirmed !== true) {
      throw new RouteError(
        409,
        'confirmation-required',
        `preset ${JSON.stringify(preset)} changes how broadly the agent may act; repeat with confirmed:true after an explicit user decision`,
      )
    }
    const resolved = await resolveSession(reference)
    if (resolved.error !== undefined) throw new RouteError(404, 'no-such-session', resolved.error)
    const sessionId = resolved.sessionId
    const agents = serviceOf(ctx, 'agents')
    const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) {
      throw new RouteError(
        409,
        'session-not-live',
        'this Session has no live Agent; open it in the desktop app (or send it a prompt) before switching its preset',
      )
    }
    const commands = serviceOf(ctx, 'commands')
    let settled
    try {
      settled = await commands.execute(agent, `/permission ${preset}`, [], abort.signal)
    } catch (error) {
      throw new RouteError(500, 'switch-failed', error instanceof Error ? error.message : String(error))
    }
    if (settled === undefined) {
      throw new RouteError(501, 'permission-unavailable', 'this Host offers no /permission command')
    }
    if (settled?.result?.kind !== 'success') {
      const text = displayText(settled?.result?.text, TEXT_MAX) ?? 'the /permission command rejected the switch'
      throw new RouteError(409, 'switch-failed', text)
    }
    const values = await projectionValues(ctx, sessionId, abort.signal)
    const observed = exactText(values?.permissions?.currentValue, PRESET_MAX)
    if (observed !== preset) {
      throw new RouteError(
        409,
        'switch-unverified',
        `the Host recorded preset ${JSON.stringify(preset)} but the Session now reports ${JSON.stringify(observed)}; not retrying`,
      )
    }
    return {
      ok: true,
      sessionId,
      preset,
      matched: true,
      text: displayText(settled?.result?.text, TEXT_MAX),
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/permissions',
      handler: async (req, res) => {
        if ((await guard(req, res)) !== true) return
        try {
          if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            return reply(res, 200, await getPermissions(url))
          }
          if (req.method === 'POST') return reply(res, 200, await setPermission(req))
          return reply(res, 405, { ok: false, error: 'use GET or POST' })
        } catch (error) {
          return failed(res, error)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/awaiting',
      handler: async (req, res) => {
        if ((await guard(req, res)) !== true) return
        if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'use GET' })
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const sessionId = await readSession(url)
          const state = await ctx.sessionController.state({ sessionId }, abort.signal)
          const values = await projectionValues(ctx, sessionId, abort.signal)
          return reply(res, 200, {
            ok: true,
            ...awaitingPayload({ sessionId, state, userQuestions: values?.userQuestions }),
          })
        } catch (error) {
          return failed(res, error)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/local-cli/answer',
      handler: async (req, res) => {
        if ((await guard(req, res)) !== true) return
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'use POST' })
        try {
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            throw new RouteError(400, 'invalid-body', error instanceof Error ? error.message : String(error))
          }
          if (!isPlainObject(body)) throw new RouteError(400, 'invalid-body', 'request body must be a JSON object')
          assertKeys(body, ['sessionId', 'callId', 'answers'], 'answer request')
          const reference = exactReference(body.sessionId)
          if (reference === null) throw new RouteError(400, 'invalid-body', 'sessionId is required')
          const callId = exactText(body.callId, IDENTIFIER_MAX)
          if (callId === null) throw new RouteError(400, 'invalid-body', 'callId is required')
          if (!Array.isArray(body.answers)) throw new RouteError(400, 'invalid-answer', 'answers must be an array')
          const resolved = await resolveSession(reference)
          if (resolved.error !== undefined) throw new RouteError(404, 'no-such-session', resolved.error)
          const sessionId = resolved.sessionId
          // Re-read immediately before submitting: a question may have settled
          // between listing and answering, and an answer must never be applied
          // to a stale request.
          const state = await ctx.sessionController.state({ sessionId }, abort.signal)
          const values = await projectionValues(ctx, sessionId, abort.signal)
          const projected = values?.userQuestions
          if (projected !== undefined && projected !== null) {
            if (!isPlainObject(projected) || !Array.isArray(projected.active)) {
              throw new RouteError(502, 'schema-invalid', 'userQuestions projection has an unexpected shape')
            }
          }
          const seen = { callIds: new Set(), questionIds: new Set() }
          const active = (projected?.active ?? []).map((item) => questionView(item, seen))
          const target = active.find((item) => item.callId === callId)
          if (target === undefined) {
            // An approval has no callId in any readable projection: when the
            // Session is only approval-pending, say that plainly instead of
            // pretending the id is stale.
            const approvalPending =
              Array.isArray(state?.pendingInput) && state.pendingInput.includes('approval') && active.length === 0
            if (approvalPending) {
              throw new RouteError(
                501,
                'approval-answer-unsupported',
                'this Harness build exposes no host-side approval answer API; confirm the approval in the desktop app',
              )
            }
            throw new RouteError(
              404,
              'stale-request',
              `no active question has callId ${JSON.stringify(callId)}; open questions and tool approvals can only be answered in the desktop app, and a settled request cannot be answered again`,
            )
          }
          if (target.state !== 'continued') {
            throw new RouteError(
              409,
              'not-answerable',
              'this question is still blocking its tool call and is held by the desktop Remote Event waterfall; answer it in the desktop app',
            )
          }
          const answers = validateAnswerBatch(body.answers, target)
          const agents = serviceOf(ctx, 'agents', 'answer-unavailable')
          const agent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
          if (agent === undefined) {
            throw new RouteError(409, 'session-not-live', 'this Session has no live Agent to receive the answer')
          }
          const userQuestions = serviceOf(ctx, 'userQuestions', 'answer-unavailable')
          let accepted
          try {
            accepted = userQuestions.answer(agent, callId, { answers })
          } catch (error) {
            throw answerFailure(error)
          }
          if (accepted !== true) {
            throw new RouteError(409, 'stale-request', 'the question is no longer continued; nothing was submitted')
          }
          return reply(res, 200, {
            ok: true,
            sessionId,
            callId,
            accepted: true,
            source: 'userQuestions/answer',
          })
        } catch (error) {
          return failed(res, error)
        }
      },
    }),
  )

  return { paths: ['/local-cli/permissions', '/local-cli/awaiting', '/local-cli/answer'] }
}
