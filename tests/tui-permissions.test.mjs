/**
 * Permission-preset and pending-answer tests for the full-screen TUI.
 *
 * These tests drive `dsh-tui.mjs` with a plain mock adapter: no Host, no
 * terminal, no real approval/question and no real permission write. They pin the
 * safety contract:
 *
 *   - a permission switch needs a second explicit confirmation and sends the
 *     exact `{sessionId,preset,confirmed}` body once;
 *   - approvals and `open` questions are desktop-only: the TUI prints guidance
 *     and never calls an answer/submit adapter for them;
 *   - only `continued` questions can be answered, with the exact labels the Host
 *     offered, and every batch is confirmed before `submitAnswer`;
 *   - Esc cancels without submitting and preserves composer draft/attachments;
 *   - duplicate Enter, stale requests and a switched Session never double-submit;
 *   - after an accepted answer the TUI watches the real remote (fetchStatus +
 *     fetchTranscript) instead of re-sending the original prompt;
 *   - long details are wrapped into scrollable page rows instead of being lost.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTui } from '../dsh-tui.mjs'

const BASE_CWD = '/tmp/dsh-permissions-test-workspace'
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

const PERMISSIONS = {
  ok: true,
  sessionId: 'sess-a',
  permission: {
    currentValue: 'workspace-write',
    label: '工作区写入',
    options: [
      { value: 'read-only', name: '只读', description: '只读文件系统' },
      { value: 'workspace-write', name: '工作区写入', description: '可写当前工作区' },
      { value: 'danger-full-access', name: '完全访问', description: '完整文件系统与网络访问' },
      { value: 'auto', name: '自动' },
      { value: 'custom', name: '自定义（派生）' },
    ],
    defaultPreset: 'workspace-write',
  },
  canSet: true,
  source: 'projections+permissionPresets.catalog',
}

function continuedBatch({
  callId = 'call-cont',
  id = 'q1',
  question = 'Pick one',
  detail = undefined,
  header = undefined,
  options = [{ label: 'A', description: '选 A' }, { label: 'B' }],
  multiSelect = false,
} = {}) {
  return {
    callId,
    state: 'continued',
    questions: [
      {
        id,
        question,
        ...(detail === undefined ? {} : { detail }),
        ...(header === undefined ? {} : { header }),
        options,
        ...(multiSelect === true ? { multiSelect: true } : {}),
      },
    ],
  }
}

function openBatch({ callId = 'call-open', id = 'qo', question = 'Choose plan' } = {}) {
  return {
    callId,
    state: 'open',
    questions: [{ id, question, options: [{ label: 'Approve' }, { label: 'Reject' }] }],
  }
}

function awaitingPayload({ active = [], pendingInput = [], approvals = false, running = false } = {}) {
  return {
    ok: true,
    sessionId: 'sess-a',
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

function makeAdapter(overrides = {}) {
  const requests = {
    listSessions: [],
    fetchTranscript: [],
    fetchStatus: [],
    fetchPermissions: [],
    submitPermission: [],
    fetchAwaiting: [],
    submitAnswer: [],
    ask: [],
    loadClipboard: [],
    validateBatch: [],
    listWorkspaces: 0,
  }
  const rows = overrides.rows ?? [
    sessionRow('sess-a', 'Conversation A', '/work/a'),
    sessionRow('sess-b', 'Conversation B', '/work/b'),
  ]
  const permissionPayload = overrides.permissions ?? PERMISSIONS
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
      return {
        ok: true,
        sessionId,
        running: false,
        more: false,
        items: [{ kind: 'user', text: `hello ${sessionId}` }],
      }
    },
    async fetchStatus(sessionId) {
      requests.fetchStatus.push(sessionId)
      if (typeof overrides.fetchStatus === 'function') return overrides.fetchStatus(sessionId)
      return { ok: true, sessionId, status: { pendingInput: [], running: false } }
    },
    async fetchPermissions(sessionId) {
      requests.fetchPermissions.push(sessionId)
      if (typeof overrides.fetchPermissions === 'function') return overrides.fetchPermissions(sessionId)
      return { ...permissionPayload, sessionId }
    },
    async submitPermission(body) {
      requests.submitPermission.push(body)
      if (typeof overrides.submitPermission === 'function') return overrides.submitPermission(body)
      return { ok: true, sessionId: body.sessionId, preset: body.preset, matched: true, text: `preset ${body.preset}` }
    },
    async fetchAwaiting(sessionId) {
      requests.fetchAwaiting.push(sessionId)
      if (typeof overrides.fetchAwaiting === 'function') return overrides.fetchAwaiting(sessionId)
      const payload = awaitingFor(sessionId)
      return { ...payload, sessionId }
    },
    async submitAnswer(body) {
      requests.submitAnswer.push(body)
      if (typeof overrides.submitAnswer === 'function') return overrides.submitAnswer(body)
      return { ok: true, sessionId: body.sessionId, callId: body.callId, accepted: true, source: 'userQuestions/answer' }
    },
    async newConversationForDirectory() {
      return { sessionId: 'sess-new' }
    },
    async newConversationWithOptions() {
      return { sessionId: 'sess-new-options' }
    },
    async ask(body, extra) {
      requests.ask.push({ body, signal: extra?.signal })
      return { ok: true, sessionId: body.sessionId, text: 'asked', elapsedMs: 1, tools: 0 }
    },
    async askBlocking(body) {
      requests.ask.push({ body })
      return { ok: true, sessionId: body.sessionId, text: 'asked', elapsedMs: 1, tools: 0 }
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
      requests.loadClipboard += 1
      return { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'clip.png' }
    },
    validateBatch(images) {
      requests.validateBatch.push(images)
      return images.slice()
    },
  }
  if (typeof overrides.ask === 'function') adapter.ask = overrides.ask
  if (typeof overrides.askBlocking === 'function') adapter.askBlocking = overrides.askBlocking
  if (overrides.withoutPermissions === true) delete adapter.fetchPermissions
  if (overrides.withoutAwaiting === true) delete adapter.fetchAwaiting
  return { adapter, requests }
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
      watchIntervalMs: 10,
      watchTimeoutMs: 800,
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

async function openCommand(tui, command, kind) {
  await type(tui, command)
  await tui.press('', 'enter')
  return tui.untilView((view) => view.modal !== null && view.modal.kind === kind, `${command} ${kind}`)
}

/** Open a page through its dedicated key (works while a draft is present). */
async function openKey(tui, key, kind) {
  await tui.press('', key)
  return tui.untilView((view) => view.modal !== null && view.modal.kind === kind, `${key} ${kind}`)
}

