/**
 * End-to-end tests for dsh-ask as a subprocess.
 *
 * A throwaway DSH_HOME holds the token, and a local `node:http` server plays the
 * loopback bridge (`/local-cli/health`, `/ask`, `/stream`). Nothing here talks
 * to the desktop app, starts it, or reads the real clipboard: `--no-start` and
 * `DSH_ASK_NO_START=1` keep auto-launch off, and no test passes `--paste`.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-cli-test-'))

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-cli-test-png'),
])
const PNG_B64 = PNG_BYTES.toString('base64')

const IMAGE_CAPS = {
  supported: true,
  maxImages: 4,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  bodyLimitBytes: 18 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/**
 * A loopback bridge double. `routes` maps "METHOD /path" to a handler that gets
 * the parsed request body and the fake Host. Every request is recorded so the
 * tests can assert both the wire shape and what was (not) called.
 */
async function startHost(routes) {
  const requests = []
  const host = { origin: '', requests }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw === '' ? undefined : JSON.parse(raw)
    } catch {
      body = undefined
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, raw })
    const handler = routes[`${req.method} ${url.pathname}`]
    if (handler === undefined) {
      json(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` })
      return
    }
    await handler({ req, res, url, body, host })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host.origin = `http://127.0.0.1:${server.address().port}`
  host.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  return host
}

function healthRoute(caps = IMAGE_CAPS) {
  return ({ res, host }) =>
    json(res, 200, {
      ok: true,
      origin: host.origin,
      pid: 4242,
      capabilities: caps === undefined ? {} : { images: caps },
    })
}

function queueRoute() {
  return ({ res }) => json(res, 200, { ok: true, sessionId: 's-live', running: false, items: [] })
}

async function makeHome(names = ['pixel.png', 'second.png']) {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
  for (const name of names) await writeFile(join(home, name), PNG_BYTES)
  return home
}

function cliEnv(home) {
  return {
    ...process.env,
    DSH_HOME: home,
    DSH_ASK_LANG: 'en',
    DSH_ASK_NO_START: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  }
}

/** Run dsh-ask with stdin closed (so a stdin read can never hang the test). */
function runCli(home, origin, args, timeoutMs = 15_000) {
  // A subcommand must stay argv[0]; the global flags still parse after it.
  const subcommands = new Set(['status', 'list', 'queue', 'pending', 'workspaces', 'history', 'new', 'create', 'connect', 'resume'])
  const argv = subcommands.has(args[0])
    ? [args[0], '--no-start', '-u', origin, ...args.slice(1)]
    : ['--no-start', '-u', origin, ...args]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ASK, ...argv], {
      cwd: home,
      env: cliEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 'timeout' : (code ?? signal),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

/**
 * Drive an interactive `connect` session over pipes: each command is written
 * only after the previous prompt appeared, so readline never sees a burst of
 * lines before it has a pending question.
 */
function runConnectSession(home, origin, commands, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [ASK, 'connect', '--no-start', '-u', origin, '-s', 's-live', '--no-history'],
      { cwd: home, env: cliEnv(home), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const stdout = []
    const stderr = []
    let seen = ''
    let next = 0
    let closing = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const feed = () => {
      // Both prompt forms count: "❯ " for a normal line and "… " for the
      // continuation line of /multiline.
      const prompts = (seen.match(/❯ |… /g) ?? []).length
      while (next < commands.length && prompts > next) {
        try {
          child.stdin.write(`${commands[next]}\n`)
        } catch {
          // The child may have exited between prompts.
        }
        next += 1
      }
      if (closing === false && next >= commands.length) {
        closing = true
        setTimeout(() => {
          try {
            child.stdin.end()
          } catch {
            // Already gone.
          }
        }, 300)
      }
    }
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      seen += String(chunk)
      stdout.push(chunk)
      feed()
    })
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 'timeout' : (code ?? signal),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })
}

function startNdjson(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
}

