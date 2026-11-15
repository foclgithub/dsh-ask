/**
 * Terminal approval-channel tests for the full-screen TUI.
 *
 * These mock-only tests pin the explicit, per-Session approval contract:
 *
 *   - nothing is claimed automatically; a claim needs a second confirmation and
 *     the default confirmation choice is cancel;
 *   - the desktop keeps working (no exclusivity): the UI says the first explicit
 *     human answer wins, and it never claims old desktop-pending requests;
 *   - only allowed-once / rejected can be submitted, each from a confirmation
 *     page whose default is cancel, with a single in-flight submit;
 *   - a vanished request (desktop answered, signal cancelled, lease lost) is
 *     never answered from a stale page, and a disconnected submit is not retried;
 *   - release / Session switch / quit drop the terminal claim;
 *   - an old Host without the adapter methods degrades explicitly.
 *
 * Nothing here touches a real Host, a real approval, a real permission or the
 * desktop profile.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTui } from '../dsh-tui.mjs'

const BASE_CWD = '/tmp/dsh-approval-tui-test-workspace'
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

function awaitingPayload({ running = false, pendingInput = [], active = [], approvals = false } = {}) {
  return {
    ok: true,
    running,
    pendingInput,
    questions: { active, settledCount: 0 },
    approvals: {
      supported: false,
      present: approvals,
      reason: approvals ? 'no host read/answer API; confirm in the desktop app' : '',
    },
    answerable: active.some((batch) => batch.state === 'continued'),
  }
}

function continuedBatch({ callId = 'call-cont', id = 'q1', question = 'Pick one' } = {}) {
  return {
    callId,
    state: 'continued',
    questions: [{ id, question, options: [{ label: 'A' }, { label: 'B' }] }],
  }
}

function approvalRequest({
  requestId = 'req-1',
  toolName = 'bash',
  callId = 'call-1',
  reason = '命令可能修改工作区',
  displayReason = null,
  requestedAt = 1_700_000_000_000,
} = {}) {
  return { requestId, sessionId: 'sess-a', toolName, callId, reason, displayReason, requestedAt }
}

function makeAdapter(overrides = {}) {
  const requests = {
    listSessions: [],
    fetchTranscript: [],
    fetchStatus: [],
    fetchAwaiting: [],
    fetchApprovalChannel: [],
    submitAnswer: [],
    claimApprovalChannel: [],
    heartbeatApprovalChannel: [],
    releaseApprovalChannel: [],
    submitApprovalDecision: [],
    ask: [],
    loadClipboard: [],
    validateBatch: [],
    listWorkspaces: 0,
  }
  const rows = overrides.rows ?? [
    sessionRow('sess-a', 'Conversation A', '/work/a'),
    sessionRow('sess-b', 'Conversation B', '/work/b'),
  ]
  const channel = {
    claim: null,
    connected: true,
    pending: [],
    leaseMs: 60_000,
    ...(overrides.initialChannel ?? {}),
  }
  const awaitingFor = overrides.awaiting ?? (() => awaitingPayload())
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
      if (typeof overrides.fetchTranscript === 'function') return overrides.fetchTranscript(sessionId, limit)
      return { ok: true, sessionId, running: false, more: false, items: [] }
    },
    async fetchStatus(sessionId) {
      requests.fetchStatus.push(sessionId)
      if (typeof overrides.fetchStatus === 'function') return overrides.fetchStatus(sessionId)
      return { ok: true, sessionId, status: { pendingInput: [], running: false } }
    },
    async fetchAwaiting(sessionId) {
      requests.fetchAwaiting.push(sessionId)
      if (typeof overrides.fetchAwaiting === 'function') return overrides.fetchAwaiting(sessionId)
      return { ...awaitingFor(sessionId), sessionId }
    },
    async fetchApprovalChannel(claimId) {
      requests.fetchApprovalChannel.push(claimId)
      if (typeof overrides.fetchApprovalChannel === 'function') return overrides.fetchApprovalChannel(claimId)
      if (channel.claim === null) {
        return { ok: true, claim: null, connected: false, pendingCount: 0, maxPending: 8, pending: [] }
      }
      return {
        ok: true,
        claim: { ...channel.claim },
        connected: channel.connected,
        pendingCount: channel.pending.length,
        maxPending: 8,
        pending: channel.pending.map((request) => ({ ...request })),
      }
    },
    async claimApprovalChannel(request) {
      requests.claimApprovalChannel.push(request)
      if (typeof overrides.claimApprovalChannel === 'function') return overrides.claimApprovalChannel(request)
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
    async heartbeatApprovalChannel(request) {
      requests.heartbeatApprovalChannel.push(request)
      return { ok: true, claimId: request.claimId, expiresAt: Date.now() + 60_000, leaseMs: 60_000 }
    },
    async releaseApprovalChannel(request) {
      requests.releaseApprovalChannel.push(request)
      if (typeof overrides.releaseApprovalChannel === 'function') return overrides.releaseApprovalChannel(request)
      const delegated = channel.pending.length
      channel.claim = null
      channel.pending = []
      return { ok: true, released: true, delegated }
    },
    async submitApprovalDecision(request) {
      requests.submitApprovalDecision.push(request)
      if (typeof overrides.submitApprovalDecision === 'function') return overrides.submitApprovalDecision(request)
      channel.pending = channel.pending.filter((entry) => entry.requestId !== request.requestId)
      return {
        ok: true,
        claimId: request.claimId,
        requestId: request.requestId,
        outcome: request.outcome,
        submittedAt: Date.now(),
        final: false,
        note: 'submitted to the local channel; the Host result is not observed here',
      }
    },
    async newConversationForDirectory() {
      return { sessionId: 'sess-new' }
    },
    async newConversationWithOptions() {
      return { sessionId: 'sess-new-options' }
    },
    async ask(body) {
      requests.ask.push({ body })
      return { ok: true, sessionId: body.sessionId, text: 'ok', elapsedMs: 1, tools: 0 }
    },
    async submitAnswer(request) {
      requests.submitAnswer.push(request)
      return {
        ok: true,
        sessionId: request.sessionId,
        callId: request.callId,
        accepted: true,
        source: 'userQuestions/answer',
      }
    },
    async fetchQueue(sessionId) {
      return { ok: true, sessionId, running: false, items: [] }
    },
    async mutateQueue(sessionId) {
      return { ok: true, sessionId, running: false, items: [] }
    },
    async listWorkspaces() {
      requests.listWorkspaces += 1
      return []
    },
    async loadPaths() {
      return []
    },
    async loadClipboard() {
      return { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'clip.png' }
    },
    validateBatch(images) {
      requests.validateBatch.push(images)
      return images.slice()
    },
  }
  if (typeof overrides.ask === 'function') adapter.ask = overrides.ask
  if (overrides.withoutApprovalChannel === true) {
    delete adapter.fetchApprovalChannel
    delete adapter.claimApprovalChannel
    delete adapter.heartbeatApprovalChannel
    delete adapter.releaseApprovalChannel
    delete adapter.submitApprovalDecision
  }
  return { adapter, requests, channel }
}

function boot(adapter, options = {}) {
  const { columns = 100, initialSession = 'sess-a', ...rest } = options
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
  return { views, last, press, untilView, running, output }
}

const type = (tui, text) => tui.press(text, 'text')

async function openApprovals(tui) {
  await tui.press('', 'f2')
  return tui.untilView((view) => view.modal !== null && view.modal.kind === 'approvals', 'approvals page')
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

const messagesText = (view) => view.messages.map((message) => message.text).join('\n')
const modalText = (view) =>
  view.modal === null ? '' : view.modal.items.map((item) => `${item.label} ${item.detail}`).join('\n')

// ---------------------------------------------------------------------------
// 1. No auto claim; explicit claim needs a second confirmation
// ---------------------------------------------------------------------------

test('opening /approvals never claims automatically and offers an explicit claim entry', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    const view = await openApprovals(tui)
    assert.equal(requests.claimApprovalChannel.length, 0, 'opening the page must not claim')
    assert.match(modalText(view), /终端审批通道：未接入/)
    assert.match(modalText(view), /不会自动接入/)
    assert.ok(view.modal.items.some((item) => item.label.includes('接入当前会话终端审批')))
    assert.ok(view.modal.items.every((item) => item.label.includes('允许一次') === false))
  } finally {
    await stopTui(tui)
  }
})

test('claim confirmation defaults to cancel and Esc/cancel writes nothing', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, 'keep draft')
    await openApprovals(tui)
    await selectItem(tui, '接入当前会话终端审批')
    const confirm = await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', 'claim confirm')
    assert.equal(
      confirm.modal.items[confirm.modal.selected].label.includes('取消'),
      true,
      'default choice is cancel',
    )
    assert.match(modalText(confirm), /桌面端仍可同时看到审批请求/)
    assert.match(modalText(confirm), /谁先显式答复谁生效/)
    await tui.press('', 'escape')
    const back = await tui.untilView((v) => v.modal?.kind === 'approvals', 'back to approvals')
    assert.equal(requests.claimApprovalChannel.length, 0, 'Esc must not claim')
    await tui.press('', 'escape')
    const chat = await tui.untilView((v) => v.modal === null, 'back to chat')
    assert.equal(chat.input, 'keep draft')
  } finally {
    await stopTui(tui)
  }
})

test('explicit claim sends one claim and shows the terminal channel status', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openApprovals(tui)
    await selectItem(tui, '接入当前会话终端审批')
    await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', 'claim confirm')
    await selectItem(tui, '确认接入终端审批')
    await tui.untilView((v) => v.modal === null, 'claim settles')
    assert.equal(requests.claimApprovalChannel.length, 1)
    assert.deepEqual(requests.claimApprovalChannel[0], { sessionId: 'sess-a', leaseMs: 60_000 })
    assert.equal(requests.heartbeatApprovalChannel.length, 0, 'the adapter owns heartbeat, not the TUI')

    const view = await openApprovals(tui)
    assert.match(modalText(view), /终端审批通道：已接入/)
    assert.match(modalText(view), /桌面端仍可同时答复/)
    assert.match(modalText(view), /含接入前已挂起/)
    assert.ok(view.modal.items.some((item) => item.label.includes('释放回桌面')))
    assert.ok(view.modal.items.every((item) => item.label.includes('允许一次') === false))
    assert.equal(channel.claim.claimId, 'claim-1')
  } finally {
    await stopTui(tui)
  }
})

test('claim conflict is reported without stealing or retrying', async () => {
  const { adapter, requests } = makeAdapter({
    claimApprovalChannel: () => {
      throw Object.assign(new Error('another claim is already active'), { code: 'claim-conflict' })
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openApprovals(tui)
    await selectItem(tui, '接入当前会话终端审批')
    await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', 'claim confirm')
    await selectItem(tui, '确认接入终端审批')
    await tui.untilView((v) => v.modal === null, 'claim failure settles')
    assert.equal(requests.claimApprovalChannel.length, 1, 'claim is never retried')
    assert.match(messagesText(tui.last()), /已有活动的终端审批接入/)
    const view = await openApprovals(tui)
    assert.match(modalText(view), /终端审批通道：未接入/)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 2. Real pending detail and allow-once / reject confirmation
// ---------------------------------------------------------------------------

async function claimedWithPending(tui, requests, channel, request = approvalRequest()) {
  channel.pending = [request]
  await openApprovals(tui)
  await selectItem(tui, '接入当前会话终端审批')
  await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', 'claim confirm')
  await selectItem(tui, '确认接入终端审批')
  await tui.untilView((v) => v.modal === null, 'claim settles')
  assert.equal(requests.claimApprovalChannel.length, 1)
  const view = await openApprovals(tui)
  return view
}

test('/approvals shows real pending details and a safe default close action', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    let view = await claimedWithPending(tui, requests, channel, approvalRequest({
      displayReason: '需要写入 /work/a',
    }))
    assert.match(modalText(view), /审批 · bash/)
    await selectItem(tui, '审批 · bash')
    view = await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'request detail')
    const text = modalText(view)
    for (const needle of ['req-1', 'bash', 'call-1', '命令可能修改工作区', '需要写入 /work/a']) {
      assert.match(text, new RegExp(needle))
    }
    assert.match(text, /不提供参数、路径或命令正文/)
    assert.match(text, /允许一次=allowed-once/)
    assert.equal(view.modal.items[view.modal.selected].label.includes('关闭'), true, 'default = close, no submit')
    assert.equal(requests.submitApprovalDecision.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('allow-once needs a second confirmation, defaults to cancel and submits exactly once', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '允许一次…')
    let view = await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'allow confirm')
    assert.equal(view.modal.items[view.modal.selected].label.includes('取消'), true, 'default = cancel')
    assert.match(modalText(view), /只对本次请求/)
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'back to detail')
    assert.equal(requests.submitApprovalDecision.length, 0)

    await selectItem(tui, '允许一次…')
    view = await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'allow confirm again')
    await selectItem(tui, '确认提交允许一次')
    const settled = await tui.untilView((v) => v.modal === null, 'submit settles')
    assert.equal(requests.submitApprovalDecision.length, 1)
    assert.deepEqual(requests.submitApprovalDecision[0], {
      claimId: 'claim-1',
      requestId: 'req-1',
      outcome: 'allowed-once',
    })
    assert.match(messagesText(settled), /已提交审批决定：允许一次/)
    assert.match(messagesText(settled), /等待 Host 确认/)
    assert.equal(messagesText(settled).includes('已允许'), false, 'never claims the Host allowed it')
  } finally {
    await stopTui(tui)
  }
})

test('reject uses the rejected outcome and the same default-cancel confirmation', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '拒绝…')
    const view = await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'reject confirm')
    assert.equal(view.modal.items[view.modal.selected].label.includes('取消'), true)
    await selectItem(tui, '确认提交拒绝')
    await tui.untilView((v) => v.modal === null, 'reject settles')
    assert.deepEqual(requests.submitApprovalDecision[0], {
      claimId: 'claim-1',
      requestId: 'req-1',
      outcome: 'rejected',
    })
  } finally {
    await stopTui(tui)
  }
})

test('a request handled on the desktop is not answered from the stale page', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '允许一次…')
    await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'confirm')
    // The desktop (or another terminal) answered meanwhile.
    channel.pending = []
    await selectItem(tui, '确认提交允许一次')
    const settled = await tui.untilView((v) => v.modal === null, 'stale page closes')
    assert.equal(requests.submitApprovalDecision.length, 0, 'no stale answer is sent')
    assert.match(messagesText(settled), /已被桌面\/其他终端处理、取消或过期/)
  } finally {
    await stopTui(tui)
  }
})

test('a request that disappears while the page is open closes the stale page via polling', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    channel.pending = []
    await tui.untilView(
      (v) => v.modal === null || v.modal.kind !== 'approval-request-detail',
      'poll closes the stale detail',
      3000,
    )
    assert.equal(requests.submitApprovalDecision.length, 0)
    assert.match(messagesText(tui.last()), /已被桌面\/其他终端处理、取消或过期/)
  } finally {
    await stopTui(tui)
  }
})

test('a second Enter during submit is ignored: one decision, no duplicate', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { adapter, requests, channel } = makeAdapter({
    submitApprovalDecision: async (request) => {
      await gate
      channel.pending = channel.pending.filter((entry) => entry.requestId !== request.requestId)
      return {
        ok: true,
        claimId: request.claimId,
        requestId: request.requestId,
        outcome: request.outcome,
        submittedAt: Date.now(),
        final: false,
        note: 'submitted',
      }
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '允许一次…')
    await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'confirm')
    await selectItem(tui, '确认提交允许一次')
    await tui.press('', 'enter')
    await tui.press('', 'enter')
    assert.equal(requests.submitApprovalDecision.length, 1, 'only one decision may be in flight')
    release()
    await tui.untilView((v) => v.modal === null, 'submit settles')
    assert.equal(requests.submitApprovalDecision.length, 1)
  } finally {
    release()
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 3. Stale / expired / disconnected / release / switch / quit
// ---------------------------------------------------------------------------

test('request-not-pending from the Host is reported once and never retried', async () => {
  const { adapter, requests, channel } = makeAdapter({
    submitApprovalDecision: () => {
      throw Object.assign(new Error('the request is not pending'), { code: 'request-not-pending' })
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '拒绝…')
    await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'confirm')
    // Keep it locally pending so the local freshness check passes.
    await selectItem(tui, '确认提交拒绝')
    await tui.untilView((v) => v.modal === null, 'failure settles')
    assert.equal(requests.submitApprovalDecision.length, 1)
    assert.match(messagesText(tui.last()), /已被桌面\/其他终端处理、取消或过期/)
    await sleep(30)
    assert.equal(requests.submitApprovalDecision.length, 1)
  } finally {
    await stopTui(tui)
  }
})

test('claim-expired on submit drops the claim and asks for a fresh explicit claim', async () => {
  const { adapter, requests, channel } = makeAdapter({
    submitApprovalDecision: () => {
      throw Object.assign(new Error('claim expired'), { code: 'claim-expired' })
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '审批 · bash')
    await tui.untilView((v) => v.modal?.kind === 'approval-request-detail', 'detail')
    await selectItem(tui, '允许一次…')
    await tui.untilView((v) => v.modal?.kind === 'approval-confirm', 'confirm')
    await selectItem(tui, '确认提交允许一次')
    await tui.untilView((v) => v.modal === null, 'expiry settles')
    assert.match(messagesText(tui.last()), /终端审批接入已失效/)
    const view = await openApprovals(tui)
    assert.match(modalText(view), /终端审批通道：未接入/)
  } finally {
    await stopTui(tui)
  }
})

test('a disconnected channel read keeps the claim but never auto-answers; recovery shows pending', async () => {
  let offline = false
  const { adapter, requests, channel } = makeAdapter({
    fetchApprovalChannel: (claimId) => {
      if (offline) throw Object.assign(new Error('cannot reach Host'), { code: 'network-error' })
      return {
        ok: true,
        claim: { ...channel.claim },
        connected: true,
        pendingCount: channel.pending.length,
        maxPending: 8,
        pending: channel.pending.map((request) => ({ ...request })),
      }
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    offline = true
    await openApprovals(tui)
    await selectItem(tui, '刷新终端审批通道')
    const broken = await tui.untilView((v) => modalText(v).includes('通道错误'), 'channel error shown')
    assert.match(modalText(broken), /通道错误/)
    assert.equal(requests.submitApprovalDecision.length, 0, 'a read failure never answers')
    offline = false
    await selectItem(tui, '刷新终端审批通道')
    const recovered = await tui.untilView((v) => modalText(v).includes('审批 · bash'), 'channel recovers')
    assert.match(modalText(recovered), /审批 · bash/)
  } finally {
    await stopTui(tui)
  }
})

test('release needs confirmation, defaults to cancel and returns pending requests to the desktop', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '释放回桌面…')
    let view = await tui.untilView((v) => v.modal?.kind === 'approval-release-confirm', 'release confirm')
    assert.equal(view.modal.items[view.modal.selected].label.includes('取消'), true)
    assert.match(modalText(view), /不会被自动允许/)
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'approvals', 'release cancelled')
    assert.equal(requests.releaseApprovalChannel.length, 0)
    assert.equal(requests.submitApprovalDecision.length, 0)

    await selectItem(tui, '释放回桌面…')
    await tui.untilView((v) => v.modal?.kind === 'approval-release-confirm', 'release confirm again')
    await selectItem(tui, '确认释放回桌面')
    await tui.untilView((v) => v.modal === null, 'release settles')
    assert.equal(requests.releaseApprovalChannel.length, 1)
    assert.deepEqual(requests.releaseApprovalChannel[0], { claimId: 'claim-1', reason: 'user' })
    assert.equal(requests.submitApprovalDecision.length, 0, 'release never answers')
    const view2 = await openApprovals(tui)
    assert.match(modalText(view2), /终端审批通道：未接入/)
  } finally {
    await stopTui(tui)
  }
})

test('switching Session releases the terminal claim and never answers the old one', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await tui.press('', 'ctrl-p')
    await tui.untilView((v) => v.modal?.kind === 'sessions' && v.modal.items.length >= 2, 'picker')
    const index = tui.last().modal.items.findIndex((item) => item.detail.startsWith('sess-b'))
    for (let guard = 0; guard < 20 && tui.last().modal.selected !== index; guard += 1) {
      await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
    }
    await tui.press('', 'enter')
    const view = await tui.untilView((v) => v.modal === null && v.sessionId === 'sess-b', 'switched to B')
    assert.equal(requests.releaseApprovalChannel.length, 1)
    assert.equal(requests.releaseApprovalChannel[0].reason, 'shutdown')
    assert.equal(requests.submitApprovalDecision.length, 0)
    assert.equal(view.sessionId, 'sess-b')
  } finally {
    await stopTui(tui)
  }
})

test('quitting releases the terminal claim (best effort) without answering', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    await tui.press('', 'ctrl-q')
    assert.equal(await tui.running, 0)
    await until(() => requests.releaseApprovalChannel.length === 1, { label: 'release on quit', timeoutMs: 1000 })
    assert.equal(requests.releaseApprovalChannel[0].reason, 'shutdown')
    assert.equal(requests.submitApprovalDecision.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('lease lost is reported as needing a fresh claim; old pending is not answered', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    channel.claim = null
    const settle = await tui.untilView(
      (v) => messagesText(v).includes('终端审批接入已结束') || messagesText(v).includes('租约'),
      'lease loss reported',
      3000,
    )
    assert.equal(requests.submitApprovalDecision.length, 0)
    const view = await openApprovals(tui)
    assert.match(modalText(view), /终端审批通道：未接入/)
    assert.ok(view.modal.items.some((item) => item.label.includes('接入当前会话终端审批')))
    void settle
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 4. Coexistence, busy turn, old Host
// ---------------------------------------------------------------------------

test('after the lease is lost the user can explicitly claim again (no auto-reclaim)', async () => {
  const { adapter, requests, channel } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await claimedWithPending(tui, requests, channel)
    channel.claim = null
    await tui.untilView(
      (v) => messagesText(v).includes('终端审批接入已结束'),
      'lease loss reported',
      3000,
    )
    assert.equal(requests.claimApprovalChannel.length, 1, 'lease loss must not auto-reclaim')
    const list = await openApprovals(tui)
    assert.match(modalText(list), /终端审批通道：未接入/)
    await selectItem(tui, '接入当前会话终端审批')
    await tui.untilView((v) => v.modal?.kind === 'approval-claim-confirm', 'claim confirm')
    await selectItem(tui, '确认接入终端审批')
    await tui.untilView((v) => v.modal === null, 'second claim settles')
    assert.equal(requests.claimApprovalChannel.length, 2, 'a second claim requires the explicit flow')
    const again = await openApprovals(tui)
    assert.match(modalText(again), /终端审批通道：已接入/)
  } finally {
    await stopTui(tui)
  }
})

test('the existing continued-question flow still works while the terminal claim is active', async () => {
  const batch = continuedBatch()
  const { adapter, requests, channel } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [batch] }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, 'keep draft')
    await claimedWithPending(tui, requests, channel)
    await openApprovals(tui)
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'question detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'question answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'answer confirm')
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'answer submitted')
    assert.equal(requests.submitAnswer.length, 1)
    assert.equal(requests.submitApprovalDecision.length, 0)
    assert.equal(tui.last().input, 'keep draft', 'the approval claim must not disturb the draft')
  } finally {
    await stopTui(tui)
  }
})

test('F2 opens /approvals during a waiting turn, keeps the draft and never auto-claims', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { adapter, requests } = makeAdapter({
    ask: async (body) => {
      requests.ask.push({ body })
      await gate
      return { ok: false, code: 'input-required', error: 'waiting for approval', accepted: true }
    },
    awaiting: () => awaitingPayload({ pendingInput: ['approval'], approvals: true }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, 'run something')
    await tui.press('', 'enter')
    await tui.untilView((view) => view.status === 'waiting', 'turn waiting')
    await type(tui, 'next draft')
    const view = await openApprovals(tui)
    assert.match(modalText(view), /未接入/)
    assert.equal(requests.claimApprovalChannel.length, 0, 'busy F2 must not auto-claim')
    await tui.press('', 'escape')
    const back = await tui.untilView((v) => v.modal === null, 'back to the waiting turn')
    assert.equal(back.input, 'next draft')
  } finally {
    release()
    await stopTui(tui)
  }
})

test('an old Host without approval-channel methods degrades explicitly and never claims', async () => {
  const { adapter, requests } = makeAdapter({
    withoutApprovalChannel: true,
    awaiting: () => awaitingPayload({ pendingInput: ['approval'], approvals: true }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    const view = await openApprovals(tui)
    assert.match(modalText(view), /不支持终端审批通道|没有 CLI 读取\/答复审批的 API/)
    assert.ok(view.modal.items.every((item) => item.label.includes('接入当前会话终端审批') === false))
    assert.equal(typeof adapter.claimApprovalChannel, 'undefined')
  } finally {
    await stopTui(tui)
  }
})
