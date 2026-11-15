/**
 * dsh-media.mjs - image-file, clipboard, and terminal-preview helpers.
 *
 * This module is deliberately small and dependency-free: it only imports Node
 * built-ins, never runs a shell, never opens a GUI, and never fetches remote
 * URLs. It is meant to be wired into dsh-ask for "attach these pictures to the
 * prompt" and "show me the picture in my terminal" flows.
 *
 *   loadImage(path)                  -> { mediaType, data, name }   (one file)
 *   loadImages(paths)                -> [{ mediaType, data, name }]  (1..4 files)
 *   readClipboardImage()             -> { mediaType, data, name }    (macOS only)
 *   previewImage(image, options)     -> { mode, rendered, ... }      (writes escape)
 *
 * Files are always addressed with fs primitives (no shell interpolation), so a
 * path such as `$(rm -rf /)` is just an unusual filename and simply fails with
 * EIMAGE_NOT_FOUND. One helper, splitDragPaths(), accepts the quoted and
 * backslash-escaped path list that Terminal.app/iTerm2 paste when files are
 * dragged into the window.
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Images accepted in one loadImages() call. */
export const MAX_IMAGES = 4
/** Bytes accepted per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Bytes accepted across one loadImages() call. */
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024
/** Default osascript timeout for readClipboardImage(). */
export const CLIPBOARD_TIMEOUT_MS = 8_000
/** stdout cap for the clipboard JXA script (a few MiB of base64 is normal). */
const CLIPBOARD_MAX_BUFFER = 32 * 1024 * 1024
/** kitty wants at most 4096 base64 characters per escape sequence. */
const KITTY_CHUNK_CHARS = 4096
/** iTerm2 truncates a single OSC 1337 sequence above 1,048,576 bytes. */
const ITERM_OSC_LIMIT = 1024 * 1024
/** iTerm2 multipart FilePart payloads stay at <= 64 KiB of base64 per sequence. */
const ITERM_PART_CHARS = 64 * 1024

const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MEDIA_TYPE_LABELS = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
}
const PREVIEW_MODES = new Set(['auto', 'never', 'iterm', 'kitty'])

/** Error type with a stable `code` for callers that branch on failure kinds. */
export class MediaError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

function mediaError(code, message, cause) {
  return new MediaError(code, message, cause)
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const GIF87_MAGIC = Buffer.from('GIF87a', 'ascii')
const GIF89_MAGIC = Buffer.from('GIF89a', 'ascii')

/**
 * Identify an image from its magic bytes. The filename/extension is ignored on
 * purpose: a JPEG saved as `holiday.png` is reported as `image/jpeg`.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function detectMediaType(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer)
    else return null
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png'
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg'
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6)
    if (signature.equals(GIF87_MAGIC) || signature.equals(GIF89_MAGIC)) return 'image/gif'
  }
  if (buffer.length >= 12) {
    const riff = buffer.subarray(0, 4).toString('ascii')
    const webp = buffer.subarray(8, 12).toString('ascii')
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return null
}

// ---------------------------------------------------------------------------
// Terminal-safe text helpers
// ---------------------------------------------------------------------------

/**
 * Strip terminal control sequences from text that will be shown to a user.
 * Removes OSC/DCS/CSI sequences wholesale, then drops any leftover C0/C1
 * control characters (including ESC, BEL, newlines) and bidi overrides.
 *
 * @param {unknown} value
 * @param {{max?: number}} [options]
 * @returns {string}
 */
export function sanitizeTerminalText(value, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 200
  let text = typeof value === 'string' ? value : value == null ? '' : String(value)
  // OSC: ESC ] ... (BEL or ST). DCS/PM/APC: ESC P|^|_ ... ST. CSI: ESC [ ... final.
  text = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
  // Remaining control characters become spaces so truncated filenames keep
  // visible word boundaries ("a\nb.png" -> "a b.png") instead of merging.
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  const codePoints = Array.from(text)
  if (codePoints.length > max) return `${codePoints.slice(0, max).join('')}…`
  return text
}

/** Human-readable byte count used by preview summaries. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

function displayPath(file) {
  return sanitizeTerminalText(file, { max: 300 })
}

// ---------------------------------------------------------------------------
// Path parsing (Terminal drag-and-drop safe, never shell-interpreted)
// ---------------------------------------------------------------------------

function resolvePath(raw, options) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : homedir()
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  let target = raw
  if (target === '~') target = home
  else if (target.startsWith('~/')) target = join(home, target.slice(2))
  return resolve(cwd, target)
}

function unescapePathWord(word) {
  let out = ''
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = word[index + 1]
    if (next === undefined) throw mediaError('EINVALID_PATH', 'image path ends with a trailing backslash')
    out += next
    index += 1
  }
  return out
}

function parseQuotedToken(token) {
  const quote = token[0]
  const inner = token.slice(1, -1)
  if (quote === "'") return inner
  return inner.replace(/\\(["\\$`])/g, '$1')
}

/**
 * Turn one path argument into an absolute path. Accepts absolute paths,
 * relative paths, `~/...`, surrounding single/double quotes, and the
 * backslash escaping that macOS terminals paste for spaces and punctuation.
 * No shell is involved; the returned path is passed straight to fs.
 *
 * @param {string} input
 * @param {{home?: string, cwd?: string}} [options]
 * @returns {string}
 */
export function normalizeImagePath(input, options = {}) {
  if (typeof input !== 'string') throw mediaError('EINVALID_PATH', 'image path must be a string')
  let raw = input.trim()
  if (raw === '') throw mediaError('EINVALID_PATH', 'image path is empty')
  if (raw.includes('\0')) throw mediaError('EINVALID_PATH', 'image path contains a NUL byte')
  if (raw[0] === "'" || raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== raw[0]) {
      throw mediaError('EINVALID_PATH', 'image path has an unterminated quote')
    }
    raw = parseQuotedToken(raw)
  } else {
    raw = unescapePathWord(raw)
  }
  if (raw === '') throw mediaError('EINVALID_PATH', 'image path is empty after quote/escape handling')
  if (raw.includes('\0')) throw mediaError('EINVALID_PATH', 'image path contains a NUL byte')
  return resolvePath(raw, options)
}

