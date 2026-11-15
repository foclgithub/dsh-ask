/**
 * dsh-tui-screen.mjs - full-screen TUI view layer for dsh-ask.
 *
 * The module is deliberately split in two halves:
 *
 *   renderFrame(view, { columns, rows, color })   pure, no I/O, returns
 *                                                 { output, cursor }
 *   createScreen({ input, output, onKey, onResize })  owns the alternate
 *                                                 screen, raw mode, bracketed
 *                                                 paste, key forwarding and
 *                                                 resize forwarding.
 *
 * `view` is the only input the layout understands:
 *
 *   {
 *     project, cwd, sessionTitle, sessionId, model, status,
 *     messages: [{ role, text }],
 *     input, inputCursor,
 *     attachments: [{ name }],
 *     hint,
 *     scrollOffset,
 *     modal: null | { title, items: [{ label, detail }], selected, query, footer }
 *   }
 *
 * Field names and the shape of `renderFrame` are the contract used by dsh-ask;
 * see `docs/architecture.md` for the layer split. This file only imports Node
 * built-ins and never touches the network, the clipboard, the file system, or
 * child processes.
 *
 * All text that comes from a Session, a workspace, a file name, a modal item,
 * or a paste buffer is untrusted: every rendered string is stripped of terminal
 * escape sequences and C0/C1 controls. Text is wrapped and truncated by display
 * width with grapheme clusters kept intact, so CJK and emoji never straddle a
 * line boundary and no line can exceed `columns`.
 */

import { emitKeypressEvents } from 'node:readline'

// ---------------------------------------------------------------------------
// Public limits and frame escape sequences
// ---------------------------------------------------------------------------

/** The composer never grows past this many visual lines. */
export const MAX_INPUT_LINES = 5

/**
 * Keyboard hint used when the business layer does not provide one. The wording
 * mirrors the business layer's HINT_READY; Ctrl+Q lives in the help modal, not
 * here. Narrow windows simply truncate the line.
 */
export const DEFAULT_HINT =
  'Enter 发送 · Alt+Enter 换行 · Ctrl+P 会话 · Ctrl+N 新建 · F1 帮助'

const ENTER_ALT_SCREEN = '\x1b[?1049h'
const EXIT_ALT_SCREEN = '\x1b[?1049l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const CLEAR_SCREEN = '\x1b[2J'
const CURSOR_HOME = '\x1b[H'
const RESET = '\x1b[0m'
const ELLIPSIS = '…'

// Cold, low-saturation 256-colour palette. Borders are just a faint grey;
// role labels carry the only real hue. NO_COLOR removes these sequences but
// leaves every layout decision untouched (selection is also marked with ">").
const STYLE_SEQUENCES = {
  accent: '\x1b[38;5;110m',
  accentBold: '\x1b[1m\x1b[38;5;110m',
  dim: '\x1b[38;5;244m',
  border: '\x1b[38;5;241m',
  roleUser: '\x1b[38;5;110m',
  roleAssistant: '\x1b[38;5;109m',
  roleTool: '\x1b[38;5;108m',
  roleError: '\x1b[38;5;174m',
  roleSystem: '\x1b[38;5;139m',
  status: '\x1b[38;5;109m',
  selected: '\x1b[48;5;236m\x1b[38;5;117m',
  hint: '\x1b[38;5;244m',
  plain: '',
}

const ROLE_LABELS = {
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  error: 'error',
  system: 'system',
}

const ROLE_SHORT = { user: 'u', assistant: 'a', tool: 't', error: 'e', system: 's' }

const ROLE_STYLES = {
  user: 'roleUser',
  assistant: 'roleAssistant',
  tool: 'roleTool',
  error: 'roleError',
  system: 'roleSystem',
}

// ---------------------------------------------------------------------------
// Grapheme and display-width primitives
// ---------------------------------------------------------------------------

const WIDE_CODE_POINT_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo init
  [0x2329, 0x232a],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji (misc symbols, emoticons)
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // symbols and pictographs extended A
  [0x20000, 0x3fffd], // CJK extensions B+
]

const COMBINING_MARK = /\p{Mn}|\p{Me}|\p{Cf}/u
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

let graphemeSegmenter = null
try {
  graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
} catch {
  graphemeSegmenter = null
}

/** Split text into user-perceived characters (grapheme clusters). */
export function splitGraphemes(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (!graphemeSegmenter) return Array.from(text)
  const out = []
  for (const part of graphemeSegmenter.segment(text)) out.push(part.segment)
  return out
}

function isWideCodePoint(codePoint) {
  for (const [from, to] of WIDE_CODE_POINT_RANGES) {
    if (codePoint >= from && codePoint <= to) return true
  }
  return false
}

function graphemeWidth(grapheme) {
  if (grapheme === '') return 0
  // Emoji clusters (ZWJ families, flags, keycaps, VS16 presentations) are two
  // cells wide as a whole even though they contain several code points.
  if (grapheme.includes('\u200d') || grapheme.includes('\ufe0f') || PICTOGRAPHIC.test(grapheme)) {
    return 2
  }
  const codePoint = grapheme.codePointAt(0)
  if (codePoint === undefined) return 0
  const base = String.fromCodePoint(codePoint)
  if (COMBINING_MARK.test(base)) return 0
  if (isWideCodePoint(codePoint)) return 2
  return 1
}

// ---------------------------------------------------------------------------
// Terminal-safe text
// ---------------------------------------------------------------------------

