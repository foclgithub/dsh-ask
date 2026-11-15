/**
 * Lazy-conversation tests for the full-screen TUI.
 *
 * Every TTY new-conversation entry (bare startup, Ctrl+N, /new, both picker
 * "new" choices and the resume-picker Esc) must only open a local draft; no
 * Host Session is created until the first real send of text/attachments. The
 * explicit non-interactive `dsh-ask new` CLI path is outside the TUI and stays
 * immediate.
 *
 * These tests are mock-only: no Host, no real Session and no real approval.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTui } from '../dsh-tui.mjs'

const BASE_CWD = '/tmp/dsh-lazy-session-test-workspace'
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

function awaitingPayload() {
  return {
    ok: true,
    running: false,
    pendingInput: [],
    questions: { active: [], settledCount: 0 },
    approvals: { supported: false, present: false, reason: '' },
    answerable: false,
  }
}

function makeAdapter(overrides = {}) {
  const requests = {
    listSessions: [],
    fetchTranscript: [],
    fetchStatus: [],
    fetchAwaiting: [],
    fetchPermissions: [],
    newConversationForDirectory: [],
    newConversationWithOptions: [],
    ask: [],
    loadClipboard: [],
    claimApprovalChannel: [],
    releaseApprovalChannel: [],
    fetchApprovalChannel: [],
    submitApprovalDecision: [],
  }
  const rows = overrides.rows ?? [
    sessionRow('sess-a', 'Conversation A', '/work/a'),
    sessionRow('sess-b', 'Conversation B', '/work/b'),
  ]
  const channel = { claim: null, pending: [] }
  const adapter = {
    endpoint: 'http://127.0.0.1:65535',
    pid: 4242,
    images: { supported: true, maxImages: 4 },
    async listSessions(limit) {
      requests.listSessions.push(limit)
      return rows.map((row) => ({ ...row }))
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
      return { ...awaitingPayload(), sessionId }
    },
    async fetchPermissions(sessionId) {
      requests.fetchPermissions.push(sessionId)
      return {
        ok: true,
        sessionId,
        permission: { currentValue: 'workspace-write', label: '工作区写入', options: [], defaultPreset: 'workspace-write' },
        canSet: true,
      }
    },
    async newConversationForDirectory(cwd) {
      requests.newConversationForDirectory.push(cwd)
      if (typeof overrides.newConversationForDirectory === 'function') {
        return overrides.newConversationForDirectory(cwd)
      }
      return { sessionId: 'sess-new' }
    },
    async newConversationWithOptions(cwd) {
      requests.newConversationWithOptions.push(cwd)
      if (typeof overrides.newConversationWithOptions === 'function') {
        return overrides.newConversationWithOptions(cwd)
      }
      return { sessionId: 'sess-new-options', workspace: { title: 'my-workspace', path: BASE_CWD } }
    },
    async ask(body, extra) {
      requests.ask.push({ body, signal: extra?.signal })
      if (typeof overrides.ask === 'function') return overrides.ask(body, extra)
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
      return []
    },
    async loadPaths() {
      return []
    },
    async loadClipboard() {
      requests.loadClipboard.push(true)
      return { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'clip.png' }
    },
    validateBatch(images) {
      return images.slice()
    },
    async fetchApprovalChannel(claimId) {
      requests.fetchApprovalChannel.push(claimId)
      if (channel.claim === null) {
        return { ok: true, claim: null, connected: false, pendingCount: 0, maxPending: 8, pending: [] }
      }
      return {
        ok: true,
        claim: { ...channel.claim },
        connected: true,
        pendingCount: channel.pending.length,
        maxPending: 8,
        pending: channel.pending.map((request) => ({ ...request })),
      }
    },
    async claimApprovalChannel(request) {
      requests.claimApprovalChannel.push(request)
      channel.claim = {
        claimId: 'claim-1',
        sessionId: request.sessionId,
        expiresAt: Date.now() + 60_000,
        leaseMs: request.leaseMs ?? 60_000,
      }
      return {
        ok: true,
        claimId: channel.claim.claimId,
        sessionId: channel.claim.sessionId,
        expiresAt: channel.claim.expiresAt,
        leaseMs: channel.claim.leaseMs,
      }
    },
    async heartbeatApprovalChannel() {
      return { ok: true, claimId: 'claim-1', expiresAt: Date.now() + 60_000, leaseMs: 60_000 }
    },
    async releaseApprovalChannel(request) {
      requests.releaseApprovalChannel.push(request)
      const delegated = channel.pending.length
      channel.claim = null
      channel.pending = []
      return { ok: true, released: true, delegated }
    },
    async submitApprovalDecision() {
      throw new Error('must not submit approvals in lazy-session tests')
    },
  }
  if (typeof overrides.ask === 'function') adapter.ask = overrides.ask
  return { adapter, requests, channel }
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
        if (view === undefined || predicate(view) !== true) return undefined
        return view
      },
      { label, timeoutMs },
    )
  return { views, last, press, untilView, running }
}

const type = (tui, text) => tui.press(text, 'text')

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

const messagesText = (view) => view.messages.map((message) => message.text).join('\n')

// ---------------------------------------------------------------------------
// 1. Bare startup / new entries are drafts
// ---------------------------------------------------------------------------

test('bare startup is only a local draft; the first text send creates exactly one Session', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    const draft = await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    assert.equal(draft.modal, null)
    assert.match(draft.hint, /发送时创建会话/)
    assert.equal(requests.newConversationForDirectory.length, 0)
    assert.equal(requests.newConversationWithOptions.length, 0)
    assert.equal(requests.ask.length, 0)

    await type(tui, 'first message')
    await tui.press('', 'enter')
    const created = await tui.untilView(
      (view) => view.sessionId === 'sess-new' && view.status === 'ready',
      'first send creates the Session',
    )
    assert.deepEqual(requests.newConversationForDirectory, [BASE_CWD])
    assert.deepEqual(requests.ask.map((entry) => entry.body.sessionId), ['sess-new'])
    assert.equal(created.messages.some((message) => message.text === 'first message'), true)
  } finally {
    await stopTui(tui)
  }
})

test('quitting a bare draft creates zero Host Sessions', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'unsent draft')
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    assert.equal(requests.newConversationForDirectory.length, 0)
    assert.equal(requests.newConversationWithOptions.length, 0)
    assert.equal(requests.ask.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('/new and Ctrl+N open local drafts without creating a Host Session', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.status === 'ready', 'host Session loaded')
    await type(tui, '/new')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', '/new draft')
    assert.equal(requests.newConversationForDirectory.length, 0)

    await type(tui, 'kept')
    await tui.press('', 'ctrl-n')
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'Ctrl+N draft')
    assert.equal(requests.newConversationForDirectory.length, 0)
    assert.equal(requests.newConversationWithOptions.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('the picker "new conversation" entry opens a draft instead of creating', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.status === 'ready', 'host Session loaded')
    await tui.press('', 'ctrl-p')
    await tui.untilView((view) => view.modal?.kind === 'sessions' && view.modal.items.length >= 2, 'picker')
    await selectItem(tui, '新建当前目录会话')
    const draft = await tui.untilView((view) => view.modal === null && view.sessionId === '' && view.status === 'draft', 'picker draft')
    assert.equal(draft.status, 'draft')
    assert.equal(requests.newConversationForDirectory.length, 0)
    assert.equal(requests.newConversationWithOptions.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('switching to an old Session from a draft creates nothing', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'never sent')
    await tui.press('', 'ctrl-p')
    await tui.untilView((view) => view.modal?.kind === 'sessions', 'picker')
    await selectItem(tui, 'Conversation A')
    const view = await tui.untilView(
      (view) => view.sessionId === 'sess-a' && view.status === 'ready',
      'switched to the old Session',
    )
    assert.equal(view.modal, null)
    assert.equal(requests.newConversationForDirectory.length, 0)
    assert.equal(requests.newConversationWithOptions.length, 0)
    assert.equal(requests.ask.length, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 2. First send: create once, preserve drafts, failures keep the ID
// ---------------------------------------------------------------------------

test('the first image-only send creates one Session and carries the attachment', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'image draft')
    assert.equal(requests.newConversationForDirectory.length, 0, 'attaching must not create')
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (v) => v.sessionId === 'sess-new' && v.status === 'ready' && v.attachments.length === 0,
      'image send creates and clears the pending attachment',
    )
    assert.equal(requests.newConversationForDirectory.length, 1)
    assert.equal(requests.ask.length, 1)
    assert.equal(requests.ask[0].body.sessionId, 'sess-new')
    assert.deepEqual(requests.ask[0].body.images.map((image) => image.name), ['clip.png'])
    assert.equal(view.messages.some((message) => message.role === 'user'), true)
  } finally {
    await stopTui(tui)
  }
})

test('a double Enter during the first send creates and asks exactly once', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { adapter, requests } = makeAdapter({
    newConversationForDirectory: async () => {
      await gate
      return { sessionId: 'sess-new' }
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'first')
    await tui.press('', 'enter')
    await tui.press('', 'enter')
    assert.equal(requests.newConversationForDirectory.length, 1, 'only one create may be in flight')
    release()
    await tui.untilView((view) => view.sessionId === 'sess-new' && view.status === 'ready', 'created')
    assert.equal(requests.newConversationForDirectory.length, 1)
    assert.equal(requests.ask.length, 1)
  } finally {
    release()
    await stopTui(tui)
  }
})

test('a definite create failure keeps the text/attachment draft and sends nothing', async () => {
  const { adapter, requests } = makeAdapter({
    newConversationForDirectory: () => {
      const error = new Error('cannot create a workspace here')
      error.code = 'create-failed'
      throw error
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'keep me')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'image draft')
    await tui.press('', 'enter')
    const view = await tui.untilView((v) => messagesText(v).includes('创建会话失败'), 'create failure reported')
    assert.equal(view.sessionId, '')
    assert.equal(view.status, 'draft')
    assert.equal(view.input, 'keep me', 'the text draft survives a failed create')
    assert.equal(view.attachments.length, 1, 'the image draft survives a failed create')
    assert.equal(requests.newConversationForDirectory.length, 1)
    assert.equal(requests.ask.length, 0, 'nothing is sent when the Session was not created')
  } finally {
    await stopTui(tui)
  }
})

test('an unknown create result is not re-created automatically on the next Enter', async () => {
  const { adapter, requests } = makeAdapter({
    newConversationForDirectory: () => ({}),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'unknown create')
    await tui.press('', 'enter')
    const first = await tui.untilView((v) => messagesText(v).includes('创建会话结果未知'), 'unknown create reported')
    assert.equal(first.sessionId, '')
    assert.equal(requests.newConversationForDirectory.length, 1)
    await tui.press('', 'enter')
    await sleep(30)
    assert.equal(
      requests.newConversationForDirectory.length,
      1,
      'an unknown create result must not trigger a second Host Session',
    )
    assert.match(messagesText(tui.last()), /不会自动重复创建/)
  } finally {
    await stopTui(tui)
  }
})

test('a created Session keeps its ID when the first send fails and is not re-created', async () => {
  const { adapter, requests } = makeAdapter({
    ask: async (body) => {
      requests.ask.push({ body })
      throw new Error('socket hang up')
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await type(tui, 'first')
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (v) => v.sessionId === 'sess-new' && messagesText(v).includes('投递结果未知'),
      'send failure keeps the created Session',
    )
    assert.equal(requests.newConversationForDirectory.length, 1)
    assert.equal(requests.ask.length, 1)
    await tui.press('', 'enter')
    await sleep(30)
    assert.equal(requests.newConversationForDirectory.length, 1, 'a created Session is never created again')
    assert.equal(requests.ask.length, 1, 'an unknown delivery is not re-sent automatically')
    assert.equal(view.status, 'ready')
  } finally {
    await stopTui(tui)
  }
})

test('the first send honours an explicit -w workspace option', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { workspace: 'my-workspace' })
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'workspace draft')
    assert.equal(requests.newConversationWithOptions.length, 0)
    await type(tui, 'create workspace')
    await tui.press('', 'enter')
    await tui.untilView(
      (view) => view.sessionId === 'sess-new-options' && view.status === 'ready',
      'created with options',
    )
    assert.deepEqual(requests.newConversationWithOptions, [BASE_CWD])
    assert.equal(requests.newConversationForDirectory.length, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 3. Pre-create commands / approval release regression
// ---------------------------------------------------------------------------

test('/status, /permissions and /approvals on a draft only explain and create nothing', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'local draft')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'image draft before commands')
    for (const command of ['/status', '/permissions', '/approvals']) {
      await type(tui, command)
      await tui.press('', 'enter')
      const view = await tui.untilView(
        (v) => messagesText(v).includes('尚未创建会话') || messagesText(v).includes('未创建（本地草稿）'),
        `${command} draft hint`,
      )
      assert.equal(requests.newConversationForDirectory.length, 0, `${command} must not create`)
      assert.equal(requests.newConversationWithOptions.length, 0)
      assert.equal(requests.fetchPermissions.length, 0, `${command} must not hit Host permission reads`)
      assert.equal(requests.fetchAwaiting.length, 0, `${command} must not hit Host awaiting reads`)
      assert.equal(tui.last().attachments.length, 1, `${command} must preserve the image draft`)
    }
  } finally {
    await stopTui(tui)
  }
})

test('/new from a claimed Session releases the terminal approval claim without creating', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter, { initialSession: 'sess-a' })
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.status === 'ready', 'host Session loaded')
    await tui.press('', 'f2')
    await tui.untilView((view) => view.modal?.kind === 'approvals', 'approvals')
    await selectItem(tui, '接入当前会话终端审批')
    await tui.untilView((view) => view.modal?.kind === 'approval-claim-confirm', 'claim confirm')
    await selectItem(tui, '确认接入终端审批')
    await tui.untilView((view) => view.modal === null, 'claim settles')
    assert.equal(requests.claimApprovalChannel.length, 1)

    await type(tui, '/new')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.sessionId === '' && view.status === 'draft', 'new draft')
    assert.equal(requests.releaseApprovalChannel.length, 1, 'switching to a draft still releases the claim')
    assert.equal(requests.releaseApprovalChannel[0].reason, 'shutdown')
    assert.equal(requests.newConversationForDirectory.length, 0)
  } finally {
    await stopTui(tui)
  }
})