test('image-only: sends body.images without text and never enters connect', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-image-only"}\n')
      res.write('{"t":"delta","text":"looked at it"}\n')
      res.write('{"t":"done","ok":true,"sessionId":"s-image-only","text":"looked at it"}')
      res.end()
    },
  })
  try {
    const result = await runCli(home, host.origin, ['--image', 'pixel.png', '--preview', 'never'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /looked at it/)

    const streams = host.requests.filter((entry) => entry.path === '/local-cli/stream')
    assert.equal(streams.length, 1)
    assert.equal(streams[0].body.text, '')
    assert.equal(streams[0].body.images.length, 1)
    assert.equal(streams[0].body.images[0].mediaType, 'image/png')
    assert.equal(streams[0].body.images[0].data, PNG_B64)
    // No Session listing, transcript, ask fallback, or Session creation.
    assert.deepEqual(
      host.requests.map((entry) => entry.path),
      ['/local-cli/health', '/local-cli/stream'],
    )
  } finally {
    await host.close()
  }
})

test('body.images: every --image is sent with text in wire form', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-two"}\n')
      res.write('{"t":"done","ok":true,"sessionId":"s-two","text":"done"}')
      res.end()
    },
  })
  try {
    const result = await runCli(home, host.origin, ['--image', 'pixel.png', '--image', 'second.png', 'describe both'])
    assert.equal(result.code, 0)
    const body = host.requests.find((entry) => entry.path === '/local-cli/stream').body
    assert.equal(body.text, 'describe both')
    assert.equal(body.images.length, 2)
    assert.deepEqual(
      body.images.map((image) => image.name),
      ['pixel.png', 'second.png'],
    )
    for (const image of body.images) {
      assert.equal(image.mediaType, 'image/png')
      assert.equal(image.data, PNG_B64)
      assert.equal('bytes' in image, false, 'bytes is a local field and must not go on the wire')
    }
  } finally {
    await host.close()
  }
})

test('a real --image path containing spaces stays one path', async () => {
  const home = await makeHome(['a picture with spaces.png'])
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-space"}\n')
      res.write('{"t":"done","ok":true,"sessionId":"s-space","text":"ok"}')
      res.end()
    },
  })
  try {
    const spaced = join(home, 'a picture with spaces.png')
    const result = await runCli(home, host.origin, ['--image', spaced, '--preview', 'never'])
    assert.equal(result.code, 0)
    const body = host.requests.find((entry) => entry.path === '/local-cli/stream').body
    assert.equal(body.images.length, 1, 'one shell-quoted path must not split on its spaces')
    assert.equal(body.images[0].name, 'a picture with spaces.png')
    assert.equal(body.images[0].data, PNG_B64)
  } finally {
    await host.close()
  }
})

test('an older Host without image capabilities gets a clear upgrade hint', async () => {
  const home = await makeHome()
  const host = await startHost({
    // No capabilities member at all: this is what an old bridge answers.
    'GET /local-cli/health': ({ res, host: fake }) => json(res, 200, { ok: true, origin: fake.origin }),
  })
  try {
    const result = await runCli(home, host.origin, ['--image', 'pixel.png', 'hello'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /image/i)
    assert.match(result.stderr, /older/i)
    assert.match(result.stderr, /Update DeepSeek Harness/i)
    assert.deepEqual(
      host.requests.map((entry) => entry.path),
      ['/local-cli/health'],
    )
  } finally {
    await host.close()
  }
})

test('--json keeps stdout parseable and free of ANSI escapes', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/ask': ({ res }) =>
      json(res, 200, { ok: true, sessionId: 's-json', text: 'hello json', running: false }),
  })
  try {
    const result = await runCli(home, host.origin, ['--json', '--image', 'pixel.png', 'hi'])
    assert.equal(result.code, 0)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.sessionId, 's-json')
    assert.equal(payload.text, 'hello json')
    assert.equal(result.stdout.includes('\x1b'), false)
    assert.equal(result.stderr.includes('\x1b'), false)
    const body = host.requests.find((entry) => entry.path === '/local-cli/ask').body
    assert.equal(body.text, 'hi')
    assert.equal(body.images.length, 1)
  } finally {
    await host.close()
  }
})

test('a stream that ends without a done frame is an error that keeps sessionId and partial text', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-no-done"}\n')
      res.write('{"t":"delta","text":"half an answer"}\n')
      res.end()
    },
  })
  try {
    const result = await runCli(home, host.origin, ['no done please'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /incomplete-stream/)
    assert.match(result.stderr, /done frame/)
    assert.match(result.stderr, /s-no-done/)
    assert.match(result.stderr, /half an answer/)
    assert.equal(result.stderr.includes('\x1b'), false)
  } finally {
    await host.close()
  }
})