// OSC, DCS/PM/APC, CSI and bare ESC sequences. Content is never trusted to be
// "already safe": an assistant message, a session title, or a pasted file name
// can all carry escape bytes.
const ESCAPE_SEQUENCE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*(?:\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

// Sticky variant used while walking one input string top to bottom.
const ESCAPE_SEQUENCE_STICKY =
  /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*(?:\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/y

const UNSAFE_SINGLE_LINE =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const UNSAFE_MULTI_LINE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const UNSAFE_INPUT_CHAR = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

/** Remove terminal escape sequences, leaving the printable text behind. */
export function stripTerminalSequences(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.replace(ESCAPE_SEQUENCE, '')
}

/**
 * Sanitize a single-line fragment (project name, title, model, file name,
 * footer, hint, ...): strip escapes, replace controls with spaces, collapse
 * whitespace, trim and optionally truncate by display width.
 */
export function sanitizeLine(value, options = {}) {
  const max = options.max
  let text = stripTerminalSequences(value).replace(UNSAFE_SINGLE_LINE, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (Number.isFinite(max) && max >= 0) text = truncateRight(text, Math.floor(max))
  return text
}

/**
 * Sanitize multi-line message text while preserving real newlines. Carriage
 * returns are normalised, tabs expanded and every other control replaced by a
 * space so the wrapper only ever sees printable text and "\n".
 */
export function sanitizeMultiline(value) {
  let text = stripTerminalSequences(value)
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/\t/g, '    ')
  return text.replace(UNSAFE_MULTI_LINE, ' ')
}

// ---------------------------------------------------------------------------
// Width-aware truncation, wrapping and segment helpers
// ---------------------------------------------------------------------------

function truncateRight(value, maxWidth) {
  const limit = Math.max(0, Math.floor(maxWidth))
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (limit === 0) return ''
  if (displayWidth(text) <= limit) return text
  let out = ''
  let used = 0
  let cut = false
  for (const grapheme of splitGraphemes(text)) {
    const width = graphemeWidth(grapheme)
    if (used + width > limit) {
      cut = true
      break
    }
    out += grapheme
    used += width
  }
  if (!cut) return out
  if (used + 1 > limit) {
    // Drop a trailing wide cluster so the ellipsis itself still fits.
    const graphemes = splitGraphemes(out)
    while (graphemes.length > 0 && used + 1 > limit) {
      used -= graphemeWidth(graphemes.pop())
    }
    out = graphemes.join('')
  }
  return used + 1 <= limit ? `${out}${ELLIPSIS}` : out
}

function truncateLeft(value, maxWidth) {
  const limit = Math.max(0, Math.floor(maxWidth))
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (limit === 0) return ''
  if (displayWidth(text) <= limit) return text
  const graphemes = splitGraphemes(text)
  let out = ''
  let used = 0
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const width = graphemeWidth(graphemes[index])
    if (used + width + 1 > limit) break
    out = graphemes[index] + out
    used += width
  }
  return `${ELLIPSIS}${out}`
}

/** Width of one text run in terminal cells, ignoring escape sequences. */
export function displayWidth(value) {
  const text = stripTerminalSequences(value)
  let width = 0
  for (const grapheme of splitGraphemes(text)) width += graphemeWidth(grapheme)
  return width
}

/**
 * Word-wrap display text to `width` cells. Newlines are hard breaks, words are
 * broken only when a single word is wider than the line, and grapheme clusters
 * are never split. Leading spaces introduced by a soft wrap are dropped.
 */
export function wrapText(value, width) {
  const max = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1))
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const lines = []
  for (const paragraph of text.split('\n')) {
    lines.push(...wrapParagraph(paragraph, max))
  }
  return lines.length > 0 ? lines : ['']
}

function wrapParagraph(text, max) {
  const lines = []
  let line = ''
  let lineWidth = 0
  let breakAt = -1

  const pushLine = () => {
    lines.push(line.replace(/\s+$/u, ''))
    line = ''
    lineWidth = 0
    breakAt = -1
  }

  for (const grapheme of splitGraphemes(text)) {
    if (line === '' && grapheme === ' ') continue
    const width = graphemeWidth(grapheme)
    if (width > max) {
      // A cluster wider than the entire line (e.g. an emoji at width 1):
      // degrade to a fitting replacement instead of overflowing the terminal.
      if (line !== '') pushLine()
      lines.push(truncateRight(grapheme, max))
      continue
    }
    if (lineWidth + width > max) {
      if (breakAt > 0) {
        const head = line.slice(0, breakAt)
        const tail = line.slice(breakAt + 1)
        lines.push(head.replace(/\s+$/u, ''))
        line = tail
        lineWidth = displayWidth(tail)
        breakAt = -1
      } else {
        pushLine()
      }
    }
    if (grapheme === ' ' && line !== '') breakAt = line.length
    line += grapheme
    lineWidth += width
  }
  if (line !== '' || lines.length === 0) lines.push(line.replace(/\s+$/u, ''))
  return lines
}

function segmentsWidth(segments) {
  let width = 0
  for (const segment of segments) width += displayWidth(segment.text)
  return width
}

/**
 * Cut a segment list to at most `maxWidth` cells. When content is dropped an
 * ellipsis is appended (if it fits). Returned width is exact for the segments
 * that were kept.
 */
function fitSegments(segments, maxWidth) {
  const limit = Math.max(0, Math.floor(maxWidth))
  const placed = []
  let used = 0
  let truncated = false

  for (const segment of segments) {
    if (!segment || !segment.text) continue
    for (const grapheme of splitGraphemes(segment.text)) {
      const width = graphemeWidth(grapheme)
      if (used + width > limit) {
        truncated = true
        break
      }
      placed.push({ grapheme, style: segment.style })
      used += width
    }
    if (truncated) break
  }

  if (truncated) {
    while (placed.length > 0 && used + 1 > limit) {
      const last = placed.pop()
      used -= graphemeWidth(last.grapheme)
    }
    if (used + 1 <= limit) {
      placed.push({ grapheme: ELLIPSIS, style: placed.length > 0 ? placed[placed.length - 1].style : 'dim' })
      used += 1
    }
  }

  const out = []
  for (const entry of placed) {
    const previous = out[out.length - 1]
    if (previous && previous.style === entry.style) previous.text += entry.grapheme
    else out.push({ text: entry.grapheme, style: entry.style })
  }
  return { segments: out, width: used, truncated }
}

/** Fit and right-pad a segment list so it occupies exactly `columns` cells. */
function padSegments(segments, columns) {
  const fitted = fitSegments(segments, columns)
  const out = fitted.segments.slice()
  if (fitted.width < columns) out.push({ text: ' '.repeat(columns - fitted.width), style: 'plain' })
  return out
}

