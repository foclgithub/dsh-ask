/**
 * Route-level tests for `/local-cli/permissions`, `/local-cli/awaiting` and
 * `/local-cli/answer`.
 *
 * The Host services are mocked, so these tests assert what the bridge itself
 * does: read only the whitelisted projection/catalog fields, switch presets
 * through the real `/permission` command path with post-write verification,
 * and answer only a `continued` question whose callId is still projected.
 * Approve/reject labels are ordinary offered options: the bridge forwards the
 * user's explicit labels and never invents a decision.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { displayText, exactText, validateAnswerBatch } from '../permissions.js'
import { apply } from '../index.js'

const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-local-cli-permissions-'))
process.env.DSH_HOME = DSH_HOME

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

function makeRequest({ method = 'GET', token, url = '/', body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { 'x-local-cli-token': token },
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const CATALOG = {
  options: [
    { value: 'read-only', name: 'Read only', description: 'No writes' },
    { value: 'workspace-write', name: 'Workspace write', description: 'Write in the workspace' },
    { value: 'danger-full-access', name: 'Full access', description: 'No approval prompts' },
  ],
  defaultOptions: [
    { value: 'read-only', name: 'Read only' },
    { value: 'workspace-write', name: 'Workspace write' },
    { value: 'danger-full-access', name: 'Full access' },
  ],
  defaultPreset: 'workspace-write',
}

function continuedQuestion() {
  return {
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
    settled: [],
  }
}

/** One fake Host context with the services the permission routes consume. */
async function createEnv(options = {}) {
  const routes = new Map()
  const calls = { execute: [], answer: [], projections: [] }
  let currentValue = options.currentValue ?? 'workspace-write'
  const agents = new Map([
    ['session-1', { id: 'session-1' }],
    ['session-2', { id: 'session-2' }],
  ])
  const projected = options.userQuestions === undefined ? { active: [], settled: [] } : options.userQuestions

  const ctx = {
    effect(fn) {
      const disposer = fn()
      return disposer ?? (() => {})
    },
    logger() {
      return { warn() {} }
    },
    get(name) {
      if (name === 'permissionPresets' && options.noPermissionPresets !== true) {
        return {
          catalog() {
            if (options.catalog !== undefined) return options.catalog
            return CATALOG
          },
        }
      }
      if (name === 'commands' && options.noCommands !== true) {
        return {
          async execute(agent, line) {
            calls.execute.push({ agent, line })
            if (options.executeResult !== undefined) return options.executeResult
            if (options.executeThrows !== undefined) throw options.executeThrows
            if (options.projectionAfterSet !== undefined) {
              currentValue = options.projectionAfterSet
            } else {
              currentValue = line.slice('/permission '.length)
            }
            return { commandId: 'c1', result: { kind: 'success', text: `preset ${currentValue}` } }
          },
        }
      }
      if (name === 'agents' && options.noAgents !== true) {
        const registry = options.noLiveAgent === true ? new Map() : agents
        return { get: (id) => registry.get(id) }
      }
      if (name === 'userQuestions' && options.noUserQuestions !== true) {
        return {
          answer(agent, callId, answer) {
            calls.answer.push({ agent, callId, answer })
            if (options.answerThrows !== undefined) throw options.answerThrows
            return options.answerResult ?? true
          },
        }
      }
      return undefined
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
        return { items: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] }
      },
      async projections(request) {
        calls.projections.push(request)
        return {
          kind: 'sequenced',
          asOfSeq: 5,
          values: {
            permissions: { currentValue },
            userQuestions: projected,
          },
        }
      },
      async state() {
        return options.state ?? { cursor: 1, active: true, running: false, queue: [], pendingInput: [] }
      },
    },
  }
  apply(ctx)
  const token = await waitForToken()
  return { routes, calls, token, agent: agents.get('session-1') }
}