test('a hard-cut stream keeps sessionId and partial text instead of reporting success', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-cut"}\n')
      res.write('{"t":"delta","text":"cut short"}\n')
      res.flushHeaders()
      // Give the client a moment to consume the frames, then break the socket.
      setTimeout(() => res.destroy(), 100)
    },
  })
  try {
    const result = await runCli(home, host.origin, ['cut it'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /stream-interrupted/)
    assert.match(result.stderr, /s-cut/)
    assert.match(result.stderr, /cut short/)
  } finally {
    await host.close()
  }
})

test('a tail frame without a trailing newline is still parsed', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-tail"}\n')
      res.write('{"t":"delta","text":"tail answer"}\n')
      // The final frame is written without "\n" right before EOF.
      res.end('{"t":"done","ok":true,"sessionId":"s-tail","text":"tail answer"}')
    },
  })
  try {
    const result = await runCli(home, host.origin, ['tail please'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /tail answer/)
    assert.doesNotMatch(result.stderr, /incomplete-stream/)
  } finally {
    await host.close()
  }
})

test('a turn-end error reason is reported as a failure', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-turn"}\n')
      res.write('{"t":"delta","text":"started"}\n')
      res.write('{"t":"turn-end","reason":"error"}\n')
      res.write('{"t":"done","ok":true,"sessionId":"s-turn","text":"started"}')
      res.end()
    },
  })
  try {
    const result = await runCli(home, host.origin, ['turn error'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /turn-end/)
    assert.match(result.stderr, /ended with reason: error/)
    assert.match(result.stderr, /s-turn/)
  } finally {
    await host.close()
  }
})

test('image-model-unsupported in a stream error frame is explicit and not retried', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/stream': ({ res }) => {
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-vision"}\n')
      res.write(
        '{"t":"error","code":"image-model-unsupported","accepted":false,"sessionId":"s-vision","error":"the selected model cannot see images"}\n',
      )
      res.end()
    },
  })
  try {
    const result = await runCli(home, host.origin, ['--image', 'pixel.png', 'look'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /image-model-unsupported/)
    assert.match(result.stderr, /vision-capable model/)
    assert.match(result.stderr, /s-vision/)
    // One prompt attempt only: the CLI must not switch models and retry.
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/stream').length, 1)
  } finally {
    await host.close()
  }
})

test('image-model-unsupported as an ask 4xx keeps JSON clean and leaves accepted false', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/ask': ({ res }) =>
      json(res, 400, {
        ok: false,
        code: 'image-model-unsupported',
        accepted: false,
        sessionId: 's-vision-json',
        error: 'the selected model cannot see images',
      }),
  })
  try {
    const result = await runCli(home, host.origin, ['--json', '--image', 'pixel.png', 'look'])
    assert.equal(result.code, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'image-model-unsupported')
    assert.equal(payload.accepted, false)
    assert.equal(payload.sessionId, 's-vision-json')
    assert.equal(result.stdout.includes('\x1b'), false)
    assert.match(result.stderr, /vision-capable model/)
    assert.equal(host.requests.filter((entry) => entry.path === '/local-cli/ask').length, 1)
  } finally {
    await host.close()
  }
})

test('bad option values exit 2 before any Host request and never become prompt text', async () => {
  const home = await makeHome()
  const host = await startHost({ 'GET /local-cli/health': healthRoute() })
  try {
    for (const args of [
      ['--preview', 'chromatic', 'hello'],
      ['--bogus', 'hello'],
      ['--image'],
      ['--tail', 'soon', 'hello'],
    ]) {
      const result = await runCli(home, host.origin, args)
      assert.equal(result.code, 2, `expected usage exit for ${args.join(' ')}`)
      assert.match(result.stderr, /dsh-ask:/)
    }
    assert.equal(host.requests.length, 0, 'nothing may reach the bridge for a bad option')
  } finally {
    await host.close()
  }
})