/** Extract the [from, to) column slice of an already padded line. */
function sliceSegments(segments, from, to) {
  const start = Math.max(0, Math.floor(from))
  const end = Math.max(start, Math.floor(to))
  const out = []
  let column = 0
  for (const segment of segments) {
    let buffer = ''
    for (const grapheme of splitGraphemes(segment.text)) {
      const width = graphemeWidth(grapheme)
      const clusterStart = column
      const clusterEnd = column + width
      column = clusterEnd
      if (clusterEnd <= start) continue
      if (clusterStart >= end) break
      if (clusterStart >= start && clusterEnd <= end) {
        buffer += grapheme
      } else {
        const covered = Math.min(clusterEnd, end) - Math.max(clusterStart, start)
        if (covered > 0) buffer += ' '.repeat(covered)
      }
    }
    if (buffer) out.push({ text: buffer, style: segment.style })
    if (column >= end) break
  }
  const missing = end - start - segmentsWidth(out)
  if (missing > 0) out.push({ text: ' '.repeat(missing), style: 'plain' })
  return out
}

function stylePrefix(style, color) {
  if (!color) return ''
  return STYLE_SEQUENCES[style] || ''
}

function segmentsToAnsi(segments, color) {
  let output = ''
  for (const segment of segments) {
    if (!segment.text) continue
    const prefix = stylePrefix(segment.style, color)
    output += prefix ? `${prefix}${segment.text}${RESET}` : segment.text
  }
  return output
}

// ---------------------------------------------------------------------------
// View normalisation
// ---------------------------------------------------------------------------

function toDimension(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

function normalizeRole(value) {
  const role = sanitizeLine(value, { max: 20 }).toLowerCase()
  return role || 'system'
}

function normalizeModal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((item) => {
          if (typeof item === 'string') return { label: sanitizeLine(item, { max: 300 }), detail: '' }
          if (!item || typeof item !== 'object') return null
          return {
            label: sanitizeLine(item.label, { max: 300 }),
            detail: sanitizeLine(item.detail, { max: 300 }),
          }
        })
        .filter((item) => item && (item.label || item.detail))
    : []
  let selected = Number.isFinite(raw.selected) ? Math.floor(raw.selected) : 0
  selected = items.length > 0 ? Math.max(0, Math.min(selected, items.length - 1)) : 0
  return {
    title: sanitizeLine(raw.title, { max: 200 }),
    items,
    selected,
    query: sanitizeLine(raw.query, { max: 300 }),
    footer: sanitizeLine(raw.footer, { max: 300 }),
  }
}

function normalizeView(view) {
  const source = view && typeof view === 'object' ? view : {}
  const input = typeof source.input === 'string' ? source.input : source.input == null ? '' : String(source.input)
  const rawCursor = Number.isFinite(source.inputCursor) ? Math.floor(source.inputCursor) : input.length
  const inputCursor = Math.max(0, Math.min(rawCursor, input.length))
  const scrollOffset = Number.isFinite(source.scrollOffset) && source.scrollOffset > 0
    ? Math.floor(source.scrollOffset)
    : 0
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message) => {
        if (typeof message === 'string') return { role: 'system', text: sanitizeMultiline(message) }
        if (!message || typeof message !== 'object') return { role: 'system', text: '' }
        return {
          role: normalizeRole(message.role),
          text: sanitizeMultiline(message.text),
        }
      })
    : []
  const attachments = Array.isArray(source.attachments)
    ? source.attachments
        .map((attachment) => {
          if (typeof attachment === 'string') return sanitizeLine(attachment, { max: 120 })
          if (!attachment || typeof attachment !== 'object') return ''
          return sanitizeLine(attachment.name, { max: 120 })
        })
        .filter((name) => name !== '')
    : []
  return {
    project: sanitizeLine(source.project, { max: 120 }),
    cwd: sanitizeLine(source.cwd, { max: 300 }),
    sessionTitle: sanitizeLine(source.sessionTitle, { max: 300 }),
    sessionId: sanitizeLine(source.sessionId, { max: 120 }),
    model: sanitizeLine(source.model, { max: 120 }),
    status: sanitizeLine(source.status, { max: 60 }),
    messages,
    input,
    inputCursor,
    attachments,
    hint: sanitizeLine(source.hint, { max: 300 }),
    scrollOffset,
    modal: normalizeModal(source.modal),
  }
}

// ---------------------------------------------------------------------------
// Layout: header, messages, attachments, composer, hint
// ---------------------------------------------------------------------------

function roleLabelConfig(columns) {
  if (columns >= 40) return { labelWidth: 10, mode: 'full' }
  if (columns >= 8) return { labelWidth: 2, mode: 'short' }
  return { labelWidth: 0, mode: 'none' }
}

function roleLabel(role, mode) {
  if (mode === 'full') return ROLE_LABELS[role] || sanitizeLine(role, { max: 9 })
  if (mode === 'short') return ROLE_SHORT[role] || truncateRight(sanitizeLine(role, { max: 2 }), 1)
  return ''
}

function buildHeaderLines(view, columns) {
  const brand = truncateRight('dsh-ask', columns)
  const lineOne = [{ text: brand, style: 'accentBold' }]
  let leftWidth = displayWidth(brand)

  if (view.project && leftWidth + 6 <= columns) {
    const reserveCwd = columns >= 50 ? 12 : 0
    const projectMax = Math.max(1, Math.min(48, columns - leftWidth - 5 - reserveCwd))
    const project = truncateRight(view.project, projectMax)
    if (project) {
      lineOne.push({ text: '  ·  ', style: 'dim' }, { text: project, style: 'plain' })
      leftWidth += 5 + displayWidth(project)
    }
  }

  if (columns >= 50 && view.cwd) {
    const available = columns - leftWidth - 1
    if (available >= 6) {
      const cwd = truncateLeft(view.cwd, Math.min(available, 64))
      const gap = columns - leftWidth - displayWidth(cwd)
      if (gap > 0) {
        lineOne.push({ text: ' '.repeat(gap), style: 'plain' }, { text: cwd, style: 'dim' })
      }
    }
  }

  const lineTwo = buildSessionLine(view, columns)
  return [padSegments(lineOne, columns), padSegments(lineTwo, columns)]
}