async function call(env, path, { method = 'GET', body, token, query = '' } = {}) {
  const handler = env.routes.get(path)
  assert.equal(typeof handler, 'function', `${path} route must be registered`)
  const res = makeResponse()
  await handler(
    makeRequest({ method, token: token ?? env.token, url: `${path}${query}`, body }),
    res,
  )
  return { res, body: JSON.parse(res.text) }
}

test('GET permissions returns the whitelisted current value and catalog', async () => {
  const env = await createEnv()
  const { res, body } = await call(env, '/local-cli/permissions', { query: '?sessionId=session-1' })

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.permission.currentValue, 'workspace-write')
  assert.equal(body.permission.label, 'Workspace write')
  assert.equal(body.permission.defaultPreset, 'workspace-write')
  assert.deepEqual(
    body.permission.options.map((option) => option.value),
    ['read-only', 'workspace-write', 'danger-full-access'],
  )
  assert.equal(body.canSet, true)
  assert.equal(body.source, 'projections+permissionPresets.catalog')
  assert.equal(JSON.stringify(body).includes('defaultOptions'), false)
  assert.equal(JSON.stringify(body).includes('callId'), false)
})

test('GET permissions rejects an unknown Session and a missing reference', async () => {
  const env = await createEnv()
  const missing = await call(env, '/local-cli/permissions')
  assert.equal(missing.res.status, 400)
  assert.equal(missing.body.code, 'invalid-body')

  const unknown = await call(env, '/local-cli/permissions', { query: '?sessionId=nope' })
  assert.equal(unknown.res.status, 404)
  assert.equal(unknown.body.code, 'no-such-session')
})

test('GET permissions refuses a malformed catalog instead of inventing options', async () => {
  const env = await createEnv({ catalog: { options: 'not-an-array' } })
  const { res, body } = await call(env, '/local-cli/permissions', { query: '?sessionId=session-1' })
  assert.equal(res.status, 502)
  assert.equal(body.code, 'schema-invalid')
})

test('POST permissions switches through the /permission command', async () => {
  const env = await createEnv()
  const { res, body } = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only' },
  })

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.preset, 'read-only')
  assert.equal(body.matched, true)
  assert.equal(env.calls.execute.length, 1)
  assert.equal(env.calls.execute[0].line, '/permission read-only')
  assert.equal(env.calls.execute[0].agent, env.agent)
  // The response carries the post-write projection, not an assumed value.
  const read = await call(env, '/local-cli/permissions', { query: '?sessionId=session-1' })
  assert.equal(read.body.permission.currentValue, 'read-only')
})

test('POST permissions rejects unknown presets without running a command', async () => {
  const env = await createEnv()
  const { res, body } = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'custom' },
  })
  assert.equal(res.status, 400)
  assert.equal(body.code, 'unknown-preset')
  assert.equal(env.calls.execute.length, 0)
})

test('POST permissions requires confirmation for high-impact presets', async () => {
  const env = await createEnv()
  const denied = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'danger-full-access' },
  })
  assert.equal(denied.res.status, 409)
  assert.equal(denied.body.code, 'confirmation-required')
  assert.equal(env.calls.execute.length, 0)

  const confirmed = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'danger-full-access', confirmed: true },
  })
  assert.equal(confirmed.res.status, 200)
  assert.equal(env.calls.execute[0].line, '/permission danger-full-access')
})

test('POST permissions rejects unknown fields and a non-live Session', async () => {
  const env = await createEnv({ noLiveAgent: true })
  const extra = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only', approval: 'never' },
  })
  assert.equal(extra.res.status, 400)
  assert.equal(extra.body.code, 'invalid-body')

  const cold = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only' },
  })
  assert.equal(cold.res.status, 409)
  assert.equal(cold.body.code, 'session-not-live')
  assert.equal(env.calls.execute.length, 0)
})