/** Split a whitespace-separated drag-and-drop path list, honouring quotes. */
function tokenizeDragText(text) {
  const tokens = []
  let current = ''
  let started = false
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"') {
      if (char === '\\') {
        const next = text[index + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          started = true
          index += 1
        } else {
          current += char
          started = true
        }
        continue
      }
      if (char === '"') {
        quote = null
        continue
      }
      current += char
      started = true
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      else {
        current += char
        started = true
      }
      continue
    }
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) throw mediaError('EINVALID_PATH', 'drag path list ends with a trailing backslash')
      current += next
      started = true
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote !== null) throw mediaError('EINVALID_PATH', 'drag path list has an unterminated quote')
  if (started) tokens.push(current)
  return tokens
}

/**
 * Parse the one-string form of a terminal drag: quoted paths, backslash-escaped
 * spaces, and several paths separated by whitespace.
 *
 * @param {string} text
 * @param {{home?: string, cwd?: string}} [options]
 * @returns {string[]} absolute paths, in input order
 */
export function splitDragPaths(text, options = {}) {
  if (typeof text !== 'string') throw mediaError('EINVALID_PATH', 'drag path list must be a string')
  return tokenizeDragText(text).map((token) => {
    if (token === '') throw mediaError('EINVALID_PATH', 'drag path list contains an empty path')
    if (token.includes('\0')) throw mediaError('EINVALID_PATH', 'drag path list contains a NUL byte')
    return resolvePath(token, options)
  })
}

// ---------------------------------------------------------------------------
// Image files
// ---------------------------------------------------------------------------

async function statImageFile(file) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw mediaError('EIMAGE_NOT_FOUND', `image file not found: ${displayPath(file)}`, error)
    }
    throw mediaError('EIMAGE_READ_FAILED', `cannot inspect image file: ${displayPath(file)}`, error)
  }
  if (!info.isFile()) throw mediaError('ENOT_A_FILE', `not a regular file: ${displayPath(file)}`)
  if (info.size > MAX_IMAGE_BYTES) {
    throw mediaError(
      'EIMAGE_TOO_LARGE',
      `image is too large: ${displayPath(file)} (${formatBytes(info.size)} > ${formatBytes(MAX_IMAGE_BYTES)})`,
    )
  }
  return { path: file, size: info.size }
}