test('connect: a Host that dies after the POST leaves attachments unconfirmed, and later text carries no images', async () => {
  const home = await makeHome()
  const pixel = join(home, 'pixel.png')
  let streamCalls = 0
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/queue': queueRoute(),
    'POST /local-cli/stream': ({ res }) => {
      streamCalls += 1
      if (streamCalls === 1) {
        // The Host read the POST (images included) and then vanished. The
        // client cannot know whether the prompt was queued.
        res.destroy()
        return
      }
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-live"}\n')
      res.write('{"t":"delta","text":"text answered"}\n')
      res.end('{"t":"done","ok":true,"sessionId":"s-live","text":"text answered"}')
    },
  })
  try {
    const result = await runConnectSession(home, host.origin, [
      `/attach "${pixel}"`,
      '/send',
      'hello after',
      '/attachments',
      '/exit',
    ])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)

    const streams = host.requests.filter((entry) => entry.path === '/local-cli/stream')
    assert.equal(streams.length, 2)
    assert.equal(streams[0].body.text, '')
    assert.equal(streams[0].body.images.length, 1)
    // The later plain-text turn must not silently resubmit the image.
    assert.equal(streams[1].body.text, 'hello after')
    assert.equal((streams[1].body.images ?? []).length, 0)

    assert.match(result.stdout, /unconfirmed/i)
    assert.match(result.stdout, /check \/history/i)
    assert.match(result.stdout, /s-live/)
    assert.match(result.stdout, /0 pending · 1 sent/)
    assert.match(result.stdout, /delivery unknown/)
    assert.doesNotMatch(result.stdout, /nothing was queued/)
  } finally {
    await host.close()
  }
})

test('connect: an explicit image-model-unsupported refusal keeps attachments for an explicit /send retry', async () => {
  const home = await makeHome()
  const pixel = join(home, 'pixel.png')
  let streamCalls = 0
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/queue': queueRoute(),
    'POST /local-cli/stream': ({ res }) => {
      streamCalls += 1
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-live"}\n')
      if (streamCalls === 1) {
        res.end(
          '{"t":"error","code":"image-model-unsupported","accepted":false,"sessionId":"s-live","error":"model cannot see images"}',
        )
        return
      }
      res.write('{"t":"delta","text":"retried ok"}\n')
      res.end('{"t":"done","ok":true,"sessionId":"s-live","text":"retried ok"}')
    },
  })
  try {
    const result = await runConnectSession(home, host.origin, [
      `/attach "${pixel}"`,
      '/send',
      '/send',
      '/attachments',
      '/exit',
    ])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)

    const streams = host.requests.filter((entry) => entry.path === '/local-cli/stream')
    assert.equal(streams.length, 2)
    // Both attempts were made only because the first one was explicitly refused.
    assert.equal(streams[0].body.images.length, 1)
    assert.equal(streams[1].body.images.length, 1)
    assert.equal(streams[1].body.text, '')

    assert.match(result.stdout, /attachments kept locally/)
    assert.match(result.stdout, /model cannot see images/)
    assert.match(result.stdout, /retried ok/)
    assert.match(result.stdout, /0 pending · 0 sent/)
  } finally {
    await host.close()
  }
})

test('connect: attachment file names are sanitized before they reach the terminal', async () => {
  const evilName = 'evil\x1b[31mpicture.png'
  const home = await makeHome([evilName])
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/queue': queueRoute(),
  })
  try {
    const result = await runConnectSession(home, host.origin, [
      `/attach "${join(home, evilName)}"`,
      '/attachments',
      '/exit',
    ])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.equal(result.stdout.includes('\x1b'), false, 'a file name must not inject terminal escapes')
    assert.equal(result.stderr.includes('\x1b'), false)
    assert.match(result.stdout, /evilpicture\.png/)
  } finally {
    await host.close()
  }
})

