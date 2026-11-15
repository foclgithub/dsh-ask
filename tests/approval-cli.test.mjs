/**
 * Tests for the `approval` CLI commands and the TUI approval adapter.
 *
 * A local node:http server plays the loopback bridge and records every wire
 * request. Nothing here talks to the desktop app, writes files, or answers a
 * real approval: DSH_ASK_NO_START=1 and a throwaway DSH_HOME keep it local.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { createTuiAdapter } from '../dsh-ask.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-approval-cli-'))

after(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

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
    requests.push({ method: req.method, path: url.pathname, query: url.search, body })
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

function healthRoute() {
  return ({ res, host }) => json(res, 200, { ok: true, origin: host.origin, pid: 4242, capabilities: {} })
}

async function makeHome() {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
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

function runArgs(home, origin, args, prefixFlags = true) {
  const argv = args[0] === 'approval' && prefixFlags ? ['approval', '--no-start', '-u', origin, ...args.slice(1)] : ['--no-start', '-u', origin, ...args]
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
    }, 15_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 'timeout' : code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function runCli(home, origin, args) {
  return runArgs(home, origin, args, true)
}

/** Flags-first shape: global flags before the `approval` subcommand. */
function runRaw(home, origin, args) {
  return runArgs(home, origin, args, false)
}

const STATUS_PAYLOAD = {
  ok: true,
  claim: {
    claimId: 'claim-1',
    sessionId: 's-canonical',
    expiresAt: 1_700_000_060_000,
    leaseMs: 60_000,
  },
  connected: true,
  pendingCount: 1,
  maxPending: 8,
  pending: [
    {
      requestId: 'req-1',
      sessionId: 's-canonical',
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs approval',
      displayReason: null,
      requestedAt: 1_700_000_000_000,
    },
  ],
}

const CLAIM_PAYLOAD = {
  ok: true,
  claimId: 'claim-1',
  sessionId: 's-canonical',
  expiresAt: 1_700_000_060_000,
  leaseMs: 60_000,
}

test('approval status without a claim id renders the unclaimed channel', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/approval': ({ res }) =>
      json(res, 200, { ok: true, claim: null, connected: false, pendingCount: 0, maxPending: 8, pending: [] }),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'status'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /claim       none/)
  const get = host.requests.find((request) => request.path === '/local-cli/approval')
  assert.equal(get.method, 'GET')
  assert.equal(get.query, '')
  assert.equal(host.requests.some((request) => request.path.startsWith('/local-cli/ask')), false)
})

test('approval status forwards an exact claim id and prints raw JSON on --json', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/approval': ({ res }) => json(res, 200, STATUS_PAYLOAD),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'status', 'claim 1/2'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /claim       claim-1/)
  assert.match(result.stdout, /req-1/)
  const get = host.requests.find((request) => request.path === '/local-cli/approval')
  assert.equal(decodeURIComponent(get.query), '?claimId=claim 1/2')

  const raw = await runCli(home, host.origin, ['--json', 'approval', 'status', 'claim 1/2'])
  assert.equal(raw.code, 0)
  assert.deepEqual(JSON.parse(raw.stdout), STATUS_PAYLOAD)
})

test('approval claim defaults to a 60s lease and shows it explicitly', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/approval/claim': ({ res }) => json(res, 200, CLAIM_PAYLOAD),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'claim', 'abc prefix'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /claim       claim-1/)
  assert.match(result.stdout, /session     s-canonical/)
  assert.match(result.stdout, /lease       60s \(60000 ms\)/)

  const claim = host.requests.find((request) => request.path === '/local-cli/approval/claim')
  assert.deepEqual(claim.body, { sessionId: 'abc prefix', leaseMs: 60_000 })
})

test('approval claim honours --lease and stays byte-exact', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/approval/claim': ({ res }) => json(res, 200, { ...CLAIM_PAYLOAD, leaseMs: 120_000 }),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'claim', '  session  id/1  ', '--lease', '120000'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /lease       120s \(120000 ms\)/)
  const claim = host.requests.find((request) => request.path === '/local-cli/approval/claim')
  assert.deepEqual(claim.body, { sessionId: '  session  id/1  ', leaseMs: 120_000 })
})

test('approval stays a subcommand when global flags come first', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/approval': ({ res }) => json(res, 200, STATUS_PAYLOAD),
  })
  t.after(() => host.close())

  const result = await runRaw(home, host.origin, ['--json', '-u', host.origin, 'approval', 'status'])
  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), STATUS_PAYLOAD)
  assert.equal(host.requests.some((request) => request.method === 'POST'), false)
})

test('approval release posts the exact claim id and reports delegated work', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/approval/release': ({ res }) => json(res, 200, { ok: true, released: true, delegated: 2 }),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'release', 'claim/one  two'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /delegated 2 pending request\(s\)/)
  const release = host.requests.find((request) => request.path === '/local-cli/approval/release')
  assert.deepEqual(release.body, { claimId: 'claim/one  two', reason: 'user' })
})

test('approval answer requires an explicit decision and --confirm', async (t) => {
  const home = await makeHome()
  const host = await startHost({ 'GET /local-cli/health': healthRoute() })
  t.after(() => host.close())

  const cases = [
    ['approval', 'answer', 'claim-1', 'req-1', '--confirm'],
    ['approval', 'answer', 'claim-1', 'req-1', '--allow-once'],
    ['approval', 'answer', 'claim-1', 'req-1', '--allow-once', '--reject', '--confirm'],
    ['approval', 'answer', 'claim-1'],
  ]
  for (const args of cases) {
    const result = await runCli(home, host.origin, args)
    assert.equal(result.code, 2, args.join(' '))
    assert.equal(host.requests.length, 0, 'nothing may be sent before an explicit confirmed decision')
  }
})