async function readImageBuffer(file) {
  try {
    return await readFile(file)
  } catch (error) {
    throw mediaError('EIMAGE_READ_FAILED', `cannot read image file: ${displayPath(file)}`, error)
  }
}

function sniffsMediaType(buffer, file) {
  const mediaType = detectMediaType(buffer)
  if (mediaType === null) {
    throw mediaError(
      'EUNSUPPORTED_MEDIA_TYPE',
      `unsupported image format: ${displayPath(file)} (expected PNG, JPEG, GIF, or WEBP magic bytes)`,
    )
  }
  return mediaType
}

/** Enforce the per-image byte limit after a read (the file can grow meanwhile). */
function assertSingleImageSize(buffer, file) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw mediaError(
      'EIMAGE_TOO_LARGE',
      `image is too large: ${displayPath(file)} (${formatBytes(buffer.length)} > ${formatBytes(MAX_IMAGE_BYTES)})`,
    )
  }
}

/**
 * Load one image file as base64. Directory paths, files larger than 5 MiB, and
 * files that do not start with a PNG/JPEG/GIF/WEBP signature are rejected.
 *
 * @param {string} input path or Terminal-dragged path token
 * @param {{home?: string, cwd?: string}} [options]
 * @returns {Promise<{mediaType: string, data: string, name: string}>}
 */
export async function loadImage(input, options = {}) {
  const [image] = await loadImages([input], options)
  return image
}

/**
 * Load up to four images as base64, enforcing 4 images / 5 MiB per image /
 * 12 MiB in total. The files are stat'ed before any content is read so an
 * oversized batch fails without slurping it into memory.
 *
 * `paths` may be an array (each item is one path, quotes/escapes allowed) or a
 * single string containing a whitespace-separated drag-and-drop path list.
 *
 * @param {string|string[]} paths
 * @param {{home?: string, cwd?: string}} [options]
 * @returns {Promise<Array<{mediaType: string, data: string, name: string}>>}
 */
export async function loadImages(paths, options = {}) {
  let resolved
  if (typeof paths === 'string') {
    resolved = splitDragPaths(paths, options)
  } else if (Array.isArray(paths)) {
    resolved = paths.map((item) => normalizeImagePath(item, options))
  } else {
    throw mediaError('EINVALID_PATH', 'loadImages expects one path string or an array of paths')
  }
  if (resolved.length === 0) return []
  if (resolved.length > MAX_IMAGES) {
    throw mediaError('ETOO_MANY_IMAGES', `too many images: ${resolved.length} (max ${MAX_IMAGES})`)
  }

  const infos = []
  for (const file of resolved) infos.push(await statImageFile(file))
  const totalSize = infos.reduce((sum, info) => sum + info.size, 0)
  if (totalSize > MAX_TOTAL_BYTES) {
    throw mediaError(
      'ETOTAL_TOO_LARGE',
      `image batch is too large: ${formatBytes(totalSize)} (max ${formatBytes(MAX_TOTAL_BYTES)})`,
    )
  }

  const images = []
  let readSize = 0
  for (const info of infos) {
    const buffer = await readImageBuffer(info.path)
    assertSingleImageSize(buffer, info.path)
    readSize += buffer.length
    if (readSize > MAX_TOTAL_BYTES) {
      throw mediaError(
        'ETOTAL_TOO_LARGE',
        `image batch is too large: ${formatBytes(readSize)} (max ${formatBytes(MAX_TOTAL_BYTES)})`,
      )
    }
    const mediaType = sniffsMediaType(buffer, info.path)
    images.push({
      mediaType,
      data: buffer.toString('base64'),
      name: basename(info.path),
    })
  }
  return images
}

// ---------------------------------------------------------------------------
// macOS clipboard
// ---------------------------------------------------------------------------

/**
 * JXA program run through `osascript -l JavaScript`. AppKit's NSPasteboard is
 * read-only here: prefer public.png, otherwise convert public.tiff to PNG with
 * NSBitmapImageRep. The script writes one JSON line to stdout and never writes
 * to the pasteboard or touches the network.
 */