/** Move the modal selection to the first item whose label contains `needle`. */
async function selectItem(tui, needle) {
  const modal = tui.last().modal
  assert.ok(modal !== null, `no modal when selecting ${JSON.stringify(needle)}`)
  const index = modal.items.findIndex((item) => item.label.includes(needle))
  assert.notEqual(index, -1, `no item ${JSON.stringify(needle)} in ${JSON.stringify(modal.items.map((item) => item.label))}`)
  for (let guard = 0; guard < modal.items.length * 3; guard += 1) {
    const selected = tui.last().modal.selected
    if (selected === index) break
    await tui.press('', selected < index ? 'down' : 'up')
  }
  assert.equal(tui.last().modal.selected, index, `selection must reach ${JSON.stringify(needle)}`)
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

function messagesText(view) {
  return view.messages.map((message) => message.text).join('\n')
}

function modalText(view) {
  if (view.modal === null) return ''
  return view.modal.items.map((item) => `${item.label} ${item.detail}`).join('\n')
}

// ---------------------------------------------------------------------------
// 1. /permissions: show the real preset, require explicit confirmation
// ---------------------------------------------------------------------------

test('/permissions shows the current preset and only submits after an explicit confirmation', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.sessionId === 'sess-a' && view.status === 'ready', 'session loaded')
    await type(tui, 'keep this draft')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'attachment')

    let view = await openKey(tui, 'f3', 'permissions')
    assert.match(modalText(view), /当前预设：workspace-write/)
    assert.match(modalText(view), /只读/)
    assert.match(modalText(view), /workspace-write/)
    const presetRows = view.modal.items.filter((item) => /^[●○] /.test(item.label))
    assert.ok(presetRows.length >= 3, 'the real catalog presets are listed')
    assert.equal(
      presetRows.some((item) => item.label.includes('custom')),
      false,
      'custom is a derived state, never a selectable preset',
    )
    assert.equal(requests.submitPermission.length, 0, 'opening the list must not change anything')

    // Esc cancels: no write, and the composer draft/attachment stay untouched.
    await tui.press('', 'escape')
    view = await tui.untilView((view) => view.modal === null, 'permissions closed')
    assert.equal(view.input, 'keep this draft')
    assert.deepEqual(view.attachments.map((entry) => entry.name), ['clip.png'])
    assert.equal(requests.submitPermission.length, 0)

    // Select a target, then cancel at the confirmation page: still no write.
    await openKey(tui, 'f3', 'permissions')
    await selectItem(tui, '[read-only]')
    view = await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'permission confirm')
    assert.match(modalText(view), /取消（不切换）/)
    assert.match(modalText(view), /确认切换/)
    assert.equal(requests.submitPermission.length, 0, 'selection alone must not submit')
    const confirmSelected = view.modal.items[view.modal.selected].label
    assert.match(confirmSelected, /取消/, 'the safe default is cancel, never allow/confirm')
    await tui.press('', 'enter') // default = cancel
    await tui.untilView((v) => v.modal?.kind === 'permissions', 'back to permissions list')
    assert.equal(requests.submitPermission.length, 0)

    // Now really switch: list -> confirm -> exact body.
    await selectItem(tui, '[read-only]')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'permission confirm again')
    await selectItem(tui, '确认切换')
    await tui.untilView((v) => v.modal === null, 'permission switch settles')
    assert.equal(requests.submitPermission.length, 1)
    assert.deepEqual(requests.submitPermission[0], { sessionId: 'sess-a', preset: 'read-only', confirmed: false })
    const settled = tui.last()
    assert.match(messagesText(settled), /权限预设已切换：workspace-write → read-only/)
    assert.equal(settled.input, 'keep this draft', 'switching a preset must not clear the draft')
    assert.equal(settled.attachments.length, 1, 'switching a preset must not clear attachments')
    assert.match(settled.statusLines[0], /read-only/)
    // Never re-sends anything through ask.
    assert.equal(requests.ask.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('/permissions needs a second high-risk confirmation for danger-full-access and sends confirmed:true', async () => {
  const { adapter, requests } = makeAdapter()
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/permissions', 'permissions')
    await selectItem(tui, '[danger-full-access]')
    let view = await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'danger confirm')
    assert.match(modalText(view), /高危/)
    assert.match(modalText(view), /二次确认/)
    assert.equal(requests.submitPermission.length, 0)

    // Cancel the second confirmation: nothing is written.
    await selectItem(tui, '继续高危二次确认')
    view = await tui.untilView((v) => v.modal?.kind === 'permission-confirm-2', 'danger second confirm')
    assert.match(modalText(view), /第二次确认/)
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'back to first confirm')
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'permissions', 'back to list')
    assert.equal(requests.submitPermission.length, 0)

    // Confirm both steps: confirmed:true only after the second explicit Enter.
    await selectItem(tui, '[danger-full-access]')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'danger confirm again')
    await selectItem(tui, '继续高危二次确认')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm-2', 'danger second confirm again')
    await selectItem(tui, '确认切换为 danger-full-access')
    await tui.untilView((v) => v.modal === null, 'danger switch settles')
    assert.equal(requests.submitPermission.length, 1)
    assert.deepEqual(requests.submitPermission[0], {
      sessionId: 'sess-a',
      preset: 'danger-full-access',
      confirmed: true,
    })
  } finally {
    await stopTui(tui)
  }
})