function buildSessionLine(view, columns) {
  const title = view.sessionTitle || 'untitled'
  if (columns < 16) return [{ text: truncateRight(title, columns), style: 'plain' }]

  const segments = [{ text: 'session ', style: 'dim' }]
  const titleMax = Math.max(4, Math.min(40, Math.floor(columns * 0.28)))
  const shownTitle = truncateRight(title, titleMax)
  segments.push({ text: shownTitle, style: 'plain' })
  let used = 8 + displayWidth(shownTitle)

  if (view.sessionId && columns >= 44) {
    const id = truncateRight(view.sessionId, 12)
    const idWidth = displayWidth(id) + 2
    if (used + idWidth <= columns - 14) {
      segments.push(
        { text: ' (', style: 'dim' },
        { text: id, style: 'dim' },
        { text: ')', style: 'dim' },
      )
      used += idWidth
    }
  }

  const separator = '  ·  '
  const model = view.model || 'unknown'
  const modelMax = Math.max(6, Math.min(32, Math.floor(columns * 0.24)))
  const shownModel = truncateRight(model, modelMax)
  const modelPart = [
    { text: separator, style: 'dim' },
    { text: 'model ', style: 'dim' },
    { text: shownModel, style: 'accent' },
  ]
  const modelWidth = segmentsWidth(modelPart)
  if (used + modelWidth <= columns) {
    segments.push(...modelPart)
    used += modelWidth
  } else {
    const remaining = columns - used
    const labelWidth = displayWidth(separator) + 6
    if (remaining - labelWidth >= 2) {
      const short = truncateRight(model, remaining - labelWidth)
      segments.push(
        { text: separator, style: 'dim' },
        { text: 'model ', style: 'dim' },
        { text: short, style: 'accent' },
      )
      used = columns
    }
  }

  if (view.status) {
    const status = truncateRight(view.status, 14)
    const statusPart = [{ text: separator, style: 'dim' }, { text: status, style: 'status' }]
    const statusWidth = segmentsWidth(statusPart)
    if (used + statusWidth <= columns) {
      segments.push(...statusPart)
    } else if (columns - used >= 10) {
      const short = truncateRight(status, columns - used - displayWidth(separator))
      if (short) segments.push({ text: separator, style: 'dim' }, { text: short, style: 'status' })
    }
  }

  return segments
}

function buildMessageVisualLines(message, columns) {
  const config = roleLabelConfig(columns)
  const contentWidth = Math.max(1, columns - config.labelWidth)
  const text = sanitizeMultiline(message.text).replace(/^\n+|\n+$/g, '')
  const wrapped = wrapText(text, contentWidth)
  const label = roleLabel(message.role, config.mode)
  const labelStyle = ROLE_STYLES[message.role] || 'dim'
  const out = []
  for (let index = 0; index < wrapped.length; index += 1) {
    const line = []
    if (config.labelWidth > 0) {
      if (index === 0 && label !== '') {
        const padding = Math.max(0, config.labelWidth - displayWidth(label))
        line.push({ text: `${label}${' '.repeat(padding)}`, style: labelStyle })
      } else {
        line.push({ text: ' '.repeat(config.labelWidth), style: 'plain' })
      }
    }
    line.push({ text: wrapped[index], style: 'plain' })
    out.push(line)
  }
  return out
}

/**
 * Build exactly `viewport` lines from the bottom of the transcript.
 * `scrollOffset` counts visual lines scrolled up from the newest line (0 pins
 * the view to the bottom). Messages are wrapped from the newest backwards so a
 * short history does not require wrapping the whole conversation.
 */
function buildMessageViewport(messages, columns, viewport, scrollOffset) {
  if (viewport <= 0) return []
  if (messages.length === 0) return Array.from({ length: viewport }, () => [])
  const target = viewport + Math.max(0, Math.floor(scrollOffset))
  const collected = [] // newest-first visual lines
  let exhausted = true

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const lines = buildMessageVisualLines(messages[index], columns)
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      collected.push(lines[lineIndex])
    }
    if (collected.length >= target) {
      exhausted = index === 0
      break
    }
  }

  let windowLines
  if (exhausted) {
    const total = collected.length
    const maxOffset = Math.max(0, total - viewport)
    const offset = Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset)
    windowLines = collected.slice(offset, offset + viewport).reverse()
  } else {
    const offset = Math.max(0, Math.floor(scrollOffset))
    windowLines = collected.slice(offset, offset + viewport).reverse()
  }

  while (windowLines.length < viewport) windowLines.unshift([])
  return windowLines.slice(0, viewport)
}

function buildAttachmentLine(view, columns) {
  const prefix = columns >= 20 ? 'attach ' : 'a '
  const segments = [{ text: truncateRight(prefix, columns), style: 'dim' }]
  let used = displayWidth(segments[0].text)
  if (used >= columns) return segments

  if (view.attachments.length === 0) {
    segments.push({ text: truncateRight('none', columns - used), style: 'dim' })
    return segments
  }

  let index = 0
  while (index < view.attachments.length) {
    const separator = index > 0 ? '  ·  ' : ''
    const remaining = view.attachments.length - index - 1
    const suffix = remaining > 0 ? ` +${remaining}` : ''
    const available = columns - used - displayWidth(separator) - displayWidth(suffix)
    if (available < 4 && index > 0) break
    const name = view.attachments[index]
    const chip = truncateRight(name, Math.max(1, Math.min(28, available)))
    if (!chip) break
    if (index > 0) used += displayWidth(separator)
    segments.push({ text: separator, style: 'dim' }, { text: chip, style: 'plain' })
    used += displayWidth(chip)
    index += 1
    if (used >= columns) break
  }

  const written = index
  if (written < view.attachments.length) {
    const remaining = view.attachments.length - written
    segments.push({ text: truncateRight(` +${remaining}`, columns - used), style: 'dim' })
  }
  return segments
}

/**
 * Sanitise the composer text while keeping a mapping from the caller's cursor
 * index (UTF-16 code units into `view.input`) to the printable display string.
 * Escape sequences disappear; every other control becomes one space, so a
 * cursor that sits inside a stripped sequence snaps to the sequence start.
 */
function mapInputToDisplay(source, rawCursor) {
  let display = ''
  const boundaries = new Array(source.length + 1).fill(0)
  let index = 0

  while (index < source.length) {
    ESCAPE_SEQUENCE_STICKY.lastIndex = index
    const match = ESCAPE_SEQUENCE_STICKY.exec(source)
    if (match) {
      const before = display.length
      for (let offset = 0; offset < match[0].length; offset += 1) boundaries[index + offset] = before
      index += match[0].length
      boundaries[index] = before
      continue
    }

    const start = index
    const char = String.fromCodePoint(source.codePointAt(index))
    index += char.length
    const before = display.length
    for (let offset = start; offset < index; offset += 1) boundaries[offset] = before

    if (char === '\r') {
      if (source[index] === '\n') {
        boundaries[index] = before
        index += 1
      }
      display += '\n'
    } else if (char === '\n') {
      display += '\n'
    } else if (UNSAFE_INPUT_CHAR.test(char)) {
      display += ' '
    } else {
      display += char
    }
    boundaries[index] = display.length
  }
  boundaries[source.length] = display.length

  const clamped = Math.max(0, Math.min(rawCursor, source.length))
  return { display, cursor: boundaries[clamped] === undefined ? display.length : boundaries[clamped] }
}

