/**
 * dsh-tui.mjs - the full-screen TUI business layer for `dsh-ask`.
 *
 * This module owns everything except drawing: session switching, one draft /
 * attachment batch / history / cwd per Session, key handling, modals, slash
 * commands, and the streaming turn. It never writes to stdout while the screen
 * is running; text reaches the user only through the `view` it renders.
 *
 * The renderer is a separate module with a fixed interface:
 *
 *   createScreen({ input, output, onKey(str, key), onResize, onError(message) })
 *     -> { start(), render(view), stop() }
 *
 * The default renderer is the native Rust UI (`dsh-native-screen.mjs`), which
 * owns raw mode, the alternate screen and stdin; in that case this module never
 * touches the terminal and `onError` reports a dead child so the CLI can exit
 * instead of hanging. `ownsTerminal: true` on the returned screen tells the
 * cleanup path not to pause stdin behind the child's back.
 *
 * `view` is exactly:
 *
 *   {
 *     project, cwd, sessionTitle, sessionId, model,
 *     status,                                  // 'ready' | 'waiting' | 'streaming' | ...
 *     messages: [{ role, text }],              // role: 'user' | 'assistant' | 'system' | 'error'
 *     input, inputCursor,                      // inputCursor is a UTF-16 index into input
 *     attachments: [{ name }],                 // pending attachments for the next turn
 *     hint,                                    // one contextual line
 *     scrollOffset,                            // 0 = pinned to the newest message
 *     modal: null | {
 *       kind,                         // 'commands' | 'sessions' | 'help' |
 *                                     // 'permissions' | 'permission-confirm' |
 *                                     // 'permission-confirm-2' | 'approvals' |
 *                                     // 'question-detail' | 'question-answer' |
 *                                     // 'question-input' | 'answer-confirm' |
 *                                     // 'approval-claim-confirm' |
 *                                     // 'approval-release-confirm' |
 *                                     // 'approval-request-detail' |
 *                                     // 'approval-confirm'
 *       title, items: [{ label, detail }], selected, query, footer,
 *     },
 *   }
 *
 * `modal.kind` is the only addition to the old view: 'commands' is the inline
 * slash-command popup glued above the composer (composer stays visible and
 * editable), 'sessions' is the full resume/session picker and 'help' the
 * shortcuts overlay. Every other kind is a read-only or selection page (title,
 * wrapped rows, footer); a renderer without kind support treats it as
 * 'sessions'. `query` carries search text for 'sessions' and the typed custom
 * answer for 'question-input'. Modal `items` are already filtered by `query`,
 * so `selected` always indexes the list the renderer shows. `onKey(str, key)`
 * is called once per key; this module returns a promise from it and also
 * serializes all handling, so a fast typist can never interleave two state
 * transitions.
 *
 * `view.ui` (from `nativeUiLabels(lang)`) carries the language-dependent
 * literals the native renderer draws itself (placeholder, empty list,
 * back-to-bottom variants, fallback modal titles). It is an ordinary
 * enumerable field, rebuilt on every frame, so `JSON.stringify(view)` (and the
 * oversized-frame fallback in `dsh-native-screen.mjs`) always carries it.
 *
 * Language: `runTui` resolves it once from `options.lang` via
 * `dsh-i18n.mjs:resolveLanguage` (the CLI has already resolved `--lang` /
 * `DSH_ASK_LANG` / the locale). Only text this tool owns comes from
 * `dsh-tui-messages.mjs`; Host data and user/model text are never rewritten.
 *
 * The `adapter` argument is supplied by the CLI and wraps the already-tested
 * bridge calls. It is the only way this module talks to the Host:
 *
 *   {
 *     endpoint, pid, images,                  // images = Host image capabilities, undefined = unsupported
 *     listSessions(limit)             -> rows  [{ sessionId, title, preview, blank, running, updatedAt, cwd }]
 *     fetchTranscript(id, limit)      -> payload { ok, sessionId, running, items, more }
 *     newConversationForDirectory(cwd) -> { sessionId, workspace? }   // current directory, ignores -w
 *     newConversationWithOptions(cwd)  -> { sessionId, workspace? }   // honours -w, like the old picker
 *     ask(body, { signal, onFrame })   -> payload                      // streaming; onFrame gets every frame
 *     askBlocking(body, { signal })    -> payload                      // --no-stream
 *     fetchQueue(id)                   -> { running, items }
 *     fetchStatus(id)                  -> { ok, sessionId, status }   // whitelisted status
 *     mutateQueue(id, itemId, action, text) -> payload
 *     listWorkspaces()                 -> rows [{ id, title, path, sessions }]
 *     loadPaths(text, cwd)             -> images [{ mediaType, data, name }]
 *     loadClipboard()                  -> image
 *     validateBatch(images)            -> images    // throws a user-facing message on Host limits
 *     fetchPermissions(id)             -> { ok, sessionId, permission:{currentValue,label,options,defaultPreset}, canSet }
 *     submitPermission({sessionId, preset, confirmed}) -> { ok, sessionId, preset, matched, text }
 *     fetchAwaiting(id)                -> { ok, sessionId, running, pendingInput, questions:{active,settledCount}, approvals, answerable }
 *     submitAnswer({sessionId, callId, answers}) -> { ok, sessionId, callId, accepted }
 *     fetchApprovalChannel(claimId?)   -> { ok, claim, connected, pendingCount, maxPending, pending }
 *     claimApprovalChannel({sessionId, leaseMs?}) -> { ok, claimId, sessionId, expiresAt, leaseMs }  // adapter starts heartbeat
 *     heartbeatApprovalChannel({claimId}) -> { ok, claimId, expiresAt, leaseMs }
 *     releaseApprovalChannel({claimId, reason?}) -> { ok, released, delegated } // stops adapter heartbeat
 *     submitApprovalDecision({claimId, requestId, outcome}) -> { ok, claimId, requestId, outcome, submittedAt, final:false, note }
 *   }
 *
 * The last four are optional: a missing method means an older CLI/Host and the
 * TUI degrades with an explicit message. Approvals and `open` questions have no
 * host-side answer API in the targeted Harness build; the TUI only reports them
 * as desktop-only and never fabricates a decision. `submitPermission` and
 * `submitAnswer` are additionally exposed through F3/F2 so a pending decision
 * can be opened without touching (or losing) the composer draft/attachments.
 *
 * Trust model: titles, paths, tool names, tool arguments and attachment names
 * are untrusted text from the Host. Everything that reaches the view is stripped
 * of terminal control sequences here instead of trusting the renderer.
 */

import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'

import { formatBytes, sanitizeTerminalText } from './dsh-media.mjs'
import { DEFAULT_LANGUAGE, createTranslator, nativeUiLabels, resolveLanguage } from './dsh-i18n.mjs'
import { TUI_CATALOG } from './dsh-tui-messages.mjs'

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const MODEL_UNKNOWN = 'unknown'

// Every user-visible basic-flow string lives in `dsh-tui-messages.mjs` and is
// translated at render time inside `runTui`. Only text this tool owns is in
// the catalog: Host titles, paths, session ids, model output, user messages and
// question/approval options are never rewritten (no global string replacement
// is ever applied to `view.messages`).

/** A zh translator, so module-level helpers keep the pre-i18n behaviour. */
const defaultTranslator = () => createTranslator(DEFAULT_LANGUAGE, TUI_CATALOG)

/** Remove OSC/DCS/CSI and stray ESC sequences while keeping \n and \t. */
function stripEscapes(value) {
  let text = typeof value === 'string' ? value : value == null ? '' : String(value)
  text = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  return text
}

/** One-line, bounded label for a view field. */
function oneLine(value, max = 200) {
  return sanitizeTerminalText(value, { max })
}