export const CLIPBOARD_JXA_SCRIPT = `ObjC.import('AppKit');
ObjC.import('Foundation');

function realObject(value) {
  if (!value) return null;
  try {
    if (typeof value.isNil === 'function' && value.isNil()) return null;
  } catch (error) {}
  return value;
}

function unwrapString(value) {
  try {
    return String(ObjC.unwrap(value));
  } catch (error) {
    return String(value);
  }
}

function base64Of(data) {
  return unwrapString(data.base64EncodedStringWithOptions(0));
}

function pngFromTiff(tiff) {
  var representation = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (!realObject(representation)) return null;
  return realObject(representation.representationUsingTypeProperties(4, $()));
}

function run() {
  try {
    var pasteboard = realObject($.NSPasteboard.generalPasteboard);
    if (!pasteboard) return JSON.stringify({ ok: false, reason: 'no-image' });
    var png = realObject(pasteboard.dataForType('public.png'));
    if (!png) {
      var tiff = realObject(pasteboard.dataForType('public.tiff'));
      if (tiff) png = pngFromTiff(tiff);
    }
    if (!png) return JSON.stringify({ ok: false, reason: 'no-image' });
    var data = base64Of(png);
    if (!data) return JSON.stringify({ ok: false, reason: 'no-image' });
    return JSON.stringify({ ok: true, mediaType: 'image/png', data: data });
  } catch (error) {
    return JSON.stringify({ ok: false, reason: 'error', message: String(error) });
  }
}
`

/**
 * Run osascript with execFile (never a shell), a hard timeout, and a stdout cap.
 * Kept separate from readClipboardImage() so tests can inject a fake runner.
 */
async function defaultClipboardRunner({ script, timeoutMs }) {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
    timeout: timeoutMs,
    maxBuffer: CLIPBOARD_MAX_BUFFER,
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout
}

function isBase64Code(code) {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    (code >= 48 && code <= 57) || // 0-9
    code === 43 || // +
    code === 47 // /
  )
}

/**
 * Decode strict, canonical base64. Whitespace, a missing/extra pad character, a
 * non-multiple-of-4 length, or non-zero pad bits are all rejected, so the same
 * bytes always have exactly one accepted encoding. The scan is iterative rather
 * than regex-based so multi-megabyte payloads cannot blow the regex stack.
 *
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bodyLength = value.length - padding
  for (let index = 0; index < bodyLength; index += 1) {
    if (!isBase64Code(value.charCodeAt(index))) return null
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null // '='
  }
  let bytes
  try {
    bytes = Buffer.from(value, 'base64')
  } catch {
    return null
  }
  if (bytes.length === 0 || bytes.toString('base64') !== value) return null
  return bytes
}

/**
 * Read a PNG (or TIFF converted to PNG) from the macOS pasteboard.
 *
 * Resolves `{ mediaType: 'image/png', data: <base64>, name: 'clipboard.png' }`.
 * The script payload is re-validated with the same rules as file loading: it
 * must be canonical base64, its magic bytes must be PNG, and it must not exceed
 * MAX_IMAGE_BYTES (5 MiB). Anything else is ECLIPBOARD_BAD_PAYLOAD.
 * Throws MediaError with a stable code on every other outcome:
 *   EUNSUPPORTED_PLATFORM  - not macOS (Linux/Windows have no NSPasteboard)
 *   ECLIPBOARD_NO_IMAGE    - clipboard holds neither public.png nor public.tiff
 *   ECLIPBOARD_TIMEOUT     - osascript exceeded `timeoutMs`
 *   ECLIPBOARD_FAILED      - osascript failed or printed an unreadable result
 *   ECLIPBOARD_BAD_PAYLOAD - script result was not a real PNG
 *
 * Tests pass `{ platform, run }` to mock the OS boundary; production passes
 * nothing and gets `process.platform` plus the execFile runner.
 *
 * @param {{platform?: string, run?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{mediaType: string, data: string, name: string}>}
 */
