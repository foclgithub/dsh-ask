/**
 * Route-level tests for image input on the loopback bridge.
 *
 * The Host services are mocked: these tests assert what the bridge itself does
 * - validate the request, then hand a real `content` array to
 * `sessionController.prompt` - without booting a Harness profile. Both prompt
 * routes (`/local-cli/ask` and `/local-cli/stream`) run the same cases, and
 * every rejected payload must leave `create`/`prompt` untouched.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import {
  IMAGE_BODY_LIMIT_BYTES,
  IMAGE_LIMITS,
  IMAGE_MEDIA_TYPES,
  buildPromptContent,
  decodeCanonicalBase64,
  imageCapabilities,
  matchesMediaType,
  validateImages,
} from '../images.js'

// A throwaway DSH_HOME keeps the token and endpoint files out of the real
// profile directory; the bridge mints its token under this root.
const DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-local-cli-images-'))
process.env.DSH_HOME = DSH_HOME

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-payload'),
])
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-payload')])
const GIF_BYTES = Buffer.from('GIF89a' + 'fake-gif-payload', 'latin1')
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from('fake-webp-payload', 'latin1'),
])

const PNG_B64 = PNG_BYTES.toString('base64')
const JPEG_B64 = JPEG_BYTES.toString('base64')
const GIF_B64 = GIF_BYTES.toString('base64')
const WEBP_B64 = WEBP_BYTES.toString('base64')

const OVERSIZE_B64 = Buffer.concat([
  PNG_BYTES.subarray(0, 8),
  Buffer.alloc(IMAGE_LIMITS.maxImageBytes),
]).toString('base64')

// Three images below the per-image cap whose sum passes the total cap.
const TOTAL_OVERSIZE_IMAGES = Array.from({ length: 3 }, () =>
  Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(4 * 1024 * 1024)]).toString('base64'),
)

const ROUTES = [
  { path: '/local-cli/ask', name: 'ask' },
  { path: '/local-cli/stream', name: 'stream' },
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

function makeRequest({ method, token, body, rawBody }) {
  const text = rawBody !== undefined ? rawBody : body === undefined ? '' : JSON.stringify(body)
  const chunks = text === '' ? [] : [Buffer.from(text)]
  const headers = { 'x-local-cli-token': token }
  if (method === 'POST') headers['content-type'] = 'application/json'
  return {
    method,
    url: '/',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** The structured failure the Host raises when the selected model rejects images. */
function remotePromptError(message = 'Model "deepseek-flash" does not support image input.') {
  return Object.assign(new Error(message), {
    name: 'RemoteError',
    code: 'session/attachment-invalid',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    isDSHRemoteError: true,
  })
}

/**
 * A fake context with just the services the bridge injects. `follow` plays a
 * complete turn: opening snapshot, the admitted user message carrying the
 * bridge-minted request id, one text delta, then `turn/end`.
 *
 * `options.promptError` makes `sessionController.prompt` throw that value, which
 * exercises the bridge's prompt-failure mapping.
 */
async function createEnv(options = {}) {
  const routes = new Map()
  const calls = { create: [], prompt: [], state: 0, wait: 0, follow: 0, list: 0 }
  const disposers = []
  let resolvePrompt
  const promptCalled = new Promise((resolve) => {
    resolvePrompt = resolve
  })

  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
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
      async create(path) {
        return { id: 'ws-1', title: 'test-workspace', path, sessionIds: [] }
      },
    },
    sessionController: {
      async list() {
        calls.list += 1
        return { items: [] }
      },
      async projections() {
        return { values: {} }
      },
      async events() {
        return { records: [], hasMore: false }
      },
      async create(request) {
        calls.create.push(request)
        return { sessionId: 'session-1' }
      },
      async state() {
        calls.state += 1
        return { running: false, pendingInput: [], cursor: 0, queue: [] }
      },
      async prompt(request) {
        calls.prompt.push(request)
        resolvePrompt()
        if (options.promptError !== undefined) throw options.promptError
      },
      async wait() {
        calls.wait += 1
        return {
          reason: 'settled',
          output: {
            records: [
              {
                type: 'event',
                event: {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: 'done' }] } },
                  seq: 1,
                },
              },
              { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'complete' } }, seq: 2 } },
            ],
          },
        }
      },
      async *follow() {
        calls.follow += 1
        yield { type: 'snapshot' }
        await promptCalled
        const requestId = String(calls.prompt.at(-1)?.requestId ?? '')
        yield { type: 'event', event: { type: 'user/message', data: { source: { rpcId: requestId } }, seq: 1 } }
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'hello' } } }
        yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'complete' } }, seq: 2 } }
      },
      async updateQueue() {},
    },
  }

  apply(ctx)
  const token = await waitForToken()
  return {
    routes,
    calls,
    token,
    dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          disposer()
        } catch {
          // A disposed route or timer must never fail teardown.
        }
      }
    },
  }
}

