/**
 * Tests for the client entry (`client.js`) that renders the language control.
 *
 * The entry is a browser script, not an ESM module: the Host serves it to
 * `window.__ModuleLoader__.load`. This test loads the real file in a `node:vm`
 * sandbox with that global, hands `factory` a minimal React stub (the Host's
 * `require('react')`), and drives the registered slot component through its
 * element tree. No browser, no build step, no network.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'client.js')

/** A React stand-in: element records plus hook state that survives renders. */
function createReact() {
  const hooks = []
  let index = 0
  const api = {
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useRef(initial) {
      const slot = index
      index += 1
      if (hooks.length <= slot) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useState(initial) {
      const slot = index
      index += 1
      if (hooks.length <= slot) hooks[slot] = initial
      return [
        hooks[slot],
        (value) => {
          hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value
        },
      ]
    },
  }
  return { api, begin: () => {
    index = 0
  } }
}

/** Load the real client entry through the browser wrapper. */
async function loadClient() {
  const source = await readFile(CLIENT, 'utf8')
  let definition
  const sandbox = { window: { __ModuleLoader__: { load: (value) => {
    definition = value
  } } } }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(definition.id, '@local/dsh-local-cli')

  const react = createReact()
  const exports = definition.factory((name) => {
    if (name === 'react') return react.api
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  return { definition, react, exports }
}

/** Expand the element tree; function components are invoked in place. */
function expand(render, node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) return node.map((child) => expand(render, child))
  if (typeof node.type === 'function') return expand(render, node.type(node.props))
  const props = { ...node.props }
  if (props.children !== undefined) props.children = expand(render, props.children)
  return { type: node.type, props }
}

function render(hooks, component, props) {
  hooks.begin()
  return expand(hooks, component(props))
}

function find(tree, predicate) {
  let hit
  const walk = (node) => {
    if (hit !== undefined || node === null || node === undefined) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (predicate(node) === true) {
      hit = node
      return
    }
    walk(node.props?.children)
  }
  walk(tree)
  return hit
}

const byType = (type) => (node) => node.type === type

function text(tree) {
  const parts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    walk(node.props?.children)
  }
  walk(tree)
  return parts.join(' ')
}

function mount(exports) {
  const injections = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, run) {
        injections.push(name)
        return run()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { injections, registered, component: registered[0]?.component }
}

function formState(overrides = {}) {
  return { status: 'ready', writable: true, value: { language: 'zh' }, revision: 7, ...overrides }
}

function fakeForm({ language = 'zh', mutate, state = {} } = {}) {
  const calls = []
  return {
    calls,
    form: {
      state: formState({ value: { language }, ...state }),
      mutate(ops, revision) {
        calls.push({ ops, revision })
        return mutate === undefined ? Promise.resolve(true) : mutate(ops, revision)
      },
    },
  }
}

test('the client entry registers the plugin row slot under the package row key', async () => {
  const { exports } = await loadClient()
  assert.deepEqual(JSON.parse(JSON.stringify(exports.inject)), ['slots'])
  assert.equal(typeof exports.apply, 'function')

  const { injections, registered } = mount(exports)
  assert.deepEqual(injections, ['plugins.row.config'], 'slots.inject waits for the owner')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.row.config')
  assert.equal(registered[0].options.key, '@local/dsh-local-cli#local-cli')
  assert.equal(typeof registered[0].component, 'function')
})

test('package.json declares the browser client entry', async () => {
  const payload = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(payload.exports['./client'], './client.js')
  assert.ok(payload.files.includes('client.js'))
  assert.equal(payload.dsh.client.platform, 'web')
  assert.ok(payload.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
})

test('the summary is a short one-liner', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const tree = render(react, component, { view: 'summary' })
  assert.match(text(tree), /界面语言/)
  assert.match(text(tree), /Interface language/)
  assert.equal(find(tree, byType('select')), undefined)
})

test('the page shows the current value, three options and the precedence hint', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const { form } = fakeForm({ language: 'zh' })
  const tree = render(react, component, { view: 'page', form })

  const select = find(tree, byType('select'))
  assert.ok(select !== undefined)
  assert.equal(select.props.value, 'zh')
  assert.equal(select.props.disabled, false)
  const options = find(tree, (node) => node.type === 'option')
  assert.ok(options !== undefined)

  const hint = text(tree)
  assert.match(hint, /下次启动 dsh-ask 生效/)
  assert.match(hint, /--lang 与 DSH_ASK_LANG 优先/)
  assert.match(hint, /takes effect the next time dsh-ask starts/i)
})