test('POST permissions reports a missing command surface and a command rejection', async () => {
  const noCommand = await createEnv({ noCommands: true })
  const missing = await call(noCommand, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only' },
  })
  assert.equal(missing.res.status, 501)
  assert.equal(missing.body.code, 'permission-unavailable')

  const rejecting = await createEnv({ executeResult: { commandId: 'c1', result: { kind: 'error', text: 'unknown preset' } } })
  const failed = await call(rejecting, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only' },
  })
  assert.equal(failed.res.status, 409)
  assert.equal(failed.body.code, 'switch-failed')
  assert.match(failed.body.error, /unknown preset/)
})

test('POST permissions refuses to report success when the projection disagrees', async () => {
  const env = await createEnv({ projectionAfterSet: 'workspace-write' })
  const { res, body } = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: 'read-only' },
  })
  assert.equal(res.status, 409)
  assert.equal(body.code, 'switch-unverified')
  assert.match(body.error, /workspace-write/)
})

test('GET awaiting maps pending kinds, questions and the approval limitation', async () => {
  const env = await createEnv({
    userQuestions: continuedQuestion(),
    state: { running: true, pendingInput: ['question', 'approval', 'bogus'] },
  })
  const { res, body } = await call(env, '/local-cli/awaiting', { query: '?sessionId=session-1' })

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.pendingInput, ['question', 'approval'])
  assert.equal(body.running, true)
  assert.equal(body.answerable, true)
  assert.equal(body.questions.settledCount, 0)
  assert.equal(body.questions.active[0].callId, 'call-1')
  assert.equal(body.questions.active[0].state, 'continued')
  assert.deepEqual(
    body.questions.active[0].questions[0].options.map((option) => option.label),
    ['Approve', 'Reject'],
  )
  assert.equal(body.approvals.supported, false)
  assert.equal(body.approvals.present, true)
  assert.match(body.approvals.reason, /desktop/)
})

test('GET awaiting treats a missing projection as no questions and rejects a malformed one', async () => {
  const empty = await createEnv({ state: { running: false, pendingInput: [] } })
  const none = await call(empty, '/local-cli/awaiting', { query: '?sessionId=session-1' })
  assert.equal(none.res.status, 200)
  assert.deepEqual(none.body.questions.active, [])
  assert.equal(none.body.answerable, false)

  const broken = await createEnv({ userQuestions: { active: 'nope', settled: [] } })
  const bad = await call(broken, '/local-cli/awaiting', { query: '?sessionId=session-1' })
  assert.equal(bad.res.status, 502)
  assert.equal(bad.body.code, 'schema-invalid')
})

test('POST answer submits an explicit approve label for a continued question', async () => {
  const env = await createEnv({ userQuestions: continuedQuestion() })
  const { res, body } = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.accepted, true)
  assert.equal(body.callId, 'call-1')
  assert.equal(env.calls.answer.length, 1)
  assert.equal(env.calls.answer[0].callId, 'call-1')
  assert.deepEqual(env.calls.answer[0].answer, { answers: [{ id: 'q1', selected: ['Approve'] }] })
})

test('POST answer forwards an explicit reject label unchanged', async () => {
  const env = await createEnv({ userQuestions: continuedQuestion() })
  const { res, body } = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Reject'] }] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(env.calls.answer[0].answer, { answers: [{ id: 'q1', selected: ['Reject'] }] })
  assert.equal(body.accepted, true)
})

test('POST answer refuses a blocking (open) question without touching the service', async () => {
  const payload = continuedQuestion()
  payload.active[0].state = 'open'
  const env = await createEnv({ userQuestions: payload })
  const { res, body } = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(res.status, 409)
  assert.equal(body.code, 'not-answerable')
  assert.match(body.error, /desktop/)
  assert.equal(env.calls.answer.length, 0)
})