export async function readClipboardImage(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  if (platform !== 'darwin') {
    throw mediaError(
      'EUNSUPPORTED_PLATFORM',
      `reading an image from the clipboard is only supported on macOS (current platform: ${sanitizeTerminalText(platform, { max: 40 }) || 'unknown'})`,
    )
  }
  const run = typeof options.run === 'function' ? options.run : defaultClipboardRunner
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CLIPBOARD_TIMEOUT_MS

  let stdout
  try {
    stdout = await run({ script: CLIPBOARD_JXA_SCRIPT, timeoutMs })
  } catch (error) {
    if (error && (error.code === 'ETIMEDOUT' || error.timedOut === true || error.killed === true)) {
      throw mediaError('ECLIPBOARD_TIMEOUT', `reading the clipboard image timed out after ${timeoutMs}ms`, error)
    }
    const message = sanitizeTerminalText(error && error.message ? error.message : error, { max: 400 })
    throw mediaError('ECLIPBOARD_FAILED', `could not read the clipboard image with osascript: ${message}`, error)
  }

  let text
  if (typeof stdout === 'string') text = stdout
  else if (stdout && typeof stdout.stdout === 'string') text = stdout.stdout
  else text = ''
  let parsed
  try {
    parsed = JSON.parse(text.trim())
  } catch (error) {
    throw mediaError('ECLIPBOARD_FAILED', 'osascript returned an unreadable clipboard result', error)
  }
  if (!parsed || parsed.ok !== true) {
    if (parsed && parsed.reason === 'no-image') {
      throw mediaError('ECLIPBOARD_NO_IMAGE', 'the clipboard does not contain a PNG or TIFF image')
    }
    const detail =
      parsed && typeof parsed.message === 'string'
        ? `: ${sanitizeTerminalText(parsed.message, { max: 300 })}`
        : ''
    throw mediaError('ECLIPBOARD_FAILED', `osascript could not read the clipboard image${detail}`)
  }

  const data = decodeCanonicalBase64(parsed.data)
  if (data === null) {
    throw mediaError('ECLIPBOARD_BAD_PAYLOAD', 'the clipboard script returned data that is not canonical base64')
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw mediaError(
      'ECLIPBOARD_BAD_PAYLOAD',
      `the clipboard image is too large: ${formatBytes(data.length)} > ${formatBytes(MAX_IMAGE_BYTES)}`,
    )
  }
  if (typeof parsed.mediaType === 'string' && parsed.mediaType !== 'image/png') {
    throw mediaError(
      'ECLIPBOARD_BAD_PAYLOAD',
      `the clipboard script returned media type ${sanitizeTerminalText(parsed.mediaType, { max: 60 })}, but only PNG is accepted`,
    )
  }
  if (detectMediaType(data) !== 'image/png') {
    throw mediaError('ECLIPBOARD_BAD_PAYLOAD', 'the clipboard image content is not a PNG (magic bytes mismatch)')
  }
  return { mediaType: 'image/png', data: data.toString('base64'), name: 'clipboard.png' }
}

// ---------------------------------------------------------------------------
// Terminal preview
// ---------------------------------------------------------------------------

function positiveInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null
}

function terminalSize(output, env) {
  const columns =
    positiveInteger(output.columns) ?? positiveInteger(env.COLUMNS) ?? 80
  const rows = positiveInteger(output.rows) ?? positiveInteger(env.LINES) ?? 24
  return { columns, rows }
}

function normalizePreviewImage(image) {
  if (!image || typeof image !== 'object') {
    throw mediaError('EINVALID_IMAGE', 'previewImage needs an object with mediaType, data, and name')
  }
  const mediaType = typeof image.mediaType === 'string' ? image.mediaType.toLowerCase() : ''
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw mediaError(
      'EINVALID_IMAGE',
      `previewImage does not support media type ${sanitizeTerminalText(image.mediaType, { max: 60 }) || '(missing)'}`,
    )
  }
  let data = image.data
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) data = Buffer.from(data).toString('base64')
  if (typeof data !== 'string') {
    throw mediaError('EINVALID_IMAGE', 'previewImage needs base64 image data in image.data')
  }
  const bytes = decodeCanonicalBase64(data)
  if (bytes === null) {
    throw mediaError(
      'EINVALID_IMAGE',
      'previewImage image.data is not canonical base64 (no whitespace, exact padding, and a multiple-of-4 length are required)',
    )
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw mediaError(
      'EIMAGE_TOO_LARGE',
      `preview image is too large: ${formatBytes(bytes.length)} > ${formatBytes(MAX_IMAGE_BYTES)}`,
    )
  }
  const actualMediaType = detectMediaType(bytes)
  if (actualMediaType === null) {
    throw mediaError('EINVALID_IMAGE', 'previewImage image.data does not start with a PNG, JPEG, GIF, or WEBP magic number')
  }
  if (actualMediaType !== mediaType) {
    throw mediaError(
      'EINVALID_IMAGE',
      `previewImage mediaType ${mediaType} does not match its magic bytes (${actualMediaType})`,
    )
  }
  const name = typeof image.name === 'string' && image.name !== '' ? image.name : 'image'
  return { mediaType, data, name, byteLength: bytes.length }
}

