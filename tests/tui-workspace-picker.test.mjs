/**
 * Workspace-scoped session picker tests (mock only).
 *
 * Covers: default scope = -w > active Session's real workspace/cwd > CLI cwd;
 * explicit "all sessions / current workspace" toggle; empty scope still offers
 * the lazy new-conversation entry; old Host degradation; explicit -w misses stay
 * errors (no silent global list); switching/refresh keep the scope; restoring an
 * existing Session corrects its real cwd/workspace via fetchSessionContext; a
 * new conversation from the picker uses the scope directory while creation stays
 * lazy. No real Host, Session, workspace or file is touched.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTui } from '../dsh-tui.mjs'

const BASE_CWD = '/tmp/dsh-workspace-picker-test-workspace'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, { label = 'condition', timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(2)
  }
}

function sessionRow(sessionId, title, cwd) {
  return { sessionId, title, preview: '', blank: false, running: false, updatedAt: 1, cwd }
}

const ROWS = [
  sessionRow('sess-a', 'Conversation A', '/stale/a'),
  sessionRow('sess-b', 'Conversation B', '/stale/b'),
]

const CONTEXTS = {
  'sess-a': { sessionId: 'sess-a', cwd: '/real/a', workspace: { id: 'ws-a', path: '/real/a', title: 'Workspace A' } },
  'sess-b': { sessionId: 'sess-b', cwd: '/real/b', workspace: { id: 'ws-b', path: '/real/b', title: 'Workspace B' } },
}

const WORKSPACE_PATHS = {
  'ws-a': '/real/a',
  'ws-b': '/real/b',
  'explicit-ws': '/real/explicit',
  'ws-base': BASE_CWD,
}

function makeAdapter(overrides = {}) {
  const requests = {
    listSessions: [],
    listSessionsScoped: [],
    fetchSessionContext: [],
    fetchTranscript: [],
    fetchStatus: [],
    fetchAwaiting: [],
    newConversationForDirectory: [],
    newConversationWithOptions: [],
    ask: [],
  }
  const rows = overrides.rows ?? ROWS
  const scopedRows =
    overrides.scopedRows ??
    ((request) => {
      if (request.all === true) return rows
      if (request.workspace !== undefined) {
        return rows.filter((row) => {
          const context = CONTEXTS[row.sessionId]
          return context?.workspace?.id === request.workspace || context?.workspace?.path === request.workspace
        })
      }
      return rows.filter((row) => CONTEXTS[row.sessionId]?.cwd === request.cwd)
    })
  const scopedScope =
    overrides.scopedScope ??
    ((request) => {
      if (request.all === true) return { type: 'all' }
      if (request.workspace !== undefined) {
        const path = WORKSPACE_PATHS[request.workspace]
        return {
          type: 'workspace',
          workspace: {
            id: request.workspace,
            path: path ?? `/real/${request.workspace}`,
            title: `Workspace ${request.workspace}`,
          },
        }
      }
      return { type: 'cwd', cwd: request.cwd }
    })
  const adapter = {
    endpoint: 'http://127.0.0.1:65535',
    pid: 4242,
    images: { supported: true, maxImages: 4 },
    async listSessions(limit) {
      requests.listSessions.push(limit)
      return rows.map((row) => ({ ...row }))
    },
    async listSessionsScoped(request) {
      requests.listSessionsScoped.push({ ...request })
      if (typeof overrides.listSessionsScoped === 'function') {
        return overrides.listSessionsScoped(request)
      }
      return {
        rows: scopedRows(request).map((row) => ({ ...row })),
        scope: scopedScope(request),
        supported: true,
      }
    },
    async fetchSessionContext(sessionId) {
      requests.fetchSessionContext.push(sessionId)
      if (typeof overrides.fetchSessionContext === 'function') {
        return overrides.fetchSessionContext(sessionId)
      }
      return CONTEXTS[sessionId] ?? { sessionId, cwd: `/real/${sessionId}`, workspace: null }
    },
    async fetchTranscript(sessionId, limit) {
      requests.fetchTranscript.push({ sessionId, limit })
      return { ok: true, sessionId, running: false, more: false, items: [] }
    },
    async fetchStatus(sessionId) {
      requests.fetchStatus.push(sessionId)
      return { ok: true, sessionId, status: { pendingInput: [], running: false } }
    },
    async fetchAwaiting(sessionId) {
      requests.fetchAwaiting.push(sessionId)
      return {
        ok: true,
        sessionId,
        running: false,
        pendingInput: [],
        questions: { active: [], settledCount: 0 },
        approvals: { supported: false, present: false, reason: '' },
        answerable: false,
      }
    },
    async newConversationForDirectory(cwd) {
      requests.newConversationForDirectory.push(cwd)
      return { sessionId: 'sess-created' }
    },
    async newConversationWithOptions(cwd) {
      requests.newConversationWithOptions.push(cwd)
      return { sessionId: 'sess-created-options', workspace: { id: 'explicit-ws', path: cwd, title: 'Explicit' } }
    },
    async ask(body, extra) {
      requests.ask.push({ body })
      extra?.onFrame?.({ t: 'delta', text: 'ok' })
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    },
    async fetchQueue(sessionId) {
      return { ok: true, sessionId, running: false, items: [] }
    },
    async mutateQueue(sessionId) {
      return { ok: true, sessionId, running: false, items: [] }
    },
    async listWorkspaces() {
      if (typeof overrides.listWorkspaces === 'function') return overrides.listWorkspaces()
      return []
    },
    async loadPaths() {
      return []
    },
    async loadClipboard() {
      return { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'clip.png' }
    },
    validateBatch(images) {
      return images.slice()
    },
  }
  if (overrides.withoutScoped === true) {
    delete adapter.listSessionsScoped
    delete adapter.fetchSessionContext
  }
  return { adapter, requests }
}

function boot(adapter, options = {}) {
  const { columns = 100, initialSession = '', ...rest } = options
  const views = []
  let onKey
  const output = { columns, write() {} }
  const running = runTui({
    adapter,
    createScreen: async ({ onKey: handler }) => {
      onKey = handler
      return {
        ownsTerminal: false,
        start() {},
        render(view) {
          views.push(view)
        },
        stop() {},
      }
    },
    output,
    options: {
      cwd: BASE_CWD,
      renderDelayMs: 0,
      initialSession,
      pendingPollMs: 0,
      approvalPollMs: 100,
      watchIntervalMs: 10,
      watchTimeoutMs: 500,
      ...rest,
    },
  })
  running.catch(() => {})
  const last = () => views[views.length - 1]
  const press = (str = '', key) => {
    assert.equal(typeof onKey, 'function', 'the screen factory never received onKey')
    return onKey(str, key)
  }
  const untilView = (predicate, label, timeoutMs = 3000) =>
    until(
      () => {
        const view = last()
        if (view === undefined) return undefined
        return predicate(view) === true ? view : undefined
      },
      { label, timeoutMs },
    )
  return { views, last, press, untilView, running }
}

const type = (tui, text) => tui.press(text, 'text')

async function openPicker(tui, title = '切换会话') {
  await tui.press('', 'ctrl-p')
  return tui.untilView((view) => view.modal?.kind === 'sessions' && view.modal.title === title, 'session picker')
}

async function selectItem(tui, needle) {
  const modal = tui.last().modal
  assert.ok(modal !== null, `no modal when selecting ${JSON.stringify(needle)}`)
  const index = modal.items.findIndex((item) => item.label.includes(needle))
  assert.notEqual(
    index,
    -1,
    `no item ${JSON.stringify(needle)} in ${JSON.stringify(modal.items.map((item) => item.label))}`,
  )
  for (let guard = 0; guard < modal.items.length * 3; guard += 1) {
    const selected = tui.last().modal.selected
    if (selected === index) break
    await tui.press('', selected < index ? 'down' : 'up')
  }
  assert.equal(tui.last().modal.selected, index)
  await tui.press('', 'enter')
}

async function stopTui(tui, timeoutMs = 4000) {
  const settled = tui.running.then(
    (code) => ({ code }),
    (error) => ({ error }),
  )
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raced = await Promise.race([settled, sleep(15).then(() => null)])
    if (raced !== null) {
      if ('error' in raced) throw raced.error
      return raced.code
    }
    if (Date.now() > deadline) throw new Error('runTui did not settle during cleanup')
    await tui.press('', 'ctrl-q')
  }
}

const modalText = (view) =>
  view.modal === null ? '' : view.modal.items.map((item) => `${item.label} ${item.detail}`).join('\n')

// ---------------------------------------------------------------------------
// 1. Default scope resolution
// ---------------------------------------------------------------------------

test('the picker defaults to the active Session real workspace, not the stale cwd', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    const loaded = await tui.untilView(
      (view) => view.sessionId === 'sess-a' && view.cwd === '/real/a',
      'Session context corrected',
    )
    assert.equal(loaded.cwd, '/real/a', 'fetchSessionContext corrects the stale list cwd')
    const picker = await openPicker(tui)
    assert.match(modalText(picker), /范围：Workspace ws-a/)
    assert.equal(requests.listSessionsScoped.length, 1)
    assert.deepEqual(requests.listSessionsScoped[0], { limit: 20, workspace: 'ws-a' })
    assert.match(modalText(picker), /Conversation A/)
  } finally {
    await stopTui(tui)
  }
})

test('an explicit -w always wins over the active Session workspace', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a', workspace: 'explicit-ws' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.cwd === '/real/a', 'loaded')
    const picker = await openPicker(tui)
    assert.equal(requests.listSessionsScoped[0].workspace, 'explicit-ws')
    assert.match(modalText(picker), /范围：Workspace explicit-ws/)
    assert.match(modalText(picker), /首次发送时创建/)
  } finally {
    await stopTui(tui)
  }
})

test('a bare draft defaults to the CLI cwd, or its registered workspace', async () => {
  {
    const { adapter, requests } = makeAdapter()
    const tui = boot(adapter)
    try {
      await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'draft')
      await openPicker(tui)
      assert.deepEqual(requests.listSessionsScoped[0], { limit: 20, cwd: BASE_CWD })
    } finally {
      await stopTui(tui)
    }
  }
  {
    const { adapter, requests } = makeAdapter({
      listWorkspaces: () => [{ id: 'ws-base', title: 'Base workspace', path: BASE_CWD }],
    })
    const tui = boot(adapter)
    try {
      await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'draft')
      await openPicker(tui)
      assert.deepEqual(requests.listSessionsScoped[0], { limit: 20, workspace: 'ws-base' })
    } finally {
      await stopTui(tui)
    }
  }
})

// ---------------------------------------------------------------------------
// 2. Scope toggle / empty list / old Host / -w error
// ---------------------------------------------------------------------------

test('the visible scope item toggles between all sessions and the default workspace', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a', 'loaded')
    let picker = await openPicker(tui)
    assert.ok(picker.modal.items.some((item) => item.label.startsWith('范围：')))
    await selectItem(tui, '范围：Workspace ws-a')
    picker = await tui.untilView(
      (view) => view.modal?.kind === 'sessions' && modalText(view).includes('范围：全部会话'),
      'all scope',
    )
    assert.equal(requests.listSessionsScoped.at(-1).all, true)
    assert.match(modalText(picker), /Conversation B/)

    await selectItem(tui, '范围：全部会话')
    picker = await tui.untilView(
      (view) => modalText(view).includes('范围：Workspace ws-a'),
      'back to default scope',
    )
    assert.deepEqual(requests.listSessionsScoped.at(-1), { limit: 20, workspace: 'ws-a' })
    // Search is client-side and must not change the scope; refreshing keeps it.
    await type(tui, 'Conversation')
    await tui.untilView(
      (view) => view.modal?.kind === 'sessions' && view.modal.query === 'Conversation',
      'picker search',
    )
    await tui.press('', 'ctrl-p')
    await tui.untilView((view) => view.modal?.kind === 'sessions', 'refreshed picker')
    assert.deepEqual(requests.listSessionsScoped.at(-1), { limit: 20, workspace: 'ws-a' })
    assert.equal(tui.last().modal.query, 'Conversation', 'the search text survives a refresh')
    for (let index = 0; index < 'Conversation'.length; index += 1) {
      await tui.press('', 'backspace')
    }
    await tui.untilView(
      (view) => view.modal?.kind === 'sessions' && modalText(view).includes('范围：Workspace ws-a'),
      'scope label restored after clearing search',
    )
  } finally {
    await stopTui(tui)
  }
})

test('an empty scope still offers the local new-conversation entry and creates nothing', async () => {
  const { adapter, requests } = makeAdapter({ scopedRows: () => [] })
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.cwd === '/real/a', 'loaded')
    const picker = await openPicker(tui)
    assert.match(modalText(picker), /当前范围内没有会话/)
    assert.ok(picker.modal.items.some((item) => item.label === '新建当前目录会话'))
    assert.equal(requests.newConversationForDirectory.length, 0)
    await selectItem(tui, '新建当前目录会话')
    const draft = await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'scope draft')
    assert.equal(draft.cwd, '/real/a', 'the new draft uses the picker scope directory')
    assert.equal(requests.newConversationForDirectory.length, 0, 'the draft does not create a Host Session')
  } finally {
    await stopTui(tui)
  }
})

test('an explicit -w miss stays an error and never silently lists all sessions', async () => {
  const { adapter, requests } = makeAdapter({
    listSessionsScoped: (request) => {
      if (request.all === true) {
        return {
          rows: ROWS.map((row) => ({ ...row })),
          scope: { type: 'all' },
          supported: true,
        }
      }
      throw Object.assign(new Error('no workspace matches'), { code: 'no-such-workspace' })
    },
  })
  const tui = boot(adapter, { initialSession: 'sess-a', workspace: 'missing-ws' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a', 'loaded')
    let picker = await openPicker(tui)
    assert.match(modalText(picker), /找不到 workspace missing-ws/)
    assert.match(modalText(picker), /未回退全部会话/)
    assert.equal(requests.listSessions.length, 0, 'no silent global fallback')
    assert.equal(picker.modal.items.some((item) => item.label.includes('Conversation A')), false)

    // An explicit user choice may still request all sessions.
    await selectItem(tui, '范围：')
    picker = await tui.untilView(
      (view) => view.modal?.kind === 'sessions' && modalText(view).includes('Conversation A'),
      'explicit all scope',
    )
    assert.equal(requests.listSessionsScoped.at(-1).all, true)
    assert.match(modalText(picker), /Conversation A/)
  } finally {
    await stopTui(tui)
  }
})

test('an old Host without scoped sessions degrades to the global list with an explicit banner', async () => {
  const { adapter, requests } = makeAdapter({ withoutScoped: true })
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a', 'loaded')
    const picker = await openPicker(tui)
    assert.match(modalText(picker), /当前 Host 不支持范围筛选/)
    assert.match(modalText(picker), /已显示全部会话/)
    assert.equal(requests.listSessions.length, 1)
    assert.ok(picker.modal.items.some((item) => item.label.includes('Conversation B')))
    assert.equal(picker.modal.items.some((item) => item.label.startsWith('范围：')), false)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 3. Restoring real context / switch / new conversation from scope
// ---------------------------------------------------------------------------

test('switching to an existing Session corrects its real cwd before it is shown', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.cwd === '/real/a', 'A loaded')
    const picker = await openPicker(tui)
    // The default scope only lists the active workspace; switch scope explicitly.
    await selectItem(tui, '范围：Workspace ws-a')
    await tui.untilView((view) => modalText(view).includes('范围：全部会话'), 'all sessions scope')
    await selectItem(tui, 'Conversation B')
    const switched = await tui.untilView(
      (view) => view.sessionId === 'sess-b' && view.status === 'ready',
      'switched to B',
    )
    assert.equal(switched.cwd, '/real/b', 'B must show its real cwd, not the stale list row')
    assert.ok(requests.fetchSessionContext.includes('sess-b'))
    const pickerB = await openPicker(tui)
    assert.deepEqual(requests.listSessionsScoped.at(-1), { limit: 20, workspace: 'ws-b' })
    assert.match(modalText(pickerB), /范围：Workspace ws-b/)
  } finally {
    await stopTui(tui)
  }
})

test('a new conversation from the picker uses the scope directory and still creates lazily', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.cwd === '/real/a', 'loaded')
    await openPicker(tui)
    await selectItem(tui, '新建当前目录会话')
    const draft = await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'draft')
    assert.equal(draft.cwd, '/real/a')
    assert.equal(requests.newConversationForDirectory.length, 0, 'selecting new is still lazy')
    await type(tui, 'create from scope')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.sessionId === 'sess-created', 'created on first send')
    assert.deepEqual(requests.newConversationForDirectory, ['/real/a'])
    assert.equal(requests.ask[0].body.sessionId, 'sess-created')
  } finally {
    await stopTui(tui)
  }
})

test('the initial resume picker (no active Session) defaults to the CLI cwd', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialPicker: true })
  try {
    const picker = await tui.untilView(
      (view) => view.modal?.kind === 'sessions' && view.modal.title === '选择会话',
      'initial resume picker',
    )
    assert.deepEqual(requests.listSessionsScoped[0], { limit: 20, cwd: BASE_CWD })
    assert.match(modalText(picker), /范围：/)
    assert.ok(picker.modal.items.some((item) => item.label === '新建当前目录会话'))
  } finally {
    await stopTui(tui)
  }
})