test('permission failures are reported once and never retried automatically', async () => {
  let permissionReads = 0
  const { adapter, requests } = makeAdapter({
    fetchPermissions: () => {
      permissionReads += 1
      return { ...PERMISSIONS, sessionId: 'sess-a' }
    },
    submitPermission: (body) => {
      const error = new Error(`no live agent for ${body.sessionId}`)
      error.code = 'session-not-live'
      throw error
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/permissions', 'permissions')
    await selectItem(tui, '[read-only]')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'confirm')
    await selectItem(tui, '确认切换')
    await tui.untilView((v) => v.modal === null, 'failure settles')
    assert.equal(requests.submitPermission.length, 1, 'a failed switch is not retried')
    assert.match(messagesText(tui.last()), /live Agent/)
    const readsAfterFailure = permissionReads
    await sleep(20)
    assert.equal(permissionReads, readsAfterFailure, 'no retry loop after a failed switch')
  } finally {
    await stopTui(tui)
  }
})

test('a second Enter during a permission switch is ignored: one write', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { adapter, requests } = makeAdapter({
    submitPermission: async (body) => {
      await gate
      return { ok: true, sessionId: body.sessionId, preset: body.preset, matched: true, text: 'ok' }
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/permissions', 'permissions')
    await selectItem(tui, '[read-only]')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'confirm')
    await selectItem(tui, '确认切换')
    await tui.press('', 'enter')
    await tui.press('', 'enter')
    assert.equal(requests.submitPermission.length, 1, 'only one permission write may be in flight')
    release()
    await tui.untilView((v) => v.modal === null, 'switch settles')
    assert.equal(requests.submitPermission.length, 1)
  } finally {
    release()
    await stopTui(tui)
  }
})

test('switching Session from the permission confirmation list never submits the old scope', async () => {
  const { adapter, requests } = makeAdapter({
    fetchPermissions: (sessionId) => ({ ...PERMISSIONS, sessionId }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/permissions', 'permissions')
    await selectItem(tui, '[read-only]')
    await tui.untilView((v) => v.modal?.kind === 'permission-confirm', 'confirm')
    // Ctrl+P replaces the confirmation with the Session picker; nothing is sent.
    await tui.press('', 'ctrl-p')
    await tui.untilView((v) => v.modal?.kind === 'sessions' && v.modal.items.length >= 2, 'picker')
    const index = tui.last().modal.items.findIndex((item) => item.detail.startsWith('sess-b'))
    for (let guard = 0; guard < 20 && tui.last().modal.selected !== index; guard += 1) {
      await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
    }
    await tui.press('', 'enter')
    const view = await tui.untilView((v) => v.modal === null && v.sessionId === 'sess-b', 'switched to B')
    assert.equal(requests.submitPermission.length, 0, 'a switched Session must not inherit the pending switch')
    assert.equal(view.sessionId, 'sess-b')
  } finally {
    await stopTui(tui)
  }
})

test('/permissions degrades clearly when the adapter has no permission API', async () => {
  const { adapter } = makeAdapter({ withoutPermissions: true })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, '/permissions')
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (v) => messagesText(v).includes('/local-cli/permissions'),
      'unsupported note',
    )
    assert.equal(view.modal, null)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 2. /approvals: desktop-only approvals/open questions, answerable continued
// ---------------------------------------------------------------------------

test('/approvals never offers an allow action for approvals or open questions', async () => {
  const { adapter, requests } = makeAdapter({
    awaiting: () =>
      awaitingPayload({
        pendingInput: ['approval', 'question'],
        approvals: true,
        active: [openBatch(), continuedBatch()],
      }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    let view = await openCommand(tui, '/approvals', 'approvals')
    const wrapped = view.modal.items.map((item) => item.label).join('')
    assert.match(wrapped, /审批/)
    assert.match(wrapped, /桌面应用/)
    assert.match(wrapped, /不会替你允许或拒绝/)
    assert.match(wrapped, /仅桌面可答/)
    // No approval/allow action is ever rendered anywhere.
    for (const item of view.modal.items) {
      assert.equal(/^(允许|拒绝|允许一次)/.test(item.label), false, `no approval action: ${item.label}`)
    }

    // Opening the approval card only explains; it never answers.
    await selectItem(tui, '仅桌面可答')
    view = await tui.untilView((v) => v.modal?.kind === 'question-detail', 'open question detail')
    assert.match(modalText(view), /只能在桌面端回答|不能回答 open 问题/)
    assert.equal(modalText(view).includes('开始回答'), false, 'open questions have no answer entry')
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'approvals', 'back to approvals')
    assert.equal(requests.submitAnswer.length, 0)
    assert.equal(requests.ask.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('/approvals answers one continued question, then watches the real remote instead of re-sending the prompt', async () => {
  let statusReads = 0
  const { adapter, requests } = makeAdapter({
    awaiting: () =>
      awaitingPayload({
        pendingInput: ['question'],
        active: [continuedBatch({ callId: 'call-cont', id: 'q1', question: 'Pick one' })],
      }),
    // First read (Session load) is idle; the watch then sees running=true twice
    // before the remote settles, so the transcript poll is exercised.
    fetchStatus: () => {
      statusReads += 1
      return { ok: true, sessionId: 'sess-a', status: { pendingInput: [], running: statusReads > 1 && statusReads <= 3 } }
    },
    fetchTranscript: (sessionId) => ({
      ok: true,
      sessionId,
      running: statusReads > 1 && statusReads <= 3,
      more: false,
      items: [
        { kind: 'user', text: 'hello sess-a' },
        { kind: 'assistant', text: 'remote final answer' },
      ],
    }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    let view = await tui.untilView((v) => v.modal?.kind === 'question-detail', 'question detail')
    assert.match(modalText(view), /开始回答/)
    await selectItem(tui, '开始回答')
    view = await tui.untilView((v) => v.modal?.kind === 'question-answer', 'question answer')
    assert.match(modalText(view), /Pick one/)
    assert.match(modalText(view), /A/)
    await selectItem(tui, 'A')
    view = await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'answer confirm')
    assert.match(modalText(view), /选项：A/)
    assert.equal(view.modal.items[view.modal.selected].label.includes('取消'), true, 'safe default = cancel')
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'answer submitted')
    assert.equal(requests.submitAnswer.length, 1)
    assert.deepEqual(requests.submitAnswer[0], {
      sessionId: 'sess-a',
      callId: 'call-cont',
      answers: [{ id: 'q1', selected: ['A'] }],
    })

    // The real remote is watched (status + transcript). The original prompt is
    // never re-sent, and the remote output appears.
    const settled = await tui.untilView(
      (v) => messagesText(v).includes('remote final answer') && messagesText(v).includes('没有重发原 prompt'),
      'remote transcript adopted',
    )
    assert.equal(requests.ask.length, 0, 'the original prompt must never be re-sent')
    assert.ok(requests.fetchStatus.length > 1, 'status is polled while watching')
    assert.ok(requests.fetchTranscript.length > 1, 'transcript is polled while watching')
    assert.equal(settled.input, '', 'no accidental prompt text was sent')
  } finally {
    await stopTui(tui)
  }
})

test('multi-select, custom text and skip build the exact Host answer batch', async () => {
  const batch = {
    callId: 'call-multi',
    state: 'continued',
    questions: [
      {
        id: 'q1',
        question: 'Pick many',
        multiSelect: true,
        options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
      },
      { id: 'q2', question: 'Pick one or write', options: [{ label: 'P' }, { label: 'Q' }] },
    ],
  }
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [batch] }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick many')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'q1')
    await selectItem(tui, 'X')
    await tui.untilView((v) => modalText(v).includes('[x] X'), 'X toggled')
    await selectItem(tui, 'Y')
    await tui.untilView((v) => modalText(v).includes('[x] Y'), 'Y toggled')
    await selectItem(tui, '完成本题')
    await tui.untilView((v) => v.modal?.kind === 'question-answer' && modalText(v).includes('Pick one or write'), 'q2')
    await selectItem(tui, '自定义文字回答')
    await tui.untilView((v) => v.modal?.kind === 'question-input', 'custom input')
    await type(tui, 'my own answer')
    await tui.press('', 'enter')
    const confirm = await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'answer confirm')
    assert.match(modalText(confirm), /自定义：my own answer/)
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'submitted')
    assert.equal(requests.submitAnswer.length, 1)
    assert.deepEqual(requests.submitAnswer[0].answers, [
      { id: 'q1', selected: ['X', 'Y'] },
      { id: 'q2', selected: [], custom: 'my own answer' },
    ])
  } finally {
    await stopTui(tui)
  }
})

test('skip sends an explicit empty selection and Esc never submits', async () => {
  const batch = {
    callId: 'call-skip',
    state: 'continued',
    questions: [{ id: 'q1', question: 'Answer me', options: [{ label: 'A' }, { label: 'B' }] }],
  }
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [batch] }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, 'preserved draft')
    await tui.press('', 'ctrl-v')
    await tui.untilView((view) => view.attachments.length === 1, 'attachment')

    await openKey(tui, 'f2', 'approvals')
    await selectItem(tui, '回答 · Answer me')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    // Esc out of the whole flow without answering: no submit, draft survives.
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'back to detail')
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal?.kind === 'approvals', 'back to list')
    await tui.press('', 'escape')
    const view = await tui.untilView((v) => v.modal === null, 'back to chat')
    assert.equal(requests.submitAnswer.length, 0, 'Esc must not submit')
    assert.equal(view.input, 'preserved draft')
    assert.deepEqual(view.attachments.map((entry) => entry.name), ['clip.png'])

    // Skip deliberately: the answer batch names the question with selected: [].
    await openKey(tui, 'f2', 'approvals')
    await selectItem(tui, '回答 · Answer me')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail again')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer again')
    await selectItem(tui, '跳过这题')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'skip confirm')
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'skip submitted')
    assert.deepEqual(requests.submitAnswer[0].answers, [{ id: 'q1', selected: [] }])
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 3. Duplicate, stale, switched Session
// ---------------------------------------------------------------------------