/** Lay out the composer: hard-wrapped visual lines plus the cursor position. */
function layoutInput(rawInput, rawCursor, columns) {
  const gutterWidth = columns >= 4 ? 2 : 0
  const contentWidth = Math.max(1, columns - gutterWidth)
  const mapped = mapInputToDisplay(rawInput, rawCursor)
  const display = mapped.display
  const lines = []
  let text = ''
  let width = 0
  let lineStart = 0
  let index = 0

  for (const grapheme of splitGraphemes(display)) {
    const start = index
    index += grapheme.length
    if (grapheme === '\n') {
      lines.push({ text, width, start: lineStart, end: start })
      text = ''
      width = 0
      lineStart = index
      continue
    }
    const graphemeW = graphemeWidth(grapheme)
    if (width > 0 && width + graphemeW > contentWidth) {
      lines.push({ text, width, start: lineStart, end: start })
      text = ''
      width = 0
      lineStart = start
    }
    if (width === 0 && graphemeW > contentWidth) {
      const shown = truncateRight(grapheme, contentWidth)
      lines.push({ text: shown, width: displayWidth(shown), start, end: index })
      lineStart = index
      continue
    }
    text += grapheme
    width += graphemeW
  }
  if (text !== '' || lines.length === 0) lines.push({ text, width, start: lineStart, end: display.length })

  const cursorIndex = mapped.cursor
  let cursorLine = lines.length - 1
  let cursorColumn = lines[cursorLine].width

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (cursorIndex < line.start) continue
    if (cursorIndex < line.end) {
      cursorLine = lineIndex
      cursorColumn = displayWidth(display.slice(line.start, cursorIndex))
      break
    }
    if (cursorIndex === line.end) {
      const next = lines[lineIndex + 1]
      if (next && next.start === cursorIndex) {
        cursorLine = lineIndex + 1
        cursorColumn = 0
      } else {
        cursorLine = lineIndex
        cursorColumn = line.width
      }
      break
    }
  }

  return { lines, cursorLine, cursorColumn, gutterWidth, contentWidth }
}

function inputWindow(input, visibleRows) {
  const total = input.lines.length
  const rows = Math.max(0, Math.min(visibleRows, total))
  if (rows === 0) return { windowStart: 0, rows: 0 }
  let windowStart = 0
  if (total > rows && input.cursorLine >= rows) {
    windowStart = Math.min(input.cursorLine - rows + 1, total - rows)
  }
  return { windowStart, rows }
}

function buildInputLines(input, allocatedRows) {
  const { windowStart, rows } = inputWindow(input, allocatedRows)
  const lines = []
  for (let offset = 0; offset < rows; offset += 1) {
    const line = input.lines[windowStart + offset]
    const first = windowStart + offset === 0
    const segments = []
    if (input.gutterWidth > 0) {
      segments.push({ text: first ? '> ' : '  ', style: first ? 'accent' : 'plain' })
    }
    segments.push({ text: line ? line.text : '', style: 'plain' })
    lines.push(segments)
  }
  return { lines, windowStart, rows }
}

function allocateLayout(rows, desiredInputRows) {
  if (rows <= 0) {
    return { headerRows: 0, hintRows: 0, attachRows: 0, ruleRows: 0, inputRows: 0, messageRows: 0 }
  }
  if (rows === 1) {
    return { headerRows: 1, hintRows: 0, attachRows: 0, ruleRows: 0, inputRows: 0, messageRows: 0 }
  }

  let headerRows = rows >= 4 ? 2 : 1
  let hintRows = rows >= 9 ? 1 : 0
  let attachRows = rows >= 8 ? 1 : 0
  let ruleRows = rows >= 6 ? 1 : 0
  let inputRows = Math.max(1, Math.min(desiredInputRows, MAX_INPUT_LINES))
  if (rows === 2) {
    hintRows = 0
    attachRows = 0
    ruleRows = 0
    inputRows = 1
  }

  const minimumMessages = rows >= 3 ? 1 : 0
  let messageRows = rows - headerRows - hintRows - attachRows - ruleRows - inputRows
  let guard = 16
  while (messageRows < minimumMessages && guard > 0) {
    guard -= 1
    if (ruleRows > 0) ruleRows = 0
    else if (attachRows > 0) attachRows = 0
    else if (hintRows > 0) hintRows = 0
    else if (inputRows > 1) inputRows -= 1
    else if (headerRows > 1) headerRows = 1
    else break
    messageRows = rows - headerRows - hintRows - attachRows - ruleRows - inputRows
  }
  if (messageRows < 0) messageRows = 0
  return { headerRows, hintRows, attachRows, ruleRows, inputRows, messageRows }
}

// ---------------------------------------------------------------------------
// Layout: modal session selector
// ---------------------------------------------------------------------------

function modalGeometry(modal, columns, maxHeight) {
  const budget = Math.max(0, Math.floor(maxHeight))
  if (budget === 0) return null
  const itemCount = Math.max(1, modal.items.length)
  let bordered = columns >= 14 && budget >= 4
  let chrome = bordered ? 2 : 0
  let queryRows = 1

  while (chrome + queryRows + 1 > budget) {
    if (bordered) {
      bordered = false
      chrome = 0
    } else if (queryRows > 0) {
      queryRows = 0
    } else {
      break
    }
  }

  const needed = chrome + queryRows + itemCount
  const boxHeight = Math.min(budget, needed)
  const itemRows = Math.max(1, boxHeight - chrome - queryRows)
  let boxWidth = bordered ? Math.max(12, Math.min(72, columns - 4)) : columns
  boxWidth = Math.max(1, Math.min(boxWidth, columns))
  const left = bordered ? Math.max(0, Math.floor((columns - boxWidth) / 2)) : 0
  return { bordered, queryRows, itemRows, boxWidth, boxHeight, left }
}