test('approval answer submits one local decision and never retries', async (t) => {
  const home = await makeHome()
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'POST /local-cli/approval/answer': ({ res }) =>
      json(res, 200, {
        ok: true,
        claimId: 'claim-1',
        requestId: 'req 1/3',
        outcome: 'allowed-once',
        submittedAt: 1_700_000_000_000,
        final: false,
        note: 'submitted to the local channel; the Host result is not observed here',
      }),
  })
  t.after(() => host.close())

  const result = await runCli(home, host.origin, ['approval', 'answer', 'claim-1', 'req 1/3', '--allow-once', '--confirm'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /submitted allowed-once for request req 1\/3/)
  assert.match(result.stdout, /waiting for the Host to confirm; not confirmed here/)
  const answers = host.requests.filter((request) => request.path === '/local-cli/approval/answer')
  assert.equal(answers.length, 1)
  assert.deepEqual(answers[0].body, { claimId: 'claim-1', requestId: 'req 1/3', outcome: 'allowed-once' })

  const rejected = await runCli(home, host.origin, [
    '--json',
    'approval',
    'answer',
    'claim-1',
    'req 1/3',
    '--reject',
    '--confirm',
  ])
  assert.equal(rejected.code, 0)
  const payload = JSON.parse(rejected.stdout)
  assert.equal(payload.final, false)
  assert.equal(host.requests.filter((request) => request.path === '/local-cli/approval/answer').length, 2)
})

test('approval surfacing stays explicit for 401, old-Host 404 and route refusals', async (t) => {
  const home = await makeHome()
  let mode = 'unauthorized'
  const host = await startHost({
    'GET /local-cli/health': healthRoute(),
    'GET /local-cli/approval': ({ res }) => {
      if (mode === 'unauthorized') return json(res, 401, { ok: false, error: 'token mismatch' })
      if (mode === 'old') return json(res, 404, { ok: false, error: 'HTTP 404' })
      return json(res, 410, { ok: false, code: 'claim-expired', error: 'the claim lease has expired' })
    },
  })
  t.after(() => host.close())

  const unauthorized = await runCli(home, host.origin, ['approval', 'status'])
  assert.equal(unauthorized.code, 1)
  assert.match(unauthorized.stderr, /token mismatch/)

  mode = 'old'
  const old = await runCli(home, host.origin, ['approval', 'status'])
  assert.equal(old.code, 1)
  assert.match(old.stderr, /may be older than this CLI/)
  assert.match(old.stderr, /\/local-cli\/approval/)

  mode = 'expired'
  const expired = await runCli(home, host.origin, ['approval', 'status', 'claim-1'])
  assert.equal(expired.code, 1)
  assert.match(expired.stderr, /claim-expired: the claim lease has expired/)
})

test('TUI adapter exposes the fixed approval surface and heartbeats after claim', async (t) => {
  const host = await startHost({
    'GET /local-cli/approval': ({ res }) => json(res, 200, STATUS_PAYLOAD),
    'POST /local-cli/approval/claim': ({ res }) =>
      json(res, 200, { ok: true, claimId: 'adapter-claim', sessionId: 's-canonical', expiresAt: Date.now() + 600, leaseMs: 600 }),
    'POST /local-cli/approval/heartbeat': ({ res }) =>
      json(res, 200, { ok: true, claimId: 'adapter-claim', expiresAt: Date.now() + 600, leaseMs: 600 }),
    'POST /local-cli/approval/release': ({ res }) => json(res, 200, { ok: true, released: true, delegated: 0 }),
    'POST /local-cli/approval/answer': ({ res }) =>
      json(res, 200, { ok: true, claimId: 'adapter-claim', requestId: 'req-1', outcome: 'rejected', submittedAt: 1, final: false }),
  })
  t.after(() => host.close())
  const adapter = createTuiAdapter({ base: host.origin, token: 'test-token', instance: { capabilities: {} } }, {})

  assert.equal(typeof adapter.fetchApprovalChannel, 'function')
  assert.equal(typeof adapter.claimApprovalChannel, 'function')
  assert.equal(typeof adapter.heartbeatApprovalChannel, 'function')
  assert.equal(typeof adapter.releaseApprovalChannel, 'function')
  assert.equal(typeof adapter.submitApprovalDecision, 'function')

  await adapter.fetchApprovalChannel()
  await adapter.fetchApprovalChannel('id x/1')
  const fetches = host.requests.filter((request) => request.path === '/local-cli/approval')
  assert.equal(fetches[0].query, '')
  assert.equal(decodeURIComponent(fetches[1].query), '?claimId=id x/1')

  const claimed = await adapter.claimApprovalChannel({ sessionId: 's-canonical' })
  assert.equal(claimed.claimId, 'adapter-claim')
  const claimRequest = host.requests.find((request) => request.path === '/local-cli/approval/claim')
  assert.deepEqual(claimRequest.body, { sessionId: 's-canonical' })

  // The adapter owns the lease heartbeat while the claim is active.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(host.requests.filter((request) => request.path === '/local-cli/approval/heartbeat').length >= 1, true)

  await adapter.submitApprovalDecision({ claimId: 'adapter-claim', requestId: 'req-1', outcome: 'rejected' })
  const decision = host.requests.find((request) => request.path === '/local-cli/approval/answer')
  assert.deepEqual(decision.body, { claimId: 'adapter-claim', requestId: 'req-1', outcome: 'rejected' })

  await adapter.releaseApprovalChannel({ claimId: 'adapter-claim' })
  const afterRelease = host.requests.filter((request) => request.path === '/local-cli/approval/heartbeat').length
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(host.requests.filter((request) => request.path === '/local-cli/approval/heartbeat').length, afterRelease)
})