test('a second Enter while submitting is ignored: one answer, no duplicate write', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
    submitAnswer: async (body) => {
      await gate
      return { ok: true, sessionId: body.sessionId, callId: body.callId, accepted: true, source: 'userQuestions/answer' }
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')
    await selectItem(tui, '确认提交回答')
    // The first submit is in flight; a second Enter must not submit again.
    await tui.press('', 'enter')
    await tui.press('', 'enter')
    assert.equal(requests.submitAnswer.length, 1, 'only one submit may be in flight')
    release()
    await tui.untilView((v) => v.modal === null, 'submission settles')
    assert.equal(requests.submitAnswer.length, 1)
  } finally {
    release()
    await stopTui(tui)
  }
})

test('a stale request is reported once, closes the flow and never retries', async () => {
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
    submitAnswer: () => {
      const error = new Error('no active question has this callId')
      error.code = 'stale-request'
      throw error
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'flow closed')
    assert.equal(requests.submitAnswer.length, 1, 'a stale submit is never retried')
    assert.match(messagesText(tui.last()), /已过期|已在别处处理/)
    await sleep(20)
    assert.equal(requests.submitAnswer.length, 1)
  } finally {
    await stopTui(tui)
  }
})

test('a request that settled before submit is not answered at all (local freshness check)', async () => {
  let expire = false
  const batch = continuedBatch()
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: expire ? [] : [batch] }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')
    expire = true
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'flow closed')
    assert.equal(requests.submitAnswer.length, 0, 'the local re-read found the request gone')
    assert.match(messagesText(tui.last()), /已过期|已在别处处理/)
  } finally {
    await stopTui(tui)
  }
})