function modalTopBorder(title, boxWidth) {
  const innerWidth = boxWidth - 2
  const segments = [{ text: '┌', style: 'border' }]
  const shown = title ? truncateRight(title, Math.max(0, innerWidth - 3)) : ''
  if (shown) {
    segments.push(
      { text: '─ ', style: 'border' },
      { text: shown, style: 'accent' },
      { text: ' ', style: 'border' },
    )
    const fill = innerWidth - 2 - displayWidth(shown) - 1
    if (fill > 0) segments.push({ text: '─'.repeat(fill), style: 'border' })
  } else {
    segments.push({ text: '─'.repeat(innerWidth), style: 'border' })
  }
  segments.push({ text: '┐', style: 'border' })
  return segments
}

function modalBottomBorder(boxWidth) {
  return [
    { text: '└', style: 'border' },
    { text: '─'.repeat(Math.max(0, boxWidth - 2)), style: 'border' },
    { text: '┘', style: 'border' },
  ]
}

function wrapModalInner(segments, innerWidth, bordered, padStyle = 'plain') {
  const fitted = fitSegments(segments, innerWidth)
  const inner = fitted.segments.slice()
  if (fitted.width < innerWidth) {
    inner.push({ text: ' '.repeat(innerWidth - fitted.width), style: padStyle })
  }
  if (!bordered) return inner
  return [{ text: '│', style: 'border' }, ...inner, { text: '│', style: 'border' }]
}

/**
 * Build the clean selection page used while a modal is open.
 *
 * Unlike the normal frame, a modal hides the transcript/composer entirely:
 * rows 0..topRows-1 keep the ordinary two-line header, the middle region is
 * cleared to blank cells and holds the selector, and the last row is a shortcut
 * hint (the business layer passes `modal.footer` as `view.hint`). The selector
 * starts directly below the header and is never taller than `rows - 3`, so it
 * cannot cover the top bar or the session/model line and leaves no background
 * fragments around its border.
 */
function buildModalPage(modal, columns, rows) {
  const topRows = Math.min(2, Math.max(0, rows))
  const remaining = rows - topRows
  const hintRows = remaining >= 2 ? 1 : 0
  const availableHeight = Math.max(0, remaining - hintRows)
  if (availableHeight === 0) {
    return { topRows, hintRows, availableHeight, entries: [], cursor: null, left: 0 }
  }

  const geometry = modalGeometry(modal, columns, availableHeight)
  const { bordered, queryRows, itemRows, boxWidth, boxHeight, left } = geometry
  const chromeStart = bordered ? 1 : 0
  const innerWidth = bordered ? boxWidth - 2 : boxWidth
  const entries = []
  let rowOffset = 0
  const push = (segments) => {
    entries.push({ row: topRows + rowOffset, segments })
    rowOffset += 1
  }

  if (bordered) push(modalTopBorder(modal.title, boxWidth))

  let cursor = null
  if (queryRows > 0) {
    const prefixWidth = innerWidth >= 12 ? 7 : 0
    const prefix = prefixWidth > 0 ? 'filter ' : ''
    const queryWidth = innerWidth - prefixWidth
    const shownQuery = truncateRight(modal.query, queryWidth)
    const querySegments = []
    if (prefix) querySegments.push({ text: prefix, style: 'dim' })
    if (shownQuery) {
      querySegments.push({ text: shownQuery, style: 'plain' })
    } else {
      const placeholder = truncateRight('type to filter', queryWidth)
      if (placeholder) querySegments.push({ text: placeholder, style: 'dim' })
    }
    push(wrapModalInner(querySegments, innerWidth, bordered))
    const cursorInner = Math.min(prefixWidth + displayWidth(shownQuery), Math.max(0, innerWidth - 1))
    cursor = {
      row: topRows + chromeStart + 1,
      column: left + (bordered ? 1 : 0) + cursorInner + 1,
    }
  }

  const itemCount = modal.items.length
  let first = 0
  if (itemCount > itemRows) {
    first = Math.max(0, Math.min(modal.selected - Math.floor(itemRows / 2), itemCount - itemRows))
  }
  for (let offset = 0; offset < itemRows; offset += 1) {
    const index = first + offset
    const item = index < itemCount ? modal.items[index] : null
    const inner = []
    if (itemCount === 0) {
      inner.push({ text: truncateRight('(no sessions)', innerWidth), style: 'dim' })
      push(wrapModalInner(inner, innerWidth, bordered))
      continue
    }
    if (!item) {
      push(wrapModalInner(inner, innerWidth, bordered))
      continue
    }
    const selected = index === modal.selected
    const marker = selected ? '> ' : '  '
    const available = Math.max(0, innerWidth - 2)
    let labelWidth = available
    let detailWidth = 0
    if (item.detail && available > 8) {
      labelWidth = Math.max(4, Math.min(28, Math.floor(available * 0.55)))
      detailWidth = Math.max(0, available - labelWidth - 2)
    }
    const label = truncateRight(item.label, labelWidth)
    const labelPad = Math.max(0, labelWidth - displayWidth(label))
    const detail = detailWidth > 0 ? truncateRight(item.detail, detailWidth) : ''
    const detailPad = detail ? Math.max(0, detailWidth - displayWidth(detail)) : 0
    inner.push({ text: marker, style: selected ? 'selected' : 'dim' })
    inner.push({ text: `${label}${' '.repeat(labelPad)}`, style: selected ? 'selected' : 'plain' })
    if (detailWidth > 0) {
      inner.push(
        { text: '  ', style: selected ? 'selected' : 'plain' },
        { text: `${detail}${' '.repeat(detailPad)}`, style: selected ? 'selected' : 'dim' },
      )
    }
    push(wrapModalInner(inner, innerWidth, bordered, selected ? 'selected' : 'plain'))
  }

  if (bordered) {
    entries.push({ row: topRows + boxHeight - 1, segments: modalBottomBorder(boxWidth) })
  }

  return { topRows, hintRows, availableHeight, entries, cursor, left }
}