async function callRoute(env, path, { method = 'POST', body, rawBody } = {}) {
  const handler = env.routes.get(path)
  assert.equal(typeof handler, 'function', `route ${path} must be registered`)
  const res = makeResponse()
  await handler(makeRequest({ method, token: env.token, body, rawBody }), res)
  return res
}

function parseJson(res) {
  assert.ok(res.text.length > 0, 'response body must not be empty')
  return JSON.parse(res.text)
}

function streamFrames(res) {
  return res.text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

//#region health

test('health advertises the image capabilities without dropping old fields', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/health', { method: 'GET' })
    assert.equal(res.status, 200)
    const payload = parseJson(res)
    assert.equal(payload.ok, true)
    assert.equal(payload.origin, 'http://127.0.0.1:49188')
    assert.equal(typeof payload.pid, 'number')
    assert.equal(typeof payload.node, 'string')
    assert.equal(payload.platform, process.platform)

    assert.equal(payload.capabilities.images.supported, true)
    assert.equal(payload.capabilities.images.maxImages, 4)
    assert.equal(payload.capabilities.images.maxImageBytes, 5 * 1024 * 1024)
    assert.equal(payload.capabilities.images.maxTotalBytes, 12 * 1024 * 1024)
    assert.equal(payload.capabilities.images.bodyLimitBytes, 18 * 1024 * 1024)
    assert.deepEqual(payload.capabilities.images.mediaTypes, [...IMAGE_MEDIA_TYPES])
  } finally {
    env.dispose()
  }
})

//#endregion

//#region valid prompts

test('ask forwards a real image content part to sessionController.prompt', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/ask', {
      body: {
        text: '  describe this  ',
        images: [{ mediaType: 'image/png', data: PNG_B64, name: '  shot.png  ' }],
      },
    })
    assert.equal(res.status, 200)
    const payload = parseJson(res)
    assert.equal(payload.ok, true)
    assert.equal(payload.text, 'done')
    assert.equal(payload.sessionId, 'session-1')

    assert.equal(env.calls.create.length, 1)
    assert.equal(env.calls.prompt.length, 1)
    const prompt = env.calls.prompt[0]
    assert.equal(prompt.mode, 'queue')
    assert.equal(prompt.sessionId, 'session-1')
    assert.match(prompt.requestId, /^local-cli-.+/)
    assert.deepEqual(prompt.content, [
      { type: 'text', text: 'describe this' },
      { type: 'image', mediaType: 'image/png', data: PNG_B64, name: 'shot.png' },
    ])
  } finally {
    env.dispose()
  }
})

test('ask accepts an image-only prompt with no text part', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/ask', {
      body: { images: [{ type: 'image', mediaType: 'image/jpeg', data: JPEG_B64 }] },
    })
    assert.equal(res.status, 200)
    assert.equal(parseJson(res).ok, true)
    assert.equal(env.calls.prompt.length, 1)
    assert.deepEqual(env.calls.prompt[0].content, [
      { type: 'image', mediaType: 'image/jpeg', data: JPEG_B64 },
    ])
  } finally {
    env.dispose()
  }
})