test('a response naming another Session is treated as unverified and does not double-submit', async () => {
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
    submitAnswer: (body) => ({
      ok: true,
      sessionId: 'sess-b',
      callId: body.callId,
      accepted: true,
      source: 'userQuestions/answer',
    }),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')
    await selectItem(tui, '确认提交回答')
    await tui.untilView((v) => v.modal === null, 'flow closed')
    assert.equal(requests.submitAnswer.length, 1)
    assert.match(messagesText(tui.last()), /已过期|已在别处处理|没有提交/)
  } finally {
    await stopTui(tui)
  }
})

test('switching Session abandons the answer flow and never answers the old one', async () => {
  const { adapter, requests } = makeAdapter({
    awaiting: (sessionId) =>
      sessionId === 'sess-a'
        ? awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] })
        : awaitingPayload(),
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'A')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')

    // Global Ctrl+P switches Session above every modal; the flow must be gone.
    await tui.press('', 'ctrl-p')
    await tui.untilView((v) => v.modal?.kind === 'sessions' && v.modal.items.length >= 2, 'picker')
    const index = tui.last().modal.items.findIndex((item) => item.detail.startsWith('sess-b'))
    for (let guard = 0; guard < 20 && tui.last().modal.selected !== index; guard += 1) {
      await tui.press('', tui.last().modal.selected < index ? 'down' : 'up')
    }
    await tui.press('', 'enter')
    const view = await tui.untilView((v) => v.modal === null && v.sessionId === 'sess-b', 'switched to B')
    assert.equal(view.input, '')
    assert.equal(requests.submitAnswer.length, 0, 'switching must never answer the previous Session')
    await sleep(20)
    assert.equal(requests.submitAnswer.length, 0)
  } finally {
    await stopTui(tui)
  }
})

