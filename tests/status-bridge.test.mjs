/**
 * Route-level tests for `/local-cli/status`.
 *
 * The Host services are mocked: these tests assert what the bridge itself does
 * - read only the whitelisted projections and the passive state, sanitize every
 * supplied string, and never touch the Session - without booting a Harness
 * profile. A Host without `projections` (older build) must still answer with
 * null fields so the CLI/TUI can render "—".
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

// A throwaway DSH_HOME keeps the token and endpoint files out of the real
// profile directory; the bridge mints its token under this root.
const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-local-cli-status-'))
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

function makeRequest({ method = 'GET', token, url = '/' }) {
  return {
    method,
    url,
    headers: { 'x-local-cli-token': token },
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this
    },
    async *[Symbol.asyncIterator]() {},
  }
}

/** The projection values a live Host serves for one Session. */
function projectionValues() {
  return {
    title: 'status probe',
    modelSelection: {
      lastUsed: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
      next: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
    },
    contextPressure: {
      pressureTokens: 22_000,
      projectedTokens: 24_000,
      contextWindow: 200_000,
    },
    tokenUsage: {
      uncachedInputTokens: 39_840,
      outputTokens: 160,
      cacheReadTokens: 291_840,
      cacheWriteTokens: 160,
      // Raw state keys a careless projection must never leak.
      totals: { uncachedInputTokens: 39_840 },
    },
    contextBreakdown: { systemTokens: 1_000, toolsTokens: 2_000, messageTokens: 21_000 },
    sessionStats: {
      turns: 2,
      steps: 5,
      llmMs: 12_300,
      toolMs: 900,
      ttftMs: 1_600,
      ttftSteps: 2,
      decodeMs: 9_400,
      decodeTokens: 329,
    },
    permissions: { currentValue: 'workspace-write' },
  }
}

/** One fake Host context with only the services the bridge injects. */
async function createEnv(options = {}) {
  const routes = new Map()
  const calls = { projections: [], list: [], state: [], prompt: 0, create: 0, updateQueue: 0 }
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
        return []
      },
    },
    sessionController: {
      async list() {
        calls.list.push({})
        return { items: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] }
      },
      async projections(request) {
        calls.projections.push(request)
        if (options.noProjections === true) throw new TypeError('projections is not a function')
        return { kind: 'sequenced', asOfSeq: 7, values: options.values ?? projectionValues() }
      },
      async state(request) {
        calls.state.push(request)
        return options.state ?? { cursor: 3, active: true, running: true, queue: [{ id: 'q1' }], pendingInput: ['approval', 'bogus', 'question'] }
      },
      async prompt() {
        calls.prompt += 1
      },
      async create() {
        calls.create += 1
      },
      async updateQueue() {
        calls.updateQueue += 1
      },
    },
  }
  apply(ctx)
  const token = await waitForToken()
  return { routes, calls, token }
}

async function callStatus(env, query, { method, token } = {}) {
  const handler = env.routes.get('/local-cli/status')
  assert.equal(typeof handler, 'function', 'status route must be registered')
  const res = makeResponse()
  await handler(
    makeRequest({ method, token: token ?? env.token, url: `/local-cli/status${query}` }),
    res,
  )
  return { res, body: JSON.parse(res.text) }
}

test('serves the whitelisted status fields and nothing else', async () => {
  const env = await createEnv()
  const { res, body } = await callStatus(env, '?sessionId=session-1')

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.status.model.provider, 'deepseek')
  assert.equal(body.status.model.model, 'deepseek-flash')
  assert.equal(body.status.model.effort, 'high')
  assert.deepEqual(
    body.status.context,
    { usedTokens: 24_000, contextWindow: 200_000, percent: 12, pressureTokens: 22_000, projectedTokens: 24_000 },
  )
  assert.equal(body.status.usage.uncachedInputTokens, 39_840)
  assert.equal(body.status.usage.outputTokens, 160)
  assert.equal(body.status.usage.cacheReadTokens, 291_840)
  assert.equal(body.status.usage.cacheWriteTokens, 160)
  assert.equal(body.status.usage.billedInputTokens, 331_840)
  assert.equal(body.status.usage.totalTokens, 332_000)
  assert.equal(body.status.usage.cacheHitPercent, 88)
  assert.deepEqual(body.status.stats, {
    turns: 2,
    steps: 5,
    llmMs: 12_300,
    toolMs: 900,
    ttftMs: 1_600,
    ttftSteps: 2,
    decodeMs: 9_400,
    decodeTokens: 329,
    tokensPerSecond: 35,
  })
  assert.equal(body.status.permission, 'workspace-write')
  assert.equal(body.status.running, true)
  assert.equal(body.status.queue, 1)
  assert.deepEqual(body.status.pendingInput, ['approval', 'question'], 'only whitelisted pending kinds')

  const wire = JSON.stringify(body)
  for (const forbidden of ['lastUsed', 'contextBreakdown', 'totals']) {
    assert.equal(wire.includes(forbidden), false, `raw projection key ${forbidden} must not leak`)
  }
  assert.equal(env.calls.prompt, 0)
  assert.equal(env.calls.create, 0)
  assert.equal(env.calls.updateQueue, 0)
})

test('sanitizes every Host-supplied label', async () => {
  const values = projectionValues()
  values.modelSelection.next = {
    provider: 'deep\u0000seek\n',
    model: '\u001b[31mdeepseek-flash\u001b[0m' + 'x'.repeat(200),
    reasoningEffort: 'high\u009f',
  }
  values.permissions = { currentValue: 'workspace\u0007-write' }
  const env = await createEnv({ values })
  const { body } = await callStatus(env, '?sessionId=session-1')

  assert.equal(body.status.model.provider, 'deep seek')
  assert.equal(body.status.model.model.length, 64, 'labels are capped')
  assert.equal(body.status.model.effort, 'high')
  assert.equal(body.status.permission, 'workspace -write')
  assert.doesNotMatch(JSON.stringify(body), /[\u0000-\u001f\u007f]/)
})

test('an older Host without projections answers with null fields', async () => {
  const env = await createEnv({ noProjections: true })
  const { res, body } = await callStatus(env, '?sessionId=session-1')

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.status.model, null)
  assert.equal(body.status.context, null)
  assert.equal(body.status.usage, null)
  assert.equal(body.status.stats, null)
  assert.equal(body.status.permission, null)
  assert.equal(body.status.running, true, 'the passive state still reads')
})

test('unknown Session, bad requests and missing auth are refused', async () => {
  const env = await createEnv()

  const unknown = await callStatus(env, '?sessionId=session-unknown')
  assert.equal(unknown.res.status, 404)
  assert.equal(unknown.body.code, 'no-such-session')

  const missing = await callStatus(env, '')
  assert.equal(missing.res.status, 400)

  const post = await callStatus(env, '?sessionId=session-1', { method: 'POST' })
  assert.equal(post.res.status, 405)

  const unauth = await callStatus(env, '?sessionId=session-1', { token: 'wrong' })
  assert.equal(unauth.res.status, 401)
  assert.equal(unauth.body.ok, false)
})

test('accepts the legacy `session` parameter for prefix resolution', async () => {
  const env = await createEnv()
  const { res, body } = await callStatus(env, '?session=session-')

  assert.equal(res.status, 404, 'an ambiguous prefix is not guessed')
  assert.equal(body.ok, false)
})