test('ask keeps the text-only request shape unchanged', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/ask', { body: { text: 'plain text' } })
    assert.equal(res.status, 200)
    assert.equal(env.calls.prompt.length, 1)
    assert.deepEqual(env.calls.prompt[0].content, [{ type: 'text', text: 'plain text' }])
  } finally {
    env.dispose()
  }
})

test('ask still rejects a body with neither text nor images', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/ask', { body: { text: '   ' } })
    assert.equal(res.status, 400)
    const payload = parseJson(res)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'text-required')
    assert.equal(payload.error, 'text is required')
    assert.equal(env.calls.create.length, 0)
    assert.equal(env.calls.prompt.length, 0)
  } finally {
    env.dispose()
  }
})

test('stream forwards a real image content part and streams the answer', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/stream', {
      body: {
        text: 'what is this',
        images: [{ type: 'image', mediaType: 'image/webp', data: WEBP_B64, name: 'cap.webp' }],
      },
    })
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /^application\/x-ndjson/)
    assert.equal(res.ended, true)

    const frames = streamFrames(res)
    assert.deepEqual(frames[0], { t: 'session', sessionId: 'session-1' })
    assert.equal(frames.some((frame) => frame.t === 'delta' && frame.text === 'hello'), true)
    const done = frames.find((frame) => frame.t === 'done')
    assert.ok(done, 'stream must end with a done frame')
    assert.equal(done.ok, true)
    assert.equal(done.sessionId, 'session-1')
    assert.equal(done.text, 'hello')
    assert.equal(frames.some((frame) => frame.t === 'error'), false)

    assert.equal(env.calls.create.length, 1)
    assert.equal(env.calls.follow, 1)
    assert.equal(env.calls.prompt.length, 1)
    assert.deepEqual(env.calls.prompt[0].content, [
      { type: 'text', text: 'what is this' },
      { type: 'image', mediaType: 'image/webp', data: WEBP_B64, name: 'cap.webp' },
    ])
  } finally {
    env.dispose()
  }
})

test('stream accepts an image-only prompt with no text part', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/stream', {
      body: { images: [{ mediaType: 'image/gif', data: GIF_B64 }] },
    })
    assert.equal(res.status, 200)
    const frames = streamFrames(res)
    const done = frames.find((frame) => frame.t === 'done')
    assert.ok(done)
    assert.equal(done.ok, true)
    assert.deepEqual(env.calls.prompt[0].content, [
      { type: 'image', mediaType: 'image/gif', data: GIF_B64 },
    ])
  } finally {
    env.dispose()
  }
})

test('stream keeps the text-only request shape unchanged', async () => {
  const env = await createEnv()
  try {
    const res = await callRoute(env, '/local-cli/stream', { body: { text: 'plain text' } })
    assert.equal(res.status, 200)
    assert.deepEqual(env.calls.prompt[0].content, [{ type: 'text', text: 'plain text' }])
  } finally {
    env.dispose()
  }
})

//#endregion

//#region prompt failures

test('ask maps a model image-capability rejection to 422 image-model-unsupported', async () => {
  const env = await createEnv({ promptError: remotePromptError() })
  try {
    const res = await callRoute(env, '/local-cli/ask', {
      body: { text: 'look', images: [{ mediaType: 'image/png', data: PNG_B64 }] },
    })
    assert.equal(res.status, 422)
    const payload = parseJson(res)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'image-model-unsupported')
    assert.equal(payload.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
    assert.equal(payload.sessionId, 'session-1')
    assert.equal(payload.accepted, false)
    assert.match(payload.error, /does not support image input/)
    assert.match(payload.error, /desktop session/)
    assert.match(payload.error, /retry/)
    assert.equal('data' in payload, false)
    assert.equal(env.calls.prompt.length, 1)
  } finally {
    env.dispose()
  }
})