// ---------------------------------------------------------------------------
// 4. Pending-input detection, long detail, unsupported adapter
// ---------------------------------------------------------------------------

test('a disconnected pending read shows a retryable error page instead of guessing', async () => {
  let online = false
  const { adapter, requests } = makeAdapter({
    fetchAwaiting: () => {
      if (online !== true) {
        const error = new Error('cannot reach the Host (network-error)')
        error.code = 'network-error'
        throw error
      }
      return awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] })
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    const view = await openCommand(tui, '/approvals', 'approvals')
    assert.match(modalText(view), /读取失败/)
    assert.equal(requests.submitAnswer.length, 0)
    online = true
    await selectItem(tui, '重新读取待处理请求')
    const recovered = await tui.untilView((v) => modalText(v).includes('回答 · Pick one'), 'retry recovers')
    assert.match(modalText(recovered), /回答 · Pick one/)
    assert.equal(requests.submitAnswer.length, 0, 'a read failure never answers anything')
  } finally {
    await stopTui(tui)
  }
})

test('a disconnected answer submit is reported as unknown and never retried automatically', async () => {
  const { adapter, requests } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
    submitAnswer: () => {
      const error = new Error('cannot reach the Host (network-error)')
      error.code = 'network-error'
      throw error
    },
  })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await type(tui, 'keep draft')
    await openKey(tui, 'f2', 'approvals')
    await selectItem(tui, '回答 · Pick one')
    await tui.untilView((v) => v.modal?.kind === 'question-detail', 'detail')
    await selectItem(tui, '开始回答')
    await tui.untilView((v) => v.modal?.kind === 'question-answer', 'answer')
    await selectItem(tui, 'B')
    await tui.untilView((v) => v.modal?.kind === 'answer-confirm', 'confirm')
    await selectItem(tui, '确认提交回答')
    const view = await tui.untilView((v) => v.modal === null, 'unknown result settles')
    assert.match(messagesText(view), /结果未知/)
    assert.match(messagesText(view), /不要连续重试/)
    assert.equal(requests.submitAnswer.length, 1, 'a network failure is not retried')
    assert.equal(view.input, 'keep draft', 'the draft survives a failed answer')
    await sleep(20)
    assert.equal(requests.submitAnswer.length, 1)
  } finally {
    await stopTui(tui)
  }
})