test('connect: a stream cut after the POST also keeps attachments unconfirmed, never pending', async () => {
  const home = await makeHome()
  const pixel = join(home, 'pixel.png')
  let streamCalls = 0
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/queue': queueRoute(),
    'POST /local-cli/stream': ({ res }) => {
      streamCalls += 1
      if (streamCalls === 1) {
        startNdjson(res)
        res.write('{"t":"session","sessionId":"s-live"}\n')
        res.flushHeaders()
        setTimeout(() => res.destroy(), 100)
        return
      }
      startNdjson(res)
      res.write('{"t":"session","sessionId":"s-live"}\n')
      res.write('{"t":"delta","text":"second turn"}\n')
      res.end('{"t":"done","ok":true,"sessionId":"s-live","text":"second turn"}')
    },
  })
  try {
    const result = await runConnectSession(home, host.origin, [
      `/attach "${pixel}"`,
      '/send',
      'after the cut',
      '/attachments',
      '/exit',
    ])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    const streams = host.requests.filter((entry) => entry.path === '/local-cli/stream')
    assert.equal(streams.length, 2)
    assert.equal(streams[0].body.images.length, 1)
    assert.equal(streams[1].body.text, 'after the cut')
    assert.equal((streams[1].body.images ?? []).length, 0, 'an unknown delivery must not ride the next text prompt')
    assert.match(result.stderr, /stream-interrupted/)
    assert.match(result.stdout, /attachments marked unconfirmed/)
    assert.match(result.stdout, /0 pending · 1 sent/)
    assert.doesNotMatch(result.stdout, /nothing was queued/)
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// status: whitelisted read through the loopback bridge
// ---------------------------------------------------------------------------

const STATUS_PAYLOAD = {
  model: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
  context: { usedTokens: 24_000, contextWindow: 200_000, percent: 12, pressureTokens: 22_000, projectedTokens: 24_000 },
  usage: {
    uncachedInputTokens: 39_840,
    outputTokens: 160,
    cacheReadTokens: 291_840,
    cacheWriteTokens: 160,
    billedInputTokens: 331_840,
    totalTokens: 332_000,
    cacheHitPercent: 88,
  },
  stats: {
    turns: 2,
    steps: 5,
    llmMs: 12_300,
    toolMs: 900,
    ttftMs: 1_600,
    ttftSteps: 2,
    decodeMs: 9_400,
    decodeTokens: 329,
    tokensPerSecond: 35,
  },
  permission: 'workspace-write',
  running: false,
  queue: 0,
  pendingInput: [],
}

test('status --json prints the whitelisted status without raw projection keys', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/status': ({ res, url }) => {
      assert.equal(url.searchParams.get('sessionId'), 's-live', 'the session is explicit')
      json(res, 200, { ok: true, sessionId: 's-live', status: STATUS_PAYLOAD })
    },
  })
  try {
    const result = await runCli(home, host.origin, ['status', 's-live', '--json'])
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.sessionId, 's-live')
    assert.equal(payload.status.model.model, 'deepseek-flash')
    assert.equal(payload.status.context.percent, 12)
    assert.equal(payload.status.usage.totalTokens, 332_000)
    assert.equal(payload.status.stats.tokensPerSecond, 35)
    const wire = JSON.stringify(payload)
    assert.equal(wire.includes('lastUsed'), false, 'the raw selection state never leaves the Host')
    assert.equal(wire.includes('x-local-cli-token'), false, 'the token never appears in output')
  } finally {
    await host.close()
  }
})

test('status renders the compact rows, and an older Host degrades with a clear error', async () => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/status': ({ res }) => json(res, 200, { ok: true, sessionId: 's-live', status: STATUS_PAYLOAD }),
  })
  try {
    const rendered = await runCli(home, host.origin, ['status', 's-live'])
    assert.equal(rendered.code, 0)
    assert.match(rendered.stdout, /model       deepseek \/ deepseek-flash · effort high/)
    assert.match(rendered.stdout, /context     12% · 24K \/ 200K tokens \(projected\)/)
    assert.match(rendered.stdout, /tokens      in 39840 · out 160 · cache read 291840 · cache write 160 · total 332000 · cache hit 88%/)
    assert.match(rendered.stdout, /stats       2 turns · 5 steps · cumulative llm 12\.3s · tool 900ms · ttft avg 800ms · decode 9\.4s · 35 tok\/s/)
    assert.match(rendered.stdout, /permission  workspace-write/)
    assert.match(rendered.stdout, /state       idle · queue 0 · pending none/)
    assert.doesNotMatch(rendered.stdout, /\$|费用|cost/, 'no invented cost row')
  } finally {
    await host.close()
  }

  const older = await startHost({ 'GET /local-cli/health': healthRoute() })
  try {
    const degraded = await runCli(home, older.origin, ['status', 's-live'])
    assert.equal(degraded.code, 1)
    assert.match(degraded.stderr, /no route for GET \/local-cli\/status/)
    assert.match(degraded.stderr, /older than this CLI/)
    assert.doesNotMatch(degraded.stderr, /test-token/)
  } finally {
    await older.close()
  }
})