/** Splice the selector onto a cleared middle region (never over base text). */
function overlayModal(lines, page, columns) {
  for (const entry of page.entries) {
    if (entry.row < 0 || entry.row >= lines.length) continue
    const boxWidth = segmentsWidth(entry.segments)
    const leftPad = page.left > 0 ? [{ text: ' '.repeat(page.left), style: 'plain' }] : []
    const rightPadWidth = Math.max(0, columns - page.left - boxWidth)
    const rightPad = rightPadWidth > 0 ? [{ text: ' '.repeat(rightPadWidth), style: 'plain' }] : []
    lines[entry.row] = padSegments([...leftPad, ...entry.segments, ...rightPad], columns)
  }
}

// ---------------------------------------------------------------------------
// Pure frame renderer
// ---------------------------------------------------------------------------

/**
 * Render one complete full-screen frame. No I/O: the returned `output` is the
 * exact string to write in a single call (it starts by hiding the cursor,
 * homes, draws every row, and positions the cursor when `cursor` is non-null).
 *
 * @param {object} view
 * @param {{columns?: number, rows?: number, color?: boolean}} [options]
 * @returns {{output: string, cursor: null | {row: number, column: number}}}
 */
export function renderFrame(view, options = {}) {
  const columns = toDimension(options.columns, 80)
  const rows = toDimension(options.rows, 24)
  const color = options.color === undefined ? false : Boolean(options.color)
  const normalized = normalizeView(view)
  const lines = []
  let cursor = null

  if (normalized.modal) {
    // Clean selection page: never paint the transcript/composer behind the
    // modal. Only the two header rows (fewer on a tiny terminal), a cleared
    // middle holding the selector, and the bottom shortcut hint are drawn.
    const page = buildModalPage(normalized.modal, columns, rows)
    const header = buildHeaderLines(normalized, columns)
    for (let index = 0; index < page.topRows; index += 1) {
      lines.push(header[index] || padSegments([], columns))
    }
    for (let index = 0; index < page.availableHeight; index += 1) {
      lines.push(padSegments([], columns))
    }
    if (page.hintRows > 0) {
      const hint = normalized.modal.footer || normalized.hint || DEFAULT_HINT
      lines.push(padSegments([{ text: truncateRight(hint, columns), style: 'hint' }], columns))
    }
    overlayModal(lines, page, columns)
    cursor = page.cursor
  } else {
    const input = layoutInput(normalized.input, normalized.inputCursor, columns)
    const desiredInputRows = Math.min(MAX_INPUT_LINES, input.lines.length)
    const allocation = allocateLayout(rows, desiredInputRows)

    const header = buildHeaderLines(normalized, columns)
    for (let index = 0; index < allocation.headerRows; index += 1) {
      lines.push(header[index] || padSegments([], columns))
    }

    const messageViewport = buildMessageViewport(
      normalized.messages,
      columns,
      allocation.messageRows,
      normalized.scrollOffset,
    )
    for (const messageLine of messageViewport) lines.push(padSegments(messageLine, columns))

    if (allocation.ruleRows > 0) {
      lines.push(padSegments([{ text: '─'.repeat(columns), style: 'border' }], columns))
    }
    if (allocation.attachRows > 0) {
      lines.push(padSegments(buildAttachmentLine(normalized, columns), columns))
    }

    const inputLines = buildInputLines(input, allocation.inputRows)
    for (const inputLine of inputLines.lines) lines.push(padSegments(inputLine, columns))

    if (allocation.hintRows > 0) {
      const hint = normalized.hint || DEFAULT_HINT
      lines.push(padSegments([{ text: truncateRight(hint, columns), style: 'hint' }], columns))
    }

    if (allocation.inputRows > 0 && inputLines.rows > 0) {
      const cursorRowInWindow = input.cursorLine - inputLines.windowStart
      if (cursorRowInWindow >= 0 && cursorRowInWindow < inputLines.rows) {
        const inputTop = allocation.headerRows + allocation.messageRows + allocation.ruleRows + allocation.attachRows
        const row = inputTop + cursorRowInWindow + 1
        const column = Math.max(1, Math.min(columns, input.gutterWidth + input.cursorColumn + 1))
        cursor = { row, column }
      }
    }
  }

  // Defensive: the allocation guarantees this, but a malformed view must never
  // be allowed to scroll the alternate screen by emitting the wrong row count.
  while (lines.length < rows) lines.push(padSegments([], columns))
  if (lines.length > rows) lines.length = rows

  const body = lines.map((line) => segmentsToAnsi(padSegments(line, columns), color)).join('\r\n')
  // Hide first (every frame starts hidden so a stale visible cursor never
  // flickers at the old position), then position and explicitly show it. When
  // there is no editable cursor (tiny modal without a query row) it stays
  // hidden for the whole frame.
  const cursorSequence = cursor
    ? `\x1b[${cursor.row};${cursor.column}H${SHOW_CURSOR}`
    : ''
  const output = `${HIDE_CURSOR}${CURSOR_HOME}${body}${cursorSequence}`
  return { output, cursor }
}

// ---------------------------------------------------------------------------
// Stateful terminal wrapper
// ---------------------------------------------------------------------------

// readline keeps its decoder in symbol-keyed stream state and hangs its data
// listeners off the input. Remember exactly what emitKeypressEvents() added so
// stop() can remove only those, never a listener that existed before start().
const READLINE_EVENT_NAMES = ['data', 'newListener', 'end']

function readlineSymbol(stream, description) {
  if (!stream || typeof stream !== 'object') return null
  for (const symbol of Object.getOwnPropertySymbols(stream)) {
    if (symbol.description === description) return symbol
  }
  return null
}

function hasReadlineDecoder(stream) {
  return readlineSymbol(stream, 'keypress-decoder') !== null || readlineSymbol(stream, 'escape-decoder') !== null
}

function dropReadlineDecoder(stream) {
  for (const description of ['keypress-decoder', 'escape-decoder']) {
    const symbol = readlineSymbol(stream, description)
    if (symbol === null) continue
    try {
      delete stream[symbol]
    } catch {
      // Some stream doubles freeze their symbol table; nothing else to do.
    }
  }
}

function snapshotStreamListeners(stream) {
  const snapshot = new Map()
  if (!stream || typeof stream.listeners !== 'function') return snapshot
  for (const event of READLINE_EVENT_NAMES) {
    let listeners = []
    try {
      listeners = stream.listeners(event)
    } catch {
      listeners = []
    }
    snapshot.set(event, new Set(listeners))
  }
  return snapshot
}

