/**
 * Tests for the pure full-screen view module and its terminal lifecycle.
 *
 * Everything here is in-process: no subprocess, no Host, no clipboard, no real
 * terminal. `renderFrame` is asserted from its returned text (stripping only
 * the frame's own CSI sequences), and `createScreen` is driven with
 * EventEmitter doubles so raw-mode, resize, key and paste handling are all
 * observable.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import {
  DEFAULT_HINT,
  MAX_INPUT_LINES,
  createScreen,
  displayWidth,
  renderFrame,
  sanitizeLine,
  sanitizeMultiline,
  splitGraphemes,
  stripTerminalSequences,
  wrapText,
} from '../dsh-tui-screen.mjs'

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const CURSOR_POSITION = /\x1b\[(\d+);(\d+)H$/

function plainFrame(frame) {
  return frame.output.replace(CSI, '').split('\r\n')
}

function plainText(frame) {
  return frame.output.replace(CSI, '')
}

function assertShape(lines, columns, rows) {
  assert.equal(lines.length, rows, `expected ${rows} rows, got ${lines.length}`)
  lines.forEach((line, index) => {
    assert.equal(displayWidth(line), columns, `row ${index + 1} is ${displayWidth(line)} cells, expected ${columns}`)
  })
}

function baseView(overrides = {}) {
  return {
    project: 'dsh-local-cli',
    cwd: '/Users/example/workspace/dsh-local-cli',
    sessionTitle: 'Refactor TUI screen',
    sessionId: 's-abc1234567890de',
    model: 'deepseek-v4-flash',
    status: 'ready',
    messages: [
      { role: 'user', text: '你好，帮我把会话列表做成全屏选择器' },
      { role: 'assistant', text: '好的。我先看现有交互，然后写一个纯视图层。\n\n第一步是把布局与终端生命周期拆开。' },
      { role: 'tool', text: 'read dsh-ask.mjs' },
      { role: 'error', text: '示例错误：连接失败' },
      { role: 'system', text: 'switched to session s-abc123' },
    ],
    input: '继续',
    inputCursor: 2,
    attachments: [{ name: 'screenshot.png' }],
    hint: 'Enter 发送 · F1 帮助',
    scrollOffset: 0,
    modal: null,
    ...overrides,
  }
}

class MockOutput extends EventEmitter {
  constructor({ columns = 80, rows = 24, isTTY = true } = {}) {
    super()
    this.isTTY = isTTY
    this.columns = columns
    this.rows = rows
    this.writes = []
  }

  write(chunk) {
    this.writes.push(String(chunk))
    return true
  }
}

class MockInput extends EventEmitter {
  constructor({ isTTY = true, isRaw = false, raw = true } = {}) {
    super()
    this.isTTY = isTTY
    this.isRaw = isRaw
    this.rawCalls = []
    if (raw) {
      this.setRawMode = (value) => {
        this.rawCalls.push(value)
        this.isRaw = value
        return this
      }
    }
  }
}

function harness({ input, output, onKey, onResize } = {}) {
  const mockInput = input || new MockInput()
  const mockOutput = output || new MockOutput()
  const keys = []
  const resizes = []
  const screen = createScreen({
    input: mockInput,
    output: mockOutput,
    onKey(str, key) {
      keys.push({ str, key })
      if (onKey) onKey(str, key)
    },
    onResize(size) {
      resizes.push(size)
      if (onResize) onResize(size)
    },
  })
  return { input: mockInput, output: mockOutput, keys, resizes, screen }
}

function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('display width and graphemes', () => {
  it('measures ASCII, CJK, fullwidth punctuation, combining marks and emoji', () => {
    assert.equal(displayWidth('abc'), 3)
    assert.equal(displayWidth('中文'), 4)
    assert.equal(displayWidth('，'), 2)
    assert.equal(displayWidth('e\u0301'), 1)
    assert.equal(displayWidth('👨‍👩‍👧‍👦'), 2)
    assert.equal(displayWidth('❤️'), 2)
    assert.equal(displayWidth('a中👨‍👩‍👧‍👦'), 5)
    assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3)
  })

  it('keeps grapheme clusters whole', () => {
    assert.equal(splitGraphemes('e\u0301').length, 1)
    assert.equal(splitGraphemes('👨‍👩‍👧‍👦').length, 1)
    assert.equal(splitGraphemes('中文').length, 2)
  })

  it('wraps by display width without splitting clusters', () => {
    assert.deepEqual(wrapText('中文测试', 4), ['中文', '测试'])
    assert.deepEqual(wrapText('abc def', 4), ['abc', 'def'])
    assert.deepEqual(wrapText('a\nb', 10), ['a', 'b'])
    assert.deepEqual(wrapText('', 10), [''])
    const wrapped = wrapText('ab👨‍👩‍👧‍👦cd', 3)
    assert.deepEqual(wrapped, ['ab', '👨‍👩‍👧‍👦c', 'd'])
    assert.ok(wrapped.every((line) => displayWidth(line) <= 3))
  })

  it('strips terminal escapes and controls from untrusted fragments', () => {
    assert.equal(stripTerminalSequences('\x1b[31mred\x1b[0m'), 'red')
    assert.equal(stripTerminalSequences('\x1b]8;;http://x\x07link\x1b]8;;\x07'), 'link')
    assert.equal(sanitizeLine('  \x1b[31m evil \x1b[0m  name\x07 ', { max: 40 }), 'evil name')
    assert.equal(sanitizeMultiline('a\r\nb\rc\u0007d\te'), 'a\nb\nc d    e')
  })
})

describe('renderFrame basics', () => {
  it('returns a full frame for 80x24 and 40x12', () => {
    const wide = renderFrame(baseView(), { columns: 80, rows: 24, color: false })
    const wideLines = plainFrame(wide)
    assertShape(wideLines, 80, 24)

    assert.ok(wide.output.startsWith(HIDE_CURSOR))
    assert.ok(!wide.output.endsWith('\n'))
    assert.deepEqual(wide.cursor, { row: 23, column: 7 })

    const narrow = renderFrame(baseView(), { columns: 40, rows: 12, color: false })
    const narrowLines = plainFrame(narrow)
    assertShape(narrowLines, 40, 12)
  })

  it('draws the branded header, session/model line, roles, attachments, composer and hint', () => {
    const lines = plainFrame(renderFrame(baseView(), { columns: 80, rows: 24, color: false }))

    assert.match(lines[0], /^dsh-ask {2}· {2}dsh-local-cli/)
    assert.ok(lines[0].includes('/Users/example/workspace/dsh-local-cli'))

    assert.ok(lines[1].includes('session Refactor TUI screen'))
    assert.ok(lines[1].includes('session s-abc123456…') === false)
    assert.ok(lines[1].includes('model deepseek-v4-flash'))
    assert.ok(lines[1].includes('ready'))

    const userIndex = lines.findIndex((line) => line.startsWith('user '))
    const assistantIndex = lines.findIndex((line) => line.startsWith('assistant '))
    const toolIndex = lines.findIndex((line) => line.startsWith('tool '))
    const errorIndex = lines.findIndex((line) => line.startsWith('error '))
    const systemIndex = lines.findIndex((line) => line.startsWith('system '))
    for (const index of [userIndex, assistantIndex, toolIndex, errorIndex, systemIndex]) {
      assert.ok(index >= 2, `missing role line (index ${index})`)
    }
    assert.ok(userIndex < assistantIndex && assistantIndex < toolIndex && toolIndex < errorIndex && errorIndex < systemIndex)
    assert.ok(lines[userIndex].includes('你好'))
    assert.ok(lines[systemIndex].includes('switched to session s-abc123'))

    // Bottom chrome is fixed: rule, attachment bar, composer, hint.
    const ruleIndex = lines.findIndex((line) => line === '─'.repeat(80))
    assert.equal(ruleIndex, 20)
    assert.match(lines[21], /^attach +screenshot\.png/)
    assert.match(lines[22], /^> 继续/)
    assert.ok(lines[23].includes('Enter 发送'))
    assert.deepEqual(renderFrame(baseView(), { columns: 80, rows: 24, color: false }).cursor, {
      row: 23,
      column: 7,
    })
  })

  it('degrades the 40x12 layout without overflow', () => {
    const lines = plainFrame(renderFrame(baseView(), { columns: 40, rows: 12, color: false }))
    assertShape(lines, 40, 12)
    assert.match(lines[0], /^dsh-ask {2}· {2}dsh-local-cli/)
    assert.ok(lines[1].includes('session Refactor T…'))
    assert.ok(lines[1].includes('model deepseek…'))
    assert.ok(lines[1].includes('ready') === false) // status is prioritized out before overflow
    assert.match(lines[10], /^> 继续/)
    assert.ok(lines[11].startsWith('Enter 发送'))
  })

  it('shows the cursor, and keeps it hidden when a modal has no cursor row', () => {
    const frame = renderFrame(baseView(), { columns: 80, rows: 24, color: false })
    assert.ok(frame.cursor)
    const match = frame.output.match(/\x1b\[(\d+);(\d+)H\x1b\[\?25h$/)
    assert.ok(match, 'frame should position then show the cursor at the very end')
    assert.equal(Number(match[1]), frame.cursor.row)
    assert.equal(Number(match[2]), frame.cursor.column)
    assert.equal(frame.output.split(SHOW_CURSOR).length - 1, 1)

    // A 1-row terminal cannot fit the modal query, so there is no editable
    // cursor and the frame must not reveal the hidden cursor.
    const tiny = renderFrame(
      baseView({
        modal: { title: 'Sessions', items: [{ label: 'only', detail: '' }], selected: 0, query: '', footer: 'f' },
      }),
      { columns: 80, rows: 1, color: false },
    )
    assert.equal(tiny.cursor, null)
    assert.ok(!tiny.output.includes(SHOW_CURSOR))
  })

  it('writes only layout without SGR colours when color is false', () => {
    const frame = renderFrame(baseView(), { columns: 80, rows: 24, color: false })
    assert.doesNotMatch(frame.output, /\x1b\[[0-9;]+m/)
    const colored = renderFrame(baseView(), { columns: 80, rows: 24, color: true })
    assert.match(colored.output, /\x1b\[38;5;/)
    assert.deepEqual(plainFrame(colored), plainFrame(frame))
  })

  it('never exceeds the requested size across narrow and tiny terminals', () => {
    const sizes = [
      [80, 24],
      [60, 18],
      [40, 12],
      [30, 10],
      [20, 8],
      [12, 6],
      [8, 4],
      [5, 3],
      [2, 2],
      [1, 1],
    ]
    for (const [columns, rows] of sizes) {
      const lines = plainFrame(renderFrame(baseView(), { columns, rows, color: false }))
      assertShape(lines, columns, rows)
      const text = lines.join('')
      assert.ok(text.isWellFormed(), `${columns}x${rows} frame is not well formed`)
    }
  })
})

describe('message wrapping, scrolling and untrusted text', () => {
  it('wraps CJK and emoji by display width and keeps clusters intact', () => {
    const text = `${'中文'.repeat(20)} 👨‍👩‍👧‍👦 e\u0301`
    const frame = renderFrame(baseView({ messages: [{ role: 'assistant', text }] }), {
      columns: 40,
      rows: 12,
      color: false,
    })
    const lines = plainFrame(frame)
    assertShape(lines, 40, 12)
    const flat = plainText(frame)
    assert.ok(flat.includes('👨‍👩‍👧‍👦'))
    assert.ok(flat.includes('e\u0301'))
    assert.ok(flat.isWellFormed())
    assert.ok(lines.every((line) => line.isWellFormed()))
  })

  it('degrades a wide cluster at one column without overflowing', () => {
    const frame = renderFrame(baseView({ messages: [{ role: 'assistant', text: '👨‍👩‍👧‍👦' }] }), {
      columns: 1,
      rows: 3,
      color: false,
    })
    assertShape(plainFrame(frame), 1, 3)
  })

  it('pins scrollOffset 0 to the newest line and clamps large offsets to the oldest', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: 'assistant',
      text: `msg-${String(index).padStart(2, '0')}`,
    }))
    const view = baseView({ messages, scrollOffset: 0 })
    const bottom = plainFrame(renderFrame(view, { columns: 60, rows: 14, color: false }))
    assert.ok(bottom.some((line) => line.includes('msg-39')))
    assert.ok(!bottom.some((line) => line.includes('msg-00')))

    const scrolled = plainFrame(
      renderFrame(baseView({ messages, scrollOffset: 3 }), { columns: 60, rows: 14, color: false }),
    )
    assert.ok(scrolled.some((line) => line.includes('msg-36')))
    assert.ok(!scrolled.some((line) => line.includes('msg-39')))

    const clamped = plainFrame(
      renderFrame(baseView({ messages, scrollOffset: 9999 }), { columns: 60, rows: 14, color: false }),
    )
    assert.ok(clamped.some((line) => line.includes('msg-00')))
  })

  it('strips control sequences from every untrusted view field', () => {
    const malicious = baseView({
      project: '\x1b[31mevil-project\x1b[0m',
      cwd: '\x1b]8;;http://evil\x07/cwd\x1b]8;;\x07',
      sessionTitle: 'title\x07with\x1b[2Jescape',
      sessionId: 's-\x1b[31m1',
      model: '\x1b]8;;http://evil\x07model\x1b]8;;\x07',
      status: '\x1b[2Jready',
      messages: [
        { role: 'user', text: 'hello \x1b[31mred\x1b[0m \x1b]8;;http://evil\x07link\x1b]8;;\x07 \x07bell' },
        { role: 'error', text: '\x1b[2Jcleared' },
      ],
      input: 'safe \x1b[31mtext\x1b[0m',
      inputCursor: 4,
      attachments: [{ name: '\x1b[31ma.png\x1b[0m' }],
      hint: '\x1b[31mhint\x1b[0m',
      modal: {
        title: '\x1b[31mSessions\x1b[0m',
        items: [{ label: '\x1b[31mitem\x1b[0m', detail: '\x1b]8;;http://evil\x07detail\x1b]8;;\x07' }],
        selected: 0,
        query: '\x1b[31mquery\x1b[0m',
        footer: '\x1b[31mfooter\x1b[0m',
      },
    })

    const assertSafeFrame = (frame) => {
      const output = frame.output
      assert.ok(!output.includes('\x1b[31m'), 'user CSI must not survive')
      assert.ok(!output.includes('\x1b[2J') || output.startsWith(HIDE_CURSOR), 'no user clear-screen')
      assert.ok(!output.includes('\x07'))
      assert.ok(!output.includes('\x1b]8'))
      assert.ok(!output.includes('http://evil'), 'OSC payload must not be displayed')
      const lines = plainFrame(frame)
      for (const line of lines) assert.doesNotMatch(line, /[\x00-\x08\x0b-\x1f\x7f]/)
      return lines.join('\n')
    }

    // Normal frame: transcript, attachment and hint are all sanitized.
    const chat = assertSafeFrame(renderFrame({ ...malicious, modal: null }, { columns: 80, rows: 24, color: false }))
    assert.ok(chat.includes('evil-project'))
    assert.ok(chat.includes('a.png'))
    assert.ok(chat.includes('hint'))
    assert.ok(chat.includes('red'))
    assert.ok(chat.includes('link'))
    assert.ok(chat.includes('bell'))

    // Modal frame: modal title/items/query/footer are sanitized too, and the
    // hidden chat behind the selector cannot re-introduce escapes or text.
    const modalLines = plainFrame(renderFrame(malicious, { columns: 80, rows: 20, color: false }))
    const modalText = assertSafeFrame(renderFrame(malicious, { columns: 80, rows: 20, color: false }))
    assert.ok(modalText.includes('evil-project'))
    assert.ok(modalText.includes('item'))
    assert.ok(modalText.includes('query'))
    assert.ok(modalText.includes('footer'))
    assert.ok(!modalText.includes('a.png'))
    assert.ok(!modalText.includes('http://evil'))
    assert.ok(modalLines.length === 20)
  })

  it('maps inputCursor (UTF-16) to a display column across CJK and emoji', () => {
    const cjk = renderFrame(baseView({ input: '你好a', inputCursor: 2 }), { columns: 80, rows: 24, color: false })
    assert.deepEqual(cjk.cursor, { row: 23, column: 7 }) // 2 gutter + 4 cells + 1

    const emoji = '👨‍👩‍👧‍👦x'
    const family = renderFrame(baseView({ input: emoji, inputCursor: 11 }), {
      columns: 80,
      rows: 24,
      color: false,
    })
    assert.deepEqual(family.cursor, { row: 23, column: 5 }) // 2 gutter + 2 cells + 1
  })

  it('limits the composer to five visual lines and keeps the cursor visible', () => {
    const long = renderFrame(baseView({ input: 'x'.repeat(400), inputCursor: 400 }), {
      columns: 80,
      rows: 24,
      color: false,
    })
    const lines = plainFrame(long)
    assertShape(lines, 80, 24)
    const hintIndex = lines.findIndex((line) => line.includes('Enter 发送'))
    assert.equal(hintIndex, 23)
    const inputIndexes = []
    for (let index = 18; index < hintIndex; index += 1) {
      if (/^[> ]/.test(lines[index]) && (lines[index].trimStart().startsWith('x') || lines[index].startsWith('>'))) {
        inputIndexes.push(index)
      }
    }
    assert.equal(inputIndexes.length, MAX_INPUT_LINES)
    assert.ok(long.cursor.row >= inputIndexes[0] + 1 && long.cursor.row <= inputIndexes[inputIndexes.length - 1] + 1)

    const explicit = renderFrame(baseView({ input: 'a\nb\nc\nd\ne\nf', inputCursor: 11 }), {
      columns: 80,
      rows: 24,
      color: false,
    })
    const explicitLines = plainFrame(explicit)
    assertShape(explicitLines, 80, 24)
    assert.ok(explicit.cursor.row > 0 && explicit.cursor.row <= 24)
  })
})

describe('modal overlay', () => {
  function modalView(overrides = {}) {
    return baseView({
      modal: {
        title: 'Sessions',
        items: Array.from({ length: 50 }, (_, index) => ({
          label: `item-${String(index).padStart(2, '0')}`,
          detail: `detail ${index}`,
        })),
        selected: 45,
        query: 'item',
        footer: '↑↓ 选择 · Enter 打开 · Esc 退出',
        ...overrides,
      },
    })
  }

  it('highlights the selected row and scrolls tall item lists', () => {
    const lines = plainFrame(renderFrame(modalView(), { columns: 60, rows: 18, color: false }))
    assertShape(lines, 60, 18)

    const top = lines.findIndex((line) => line.includes('┌─ Sessions'))
    const bottom = lines.findIndex((line) => line.includes('└'))
    assert.ok(top >= 0 && bottom > top)
    assert.ok(lines.some((line) => line.includes('filter item')))
    assert.ok(lines.some((line) => line.includes('> item-45')))
    assert.ok(!lines.some((line) => line.includes('item-00')))
    assert.ok(lines.some((line) => line.includes('↑↓ 选择 · Enter 打开 · Esc 退出')))

    const visibleItems = lines.filter((line) => line.includes('item-'))
    assert.ok(visibleItems.length <= 12, `expected the item viewport to clip, saw ${visibleItems.length} rows`)
    assert.ok(visibleItems.length >= 2)
  })

  it('keeps the first item selected and clips the tail', () => {
    const lines = plainFrame(
      renderFrame(modalView({ selected: 0 }), { columns: 60, rows: 18, color: false }),
    )
    assert.ok(lines.some((line) => line.includes('> item-00')))
    assert.ok(!lines.some((line) => line.includes('item-49')))
  })

  it('clamps an out-of-range selected index to the last item', () => {
    const lines = plainFrame(
      renderFrame(modalView({ selected: 9999 }), { columns: 60, rows: 18, color: false }),
    )
    assert.ok(lines.some((line) => line.includes('> item-49')))
  })

  it('shows a placeholder when the picker has no items', () => {
    const lines = plainFrame(
      renderFrame(modalView({ items: [], selected: 0 }), { columns: 60, rows: 18, color: false }),
    )
    assert.ok(lines.some((line) => line.includes('(no sessions)')))
  })

  it('fits a modal into narrow and short terminals without overflow', () => {
    for (const [columns, rows] of [
      [40, 12],
      [20, 8],
      [12, 6],
      [8, 4],
      [5, 3],
      [1, 1],
    ]) {
      const frame = renderFrame(modalView(), { columns, rows, color: false })
      const lines = plainFrame(frame)
      assertShape(lines, columns, rows)
      if (rows > 1) assert.ok(lines.some((line) => line.includes('>')), 'selected marker should survive')
    }
  })

  it('is a clean page: two header rows, cleared middle, bottom hint', () => {
    const view = modalView()
    const normal = plainFrame(renderFrame({ ...view, modal: null }, { columns: 80, rows: 24, color: false }))
    const frame = renderFrame(view, { columns: 80, rows: 24, color: false })
    const lines = plainFrame(frame)
    assertShape(lines, 80, 24)

    // Both header rows survive untouched; the selector starts directly below
    // the session/model line instead of covering it.
    assert.deepEqual(lines.slice(0, 2), normal.slice(0, 2))
    assert.ok(lines[0].includes('dsh-ask'))
    assert.ok(lines[1].includes('session Refactor TUI screen'))
    assert.ok(lines[2].includes('┌─ Sessions'))

    // The selector may use at most rows - 3 lines and is followed by the hint.
    const top = lines.findIndex((line) => line.includes('┌─ Sessions'))
    const bottom = lines.findIndex((line) => line.includes('└'))
    assert.equal(top, 2)
    assert.equal(bottom, 22)
    assert.equal(bottom - top + 1, 24 - 3)
    assert.ok(lines[23].includes('↑↓ 选择 · Enter 打开 · Esc 退出'))
    assert.equal(lines.filter((line) => line.includes('↑↓ 选择 · Enter 打开 · Esc 退出')).length, 1)

    // No transcript, composer or attachment fragments may leak around/behind
    // the selection page.
    const middle = lines.slice(2, 23).join('\n')
    for (const fragment of [
      'screenshot.png',
      'attach ',
      '> 继续',
      'user     你好',
      'assistant 好的',
      'read dsh-ask.mjs',
      'switched to session',
    ]) {
      assert.ok(!middle.includes(fragment), `background fragment leaked: ${fragment}`)
    }

    // Outside the border every middle row is blank.
    const left = lines[2].indexOf('┌')
    const right = lines[2].indexOf('┐')
    assert.ok(left >= 0 && right > left)
    for (let row = 2; row <= 22; row += 1) {
      assert.equal(lines[row].slice(0, left).trim(), '')
      assert.equal(lines[row].slice(right + 1).trim(), '')
    }

    // The cursor sits on the modal filter line, not in the hidden composer.
    assert.deepEqual(frame.cursor, { row: 4, column: 17 })
  })

  it('never makes the selector taller than rows - 3', () => {
    for (const [columns, rows] of [
      [80, 24],
      [60, 18],
      [40, 12],
      [20, 8],
      [20, 7],
    ]) {
      const lines = plainFrame(renderFrame(modalView(), { columns, rows, color: false }))
      assertShape(lines, columns, rows)
      const top = lines.findIndex((line) => line.includes('┌─ Sessions'))
      const bottom = lines.findIndex((line) => line.includes('└'))
      assert.ok(top >= 2, `selector should start below the header (${columns}x${rows})`)
      assert.ok(bottom > top)
      assert.ok(bottom - top + 1 <= rows - 3, `selector too tall at ${columns}x${rows}`)
    }
  })

  it('keeps both header rows and degrades the middle on short terminals', () => {
    for (const rows of [8, 6, 5, 4]) {
      const lines = plainFrame(renderFrame(modalView(), { columns: 40, rows, color: false }))
      assertShape(lines, 40, rows)
      assert.ok(lines[0].includes('dsh-ask'))
      assert.ok(lines[1].includes('session'))
      assert.ok(lines[rows - 1].includes('↑↓ 选择'))
      assert.ok(lines.some((line) => line.includes('item-')))
    }

    const three = plainFrame(renderFrame(modalView(), { columns: 40, rows: 3, color: false }))
    assertShape(three, 40, 3)
    assert.ok(three[0].includes('dsh-ask'))
    assert.ok(three[1].includes('session'))
    assert.ok(three[2].includes('>'))

    const two = plainFrame(renderFrame(modalView(), { columns: 40, rows: 2, color: false }))
    assertShape(two, 40, 2)
    assert.ok(two[0].includes('dsh-ask'))
    assert.ok(two[1].includes('session'))
  })
})

describe('createScreen lifecycle', () => {
  it('enters and restores the terminal, writes one frame per render and is idempotent', () => {
    const { input, output, screen } = harness()
    try {
      assert.equal(screen.start(), screen)
      assert.equal(input.rawCalls.length, 1)
      assert.equal(input.rawCalls[0], true)
      assert.ok(output.writes[0].includes('\x1b[?1049h'))
      assert.ok(output.writes[0].includes('\x1b[?25l'))
      assert.ok(output.writes[0].includes('\x1b[?2004h'))

      screen.start() // idempotent
      assert.equal(input.rawCalls.length, 1)
      assert.equal(output.writes.length, 1)

      const frame = screen.render(baseView())
      assert.ok(frame)
      assert.equal(output.writes.length, 2)
    } finally {
      screen.stop()
    }
  })

  it('renders complete frames in a single write and restores everything on stop', () => {
    const { input, output, screen } = harness()
    assert.equal(screen.render(baseView()), null)
    assert.equal(output.writes.length, 0)

    screen.start()
    assert.equal(output.writes.length, 1)
    const frame = screen.render(baseView())
    assert.ok(frame)
    assert.equal(output.writes.length, 2)
    const lines = plainFrame({ output: output.writes[1] })
    assertShape(lines, 80, 24)
    assert.ok(output.writes[1].endsWith(SHOW_CURSOR))
    assert.deepEqual(frame.cursor, { row: 23, column: 7 })

    assert.equal(screen.stop(), true)
    assert.equal(output.writes.length, 3)
    assert.ok(output.writes[2].includes('\x1b[?25h'))
    assert.ok(output.writes[2].includes('\x1b[?2004l'))
    assert.ok(output.writes[2].includes('\x1b[?1049l'))
    assert.deepEqual(input.rawCalls, [true, false])
    assert.equal(input.isRaw, false)

    assert.equal(screen.stop(), false)
    assert.equal(output.writes.length, 3)
    assert.equal(screen.render(baseView()), null)
    assert.equal(output.writes.length, 3)
  })

  it('restores the previous raw-mode value instead of forcing false', () => {
    const input = new MockInput({ isRaw: true })
    const output = new MockOutput()
    const screen = createScreen({ input, output })
    screen.start()
    screen.stop()
    assert.deepEqual(input.rawCalls, [true, true])
    assert.equal(input.isRaw, true)
  })

  it('forwards keys and reassembles bracketed paste as one paste event', () => {
    const { input, screen, keys } = harness()
    try {
      screen.start()
      input.emit('data', Buffer.from('a\x1b[A'))
      input.emit('data', Buffer.from('\x1b[200~line1\nline2\x1b[201~'))
      input.emit('data', Buffer.from('b'))
      assert.deepEqual(
        keys.map(({ str, key }) => [str, key && key.name]),
        [
          ['a', 'a'],
          [undefined, 'up'],
          ['line1\nline2', 'paste'],
          ['b', 'b'],
        ],
      )
      const paste = keys.find(({ key }) => key && key.name === 'paste')
      assert.equal(paste.key.bracketed, true)
      assert.match(paste.key.sequence, /^\x1b\[200~line1\nline2\x1b\[201~$/)
      assert.ok(!keys.some(({ key }) => key && key.name === 'enter'), 'pasted newline must not become Enter')
    } finally {
      screen.stop()
    }
  })

  it('forwards resize events until stop', () => {
    const { input, output, screen, resizes } = harness()
    const sigwinchBefore = process.listenerCount('SIGWINCH')
    try {
      screen.start()
      output.columns = 100
      output.rows = 30
      output.emit('resize')
      assert.deepEqual(resizes.at(-1), { columns: 100, rows: 30 })

      process.emit('SIGWINCH')
      assert.deepEqual(resizes.at(-1), { columns: 100, rows: 30 })
      assert.equal(process.listenerCount('SIGWINCH'), sigwinchBefore + 1)

      screen.stop()
      assert.equal(process.listenerCount('SIGWINCH'), sigwinchBefore)
      const count = resizes.length
      output.emit('resize')
      process.emit('SIGWINCH')
      assert.equal(resizes.length, count)
    } finally {
      screen.stop()
    }
  })

  it('cleans up only the listeners readline added, preserving pre-existing listeners', () => {
    const input = new MockInput()
    const output = new MockOutput()
    const preData = () => {}
    const preKeypress = () => {}
    input.on('data', preData)
    input.on('keypress', preKeypress)
    const screen = createScreen({ input, output })
    try {
      screen.start()
      assert.ok(input.listenerCount('data') >= 2)
      assert.equal(input.listenerCount('keypress'), 2)
      screen.stop()
      assert.deepEqual(input.listeners('data'), [preData])
      assert.deepEqual(input.listeners('keypress'), [preKeypress])
      assert.equal(input.listenerCount('newListener'), 0)
    } finally {
      screen.stop()
    }
  })

  it('can restart after stop and keeps forwarding keys', () => {
    const { input, output, screen, keys } = harness()
    try {
      screen.start()
      screen.stop()
      assert.equal(input.listenerCount('keypress'), 0)
      assert.equal(input.listenerCount('data'), 0)

      screen.start()
      input.emit('data', Buffer.from('c'))
      assert.deepEqual(
        keys.map(({ key }) => key && key.name),
        ['c'],
      )
      const lines = plainFrame({ output: screen.render(baseView()).output })
      assertShape(lines, 80, 24)
      assert.equal(output.listenerCount('resize'), 1)
    } finally {
      screen.stop()
    }
  })

  it('honours NO_COLOR and TERM=dumb for colour output but never changes layout', () => {
    const { output, screen } = harness()
    try {
      screen.start()
      withEnv('NO_COLOR', undefined, () => {
        withEnv('TERM', 'xterm-256color', () => {
          const colored = screen.render(baseView())
          assert.match(colored.output, /\x1b\[38;5;/)
        })
        withEnv('NO_COLOR', '1', () => {
          const plain = screen.render(baseView())
          assert.doesNotMatch(plain.output, /\x1b\[[0-9;]+m/)
        })
        withEnv('NO_COLOR', undefined, () => {
          withEnv('TERM', 'dumb', () => {
            const dumb = screen.render(baseView())
            assert.doesNotMatch(dumb.output, /\x1b\[[0-9;]+m/)
          })
        })
      })
      const rendered = screen.render(baseView())
      assertShape(plainFrame(rendered), 80, 24)
    } finally {
      screen.stop()
    }
  })

  it('works with non-TTY streams and without callbacks', () => {
    const input = new MockInput({ isTTY: false, raw: false })
    const output = new MockOutput({ columns: 30, rows: 10, isTTY: false })
    const screen = createScreen({ input, output })
    assert.doesNotThrow(() => {
      screen.start()
      const frame = screen.render(baseView())
      assert.ok(frame)
      assert.equal(frame.output.includes('\x1b[38;5;'), false)
      screen.stop()
    })
  })
})

describe('default hint contract', () => {
  it('uses the business wording and does not advertise Ctrl+C quit', () => {
    assert.ok(DEFAULT_HINT.includes('Enter 发送'))
    assert.ok(DEFAULT_HINT.includes('Alt+Enter 换行'))
    assert.ok(DEFAULT_HINT.includes('Ctrl+P 会话'))
    assert.ok(DEFAULT_HINT.includes('Ctrl+N 新建'))
    assert.ok(DEFAULT_HINT.includes('F1 帮助'))
    assert.ok(!DEFAULT_HINT.includes('Ctrl+C'))
    assert.ok(!DEFAULT_HINT.includes('Ctrl+Q'))
    const lines = plainFrame(renderFrame(baseView({ hint: '' }), { columns: 80, rows: 24, color: false }))
    assert.ok(lines[23].includes('Enter 发送'))
    assert.ok(lines[23].includes('Ctrl+N 新建'))
  })
})