test('a status-level pending-input becomes a visible /approvals entry and never auto-answers', async () => {
  const { adapter, requests } = makeAdapter({
    fetchStatus: () => ({
      ok: true,
      sessionId: 'sess-a',
      status: { pendingInput: ['question'], running: false },
    }),
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
  })
  const tui = boot(adapter, { pendingPollMs: 20 })
  try {
    const view = await tui.untilView(
      (v) => v.hint.includes('/approvals') && v.statusLines[0].includes('待处理'),
      'prominent pending entry',
    )
    assert.match(view.statusLines[0], /待处理/)
    assert.equal(view.modal, null, 'detection must not hijack the composer or auto-open')
    assert.equal(requests.submitAnswer.length, 0)
    assert.equal(requests.ask.length, 0)
  } finally {
    await stopTui(tui)
  }
})

test('a newly created Session also detects pending input (loaded flag on bare startup)', async () => {
  const { adapter } = makeAdapter({
    fetchStatus: () => ({
      ok: true,
      sessionId: 'sess-new',
      status: { pendingInput: ['question'], running: false },
    }),
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [continuedBatch()] }),
  })
  const tui = boot(adapter, { initialSession: '' })
  try {
    // Bare startup is a local draft now; the Session exists only after the
    // first send, and the loaded flag must still enable pending detection.
    await tui.untilView((v) => v.sessionId === '' && v.status === 'draft', 'lazy draft')
    await type(tui, 'create the Session')
    await tui.press('', 'enter')
    const view = await tui.untilView(
      (v) => v.sessionId === 'sess-new' && v.hint.includes('/approvals') && v.statusLines[0].includes('待处理'),
      'pending entry on a new Session',
    )
    assert.equal(view.modal, null)
  } finally {
    await stopTui(tui)
  }
})