test('ask detects the known image rejection by its message when details are lost', async () => {
  const env = await createEnv({
    promptError: new Error('Model "deepseek-flash" does not support image input.'),
  })
  try {
    const res = await callRoute(env, '/local-cli/ask', {
      body: { images: [{ mediaType: 'image/png', data: PNG_B64 }] },
    })
    assert.equal(res.status, 422)
    const payload = parseJson(res)
    assert.equal(payload.code, 'image-model-unsupported')
    assert.equal(payload.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
    assert.equal(payload.accepted, false)
    assert.equal(payload.sessionId, 'session-1')
  } finally {
    env.dispose()
  }
})

test('ask keeps generic prompt failures structured without marking them unaccepted', async () => {
  const failure = Object.assign(new Error('gateway unavailable'), {
    name: 'RemoteError',
    code: 'gateway/unavailable',
    details: { reason: 'UPSTREAM_DOWN' },
    isDSHRemoteError: true,
  })
  const env = await createEnv({ promptError: failure })
  try {
    const res = await callRoute(env, '/local-cli/ask', {
      body: { text: 'hello', images: [{ mediaType: 'image/png', data: PNG_B64 }] },
    })
    assert.equal(res.status, 500)
    const payload = parseJson(res)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'gateway/unavailable')
    assert.equal(payload.reason, 'UPSTREAM_DOWN')
    assert.equal(payload.sessionId, 'session-1')
    assert.equal(payload.error, 'gateway unavailable')
    assert.equal('accepted' in payload, false, 'unknown failures must not claim the prompt was not accepted')
  } finally {
    env.dispose()
  }
})

test('stream sends a structured error frame when the model rejects image input', async () => {
  const env = await createEnv({ promptError: remotePromptError() })
  try {
    const res = await callRoute(env, '/local-cli/stream', {
      body: { images: [{ mediaType: 'image/png', data: PNG_B64 }] },
    })
    assert.equal(res.status, 200)
    assert.equal(res.ended, true)
    const frames = streamFrames(res)
    assert.deepEqual(frames[0], { t: 'session', sessionId: 'session-1' })
    const errorFrame = frames.find((frame) => frame.t === 'error')
    assert.ok(errorFrame, 'stream must answer with an error frame')
    assert.equal(errorFrame.code, 'image-model-unsupported')
    assert.equal(errorFrame.reason, 'MODEL_DOES_NOT_SUPPORT_IMAGES')
    assert.equal(errorFrame.sessionId, 'session-1')
    assert.equal(errorFrame.accepted, false)
    assert.match(errorFrame.error, /desktop session/)
    assert.match(errorFrame.error, /retry/)
    assert.equal(frames.some((frame) => frame.t === 'done'), false)
    assert.equal(frames.some((frame) => frame.t === 'delta'), false)
  } finally {
    env.dispose()
  }
})

test('stream keeps generic prompt failures structured without an accepted flag', async () => {
  const env = await createEnv({ promptError: new Error('socket hang up') })
  try {
    const res = await callRoute(env, '/local-cli/stream', {
      body: { text: 'hello', images: [{ mediaType: 'image/png', data: PNG_B64 }] },
    })
    assert.equal(res.status, 200)
    const frames = streamFrames(res)
    const errorFrame = frames.find((frame) => frame.t === 'error')
    assert.ok(errorFrame)
    assert.equal(errorFrame.code, 'prompt-failed')
    assert.equal(errorFrame.sessionId, 'session-1')
    assert.equal(errorFrame.error, 'socket hang up')
    assert.equal('reason' in errorFrame, false)
    assert.equal('accepted' in errorFrame, false)
  } finally {
    env.dispose()
  }
})

//#endregion

//#region rejected prompts