function collectAddedListeners(stream, snapshot) {
  const added = []
  if (!stream || typeof stream.listeners !== 'function') return added
  for (const event of READLINE_EVENT_NAMES) {
    let listeners = []
    try {
      listeners = stream.listeners(event)
    } catch {
      listeners = []
    }
    const before = snapshot.get(event) || new Set()
    for (const listener of listeners) {
      if (!before.has(listener)) added.push({ event, listener })
    }
  }
  return added
}

/**
 * Own the real terminal around the pure renderer.
 *
 * @param {object} [options]
 * @param {NodeJS.ReadStream} [options.input]
 * @param {NodeJS.WriteStream} [options.output]
 * @param {(str: string, key: object) => void} [options.onKey]
 * @param {(size: {columns: number, rows: number}) => void} [options.onResize]
 * @returns {{start: () => object, render: (view: object) => null | {output: string, cursor: object|null}, stop: () => boolean}}
 */
export function createScreen({
  input = process.stdin,
  output = process.stdout,
  onKey,
  onResize,
} = {}) {
  let started = false
  let keypressHandler = null
  let resizeHandler = null
  let processResizeHandler = null
  let pasteBuffer = null
  let savedRawMode = null
  let rawModeManaged = false
  let readlineDecoderManaged = false
  let readlineAddedListeners = []
  const resizeSources = new Set()

  const write = (chunk) => {
    try {
      if (output && typeof output.write === 'function') output.write(chunk)
    } catch {
      // A closed terminal is not actionable here; leave the business layer to
      // notice its own stream errors.
    }
  }

  const readSize = () => ({
    columns: toDimension(output && output.columns, 80),
    rows: toDimension(output && output.rows, 24),
  })

  const detectColor = () => {
    if (!output || output.isTTY !== true) return false
    if (process.env.NO_COLOR !== undefined) return false
    if (process.env.TERM === 'dumb') return false
    return true
  }

  const handleResize = () => {
    if (typeof onResize !== 'function') return
    onResize(readSize())
  }

  const start = () => {
    if (started) return api
    started = true

    // Remember whether stdin was already raw so stop() restores the exact
    // previous value instead of always forcing cooked mode. If raw mode was
    // already on (the caller or a former screen owns it), it stays on.
    if (input && input.isTTY === true && typeof input.setRawMode === 'function') {
      savedRawMode = input.isRaw === true
      try {
        input.setRawMode(true)
        rawModeManaged = true
      } catch {
        rawModeManaged = false
      }
    } else {
      savedRawMode = null
      rawModeManaged = false
    }

    write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}${CURSOR_HOME}${ENABLE_BRACKETED_PASTE}`)

    // readline decodes bracketed paste as `paste-start` / payload keypresses /
    // `paste-end`. The business layer handles one `{ name: 'paste' }` event so
    // a pasted newline can never be mistaken for an Enter press; reassemble the
    // payload here (readline keeps the chunks) and forward it once.
    keypressHandler = (str, key) => {
      const name = key && typeof key.name === 'string' ? key.name : ''
      if (name === 'paste-start') {
        pasteBuffer = []
        return
      }
      if (pasteBuffer !== null) {
        if (name === 'paste-end') {
          const payload = pasteBuffer.join('')
          pasteBuffer = null
          if (typeof onKey === 'function') {
            onKey(payload, {
              name: 'paste',
              sequence: `\x1b[200~${payload}\x1b[201~`,
              bracketed: true,
            })
          }
          return
        }
        if (typeof str === 'string') pasteBuffer.push(str)
        return
      }
      if (name === 'paste' && typeof str === 'string') {
        if (typeof onKey === 'function') onKey(str, key)
        return
      }
      if (typeof onKey === 'function') onKey(str, key)
    }
    if (input && typeof input.on === 'function') {
      input.on('keypress', keypressHandler)
      const listenerSnapshot = snapshotStreamListeners(input)
      readlineDecoderManaged = !hasReadlineDecoder(input)
      try {
        emitKeypressEvents(input)
      } catch {
        // Some stream doubles are EventEmitters but not readable; the keypress
        // listener is still installed for callers that emit keypress directly.
      }
      readlineAddedListeners = readlineDecoderManaged
        ? collectAddedListeners(input, listenerSnapshot)
        : []
    }

    resizeHandler = () => handleResize()
    if (output && typeof output.on === 'function') {
      output.on('resize', resizeHandler)
      resizeSources.add(output)
    }
    if (input && input !== output && typeof input.on === 'function') {
      input.on('resize', resizeHandler)
      resizeSources.add(input)
    }

    processResizeHandler = () => handleResize()
    if (typeof process.on === 'function') process.on('SIGWINCH', processResizeHandler)

    return api
  }

  const render = (view) => {
    if (!started) return null
    const size = readSize()
    const frame = renderFrame(view, { columns: size.columns, rows: size.rows, color: detectColor() })
    write(frame.output)
    return frame
  }

  const stop = () => {
    if (!started) return false
    started = false

    write(`${RESET}${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${EXIT_ALT_SCREEN}`)

    if (rawModeManaged && input && typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(savedRawMode === true)
      } catch {
        // Already restored or closed.
      }
    }
    rawModeManaged = false
    savedRawMode = null

    if (keypressHandler && input && typeof input.removeListener === 'function') {
      input.removeListener('keypress', keypressHandler)
    }
    keypressHandler = null
    pasteBuffer = null

    // Remove only the `data` / `newListener` / `end` listeners that
    // emitKeypressEvents() installed. A `data` listener left on stdin can keep
    // the process alive after the screen is gone; pre-existing listeners are
    // deliberately untouched.
    if (input && typeof input.removeListener === 'function') {
      for (const entry of readlineAddedListeners) {
        input.removeListener(entry.event, entry.listener)
      }
    }
    readlineAddedListeners = []
    if (readlineDecoderManaged && input) dropReadlineDecoder(input)
    readlineDecoderManaged = false

    if (resizeHandler) {
      for (const source of resizeSources) {
        if (source && typeof source.removeListener === 'function') {
          source.removeListener('resize', resizeHandler)
        }
      }
      resizeSources.clear()
      resizeHandler = null
    }

    if (processResizeHandler && typeof process.removeListener === 'function') {
      process.removeListener('SIGWINCH', processResizeHandler)
    }
    processResizeHandler = null
    return true
  }

  const api = { start, render, stop }
  return api
}