test('F2 opens /approvals while a turn is waiting and keeps the next draft', async () => {
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
    await tui.press('', 'f2')
    const view = await tui.untilView((v) => v.modal?.kind === 'approvals', 'approvals while busy')
    assert.match(modalText(view), /审批/)
    await tui.press('', 'escape')
    const back = await tui.untilView((v) => v.modal === null, 'closed back to the waiting turn')
    assert.equal(back.input, 'next draft', 'opening the pending list must preserve the composer draft')
    assert.equal(requests.submitAnswer.length, 0, 'approvals are never answered by this CLI')
  } finally {
    release()
    await stopTui(tui)
  }
})

test('long question/detail/option text is wrapped into scrollable rows, not truncated', async () => {
  const longQuestion = `Q${'q'.repeat(360)}`
  const longDetail = `D${'d'.repeat(260)}`
  const longOption = `O${'o'.repeat(120)}`
  const batch = continuedBatch({
    question: longQuestion,
    detail: longDetail,
    options: [{ label: longOption, description: longDetail }],
  })
  const { adapter } = makeAdapter({
    awaiting: () => awaitingPayload({ pendingInput: ['question'], active: [batch] }),
  })
  const tui = boot(adapter, { columns: 50 })
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    await openCommand(tui, '/approvals', 'approvals')
    await selectItem(tui, '回答 · Qqq')
    const detailView = await tui.untilView((v) => v.modal?.kind === 'question-detail', 'long detail')
    const labels = detailView.modal.items.map((item) => item.label)
    const joined = labels.join('')
    assert.ok(joined.includes(longQuestion), 'the full question text survives wrapping')
    assert.ok(joined.includes(longDetail), 'the full detail survives wrapping')
    assert.ok(joined.includes(longOption), 'the full option label survives wrapping')
    assert.ok(labels.some((label) => label.length > 0 && label.length <= 46), 'rows fit the wrapped width')
    // Selection can scroll through the whole detail; End reaches the last row.
    await tui.press('', 'end')
    const endView = tui.last()
    assert.equal(endView.modal.selected, endView.modal.items.length - 1)
    await tui.press('', 'pageup')
    assert.ok(tui.last().modal.selected < endView.modal.items.length - 1, 'PageUp scrolls back')
  } finally {
    await stopTui(tui)
  }
})

test('/approvals degrades clearly when the adapter has no awaiting API', async () => {
  const { adapter } = makeAdapter({ withoutAwaiting: true })
  const tui = boot(adapter)
  try {
    await tui.untilView((view) => view.status === 'ready', 'session loaded')
    const view = await openCommand(tui, '/approvals', 'approvals')
    assert.match(modalText(view), /不支持读取待处理请求/)
    await tui.press('', 'escape')
    await tui.untilView((v) => v.modal === null, 'closed')
  } finally {
    await stopTui(tui)
  }
})