function writeSummary(output, image, reason) {
  const label = MEDIA_TYPE_LABELS[image.mediaType] ?? image.mediaType
  const name = sanitizeTerminalText(image.name, { max: 120 }) || 'image'
  output.write(`[image] ${name} (${label}, ${formatBytes(image.byteLength)})\n`)
  return { mode: 'text', rendered: false, reason }
}

function itermArgs(image, size) {
  // iTerm2 sizes in this escape are terminal cells; stay inside the window.
  const width = Math.max(1, Math.min(size.columns - 1, 100))
  const height = Math.max(1, Math.min(size.rows - 2, 40))
  const name = sanitizeTerminalText(image.name, { max: 120 }) || 'image'
  const encodedName = Buffer.from(name, 'utf8').toString('base64')
  return {
    width,
    height,
    args:
      `name=${encodedName};size=${image.byteLength};width=${width};height=${height};` +
      'preserveAspectRatio=1;inline=1',
  }
}

function writeItermImage(output, image, size) {
  const { args, width, height } = itermArgs(image, size)
  const single = `\x1b]1337;File=${args}:${image.data}\x07`
  if (single.length <= ITERM_OSC_LIMIT) {
    output.write(`${single}\n`)
    return { mode: 'iterm', rendered: true, multipart: false, width, height, bytes: image.byteLength }
  }
  // A single OSC over 1,048,576 bytes is truncated by iTerm2; the documented
  // MultipartFile/FilePart/FileEnd framing keeps every sequence small.
  const parts = []
  for (let offset = 0; offset < image.data.length; offset += ITERM_PART_CHARS) {
    parts.push(`\x1b]1337;FilePart=${image.data.slice(offset, offset + ITERM_PART_CHARS)}\x07`)
  }
  output.write(`\x1b]1337;MultipartFile=${args}\x07${parts.join('')}\x1b]1337;FileEnd\x07\n`)
  return {
    mode: 'iterm',
    rendered: true,
    multipart: true,
    width,
    height,
    bytes: image.byteLength,
    chunks: parts.length,
  }
}

/**
 * Split base64 into kitty's recommended ≤4096-character pieces. Splitting at
 * 4-character boundaries keeps every piece independently decodable.
 */
function kittyChunks(data) {
  const chunks = []
  for (let offset = 0; offset < data.length; offset += KITTY_CHUNK_CHARS) {
    chunks.push(data.slice(offset, offset + KITTY_CHUNK_CHARS))
  }
  return chunks
}

function writeKittyImage(output, image, size) {
  const chunks = kittyChunks(image.data)
  // First-frame c/r cells cap the display so a huge screenshot cannot cover
  // the whole window (kitty scales the image to preserve its aspect ratio).
  const columns = Math.max(1, Math.min(size.columns - 1, 100))
  const rows = Math.max(1, Math.min(size.rows - 2, 40))
  const parts = []
  for (let index = 0; index < chunks.length; index += 1) {
    const first = index === 0
    const last = index === chunks.length - 1
    const keys = [
      first ? 'f=100' : null,
      first ? 'a=T' : null,
      first ? 'q=2' : null,
      first ? `c=${columns}` : null,
      first ? `r=${rows}` : null,
      `m=${last ? 0 : 1}`,
    ].filter((key) => key !== null)
    parts.push(`\x1b_G${keys.join(',')};${chunks[index]}\x1b\\`)
  }
  output.write(`${parts.join('')}\n`)
  return {
    mode: 'kitty',
    rendered: true,
    chunks: chunks.length,
    columns,
    rows,
    bytes: image.byteLength,
  }
}

function isItermTerminal(env) {
  return (
    env.TERM_PROGRAM === 'iTerm.app' ||
    env.TERM_PROGRAM === 'iTerm2' ||
    env.LC_TERMINAL === 'iTerm2' ||
    typeof env.ITERM_SESSION_ID === 'string'
  )
}

