/**
 * Plugin config tests: `Config.language` and `health.cliPreferences.language`.
 *
 * A fake Host context registers the bridge routes without a Harness profile.
 * The acceptance points are:
 *
 *   1. the schema serializes the way a settings form reads it (union of the
 *      three values, `default: 'auto'`, `volatile: true`, localized member
 *      descriptions);
 *   2. `health` re-reads the live volatile reference on every request, so a
 *      settings write is visible without remounting the plugin;
 *   3. the pre-config entry point still works: `apply(ctx)` without a config
 *      keeps the old behavior and reports `auto`.
 *
 * The locale files are checked only for the plugin display title:
 * `DSH Ask 终端` (zh) / `DSH Ask Terminal` (en).
 */

import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, apply } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-'))
process.env.DSH_HOME = ROOT

async function bridgeToken() {
  const file = join(ROOT, 'local-cli', 'token')
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const value = (await readFile(file, 'utf8')).trim()
      if (value !== '') return value
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
    chunks: [],
    writeHead(status) {
      this.status = status
      return this
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
    },
  }
  Object.defineProperty(res, 'text', {
    get() {
      return this.chunks.join('')
    },
  })
  return res
}

function makeRequest(token) {
  return {
    method: 'GET',
    url: '/local-cli/health',
    headers: { 'x-local-cli-token': token },
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this
    },
    async *[Symbol.asyncIterator]() {},
  }
}

/** The services the bridge injects, stubbed down to what health touches. */
function createContext(routes) {
  return {
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
        return 'http://127.0.0.1:45999'
      },
    },
    workspaceRegistry: {
      list() {
        return []
      },
    },
    sessionController: {
      async list() {
        return { items: [] }
      },
      async projections() {
        throw new TypeError('not used by this test')
      },
      async state() {
        throw new TypeError('not used by this test')
      },
    },
  }
}

async function mount(config) {
  const routes = new Map()
  apply(createContext(routes), config)
  return { routes, token: await bridgeToken() }
}

async function readHealth(env) {
  const handler = env.routes.get('/local-cli/health')
  assert.equal(typeof handler, 'function', 'health route must be registered')
  const res = makeResponse()
  await handler(makeRequest(env.token), res)
  assert.equal(res.status, 200)
  return JSON.parse(res.text)
}

function languageSchema() {
  const serialized = JSON.parse(JSON.stringify(Config))
  const refs = serialized.refs
  const root = refs[String(serialized.uid)]
  const node = refs[String(root.dict.language)]
  assert.equal(node.type, 'union', 'language must serialize as a union')
  return { node, refs }
}

test('the language schema serializes for a settings form', () => {
  const { node, refs } = languageSchema()
  assert.equal(node.meta.default, 'auto')
  assert.equal(node.meta.volatile, true)
  assert.equal(node.meta.description[''], 'dsh-ask interface language; auto follows the CLI flags and the locale.')
  // The field itself carries the same locale keys, so a locale-aware form can
  // label it without falling back to the English string.
  assert.match(node.meta.description.zh, /dsh-ask 的界面语言/)
  assert.match(node.meta.description.en, /interface language/)

  const members = node.list.map((uid) => refs[String(uid)])
  assert.deepEqual(members.map((member) => member.value), ['auto', 'zh', 'en'])
  // The three options carry the localized descriptions keyed by the schema's
  // locale keys ('zh' / 'en'), which is what a locale-aware form reads.
  assert.deepEqual(
    members.map((member) => member.meta.description.zh),
    ['自动：跟随 CLI 参数与系统 locale', '中文界面', '英文界面'],
  )
  assert.deepEqual(
    members.map((member) => member.meta.description.en),
    ['Automatic: follow the CLI flags and the locale', 'Chinese interface', 'English interface'],
  )
})

test('health reads the live volatile reference on every request', async () => {
  let value = 'zh'
  const env = await mount({ language: { get: () => value } })
  assert.equal((await readHealth(env)).cliPreferences.language, 'zh')

  value = 'en'
  assert.equal((await readHealth(env)).cliPreferences.language, 'en', 'no remount needed')
})

test('health reports auto when the setting is auto, absent or unusable', async () => {
  for (const config of [
    { language: { get: () => 'auto' } },
    { language: 'zh' }, // profile overlay value, not a live reference
    { language: { get: () => 'fr' } }, // never forwarded to the CLI
    undefined,
  ]) {
    const env = await mount(config)
    const expected = config?.language === 'zh' ? 'zh' : 'auto'
    assert.equal((await readHealth(env)).cliPreferences.language, expected)
  }
})

test('apply(ctx) without a config keeps the pre-config behavior', async () => {
  const env = await mount()
  const body = await readHealth(env)
  assert.equal(body.ok, true)
  assert.equal(body.cliPreferences.language, 'auto')
})

test('both locale files present the plugin display title', async () => {
  const expected = { zh: 'DSH Ask 终端', en: 'DSH Ask Terminal' }
  for (const locale of ['zh', 'en']) {
    const file = join(HERE, '..', 'locale', `${locale}.json`)
    const payload = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(payload.meta.title, expected[locale], `${locale} plugin title`)
  }
})