test('POST answer rejects stale callIds, unknown labels and uncovered questions', async () => {
  const env = await createEnv({ userQuestions: continuedQuestion() })
  const stale = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-9', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(stale.res.status, 404)
  assert.equal(stale.body.code, 'stale-request')

  const label = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Maybe'] }] },
  })
  assert.equal(label.res.status, 400)
  assert.equal(label.body.code, 'label-not-offered')

  const missing = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [] },
  })
  assert.equal(missing.res.status, 400)
  assert.equal(missing.body.code, 'invalid-answer')

  const extra = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'], note: 'x' }] },
  })
  assert.equal(extra.res.status, 400)
  assert.equal(extra.body.code, 'invalid-answer')

  assert.equal(env.calls.answer.length, 0)
})

test('POST answer surfaces queued replies and a vanished continuation', async () => {
  const queued = new Error('a reply is already queued for this question')
  queued.code = 'REPLY_QUEUED'
  const queuedEnv = await createEnv({ userQuestions: continuedQuestion(), answerThrows: queued })
  const busy = await call(queuedEnv, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(busy.res.status, 409)
  assert.equal(busy.body.code, 'reply-queued')

  const goneEnv = await createEnv({ userQuestions: continuedQuestion(), answerResult: false })
  const gone = await call(goneEnv, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(gone.res.status, 409)
  assert.equal(gone.body.code, 'stale-request')
})

test('new routes require the loopback token', async () => {
  const env = await createEnv({ userQuestions: continuedQuestion() })
  const cases = [
    ['/local-cli/permissions', { query: '?sessionId=session-1' }],
    ['/local-cli/permissions', { method: 'POST', body: { sessionId: 'session-1', preset: 'read-only' } }],
    ['/local-cli/awaiting', { query: '?sessionId=session-1' }],
    ['/local-cli/answer', { method: 'POST', body: { sessionId: 'session-1', callId: 'call-1', answers: [] } }],
  ]
  for (const [path, init] of cases) {
    const missing = await call(env, path, { ...init, token: '' })
    assert.equal(missing.res.status, 401, path)
    assert.equal(missing.body.ok, false)
    const wrong = await call(env, path, { ...init, token: 'not-the-token' })
    assert.equal(wrong.res.status, 401, path)
  }
  assert.equal(env.calls.answer.length, 0)
  assert.equal(env.calls.execute.length, 0)
})

function codeOf(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error.code ?? error.message
  }
}

test('answer batches keep labels and custom text byte-for-byte', () => {
  const target = {
    callId: 'call-1',
    state: 'continued',
    questions: [{ id: 'q 1', question: 'Why?', options: [{ label: ' Approve ' }, { label: 'Reject' }] }],
  }
  const ok = validateAnswerBatch([{ id: 'q 1', selected: [' Approve '], custom: '  a note ' }], target)
  assert.deepEqual(ok, [{ id: 'q 1', selected: [' Approve '], custom: '  a note ' }])
  assert.equal(codeOf(() => validateAnswerBatch([{ id: 'q 1', selected: ['Approve'] }], target)), 'label-not-offered')
  assert.equal(codeOf(() => validateAnswerBatch([{ id: 'q 1', selected: [' Reject'] }], target)), 'label-not-offered')
})

test('overlong custom text is rejected, never truncated', () => {
  const target = {
    callId: 'call-1',
    state: 'continued',
    questions: [{ id: 'q1', question: 'Why?', options: [{ label: 'Approve' }] }],
  }
  assert.equal(codeOf(() => validateAnswerBatch([{ id: 'q1', selected: [], custom: 'x'.repeat(513) }], target)), 'invalid-answer')
  const exact = 'y'.repeat(512)
  assert.deepEqual(validateAnswerBatch([{ id: 'q1', selected: [], custom: exact }], target), [
    { id: 'q1', selected: [], custom: exact },
  ])
  assert.equal(codeOf(() => validateAnswerBatch([{ id: 'q1', selected: [], custom: '   ' }], target)), 'invalid-answer')
})

test('a question without options accepts no selected label, only custom or skip', () => {
  const target = { callId: 'call-1', state: 'continued', questions: [{ id: 'q1', question: 'Why?' }] }
  assert.equal(codeOf(() => validateAnswerBatch([{ id: 'q1', selected: ['anything'] }], target)), 'label-not-offered')
  assert.deepEqual(validateAnswerBatch([{ id: 'q1', selected: [], custom: 'because' }], target), [
    { id: 'q1', selected: [], custom: 'because' },
  ])
  assert.deepEqual(validateAnswerBatch([{ id: 'q1', selected: [] }], target), [{ id: 'q1', selected: [] }])
})

test('helper splits display sanitization from exact wire values', () => {
  assert.equal(displayText('a\u0000b', 10), 'a b')
  assert.equal(displayText('   ', 10), null)
  assert.equal(exactText(' Approve ', 20), ' Approve ')
  assert.equal(exactText('a\u0000b', 20), null)
  assert.equal(exactText('x'.repeat(30), 20), null)
  assert.equal(exactText('', 20), null)
})

test('GET awaiting rejects unsafe identifiers, duplicate ids and duplicate labels', async () => {
  const unsafe = continuedQuestion()
  unsafe.active[0].questions[0].options[0].label = 'Approve\u0000now'
  const unsafeEnv = await createEnv({ userQuestions: unsafe })
  const unsafeRead = await call(unsafeEnv, '/local-cli/awaiting', { query: '?sessionId=session-1' })
  assert.equal(unsafeRead.res.status, 502)
  assert.equal(unsafeRead.body.code, 'schema-invalid')

  const duplicateIds = continuedQuestion()
  duplicateIds.active[0].questions.push({ id: 'q1', question: 'Second?' })
  const dupEnv = await createEnv({ userQuestions: duplicateIds })
  const dupRead = await call(dupEnv, '/local-cli/awaiting', { query: '?sessionId=session-1' })
  assert.equal(dupRead.res.status, 502)
  assert.match(dupRead.body.error, /repeated/)

  const duplicateLabels = continuedQuestion()
  duplicateLabels.active[0].questions[0].options.push({ label: 'Approve', description: 'again' })
  const labelEnv = await createEnv({ userQuestions: duplicateLabels })
  const labelRead = await call(labelEnv, '/local-cli/awaiting', { query: '?sessionId=session-1' })
  assert.equal(labelRead.res.status, 502)
  assert.match(labelRead.body.error, /repeats option label/)
})

test('POST answer requires the exact projected label and skips sanitization', async () => {
  const payload = continuedQuestion()
  payload.active[0].questions[0].options = [{ label: ' Approve ' }, { label: 'Reject' }]
  const env = await createEnv({ userQuestions: payload })
  const spaced = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: [' Approve '] }] },
  })
  assert.equal(spaced.res.status, 200)
  assert.deepEqual(env.calls.answer[0].answer, { answers: [{ id: 'q1', selected: [' Approve '] }] })

  const trimmed = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(trimmed.res.status, 400)
  assert.equal(trimmed.body.code, 'label-not-offered')
})

test('POST permissions rejects a preset that only differs by whitespace', async () => {
  const env = await createEnv()
  const { res, body } = await call(env, '/local-cli/permissions', {
    method: 'POST',
    body: { sessionId: 'session-1', preset: ' read-only ' },
  })
  assert.equal(res.status, 400)
  assert.equal(body.code, 'unknown-preset')
  assert.equal(env.calls.execute.length, 0)
})

test('POST answer reports an approval-only Session as unsupported', async () => {
  const env = await createEnv({ state: { running: true, pendingInput: ['approval'] } })
  const { res, body } = await call(env, '/local-cli/answer', {
    method: 'POST',
    body: { sessionId: 'session-1', callId: 'call-approval', answers: [{ id: 'q1', selected: ['Approve'] }] },
  })
  assert.equal(res.status, 501)
  assert.equal(body.code, 'approval-answer-unsupported')
  assert.equal(env.calls.answer.length, 0)
})