function isKittyTerminal(env) {
  return (
    env.KITTY_WINDOW_ID !== undefined ||
    env.TERM === 'xterm-kitty' ||
    env.TERM_PROGRAM === 'kitty' ||
    typeof env.KITTY_LISTEN_ON === 'string'
  )
}

/**
 * tmux/screen need an explicit passthrough wrapper for image escapes. We do not
 * guess whether the user configured one, so auto-detection degrades to text.
 */
function isMultiplexerTerminal(env) {
  return (
    env.TMUX !== undefined ||
    env.TMUX_PANE !== undefined ||
    env.TERM_PROGRAM === 'tmux' ||
    (typeof env.TERM === 'string' && (env.TERM.startsWith('screen') || env.TERM.startsWith('tmux')))
  )
}

/**
 * Show an image in the current terminal, or print a safe one-line summary.
 *
 * Modes:
 *   auto   - detect iTerm2 / kitty from `env`; everything else gets text.
 *   iterm  - force the iTerm2 OSC 1337 escape when safety gates allow it.
 *   kitty  - force the kitty graphics protocol (PNG only; other formats fall
 *            back to text because converting them would need a decoder).
 *   never  - always print the text summary.
 *
 * Safety gates run before the forced modes: a non-TTY output never receives an
 * escape sequence, `NO_COLOR` present (any value) and `TERM=dumb` always select
 * the plain summary, and a PNG is required for kitty. Without those signals,
 * `iterm`/`kitty` override terminal auto-detection. Auto-detection also treats
 * tmux/screen as text (reason `tmux-not-supported`) because it cannot know
 * whether a passthrough wrapper was configured; explicit modes are never
 * rewritten. Large iTerm2 images are framed with the documented
 * MultipartFile/FilePart/FileEnd escape sequence instead of one oversized
 * sequence, and kitty's first frame carries c/r cell limits so giant images
 * cannot cover the window.
 *
 * @param {{mediaType: string, data: string, name?: string}} image
 * @param {{output?: NodeJS.WritableStream, mode?: 'auto'|'never'|'iterm'|'kitty', env?: NodeJS.ProcessEnv}} [options]
 * @returns {{mode: 'text'|'iterm'|'kitty', rendered: boolean, reason?: string, multipart?: boolean, width?: number, height?: number, columns?: number, rows?: number, chunks?: number, bytes?: number}}
 */
export function previewImage(image, options = {}) {
  const { output = process.stdout, mode = 'auto', env = process.env } = options ?? {}
  if (!PREVIEW_MODES.has(mode)) {
    throw mediaError(
      'EINVALID_MODE',
      `unknown preview mode: ${sanitizeTerminalText(mode, { max: 30 }) || '(missing)'} (expected auto, never, iterm, or kitty)`,
    )
  }
  if (!output || typeof output.write !== 'function') {
    throw mediaError('EINVALID_OUTPUT', 'previewImage needs a writable output stream')
  }
  const normalized = normalizePreviewImage(image)
  const environment = env ?? {}
  const size = terminalSize(output, environment)

  if (mode === 'never') return writeSummary(output, normalized, 'mode-never')
  if (output.isTTY !== true) return writeSummary(output, normalized, 'not-a-tty')
  if (environment.NO_COLOR !== undefined) return writeSummary(output, normalized, 'no-color')
  if (environment.TERM === 'dumb') return writeSummary(output, normalized, 'dumb-terminal')
  if (mode === 'iterm') return writeItermImage(output, normalized, size)
  if (mode === 'kitty') {
    return normalized.mediaType === 'image/png'
      ? writeKittyImage(output, normalized, size)
      : writeSummary(output, normalized, 'kitty-requires-png')
  }
  if (isMultiplexerTerminal(environment)) return writeSummary(output, normalized, 'tmux-not-supported')
  if (isKittyTerminal(environment)) {
    return normalized.mediaType === 'image/png'
      ? writeKittyImage(output, normalized, size)
      : writeSummary(output, normalized, 'kitty-requires-png')
  }
  if (isItermTerminal(environment)) return writeItermImage(output, normalized, size)
  return writeSummary(output, normalized, 'terminal-not-supported')
}
