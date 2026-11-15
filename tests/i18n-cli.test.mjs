/**
 * Language tests for the `dsh-ask` CLI surface (`--lang`, `DSH_ASK_LANG`, the
 * localized help and the localized subcommand output).
 *
 * A throwaway DSH_HOME and a local `node:http` bridge keep every run offline.
 * The language is always set explicitly per test: the child environment drops
 * the locale variables, so the machine running the tests cannot leak into a
 * result. `--lang en` must never translate Host/user data (Session titles,
 * ids, paths) and must never change JSON.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASK = join(HERE, '..', 'dsh-ask.mjs')
// Parent for this run's throwaway homes. The temporary directories are left in
// place on purpose: this suite never deletes files, so a failed run can be
// inspected afterwards (cleanup is the caller's business, not this file's).
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-cli-i18n-'))

/** A Session whose title is Chinese user data: it must survive both languages. */
const CHINESE_TITLE = '帮我修登录逻辑'
const ENV_LANGUAGE_VARIABLES = ['DSH_ASK_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function sessionRow(overrides = {}) {
  return {
    sessionId: 's-i18n-1',
    title: CHINESE_TITLE,
    updatedAt: Date.now(),
    running: true,
    blank: false,
    preview: '',
    ...overrides,
  }
}

const STATUS = {
  model: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
  context: { usedTokens: 24_000, contextWindow: 200_000, percent: 12, projectedTokens: 24_000 },
  usage: { uncachedInputTokens: 3_000, outputTokens: 200, cacheReadTokens: 1_000, cacheWriteTokens: 50, totalTokens: 3_200, cacheHitPercent: 88 },
  stats: { turns: 2, steps: 5, llmMs: 1_200, toolMs: 300, ttftMs: 300, ttftSteps: 2, decodeMs: 900, tokensPerSecond: 30 },
  permission: 'workspace-write',
  running: false,
  queue: 1,
  pendingInput: [],
}

/**
 * One loopback bridge double covering every read the tests exercise.
 *
 * `health` is merged into the `/local-cli/health` body, so a test can model the
 * Desktop plugin's `cliPreferences.language`; a function is re-evaluated per
 * request, which lets one Host switch its reported setting between runs.
 */
async function startHost({ health = {} } = {}) {
  const requests = []
  const host = { requests }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(url.pathname + url.search)
    switch (url.pathname) {
      case '/local-cli/health': {
        const extra = typeof health === 'function' ? health() : health
        return json(res, 200, { ok: true, origin: host.origin, pid: 4242, capabilities: {}, ...extra })
      }
      case '/local-cli/sessions':
        return json(res, 200, { ok: true, sessions: [sessionRow()] })
      case '/local-cli/workspaces':
        return json(res, 200, { ok: true, workspaces: [{ id: 'w-1', title: CHINESE_TITLE, path: '/tmp/中文目录', sessions: 2 }] })
      case '/local-cli/status':
        return json(res, 200, { ok: true, sessionId: 's-i18n-1', status: STATUS })
      case '/local-cli/queue':
        return json(res, 200, { ok: true, sessionId: 's-i18n-1', running: true, items: [{ index: 1, id: 'q-1', placement: 'queued', text: '等一下再发' }] })
      case '/local-cli/permissions':
        return json(res, 200, {
          ok: true,
          sessionId: 's-i18n-1',
          permission: {
            currentValue: 'workspace-write',
            label: 'workspace write',
            options: [{ value: 'read-only' }, { value: 'workspace-write' }],
            defaultPreset: 'workspace-write',
          },
          canSet: true,
        })
      case '/local-cli/awaiting':
        return json(res, 200, {
          ok: true,
          sessionId: 's-i18n-1',
          running: false,
          pendingInput: ['question'],
          questions: {
            active: [
              {
                callId: 'call-1',
                state: 'continued',
                questions: [{ id: 'q1', question: '是否继续？', options: [{ label: '是' }, { label: '否' }], multiSelect: false }],
              },
            ],
          },
          approvals: { present: false },
        })
      case '/local-cli/approval':
        return json(res, 200, { ok: true, claim: null, pendingCount: 1 })
      default:
        return json(res, 404, { ok: false, error: `no route for ${url.pathname}` })
    }
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

async function makeHome() {
  const home = await mkdtemp(join(ROOT, 'home-'))
  await mkdir(join(home, 'local-cli'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'local-cli', 'token'), 'test-token\n')
  return home
}

/**
 * The child environment with every language source removed, so only the test's
 * own `--lang` / `DSH_ASK_LANG` can decide the output language.
 */
function baseEnv(home) {
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_ASK_NO_START: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  }
  for (const name of ENV_LANGUAGE_VARIABLES) delete env[name]
  return env
}