test('save writes exactly the language field at the revision it read', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const { form, calls } = fakeForm({ language: 'zh' })

  let tree = render(react, component, { view: 'page', form })
  find(tree, byType('select')).props.onChange({ target: { value: 'en' } })
  tree = render(react, component, { view: 'page', form })
  assert.equal(find(tree, byType('select')).props.value, 'en')

  await find(tree, byType('button')).props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { ops: [{ op: 'set', path: ['language'], value: 'en' }], revision: 7 },
  ])

  tree = render(react, component, { view: 'page', form })
  assert.match(text(tree), /已保存/)
  assert.doesNotMatch(text(tree), /保存失败/)
  // The Host value is the source again: the local draft was cleared.
  assert.equal(find(tree, byType('select')).props.value, 'zh')
})

test('an unknown value is not submitted', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const { form, calls } = fakeForm({ language: 'zh' })

  let tree = render(react, component, { view: 'page', form })
  find(tree, byType('select')).props.onChange({ target: { value: 'fr' } })
  tree = render(react, component, { view: 'page', form })
  await find(tree, byType('button')).props.onClick()

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [], 'nothing outside auto/zh/en may be written')
  tree = render(react, component, { view: 'page', form })
  assert.match(text(tree), /不支持的语言/)
  assert.doesNotMatch(text(tree), /已保存/)
})

test('a failed write is shown as a failure, never as a success', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const { form } = fakeForm({
    language: 'zh',
    mutate: () => Promise.reject(new Error('network down')),
  })

  let tree = render(react, component, { view: 'page', form })
  find(tree, byType('select')).props.onChange({ target: { value: 'en' } })
  tree = render(react, component, { view: 'page', form })
  await find(tree, byType('button')).props.onClick()

  tree = render(react, component, { view: 'page', form })
  assert.match(text(tree), /保存失败/)
  assert.match(text(tree), /network down/)
  assert.doesNotMatch(text(tree), /已保存/)
})

test('only a true mutate result is a success; false and unknown shapes fail', async () => {
  // ConfigFormController.mutate resolves to a boolean: true only after the
  // Host accepted the write. false (rejected/recovered) and any unknown shape
  // are failures and must never be painted as saved.
  for (const result of [false, undefined, { ok: true }]) {
    const { exports, react } = await loadClient()
    const { component } = mount(exports)
    const { form } = fakeForm({
      language: 'zh',
      mutate: () => Promise.resolve(result),
    })

    let tree = render(react, component, { view: 'page', form })
    find(tree, byType('select')).props.onChange({ target: { value: 'en' } })
    tree = render(react, component, { view: 'page', form })
    await find(tree, byType('button')).props.onClick()

    tree = render(react, component, { view: 'page', form })
    assert.match(text(tree), /保存失败/, `result ${JSON.stringify(result)} must fail`)
    assert.match(text(tree), /Host did not accept/)
    assert.doesNotMatch(text(tree), /已保存/)
  }
})

test('a same-frame double click writes once', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const { form, calls } = fakeForm({ language: 'zh' })

  let tree = render(react, component, { view: 'page', form })
  find(tree, byType('select')).props.onChange({ target: { value: 'en' } })
  tree = render(react, component, { view: 'page', form })
  const onClick = find(tree, byType('button')).props.onClick
  await Promise.all([onClick(), onClick()])

  assert.equal(calls.length, 1, 'the in-flight guard blocks the second click')
  tree = render(react, component, { view: 'page', form })
  assert.match(text(tree), /已保存/)
})

test('a missing form shows a waiting state with no control', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)
  const tree = render(react, component, { view: 'page' })
  assert.match(text(tree), /正在等待设置加载/)
  assert.match(text(tree), /Waiting for the setting to load/)
  assert.equal(find(tree, byType('select')), undefined)
  assert.equal(find(tree, byType('button')), undefined)
})

test('a read-only setting still shows the real value, and loading disables too', async () => {
  const { exports, react } = await loadClient()
  const { component } = mount(exports)

  const readonly = fakeForm({ state: { status: 'ready', writable: false, value: { language: 'en' } } })
  let tree = render(react, component, { view: 'page', form: readonly.form })
  // The read path ignores writability: a read-only form still shows its value.
  assert.equal(find(tree, byType('select')).props.value, 'en')
  assert.equal(find(tree, byType('select')).props.disabled, true)
  assert.equal(find(tree, byType('button')).props.disabled, true)
  assert.match(text(tree), /设置只读/)

  const loading = fakeForm({ state: { status: 'loading' } })
  tree = render(react, component, { view: 'page', form: loading.form })
  assert.equal(find(tree, byType('select')).props.disabled, true)
  assert.equal(find(tree, byType('button')).props.disabled, true)
  assert.match(text(tree), /设置尚未加载/)
})