const INVALID_CASES = [
  {
    name: 'a null body',
    code: 'invalid-body',
    body: () => null,
  },
  {
    name: 'an array body',
    code: 'invalid-body',
    body: () => [],
  },
  {
    name: 'a string body',
    code: 'invalid-body',
    body: () => 'hello',
  },
  {
    name: 'a number body',
    code: 'invalid-body',
    body: () => 42,
  },
  {
    name: 'an explicit null images member',
    code: 'invalid-images',
    body: () => ({ text: 'x', images: null }),
  },
  {
    name: 'a non-array images value',
    code: 'invalid-images',
    body: () => ({ text: 'x', images: 'not-an-array' }),
  },
  {
    name: 'more than four images',
    code: 'too-many-images',
    body: () => ({ images: new Array(5).fill({ mediaType: 'image/png', data: PNG_B64 }) }),
  },
  {
    name: 'a non-object image part',
    code: 'invalid-image',
    index: 0,
    body: () => ({ images: [42] }),
  },
  {
    name: 'an image part whose type is not image',
    code: 'invalid-image-type',
    index: 0,
    body: () => ({ images: [{ type: 'text', mediaType: 'image/png', data: PNG_B64 }] }),
  },
  {
    name: 'an unsupported media type',
    code: 'unsupported-image-media-type',
    index: 0,
    body: () => ({ images: [{ mediaType: 'image/bmp', data: PNG_B64 }] }),
  },
  {
    name: 'a non-string data field',
    code: 'invalid-image-data',
    index: 0,
    body: () => ({ images: [{ mediaType: 'image/png', data: 42 }] }),
  },
  {
    name: 'non-canonical base64',
    code: 'invalid-image-base64',
    index: 0,
    secretMarkers: ['not base64!!'],
    body: () => ({ images: [{ mediaType: 'image/png', data: 'not base64!!' }] }),
  },
  {
    name: 'a non-string name',
    code: 'invalid-image-name',
    index: 0,
    body: () => ({ images: [{ mediaType: 'image/png', data: PNG_B64, name: 42 }] }),
  },
  {
    name: 'bytes that do not match the declared media type',
    code: 'image-type-mismatch',
    index: 0,
    secretMarkers: [GIF_B64.slice(0, 20)],
    body: () => ({ images: [{ mediaType: 'image/png', data: GIF_B64 }] }),
  },
  {
    name: 'an image over the per-image byte limit',
    code: 'image-too-large',
    index: 0,
    secretMarkers: [OVERSIZE_B64.slice(0, 20)],
    body: () => ({ images: [{ mediaType: 'image/png', data: OVERSIZE_B64 }] }),
  },
  {
    name: 'images over the total byte limit',
    code: 'images-too-large',
    index: 2,
    secretMarkers: [TOTAL_OVERSIZE_IMAGES[0].slice(0, 20)],
    body: () => ({
      images: TOTAL_OVERSIZE_IMAGES.map((data) => ({ mediaType: 'image/png', data })),
    }),
  },
]

for (const route of ROUTES) {
  for (const testCase of INVALID_CASES) {
    test(`${route.name} rejects ${testCase.name} before creating a session`, async () => {
      const env = await createEnv()
      try {
        const res = await callRoute(env, route.path, { body: testCase.body() })
        assert.equal(res.status, 400)
        const payload = parseJson(res)
        assert.equal(payload.ok, false)
        assert.equal(payload.code, testCase.code)
        assert.equal(typeof payload.error, 'string')
        assert.notEqual(payload.error, '')
        if (testCase.index !== undefined) assert.equal(payload.index, testCase.index)
        assert.equal('data' in payload, false, 'errors must not carry image payloads')
        for (const marker of testCase.secretMarkers ?? []) {
          assert.equal(res.text.includes(marker), false, 'errors must not echo image bytes')
        }

        assert.equal(env.calls.create.length, 0, 'no Session may be created')
        assert.equal(env.calls.prompt.length, 0, 'prompt must not be called')
        assert.equal(env.calls.follow, 0, 'no turn subscription may be opened')
      } finally {
        env.dispose()
      }
    })
  }
}

test('ask rejects a JSON body larger than 18 MiB before creating a session', async () => {
  const env = await createEnv()
  try {
    const rawBody = `{"text":"x","images":[{"mediaType":"image/png","data":"${'A'.repeat(IMAGE_BODY_LIMIT_BYTES)}"}]}`
    const res = await callRoute(env, '/local-cli/ask', { rawBody })
    assert.equal(res.status, 400)
    const payload = parseJson(res)
    assert.equal(payload.ok, false)
    assert.match(payload.error, /request body exceeds \d+ bytes \(18 MiB\)/)
    assert.equal(env.calls.create.length, 0)
    assert.equal(env.calls.prompt.length, 0)
  } finally {
    env.dispose()
  }
})