function runAsk(env, args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ASK, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh-ask timed out: ${args.join(' ')}\n${stdout}\n${stderr}`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function assertNoMissingKey(text, label) {
  assert.ok(!text.includes('⟦'), `${label} leaked a missing catalog key:\n${text}`)
}

// ------------------------------------------------------------------ help text

test('the help text is Chinese by default and English with --lang en', async () => {
  const home = await makeHome()
  const zh = await runAsk(baseEnv(home), ['--help'])
  assert.equal(zh.code, 0)
  assert.match(zh.stdout, /^(?:usage|用法)[:：] ?dsh-ask/)
  assert.match(zh.stdout, /显示本帮助/)
  assert.match(zh.stdout, /输出语言/)
  assertNoMissingKey(zh.stdout, 'zh help')

  const en = await runAsk(baseEnv(home), ['--lang', 'en', '--help'])
  assert.equal(en.code, 0)
  assert.match(en.stdout, /^usage: dsh-ask/)
  assert.match(en.stdout, /show this help/)
  assert.match(en.stdout, /--lang <zh\|en>/)
  assert.doesNotMatch(en.stdout, /显示本帮助/)
  assertNoMissingKey(en.stdout, 'en help')
})

test('DSH_ASK_LANG and --lang=<value> are honoured', async () => {
  const home = await makeHome()
  const fromEnv = await runAsk({ ...baseEnv(home), DSH_ASK_LANG: 'en' }, ['--help'])
  assert.match(fromEnv.stdout, /show this help/)

  const inline = await runAsk(baseEnv(home), ['--lang=zh', '--help'])
  assert.match(inline.stdout, /显示本帮助/)
})

test('the locale variables are honoured when no explicit language is given', async () => {
  const home = await makeHome()
  const en = await runAsk({ ...baseEnv(home), LANG: 'en_US.UTF-8' }, ['--help'])
  assert.match(en.stdout, /show this help/)
  // LC_ALL wins over LANG, exactly like the resolver documents.
  const zh = await runAsk({ ...baseEnv(home), LANG: 'en_US.UTF-8', LC_ALL: 'zh_CN.UTF-8' }, ['--help'])
  assert.match(zh.stdout, /显示本帮助/)
})

test('the language flag works before the subcommand too', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const result = await runAsk(baseEnv(home), ['--lang', 'en', 'status', 's-i18n-1', '--no-start', '-u', host.origin])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^session\s+s-i18n-1/m)
    assert.doesNotMatch(result.stdout, /会话/)
  } finally {
    await host.close()
  }
})

test('an unusable DSH_ASK_LANG warns once and falls back to the locale', async () => {
  const home = await makeHome()
  const result = await runAsk({ ...baseEnv(home), DSH_ASK_LANG: 'ja', LANG: 'en_US.UTF-8' }, ['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /show this help/)
  assert.match(result.stderr, /DSH_ASK_LANG/)
  assert.equal(result.stderr.match(/DSH_ASK_LANG/g)?.length, 1, 'one warning, not one per parse')
})

test('an unsupported --lang is a usage error with exit 2', async () => {
  const home = await makeHome()
  const result = await runAsk(baseEnv(home), ['--lang', 'ja', '--help'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--lang/)
  assert.match(result.stderr, /zh/)
  assert.match(result.stderr, /en/)
  assert.equal(result.stdout, '')
})

// ------------------------------------------------------------ subcommand output

test('list prints localized flags but never translates a Session title', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const zh = await runAsk(baseEnv(home), ['list', '--no-start', '-u', host.origin])
    assert.equal(zh.code, 0, zh.stderr)
    assert.match(zh.stdout, /运行中/)
    assert.ok(zh.stdout.includes(CHINESE_TITLE), zh.stdout)
    assertNoMissingKey(zh.stdout, 'zh list')

    const en = await runAsk(baseEnv(home), ['list', '--no-start', '-u', host.origin, '--lang', 'en'])
    assert.equal(en.code, 0, en.stderr)
    assert.match(en.stdout, /running/)
    assert.ok(en.stdout.includes(CHINESE_TITLE), 'user data must pass through verbatim')
    assert.doesNotMatch(en.stdout, /运行中/)
  } finally {
    await host.close()
  }
})

test('status prints Chinese labels by default and English with --lang en', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const zh = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin])
    assert.equal(zh.code, 0, zh.stderr)
    assert.match(zh.stdout, /会话/)
    assert.match(zh.stdout, /模型/)
    assert.match(zh.stdout, /上下文/)
    assertNoMissingKey(zh.stdout, 'zh status')

    const en = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin, '--lang', 'en'])
    assert.equal(en.code, 0, en.stderr)
    assert.match(en.stdout, /^session\s+s-i18n-1/m)
    assert.match(en.stdout, /^model\s+deepseek \/ deepseek-flash/m)
    assert.match(en.stdout, /^context\s+12%/m)
    assert.doesNotMatch(en.stdout, /会话/)
  } finally {
    await host.close()
  }
})

test('permissions, awaiting and approval render localized labels and keep ids', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    for (const lang of ['zh', 'en']) {
      const args = ['--no-start', '-u', host.origin, '--lang', lang]
      const permissions = await runAsk(baseEnv(home), ['permissions', 's-i18n-1', ...args])
      assert.equal(permissions.code, 0, permissions.stderr)
      assert.match(permissions.stdout, /s-i18n-1/)
      assert.match(permissions.stdout, /workspace-write/)
      assertNoMissingKey(permissions.stdout, `${lang} permissions`)

      const awaiting = await runAsk(baseEnv(home), ['awaiting', 's-i18n-1', ...args])
      assert.equal(awaiting.code, 0, awaiting.stderr)
      assert.ok(awaiting.stdout.includes('是否继续？'), 'user content is never translated')
      assert.match(awaiting.stdout, /call-1/)
      assertNoMissingKey(awaiting.stdout, `${lang} awaiting`)

      const approval = await runAsk(baseEnv(home), ['approval', 'status', ...args])
      assert.equal(approval.code, 0, approval.stderr)
      assertNoMissingKey(approval.stdout, `${lang} approval`)
    }
    const zhApproval = await runAsk(baseEnv(home), ['approval', 'status', '--no-start', '-u', host.origin])
    assert.match(zhApproval.stdout, /认领/)
    const enApproval = await runAsk(baseEnv(home), ['approval', 'status', '--no-start', '-u', host.origin, '--lang', 'en'])
    assert.match(enApproval.stdout, /claim/)
  } finally {
    await host.close()
  }
})

test('queue renders the queued prompt verbatim in both languages', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const zh = await runAsk(baseEnv(home), ['queue', 's-i18n-1', '--no-start', '-u', host.origin])
    assert.equal(zh.code, 0, zh.stderr)
    assert.ok(zh.stdout.includes('等一下再发'))
    assertNoMissingKey(zh.stdout, 'zh queue')

    const en = await runAsk(baseEnv(home), ['queue', 's-i18n-1', '--no-start', '-u', host.origin, '--lang', 'en'])
    assert.equal(en.code, 0, en.stderr)
    assert.ok(en.stdout.includes('等一下再发'))
    assert.match(en.stdout, /running/)
  } finally {
    await host.close()
  }
})

// -------------------------------------------------- desktop plugin language

/** A Host health body carrying the Desktop plugin's language setting. */
const pluginHealth = (language) => ({ cliPreferences: { language } })

test('the desktop plugin language decides when no explicit language is given', async () => {
  const home = await makeHome()
  // The locale says English; the Desktop setting says Chinese and wins.
  const zhHost = await startHost({ health: pluginHealth('zh') })
  try {
    const result = await runAsk({ ...baseEnv(home), LANG: 'en_US.UTF-8' }, ['list', '--no-start', '-u', zhHost.origin])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /运行中/)
    assert.doesNotMatch(result.stdout, /running/)
    assertNoMissingKey(result.stdout, 'plugin zh list')
    // The setting comes from the health body the CLI already probes: exactly one
    // health request, no extra network call was added.
    assert.equal(zhHost.requests.filter((path) => path.startsWith('/local-cli/health')).length, 1)
  } finally {
    await zhHost.close()
  }

  // The locale says Chinese; the Desktop setting says English and wins.
  const enHost = await startHost({ health: pluginHealth('en') })
  try {
    const result = await runAsk(
      { ...baseEnv(home), LANG: 'zh_CN.UTF-8' },
      ['status', 's-i18n-1', '--no-start', '-u', enHost.origin],
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^session\s+s-i18n-1/m)
    assert.doesNotMatch(result.stdout, /会话/)
    assertNoMissingKey(result.stdout, 'plugin en status')
  } finally {
    await enHost.close()
  }
})

test('--lang and DSH_ASK_LANG outrank the desktop plugin language', async () => {
  const home = await makeHome()
  const zhHost = await startHost({ health: pluginHealth('zh') })
  try {
    const result = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', zhHost.origin, '--lang', 'en'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^session\s+s-i18n-1/m)
    assert.doesNotMatch(result.stdout, /会话/)
  } finally {
    await zhHost.close()
  }

  const enHost = await startHost({ health: pluginHealth('en') })
  try {
    // --lang also works before the subcommand.
    const flag = await runAsk(baseEnv(home), ['--lang', 'zh', 'list', '--no-start', '-u', enHost.origin])
    assert.equal(flag.code, 0, flag.stderr)
    assert.match(flag.stdout, /运行中/)
    assert.doesNotMatch(flag.stdout, /running/)

    const env = await runAsk({ ...baseEnv(home), DSH_ASK_LANG: 'zh' }, ['status', 's-i18n-1', '--no-start', '-u', enHost.origin])
    assert.equal(env.code, 0, env.stderr)
    assert.match(env.stdout, /会话/)
  } finally {
    await enHost.close()
  }
})

test('auto, a missing field and unusable Host values fall back to the locale', async () => {
  const home = await makeHome()
  // One Host, changing what it reports, keeps this loop cheap and offline.
  let health = pluginHealth('auto')
  const host = await startHost({ health: () => health })
  try {
    const cases = [
      ['auto', pluginHealth('auto')],
      ['an older Host without the field', {}],
      ['a null cliPreferences', { cliPreferences: null }],
      ['a missing language field', { cliPreferences: {} }],
      ['an unknown value', pluginHealth('ja')],
      ['a locale-style value', pluginHealth('zh_CN')],
      ['a non-string value', { cliPreferences: { language: 7 } }],
    ]
    for (const [label, next] of cases) {
      health = next
      const result = await runAsk({ ...baseEnv(home), LANG: 'en_US.UTF-8' }, ['list', '--no-start', '-u', host.origin])
      assert.equal(result.code, 0, `${label}: ${result.stderr}`)
      assert.match(result.stdout, /running/, label)
      assert.doesNotMatch(result.stdout, /运行中/, label)
      assertNoMissingKey(result.stdout, label)
    }
    // A Chinese locale still ends at Chinese.
    health = {}
    const zh = await runAsk({ ...baseEnv(home), LANG: 'zh_CN.UTF-8' }, ['list', '--no-start', '-u', host.origin])
    assert.equal(zh.code, 0, zh.stderr)
    assert.match(zh.stdout, /运行中/)
  } finally {
    await host.close()
  }
})

test('an unusable DSH_ASK_LANG warns once while the desktop language decides', async () => {
  const home = await makeHome()
  const host = await startHost({ health: pluginHealth('zh') })
  try {
    const result = await runAsk(
      { ...baseEnv(home), DSH_ASK_LANG: 'ja', LANG: 'en_US.UTF-8' },
      ['list', '--no-start', '-u', host.origin],
    )
    assert.equal(result.code, 0, result.stderr)
    // The warning is emitted at parse time, still in the local language, once.
    assert.equal(result.stderr.match(/DSH_ASK_LANG/g)?.length, 1, result.stderr)
    // The warning is ignored, so the desktop setting then beats the locale.
    assert.match(result.stdout, /运行中/)
    assert.doesNotMatch(result.stdout, /running/)
  } finally {
    await host.close()
  }
})

test('--help and pre-connect failures keep the offline local language', async () => {
  const home = await makeHome()
  // The Desktop setting says English, but --help never connects, so it must not
  // even be consulted: the offline default (zh) decides.
  const host = await startHost({ health: pluginHealth('en') })
  try {
    const help = await runAsk(baseEnv(home), ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /显示本帮助/)
    assert.deepEqual(host.requests, [], '--help must not contact the Host')
  } finally {
    await host.close()
  }

  // A connection failure happens before the language is adopted: the local
  // locale still decides the error, not the Desktop setting.
  const offline = await runAsk({ ...baseEnv(home), LANG: 'en_US.UTF-8' }, ['list', '--no-start', '-u', 'http://127.0.0.1:1'])
  assert.equal(offline.code, 1)
  assert.match(offline.stderr, /no Host answers/)
})

test('the language is adopted on the retry path after an auto-start', { skip: process.platform !== 'darwin' }, async () => {
  const home = await makeHome()
  // A throwaway `open` on PATH: this test never launches the real Desktop app.
  const binDir = await mkdtemp(join(ROOT, 'bin-'))
  const openShim = join(binDir, 'open')
  await writeFile(openShim, '#!/bin/sh\nexit 0\n')
  await chmod(openShim, 0o755)
  const env = { ...baseEnv(home), PATH: `${binDir}:${process.env.PATH ?? ''}` }
  delete env.DSH_ASK_NO_START

  // The fake Host is "still starting" for the first two health probes and only
  // then reports the Desktop language: this is the retry path after auto-start.
  let probes = 0
  const host = await startHost({
    health: () => (++probes < 3 ? { ok: false } : pluginHealth('en')),
  })
  try {
    // No -u: connectToHost must read the recorded endpoint, otherwise it refuses
    // to auto-start. The app path does not exist, so the shim `open` is the one
    // that "launches" it.
    await writeFile(join(home, 'local-cli', 'endpoint'), `${host.origin}\n`)
    const result = await runAsk(
      env,
      ['list', '--app', join(home, 'Fake Harness.app')],
      20_000,
    )
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /running/)
    assert.doesNotMatch(result.stdout, /运行中/)
    assert.ok(probes >= 3, `expected the retry path, saw ${probes} probes`)
    // The launch notice is offline, but the ready line is printed after
    // adoption, so it already speaks the Desktop language (English here).
    assert.match(result.stderr, /启动/)
    assert.match(result.stderr, /\bready\b/)
    assert.doesNotMatch(result.stderr, /就绪/)
  } finally {
    await host.close()
  }
})

// ------------------------------------------------------------------ JSON shape

test('--json stays byte-identical across languages', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const zh = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin, '--json'])
    const en = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin, '--json', '--lang', 'en'])
    assert.equal(zh.code, 0, zh.stderr)
    assert.equal(en.code, 0, en.stderr)
    assert.equal(zh.stdout, en.stdout, 'JSON must not depend on the output language')
    const payload = JSON.parse(zh.stdout)
    assert.deepEqual(Object.keys(payload).sort(), ['ok', 'sessionId', 'status'])
    assert.equal(payload.sessionId, 's-i18n-1')
  } finally {
    await host.close()
  }
})

test('the desktop plugin language never leaks into the --json payload', async () => {
  const home = await makeHome()
  let language = 'zh'
  const host = await startHost({ health: () => pluginHealth(language) })
  try {
    const zh = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin, '--json'])
    language = 'en'
    const en = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', host.origin, '--json'])
    assert.equal(zh.code, 0, zh.stderr)
    assert.equal(en.code, 0, en.stderr)
    assert.equal(zh.stdout, en.stdout, 'the desktop language must not change JSON')
    const payload = JSON.parse(zh.stdout)
    assert.deepEqual(Object.keys(payload).sort(), ['ok', 'sessionId', 'status'])
    assert.equal(payload.sessionId, 's-i18n-1')
  } finally {
    await host.close()
  }
})

test('an unknown subcommand keeps the English machine-facing JSON untouched', async () => {
  const home = await makeHome()
  const host = await startHost()
  try {
    const result = await runAsk(baseEnv(home), ['workspaces', '--no-start', '-u', host.origin, '--json', '--lang', 'zh'])
    assert.equal(result.code, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(payload).sort(), ['ok', 'workspaces'])
    assert.equal(payload.workspaces[0].title, CHINESE_TITLE)
  } finally {
    await host.close()
  }
})

test('a local error is localized while Host text passes through verbatim', async () => {
  const home = await makeHome()
  const zh = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', 'http://127.0.0.1:1'])
  assert.equal(zh.code, 1)
  assert.match(zh.stderr, /没有 Host 响应/)
  assertNoMissingKey(zh.stderr, 'zh network error')

  const en = await runAsk(baseEnv(home), ['status', 's-i18n-1', '--no-start', '-u', 'http://127.0.0.1:1', '--lang', 'en'])
  assert.equal(en.code, 1)
  assert.match(en.stderr, /no Host answers/)
  assert.doesNotMatch(en.stderr, /没有 Host 响应/)
})