const firstLine = (text, limit = 100) => {
  const line = String(text ?? '')
    .split('\n')[0]
    .trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

const shortId = (sessionId) => String(sessionId ?? '').slice(0, 17)

function imageBytes(image) {
  return Buffer.from(String(image?.data ?? ''), 'base64').length
}

function imageKind(mediaType) {
  const type = String(mediaType ?? '')
  if (type === 'image/png') return 'PNG'
  if (type === 'image/jpeg') return 'JPEG'
  if (type === 'image/gif') return 'GIF'
  if (type === 'image/webp') return 'WebP'
  return type === '' ? 'image' : type
}

function imageName(image) {
  return oneLine(image?.name ?? 'image', 120) || 'image'
}

function imageSummary(image) {
  return `${imageName(image)} (${imageKind(image?.mediaType)}, ${formatBytes(imageBytes(image))})`
}

function argSummary(raw) {
  let value = raw
  try {
    const args = JSON.parse(raw || '{}')
    const picked =
      args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.name ?? ''
    value = typeof picked === 'string' ? picked : JSON.stringify(picked)
  } catch {
    value = String(raw ?? '')
  }
  return firstLine(value, 70)
}

// ---------------------------------------------------------------------------
// Permission / pending-answer helpers
// ---------------------------------------------------------------------------

/** Presets the Host treats as "ask explicitly again" (spec §2, CONFIRMED_PRESETS). */
const CONFIRMED_PRESETS = new Set(['danger-full-access', 'auto'])

/** Max free-text answer the bridge accepts (spec §5 ANSWER_TEXT_MAX). */
const ANSWER_TEXT_MAX = 512

/** How many times a page scrolls the selection; wheel/PageUp also work. */
/**
 * Display width of one code point, matching the native renderer closely enough
 * for wrapping (unicode-width: CJK/emoji are 2 columns, combining marks 0).
 * @param {string} point
 * @returns {number}
 */
function codePointWidth(point) {
  const code = point.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (code >= 0x300 && code <= 0x36f) return 0 // combining marks
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Display columns of one already-sanitised line. */
function displayColumns(text) {
  const value = String(text ?? '')
  let columns = 0
  for (const point of value) columns += codePointWidth(point)
  return columns
}

/**
 * Hard-wrap one paragraph by display columns without losing characters. Tabs
 * become two spaces; a single code point wider than the budget still fits on
 * its own line instead of being dropped.
 * @param {string} paragraph
 * @param {number} width
 * @returns {string[]}
 */
function wrapParagraph(paragraph, width) {
  const budget = Math.max(8, Math.floor(Number(width) || 80))
  const text = String(paragraph ?? '').replace(/\t/g, '  ')
  if (text === '') return ['']
  const lines = []
  let line = ''
  let columns = 0
  for (const point of text) {
    const pointWidth = codePointWidth(point)
    if (line !== '' && columns + pointWidth > budget) {
      lines.push(line)
      line = ''
      columns = 0
    }
    line += point
    columns += pointWidth
  }
  lines.push(line)
  return lines
}

/**
 * Wrap a multi-line block for the native page: every explicit newline is kept
 * as a row boundary and long rows are hard-wrapped by display width. Nothing is
 * truncated, so a long tool/argument/question detail stays readable by scrolling
 * the selection.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrapBlock(text, width) {
  const blocks = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const lines = []
  for (const block of blocks) {
    lines.push(...wrapParagraph(block, width))
  }
  return lines
}

/** Adapter/tool errors carry their machine code; never infer one from prose. */
function errorCodeOf(error) {
  const payload = error?.payload ?? error
  const code = payload?.code ?? error?.code
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : ''
}

/** User-facing message of a thrown adapter error. */
function errorMessageOf(error) {
  if (error?.payload?.error !== undefined) return String(error.payload.error)
  if (error?.message !== undefined) return String(error.message)
  return String(error ?? 'unknown error')
}

/** Build an adapter-shaped error for a payload the adapter returned instead of throwing. */
function adapterPayloadError(payload, fallbackCode = 'unknown-error') {
  const error = new Error(String(payload?.error ?? payload?.message ?? 'request failed'))
  error.code = typeof payload?.code === 'string' && payload.code !== '' ? payload.code : fallbackCode
  error.payload = payload
  return error
}

/** Turn a `{ok:false}` payload into a throw; `ok:true` payloads pass through. */
function requireOk(payload, fallbackCode) {
  if (payload === null || typeof payload !== 'object') {
    throw adapterPayloadError({ error: 'Host returned an unexpected payload', code: 'schema-invalid' })
  }
  if (payload.ok === false) throw adapterPayloadError(payload, fallbackCode)
  return payload
}

/** One line of a Host question/option/detail, safe for the view. */
function safeText(value, max = 4000) {
  return oneLine(stripEscapes(String(value ?? '')), max)
}

function shortCallId(value) {
  const text = stripEscapes(String(value ?? ''))
  return text.length <= 17 ? text : `${text.slice(0, 17)}…`
}

function normalizePath(value) {
  const text = String(value ?? '')
  let expanded = text
  if (text === '~') expanded = homedir()
  else if (text.startsWith('~/')) expanded = resolve(homedir(), text.slice(2))
  const absolute = resolve(expanded)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function basenameOf(directory) {
  const text = String(directory ?? '').replace(/[\\/]+$/, '')
  return text === '' ? '' : basename(text)
}

/** The workspace registered for exactly this directory, by normalized path. */
function workspaceFor(workspaces, directory) {
  const wanted = normalizePath(directory)
  return workspaces.find(
    (workspace) =>
      typeof workspace?.path === 'string' &&
      workspace.path !== '' &&
      normalizePath(workspace.path) === wanted,
  )
}

// ---------------------------------------------------------------------------
// Cursor helpers: UTF-16 indices that never land inside a surrogate pair
// ---------------------------------------------------------------------------

function previousBoundary(text, index) {
  if (index <= 0) return 0
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return index - 2
  }
  return index - 1
}

function nextBoundary(text, index) {
  if (index >= text.length) return text.length
  const high = text.charCodeAt(index)
  if (high >= 0xd800 && high <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return index + 2
  }
  return index + 1
}

function lineStartOf(text, index) {
  const found = text.lastIndexOf('\n', index - 1)
  return found < 0 ? 0 : found + 1
}

function lineEndOf(text, index) {
  const found = text.indexOf('\n', index)
  return found < 0 ? text.length : found
}

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------
// The renderer decodes the terminal and calls onKey(str, key). The exact key
// names are the renderer's business, so this module accepts the common spellings
// and, when `key` is missing or unknown, derives control keys from `str` as a
// safety net. Printable input always arrives as text.

const KEY_ALIASES = new Map([
  ['return', 'enter'],
  ['cr', 'enter'],
  ['ent', 'enter'],
  ['esc', 'escape'],
  ['bs', 'backspace'],
  ['back', 'backspace'],
  ['del', 'delete'],
  ['arrowup', 'up'],
  ['uparrow', 'up'],
  ['arrowdown', 'down'],
  ['downarrow', 'down'],
  ['arrowleft', 'left'],
  ['leftarrow', 'left'],
  ['arrowright', 'right'],
  ['rightarrow', 'right'],
  ['pgup', 'pageup'],
  ['prior', 'pageup'],
  ['page-up', 'pageup'],
  ['pgdn', 'pagedown'],
  ['next', 'pagedown'],
  ['page-down', 'pagedown'],
  ['tab', 'tab'],
  ['space', 'space'],
])

function canonicalKey(raw) {
  let name = String(raw).trim().toLowerCase()
  if (name === '') return ''
  name = name.replace(/\s+/g, '').replace(/[+_]/g, '-').replace(/^ctrl-?/, 'ctrl-')
  if (KEY_ALIASES.has(name)) return KEY_ALIASES.get(name)
  // "arrow-up" / "up-arrow"
  const arrow = name.match(/^(?:arrow-)?(up|down|left|right)(?:-arrow)?$/)
  if (arrow !== null) return arrow[1]
  // f1 .. f12
  if (/^f([1-9]|1[0-2])$/.test(name)) return name
  // ctrl-<letter>, caret form, c-<letter>, control-<letter>
  let control = name.match(/^(?:ctrl|control|c|-|\^)([a-z])$/)
  if (control !== null) return `ctrl-${control[1]}`
  control = name.match(/^(?:ctrl|control|c)-([a-z])$/)
  if (control !== null) return `ctrl-${control[1]}`
  // alt/meta/option + key
  const alt = name.match(/^(?:alt|meta|option|m)-(.+)$/)
  if (alt !== null) {
    const inner = alt[1]
    if (inner === 'enter' || inner === 'return' || inner === 'cr') return 'alt-enter'
    if (inner === 'up' || inner === 'down' || inner === 'left' || inner === 'right') return `alt-${inner}`
    return `alt-${inner}`
  }
  const shift = name.match(/^shift-(.+)$/)
  if (shift !== null) {
    const inner = shift[1]
    if (inner === 'enter' || inner === 'return') return 'shift-enter'
    if (inner === 'tab') return 'shift-tab'
    return `shift-${inner}`
  }
  if (name === 'paste' || name === 'bracketed-paste' || name === 'bracketedpaste') return 'paste'
  if (name === 'insert') return 'insert'
  if (name === 'end') return 'end'
  if (name === 'home') return 'home'
  return name
}

function keyFromObject(key) {
  const name = key.name ?? key.key ?? key.id ?? key.code
  if (typeof name !== 'string' || name === '') return ''
  if (name.length === 1 && /[a-z]/i.test(name)) {
    if (key.ctrl === true) return `ctrl-${name.toLowerCase()}`
    if (key.meta === true || key.alt === true) return `alt-${name.toLowerCase()}`
    return name
  }
  const canonical = canonicalKey(name)
  if (key.ctrl === true && canonical.startsWith('ctrl-') === false) return `ctrl-${canonical}`
  if ((key.meta === true || key.alt === true) && canonical.startsWith('alt-') === false) {
    if (canonical === 'enter') return 'alt-enter'
    return `alt-${canonical}`
  }
  if (key.shift === true && canonical === 'enter') return 'shift-enter'
  if (key.shift === true && canonical === 'tab') return 'shift-tab'
  return canonical
}

const CONTROL_KEYS = new Map([
  ['\x00', 'ctrl-space'],
  ['\x01', 'ctrl-a'],
  ['\x03', 'ctrl-c'],
  ['\x04', 'ctrl-d'],
  ['\x05', 'ctrl-e'],
  ['\x0b', 'ctrl-k'],
  ['\x0c', 'ctrl-l'],
  ['\x0e', 'ctrl-n'],
  ['\x10', 'ctrl-p'],
  ['\x11', 'ctrl-q'],
  ['\x15', 'ctrl-u'],
  ['\x16', 'ctrl-v'],
  ['\x17', 'ctrl-w'],
  ['\x08', 'backspace'],
  ['\x7f', 'backspace'],
  ['\t', 'tab'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\x1b', 'escape'],
])

function keyFromString(str) {
  if (typeof str !== 'string' || str === '') return null
  if (CONTROL_KEYS.has(str)) return CONTROL_KEYS.get(str)
  // Alt+Enter is ESC followed by CR/LF.
  if (str === '\x1b\r' || str === '\x1b\n') return 'alt-enter'
  const csi = str.match(/^\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])$/)
  if (csi !== null) {
    const [, number, modifier, final] = csi
    if (final === 'A') return 'up'
    if (final === 'B') return 'down'
    if (final === 'C') return 'right'
    if (final === 'D') return 'left'
    if (final === 'H') return 'home'
    if (final === 'F') return 'end'
    if (final === 'Z') return 'shift-tab'
    if (final === '~') {
      const code = Number(number)
      if (code === 1 || code === 7) return 'home'
      if (code === 4 || code === 8) return 'end'
      if (code === 5) return 'pageup'
      if (code === 6) return 'pagedown'
      if (code === 2) return 'insert'
      if (code === 3) return 'delete'
      if (code >= 11 && code <= 24) return `f${code - 10}`
      return null
    }
    if (final === 'P' || final === 'Q' || final === 'R' || final === 'S') {
      // F1-F4 with a modifier still mean F1-F4.
      const index = { P: 1, Q: 2, R: 3, S: 4 }[final]
      return `f${index}`
    }
    void modifier
    return null
  }
  const ss3 = str.match(/^\x1bO([A-Za-z])$/)
  if (ss3 !== null) {
    const final = ss3[1]
    if (final === 'A') return 'up'
    if (final === 'B') return 'down'
    if (final === 'C') return 'right'
    if (final === 'D') return 'left'
    if (final === 'H') return 'home'
    if (final === 'F') return 'end'
    if (final === 'P') return 'f1'
    if (final === 'Q') return 'f2'
    if (final === 'R') return 'f3'
    if (final === 'S') return 'f4'
  }
  return null
}

/** Text that may be inserted into the draft (keeps newlines and tabs). */
function insertableText(value) {
  return stripEscapes(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function normalizeKeyEvent(str, key) {
  let name = ''
  if (typeof key === 'string' && key !== '') name = canonicalKey(key)
  else if (key !== null && typeof key === 'object') name = keyFromObject(key)
  const rawText = typeof str === 'string' ? str : ''
  if (name !== '') {
    if (name === 'text' || name === 'char' || name === 'insert-text') {
      return { name: 'text', text: insertableText(rawText) }
    }
    // A paste carries its payload in `str`; it is inserted verbatim (newlines
    // included) and must never be mistaken for an Enter press.
    if (name === 'paste') return { name: 'paste', text: insertableText(rawText) }
    // Node's readline reports an ordinary printable key as { name: 'h' }, so a
    // one-character name is content, not a command.
    if (name.length === 1) {
      const text = insertableText(rawText !== '' ? rawText : name)
      return text === '' ? null : { name: 'text', text }
    }
    if (name === 'space') {
      const text = insertableText(rawText !== '' ? rawText : ' ')
      return text === '' ? null : { name: 'text', text }
    }
    return { name, text: '' }
  }
  const derived = keyFromString(typeof str === 'string' ? str : '')
  if (derived !== null) return { name: derived, text: '' }
  if (typeof str !== 'string' || str === '') return null
  const text = insertableText(str)
  return { name: 'text', text }
}

// ---------------------------------------------------------------------------
// Eligibility and renderer resolution
// ---------------------------------------------------------------------------

/**
 * The full-screen TUI is the default only on a real terminal. Piped input,
 * `--json` and `TERM=dumb` keep the line-based behaviour, and `--plain` (or
 * DSH_ASK_PLAIN=1) opts out explicitly.
 */
export function tuiEligible({ json, plain, stdin, stdout, env } = {}) {
  if (json === true || plain === true) return false
  const environment = env ?? process.env
  if (environment.TERM === 'dumb') return false
  if (String(environment.DSH_ASK_PLAIN ?? '') === '1') return false
  const input = stdin ?? process.stdin
  const output = stdout ?? process.stdout
  if (input?.isTTY !== true) return false
  if (output?.isTTY !== true) return false
  return true
}

/**
 * The default renderer is the native Rust UI. Missing binary is a hard,
 * explicit failure that the CLI turns into the line-based `--plain` path; the
 * old in-process renderer is never used silently as a fallback.
 */
export async function resolveScreenFactory() {
  const module = await import('./dsh-native-screen.mjs')
  const create = module.createScreen ?? module.default
  if (typeof create !== 'function') {
    throw new Error('dsh-native-screen.mjs must export createScreen({ input, output, onKey, onResize })')
  }
  const binary = typeof module.resolveNativeBinary === 'function' ? module.resolveNativeBinary() : null
  if (binary === null) {
    const message =
      typeof module.nativeUnavailableMessage === 'function'
        ? module.nativeUnavailableMessage()
        : 'native dsh-ask-ui binary not found'
    const error = new Error(message)
    error.name = 'NativeScreenUnavailable'
    error.code = 'native-ui-unavailable'
    throw error
  }
  return create
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// `[name, catalogKey]`: the command name is a protocol token and is never
// translated; the description comes from the catalog at render time.
const COMMANDS = [
  ['/resume', 'cmd.resume'],
  ['/new', 'cmd.new'],
  ['/quit', 'cmd.quit'],
  ['/help', 'cmd.help'],
  ['/status', 'cmd.status'],
  ['/permissions', 'cmd.permissions'],
  ['/approvals', 'cmd.approvals'],
  ['/history', 'cmd.history'],
  ['/clear', 'cmd.clear'],
  ['/attach', 'cmd.attach'],
  ['/paste', 'cmd.paste'],
  ['/attachments', 'cmd.attachments'],
  ['/detach', 'cmd.detach'],
  ['/preview', 'cmd.preview'],
  ['/send', 'cmd.send'],
  ['/pending', 'cmd.pending'],
  ['/id', 'cmd.id'],
]

// Aliases stay usable but are not advertised in the popup, exactly like Codex
// hides `quit`/`btw` aliases. The first entry is the primary name.
const COMMAND_ALIASES = new Map([
  ['/sessions', '/resume'],
  ['/switch', '/resume'],
  ['/exit', '/quit'],
  ['/queue', '/pending'],
  ['/permission', '/permissions'],
  ['/awaiting', '/approvals'],
  ['/multiline', '/help'],
  ['/end', '/help'],
])

const COMMAND_WORDS = [
  ...new Set([
    ...COMMANDS.map(([name]) => name),
    ...COMMAND_ALIASES.keys(),
    '/edit',
    '/drop',
    '/steer',
  ]),
]

// `[keyLabel, catalogKey]`: the key names are physical keys and stay as they
// are; only the explanation is translated.
const HELP_KEYS = [
  ['Enter', 'key.enter'],
  ['/', 'key.slash'],
  ['?', 'key.question'],
  ['Tab', 'key.tab'],
  ['↑ ↓', 'key.arrows'],
  ['Alt+Enter / Ctrl+J', 'key.altEnter'],
  ['← → Home End', 'key.move'],
  ['Backspace / Delete', 'key.backspace'],
  ['Ctrl+U / Ctrl+K', 'key.killLine'],
  ['Esc', 'key.escape'],
  ['Ctrl+C', 'key.ctrlC'],
  ['Ctrl+V', 'key.ctrlV'],
  ['Ctrl+L', 'key.ctrlL'],
  ['PgUp / PgDn', 'key.page'],
  ['Ctrl+P / Ctrl+N', 'key.ctrlPN'],
  ['F1', 'key.f1'],
  ['F2', 'key.f2'],
  ['F3', 'key.f3'],
  ['Ctrl+Q', 'key.ctrlQ'],
]

function helpModalItems(t = defaultTranslator()) {
  const rows = (entries) => entries.map(([label, key]) => ({ label, detail: t(key) }))
  return [...rows(HELP_KEYS), ...rows(COMMANDS)]
}

/** Codex-style subsequence match: `/mdl` finds `/model`, `/res` finds `/resume`. */
function isSubsequence(needle, haystack) {
  if (needle === '') return true
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index >= needle.length) return true
  }
  return false
}

/**
 * Filter the slash-command list for the inline popup: prefix matches first
 * (including hidden aliases), then a fuzzy subsequence pass. Declaration order
 * is preserved inside each bucket, like Codex's SlashCommand enum order.
 */
function matchCommands(query) {
  const needle = String(query ?? '').toLowerCase()
  if (needle === '') return COMMANDS
  const prefix = COMMANDS.filter(([name]) => {
    if (name.slice(1).toLowerCase().startsWith(needle)) return true
    for (const [alias, primary] of COMMAND_ALIASES) {
      if (primary === name && alias.slice(1).toLowerCase().startsWith(needle)) return true
    }
    return false
  })
  if (prefix.length > 0) return prefix
  return COMMANDS.filter(([name]) => isSubsequence(needle, name.slice(1).toLowerCase()))
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/** One Host-supplied status label: control characters stripped and capped. */
function statusLabel(value, max = 64) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, max)
}

/** Desktop `formatTokens`: raw below 1k, K/M with the same rounding rule. */
function compactTokens(value) {
  if (typeof value !== 'number' || Number.isFinite(value) !== true || value < 0) return null
  const scaled = (candidate) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** Desktop `formatTokensPerSecond`: whole numbers at 10+, one decimal below. */
function compactSpeed(value) {
  if (typeof value !== 'number' || Number.isFinite(value) !== true || value < 0) return null
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

/** Whitelisted run state for the status line; the Host never supplies this text. */
function statusStateLabel(status) {
  const allowed = new Set([
    'ready',
    'draft',
    'waiting',
    'streaming',
    'running',
    'loading',
    'creating',
    'error',
    'clipboard',
  ])
  return allowed.has(status) ? status : 'ready'
}

/**
 * The two status rows handed to the native renderer (`view.statusLines`).
 *
 * First row: model + effort, permission preset and run state. Second row:
 * context occupancy, cumulative tokens, cache hit, turns/steps and output
 * speed. Missing values are dropped, and a row that would otherwise be empty
 * reads "—"; the cumulative token total is never presented as context
 * occupancy, and no cost is shown because the Host does not report one.
 *
 * Exported so the i18n tests can assert the rows without booting a screen.
 * `lang` defaults to zh (the pre-i18n wording); `runTui` passes the resolved
 * process language. `status` and `attention` are the run state and the
 * pending-decision marker, which only `runTui`'s state can determine.
 *
 * @param {object|undefined} session
 * @param {{ lang?: 'zh'|'en', status?: string, attention?: boolean }} [options]
 * @returns {string[]} zero, one or two rows
 */
export function buildStatusLines(session, { lang = DEFAULT_LANGUAGE, status = 'ready', attention = false } = {}) {
  if (session === undefined || session === null) return []
  const t = createTranslator(lang, TUI_CATALOG)
  const statusline = session.statusline
  const model = statusline?.model
  const first = [
    statusLabel(model?.model),
    statusLabel(model?.effort, 32),
    statusLabel(statusline?.permission, 32),
    statusStateLabel(status),
  ].filter((part) => part !== null && part !== undefined)
  // A visible marker in the status row, so a pending human decision is not
  // hidden behind the transcript. The actionable entry itself is the hint.
  if (attention === true) first.push(t('status.attention'))

  const context = statusline?.context
  const usage = statusline?.usage
  const stats = statusline?.stats
  const second = []
  if (context !== null && context !== undefined) {
    const percent = typeof context.percent === 'number' ? `${context.percent}%` : null
    const used = compactTokens(context.usedTokens)
    const limit = compactTokens(context.contextWindow)
    if (percent !== null && used !== null && limit !== null) second.push(`ctx ${percent} ${used}/${limit}`)
    else if (percent !== null) second.push(`ctx ${percent}`)
    else if (used !== null) second.push(`ctx ${used}`)
  }
  if (usage !== null && usage !== undefined) {
    const total = compactTokens(usage.totalTokens)
    if (total !== null) second.push(`${total} tok`)
    if (typeof usage.cacheHitPercent === 'number') second.push(`cache ${usage.cacheHitPercent}%`)
  }
  if (stats !== null && stats !== undefined) {
    second.push(t('status.turnsSteps', { turns: stats.turns, steps: stats.steps }))
    const speed = compactSpeed(stats.tokensPerSecond)
    if (speed !== null) second.push(`${speed} tok/s`)
  }
  return [first.length === 0 ? '—' : first.join(' · '), second.length === 0 ? '—' : second.join(' · ')]
}

// ---------------------------------------------------------------------------
// runTui
// ---------------------------------------------------------------------------

/**
 * Run the full-screen TUI until the user quits.
 *
 * @param {{
 *   adapter: object,
 *   createScreen: Function,
 *   options?: {initialSession?: string, cwd?: string, timeoutMs?: number,
 *              tail?: number, stream?: boolean, noHistory?: boolean,
 *              workspace?: string, renderDelayMs?: number,
 *              pendingPollMs?: number, watchIntervalMs?: number,
 *              watchTimeoutMs?: number, approvalPollMs?: number,
 *              approvalLeaseMs?: number, lang?: 'zh'|'en'},
 *   input?: import('node:stream').Readable,
 *   output?: NodeJS.WritableStream,
 * }} config
 * @returns {Promise<number>} exit code
 */
export async function runTui(config = {}) {
  const { adapter, createScreen } = config
  if (adapter === undefined || adapter === null) throw new TypeError('runTui needs an adapter')
  if (typeof createScreen !== 'function') {
    throw new TypeError('runTui needs createScreen({ input, output, onKey, onResize })')
  }
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const options = config.options ?? {}

  // Resolve the language once, before the screen is created. The CLI passes
  // `options.lang`; a direct call falls back to the same `resolveLanguage`
  // path, so DSH_ASK_LANG / the locale / the zh default still apply. An
  // invalid explicit value throws `code: 'invalid-language'` here, before the
  // terminal is touched (the CLI turns that into a usage error).
  const lang = resolveLanguage({ lang: options.lang })
  const t = createTranslator(lang, TUI_CATALOG)

  // Composer, footer and status-row words for this language. The catalog is
  // the only source; nothing here is a second copy of the zh wording.
  const HINT_READY = t('hint.ready')
  const HINT_DRAFT = t('hint.draft')
  const HINT_BUSY = t('hint.busy')
  const HINT_PICK = t('hint.pick')
  const HINT_HELP = t('hint.help')
  const HINT_CREATING = t('hint.creating')
  const HINT_COMMANDS = t('hint.commands')

  const state = {
    baseCwd: typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd(),
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180_000,
    tail: Math.min(Math.max(Number.isFinite(options.tail) ? options.tail : 60, 1), 300),
    stream: options.stream !== false,
    noHistory: options.noHistory === true,
    renderDelayMs: Number.isFinite(options.renderDelayMs) ? Math.max(0, options.renderDelayMs) : 16,
    pendingPollMs:
      options.pendingPollMs === 0
        ? 0
        : Number.isFinite(options.pendingPollMs)
          ? Math.max(50, options.pendingPollMs)
          : 5_000,
    watchIntervalMs: Number.isFinite(options.watchIntervalMs) ? Math.max(10, options.watchIntervalMs) : 1_500,
    watchTimeoutMs: Number.isFinite(options.watchTimeoutMs) ? Math.max(100, options.watchTimeoutMs) : 600_000,
    approvalPollMs: Number.isFinite(options.approvalPollMs) ? Math.max(100, options.approvalPollMs) : 2_000,
    approvalLeaseMs: Number.isFinite(options.approvalLeaseMs)
      ? Math.min(600_000, Math.max(10_000, Math.floor(options.approvalLeaseMs)))
      : 60_000,
    phase: 'pick',
    activeKey: null,
    sessions: new Map(),
    rows: [],
    workspaces: [],
    rowsError: '',
    loadedRows: false,
    modals: [],
    globalMessages: [],
    busy: null,
    submitBusy: null,
    watches: new Map(),
    pendingPoll: null,
    approvalClaim: null,
    approvalPoll: null,
    approvalFetchBusy: false,
    approvalSeq: 0,
    draftCounter: 0,
    lastColumns: 0,
    clipboardBusy: false,
    notice: '',
    noticeTimer: null,
    renderTimer: null,
    statusPoll: null,
    chain: Promise.resolve(),
    renderErrors: [],
    keyErrors: [],
    stopped: false,
    started: false,
    finished: false,
    initializing: false,
    nothingPicked: false,
    hadSession: false,
    exitCode: 0,
    screenError: '',
    stopPromise: null,
  }

  let screen
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  // ------------------------------------------------------------- session state

  function createSessionState(seed = {}) {
    const cwd = seed.cwd ?? state.baseCwd
    return {
      key: seed.key ?? seed.sessionId ?? '',
      sessionId: seed.sessionId ?? '',
      title: seed.title ?? '',
      cwd,
      project: seed.project ?? projectOf(cwd),
      workspace: seed.workspace ?? null,
      model: MODEL_UNKNOWN,
      messages: seed.messages ?? [],
      input: seed.input ?? '',
      cursor: seed.cursor ?? 0,
      attachments: seed.attachments ?? { pending: [], sent: [] },
      scroll: 0,
      status: seed.status ?? 'ready',
      // White-listed status of this Session only; every refresh carries its own
      // sequence so a late response can never land on another Session.
      statusline: null,
      statusSeq: 0,
      remoteRunning: false,
      // Permission preset read from the Host (whitelisted, per Session).
      permissions: null,
      permissionsError: '',
      // Pending approvals/questions read from /local-cli/awaiting. The projection
      // only ever answers `continued` questions; approvals stay desktop-only.
      awaiting: null,
      awaitingError: '',
      awaitingSeq: 0,
      pendingKinds: [],
      pendingSignature: '',
      answeredQuestions: new Set(),
      questionFlow: null,
      lastTurn: undefined,
      lastFailure: undefined,
      // Lazy conversation: a draft has no Host Session yet; createOptions marks
      // whether the first send must honour -w/--create-workspace.
      createOptions: seed.createOptions === true,
      createUnknown: seed.createUnknown === true,
      creating: false,
      more: false,
      loaded: false,
      // Codex habits: Up/Down recall the inputs sent in this Session. Browsing
      // history stashes the live draft so Down at the newest restores it.
      history: [],
      historyIndex: -1,
      historyDraft: '',
      historyLast: '',
      // Inline slash-command popup: the selection resets when the filter text
      // changes and Esc closes it until the next edit.
      menuIndex: 0,
      menuQuery: null,
      menuSuppressed: false,
    }
  }

  const activeSession = () => (state.activeKey === null ? undefined : state.sessions.get(state.activeKey))

  function projectOf(cwd) {
    const workspace = workspaceFor(state.workspaces, cwd)
    if (workspace !== undefined && typeof workspace.title === 'string' && workspace.title !== '') {
      return oneLine(workspace.title, 80)
    }
    return oneLine(basenameOf(cwd), 80)
  }

  function addMessage(session, message) {
    if (session === undefined) {
      state.globalMessages.push({ role: message.role, text: stripEscapes(message.text) })
      return
    }
    session.messages.push({ role: message.role, text: stripEscapes(message.text) })
    if (session.messages.length > 2000) session.messages.splice(0, session.messages.length - 2000)
  }

  const systemNote = (session, text) => addMessage(session, { role: 'system', text })
  const addError = (session, text) => addMessage(session, { role: 'error', text })

  function applyRow(session, row) {
    if (typeof row?.title === 'string' && row.title !== '') session.title = oneLine(row.title, 120)
    if (typeof row?.cwd === 'string' && row.cwd !== '') {
      session.cwd = row.cwd
      session.project = projectOf(session.cwd)
    }
    if (typeof row?.running === 'boolean') session.remoteRunning = row.running
  }

  function applyRowsToSessions() {
    for (const row of state.rows) {
      const session = state.sessions.get(row.sessionId)
      if (session !== undefined) applyRow(session, row)
    }
  }

  // ---------------------------------------------------------------- rendering

  function statusOf(session) {
    if (session === undefined) {
      if (state.busy?.kind === 'create') return 'creating'
      return state.initializing ? 'loading' : 'ready'
    }
    if (state.busy?.kind === 'create' && state.busy.sessionKey === session.key) return 'creating'
    if (session.sessionId === '' && state.busy === null) return 'draft'
    if (state.busy !== null && state.busy.sessionKey === session.key) {
      return session.status === 'streaming' ? 'streaming' : 'waiting'
    }
    if (state.clipboardBusy) return 'clipboard'
    if (session.status === 'loading') return 'loading'
    if (session.status === 'creating') return 'creating'
    if (session.remoteRunning === true && session.status === 'ready') return 'running'
    return session.status
  }

  /**
   * Refresh one Session's white-listed status.
   *
   * The sequence stamp and the object identity mean a response for Session A can
   * never write onto Session B after a switch. A Host without the endpoint (or a
   * transient failure) leaves the status empty and never disturbs the chat.
   */
  async function refreshStatus(session) {
    if (session === undefined || session.sessionId === '' || typeof adapter.fetchStatus !== 'function') return
    const seq = (session.statusSeq = (session.statusSeq ?? 0) + 1)
    let pendingKinds = null
    try {
      const payload = await adapter.fetchStatus(session.sessionId)
      if (session.statusSeq !== seq || state.stopped || state.finished) return
      session.statusline = payload?.status ?? null
      if (typeof session.statusline?.model?.model === 'string') session.model = session.statusline.model.model
      // The status projection may omit permission on an older Host while the
      // dedicated read already returned the whitelisted current value; keep that
      // verified value instead of showing a blank chip.
      if (session.statusline !== null && statusLabel(session.statusline.permission) === null) {
        const known = session.permissions?.currentValue
        if (typeof known === 'string' && known !== '') {
          session.statusline = { ...session.statusline, permission: known }
        }
      }
      pendingKinds = Array.isArray(session.statusline?.pendingInput)
        ? session.statusline.pendingInput.filter((kind) => typeof kind === 'string' && kind !== '')
        : []
    } catch {
      if (session.statusSeq !== seq || state.stopped || state.finished) return
      // Older Host: /local-cli/status is missing. Chat must keep working.
      session.statusline = null
    }
    // The status projection only names kinds; the details come from
    // /local-cli/awaiting. Refresh that when a pending kind appears or when the
    // last one disappears (so a stale banner cannot linger).
    if (pendingKinds !== null) {
      const changed = JSON.stringify(pendingKinds) !== JSON.stringify(session.pendingKinds)
      session.pendingKinds = pendingKinds
      if (typeof adapter.fetchAwaiting === 'function' && (changed === true || pendingKinds.length > 0)) {
        void refreshAwaiting(session, { quiet: true })
      }
    }
    if (session === activeSession()) requestRender()
  }

  function stopStatusPoll() {
    if (state.statusPoll === null) return
    clearInterval(state.statusPoll)
    state.statusPoll = null
  }

  /** At most one refresh every 3s while a turn waits; key events refresh sooner. */
  function startStatusPoll() {
    stopStatusPoll()
    state.statusPoll = setInterval(() => {
      if (state.stopped || state.finished || state.busy?.kind !== 'turn') return
      void refreshStatus(activeSession())
    }, 3_000)
    state.statusPoll.unref?.()
  }

  /**
   * The inline slash-command popup state for a Session, or null when it must
   * stay closed. Codex only shows it while the cursor sits in the first
   * `/name` token on the first line; a space (arguments) or a newline closes
   * it, and Esc suppresses it until the next edit.
   */
  function commandMenuFor(session) {
    if (session === undefined || session === null) return null
    if (session.menuSuppressed === true) return null
    const input = session.input
    if (input.startsWith('/') !== true) return null
    if (input.includes('\n') === true) return null
    if (/^\/\S*$/.test(input) !== true) return null
    if (session.cursor < 0 || session.cursor > input.length) return null
    const query = input.slice(1)
    if (session.menuQuery !== query) {
      session.menuQuery = query
      session.menuIndex = 0
    }
    const items = matchCommands(query).map(([label, key]) => ({ label, detail: t(key) }))
    if (items.length === 0) session.menuIndex = 0
    else if (session.menuIndex >= items.length) session.menuIndex = items.length - 1
    return {
      kind: 'commands',
      title: '',
      items,
      selected: session.menuIndex,
      query: input,
      footer: HINT_COMMANDS,
    }
  }

  function currentHint() {
    if (state.modals.length > 0) {
      const modal = state.modals[state.modals.length - 1]
      return modal.footer
    }
    if (commandMenuFor(activeSession()) !== null) return HINT_COMMANDS
    const session = activeSession()
    if (state.busy?.kind === 'turn') {
      if (hasAttention(session)) return attentionHint(session)
      return HINT_BUSY
    }
    if (state.busy?.kind === 'create') return HINT_CREATING
    if (state.initializing) return t('hint.initializing')
    if (state.notice !== '') return state.notice
    if (state.submitBusy !== null) return t('hint.submitting')
    if (hasAttention(session)) return attentionHint(session)
    if (session !== undefined && state.watches.has(session.key)) return WATCH_HINT
    if (session !== undefined && session.sessionId === '') return HINT_DRAFT
    if (state.phase === 'pick') return HINT_PICK
    return HINT_READY
  }

  function buildView() {
    const session = activeSession()
    const modal = state.modals.length > 0 ? state.modals[state.modals.length - 1] : undefined
    const menu = commandMenuFor(session)
    const messages = session === undefined ? state.globalMessages : session.messages
    return {
      project: session?.project ?? oneLine(basenameOf(state.baseCwd), 80),
      cwd: session?.cwd ?? state.baseCwd,
      sessionTitle: session?.title ?? '',
      sessionId: session?.sessionId ?? '',
      model:
        statusLabel(session?.statusline?.model?.model) ??
        (typeof session?.model === 'string' && session.model !== '' ? session.model : MODEL_UNKNOWN),
      status: statusOf(session),
      statusLines: buildStatusLines(session, {
        lang,
        status: statusOf(session),
        attention: session !== undefined && hasAttention(session),
      }),
      messages: messages.slice(),
      input: session?.input ?? '',
      inputCursor: session?.cursor ?? 0,
      attachments: (session?.attachments.pending ?? []).map((image) => ({ name: imageName(image) })),
      hint: currentHint(),
      scrollOffset: session?.scroll ?? 0,
      modal:
        modal === undefined
          ? menu
          : {
              kind: modal.kind ?? 'sessions',
              title: modal.title,
              items: filteredItems(modal).map(({ label, detail }) => ({ label, detail })),
              selected: modal.selected,
              query: modal.query,
              footer: modal.footer,
            },
      // The fixed JS -> native contract from `dsh-i18n.mjs` (rebuilt every
      // frame, never cached by the renderer). An ordinary enumerable field so
      // JSON serialization carries it, including the native screen's
      // oversized-frame fallback. Nothing here rewrites messages, cwd, titles
      // or attachment names.
      ui: nativeUiLabels(lang),
    }
  }

  function renderNow() {
    if (state.stopped || state.finished || screen === undefined) return
    try {
      screen.render(buildView())
    } catch (error) {
      // A renderer bug must never take the terminal down without a restore.
      state.renderErrors.push(error)
    }
  }

  function requestRender() {
    if (state.stopped || state.finished) return
    if (state.renderDelayMs === 0) {
      renderNow()
      return
    }
    if (state.renderTimer !== null) return
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null
      renderNow()
    }, state.renderDelayMs)
    state.renderTimer.unref?.()
  }

  function setNotice(text, ms = 5000) {
    state.notice = text
    if (state.noticeTimer !== null) clearTimeout(state.noticeTimer)
    state.noticeTimer = setTimeout(() => {
      state.noticeTimer = null
      state.notice = ''
      requestRender()
    }, ms)
    state.noticeTimer.unref?.()
    requestRender()
  }

  // ------------------------------------------- permissions / pending answers
  //
  // The Host build this CLI targets exposes permission presets through
  // `permissionPresets.catalog()` + the session `permissions` projection, and
  // only `continued` timed questions through `userQuestions.answer`. Tool
  // approvals and `open` questions are held by the live desktop Remote Event
  // waterfall and have NO host-side answer API; the TUI must never invent one.
  // Every write below is user-initiated, explicitly confirmed, and submitted
  // once. Nothing here auto-allows, auto-answers, or re-sends a prompt.

  const WATCH_HINT = t('hint.watch')

  function pageColumns() {
    const columns = Number(output?.columns)
    return Number.isFinite(columns) && columns >= 20 ? Math.min(160, Math.floor(columns)) : 80
  }

  function pageWrapWidth() {
    return Math.max(24, Math.min(96, pageColumns() - 4))
  }

  /** Wrap every block for the native full-screen page; nothing is truncated. */
  function contentLines(blocks) {
    const width = pageWrapWidth()
    const lines = []
    for (const block of blocks) {
      if (block === undefined || block === null) continue
      // Host-supplied question/detail/reason text is untrusted; strip terminal
      // controls here, before it is wrapped into renderer rows.
      for (const line of wrapBlock(stripEscapes(String(block)), width)) lines.push(line)
    }
    return lines
  }

  function infoItems(prefix, blocks) {
    return contentLines(blocks).map((line, index) => ({
      label: line,
      detail: '',
      key: `${prefix}:${index}`,
      readOnly: true,
    }))
  }

  /**
   * Build a full-screen page modal. `build` is re-run on terminal resize so a
   * long detail keeps fitting the new width instead of being cut off.
   */
  function pageModal(options) {
    const { kind, title, content = [], actions = [], footer = '', selectKey = undefined, build = undefined, ...extra } = options
    const modal = { kind, title, items: [], selected: 0, query: '', footer, filterable: false, ...extra }
    modal.build =
      typeof build === 'function'
        ? build
        : () => [...infoItems('page', content), ...actions]
    modal.items = modal.build()
    if (selectKey !== undefined) {
      const found = modal.items.findIndex((item) => item.key === selectKey)
      if (found >= 0) modal.selected = found
    }
    return modal
  }

  function pushPageModal(modal) {
    state.modals.push(modal)
    requestRender()
    return modal
  }

  function rebuildModal(modal) {
    if (typeof modal.build !== 'function') return
    const previousKey = modal.items[modal.selected]?.key
    modal.items = modal.build()
    if (previousKey !== undefined) {
      const found = modal.items.findIndex((item) => item.key === previousKey)
      if (found >= 0) modal.selected = found
    }
    clampSelected(modal)
  }

  /** Re-wrap every open page when the terminal width changed. */
  function relayoutModals() {
    for (const modal of state.modals) rebuildModal(modal)
  }

  function normalizeAwaiting(payload) {
    const kinds = Array.isArray(payload?.pendingInput)
      ? [...new Set(payload.pendingInput.filter((kind) => typeof kind === 'string' && kind !== ''))]
      : []
    const active = []
    for (const batch of Array.isArray(payload?.questions?.active) ? payload.questions.active : []) {
      if (batch === null || typeof batch !== 'object') continue
      const callId = typeof batch.callId === 'string' ? batch.callId : ''
      const stateName = batch.state === 'open' || batch.state === 'continued' ? batch.state : ''
      if (callId === '' || stateName === '') continue
      const questions = []
      for (const question of Array.isArray(batch.questions) ? batch.questions : []) {
        if (question === null || typeof question !== 'object') continue
        if (typeof question.id !== 'string' || question.id === '') continue
        if (typeof question.question !== 'string') continue
        const options = []
        for (const option of Array.isArray(question.options) ? question.options : []) {
          if (option === null || typeof option !== 'object' || typeof option.label !== 'string') continue
          options.push({
            label: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
          })
        }
        questions.push({
          id: question.id,
          question: question.question,
          ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
          ...(typeof question.header === 'string' ? { header: question.header } : {}),
          ...(options.length > 0 ? { options } : {}),
          multiSelect: question.multiSelect === true,
        })
      }
      if (questions.length === 0) continue
      active.push({ callId, state: stateName, questions })
    }
    const approvals = payload?.approvals
    return {
      running: payload?.running === true,
      pendingInput: kinds,
      questions: {
        active,
        settledCount: Number.isFinite(payload?.questions?.settledCount) ? payload.questions.settledCount : 0,
      },
      approvals: {
        supported: approvals?.supported === true,
        present: approvals?.present === true,
        reason: typeof approvals?.reason === 'string' ? approvals.reason : '',
      },
      answerable: payload?.answerable === true || active.some((batch) => batch.state === 'continued'),
    }
  }

  function sessionAttention(session) {
    const empty = {
      kinds: [],
      active: [],
      answerable: [],
      open: [],
      approvals: false,
      other: false,
      approvalRequests: [],
      approvalClaimed: false,
    }
    if (session === undefined) return empty
    const awaiting = session.awaiting
    const kinds =
      Array.isArray(awaiting?.pendingInput) && awaiting.pendingInput.length > 0
        ? awaiting.pendingInput
        : Array.isArray(session.pendingKinds) && session.pendingKinds.length > 0
          ? session.pendingKinds
          : []
    const active = (awaiting?.questions?.active ?? []).filter(
      (batch) => session.answeredQuestions.has(batch.callId) !== true,
    )
    const answerable = active.filter((batch) => batch.state === 'continued')
    const open = active.filter((batch) => batch.state !== 'continued')
    const approvals = awaiting?.approvals?.present === true || kinds.includes('approval')
    const channel = approvalClaimFor(session)
    return {
      kinds,
      active,
      answerable,
      open,
      approvals,
      other: kinds.includes('other'),
      approvalRequests: channel === null ? [] : channel.pending,
      approvalClaimed: channel !== null,
    }
  }

  function hasAttention(session) {
    const attention = sessionAttention(session)
    return (
      attention.active.length > 0 ||
      attention.approvals ||
      attention.approvalRequests.length > 0 ||
      attention.kinds.length > 0
    )
  }

  function attentionHint(session) {
    const attention = sessionAttention(session)
    if (attention.approvalRequests.length > 0) return t('attention.terminal-approval-request-handle-with-f2-or')
    if (attention.answerable.length > 0) return t('attention.question-waiting-for-an-answer-handle-with')
    if (attention.approvals) return t('attention.approval-needs-desktop-confirmation-view')
    if (attention.open.length > 0) return t('attention.question-can-only-be-answered-on-the')
    if (attention.kinds.includes('question')) return t('attention.pending-question-view-with-f2-or-approvals')
    return t('attention.pending-requests-view-with-f2-or-approvals')
  }

  function awaitingSignature(session) {
    const awaiting = session.awaiting
    const channel = approvalClaimFor(session)
    return JSON.stringify({
      kinds: awaiting?.pendingInput ?? [],
      active: (awaiting?.questions?.active ?? []).map((batch) => [batch.callId, batch.state]),
      approvals: awaiting?.approvals?.present === true,
      channel: channel === null ? [] : channel.pending.map((request) => request.requestId),
    })
  }

  /**
   * Add one system note when the pending set changes, so a new approval or
   * question is visible as a prominent entry without stealing the composer or
   * answering anything.
   */
  function noteAwaitingChange(session, previousSignature) {
    const signature = awaitingSignature(session)
    if (signature === session.pendingSignature) return
    const had = session.pendingSignature !== ''
    session.pendingSignature = signature
    if (hasAttention(session)) {
      systemNote(session, t('attention.the-draft-and-attachments-are-unchanged', { p1: attentionHint(session) }))
      setNotice(t('attention.pending-requests-detected-press-f2-or'), 8000)
    } else if (had && previousSignature !== '') {
      systemNote(session, t('attention.pending-requests-cleared-or-already-handled'))
    }
  }

  /**
   * Read the pending-input projection for one Session. A late response can never
   * land on another Session: the sequence stamp and the closure identity both
   * have to match.
   */
  async function refreshAwaiting(session, { quiet = false } = {}) {
    if (session === undefined || session.sessionId === '' || typeof adapter.fetchAwaiting !== 'function') return undefined
    const seq = (session.awaitingSeq = (session.awaitingSeq ?? 0) + 1)
    try {
      const payload = await adapter.fetchAwaiting(session.sessionId)
      if (session.awaitingSeq !== seq || state.stopped || state.finished) return undefined
      if (payload?.ok !== true) throw adapterPayloadError(payload, 'awaiting-unavailable')
      const previous = session.pendingSignature
      session.awaiting = normalizeAwaiting(payload)
      session.awaitingError = ''
      if (typeof session.awaiting.running === 'boolean') session.remoteRunning = session.awaiting.running
      noteAwaitingChange(session, previous)
    } catch (error) {
      if (session.awaitingSeq !== seq || state.stopped || state.finished) return undefined
      session.awaitingError = errorMessageOf(error)
      if (quiet !== true && session === activeSession()) addError(session, t('attention.cannot-read-pending-requests', { p1: session.awaitingError }))
    }
    if (session === activeSession()) requestRender()
    return session.awaiting
  }

  function stopPendingPoll() {
    if (state.pendingPoll === null) return
    clearInterval(state.pendingPoll)
    state.pendingPoll = null
  }

  /**
   * Low-frequency detection of pending input while the Session is idle. A turn
   * in flight already refreshes status; this is what notices a timed question
   * that appears after a turn returned.
   */
  function startPendingPoll() {
    stopPendingPoll()
    if (state.pendingPollMs === 0 || typeof adapter.fetchAwaiting !== 'function') return
    state.pendingPoll = setInterval(() => {
      if (state.stopped || state.finished) return
      const session = activeSession()
      if (session === undefined || session.loaded !== true || session.sessionId === '') return
      if (state.busy?.kind === 'turn' && state.busy.sessionKey === session.key) return
      void refreshAwaiting(session, { quiet: true })
    }, state.pendingPollMs)
    state.pendingPoll.unref?.()
  }

  // ---------------------------------------------------------- permission preset

  function normalizePermissions(payload) {
    const permission = payload?.permission
    const options = []
    for (const option of Array.isArray(permission?.options) ? permission.options : []) {
      if (option === null || typeof option !== 'object') continue
      if (typeof option.value !== 'string' || option.value === '') continue
      if (option.value === 'custom') continue
      options.push({
        value: option.value,
        name: typeof option.name === 'string' && option.name !== '' ? option.name : option.value,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      })
    }
    return {
      sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
      currentValue: typeof permission?.currentValue === 'string' ? permission.currentValue : null,
      label: typeof permission?.label === 'string' ? permission.label : null,
      options,
      defaultPreset: typeof permission?.defaultPreset === 'string' ? permission.defaultPreset : null,
      canSet: payload?.canSet === true,
    }
  }

  async function refreshPermissionsQuiet(session) {
    if (session === undefined || typeof adapter.fetchPermissions !== 'function') return
    try {
      const payload = await adapter.fetchPermissions(session.sessionId)
      if (payload?.ok === true && state.stopped !== true && state.finished !== true) {
        session.permissions = normalizePermissions(payload)
        session.permissionsError = ''
      }
    } catch {
      // The readback is advisory; the switch result already came from the Host.
    }
    if (session === activeSession()) requestRender()
  }

  function permissionErrorMessage(code, message) {
    switch (code) {
      case 'confirmation-required':
        return t('perm.the-host-requires-a-second-high-risk')
      case 'session-not-live':
        return t('perm.the-session-has-no-live-agent-open-it-on')
      case 'preset-not-available':
      case 'unknown-preset':
        return t('perm.the-host-catalog-does-not-offer-this-preset', { p1: message })
      case 'permission-unavailable':
        return t('perm.the-host-has-no-permission-preset-service')
      case 'switch-unverified':
        return t('perm.read-back-mismatch-after-the-switch-re-read', { p1: message })
      case 'switch-failed':
        return t('perm.the-host-refused-the-switch-re-read-not', { p1: message })
      case 'no-such-session':
        return t('perm.the-session-does-not-exist-or-is-closed')
      default:
        return t('perm.switch-failed', { p1: code === '' ? 'unknown' : code, p2: message })
    }
  }

  function buildPermissionsItems(session) {
    const permission = session.permissions
    const content = []
    if (session.permissionsError !== '') {
      content.push(t('perm.read-failed', { p1: session.permissionsError }))
      content.push(t('perm.you-can-retry-the-read-nothing-changes'))
    } else if (permission === null) {
      content.push(t('perm.the-host-returned-no-permission-presets'))
      content.push(t('perm.read-only-display-the-current-value-is'))
    } else {
      const label = permission.label === null ? '' : `（${permission.label}）`
      content.push(t('perm.current-preset', { p1: permission.currentValue ?? t('msg.not-reported'), p2: label }))
      content.push(t('perm.default-preset-new-sessions', { p1: permission.defaultPreset ?? t('msg.not-reported') }))
      content.push(t('perm.only-presets-that-really-exist-in-the-host'))
      if (permission.canSet !== true) content.push(t('perm.this-host-offers-no-switch-entry-read-only'))
      content.push(t('perm.choosing-a-target-preset-still-needs-one'))
    }
    const actions = []
    for (const option of permission?.options ?? []) {
      const current = option.value === permission.currentValue
      actions.push({
        key: `perm-preset:${option.value}`,
        action: 'permission-preset',
        value: option.value,
        label: `${current ? '●' : '○'} ${safeText(option.name, 60)}  [${safeText(option.value, 64)}]`,
        detail: option.description === undefined ? '' : safeText(option.description, 200),
      })
    }
    actions.push({ key: 'perm-refresh', action: 'permissions-refresh', label: t('perm.re-read-permission-presets'), detail: '' })
    actions.push({ key: 'perm-close', action: 'permissions-close', label: t('perm.close-esc'), detail: '' })
    return [...infoItems('perm-info', content), ...actions]
  }

  function permissionsFooter(session) {
    return session.permissions?.canSet === true ? t('perm.select-preset-enter-confirm-esc-close') : t('perm.view-esc-close-read-only')
  }

  async function openPermissions() {
    const session = activeSession()
    if (session === undefined) return
    if (session.sessionId === '') {
      systemNote(session, t('perm.no-session-yet-it-is-created-on-the-first'))
      requestRender()
      return
    }
    if (state.submitBusy !== null) {
      setNotice(t('perm.submitting-please-wait-before-opening'))
      return
    }
    if (typeof adapter.fetchPermissions !== 'function' || typeof adapter.submitPermission !== 'function') {
      systemNote(session, t('perm.this-cli-host-does-not-support-permission'))
      requestRender()
      return
    }
    state.modals = []
    const modal = pushPageModal(
      pageModal({
        kind: 'permissions',
        title: t('perm.permission-presets-loading'),
        content: [t('perm.session', { p1: shortId(session.sessionId) }), t('perm.reading-host-permission-presets-and-catalog')],
        footer: t('perm.loading'),
      }),
    )
    try {
      session.permissions = normalizePermissions(
        requireOk(await adapter.fetchPermissions(session.sessionId), 'permission-unavailable'),
      )
      session.permissionsError = ''
    } catch (error) {
      session.permissionsError = errorMessageOf(error)
    }
    if (state.stopped || state.finished || topModal() !== modal) return
    modal.title = t('perm.permission-presets')
    modal.build = () => buildPermissionsItems(session)
    rebuildModal(modal)
    const current = session.permissions?.currentValue
    if (current !== undefined && current !== null) {
      const found = modal.items.findIndex((item) => item.key === `perm-preset:${current}`)
      if (found >= 0) modal.selected = found
    }
    modal.footer = permissionsFooter(session)
    requestRender()
  }

  function permissionConfirmContent(session, value, { second = false } = {}) {
    const permission = session.permissions
    const option = permission?.options.find((entry) => entry.value === value)
    const name = option?.name ?? value
    const dangerous = CONFIRMED_PRESETS.has(value)
    const content = [
      t('perm.current-session', { p1: shortId(session.sessionId) }),
      t('perm.switch-from-to', { p1: permission?.currentValue ?? t('msg.not-reported'), p2: value, p3: name }),
      ...(option?.description === undefined ? [] : [option.description]),
    ]
    if (dangerous) {
      content.push(t('perm.high-risk-preset-it-widens-what-the-agent'))
      if (value === 'danger-full-access') {
        content.push(t('perm.note-under-the-base-config-danger-full'))
      }
    }
    if (second === true) {
      content.push(t('perm.this-is-the-second-confirmation-the-switch'))
    } else {
      content.push(t('perm.nothing-is-submitted-until-you-confirm-here'))
    }
    return content
  }

  function pushPermissionConfirm(session, value) {
    const dangerous = CONFIRMED_PRESETS.has(value)
    pushPageModal(
      pageModal({
        kind: 'permission-confirm',
        title: t('perm.confirm-permission-switch', { p1: safeText(value, 64) }),
        content: permissionConfirmContent(session, value),
        actions: [
          { key: 'perm-cancel', action: 'permission-cancel', label: t('perm.cancel-do-not-switch'), detail: '' },
          {
            key: 'perm-confirm',
            action: dangerous ? 'permission-confirm-danger' : 'permission-confirm',
            label: dangerous ? t('perm.continue-to-the-high-risk-confirmation') : t('perm.confirm-switch'),
            detail: '',
          },
        ],
        footer: dangerous ? t('perm.high-risk-action-enter-opens-the-second') : t('perm.enter-confirms-the-switch-esc-cancels-never'),
        selectKey: 'perm-cancel',
        sessionId: session.sessionId,
        value,
      }),
    )
  }

  function pushPermissionConfirmDanger(session, value) {
    pushPageModal(
      pageModal({
        kind: 'permission-confirm-2',
        title: t('perm.confirm-again', { p1: safeText(value, 64) }),
        content: permissionConfirmContent(session, value, { second: true }),
        actions: [
          { key: 'perm-cancel-2', action: 'permission-cancel', label: t('perm.cancel-do-not-switch'), detail: '' },
          { key: 'perm-confirm-2', action: 'permission-confirm-2', label: t('perm.confirm-switch-to-risk-understood', { p1: safeText(value, 64) }), detail: '' },
        ],
        footer: t('perm.final-confirmation-enter-submits-esc'),
        selectKey: 'perm-cancel-2',
        sessionId: session.sessionId,
        value,
      }),
    )
  }

  async function submitPermissionChange(session, value, confirmed) {
    if (state.submitBusy !== null) {
      setNotice(t('hint.submitting'))
      return
    }
    const active = activeSession()
    if (active === undefined || active.sessionId !== session.sessionId) {
      addError(session, t('perm.the-session-changed-permissions-were-not'))
      closeModal()
      return
    }
    if (session.permissions !== null && session.permissions.canSet !== true) {
      setNotice(t('perm.this-host-is-read-only-and-cannot-switch'))
      return
    }
    if (session.permissions !== null && session.permissions.options.some((option) => option.value === value) !== true) {
      setNotice(t('perm.the-host-catalog-has-no-nothing-was', { p1: value }))
      return
    }
    const modal = topModal()
    if (modal !== undefined) modal.footer = t('perm.submitting-the-permission-switch-nothing-is')
    state.submitBusy = { kind: 'permission', sessionKey: session.key, value }
    requestRender()
    try {
      const payload = requireOk(
        await adapter.submitPermission({ sessionId: session.sessionId, preset: value, confirmed: confirmed === true }),
        'switch-failed',
      )
      if (payload.matched !== true || payload.preset !== value || payload.sessionId !== session.sessionId) {
        throw adapterPayloadError({
          code: 'switch-unverified',
          error: 'Host did not confirm the requested preset for this Session',
        })
      }
      const previous = session.permissions?.currentValue ?? null
      const name = session.permissions?.options.find((option) => option.value === value)?.name ?? value
      if (session.permissions !== null) {
        session.permissions = { ...session.permissions, currentValue: value, label: name }
      }
      if (session.statusline !== null) session.statusline = { ...session.statusline, permission: value }
      state.modals = []
      systemNote(
        session,
        t('perm.permission-preset-switched', {
          p1: previous ?? '—',
          p2: value,
          p3: confirmed === true ? t('msg.high-risk-second-confirmation-done') : '',
          p4:
            typeof payload.text === 'string' && payload.text !== '' ? ` · Host: ${oneLine(payload.text, 160)}` : '',
        }),
      )
      setNotice(t('perm.permissions-switched', { p1: value }))
      void refreshStatus(session)
      void refreshPermissionsQuiet(session)
    } catch (error) {
      const code = errorCodeOf(error)
      addError(session, permissionErrorMessage(code, errorMessageOf(error)))
      state.modals = []
      // Never retry automatically: re-read what the Host actually recorded.
      void refreshPermissionsQuiet(session)
      void refreshStatus(session)
    } finally {
      state.submitBusy = null
      requestRender()
    }
  }

  // ---------------------------------------------------------- approval channel
  //
  // The real terminal approval channel is an official owner/answer Node Client
  // owned by the Host plugin. Claiming is an explicit, per-Session choice; the
  // desktop keeps working and whoever answers first wins (the other side gets a
  // cancel). This layer NEVER claims, releases or answers by itself: the only
  // write is a user decision sent from a confirmation page whose default action
  // is cancel. It also only shows requests received after the claim; requests
  // already pending on the desktop are never captured or answered here.

  const APPROVAL_POLL_DEFAULT_MS = 2_000
  const APPROVAL_HEARTBEAT_DEFAULT_MS = 15_000
  const APPROVAL_LEASE_DEFAULT_MS = 60_000

  function approvalChannelAvailable() {
    return (
      typeof adapter.fetchApprovalChannel === 'function' &&
      typeof adapter.claimApprovalChannel === 'function' &&
      typeof adapter.heartbeatApprovalChannel === 'function' &&
      typeof adapter.releaseApprovalChannel === 'function' &&
      typeof adapter.submitApprovalDecision === 'function'
    )
  }

  function approvalClaimFor(session) {
    const claim = state.approvalClaim
    if (claim === null || session === undefined) return null
    return claim.sessionId === session.sessionId ? claim : null
  }

  function sessionForApprovalClaim() {
    const claim = state.approvalClaim
    if (claim === null) return undefined
    for (const session of state.sessions.values()) {
      if (session.sessionId === claim.sessionId) return session
    }
    return undefined
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return t('misc.not-provided-by-the-host')
    try {
      return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
    } catch {
      return String(ms)
    }
  }

  function formatLeaseRemaining(expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return t('misc.unknown')
    return formatDuration(Math.max(0, expiresAt - Date.now()))
  }

  function normalizeApprovalSnapshot(payload) {
    const rawClaim = payload?.claim
    const claim =
      rawClaim !== null &&
      typeof rawClaim === 'object' &&
      typeof rawClaim.claimId === 'string' &&
      rawClaim.claimId !== ''
        ? {
            claimId: rawClaim.claimId,
            sessionId: typeof rawClaim.sessionId === 'string' ? rawClaim.sessionId : '',
            expiresAt: Number.isFinite(rawClaim.expiresAt) ? rawClaim.expiresAt : 0,
            leaseMs: Number.isFinite(rawClaim.leaseMs) ? rawClaim.leaseMs : APPROVAL_LEASE_DEFAULT_MS,
          }
        : null
    const pending = []
    for (const entry of Array.isArray(payload?.pending) ? payload.pending : []) {
      if (entry === null || typeof entry !== 'object') continue
      const requestId = typeof entry.requestId === 'string' ? entry.requestId : ''
      if (requestId === '') continue
      pending.push({
        requestId,
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
        toolName: typeof entry.toolName === 'string' ? entry.toolName : null,
        callId: typeof entry.callId === 'string' ? entry.callId : null,
        reason: typeof entry.reason === 'string' ? entry.reason : null,
        displayReason: typeof entry.displayReason === 'string' ? entry.displayReason : null,
        requestedAt: Number.isFinite(entry.requestedAt) ? entry.requestedAt : 0,
      })
    }
    return {
      claim,
      connected: payload?.connected === true,
      pendingCount: Number.isFinite(payload?.pendingCount) ? payload.pendingCount : pending.length,
      maxPending: Number.isFinite(payload?.maxPending) ? payload.maxPending : 8,
      pending,
    }
  }

  function describeApprovalRequest(request) {
    const tool =
      request.toolName === null || request.toolName === '' ? 'tool' : safeText(request.toolName, 60)
    const reason = request.displayReason ?? request.reason
    return reason === null || reason === '' ? tool : `${tool} · ${safeText(reason, 60)}`
  }

  function approvalRequestLines(request) {
    return [
      `requestId：${request.requestId}`,
      t('approval.tool', { p1: request.toolName ?? t('misc.not-provided-by-the-host') }),
      `callId：${request.callId ?? t('misc.not-provided-by-the-host')}`,
      t('approval.reason', { p1: request.reason ?? t('misc.not-provided-by-the-host') }),
      t('approval.display-reason', { p1: request.displayReason ?? t('misc.not-provided-by-the-host') }),
      t('approval.requested-at', { p1: request.requestedAt > 0 ? formatClock(request.requestedAt) : t('misc.not-provided-by-the-host') }),
      t('approval.scope-the-host-approval-request-only'),
      t('approval.a-decision-applies-to-this-request-only'),
    ]
  }

  function stopApprovalTimers() {
    if (state.approvalPoll !== null) {
      clearInterval(state.approvalPoll)
      state.approvalPoll = null
    }
  }

  function startApprovalTimers() {
    stopApprovalTimers()
    const claim = state.approvalClaim
    if (claim === null) return
    if (state.approvalPollMs > 0) {
      state.approvalPoll = setInterval(() => {
        if (state.stopped || state.finished) return
        const current = state.approvalClaim
        if (current === null) return
        if (current.expiresAt > 0 && Date.now() >= current.expiresAt) {
          clearApprovalClaim({
            note: t('msg.the-terminal-approval-claim-lease-expired'),
          })
          return
        }
        void refreshApprovalChannel({ quiet: true })
      }, state.approvalPollMs)
      state.approvalPoll.unref?.()
    }
  }

  function clearApprovalClaim({ note = '', silent = false } = {}) {
    const claim = state.approvalClaim
    if (claim === null) return
    const session = sessionForApprovalClaim()
    stopApprovalTimers()
    state.approvalClaim = null
    state.approvalFetchBusy = false
    if (session !== undefined) {
      session.pendingSignature = awaitingSignature(session)
      if (note !== '') systemNote(session, note)
    }
    const list = state.modals.find((modal) => modal.kind === 'approvals')
    if (list !== undefined) {
      rebuildModal(list)
      const active = activeSession()
      list.title = active !== undefined && hasAttention(active) ? t('msg.pending-requests-action-needed') : t('msg.pending-requests')
      list.footer = approvalsFooter(active ?? session)
    }
    if (note !== '' && silent !== true) setNotice(note, 8000)
    requestRender()
  }

  function pruneStaleApprovalModals() {
    const claim = state.approvalClaim
    if (claim === null) return
    let removed = false
    while (topModal() !== undefined) {
      const modal = topModal()
      if (
        (modal.kind !== 'approval-request-detail' && modal.kind !== 'approval-confirm') ||
        modal.requestId === undefined
      ) {
        break
      }
      if (claim.pending.some((request) => request.requestId === modal.requestId)) break
      state.modals.pop()
      removed = true
    }
    if (removed === true) {
      const session = activeSession()
      if (session !== undefined) {
        systemNote(session, t('approval.this-terminal-approval-request-was-handled'))
      }
    }
  }

  async function refreshApprovalChannel({ quiet = true } = {}) {
    const claim = state.approvalClaim
    if (claim === null || typeof adapter.fetchApprovalChannel !== 'function') return undefined
    if (state.approvalFetchBusy === true) return undefined
    state.approvalFetchBusy = true
    const seq = (state.approvalSeq = (state.approvalSeq ?? 0) + 1)
    const claimId = claim.claimId
    const session = sessionForApprovalClaim()
    try {
      const payload = await adapter.fetchApprovalChannel(claimId)
      if (state.stopped || state.finished || seq !== state.approvalSeq) return undefined
      if (state.approvalClaim === null || state.approvalClaim.claimId !== claimId) return undefined
      if (payload?.ok !== true) throw adapterPayloadError(payload, 'approval-unavailable')
      const snapshot = normalizeApprovalSnapshot(payload)
      const beforeIds = new Set(claim.pending.map((request) => request.requestId))
      if (snapshot.claim === null) {
        clearApprovalClaim({
          note: t('approval.the-terminal-approval-claim-ended-expired'),
        })
        return undefined
      }
      if (
        snapshot.claim.claimId !== claimId ||
        (snapshot.claim.sessionId !== '' && snapshot.claim.sessionId !== claim.sessionId)
      ) {
        clearApprovalClaim({
          note: t('approval.the-terminal-approval-claim-scope-changed'),
        })
        return undefined
      }
      const wasFirstFetch = claim.fetchedAt === 0
      state.approvalClaim = {
        ...claim,
        ...snapshot.claim,
        connected: snapshot.connected,
        maxPending: snapshot.maxPending,
        pending: snapshot.pending,
        error: '',
        fetchedAt: Date.now(),
        sessionKey: session?.key ?? claim.sessionKey,
      }
      const afterIds = new Set(snapshot.pending.map((request) => request.requestId))
      const added = snapshot.pending.filter((request) => beforeIds.has(request.requestId) !== true)
      const removed = claim.pending.filter((request) => afterIds.has(request.requestId) !== true)
      if (session !== undefined) {
        if (added.length > 0 && wasFirstFetch !== true) {
          systemNote(
            session,
            t('approval.the-terminal-received-approval-requests', { p1: added.map(describeApprovalRequest).join('、') }),
          )
          setNotice(t('approval.terminal-approval-requests-handle-with'), 8000)
        } else if (added.length === 0 && removed.length > 0) {
          systemNote(
            session,
            t('approval.terminal-approval-requests-were-handled-on', { p1: removed.length }),
          )
        }
        session.pendingSignature = awaitingSignature(session)
        pruneStaleApprovalModals()
      }
      if (state.approvalClaim.expiresAt > 0 && Date.now() >= state.approvalClaim.expiresAt) {
        clearApprovalClaim({
          note: t('msg.the-terminal-approval-claim-lease-expired'),
        })
        return undefined
      }
    } catch (error) {
      if (state.stopped || state.finished || seq !== state.approvalSeq) return undefined
      if (state.approvalClaim === null || state.approvalClaim.claimId !== claimId) return undefined
      const code = errorCodeOf(error)
      if (code === 'claim-expired' || code === 'claim-mismatch' || code === 'channel-disposed') {
        clearApprovalClaim({
          note: t('approval.the-terminal-approval-claim-is-no-longer', { p1: code }),
        })
        return undefined
      }
      state.approvalClaim.error = errorMessageOf(error)
      if (quiet !== true) {
        addError(session ?? activeSession(), t('approval.cannot-read-the-terminal-approval-channel', { p1: state.approvalClaim.error }))
      }
    } finally {
      state.approvalFetchBusy = false
      if (session === activeSession()) requestRender()
    }
    return state.approvalClaim
  }

  async function releaseApprovalClaim({ reason = 'user', force = false, silent = false } = {}) {
    const claim = state.approvalClaim
    if (claim === null) return true
    if (force !== true && state.submitBusy !== null) {
      setNotice(t('hint.submitting'))
      return false
    }
    if (force !== true) {
      state.submitBusy = { kind: 'approval-release', sessionKey: claim.sessionKey }
    }
    try {
      const payload = requireOk(
        await adapter.releaseApprovalChannel({ claimId: claim.claimId, reason }),
        'release-failed',
      )
      const delegated = Number(payload?.delegated)
      clearApprovalClaim({
        note: t('approval.terminal-approval-claim-released', {
          p1:
            Number.isFinite(delegated) && delegated > 0
              ? t('msg.unanswered-request-s-handed-back-to-the', { p1: delegated })
              : t('msg.later-approvals-return-to-the-desktop'),
        }),
        silent,
      })
      return true
    } catch (error) {
      const code = errorCodeOf(error)
      if (force === true || code === 'claim-expired' || code === 'claim-mismatch' || code === 'channel-disposed') {
        clearApprovalClaim({
          note: force === true ? '' : t('approval.the-terminal-approval-claim-is-no-longer-2', { p1: code }),
          silent: true,
        })
        return true
      }
      const session = sessionForApprovalClaim()
      if (state.approvalClaim !== null) state.approvalClaim.error = errorMessageOf(error)
      if (session !== undefined) {
        addError(session, t('approval.failed-to-release-the-terminal-approval', { p1: code === '' ? 'unknown' : code, p2: errorMessageOf(error) }))
      }
      return false
    } finally {
      if (force !== true) state.submitBusy = null
      requestRender()
    }
  }

  /**
   * Switching or leaving the Session releases the claim so the terminal never
   * keeps capturing approvals for a Session the user is no longer looking at.
   * Best-effort: the lease still bounds a failed release.
   */
  async function releaseApprovalForContextChange() {
    const claim = state.approvalClaim
    if (claim === null) return
    try {
      await Promise.race([
        Promise.resolve(adapter.releaseApprovalChannel({ claimId: claim.claimId, reason: 'shutdown' })).catch(
          () => {},
        ),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_200)
          timer.unref?.()
        }),
      ])
    } catch {
      // Lease expiry remains the backstop.
    }
    if (state.approvalClaim !== null && state.approvalClaim.claimId === claim.claimId) {
      const session = sessionForApprovalClaim()
      clearApprovalClaim({
        note: t('approval.session-switched-the-terminal-approval'),
        silent: true,
      })
      if (session !== undefined) requestRender()
    }
  }

  function approvalClaimErrorMessage(code, message) {
    switch (code) {
      case 'claim-conflict':
        return t('approval.a-terminal-approval-claim-is-already-active')
      case 'session-not-live':
        return t('approval.the-session-has-no-live-agent-open-it-on')
      case 'channel-unavailable':
      case 'agent-registry-unavailable':
        return t('approval.the-host-bridge-has-no-usable-terminal')
      case 'claim-expired':
        return t('approval.the-claim-ended-while-it-was-being')
      case 'no-such-session':
        return t('perm.the-session-does-not-exist-or-is-closed')
      case 'network-error':
        return t('approval.claim-result-unknown-refresh-the-approval')
      default:
        return t('approval.claim-failed', { p1: code === '' ? 'unknown' : code, p2: message })
    }
  }

  async function submitApprovalClaim(session, modal) {
    if (state.submitBusy !== null) {
      setNotice(t('hint.submitting'))
      return
    }
    const active = activeSession()
    if (active === undefined || active.sessionId !== session.sessionId) {
      addError(session, t('approval.the-session-changed-no-terminal-approval'))
      closeModal()
      return
    }
    if (state.approvalClaim !== null) {
      setNotice(t('approval.a-terminal-approval-claim-already-exists'))
      closeModal()
      return
    }
    state.submitBusy = { kind: 'approval-claim', sessionKey: session.key }
    if (modal !== undefined) modal.footer = t('approval.claiming-terminal-approval')
    requestRender()
    try {
      const payload = requireOk(
        await adapter.claimApprovalChannel({ sessionId: session.sessionId, leaseMs: state.approvalLeaseMs }),
        'approval-claim-failed',
      )
      const claimId = typeof payload.claimId === 'string' ? payload.claimId : ''
      const canonical = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (claimId === '' || canonical !== session.sessionId) {
        throw adapterPayloadError({
          code: 'claim-mismatch',
          error: 'Host did not confirm the claimed Session',
        })
      }
      state.approvalClaim = {
        claimId,
        sessionId: canonical,
        sessionKey: session.key,
        expiresAt: Number.isFinite(payload.expiresAt) ? payload.expiresAt : Date.now() + state.approvalLeaseMs,
        leaseMs: Number.isFinite(payload.leaseMs) ? payload.leaseMs : state.approvalLeaseMs,
        connected: true,
        maxPending: Number.isFinite(payload.maxPending) ? payload.maxPending : 8,
        pending: [],
        fetchedAt: 0,
        error: '',
      }
      state.modals = []
      systemNote(
        session,
        t('approval.terminal-approval-claimed-claim-the-desktop', { p1: shortCallId(claimId) }),
      )
      setNotice(t('approval.terminal-approval-claimed-desktop-terminal'), 8000)
      startApprovalTimers()
      await refreshApprovalChannel({ quiet: true })
    } catch (error) {
      const code = errorCodeOf(error)
      addError(session, approvalClaimErrorMessage(code, errorMessageOf(error)))
      state.modals = []
    } finally {
      state.submitBusy = null
      requestRender()
    }
  }

  function pushApprovalClaimConfirm(session) {
    const content = [
      t('approval.claim-terminal-approval-for-the-current', { p1: shortId(session.sessionId) }),
      t('approval.nothing-is-claimed-until-you-explicitly'),
      t('approval.the-desktop-still-sees-the-approval'),
      t('approval.claiming-allows-or-rejects-nothing-by'),
      t('approval.shows-the-requests-this-session-still-has'),
      t('approval.release-it-back-to-the-desktop-at-any-time'),
    ]
    pushPageModal(
      pageModal({
        kind: 'approval-claim-confirm',
        title: t('approval.claim-terminal-approval'),
        content,
        actions: [
          { key: 'approval-claim-cancel', action: 'approval-claim-cancel', label: t('approval.cancel-do-not-claim'), detail: '' },
          { key: 'approval-claim-confirm', action: 'approval-claim-confirm', label: t('approval.confirm-terminal-approval-claim'), detail: '' },
        ],
        footer: t('approval.enter-confirms-the-claim-esc-cancels-never'),
        selectKey: 'approval-claim-cancel',
        sessionId: session.sessionId,
      }),
    )
  }

  function pushApprovalReleaseConfirm() {
    const claim = state.approvalClaim
    if (claim === null) return
    const content = [
      t('approval.release-the-terminal-approval-claim-claim', { p1: shortCallId(claim.claimId) }),
      t('approval.after-release-the-terminal-stops-receiving'),
      t('approval.unanswered-requests-are-handed-back-to-the'),
      t('approval.releasing-submits-no-decision'),
    ]
    pushPageModal(
      pageModal({
        kind: 'approval-release-confirm',
        title: t('approval.release-terminal-approval'),
        content,
        actions: [
          { key: 'approval-release-cancel', action: 'approval-release-cancel', label: t('approval.cancel-keep-the-claim'), detail: '' },
          { key: 'approval-release-confirm', action: 'approval-release-confirm', label: t('approval.confirm-release-back-to-the-desktop'), detail: '' },
        ],
        footer: t('approval.enter-confirms-the-release-esc-cancels'),
        selectKey: 'approval-release-cancel',
      }),
    )
  }

  function pushApprovalRequestDetail(claim, request, session) {
    const content = [
      ...approvalRequestLines(request),
      t('approval.if-the-desktop-shows-the-same-request'),
      t('approval.submitting-only-means-the-terminal-accepted'),
    ]
    pushPageModal(
      pageModal({
        kind: 'approval-request-detail',
        title: t('approval.terminal-approval', { p1: request.toolName === null ? 'tool' : safeText(request.toolName, 60) }),
        content,
        actions: [
          { key: 'approval-allow', action: 'approval-allow', label: t('approval.allow-once'), detail: t('approval.allowed-once-this-request-only') },
          { key: 'approval-reject', action: 'approval-reject', label: t('approval.reject'), detail: t('approval.rejected-this-request-only') },
          { key: 'approval-refresh', action: 'approval-refresh', label: t('approval.refresh-the-terminal-approval-channel'), detail: '' },
          { key: 'approval-close', action: 'approval-close', label: t('approval.close-esc-submit-nothing'), detail: '' },
        ],
        footer: t('approval.scroll-enter-choose-an-action-esc-close'),
        selectKey: 'approval-close',
        claimId: claim.claimId,
        requestId: request.requestId,
        sessionId: session.sessionId,
      }),
    )
  }

  function pushApprovalDecisionConfirm(session, request, outcome) {
    const allow = outcome === 'allowed-once'
    const content = [
      t('approval.about-to-submit', { p1: allow ? t('msg.allow-once-allowed-once') : t('msg.reject-rejected') }),
      ...approvalRequestLines(request),
      allow
        ? t('approval.allow-once-applies-to-this-request-only-and')
        : t('approval.reject-applies-to-this-request-only-it'),
      t('approval.submitting-only-means-the-terminal-accepted-2'),
    ]
    pushPageModal(
      pageModal({
        kind: 'approval-confirm',
        title: allow ? t('approval.confirm-allow-once') : t('approval.confirm-reject'),
        content,
        actions: [
          { key: 'approval-decision-cancel', action: 'approval-decision-cancel', label: t('approval.cancel-submit-nothing'), detail: '' },
          {
            key: 'approval-decision-confirm',
            action: 'approval-decision-confirm',
            label: allow ? t('approval.confirm-submit-allow-once') : t('approval.confirm-submit-reject'),
            detail: '',
          },
        ],
        footer: t('approval.enter-confirms-the-submission-esc-cancels'),
        selectKey: 'approval-decision-cancel',
        claimId: state.approvalClaim?.claimId,
        requestId: request.requestId,
        outcome,
        sessionId: session.sessionId,
      }),
    )
  }

  async function submitApprovalDecisionNow(session, modal) {
    if (state.submitBusy !== null) {
      setNotice(t('hint.submitting'))
      return
    }
    const claim = state.approvalClaim
    const requestId = typeof modal?.requestId === 'string' ? modal.requestId : ''
    const outcome = modal?.outcome
    const allow = outcome === 'allowed-once'
    if (claim === null || claim.claimId !== modal?.claimId || requestId === '') {
      addError(session, t('approval.the-terminal-approval-claim-is-no-longer-3'))
      state.modals = []
      return
    }
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      addError(session, t('approval.unsupported-approval-outcome-nothing-was'))
      state.modals = []
      return
    }
    const active = activeSession()
    if (active === undefined || active.sessionId !== claim.sessionId) {
      addError(session, t('approval.the-session-changed-no-approval-was'))
      state.modals = []
      return
    }
    state.submitBusy = { kind: 'approval-answer', sessionKey: session.key }
    if (modal !== undefined) modal.footer = t('approval.checking-and-submitting-the-approval')
    requestRender()
    try {
      // Strict freshness: the request may have been answered on the desktop, or
      // its signal may have been aborted, between opening and confirming.
      await refreshApprovalChannel({ quiet: true })
      const current = state.approvalClaim
      if (current === null || current.claimId !== claim.claimId) {
        addError(session, t('approval.the-terminal-approval-claim-is-no-longer-4'))
        state.modals = []
        return
      }
      if (current.pending.some((request) => request.requestId === requestId) !== true) {
        addError(session, t('approval.the-request-was-handled-on-the-desktop'))
        state.modals = []
        return
      }
      const payload = requireOk(
        await adapter.submitApprovalDecision({ claimId: claim.claimId, requestId, outcome }),
        'approval-answer-failed',
      )
      if (
        payload.claimId !== claim.claimId ||
        payload.requestId !== requestId ||
        payload.outcome !== outcome
      ) {
        throw adapterPayloadError({
          code: 'request-not-pending',
          error: 'Host accepted the submit but did not confirm this request',
        })
      }
      if (state.approvalClaim !== null && state.approvalClaim.claimId === claim.claimId) {
        state.approvalClaim.pending = state.approvalClaim.pending.filter(
          (request) => request.requestId !== requestId,
        )
        state.approvalClaim.fetchedAt = Date.now()
      }
      state.modals = []
      systemNote(
        session,
        t('approval.approval-decision-submitted-request-waiting', { p1: allow ? t('msg.allow-once-allowed-once') : t('msg.reject-rejected'), p2: shortCallId(requestId) }),
      )
      setNotice(allow ? t('approval.allow-once-submitted-waiting-for-host') : t('approval.reject-submitted-waiting-for-host'), 8000)
      void refreshApprovalChannel({ quiet: true })
      startRemoteWatch(session, { reason: 'approval' })
    } catch (error) {
      const code = errorCodeOf(error)
      const message = errorMessageOf(error)
      if (code === 'claim-expired' || code === 'claim-mismatch' || code === 'channel-disposed') {
        clearApprovalClaim({
          note: t('approval.the-terminal-approval-claim-is-no-longer', { p1: code }),
        })
        state.modals = []
      } else if (code === 'request-not-pending' || code === 'already-settled') {
        if (state.approvalClaim !== null && state.approvalClaim.claimId === claim.claimId) {
          state.approvalClaim.pending = state.approvalClaim.pending.filter(
            (request) => request.requestId !== requestId,
          )
        }
        addError(session, t('approval.the-request-was-handled-on-the-desktop'))
        state.modals = []
        void refreshApprovalChannel({ quiet: true })
      } else if (
        code === 'outcome-not-supported' ||
        code === 'invalid-body' ||
        code === 'invalid-request' ||
        code === 'schema-invalid'
      ) {
        addError(session, t('approval.the-approval-decision-did-not-pass', { p1: message }))
        if (modal !== undefined) modal.footer = t('approval.submit-failed-choose-again')
        requestRender()
      } else if (code === 'channel-unavailable' || code === 'agent-registry-unavailable') {
        addError(session, t('approval.the-host-has-no-usable-terminal-approval', { p1: message }))
        state.modals = []
      } else {
        addError(session, t('approval.approval-submit-result-unknown-refresh-the', { p1: message }))
        state.modals = []
        void refreshApprovalChannel({ quiet: true })
      }
    } finally {
      state.submitBusy = null
      requestRender()
    }
  }

  function approvalChannelSection(session) {
    const claim = state.approvalClaim
    const content = []
    const actions = []
    if (approvalChannelAvailable() !== true) {
      return { content, actions, available: false }
    }
    if (claim === null) {
      content.push(t('approval.terminal-approval-channel-not-claimed'))
      content.push(t('approval.a-claim-covers-only-the-current-session-and'))
      content.push(t('approval.the-desktop-still-sees-the-requests-desktop'))
      content.push(
        t('approval.claiming-allows-rejects-nothing'),
      )
      actions.push({
        key: 'approval-claim',
        action: 'approval-claim',
        label: t('approval.claim-terminal-approval-for-the-current-2'),
        detail: t('approval.needs-a-second-confirmation-release-it-back'),
      })
    } else if (claim.sessionId === session.sessionId) {
      content.push(t('approval.terminal-approval-channel-claimed-claim', { p1: shortCallId(claim.claimId) }))
      content.push(
        t('approval.session-connection-lease-remaining-lease-ms', { p1: shortId(claim.sessionId), p2: claim.connected ? t('msg.connected') : t('msg.disconnected-waiting-for-reconnect-lease'), p3: formatLeaseRemaining(claim.expiresAt), p4: claim.leaseMs }),
      )
      content.push(t('approval.the-desktop-can-still-answer-at-the-same'))
      content.push(
        t('approval.this-lists-the-requests-this-session-still'),
      )
      if (claim.error !== '') content.push(t('approval.channel-error', { p1: claim.error }))
      if (claim.pending.length === 0) {
        content.push(t('approval.no-terminal-approval-requests-are-waiting'))
      } else {
        content.push(t('approval.waiting-max', { p1: claim.pending.length, p2: claim.maxPending }))
      }
      for (const request of claim.pending) {
        actions.push({
          key: `approval-request:${request.requestId}`,
          action: 'approval-request',
          requestId: request.requestId,
          label: t('approval.approval', { p1: request.toolName === null || request.toolName === '' ? 'tool' : safeText(request.toolName, 60) }),
          detail: `call ${shortCallId(request.callId)} · ${safeText(request.displayReason ?? request.reason ?? t('msg.no-reason'), 80)} · ${shortCallId(request.requestId)}`,
        })
      }
      actions.push({ key: 'approval-refresh', action: 'approval-refresh', label: t('approval.refresh-the-terminal-approval-channel'), detail: '' })
      actions.push({
        key: 'approval-release',
        action: 'approval-release',
        label: t('approval.release-back-to-the-desktop'),
        detail: t('approval.unanswered-requests-are-never-allowed'),
      })
    } else {
      const other = sessionForApprovalClaim()
      content.push(
        t('approval.terminal-approval-is-already-claimed-by', { p1: other === undefined ? '' : `（${shortId(other.sessionId)}）` }),
      )
      content.push(t('approval.this-cli-holds-only-one-terminal-claim-at-a'))
      actions.push({ key: 'approval-release', action: 'approval-release', label: t('approval.release-the-current-terminal-claim'), detail: '' })
    }
    return { content, actions, available: true }
  }

  function approvalRequestById(requestId) {
    const claim = state.approvalClaim
    if (claim === null) return undefined
    return claim.pending.find((request) => request.requestId === requestId)
  }

  function openApprovalRequestItem(item) {
    const claim = state.approvalClaim
    const session = activeSession()
    if (claim === null || session === undefined) {
      setNotice(t('msg.the-terminal-approval-claim-is-no-longer'))
      return
    }
    const request = approvalRequestById(String(item.requestId ?? ''))
    if (request === undefined) {
      setNotice(t('msg.the-request-was-handled-on-the-desktop'))
      void refreshApprovalChannel({ quiet: true })
      return
    }
    pushApprovalRequestDetail(claim, request, session)
  }

  function activateApprovalChoice(outcome) {
    const modal = topModal()
    const claim = state.approvalClaim
    const session = activeSession()
    if (modal === undefined || claim === null || session === undefined) {
      setNotice(t('msg.the-terminal-approval-claim-is-no-longer'))
      return
    }
    const request = approvalRequestById(String(modal.requestId ?? ''))
    if (request === undefined) {
      setNotice(t('approval.the-request-was-handled-on-the-desktop-2'))
      closeModal()
      void refreshApprovalChannel({ quiet: true })
      return
    }
    pushApprovalDecisionConfirm(session, request, outcome)
  }

  async function activateApprovalRefresh() {
    await refreshApprovalChannel({ quiet: false })
    const top = topModal()
    const session = activeSession()
    if (top !== undefined && top.kind === 'approvals' && session !== undefined) {
      rebuildModal(top)
      top.title = hasAttention(session) ? t('msg.pending-requests-action-needed') : t('msg.pending-requests')
      top.footer = approvalsFooter(session)
    }
    requestRender()
  }

  async function activateApprovalRelease(session, modal) {
    if (modal !== undefined) modal.footer = t('approval.releasing-terminal-approval')
    const released = await releaseApprovalClaim({ reason: 'user' })
    if (released === true) state.modals = []
    requestRender()
  }

  async function activateApprovalDecision(session, modal) {
    await submitApprovalDecisionNow(session, modal)
  }

  // --------------------------------------------------- pending input / answers

  function buildApprovalsItems(session) {
    const attention = sessionAttention(session)
    const content = [t('perm.session', { p1: shortId(session.sessionId) })]
    if (session.awaitingError !== '') content.push(t('perm.read-failed', { p1: session.awaitingError }))
    if (session.awaiting === null) {
      content.push(t('approval.the-host-returned-no-pending-state-older'))
    } else {
      const kinds = attention.kinds.length === 0 ? 'none' : attention.kinds.join(',')
      content.push(t('approval.running-pendinginput', { p1: session.awaiting.running ? t('msg.running') : t('msg.idle'), p2: kinds }))
      if (attention.approvals) {
        if (approvalChannelAvailable() !== true) {
          content.push(
            t('approval.approvals-are-pending-this-host-version-has'),
          )
        } else {
          content.push(
            t('approval.approvals-are-waiting-on-the-desktop-other'),
          )
        }
        if (session.awaiting.approvals.reason !== '') content.push(t('approval.host-note', { p1: session.awaiting.approvals.reason }))
      }
      if (attention.open.length > 0) {
        content.push(
          t('approval.open-question-s-are-blocking-tool-calls-and', { p1: attention.open.length }),
        )
      }
    }
    const channel = approvalChannelSection(session)
    if (channel.available === true) {
      content.push(...channel.content)
    } else if (attention.approvals) {
      content.push(t('approval.this-cli-host-does-not-support-the-terminal'))
    }
    if (
      channel.available !== true &&
      attention.active.length === 0 &&
      attention.approvals !== true &&
      attention.other !== true
    ) {
      content.push(t('approval.no-pending-approvals-or-questions'))
    }
    if (channel.available === true) {
      content.push(
        t('approval.tip-lists-the-requests-this-session-still'),
      )
    }
    const canSubmit = typeof adapter.submitAnswer === 'function'
    const actions = []
    if (channel.available === true) actions.push(...channel.actions)
    for (const batch of attention.active) {
      const first = batch.questions[0]
      const answerable = batch.state === 'continued' && canSubmit
      actions.push({
        key: `await-question:${batch.callId}`,
        action: 'awaiting-question',
        callId: batch.callId,
        label: `${answerable ? t('msg.answer') : t('msg.desktop-only')} · ${safeText(first.header ?? first.question, 60)}`,
        detail: t('approval.question-s-call', {
          p1: batch.questions.length,
          p2: shortCallId(batch.callId),
          p3: batch.state,
          p4: batch.state === 'continued' && canSubmit !== true ? t('msg.this-cli-cannot-submit') : '',
        }),
        batch,
      })
    }
    if (attention.other) {
      actions.push({
        key: 'await-other',
        action: 'awaiting-info',
        label: t('approval.other-pending-input-informational-only'),
        detail: t('approval.this-cli-does-not-handle-this-kind-of-input'),
      })
    }
    actions.push({ key: 'await-refresh', action: 'awaiting-refresh', label: t('approval.re-read-pending-requests'), detail: '' })
    actions.push({ key: 'await-close', action: 'awaiting-close', label: t('perm.close-esc'), detail: '' })
    return [...infoItems('await-info', content), ...actions]
  }

  function approvalsFooter(session) {
    const attention = sessionAttention(session)
    if (approvalChannelAvailable() !== true) {
      return attention.answerable.length > 0
        ? t('approval.select-enter-view-answer-esc-close')
        : t('approval.view-esc-close-handle-approvals-open')
    }
    if (attention.approvalRequests.length > 0) return t('approval.select-enter-view-reply-esc-close')
    if (attention.approvalClaimed) return t('approval.view-enter-act-esc-close-a-terminal-claim')
    return t('approval.view-enter-claim-answer-esc-close')
  }

  async function openApprovals() {
    const session = activeSession()
    if (session === undefined) return
    if (session.sessionId === '') {
      systemNote(session, t('approval.no-session-yet-it-is-created-on-the-first'))
      requestRender()
      return
    }
    if (state.submitBusy !== null) {
      setNotice(t('approval.submitting-please-wait-before-opening'))
      return
    }
    state.modals = []
    const modal = pushPageModal(
      pageModal({
        kind: 'approvals',
        title: t('approval.pending-requests-loading'),
        content: [t('perm.session', { p1: shortId(session.sessionId) }), t('approval.reading-pending-approvals-questions')],
        footer: t('perm.loading'),
      }),
    )
    if (typeof adapter.fetchAwaiting !== 'function') {
      modal.title = t('msg.pending-requests')
      modal.build = () => [
        ...infoItems('await-info', [
          t('perm.session', { p1: shortId(session.sessionId) }),
          t('approval.this-cli-host-cannot-read-pending-requests'),
        ]),
        { key: 'await-close', action: 'awaiting-close', label: t('perm.close-esc'), detail: '' },
      ]
      rebuildModal(modal)
      modal.footer = t('approval.esc-close')
      requestRender()
      return
    }
    await refreshAwaiting(session, { quiet: false })
    if (state.approvalClaim !== null && typeof adapter.fetchApprovalChannel === 'function') {
      await refreshApprovalChannel({ quiet: true })
    }
    if (state.stopped || state.finished || topModal() !== modal) return
    modal.build = () => buildApprovalsItems(session)
    rebuildModal(modal)
    modal.title = hasAttention(session) ? t('msg.pending-requests-action-needed') : t('msg.pending-requests')
    modal.footer = approvalsFooter(session)
    requestRender()
  }

  function questionBatchOf(session, callId) {
    return (session.awaiting?.questions?.active ?? []).find((batch) => batch.callId === callId)
  }

  function pushQuestionDetail(session, batch) {
    const content = [
      `callId：${batch.callId}`,
      t('question.state', { p1: batch.state, p2: batch.state === 'continued' ? t('msg.answerable') : t('msg.desktop-only-2') }),
    ]
    batch.questions.forEach((question, index) => {
      content.push(t('question.question', { p1: index + 1, p2: batch.questions.length, p3: question.header === undefined ? '' : ` · ${question.header}` }))
      content.push(question.question)
      if (question.detail !== undefined) content.push(t('question.detail', { p1: question.detail }))
      if (question.options !== undefined && question.options.length > 0) {
        content.push(
          t('question.options', { p1: question.options
            .map((option, optionIndex) => `${optionIndex + 1}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
            .join('\n') }),
        )
      } else {
        content.push(t('question.options-the-host-provided-no-preset-options'))
      }
      content.push(t('question.type', { p1: question.multiSelect ? t('msg.multi-select') : t('msg.single-select') }))
    })
    const canSubmit = typeof adapter.submitAnswer === 'function'
    if (batch.state === 'continued' && canSubmit) {
      content.push(t('question.the-answer-is-submitted-only-after-the'))
    } else if (batch.state === 'continued') {
      content.push(t('question.this-cli-cannot-submit-answers-dsh-ask'))
    } else {
      content.push(t('question.this-cli-version-cannot-answer-open'))
    }
    const actions = []
    if (batch.state === 'continued' && canSubmit) {
      actions.push({ key: 'question-start', action: 'question-start', label: t('question.start-answering'), detail: '' })
    }
    actions.push({ key: 'question-refresh', action: 'awaiting-refresh', label: t('approval.re-read-pending-requests'), detail: '' })
    return pushPageModal(
      pageModal({
        kind: 'question-detail',
        title: t('question.question-waiting', { p1: shortCallId(batch.callId) }),
        content,
        actions,
        footer:
          batch.state === 'continued'
            ? t('question.scroll-enter-start-answering-esc-back')
            : t('question.scroll-esc-back-desktop-only'),
        sessionId: session.sessionId,
        callId: batch.callId,
      }),
    )
  }

  function questionAnswerTitle(session) {
    const flow = session.questionFlow
    if (flow === null) return t('question.answer-question')
    return t('question.answer-question-2', { p1: flow.index + 1, p2: flow.batch.questions.length })
  }

  function questionAnswerFooter(session) {
    const flow = session.questionFlow
    const question = flow?.batch.questions[flow.index]
    return question?.multiSelect === true
      ? t('question.select-enter-check-finish-this-question-to')
      : t('question.select-enter-choose-and-continue-esc-cancel')
  }

  function firstQuestionActionIndex(modal) {
    const found = modal.items.findIndex((item) => item.key.startsWith('q-opt:') || item.key === 'q-custom')
    return found < 0 ? 0 : found
  }

  function buildQuestionAnswerItems(session) {
    const flow = session.questionFlow
    if (flow === null) return []
    const question = flow.batch.questions[flow.index]
    const draft = flow.drafts[flow.index]
    if (question === undefined || draft === undefined) return []
    const content = [
      t('question.question', { p1: flow.index + 1, p2: flow.batch.questions.length, p3: question.header === undefined ? '' : ` · ${question.header}` }),
      question.question,
      ...(question.detail === undefined ? [] : [t('question.detail', { p1: question.detail })]),
      t('question.type', { p1: question.multiSelect ? t('msg.multi-select-pick-several-optional-free') : t('msg.single-select-pick-one-or-use-free-text') }),
    ]
    const actions = []
    for (const [index, option] of (question.options ?? []).entries()) {
      const chosen =
        question.multiSelect === true ? draft.selected.includes(option.label) : draft.selected[0] === option.label
      actions.push({
        key: `q-opt:${index}`,
        action: 'question-option',
        optionIndex: index,
        label: `${question.multiSelect ? (chosen ? '[x]' : '[ ]') : chosen ? '(•)' : '( )'} ${safeText(option.label, 120)}`,
        detail: option.description === undefined ? '' : safeText(option.description, 200),
      })
    }
    actions.push({
      key: 'q-custom',
      action: 'question-custom',
      label: draft.custom === '' ? t('question.free-text-answer') : t('question.free-text-enter-to-edit', { p1: safeText(draft.custom, 60) }),
      detail: question.multiSelect ? t('question.free-text-is-added-to-the-multi-select') : t('question.using-free-text-clears-the-selected-options'),
    })
    if (question.multiSelect) {
      actions.push({
        key: 'q-done',
        action: 'question-done',
        label: t('question.finish-this-question-go-to-the-next'),
        detail: draft.selected.length === 0 ? t('question.no-option-checked-yet') : t('question.option-s-checked', { p1: draft.selected.length }),
      })
    }
    actions.push({
      key: 'q-skip',
      action: 'question-skip',
      label: t('question.skip-this-question-selected'),
      detail: '',
    })
    actions.push({ key: 'q-cancel', action: 'question-cancel', label: t('question.cancel-submit-nothing-esc'), detail: '' })
    return [...infoItems('qa-info', content), ...actions]
  }

  function beginQuestionAnswer(session, batch) {
    if (batch.state !== 'continued' || typeof adapter.submitAnswer !== 'function') {
      setNotice(batch.state === 'continued' ? t('question.this-cli-cannot-submit-answers') : t('question.this-question-can-only-be-answered-on-the'))
      return
    }
    if (session.answeredQuestions.has(batch.callId)) {
      setNotice(t('question.an-answer-for-this-question-was-already'))
      return
    }
    session.questionFlow = {
      sessionId: session.sessionId,
      batch,
      index: 0,
      drafts: batch.questions.map((question) => ({ id: question.id, selected: [], custom: '', skipped: false })),
    }
    const modal = pushPageModal(
      pageModal({
        kind: 'question-answer',
        title: questionAnswerTitle(session),
        actions: [],
        footer: questionAnswerFooter(session),
        build: () => buildQuestionAnswerItems(session),
      }),
    )
    rebuildModal(modal)
    modal.selected = firstQuestionActionIndex(modal)
    requestRender()
  }

  function pushQuestionInput(session) {
    const flow = session.questionFlow
    if (flow === null) return
    const question = flow.batch.questions[flow.index]
    const draft = flow.drafts[flow.index]
    if (question === undefined || draft === undefined) return
    const modal = pushPageModal(
      pageModal({
        kind: 'question-input',
        title: t('question.free-text-answer-question', { p1: flow.index + 1, p2: flow.batch.questions.length }),
        content: [t('question.question-2', { p1: question.question }), t('question.type-the-text-and-press-enter-to-use-it-esc')],
        footer: t('question.enter-uses-this-text-esc-cancels'),
      }),
    )
    modal.query = draft.custom
    // The echo row keeps the typed text visible (and wrapped) even though the
    // native page hides the caret for non-search pages.
    modal.build = () => [
      ...infoItems('qi-info', [t('question.question-2', { p1: question.question }), t('question.type-the-text-and-press-enter-to-use-it-esc')]),
      ...infoItems('qi-echo', [t('question.current-input', { p1: modal.query === '' ? t('msg.empty') : modal.query })]),
    ]
    rebuildModal(modal)
    requestRender()
  }

  function applyQuestionInput(modal) {
    const session = activeSession()
    const flow = session?.questionFlow
    if (flow === null || flow === undefined) {
      closeModal()
      return
    }
    const question = flow.batch.questions[flow.index]
    const draft = flow.drafts[flow.index]
    if (question === undefined || draft === undefined) {
      closeModal()
      return
    }
    const text = modal.query.trim()
    if (text === '') {
      setNotice(t('question.the-free-text-answer-cannot-be-empty-esc'))
      return
    }
    if (text.length > ANSWER_TEXT_MAX) {
      setNotice(t('question.the-free-text-answer-is-limited-to', { p1: ANSWER_TEXT_MAX }))
      return
    }
    draft.custom = text
    draft.selected = question.multiSelect === true ? draft.selected.slice() : []
    draft.skipped = false
    closeModal()
    advanceQuestion(session)
  }

  function handleQuestionInputKey(modal, event) {
    const refresh = () => {
      if (typeof modal.build === 'function') rebuildModal(modal)
      requestRender()
    }
    switch (event.name) {
      case 'escape':
        closeModal()
        return
      case 'enter':
        applyQuestionInput(modal)
        return
      case 'backspace':
        modal.query = modal.query.slice(0, -1)
        refresh()
        return
      case 'ctrl-u':
        modal.query = ''
        refresh()
        return
      case 'text':
      case 'paste': {
        const text = String(event.text ?? '')
          .replace(/\r\n?/g, ' ')
          .replace(/\s+/g, ' ')
        if (text === '') return
        if (modal.query.length + text.length > ANSWER_TEXT_MAX) {
          setNotice(t('question.the-free-text-answer-is-limited-to', { p1: ANSWER_TEXT_MAX }))
          return
        }
        modal.query += text
        refresh()
        return
      }
      default:
        return
    }
  }

  function advanceQuestion(session) {
    const flow = session.questionFlow
    if (flow === null) return
    flow.index += 1
    if (flow.index < flow.batch.questions.length) {
      const modal = topModal()
      if (modal !== undefined) {
        rebuildModal(modal)
        modal.selected = firstQuestionActionIndex(modal)
        modal.title = questionAnswerTitle(session)
        modal.footer = questionAnswerFooter(session)
      }
      requestRender()
      return
    }
    pushAnswerConfirm(session)
  }

  function describeDraft(question, draft) {
    if (draft.skipped === true) return t('question.skip-selected')
    const custom = String(draft.custom ?? '').trim()
    if (custom !== '') {
      return question.multiSelect === true
        ? t('question.options-free-text', { p1: draft.selected.length === 0 ? t('msg.none') : draft.selected.join('、'), p2: safeText(custom, 80) })
        : t('question.free-text', { p1: safeText(custom, 80) })
    }
    if (draft.selected.length === 0) return t('question.unanswered')
    return t('question.options-2', { p1: draft.selected.join('、') })
  }

  function pushAnswerConfirm(session) {
    const flow = session.questionFlow
    if (flow === null) return
    const content = [t('question.about-to-submit-the-answer-to-question-s', { p1: flow.batch.callId, p2: flow.batch.questions.length })]
    flow.batch.questions.forEach((question, index) => {
      content.push(t('question.question-3', { p1: index + 1, p2: describeDraft(question, flow.drafts[index]) }))
    })
    content.push(t('question.it-cannot-be-changed-after-submission-the'))
    pushPageModal(
      pageModal({
        kind: 'answer-confirm',
        title: t('question.confirm-answer-submission'),
        content,
        actions: [
          { key: 'answer-cancel', action: 'answer-cancel', label: t('approval.cancel-submit-nothing'), detail: '' },
          { key: 'answer-confirm', action: 'answer-confirm', label: t('question.confirm-answer-submission'), detail: '' },
        ],
        footer: t('question.enter-confirms-the-submission-esc-cancels'),
        selectKey: 'answer-cancel',
      }),
    )
  }

  /** Leave the whole answer flow without submitting anything. */
  function cancelQuestionFlow(session) {
    if (session !== undefined) session.questionFlow = null
    while (topModal() !== undefined) {
      const kind = topModal().kind
      if (kind !== 'answer-confirm' && kind !== 'question-answer' && kind !== 'question-input') break
      state.modals.pop()
    }
    setNotice(t('question.answer-cancelled-nothing-was-submitted'))
    requestRender()
  }

  function buildAnswerBatch(session) {
    const flow = session.questionFlow
    if (flow === null) return []
    const answers = []
    for (let index = 0; index < flow.batch.questions.length; index += 1) {
      const question = flow.batch.questions[index]
      const draft = flow.drafts[index]
      const custom = String(draft.custom ?? '').trim()
      if (custom.length > ANSWER_TEXT_MAX) {
        throw adapterPayloadError({
          code: 'invalid-answer',
          error: t('question.the-free-text-answer-to-question-exceeds', { p1: index + 1, p2: ANSWER_TEXT_MAX }),
        })
      }
      if (draft.skipped === true) {
        answers.push({ id: question.id, selected: [] })
        continue
      }
      if (custom === '' && draft.selected.length === 0) {
        throw adapterPayloadError({
          code: 'invalid-answer',
          error: t('question.question-is-not-answered-yet-pick-an-option', { p1: index + 1 }),
        })
      }
      const offered = new Set((question.options ?? []).map((option) => option.label))
      const selected = []
      for (const label of question.multiSelect === true ? draft.selected : draft.selected.slice(0, 1)) {
        if (offered.size > 0 && offered.has(label) !== true) {
          throw adapterPayloadError({
            code: 'label-not-offered',
            error: t('question.option-of-question-is-not-among-the-options', { p1: index + 1, p2: label }),
          })
        }
        if (selected.includes(label) !== true) selected.push(label)
      }
      const answer = {
        id: question.id,
        selected: question.multiSelect === true ? selected : custom === '' ? selected : [],
      }
      if (custom !== '') answer.custom = custom
      answers.push(answer)
    }
    return answers
  }

  async function submitQuestionAnswers(session, modal) {
    if (state.submitBusy !== null) {
      setNotice(t('hint.submitting'))
      return
    }
    const flow = session.questionFlow
    if (flow === null) {
      setNotice(t('question.the-answer-flow-was-cancelled'))
      return
    }
    const active = activeSession()
    if (active === undefined || active.sessionId !== flow.sessionId) {
      addError(session, t('question.the-session-changed-and-the-answer-was-not'))
      cancelQuestionFlow(session)
      return
    }
    state.submitBusy = { kind: 'answer', sessionKey: session.key, callId: flow.batch.callId }
    if (modal !== undefined) modal.footer = t('question.checking-and-submitting-the-answer-nothing')
    requestRender()
    try {
      const answers = buildAnswerBatch(session)
      // A local re-read keeps a request that already settled from being offered
      // again; the bridge independently re-reads immediately before writing.
      await refreshAwaiting(session, { quiet: true })
      const stillActive = questionBatchOf(session, flow.batch.callId)
      if (stillActive === undefined || stillActive.state !== 'continued') {
        session.answeredQuestions.add(flow.batch.callId)
        addError(session, t('question.the-request-expired-or-was-handled'))
        session.questionFlow = null
        state.modals = []
        requestRender()
        return
      }
      const payload = requireOk(
        await adapter.submitAnswer({ sessionId: session.sessionId, callId: flow.batch.callId, answers }),
        'answer-failed',
      )
      if (
        payload.accepted !== true ||
        payload.callId !== flow.batch.callId ||
        payload.sessionId !== session.sessionId
      ) {
        throw adapterPayloadError({
          code: 'stale-request',
          error: 'Host accepted the request but did not confirm this callId; treating it as unverified',
        })
      }
      session.answeredQuestions.add(flow.batch.callId)
      if (session.awaiting !== null) {
        session.awaiting = {
          ...session.awaiting,
          questions: {
            ...session.awaiting.questions,
            active: session.awaiting.questions.active.filter((batch) => batch.callId !== flow.batch.callId),
          },
        }
      }
      session.questionFlow = null
      state.modals = []
      systemNote(
        session,
        t('question.answer-submitted-call-question-s-the', { p1: shortCallId(flow.batch.callId), p2: answers.length }),
      )
      setNotice(t('question.answer-submitted-watching-real-remote'))
      void refreshAwaiting(session, { quiet: true })
      startRemoteWatch(session, { reason: 'answer' })
    } catch (error) {
      const code = errorCodeOf(error)
      const message = errorMessageOf(error)
      if (code === 'stale-request' || code === 'not-answerable') {
        session.answeredQuestions.add(flow.batch.callId)
        addError(session, t('question.the-request-expired-or-was-handled-2', { p1: code }))
        session.questionFlow = null
        state.modals = []
        void refreshAwaiting(session, { quiet: true })
        void refreshStatus(session)
      } else if (code === 'reply-queued') {
        addError(session, t('question.this-question-already-has-a-queued-reply'))
        session.questionFlow = null
        state.modals = []
        void refreshAwaiting(session, { quiet: true })
      } else if (code === 'invalid-answer' || code === 'label-not-offered') {
        addError(session, t('question.the-answer-did-not-pass-validation-edit-it', { p1: message }))
        if (modal !== undefined) modal.footer = t('question.submit-failed-edit-the-answer-and-confirm')
        requestRender()
      } else if (
        code === 'session-not-live' ||
        code === 'answer-unavailable' ||
        code === 'approval-answer-unsupported'
      ) {
        addError(session, t('question.the-host-refused-the-submission-it-may-need', { p1: message }))
        session.questionFlow = null
        state.modals = []
        void refreshAwaiting(session, { quiet: true })
      } else {
        addError(session, t('question.submit-result-unknown-reopen-approvals-to', { p1: message }))
        session.questionFlow = null
        state.modals = []
        void refreshAwaiting(session, { quiet: true })
      }
    } finally {
      state.submitBusy = null
      requestRender()
    }
  }

  // -------------------------------------------------- watching the real remote

  function stopWatch(sessionKey) {
    const watch = state.watches.get(sessionKey)
    if (watch === undefined) return
    watch.settled = true
    clearInterval(watch.timer)
    clearTimeout(watch.timeout)
    state.watches.delete(sessionKey)
  }

  function stopAllWatches() {
    for (const key of [...state.watches.keys()]) stopWatch(key)
  }

  function settleWatch(session, watch, outcome) {
    if (watch.settled !== true) {
      watch.settled = true
      clearInterval(watch.timer)
      clearTimeout(watch.timeout)
      if (state.watches.get(watch.sessionKey) === watch) state.watches.delete(watch.sessionKey)
    }
    if (outcome === 'done') {
      session.status = 'ready'
      session.remoteRunning = false
      systemNote(session, t('misc.the-remote-turn-completed-the-real-remote'))
      void refreshStatus(session)
      void refreshAwaiting(session, { quiet: true })
    } else if (outcome === 'attention') {
      systemNote(session, t('misc.the-remote-has-pending-requests-again-view'))
      setNotice(t('misc.the-remote-has-pending-requests-approvals'))
    } else if (outcome === 'timeout') {
      systemNote(session, t('misc.stopped-watching-the-remote-automatically'))
    }
    requestRender()
  }

  /**
   * After an answer is accepted, the remote turn may still be running. Watch the
   * real Session instead of re-sending the original prompt: poll status, adopt
   * the canonical transcript, and stop as soon as the remote is idle or asks for
   * another human decision.
   */
  function startRemoteWatch(session, { reason } = {}) {
    if (session === undefined || session.sessionId === '') return
    if (state.busy?.kind === 'turn' && state.busy.sessionKey === session.key) {
      // The in-flight turn already owns the remote wait; its own completion path
      // refreshes status. Nothing is re-sent here either.
      systemNote(session, t('misc.answer-submitted-this-turn-is-still-waiting'))
      requestRender()
      return
    }
    if (
      typeof adapter.fetchStatus !== 'function' &&
      typeof adapter.fetchTranscript !== 'function' &&
      typeof adapter.fetchAwaiting !== 'function'
    ) {
      systemNote(session, t('misc.this-cli-host-cannot-watch-the-remote'))
      requestRender()
      return
    }
    stopWatch(session.key)
    const watch = {
      sessionKey: session.key,
      sessionId: session.sessionId,
      reason: reason ?? 'resume',
      startedAt: Date.now(),
      count: 0,
      settled: false,
      timer: null,
      timeout: null,
    }
    state.watches.set(session.key, watch)
    const tick = async () => {
      if (watch.settled === true || state.stopped || state.finished) return
      if (Date.now() - watch.startedAt > state.watchTimeoutMs) {
        settleWatch(session, watch, 'timeout')
        return
      }
      watch.count += 1
      try {
        if (typeof adapter.fetchAwaiting === 'function') {
          const awaiting = await refreshAwaiting(session, { quiet: true })
          if (watch.settled === true) return
          const attention = sessionAttention(session)
          if (awaiting !== undefined && (attention.answerable.length > 0 || attention.open.length > 0 || attention.approvals)) {
            settleWatch(session, watch, 'attention')
            return
          }
        }
        let running = session.remoteRunning
        if (typeof adapter.fetchStatus === 'function') {
          try {
            const payload = await adapter.fetchStatus(session.sessionId)
            if (watch.settled === true) return
            const status = payload?.status
            if (status !== null && status !== undefined) {
              session.statusline = status
              if (typeof status.model?.model === 'string') session.model = status.model.model
              running = status.running === true
              session.remoteRunning = running
            }
          } catch {
            // A transient status read must not stop the watch; the timeout bounds it.
          }
        }
        if (running === false) {
          if (typeof adapter.fetchTranscript === 'function') {
            try {
              const payload = await adapter.fetchTranscript(session.sessionId, state.tail)
              if (watch.settled === true) return
              applyTranscript(session, payload)
              session.remoteRunning = payload.running === true
              if (payload.running === true) {
                if (session === activeSession()) requestRender()
                return
              }
            } catch {
              // Fall through to settle; /history remains available.
            }
          }
          settleWatch(session, watch, 'done')
          return
        }
        if (watch.count % 2 === 0 && typeof adapter.fetchTranscript === 'function') {
          try {
            const payload = await adapter.fetchTranscript(session.sessionId, state.tail)
            if (watch.settled === true) return
            applyTranscript(session, payload)
            session.remoteRunning = payload.running === true
          } catch {
            // Keep watching.
          }
        }
      } catch {
        // Keep watching; the timeout is the bound.
      }
      if (session === activeSession()) requestRender()
    }
    watch.timer = setInterval(() => {
      void tick()
    }, state.watchIntervalMs)
    watch.timer.unref?.()
    watch.timeout = setTimeout(() => settleWatch(session, watch, 'timeout'), state.watchTimeoutMs)
    watch.timeout.unref?.()
    void tick()
    requestRender()
  }

  // -------------------------------------------------------------------- modals

  function filteredItems(modal) {
    // Page modals built by the permission/approval flows are not search lists:
    // `query` is empty or (for the custom-text page) the typed answer itself.
    if (modal.filterable === false) return modal.items
    const query = modal.query.trim().toLowerCase()
    if (query === '') return modal.items
    return modal.items.filter((item) =>
      `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(query),
    )
  }

  function clampSelected(modal) {
    const count = filteredItems(modal).length
    if (count === 0) {
      modal.selected = 0
      return
    }
    if (modal.selected < 0) modal.selected = 0
    if (modal.selected >= count) modal.selected = count - 1
  }

  function topModal() {
    return state.modals.length > 0 ? state.modals[state.modals.length - 1] : undefined
  }

  function scopeLabelOf(scope) {
    if (scope === undefined || scope === null) return ''
    if (scope.mode === 'all') return t('msg.all-sessions')
    if (scope.mode === 'workspace') {
      const path = typeof scope.path === 'string' && scope.path !== '' ? scope.path : ''
      const title =
        typeof scope.title === 'string' && scope.title !== ''
          ? oneLine(scope.title, 60)
          : path !== ''
            ? oneLine(basenameOf(path), 60)
            : oneLine(String(scope.workspace ?? ''), 80)
      return path !== '' && path !== title ? `${title} · ${oneLine(path, 120)}` : title
    }
    return oneLine(String(scope.cwd ?? scope.dir ?? ''), 120)
  }

  /**
   * Default picker scope: explicit -w first, then the active Session's real
   * workspace/cwd (corrected by fetchSessionContext), then the CLI cwd.
   */
  function pickerDefaultScope(session) {
    if (typeof options.workspace === 'string' && options.workspace !== '') {
      return {
        mode: 'workspace',
        workspace: options.workspace,
        label: `workspace ${oneLine(options.workspace, 100)}`,
        dir: session?.cwd ?? state.baseCwd,
        source: '-w',
      }
    }
    const workspace = session?.workspace ?? null
    if (workspace !== null && typeof workspace === 'object') {
      const path = typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : undefined
      const id =
        typeof workspace.id === 'string' && workspace.id !== ''
          ? workspace.id
          : path !== undefined
            ? path
            : undefined
      if (id !== undefined) {
        const scope = {
          mode: 'workspace',
          workspace: id,
          ...(path === undefined ? {} : { path }),
          ...(typeof workspace.title === 'string' ? { title: workspace.title } : {}),
          dir: path ?? session?.cwd ?? state.baseCwd,
        }
        scope.label = scopeLabelOf(scope)
        return scope
      }
    }
    if (typeof session?.cwd === 'string' && session.cwd !== '') {
      const registeredCwdWorkspace = workspaceFor(state.workspaces, session.cwd)
      if (registeredCwdWorkspace !== undefined) {
        const path =
          typeof registeredCwdWorkspace.path === 'string' && registeredCwdWorkspace.path !== ''
            ? registeredCwdWorkspace.path
            : session.cwd
        const scope = {
          mode: 'workspace',
          workspace:
            typeof registeredCwdWorkspace.id === 'string' && registeredCwdWorkspace.id !== ''
              ? registeredCwdWorkspace.id
              : path,
          path,
          ...(typeof registeredCwdWorkspace.title === 'string' ? { title: registeredCwdWorkspace.title } : {}),
          dir: path,
        }
        scope.label = scopeLabelOf(scope)
        return scope
      }
      return { mode: 'cwd', cwd: session.cwd, label: scopeLabelOf({ mode: 'cwd', cwd: session.cwd }), dir: session.cwd }
    }
    const registered = workspaceFor(state.workspaces, state.baseCwd)
    if (registered !== undefined) {
      const path =
        typeof registered.path === 'string' && registered.path !== '' ? registered.path : state.baseCwd
      const scope = {
        mode: 'workspace',
        workspace:
          typeof registered.id === 'string' && registered.id !== '' ? registered.id : path,
        path,
        ...(typeof registered.title === 'string' ? { title: registered.title } : {}),
        dir: path,
      }
      scope.label = scopeLabelOf(scope)
      return scope
    }
    return {
      mode: 'cwd',
      cwd: state.baseCwd,
      label: scopeLabelOf({ mode: 'cwd', cwd: state.baseCwd }),
      dir: state.baseCwd,
    }
  }

  function pickerScopeRequest(modal) {
    if (modal.scope.mode === 'all') return { limit: 20, all: true }
    if (modal.scope.mode === 'workspace') {
      return { limit: 20, workspace: modal.scope.workspace }
    }
    return { limit: 20, cwd: modal.scope.cwd }
  }

  /** Adopt the canonical scope the Host reports for the request. */
  function applyPickerScopeResult(modal, scope) {
    if (scope === null || typeof scope !== 'object') return
    if (scope.type === 'all') {
      modal.scope = { mode: 'all', label: t('msg.all-sessions'), dir: modal.defaultScope.dir ?? state.baseCwd }
      return
    }
    if (scope.type === 'workspace' && scope.workspace !== null && typeof scope.workspace === 'object') {
      const path = typeof scope.workspace.path === 'string' && scope.workspace.path !== '' ? scope.workspace.path : undefined
      const id =
        typeof scope.workspace.id === 'string' && scope.workspace.id !== ''
          ? scope.workspace.id
          : (path ?? modal.scope.workspace)
      const next = {
        mode: 'workspace',
        workspace: id,
        ...(path === undefined ? {} : { path }),
        ...(typeof scope.workspace.title === 'string' ? { title: scope.workspace.title } : {}),
        dir: path ?? modal.scope.dir ?? state.baseCwd,
      }
      next.label = scopeLabelOf(next)
      modal.scope = next
      return
    }
    if (scope.type === 'cwd' && typeof scope.cwd === 'string' && scope.cwd !== '') {
      modal.scope = {
        mode: 'cwd',
        cwd: scope.cwd,
        label: scopeLabelOf({ mode: 'cwd', cwd: scope.cwd }),
        dir: scope.cwd,
      }
    }
  }

  function pickerScopeErrorMessage(code, message, modal) {
    switch (code) {
      case 'no-such-workspace':
        return t('picker.workspace-not-found-keeping-the-current', { p1: oneLine(String(modal.scope.workspace ?? modal.defaultScope.workspace ?? ''), 100) })
      case 'invalid-query':
        return t('picker.the-host-rejected-the-scope-argument-not')
      case 'ambiguous-session':
      case 'no-such-session':
        return t('picker.session-scope-resolution-failed-not-falling', { p1: code })
      case 'network-error':
        return t('picker.failed-to-read-the-session-scope-keeping')
      default:
        return t('picker.failed-to-read-the-session-list-not-falling', { p1: code === '' ? 'unknown' : code, p2: message })
    }
  }

  async function pickerFallbackRows(modal) {
    modal.degraded = true
    modal.scopeSupported = false
    modal.rows = typeof adapter.listSessions === 'function' ? await adapter.listSessions(20) : []
  }

  /** Fetch rows for the modal's current scope; never silently widen a -w miss. */
  async function loadPickerRows(modal) {
    modal.scopeError = ''
    modal.degraded = false
    modal.scopeSupported = typeof adapter.listSessionsScoped === 'function'
    try {
      if (modal.scopeSupported !== true) {
        await pickerFallbackRows(modal)
        return
      }
      const result = await adapter.listSessionsScoped(pickerScopeRequest(modal))
      modal.rows = Array.isArray(result?.rows) ? result.rows : []
      if (result?.supported !== true) {
        await pickerFallbackRows(modal)
        return
      }
      applyPickerScopeResult(modal, result.scope)
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === 'workspace-scope-unsupported') {
        await pickerFallbackRows(modal)
        return
      }
      modal.rows = []
      modal.scopeError = pickerScopeErrorMessage(code, errorMessageOf(error), modal)
    }
  }

  function pickerToggleItem(modal) {
    if (modal.scopeSupported !== true) return null
    const label =
      modal.scope.mode === 'all'
        ? t('picker.scope-all-sessions-enter-shows-only', { p1: oneLine(modal.defaultScope.label, 80) })
        : t('picker.scope-enter-shows-all-sessions', { p1: oneLine(modal.scope.label, 100) })
    return {
      key: 'picker:scope',
      action: 'toggle-scope',
      label,
      detail:
        modal.scope.mode === 'all'
          ? t('picker.explicitly-restore-the-default-workspace')
          : t('picker.explicitly-switch-to-all-sessions-no'),
    }
  }

  function pickerScopeDirectory(modal) {
    return modal?.scope?.dir ?? activeSession()?.cwd ?? state.baseCwd
  }

  function newSessionDetail(modal) {
    if (typeof options.workspace === 'string' && options.workspace !== '') {
      return t('picker.workspace-created-on-the-first-send', { p1: oneLine(options.workspace, 100) })
    }
    const directory = oneLine(pickerScopeDirectory(modal), 120)
    if (modal?.scope?.mode === 'workspace') {
      return t('picker.created-on-the-first-send', { p1: oneLine(modal.scope.label, 100), p2: directory })
    }
    return t('picker.created-on-the-first-send-2', { p1: directory })
  }

  function buildPickerItems(rows, modal) {
    const items = [
      {
        key: 'picker:new',
        label: t('picker.newSession'),
        detail: newSessionDetail(modal),
        newConversation: true,
      },
    ]
    const toggle = pickerToggleItem(modal)
    if (toggle !== null) items.push(toggle)
    if (modal.degraded === true) {
      items.push({
        key: 'picker:degraded',
        label: t('picker.this-host-does-not-support-scope-filtering'),
        detail: t('picker.updating-the-host-bridge-restores-workspace'),
        readOnly: true,
      })
    }
    if (modal.scopeError !== '') {
      items.push({
        key: 'picker:scope-error',
        label: `⚠ ${modal.scopeError}`,
        detail: t('picker.keep-the-current-scope-never-silently'),
        readOnly: true,
      })
    }
    for (const row of rows) {
      const flags = [row.running === true ? 'running' : '', row.blank === true ? 'blank' : '']
        .filter(Boolean)
        .join(',')
      const label =
        typeof row.title === 'string' && row.title !== ''
          ? oneLine(row.title, 120)
          : row.blank === true
            ? t('picker.empty-session')
            : row.preview === '' || row.preview === undefined
              ? t('picker.no-prompt')
              : oneLine(row.preview, 120)
      const detailParts = [shortId(row.sessionId)]
      if (typeof row.cwd === 'string' && row.cwd !== '') detailParts.push(oneLine(row.cwd, 120))
      if (flags !== '') detailParts.push(flags)
      items.push({
        key: `picker:session:${String(row.sessionId)}`,
        label,
        detail: detailParts.join(' · '),
        sessionId: String(row.sessionId),
      })
    }
    if (rows.length === 0 && modal.scopeError === '' && modal.degraded !== true) {
      items.push({
        key: 'picker:empty',
        label: t('picker.no-sessions-in-the-current-scope'),
        detail: t('picker.start-a-local-new-conversation-right-away'),
        readOnly: true,
      })
    }
    return items
  }

  async function openPicker({ initial = false } = {}) {
    if (state.submitBusy !== null) {
      setNotice(t('picker.submitting-permissions-answers-please-wait'))
      return
    }
    const current = topModal()
    if (current !== undefined && current.kind === 'sessions' && current.initial === false && initial === false) {
      await refreshPickerItems(current)
      return
    }
    if (current !== undefined && current.kind === 'sessions' && current.initial === true && initial === true) {
      await refreshPickerItems(current)
      return
    }
    const previous = activeSession()
    if (previous !== undefined) previous.questionFlow = null
    const defaultScope = pickerDefaultScope(previous)
    state.modals = []
    const modal = {
      kind: 'sessions',
      initial,
      title: initial ? t('picker.select-a-session') : t('picker.switch-session'),
      items: [],
      selected: 0,
      query: '',
      footer: initial
        ? t('picker.select-enter-resume-switch-scope-type-to')
        : t('picker.select-enter-switch-switch-scope-type-to'),
      useOptionsForNew: initial,
      defaultScope: { ...defaultScope },
      scope: { ...defaultScope },
      rows: [],
      scopeError: '',
      degraded: false,
      scopeSupported: true,
    }
    state.modals.push(modal)
    if (initial === false) state.phase = state.activeKey === null ? 'pick' : 'chat'
    requestRender()
    await refreshPickerItems(modal)
    modal.selected = initial ? 0 : Math.max(0, indexOfActive(modal.items))
    clampSelected(modal)
    requestRender()
  }

  async function refreshPickerItems(modal) {
    const previous = filteredItems(modal)[modal.selected]
    const previousKey =
      previous?.key ??
      (previous?.sessionId === undefined ? undefined : `picker:session:${String(previous.sessionId)}`)
    await loadPickerRows(modal)
    modal.items = buildPickerItems(modal.rows, modal)
    let restored = -1
    if (previousKey !== undefined) {
      restored = modal.items.findIndex((item) => item.key === previousKey)
    }
    if (restored >= 0) modal.selected = restored
    else if (modal.selected > modal.items.length - 1) modal.selected = Math.max(0, modal.items.length - 1)
    clampSelected(modal)
    requestRender()
  }

  async function togglePickerScope(modal) {
    if (modal.scopeSupported !== true) return
    if (modal.scope.mode === 'all') {
      modal.scope = { ...modal.defaultScope }
    } else {
      modal.scope = {
        mode: 'all',
        label: t('msg.all-sessions'),
        dir: modal.defaultScope.dir ?? activeSession()?.cwd ?? state.baseCwd,
      }
    }
    modal.selected = 0
    await refreshPickerItems(modal)
  }

  function indexOfActive(items) {
    if (state.activeKey === null) return 0
    const found = items.findIndex((item) => item.sessionId === state.activeKey)
    return found < 0 ? 0 : found
  }

  function closeModal() {
    const modal = state.modals.pop()
    if (modal === undefined) return
    // Codex resume picker: Esc means "start a new conversation", not "quit".
    // It only applies to the picker that owns the whole first screen, and it
    // follows the same -w rule as a bare start.
    if (modal.kind === 'sessions' && modal.initial === true) {
      void startDraftSession({ useOptions: draftUseOptions() })
      return
    }
    // Closing the last answer-flow page abandons the unfinished answer; nothing
    // was submitted, so the request stays pending and can be opened again.
    if (modal.kind === 'answer-confirm' || modal.kind === 'question-answer' || modal.kind === 'question-input') {
      const stillInside = state.modals.some(
        (entry) =>
          entry.kind === 'answer-confirm' || entry.kind === 'question-answer' || entry.kind === 'question-input',
      )
      if (stillInside !== true) {
        const session = activeSession()
        if (session !== undefined) session.questionFlow = null
      }
    }
    if (state.modals.length === 0 && state.activeKey === null) state.phase = 'pick'
    requestRender()
  }

  async function activateModalItem() {
    const modal = topModal()
    if (modal === undefined) return
    const items = filteredItems(modal)
    const item = items[modal.selected]
    if (item === undefined) {
      setNotice(t('misc.no-matching-items'))
      return
    }
    if (modal.kind === 'help') {
      // Help can sit on top of the picker; Enter closes only the help window.
      closeModal()
      return
    }
    if (modal.kind !== 'sessions') {
      await activatePageItem(modal, item)
      return
    }
    if (item.readOnly === true) {
      setNotice(item.label)
      return
    }
    if (item.action === 'toggle-scope') {
      await togglePickerScope(modal)
      return
    }
    const scopeDirectory = pickerScopeDirectory(modal)
    state.modals = []
    requestRender()
    if (item.newConversation === true) {
      await startDraftSession({ useOptions: draftUseOptions(), cwd: scopeDirectory })
      return
    }
    if (item.sessionId === undefined) {
      setNotice(t('misc.this-entry-has-no-session-to-resume'))
      return
    }
    await switchTo(String(item.sessionId))
  }

  // -------------------------------------------------- page-modal action handlers

  function activatePermissionPreset(item) {
    const session = activeSession()
    if (session === undefined) return
    if (session.permissions === null) {
      setNotice(t('perm.permission-presets-are-not-loaded-yet-re'))
      return
    }
    if (session.permissions.canSet !== true) {
      setNotice(t('perm.this-host-is-read-only-and-cannot-switch'))
      return
    }
    if (typeof adapter.submitPermission !== 'function') {
      setNotice(t('perm.this-cli-cannot-submit-permission-switches'))
      return
    }
    const value = String(item.value ?? '')
    if (value === '') return
    if (session.permissions.options.some((option) => option.value === value) !== true) {
      setNotice(t('perm.the-host-catalog-has-no-such-preset-nothing'))
      return
    }
    if (value === session.permissions.currentValue) {
      setNotice(t('perm.already-nothing-was-submitted', { p1: value }))
      return
    }
    pushPermissionConfirm(session, value)
  }

  async function activatePermissionConfirm(item, dangerous) {
    const session = activeSession()
    if (session === undefined) return
    const value = String(topModal()?.value ?? item.value ?? '')
    if (value === '') return
    if (dangerous === true && CONFIRMED_PRESETS.has(value)) {
      pushPermissionConfirmDanger(session, value)
      return
    }
    await submitPermissionChange(session, value, false)
  }

  async function activatePermissionConfirm2(item) {
    const session = activeSession()
    if (session === undefined) return
    const value = String(topModal()?.value ?? item.value ?? '')
    if (value === '') return
    await submitPermissionChange(session, value, true)
  }

  async function activateAwaitingRefresh() {
    const session = activeSession()
    if (session === undefined) return
    await refreshAwaiting(session, { quiet: false })
    const modal = topModal()
    const list = state.modals.find((entry) => entry.kind === 'approvals')
    if (list !== undefined) {
      rebuildModal(list)
      list.title = hasAttention(session) ? t('msg.pending-requests-action-needed') : t('msg.pending-requests')
      list.footer = approvalsFooter(session)
    }
    if (modal !== undefined && modal.kind === 'question-detail') {
      const batch = questionBatchOf(session, String(modal.callId ?? ''))
      if (batch === undefined) {
        closeModal()
        setNotice(t('msg.the-request-is-no-longer-pending-refreshed'))
        return
      }
    }
    requestRender()
  }

  async function activateAwaitingQuestion(item) {
    const session = activeSession()
    if (session === undefined) return
    const batch = questionBatchOf(session, String(item.callId ?? '')) ?? item.batch
    if (batch === undefined) {
      setNotice(t('msg.the-request-is-no-longer-pending-refreshed'))
      await activateAwaitingRefresh()
      return
    }
    pushQuestionDetail(session, batch)
  }

  async function activateQuestionStart(modal) {
    const session = activeSession()
    if (session === undefined) return
    const batch = questionBatchOf(session, String(modal?.callId ?? ''))
    if (batch === undefined) {
      setNotice(t('attention.the-request-is-no-longer-pending-pending'))
      closeModal()
      return
    }
    beginQuestionAnswer(session, batch)
  }

  function activateQuestionOption(modal, item) {
    const session = activeSession()
    const flow = session?.questionFlow
    if (flow === null || flow === undefined) return
    const question = flow.batch.questions[flow.index]
    const draft = flow.drafts[flow.index]
    const option = question?.options?.[Number(item.optionIndex)]
    if (option === undefined || draft === undefined) return
    const selectedKey = item.key
    if (question.multiSelect === true) {
      draft.selected = draft.selected.includes(option.label)
        ? draft.selected.filter((label) => label !== option.label)
        : [...draft.selected, option.label]
      draft.skipped = false
      rebuildModal(modal)
      const found = modal.items.findIndex((entry) => entry.key === selectedKey)
      if (found >= 0) modal.selected = found
      modal.footer = questionAnswerFooter(session)
      requestRender()
      return
    }
    draft.selected = [option.label]
    draft.custom = ''
    draft.skipped = false
    advanceQuestion(session)
  }

  function activateQuestionDone() {
    const session = activeSession()
    const flow = session?.questionFlow
    if (flow === null || flow === undefined) return
    const draft = flow.drafts[flow.index]
    if (draft.selected.length === 0 && String(draft.custom ?? '').trim() === '') {
      setNotice(t('question.multi-select-needs-at-least-one-option-or'))
      return
    }
    advanceQuestion(session)
  }

  function activateQuestionSkip() {
    const session = activeSession()
    const flow = session?.questionFlow
    if (flow === null || flow === undefined) return
    const draft = flow.drafts[flow.index]
    draft.selected = []
    draft.custom = ''
    draft.skipped = true
    advanceQuestion(session)
  }

  async function activatePageItem(modal, item) {
    if (item.readOnly === true) {
      setNotice(t('misc.scroll-to-view-enter-only-acts-on-action'))
      return
    }
    switch (item.action) {
      case 'permissions-refresh':
        await openPermissions()
        return
      case 'permissions-close':
      case 'awaiting-close':
        closeModal()
        return
      case 'permission-preset':
        activatePermissionPreset(item)
        return
      case 'permission-cancel':
        closeModal()
        return
      case 'permission-confirm':
        await activatePermissionConfirm(item, false)
        return
      case 'permission-confirm-danger':
        await activatePermissionConfirm(item, true)
        return
      case 'permission-confirm-2':
        await activatePermissionConfirm2(item)
        return
      case 'awaiting-refresh':
        await activateAwaitingRefresh()
        return
      case 'awaiting-question':
        await activateAwaitingQuestion(item)
        return
      case 'awaiting-info':
        setNotice(t('misc.this-cli-does-not-handle-this-kind-of'))
        return
      case 'question-start':
        await activateQuestionStart(modal)
        return
      case 'question-option':
        activateQuestionOption(modal, item)
        return
      case 'question-custom':
        pushQuestionInput(activeSession())
        return
      case 'question-done':
        activateQuestionDone()
        return
      case 'question-skip':
        activateQuestionSkip()
        return
      case 'question-cancel':
      case 'answer-cancel':
        cancelQuestionFlow(activeSession())
        return
      case 'answer-confirm':
        await submitQuestionAnswers(activeSession(), modal)
        return
      case 'approval-claim':
        pushApprovalClaimConfirm(activeSession())
        return
      case 'approval-claim-cancel':
        closeModal()
        return
      case 'approval-claim-confirm':
        await submitApprovalClaim(activeSession(), modal)
        return
      case 'approval-release':
        pushApprovalReleaseConfirm()
        return
      case 'approval-release-cancel':
        closeModal()
        return
      case 'approval-release-confirm':
        await activateApprovalRelease(activeSession(), modal)
        return
      case 'approval-request':
        openApprovalRequestItem(item)
        return
      case 'approval-allow':
        activateApprovalChoice('allowed-once')
        return
      case 'approval-reject':
        activateApprovalChoice('rejected')
        return
      case 'approval-decision-cancel':
        closeModal()
        return
      case 'approval-decision-confirm':
        await activateApprovalDecision(activeSession(), modal)
        return
      case 'approval-refresh':
        await activateApprovalRefresh()
        return
      case 'approval-close':
        closeModal()
        return
      default:
        setNotice(t('misc.this-action-is-not-available-in-this'))
        return
    }
  }

  // ------------------------------------------------------------ data loading

  async function refreshRows() {
    try {
      state.rows = await adapter.listSessions(20)
      state.rowsError = ''
    } catch (error) {
      state.rowsError = String(error?.message ?? error)
      if (state.rows.length === 0) state.rows = []
    }
    applyRowsToSessions()
    return state.rows
  }

  async function refreshWorkspaces() {
    if (typeof adapter.listWorkspaces !== 'function') return
    try {
      const rows = await adapter.listWorkspaces()
      if (Array.isArray(rows)) state.workspaces = rows
      for (const session of state.sessions.values()) {
        if (session.cwd !== '') session.project = projectOf(session.cwd)
      }
    } catch {
      // Project names are a convenience; a failure must not block the TUI.
    }
  }

  function rowFor(sessionId) {
    return state.rows.find((row) => row.sessionId === sessionId)
  }

  /**
   * Correct a Session's real cwd/workspace from the Host header instead of the
   * possibly stale row that opened it (e.g. a conversation opened from another
   * workspace must not keep showing that workspace). Old Hosts without the
   * scoped endpoint simply keep the list row.
   */
  async function refreshSessionContext(session) {
    if (
      session === undefined ||
      session.sessionId === '' ||
      typeof adapter.fetchSessionContext !== 'function'
    ) {
      return
    }
    const seq = (session.contextSeq = (session.contextSeq ?? 0) + 1)
    try {
      const context = await adapter.fetchSessionContext(session.sessionId)
      if (state.stopped || state.finished || session.contextSeq !== seq) return
      if (typeof context?.cwd === 'string' && context.cwd !== '') {
        session.cwd = context.cwd
        session.project = projectOf(context.cwd)
      }
      if (context?.workspace !== null && typeof context?.workspace === 'object') {
        session.workspace = {
          ...(typeof context.workspace.id === 'string' ? { id: context.workspace.id } : {}),
          ...(typeof context.workspace.path === 'string' ? { path: context.workspace.path } : {}),
          ...(typeof context.workspace.title === 'string' ? { title: context.workspace.title } : {}),
        }
        if (typeof session.workspace.title === 'string' && session.workspace.title !== '') {
          session.project = oneLine(session.workspace.title, 80)
        }
      }
      if (session === activeSession()) requestRender()
    } catch {
      // workspace-scope-unsupported / old Host: keep the row-derived cwd.
    }
  }

  async function loadSession(reference, { fetchHistory = true } = {}) {
    await releaseApprovalForContextChange()
    const previous = activeSession()
    if (previous !== undefined) previous.questionFlow = null
    const session = createSessionState({ sessionId: String(reference), key: String(reference) })
    state.sessions.set(session.key, session)
    state.activeKey = session.key
    state.phase = 'chat'
    state.hadSession = true
    session.status = 'loading'
    requestRender()
    let resolvedId = String(reference)
    try {
      if (fetchHistory === true) {
        const payload = await adapter.fetchTranscript(reference, state.tail)
        resolvedId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : String(reference)
        if (resolvedId !== session.key && state.sessions.has(resolvedId) === false) {
          state.sessions.delete(session.key)
          session.key = resolvedId
          session.sessionId = resolvedId
          state.sessions.set(resolvedId, session)
          state.activeKey = resolvedId
        }
        session.sessionId = resolvedId
        applyTranscript(session, payload)
        session.remoteRunning = payload.running === true
      } else {
        session.sessionId = resolvedId
      }
      const row = rowFor(resolvedId)
      if (row !== undefined) applyRow(session, row)
      await refreshSessionContext(session)
      session.status = 'ready'
      session.loaded = true
      void refreshStatus(session)
      void refreshAwaiting(session, { quiet: true })
    } catch (error) {
      session.status = 'error'
      addError(session, t('misc.cannot-open-session', { p1: shortId(reference), p2: String(error?.message ?? error) }))
      if (fetchHistory === true) systemNote(session, t('misc.you-can-pick-another-session-from-the'))
    }
    requestRender()
    return session
  }

  function applyTranscript(session, payload) {
    const items = payload.items ?? []
    const messages = []
    if (payload.more === true && items[0]?.kind !== 'user') {
      messages.push({ role: 'system', text: t('misc.earlier-messages-omitted') })
    }
    for (const item of items) {
      if (item?.kind === 'user') {
        messages.push({ role: 'user', text: stripEscapes(String(item.text ?? '')) })
      } else if (item?.kind === 'assistant') {
        messages.push({ role: 'assistant', text: stripEscapes(String(item.text ?? '')) })
      } else if (item?.kind === 'tool-call') {
        messages.push({
          role: 'system',
          text: `⚙ ${oneLine(item.name ?? 'tool', 60)} ${stripEscapes(argSummary(item.arguments))}`,
        })
      } else if (item?.kind === 'tool-result') {
        const line = stripEscapes(firstLine(item.text))
        if (line !== '') messages.push({ role: 'system', text: `${item.ok === false ? '✗' : '✓'} ${line}` })
      }
    }
    session.messages = messages
    session.more = payload.more === true
  }

  async function switchTo(sessionId) {
    if (state.busy !== null) {
      busyBlocked()
      return
    }
    if (state.submitBusy !== null) {
      setNotice(t('picker.submitting-permissions-answers-please-wait'))
      return
    }
    await releaseApprovalForContextChange()
    const previous = activeSession()
    if (previous !== undefined) previous.questionFlow = null
    const existing = state.sessions.get(sessionId)
    state.modals = []
    if (existing !== undefined) {
      state.activeKey = sessionId
      state.phase = 'chat'
      state.hadSession = true
      requestRender()
      await refreshSessionContext(existing)
      void refreshStatus(existing)
      void refreshAwaiting(existing, { quiet: true })
      return
    }
    const session = createSessionState({ sessionId, key: sessionId })
    const row = rowFor(sessionId)
    if (row !== undefined) applyRow(session, row)
    state.sessions.set(sessionId, session)
    state.activeKey = sessionId
    state.phase = 'chat'
    state.hadSession = true
    session.status = 'loading'
    requestRender()
    try {
      const payload = await adapter.fetchTranscript(sessionId, state.tail)
      session.sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : sessionId
      if (session.sessionId !== sessionId && state.sessions.has(session.sessionId) === false) {
        state.sessions.delete(sessionId)
        session.key = session.sessionId
        state.sessions.set(session.sessionId, session)
        state.activeKey = session.sessionId
      }
      applyTranscript(session, payload)
      session.remoteRunning = payload.running === true
      session.status = 'ready'
      session.loaded = true
      if (row === undefined) {
        await refreshRows()
        const fresh = rowFor(session.sessionId)
        if (fresh !== undefined) applyRow(session, fresh)
      }
      await refreshSessionContext(session)
      if (session.remoteRunning === true) systemNote(session, t('misc.the-remote-session-may-still-be-running'))
      void refreshStatus(session)
      void refreshAwaiting(session, { quiet: true })
    } catch (error) {
      session.status = 'error'
      addError(session, t('misc.cannot-open-session', { p1: shortId(sessionId), p2: String(error?.message ?? error) }))
    }
    requestRender()
  }

  async function switchByReference(reference) {
    const text = String(reference ?? '').trim()
    if (text === '') {
      await openPicker({ initial: false })
      return
    }
    if (state.rows.length === 0) await refreshRows()
    const ids = state.rows.map((row) => String(row.sessionId))
    if (ids.includes(text)) {
      await switchTo(text)
      return
    }
    const matches = ids.filter((id) => id.startsWith(text))
    if (matches.length === 1) {
      await switchTo(matches[0])
      return
    }
    if (matches.length > 1) {
      const session = activeSession()
      if (session !== undefined) addError(session, t('misc.sessions-start-with-give-a-longer-prefix', { p1: matches.length, p2: text }))
      return
    }
    // Nothing in the last listing: refresh once, then let the bridge resolve the
    // reference itself (it accepts a full id or an unambiguous prefix) instead
    // of claiming the Session does not exist.
    await refreshRows()
    const refreshed = state.rows.map((row) => String(row.sessionId))
    const refreshedMatches = refreshed.filter((id) => id.startsWith(text))
    if (refreshedMatches.length === 1) {
      await switchTo(refreshedMatches[0])
      return
    }
    if (refreshed.includes(text)) {
      await switchTo(text)
      return
    }
    if (refreshedMatches.length > 1) {
      const session = activeSession()
      if (session !== undefined) addError(session, t('misc.sessions-start-with-give-a-longer-prefix', { p1: refreshedMatches.length, p2: text }))
      return
    }
    if (text.length >= 4) {
      await switchTo(text)
      return
    }
    const session = activeSession()
    if (session !== undefined) addError(session, t('misc.no-session-found-for', { p1: text }))
  }

  function isDraftSession(session) {
    return session !== undefined && session.sessionId === ''
  }

  /** Every new TTY conversation honours an explicit -w/--create-workspace. */
  const draftUseOptions = () => options.workspace !== undefined || options.createWorkspace === true

  /** The single place a created draft becomes a real Host Session. */
  function applyCreatedSession(session, created) {
    const createdId = typeof created?.sessionId === 'string' ? created.sessionId : String(created?.sessionId ?? '')
    if (createdId === '') {
      const error = new Error(t('misc.the-host-returned-no-sessionid'))
      error.code = 'create-unverified'
      throw error
    }
    const workspacePath =
      typeof created?.workspace?.path === 'string' && created.workspace.path !== '' ? created.workspace.path : session.cwd
    const oldKey = session.key
    if (state.sessions.get(oldKey) === session) state.sessions.delete(oldKey)
    session.sessionId = createdId
    session.key = createdId
    session.cwd = workspacePath
    session.project = projectOf(workspacePath)
    if (typeof created?.workspace?.title === 'string' && created.workspace.title !== '') {
      session.project = oneLine(created.workspace.title, 80)
    }
    session.status = 'ready'
    session.loaded = true
    session.createOptions = false
    session.creating = false
    session.createUnknown = false
    state.sessions.set(createdId, session)
    if (state.activeKey === oldKey) state.activeKey = createdId
    state.hadSession = true
    return session
  }

  /**
   * Every TTY new-conversation entry (bare startup, Ctrl+N, /new and both
   * picker "new" choices) only opens a local draft. No Host Session exists until
   * the first real send; the explicit non-interactive `dsh-ask new` CLI path is
   * outside the TUI and stays immediate.
   */
  async function startDraftSession({ useOptions = false, cwd = undefined } = {}) {
    if (state.busy !== null) {
      busyBlocked()
      return undefined
    }
    if (state.submitBusy !== null) {
      setNotice(t('misc.submitting-permissions-answers-please-wait'))
      return undefined
    }
    await releaseApprovalForContextChange()
    const previous = activeSession()
    if (previous !== undefined) {
      previous.questionFlow = null
      if (
        isDraftSession(previous) &&
        previous.input === '' &&
        previous.attachments.pending.length === 0 &&
        previous.attachments.sent.length === 0
      ) {
        state.sessions.delete(previous.key)
      }
    }
    state.modals = []
    state.phase = 'chat'
    state.draftCounter = (state.draftCounter ?? 0) + 1
    const targetCwd = typeof cwd === 'string' && cwd !== '' ? cwd : state.baseCwd
    const session = createSessionState({
      sessionId: '',
      key: `draft:${state.draftCounter}`,
      cwd: targetCwd,
      status: 'draft',
    })
    session.createOptions = useOptions === true
    session.loaded = true
    state.sessions.set(session.key, session)
    state.activeKey = session.key
    requestRender()
    return session
  }

  /**
   * Create the Host Session for a draft, exactly once per send attempt. A
   * concurrent Enter is refused by `state.busy`; an unknown create result is not
   * retried automatically so a lost response cannot create a second Session.
   */
  async function createSessionForSend(session) {
    if (session === undefined || isDraftSession(session) !== true) return true
    if (session.createUnknown === true) {
      addError(session, t('session.createUnknownPrevious'))
      requestRender()
      return false
    }
    if (session.creating === true || state.busy !== null) {
      if (state.busy !== null) busyBlocked()
      else setNotice(t('session.creating'))
      return false
    }
    session.creating = true
    session.status = 'creating'
    state.busy = { kind: 'create', sessionKey: session.key, startedAt: Date.now() }
    requestRender()
    try {
      const created =
        session.createOptions === true && typeof adapter.newConversationWithOptions === 'function'
          ? await adapter.newConversationWithOptions(session.cwd)
          : await adapter.newConversationForDirectory(session.cwd)
      applyCreatedSession(session, created)
      state.busy = null
      systemNote(session, t('session.created', { id: shortId(session.sessionId), cwd: oneLine(session.cwd, 120) }))
      void refreshRows().then(requestRender)
      void refreshAwaiting(session, { quiet: true })
      void refreshStatus(session)
      return true
    } catch (error) {
      state.busy = null
      session.creating = false
      session.status = 'draft'
      const code = errorCodeOf(error)
      if (code === 'create-unverified' || code === 'network-error' || code === 'timeout') {
        session.createUnknown = true
        addError(session, t('session.createUnknown', { message: errorMessageOf(error) }))
      } else {
        addError(session, t('session.createFailed', { message: errorMessageOf(error) }))
      }
      requestRender()
      return false
    } finally {
      session.creating = false
    }
  }

  /** First real send: create the draft's Host Session, then send normally. */
  async function sendTurnWithCreate(session, text) {
    if (isDraftSession(session) === true) {
      const created = await createSessionForSend(session)
      if (created !== true) return
    }
    await sendTurn(session, text)
  }

  // --------------------------------------------------------------- input editing

  function resetScroll(session) {
    session.scroll = 0
  }

  /** Any real edit ends history browsing and re-opens a popup closed by Esc. */
  function noteComposerEdit(session) {
    session.historyIndex = -1
    session.menuSuppressed = false
  }

  function insertText(session, text) {
    if (text === '') return
    noteComposerEdit(session)
    session.input = session.input.slice(0, session.cursor) + text + session.input.slice(session.cursor)
    session.cursor += text.length
    resetScroll(session)
    requestRender()
  }

  function deleteBackward(session) {
    if (session.cursor <= 0) return
    noteComposerEdit(session)
    const start = previousBoundary(session.input, session.cursor)
    session.input = session.input.slice(0, start) + session.input.slice(session.cursor)
    session.cursor = start
    resetScroll(session)
    requestRender()
  }

  function deleteForward(session) {
    if (session.cursor >= session.input.length) return
    noteComposerEdit(session)
    const end = nextBoundary(session.input, session.cursor)
    session.input = session.input.slice(0, session.cursor) + session.input.slice(end)
    resetScroll(session)
    requestRender()
  }

  function moveLeft(session) {
    session.cursor = previousBoundary(session.input, session.cursor)
    requestRender()
  }

  function moveRight(session) {
    session.cursor = nextBoundary(session.input, session.cursor)
    requestRender()
  }

  function moveHome(session) {
    session.cursor = lineStartOf(session.input, session.cursor)
    requestRender()
  }

  function moveEnd(session) {
    session.cursor = lineEndOf(session.input, session.cursor)
    requestRender()
  }

  function deleteToLineStart(session) {
    const start = lineStartOf(session.input, session.cursor)
    session.input = session.input.slice(0, start) + session.input.slice(session.cursor)
    session.cursor = start
    requestRender()
  }

  function deleteToLineEnd(session) {
    const end = lineEndOf(session.input, session.cursor)
    session.input = session.input.slice(0, session.cursor) + session.input.slice(end)
    requestRender()
  }

  function longestCommonPrefix(values) {
    if (values.length === 0) return ''
    let prefix = values[0]
    for (const value of values.slice(1)) {
      let index = 0
      while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1
      prefix = prefix.slice(0, index)
    }
    return prefix
  }

  function completeCommand(session) {
    const text = session.input
    if (text.startsWith('/') !== true) return
    if (/\s/.test(text)) return
    const hits = COMMAND_WORDS.filter((word) => word.startsWith(text))
    if (hits.length === 0) return
    if (hits.length === 1) {
      session.input = `${hits[0]} `
      session.cursor = session.input.length
    } else {
      const prefix = longestCommonPrefix(hits)
      if (prefix.length > text.length) {
        session.input = prefix
        session.cursor = prefix.length
      }
      setNotice(t('misc.completions', { p1: hits.join('  ') }))
    }
    requestRender()
  }

  // ------------------------------------------------------- input history

  /** Codex recalls only inputs actually sent in this Session, newest first. */
  function recordInputHistory(session, text) {
    if (text === '') return
    if (session.history[session.history.length - 1] === text) return
    session.history.push(text)
    if (session.history.length > 100) session.history.splice(0, session.history.length - 100)
    session.historyIndex = -1
    session.historyDraft = ''
  }

  function historyPrevious(session) {
    const history = session.history
    if (history.length === 0) return false
    if (session.historyIndex === -1) {
      session.historyDraft = session.input
      session.historyIndex = history.length - 1
    } else if (session.historyIndex > 0) {
      session.historyIndex -= 1
    } else {
      return false
    }
    session.input = history[session.historyIndex]
    session.historyLast = session.input
    session.cursor = session.input.length
    resetScroll(session)
    requestRender()
    return true
  }

  /**
   * Codex only navigates history when the composer is empty, or when the
   * composer text is exactly the entry we last recalled and the cursor sits at
   * a line boundary. A live draft is never silently replaced.
   */
  function historyNavigationAllowed(session) {
    if (session.history.length === 0) return false
    if (session.input === '') return true
    if (session.cursor !== 0 && session.cursor !== session.input.length) return false
    return session.historyLast === session.input
  }

  function historyNext(session) {
    if (session.historyIndex === -1) return false
    session.historyIndex += 1
    if (session.historyIndex >= session.history.length) {
      session.historyIndex = -1
      session.input = session.historyDraft
      session.historyDraft = ''
    } else {
      session.input = session.history[session.historyIndex]
    }
    session.cursor = session.input.length
    resetScroll(session)
    requestRender()
    return true
  }

  /** Up/Down move the cursor inside a multi-line draft, like Codex. */
  function moveCursorVertically(session, delta) {
    const input = session.input
    const start = lineStartOf(input, session.cursor)
    const end = lineEndOf(input, session.cursor)
    const column = session.cursor - start
    if (delta < 0) {
      if (start === 0) return false
      const previousStart = lineStartOf(input, start - 1)
      const previousEnd = lineEndOf(input, previousStart)
      session.cursor = Math.min(previousStart + column, previousEnd)
    } else {
      if (end >= input.length) return false
      const nextStart = end + 1
      const nextEnd = lineEndOf(input, nextStart)
      session.cursor = Math.min(nextStart + column, nextEnd)
    }
    requestRender()
    return true
  }

  // --------------------------------------------------- inline command menu

  function menuSelectedItem(session) {
    const menu = commandMenuFor(session)
    if (menu === null) return null
    return menu.items[menu.selected] ?? null
  }

  function moveMenuSelection(session, delta) {
    const menu = commandMenuFor(session)
    if (menu === null) return false
    const count = menu.items.length
    if (count === 0) return true
    session.menuIndex = (session.menuIndex + delta + count) % count
    requestRender()
    return true
  }

  /** Tab: complete the selected command into the composer (Codex Tab). */
  function completeMenuSelection(session) {
    const item = menuSelectedItem(session)
    if (item === null) return false
    session.input = `${item.label} `
    session.cursor = session.input.length
    session.menuQuery = null
    session.menuSuppressed = true
    requestRender()
    return true
  }

  /** Enter: execute the selected command; a bare "/" only accepts completion. */
  async function executeMenuSelection(session) {
    const item = menuSelectedItem(session)
    if (item === null) return false
    if (session.input.trim() === '/') {
      completeMenuSelection(session)
      return true
    }
    session.input = ''
    session.cursor = 0
    session.menuQuery = null
    session.menuSuppressed = false
    requestRender()
    await runCommand(session, item.label)
    return true
  }

  // ------------------------------------------------------------- attachments

  function addImages(session, images) {
    if (images.length === 0) return []
    if (adapter.images === undefined) {
      addError(session, t('attach.unsupported'))
      return []
    }
    let combined
    try {
      combined = adapter.validateBatch([...session.attachments.pending, ...images])
    } catch (error) {
      addError(session, t('attach.addFailed', { message: String(error?.message ?? error) }))
      return []
    }
    const added = combined.slice(session.attachments.pending.length)
    session.attachments.pending.push(...added)
    for (const image of added) systemNote(session, t('attach.added', { image: imageSummary(image) }))
    requestRender()
    return added
  }

  async function attachPaths(session, argument) {
    if (argument === '') {
      systemNote(session, t('attach.usage'))
      return
    }
    if (adapter.images === undefined) {
      addError(session, t('attach.unsupported'))
      return
    }
    session.status = 'attaching'
    requestRender()
    try {
      const images = await adapter.loadPaths(argument, session.cwd)
      addImages(session, images)
    } catch (error) {
      addError(session, t('attach.addFailed', { message: String(error?.message ?? error) }))
    } finally {
      if (session.status === 'attaching') session.status = 'ready'
      requestRender()
    }
  }

  async function attachClipboard() {
    const session = activeSession()
    if (session === undefined) return
    if (state.clipboardBusy) {
      setNotice(t('attach.clipboardReading'))
      return
    }
    if (adapter.images === undefined) {
      addError(session, t('attach.unsupported'))
      return
    }
    state.clipboardBusy = true
    // Explicit status while the clipboard is being read: the renderer shows
    // `status=clipboard`, the hint says what is happening, and the message below
    // reports the outcome.
    setNotice(t('attach.clipboardReading'), 8000)
    requestRender()
    try {
      const image = await adapter.loadClipboard()
      addImages(session, [image])
      setNotice(t('attach.clipboardAdded', { image: imageSummary(image) }))
    } catch (error) {
      addError(session, t('attach.clipboardFailed', { message: String(error?.message ?? error) }))
    } finally {
      state.clipboardBusy = false
      requestRender()
    }
  }

  function combinedAttachments(session) {
    return [...session.attachments.pending, ...session.attachments.sent]
  }

  function detach(session, argument) {
    if (argument === 'all') {
      const count = combinedAttachments(session).length
      session.attachments.pending = []
      session.attachments.sent = []
      systemNote(session, t('attach.detachAll', { count }))
      requestRender()
      return
    }
    if (/^\d+$/.test(argument) !== true) {
      systemNote(session, t('attach.detachUsage'))
      return
    }
    const index = Number(argument)
    if (index >= 1 && index <= session.attachments.pending.length) {
      const [removed] = session.attachments.pending.splice(index - 1, 1)
      systemNote(session, t('attach.detached', { name: imageName(removed) }))
      requestRender()
      return
    }
    const sentIndex = index - session.attachments.pending.length - 1
    if (sentIndex >= 0 && sentIndex < session.attachments.sent.length) {
      const [removed] = session.attachments.sent.splice(sentIndex, 1)
      systemNote(session, t('attach.detached', { name: imageName(removed) }))
      requestRender()
      return
    }
    systemNote(session, t('attach.missing', { index: argument }))
  }

  function markSent(session, batch, reason) {
    const at = Date.now()
    for (const image of batch) {
      session.attachments.sent.push({ ...image, reason, sessionId: session.sessionId, at })
    }
    if (session.attachments.sent.length > 30) {
      session.attachments.sent.splice(0, session.attachments.sent.length - 30)
    }
  }

  function attachmentsText(session) {
    const { pending, sent } = session.attachments
    const lines = [t('attach.listHeader', { pending: pending.length, sent: sent.length })]
    if (pending.length === 0 && sent.length === 0) {
      lines.push(t('attach.listEmpty'))
      return lines.join('\n')
    }
    pending.forEach((image, index) => {
      lines.push(`  ${String(index + 1).padStart(2)}) ${imageSummary(image)}`)
    })
    if (sent.length > 0) {
      lines.push(`  ${t('attach.listSentHeader')}`)
      sent.forEach((image, index) => {
        const at = new Date(image.at).toLocaleTimeString()
        lines.push(
          `  ${String(pending.length + index + 1).padStart(2)}) ${t('attach.listSentLine', {
            // The reason is a state token written by markSent / the Host, not
            // prose: it is shown as stored (the run state "ready" is treated
            // the same way), so a Host code is never reworded.
            image: imageSummary(image),
            reason: image.reason ?? 'accepted',
            time: at,
            session: shortId(image.sessionId),
          })}`,
        )
      })
    }
    return lines.join('\n')
  }

  function previewAttached(session, argument) {
    const images = combinedAttachments(session)
    if (images.length === 0) {
      systemNote(session, t('attach.noAttachment'))
      return
    }
    let image
    if (argument === '') image = images[0]
    else if (/^\d+$/.test(argument)) image = images[Number(argument) - 1]
    else {
      systemNote(session, t('attach.previewUsage'))
      return
    }
    if (image === undefined) {
      systemNote(session, t('attach.missing', { index: argument }))
      return
    }
    systemNote(
      session,
      t('attach.previewInfo', { index: argument === '' ? 1 : argument, image: imageSummary(image) }),
    )
  }

  // ------------------------------------------------------------- turn sending

  const isAbortLike = (error) =>
    error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || String(error?.message ?? '').includes('local wait stopped')

  function isImageModelUnsupported(payload) {
    if (payload === undefined || payload === null) return false
    if (payload.code === 'image-model-unsupported') return true
    return typeof payload.error === 'string' && payload.error.includes('image-model-unsupported')
  }

  async function sendTurn(session, text) {
    if (session.sessionId === '') {
      addError(session, t('send.noSession'))
      requestRender()
      return
    }
    const batch = session.attachments.pending.slice()
    if (batch.length > 0 && adapter.images === undefined) {
      addError(session, t('attach.unsupported'))
      return
    }
    session.input = ''
    session.cursor = 0
    // Ownership of the batch moves to the request before it is sent: a second
    // Enter during the wait can never queue the same files twice.
    session.attachments.pending = []
    addMessage(session, {
      role: 'user',
      text:
        text === ''
          ? t('attach.onlyAttachments', {
              names: batch.map(imageName).join(t('attach.nameSeparator')),
            })
          : text,
    })
    const controller = new AbortController()
    const busy = {
      kind: 'turn',
      sessionKey: session.key,
      controller,
      batch,
      startedAt: Date.now(),
    }
    state.busy = busy
    session.status = 'waiting'
    resetScroll(session)
    requestRender()
    // Low-frequency occupancy refresh while the turn is unsettled; the >=3s
    // interval keeps the bridge reads cheap and the stream protocol untouched.
    startStatusPoll()

    const body = {
      sessionId: session.sessionId,
      text,
      timeoutMs: state.timeoutMs,
      cwd: session.cwd,
    }
    if (batch.length > 0) {
      body.images = batch.map(({ mediaType, data, name }) => ({ mediaType, data, name }))
    }

    let assistant
    const ensureAssistant = () => {
      if (assistant === undefined) {
        assistant = { role: 'assistant', text: '' }
        session.messages.push(assistant)
      }
      return assistant
    }
    // A turn that produced no text at all must not leave an empty bubble behind.
    const dropEmptyAssistant = () => {
      if (assistant === undefined || assistant.text !== '') return
      const index = session.messages.indexOf(assistant)
      if (index >= 0) session.messages.splice(index, 1)
      assistant = undefined
    }

    const onFrame = (frame) => {
      if (state.busy !== busy || state.stopped) return
      if (frame?.t === 'delta' && typeof frame.text === 'string' && frame.text !== '') {
        ensureAssistant().text += frame.text
        session.status = 'streaming'
        requestRender()
        return
      }
      if (frame?.t === 'tool') {
        addMessage(session, {
          role: 'system',
          text: `⚙ ${oneLine(frame.name ?? 'tool', 60)} ${stripEscapes(argSummary(frame.arguments))}`,
        })
        requestRender()
        return
      }
      if (frame?.t === 'tool-result') {
        const line = stripEscapes(firstLine(frame.text))
        if (line !== '') addMessage(session, { role: 'system', text: `${frame.ok === false ? '✗' : '✓'} ${line}` })
        requestRender()
        return
      }
      if (frame?.t === 'session' && typeof frame.sessionId === 'string' && frame.sessionId !== '') {
        session.sessionId = frame.sessionId
        requestRender()
      }
    }

    let payload
    try {
      payload =
        state.stream === false
          ? await adapter.askBlocking(body, { signal: controller.signal })
          : await adapter.ask(body, { signal: controller.signal, onFrame })
    } catch (error) {
      if (state.busy === busy) state.busy = null
      stopStatusPoll()
      session.status = 'ready'
      void refreshStatus(session)
      if (isAbortLike(error)) {
        if (batch.length > 0) markSent(session, batch, 'local wait stopped')
        systemNote(session, t('misc.stopped-the-local-wait-the-remote-may-still'))
        if (batch.length > 0) {
          systemNote(session, t('attach.unconfirmedBatch', { count: batch.length }))
        }
        session.lastFailure = { code: 'aborted' }
      } else {
        // The POST may have reached the Host, so the files must never go back to
        // pending: the next text turn would attach them a second time.
        if (batch.length > 0) markSent(session, batch, 'delivery unknown')
        addError(session, t('misc.request-failed', { p1: String(error?.message ?? error) }))
        systemNote(session, t('misc.delivery-result-unknown-check-history-first'))
        session.lastFailure = { code: 'delivery-unknown' }
      }
      dropEmptyAssistant()
      requestRender()
      return
    }
    if (state.busy === busy) state.busy = null
    stopStatusPoll()
    void refreshStatus(session)

    const elapsedMs = payload.elapsedMs ?? Date.now() - busy.startedAt
    const tools = payload.tools ?? 0
    const shownSession = payload.sessionId ?? session.sessionId
    session.lastTurn = { elapsedMs, tools, sessionId: shownSession, ok: payload.ok === true }

    if (payload.ok === true) {
      const finalText = typeof payload.text === 'string' ? payload.text : ''
      if (assistant !== undefined) {
        if (finalText !== '' && finalText.length >= assistant.text.length) {
          assistant.text = stripEscapes(finalText)
        }
      } else if (finalText !== '') {
        addMessage(session, { role: 'assistant', text: finalText })
      }
      dropEmptyAssistant()
      if (batch.length > 0) {
        markSent(session, batch, 'accepted')
        systemNote(session, t('send.attachmentSent', { count: batch.length, session: shortId(shownSession) }))
      }
      session.status = 'ready'
      session.remoteRunning = false
      systemNote(
        session,
        t('send.turnDone', {
          duration: formatDuration(elapsedMs),
          tools,
          session: shortId(shownSession),
        }),
      )
      requestRender()
      return
    }

    session.lastFailure = payload
    const finalText = typeof payload.text === 'string' ? payload.text : ''
    if (assistant !== undefined) {
      if (assistant.text === '' && finalText !== '') assistant.text = stripEscapes(finalText)
    } else if (finalText !== '') {
      addMessage(session, { role: 'assistant', text: finalText })
    }
    dropEmptyAssistant()
    addError(session, `${payload.code ?? 'error'} · ${payload.error ?? 'unknown failure'}`)
    if (payload.pending !== undefined) {
      systemNote(session, t('misc.waiting-for-a-human-answer-in-the-app', { p1: stripEscapes(JSON.stringify(payload.pending)) }))
    }
    if (batch.length > 0) {
      if (payload.accepted === false) {
        session.attachments.pending = [...batch, ...session.attachments.pending]
        systemNote(session, t('send.attachmentKept'))
      } else {
        markSent(
          session,
          batch,
          payload.accepted === true ? String(payload.code ?? 'accepted') : String(payload.code ?? 'unconfirmed'),
        )
        systemNote(
          session,
          payload.accepted === true ? t('send.attachmentAccepted') : t('send.attachmentUnconfirmed'),
        )
      }
    }
    if (isImageModelUnsupported(payload)) {
      systemNote(session, t('send.imageModelUnsupported'))
    }
    if (payload.code === 'stream-interrupted' || payload.code === 'incomplete-stream') {
      systemNote(session, t('misc.the-remote-session-may-still-be-running-2'))
    }
    session.status = 'ready'
    session.remoteRunning = false
    requestRender()
  }

  async function submitInput() {
    const session = activeSession()
    if (session === undefined) return
    if (state.busy !== null) {
      busyBlocked()
      return
    }
    if (session.status === 'loading' || session.status === 'creating') return
    const raw = session.input
    const text = raw.trim()
    if (text === '/') {
      // Bare slash: accept the selected completion instead of sending "/".
      session.menuSuppressed = false
      session.menuQuery = null
      requestRender()
      return
    }
    if (text.startsWith('/') && text.includes('\n') === false) {
      session.input = ''
      session.cursor = 0
      requestRender()
      await runCommand(session, text)
      return
    }
    if (text === '' && session.attachments.pending.length === 0) {
      setNotice(t('send.noContent'))
      return
    }
    recordInputHistory(session, text)
    await sendTurnWithCreate(session, text)
  }

  // ------------------------------------------------------------------ commands

  function clearMessages(session) {
    session.messages = []
    session.scroll = 0
    setNotice(t('cmd.cleared-the-on-screen-messages-the-session'))
    requestRender()
  }

  function statusText(session) {
    if (session.sessionId === '') {
      return [
        t('statusdetail.session-not-created-local-draft'),
        `cwd         ${session.cwd}`,
        `project     ${session.project === '' ? '—' : session.project}`,
        t('statusdetail.state-draft-created-on-the-first-send-using', { p1: session.createOptions === true ? t('msg.the-w-option') : '' }),
        t('statusdetail.nothing-is-created-implicitly-and-no-empty'),
      ].join('\n')
    }
    const lines = []
    lines.push(`session     ${session.sessionId}`)
    lines.push(`title       ${session.title === '' ? t('msg.unknown-the-host-did-not-provide-it') : session.title}`)
    lines.push(`cwd         ${session.cwd}`)
    lines.push(`project     ${session.project === '' ? t('misc.unknown') : session.project}`)
    const status = session.statusline
    const model = status?.model
    lines.push(
      `model       ${
        model === null || model === undefined
          ? '—'
          : `${statusLabel(model.provider) ?? '—'} / ${statusLabel(model.model) ?? '—'}${
              statusLabel(model.effort) === null ? '' : ` · effort ${statusLabel(model.effort)}`
            }`
      }`,
    )
    const context = status?.context
    lines.push(
      `context     ${
        context === null || context === undefined
          ? '—'
          : `${context.percent === null ? '—' : `${context.percent}%`} · ${compactTokens(context.usedTokens) ?? '—'} / ${compactTokens(context.contextWindow) ?? '—'} tokens`
      }`,
    )
    const usage = status?.usage
    lines.push(
      `tokens      ${
        usage === null || usage === undefined
          ? '—'
          : `in ${usage.uncachedInputTokens} · out ${usage.outputTokens} · cache read ${usage.cacheReadTokens} · cache write ${usage.cacheWriteTokens} · total ${usage.totalTokens}${
              typeof usage.cacheHitPercent === 'number' ? ` · cache hit ${usage.cacheHitPercent}%` : ''
            }`
      }`,
    )
    const stats = status?.stats
    lines.push(
      `stats       ${
        stats === null || stats === undefined
          ? '—'
          : t('msg.turns-steps-llm-total-tool-decode', {
              p1: stats.turns,
              p2: stats.steps,
              p3: formatDuration(stats.llmMs),
              p4: formatDuration(stats.toolMs),
              p5: stats.ttftSteps > 0 ? ` · ttft avg ${formatDuration(stats.ttftMs / stats.ttftSteps)}` : '',
              p6: formatDuration(stats.decodeMs),
              p7: typeof stats.tokensPerSecond === 'number' ? ` · ${compactSpeed(stats.tokensPerSecond)} tok/s` : '',
            })
      }`,
    )
    lines.push(`permission  ${statusLabel(status?.permission, 32) ?? '—'}`)
    const pending =
      Array.isArray(status?.pendingInput) && status.pendingInput.length > 0
        ? status.pendingInput.join(',')
        : 'none'
    lines.push(
      `queue       ${status === null || status === undefined ? '—' : `${status.queue} queued · pending ${pending}`}`,
    )
    if (status === null || status === undefined) {
      lines.push(t('statusdetail.status-no-host-status-yet-older-version'))
    }
    lines.push(t('statusdetail.state-remote', { p1: statusOf(session), p2: session.remoteRunning ? t('msg.may-still-be-running') : t('msg.idle') }))
    lines.push(
      t('statusdetail.attachments-pending-sent-unconfirmed', { p1: session.attachments.pending.length, p2: session.attachments.sent.length }),
    )
    lines.push(
      `images      ${
        adapter.images === undefined
          ? t('msg.not-supported-by-this-host-update-deepseek')
          : t('msg.supported-up-to-per-turn', { p1: adapter.images.maxImages ?? '?' })
      }`,
    )
    lines.push(`endpoint    ${adapter.endpoint}${adapter.pid === undefined ? '' : ` · pid ${adapter.pid}`}`)
    if (session.lastTurn !== undefined) {
      lines.push(
        t('statusdetail.last-turn-tool-calls-session', { p1: session.lastTurn.ok ? 'ok' : 'failed', p2: formatDuration(session.lastTurn.elapsedMs), p3: session.lastTurn.tools, p4: shortId(session.lastTurn.sessionId) }),
      )
    }
    if (session.lastFailure !== undefined) {
      lines.push(`last error  ${session.lastFailure.code ?? 'unknown'}`)
    }
    return lines.join('\n')
  }

  async function queueText(session) {
    const payload = await adapter.fetchQueue(session.sessionId)
    const items = payload.items ?? []
    const lines = [t('queue.pending', { p1: shortId(payload.sessionId ?? session.sessionId), p2: payload.running === true ? 'running' : 'idle', p3: items.length })]
    if (items.length === 0) {
      lines.push(t('queue.queue-empty'))
      return lines.join('\n')
    }
    for (const item of items) {
      const tag = item.placement === 'steering' ? 'steering' : item.placement === 'context' ? 'context' : 'queued'
      lines.push(`  ${String(item.index).padStart(2)}) ${tag.padEnd(10)} ${stripEscapes(firstLine(item.text, 90))}`)
      lines.push(`      id ${item.id}`)
    }
    return lines.join('\n')
  }

  async function runQueueCommand(session, text) {
    const matched = text.match(/^\/(edit|drop|steer)\s+(\d+)\s*([\s\S]*)$/)
    if (matched === null) return false
    const [, verb, rawIndex, remainder] = matched
    const listing = await adapter.fetchQueue(session.sessionId)
    const item = (listing.items ?? []).find((entry) => entry.index === Number(rawIndex))
    if (item === undefined) {
      addError(session, t('queue.no-pending-item', { p1: rawIndex }))
      return true
    }
    const action = verb === 'drop' ? 'remove' : verb === 'steer' ? 'steer' : 'edit'
    const replacement = remainder.trim()
    if (action === 'edit' && replacement === '') {
      systemNote(session, t('queue.usage-edit-n-new-text'))
      return true
    }
    const updated = await adapter.mutateQueue(
      session.sessionId,
      item.id,
      action,
      action === 'edit' ? replacement : undefined,
    )
    const items = updated.items ?? []
    const lines = [t('queue.pending', { p1: shortId(updated.sessionId ?? session.sessionId), p2: updated.running === true ? 'running' : 'idle', p3: items.length })]
    if (items.length === 0) lines.push(t('queue.queue-empty'))
    for (const entry of items) lines.push(`  ${String(entry.index).padStart(2)}) ${stripEscapes(firstLine(entry.text, 90))}`)
    systemNote(session, lines.join('\n'))
    requestRender()
    return true
  }

  async function reloadHistory(session) {
    if (state.busy !== null) {
      busyBlocked()
      return
    }
    session.status = 'loading'
    requestRender()
    try {
      const payload = await adapter.fetchTranscript(session.sessionId, state.tail)
      applyTranscript(session, payload)
      session.remoteRunning = payload.running === true
      session.status = 'ready'
      await refreshRows()
      const row = rowFor(session.sessionId)
      if (row !== undefined) applyRow(session, row)
      systemNote(session, t('cmd.session-transcript-reloaded-messages', { p1: session.messages.length }))
    } catch (error) {
      session.status = 'ready'
      addError(session, t('cmd.cannot-reload-the-session', { p1: String(error?.message ?? error) }))
    }
    requestRender()
  }

  async function runCommand(session, text) {
    const command = text.split(/\s+/)[0]
    const argument = text.slice(command.length).trim()
    switch (command) {
      case '/help':
        pushHelpModal()
        return
      case '/status':
        systemNote(session, statusText(session))
        requestRender()
        return
      case '/permissions':
      case '/permission':
        await openPermissions()
        return
      case '/approvals':
      case '/awaiting':
        await openApprovals()
        return
      case '/history':
        await reloadHistory(session)
        return
      case '/pending':
      case '/queue':
        try {
          systemNote(session, await queueText(session))
        } catch (error) {
          addError(session, t('cmd.cannot-read-the-queue', { p1: String(error?.message ?? error) }))
        }
        requestRender()
        return
      case '/attach':
        await attachPaths(session, argument)
        return
      case '/paste':
        await attachClipboard()
        return
      case '/attachments':
        systemNote(session, attachmentsText(session))
        requestRender()
        return
      case '/detach':
        detach(session, argument)
        return
      case '/preview':
        previewAttached(session, argument)
        return
      case '/send':
        if (state.busy !== null) {
          busyBlocked()
          return
        }
        if (session.attachments.pending.length === 0) {
          systemNote(session, t('attach.noPending'))
          requestRender()
          return
        }
        await sendTurnWithCreate(session, '')
        return
      case '/resume':
      case '/sessions':
        if (state.busy !== null) {
          busyBlocked()
          return
        }
        await openPicker({ initial: false })
        return
      case '/switch':
        if (state.busy !== null) {
          busyBlocked()
          return
        }
        await switchByReference(argument)
        return
      case '/new':
        await startDraftSession({ useOptions: draftUseOptions() })
        return
      case '/clear':
        clearMessages(session)
        return
      case '/id':
        systemNote(session, session.sessionId === '' ? t('session.draftNotCreated') : session.sessionId)
        requestRender()
        return
      case '/exit':
      case '/quit':
        quit(0)
        return
      case '/multiline':
        systemNote(session, t('cmd.press-alt-enter-in-the-draft-to-add-a'))
        requestRender()
        return
      case '/end':
        systemNote(session, t('cmd.end-only-matters-in-the-old-plain-multiline'))
        requestRender()
        return
      default:
        break
    }
    if (command === '/edit' || command === '/drop' || command === '/steer') {
      try {
        await runQueueCommand(session, text)
      } catch (error) {
        addError(session, t('cmd.queue-action-failed', { p1: String(error?.message ?? error) }))
        requestRender()
      }
      return
    }
    systemNote(session, t('cmd.unknown-command-press-for-commands-or-f1', { p1: command }))
    requestRender()
  }

  // ------------------------------------------------------------------- help

  function pushHelpModal() {
    state.modals.push({
      kind: 'help',
      initial: false,
      title: t('help.title'),
      items: helpModalItems(t),
      selected: 0,
      query: '',
      footer: HINT_HELP,
      useOptionsForNew: false,
    })
    requestRender()
  }

  // ------------------------------------------------------------------- quit

  function quit(code, { nothingPicked = false } = {}) {
    if (state.finished) return
    state.finished = true
    state.exitCode = code
    if (nothingPicked) state.nothingPicked = true
    resolveDone(code)
  }

  function busyBlocked() {
    setNotice(t('misc.waiting-for-this-turn-press-esc-or-ctrl-c'))
  }

  function abortLocalWait() {
    if (state.busy?.kind !== 'turn') return false
    try {
      state.busy.controller.abort()
    } catch {
      // The fetch may already be settled; its catch path reports the stop.
    }
    requestRender()
    return true
  }

  // -------------------------------------------------------------- key handling

  function handleCtrlC() {
    // Codex priority: close the active overlay, then clear the draft, then
    // interrupt the running turn, then quit. Interrupting only stops the local
    // wait; the UI never claims the remote turn was cancelled.
    const modal = topModal()
    if (modal !== undefined) {
      if (modal.kind === 'sessions' && modal.initial === true) {
        quit(0)
        return
      }
      closeModal()
      return
    }
    const session = activeSession()
    if (session !== undefined && session.input !== '') {
      session.input = ''
      session.cursor = 0
      session.menuSuppressed = false
      session.menuQuery = null
      setNotice(t('draft.cleared'))
      requestRender()
      return
    }
    if (abortLocalWait()) return
    if (state.busy?.kind === 'create') return
    quit(0)
  }

  function handleModalKey(modal, event) {
    if (modal.kind === 'question-input') {
      handleQuestionInputKey(modal, event)
      return
    }
    const items = filteredItems(modal)
    switch (event.name) {
      case 'up':
      case 'wheelup':
        modal.selected = items.length === 0 ? 0 : (modal.selected - 1 + items.length) % items.length
        requestRender()
        return
      case 'down':
      case 'wheeldown':
        modal.selected = items.length === 0 ? 0 : (modal.selected + 1) % items.length
        requestRender()
        return
      case 'pageup':
        modal.selected = Math.max(0, modal.selected - 5)
        requestRender()
        return
      case 'pagedown':
        modal.selected = Math.max(0, Math.min(items.length - 1, modal.selected + 5))
        requestRender()
        return
      case 'home':
        modal.selected = 0
        requestRender()
        return
      case 'end':
        modal.selected = Math.max(0, items.length - 1)
        requestRender()
        return
      case 'backspace':
        if (modal.filterable !== false && modal.query !== '') {
          modal.query = modal.query.slice(0, -1)
          clampSelected(modal)
          requestRender()
        }
        return
      case 'escape':
        closeModal()
        return
      case 'enter':
        void activateModalItem()
        return
      case 'text': {
        if (modal.filterable === false) return
        const text = event.text.replace(/\n/g, ' ').replace(/\s+/g, ' ')
        if (text === '') return
        modal.query += text
        clampSelected(modal)
        requestRender()
        return
      }
      default:
        return
    }
  }

  function scrollBy(session, delta) {
    session.scroll = Math.max(0, session.scroll + delta)
    requestRender()
  }

  /**
   * Keyboard PageUp/PageDown page by one viewport: the terminal height minus the
   * reserved header/composer/attachment/hint rows. Kept deterministic for
   * non-TTY outputs (the tests) by falling back to 24 rows.
   */
  function pageLines() {
    const rows = Number.isFinite(output?.rows) && output.rows > 0 ? Math.floor(output.rows) : 24
    return Math.max(5, Math.min(50, rows - 8))
  }

  function handleChatKey(session, event) {
    const menu = commandMenuFor(session)
    switch (event.name) {
      case 'enter':
        if (menu !== null) {
          void executeMenuSelection(session)
          return
        }
        void submitInput()
        return
      case 'alt-enter':
      case 'shift-enter':
      case 'ctrl-j':
        insertText(session, '\n')
        return
      case 'text':
        if (event.text === '?' && session.input === '' && session.cursor === 0) {
          pushHelpModal()
          return
        }
        insertText(session, event.text)
        return
      case 'paste':
        insertText(session, event.text)
        return
      case 'tab':
        if (menu !== null && completeMenuSelection(session)) return
        completeCommand(session)
        return
      case 'backspace':
        deleteBackward(session)
        return
      case 'delete':
        deleteForward(session)
        return
      case 'left':
        moveLeft(session)
        return
      case 'right':
        moveRight(session)
        return
      case 'home':
      case 'ctrl-a':
        moveHome(session)
        return
      case 'end':
      case 'ctrl-e':
        moveEnd(session)
        return
      case 'ctrl-u':
        deleteToLineStart(session)
        return
      case 'ctrl-k':
        deleteToLineEnd(session)
        return
      // Codex-owned transcript: the mouse wheel scrolls one visual line, while
      // PageUp/PageDown page by one viewport. The native UI therefore sends
      // wheelup/wheeldown for the wheel and keeps pageup/pagedown for the keys.
      case 'wheelup':
        scrollBy(session, 1)
        return
      case 'wheeldown':
        scrollBy(session, -1)
        return
      case 'pageup':
        scrollBy(session, pageLines())
        return
      case 'pagedown':
        scrollBy(session, -pageLines())
        return
      case 'up':
        if (menu !== null && moveMenuSelection(session, -1)) return
        if (historyNavigationAllowed(session) && historyPrevious(session)) return
        moveCursorVertically(session, -1)
        return
      case 'down':
        if (menu !== null && moveMenuSelection(session, 1)) return
        if (historyNavigationAllowed(session) && historyNext(session)) return
        moveCursorVertically(session, 1)
        return
      case 'escape':
        // Codex: close the popup first, then interrupt while a turn runs, then
        // return to the newest message. Esc never deletes the draft.
        if (menu !== null) {
          session.menuSuppressed = true
          requestRender()
          return
        }
        if (abortLocalWait()) return
        if (session.scroll > 0) {
          session.scroll = 0
          setNotice(t('misc.back-to-the-newest-message'))
          requestRender()
          return
        }
        if (session.input !== '') setNotice(t('draft.keptOnEsc'))
        else setNotice(t('hint.exitShortcut'))
        requestRender()
        return
      case 'insert':
        return
      case 'space':
        insertText(session, ' ')
        return
      default:
        return
    }
  }

  async function handleKey(str, key) {
    if (state.stopped || state.finished) return
    state.notice = ''
    if (state.noticeTimer !== null) {
      clearTimeout(state.noticeTimer)
      state.noticeTimer = null
    }
    const event = normalizeKeyEvent(str, key)
    if (event === null) return

    // Global keys work in every phase and above every modal.
    switch (event.name) {
      case 'ctrl-q':
        if (state.busy !== null) {
          busyBlocked()
          return
        }
        quit(0)
        return
      case 'ctrl-c':
        handleCtrlC()
        return
      case 'f1': {
        const modal = topModal()
        if (modal !== undefined && modal.kind === 'help') {
          closeModal()
          return
        }
        pushHelpModal()
        return
      }
      // Dedicated entries that never touch the composer: a pending decision can
      // be opened while a draft + attachments are present.
      case 'f2':
        if (state.modals.length === 0) await openApprovals()
        return
      case 'f3':
        if (state.modals.length === 0) await openPermissions()
        return
      case 'ctrl-p': {
        const session = activeSession()
        if (session !== undefined && moveMenuSelection(session, -1)) return
        if (state.busy !== null) {
          busyBlocked()
          return
        }
        await openPicker({ initial: topModal()?.initial === true })
        return
      }
      case 'ctrl-n': {
        const session = activeSession()
        if (session !== undefined && moveMenuSelection(session, 1)) return
        await startDraftSession({ useOptions: draftUseOptions() })
        return
      }
      case 'ctrl-l': {
        const session = activeSession()
        if (session !== undefined) clearMessages(session)
        return
      }
      case 'ctrl-v':
        await attachClipboard()
        return
      case 'ctrl-d': {
        const session = activeSession()
        if (session !== undefined && session.input !== '') return
        quit(0)
        return
      }
      default:
        break
    }
    // While the very first load is in flight the picker may already be on screen
    // (that is the fast path); keys must work there instead of being dropped.
    // Only the no-modal loading state (an initial -s Session) stays inert.
    if (state.initializing && state.modals.length === 0) return

    const modal = topModal()
    if (modal !== undefined) {
      handleModalKey(modal, event)
      return
    }
    const session = activeSession()
    if (session === undefined) {
      // No Session and no picker (only possible while a create is settling):
      // reopen the selector so the user is never stuck on a blank screen.
      if (state.busy === null) await openPicker({ initial: state.hadSession !== true })
      return
    }
    handleChatKey(session, event)
  }

  function onKey(str, key) {
    if (state.stopped || state.finished) return Promise.resolve()
    state.chain = state.chain
      .then(() => handleKey(str, key))
      .catch((error) => {
        state.keyErrors.push(error)
        const session = activeSession()
        addMessage(session, { role: 'error', text: t('misc.internal-error', { p1: String(error?.message ?? error) }) })
        requestRender()
      })
    return state.chain
  }

  // --------------------------------------------------------------- lifecycle

  function cleanup() {
    if (state.stopped) return
    state.stopped = true
    stopStatusPoll()
    stopPendingPoll()
    stopAllWatches()
    stopApprovalTimers()
    if (state.approvalClaim !== null && typeof adapter.releaseApprovalChannel === 'function') {
      // Best-effort: the lease still bounds a failed release. The local claim is
      // dropped immediately so no UI state can answer after shutdown.
      const claim = state.approvalClaim
      try {
        void Promise.resolve(
          adapter.releaseApprovalChannel({ claimId: claim.claimId, reason: 'shutdown' }),
        ).catch(() => {})
      } catch {
        // ignore
      }
      state.approvalClaim = null
    }
    if (state.renderTimer !== null) {
      clearTimeout(state.renderTimer)
      state.renderTimer = null
    }
    if (state.noticeTimer !== null) {
      clearTimeout(state.noticeTimer)
      state.noticeTimer = null
    }
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    process.off('SIGINT', onSigint)
    process.off('exit', cleanupOnExit)
    if (state.started === true) {
      state.started = false
      try {
        state.stopPromise = screen.stop()
      } catch {
        // The renderer already failed; nothing left to restore through it.
      }
    }
    // A native renderer owns stdin: pausing or unref'ing process.stdin here
    // would fight the child while it is still restoring the terminal. Only the
    // in-process renderer needs the parent's stdin released.
    const ownsTerminal = screen !== undefined && screen.ownsTerminal === true
    if (ownsTerminal !== true) {
      // The keypress decoder may have left stdin flowing; a resumed pipe or TTY
      // would otherwise keep the process alive after the UI is gone.
      if (input && typeof input.pause === 'function') {
        try {
          input.pause()
        } catch {
          // Already closed.
        }
      }
      if (input && typeof input.unref === 'function') {
        try {
          input.unref()
        } catch {
          // Not every stream can be unref'd.
        }
      }
    }
  }

  const onSignal = () => cleanup()
  const onSigint = () => {
    if (state.busy?.kind === 'turn') {
      try {
        state.busy.controller.abort()
      } catch {
        // settled already
      }
      return
    }
    cleanup()
    process.exitCode = 130
    quit(130)
  }
  const cleanupOnExit = () => cleanup()

  // Only start touching the terminal after the screen factory has validated.
  const boundOnKey = (str, key) => onKey(str, key)
  const boundOnResize = () => {
    const columns = pageColumns()
    if (columns !== state.lastColumns) {
      state.lastColumns = columns
      relayoutModals()
    }
    requestRender()
  }
  // A native renderer that dies leaves the terminal unusable; stop the UI with
  // a non-zero code and a clear message instead of waiting on a dead screen.
  const boundOnError = (message) => {
    if (state.finished) return
    state.screenError = String(message ?? 'native UI failed')
    if (state.busy?.kind === 'turn') {
      try {
        state.busy.controller.abort()
      } catch {
        // already settled
      }
    }
    quit(1)
  }

  screen = await createScreen({
    input,
    output,
    onKey: boundOnKey,
    onResize: boundOnResize,
    onError: boundOnError,
  })
  if (
    screen === null ||
    typeof screen !== 'object' ||
    typeof screen.start !== 'function' ||
    typeof screen.render !== 'function' ||
    typeof screen.stop !== 'function'
  ) {
    throw new TypeError('createScreen must return { start, render, stop }')
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('SIGINT', onSigint)
  process.on('exit', cleanupOnExit)

  state.initializing = true
  try {
    // Mark started first: if start() throws halfway, stop() still gets the
    // chance to restore the terminal it may already have touched.
    state.started = true
    screen.start()
    renderNow()
    await refreshWorkspaces()
    if (typeof options.initialSession === 'string' && options.initialSession !== '') {
      await loadSession(options.initialSession, { fetchHistory: state.noHistory !== true })
    } else if (options.initialPicker === true) {
      // `dsh-ask resume`: open the session list (Codex `codex resume`).
      await openPicker({ initial: true })
    } else {
      // Every TTY start is a local draft: no Host Session is created until the
      // first real send, so an immediate quit leaves no empty conversation. An
      // explicit -w / --create-workspace is honoured by that first send.
      await startDraftSession({ useOptions: draftUseOptions() })
    }
  } catch (error) {
    state.initializing = false
    cleanup()
    throw error
  }
  state.initializing = false
  state.lastColumns = pageColumns()
  startPendingPoll()
  requestRender()

  try {
    await done
  } finally {
    cleanup()
  }
  if (state.stopPromise !== null) {
    try {
      await state.stopPromise
    } catch {
      // Reaping failed; the SIGKILL backstop in the adapter handled it.
    }
  }
  if (state.nothingPicked === true) {
    output.write('nothing picked · no conversation was created\n')
  }
  if (state.screenError !== '') {
    process.stderr.write(`dsh-ask: ${state.screenError}\n`)
  }
  return state.exitCode
}