//#endregion

//#region pure module

test('image limits are the documented ones', () => {
  assert.equal(IMAGE_LIMITS.maxImages, 4)
  assert.equal(IMAGE_LIMITS.maxImageBytes, 5 * 1024 * 1024)
  assert.equal(IMAGE_LIMITS.maxTotalBytes, 12 * 1024 * 1024)
  assert.equal(IMAGE_LIMITS.bodyLimitBytes, 18 * 1024 * 1024)
  assert.equal(IMAGE_BODY_LIMIT_BYTES, 18 * 1024 * 1024)
  assert.deepEqual([...IMAGE_MEDIA_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  assert.deepEqual(imageCapabilities(), {
    supported: true,
    maxImages: 4,
    maxImageBytes: 5 * 1024 * 1024,
    maxTotalBytes: 12 * 1024 * 1024,
    bodyLimitBytes: 18 * 1024 * 1024,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  })
})

test('magic bytes are matched against the declared media type', () => {
  assert.equal(matchesMediaType('image/png', PNG_BYTES), true)
  assert.equal(matchesMediaType('image/jpeg', JPEG_BYTES), true)
  assert.equal(matchesMediaType('image/gif', GIF_BYTES), true)
  assert.equal(matchesMediaType('image/webp', WEBP_BYTES), true)
  assert.equal(matchesMediaType('image/png', GIF_BYTES), false)
  assert.equal(matchesMediaType('image/jpeg', PNG_BYTES), false)
  assert.equal(matchesMediaType('image/gif', Buffer.from('GIF00a')), false)
  assert.equal(matchesMediaType('image/webp', Buffer.from('RIFFxxxxWAVE')), false)
  assert.equal(matchesMediaType('image/bmp', PNG_BYTES), false)
})

test('canonical base64 is enforced like the Host admission path', () => {
  assert.equal(decodeCanonicalBase64(PNG_B64)?.length, PNG_BYTES.length)
  assert.equal(decodeCanonicalBase64('abc'), undefined)
  assert.equal(decodeCanonicalBase64('not base64!!'), undefined)
  assert.equal(decodeCanonicalBase64(''), undefined)
  assert.equal(decodeCanonicalBase64(42), undefined)
})

test('buildPromptContent keeps text first and allows image-only content', () => {
  const images = [{ mediaType: 'image/png', data: PNG_B64, bytes: PNG_BYTES.length }]
  assert.deepEqual(buildPromptContent('  hello  ', images), [
    { type: 'text', text: 'hello' },
    { type: 'image', mediaType: 'image/png', data: PNG_B64 },
  ])
  assert.deepEqual(buildPromptContent('   ', images), [
    { type: 'image', mediaType: 'image/png', data: PNG_B64 },
  ])
  assert.deepEqual(buildPromptContent('hello', []), [{ type: 'text', text: 'hello' }])
  assert.deepEqual(buildPromptContent('', []), [])
})

test('validateImages accepts an absent images member and normalizes names', () => {
  assert.deepEqual(validateImages(undefined), { ok: true, images: [] })
  const validated = validateImages([{ mediaType: 'image/png', data: PNG_B64, name: '  a.png  ' }])
  assert.equal(validated.ok, true)
  assert.equal(validated.images.length, 1)
  assert.equal(validated.images[0].name, 'a.png')
  assert.equal(validated.images[0].bytes, PNG_BYTES.length)
  assert.equal(validated.images[0].data, PNG_B64)
})

test('validateImages rejects an explicit null images member', () => {
  const validated = validateImages(null)
  assert.equal(validated.ok, false)
  assert.equal(validated.error.code, 'invalid-images')
  assert.equal(typeof validated.error.error, 'string')
  assert.equal('data' in validated.error, false)
})

//#endregion
