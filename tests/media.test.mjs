import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { access, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLIPBOARD_JXA_SCRIPT,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  MediaError,
  detectMediaType,
  formatBytes,
  loadImage,
  loadImages,
  normalizeImagePath,
  previewImage,
  readClipboardImage,
  sanitizeTerminalText,
  splitDragPaths,
} from '../dsh-media.mjs'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const GIF_HEADER = Buffer.from('GIF89a', 'ascii')
const WEBP_HEADER = (() => {
  const buffer = Buffer.alloc(12)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(4, 4)
  buffer.write('WEBP', 8, 'ascii')
  return buffer
})()

function imageBytes(header, extra = Buffer.alloc(16)) {
  return Buffer.concat([header, extra])
}

function fakeOutput(extra = {}) {
  const chunks = []
  return {
    chunks,
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
    ...extra,
  }
}

function pngImage(name = 'pixel.png', bytes = imageBytes(PNG_HEADER, Buffer.alloc(62))) {
  return { mediaType: 'image/png', data: bytes.toString('base64'), name }
}

function pngBytesOfSize(size) {
  assert.ok(size >= PNG_HEADER.length, 'a PNG payload must contain the magic header')
  return Buffer.concat([PNG_HEADER, Buffer.alloc(size - PNG_HEADER.length)])
}

function pngImageOfSize(name, size) {
  return { mediaType: 'image/png', data: pngBytesOfSize(size).toString('base64'), name }
}

function parseKittyKeys(sequence) {
  const keys = {}
  for (const pair of sequence.keys.split(',')) {
    const separator = pair.indexOf('=')
    keys[pair.slice(0, separator)] = pair.slice(separator + 1)
  }
  return keys
}

function parseMultipartIterm(text) {
  const head = text.match(/^\x1b\]1337;MultipartFile=([^\x07]*)\x07/)
  assert.ok(head, `missing MultipartFile head: ${JSON.stringify(text.slice(0, 80))}`)
  const args = {}
  for (const pair of head[1].split(';')) {
    const separator = pair.indexOf('=')
    if (separator > 0) args[pair.slice(0, separator)] = pair.slice(separator + 1)
  }
  const parts = Array.from(text.matchAll(/\x1b\]1337;FilePart=([A-Za-z0-9+/=]*)\x07/g)).map(
    (match) => match[1],
  )
  return { args, parts, ended: /\x1b\]1337;FileEnd\x07\n$/.test(text) }
}

function parseItermEscape(text) {
  const match = text.match(
    /^\x1b\]1337;File=name=([^;]+);size=(\d+);width=(\d+);height=(\d+);preserveAspectRatio=1;inline=1:([A-Za-z0-9+/=]+)\x07\n$/,
  )
  assert.ok(match, `not an iTerm2 OSC 1337 escape: ${JSON.stringify(text.slice(0, 80))}`)
  return {
    name: Buffer.from(match[1], 'base64').toString('utf8'),
    size: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    data: match[5],
  }
}

function parseKittyEscapes(text) {
  return Array.from(text.matchAll(/\x1b_G([^;]*);([A-Za-z0-9+/=]*)\x1b\\/g)).map((match) => ({
    keys: match[1],
    payload: match[2],
  }))
}

async function expectMediaError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MediaError, `expected MediaError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code)
    return true
  })
}

async function makeSparseImage(file, size, header = PNG_HEADER) {
  const handle = await open(file, 'w')
  try {
    await handle.writeFile(header)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  return file
}

let root
let nestedDir

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-media-test-'))
  nestedDir = join(root, 'nested dir')
  await mkdir(nestedDir, { recursive: true })
})

after(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('detectMediaType (magic bytes)', () => {
  it('recognises PNG, JPEG, GIF87/GIF89, and WEBP', () => {
    assert.equal(detectMediaType(imageBytes(PNG_HEADER)), 'image/png')
    assert.equal(detectMediaType(imageBytes(JPEG_HEADER)), 'image/jpeg')
    assert.equal(detectMediaType(imageBytes(GIF_HEADER)), 'image/gif')
    assert.equal(detectMediaType(imageBytes(Buffer.from('GIF87a', 'ascii'))), 'image/gif')
    assert.equal(detectMediaType(imageBytes(WEBP_HEADER)), 'image/webp')
  })

  it('rejects text, RIFF non-WEBP containers, and tiny buffers', () => {
    assert.equal(detectMediaType(Buffer.from('this is not an image')), null)
    const wav = Buffer.alloc(12)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(4, 4)
    wav.write('WAVE', 8, 'ascii')
    assert.equal(detectMediaType(wav), null)
    assert.equal(detectMediaType(Buffer.from([0x89, 0x50])), null)
    assert.equal(detectMediaType(Buffer.alloc(0)), null)
    assert.equal(detectMediaType('not a buffer'), null)
  })
})

describe('sanitizeTerminalText', () => {
  it('removes ANSI CSI and OSC sequences from filenames', () => {
    const cleaned = sanitizeTerminalText('evil\x1b]0;owned\x07\x1b[31m.png')
    assert.equal(cleaned, 'evil.png')
    assert.ok(!cleaned.includes('\x1b'))
    assert.ok(!cleaned.includes('\x07'))
  })

  it('drops control characters and collapses whitespace', () => {
    assert.equal(sanitizeTerminalText('shot\n\tname.png\x00'), 'shot name.png')
  })

  it('truncates long names without breaking code points', () => {
    const cleaned = sanitizeTerminalText('a'.repeat(50), { max: 10 })
    assert.equal(cleaned, `${'a'.repeat(10)}…`)
  })
})

describe('normalizeImagePath / splitDragPaths', () => {
  it('strips surrounding single and double quotes', () => {
    assert.equal(normalizeImagePath(`"${join(root, 'a b.png')}"`, { cwd: root }), join(root, 'a b.png'))
    assert.equal(normalizeImagePath(`'${join(root, 'a b.png')}'`, { cwd: root }), join(root, 'a b.png'))
  })

  it('unescapes backslash spaces and other shell-style escapes', () => {
    const escaped = join(root, 'a b.png').replace(/ /g, '\\ ')
    assert.equal(normalizeImagePath(escaped, { cwd: root }), join(root, 'a b.png'))
    assert.equal(normalizeImagePath(`${join(root, 'a(b)')}`.replace('(', '\\('), { cwd: root }), join(root, 'a(b)'))
  })

  it('expands ~ and ~/ against an injected home directory', () => {
    assert.equal(normalizeImagePath('~/pics/a.png', { home: root }), join(root, 'pics/a.png'))
    assert.equal(normalizeImagePath('~', { home: root }), root)
  })

  it('resolves relative paths against an injected cwd', () => {
    assert.equal(normalizeImagePath('a b.png', { cwd: root }), join(root, 'a b.png'))
  })

  it('splits a dragged path list with quotes and escaped spaces', () => {
    const first = join(nestedDir, 'first one.png')
    const second = join(root, 'second two.png')
    const dragText = `"${first}" ${second.replace(/ /g, '\\ ')}`
    assert.deepEqual(splitDragPaths(dragText, { cwd: root }), [first, second])
  })

  it('rejects unterminated quotes, trailing backslashes, and NUL bytes', () => {
    assert.throws(() => normalizeImagePath('"/tmp/no-end', {}), (error) => error.code === 'EINVALID_PATH')
    assert.throws(() => normalizeImagePath('/tmp/ends-with\\', {}), (error) => error.code === 'EINVALID_PATH')
    assert.throws(() => normalizeImagePath('/tmp/bad\0name', {}), (error) => error.code === 'EINVALID_PATH')
    assert.throws(() => splitDragPaths('"a b', {}), (error) => error.code === 'EINVALID_PATH')
  })
})

describe('loadImage', () => {
  it('loads each supported format and reports magic, not the extension', async () => {
    const cases = [
      ['photo.png', PNG_HEADER, 'image/png'],
      ['photo.jpg', JPEG_HEADER, 'image/jpeg'],
      ['photo.gif', GIF_HEADER, 'image/gif'],
      ['photo.webp', WEBP_HEADER, 'image/webp'],
      // A JPEG saved under a .png name must be reported as JPEG.
      ['misleading.png', JPEG_HEADER, 'image/jpeg'],
    ]
    for (const [name, header, mediaType] of cases) {
      const bytes = imageBytes(header)
      const file = join(root, name)
      await writeFile(file, bytes)
      const image = await loadImage(file)
      assert.equal(image.mediaType, mediaType)
      assert.equal(image.name, name)
      assert.equal(image.data, bytes.toString('base64'))
    }
  })

  it('loads paths containing spaces, quotes, escapes, ~, and relative paths', async () => {
    const bytes = imageBytes(PNG_HEADER)
    const spaced = join(nestedDir, 'space image.png')
    await writeFile(spaced, bytes)
    assert.equal((await loadImage(spaced)).name, 'space image.png')
    assert.equal((await loadImage(`"${spaced}"`)).name, 'space image.png')
    assert.equal((await loadImage(`'${spaced}'`)).name, 'space image.png')
    assert.equal((await loadImage(spaced.replace(/ /g, '\\ '))).name, 'space image.png')
    assert.equal((await loadImage('nested dir/space image.png', { cwd: root })).name, 'space image.png')
    await writeFile(join(root, 'tilde.png'), bytes)
    assert.equal((await loadImage('~/tilde.png', { home: root })).name, 'tilde.png')
  })

  it('rejects files whose magic bytes are not a supported image', async () => {
    const file = join(root, 'fake.png')
    await writeFile(file, 'definitely not a png')
    await expectMediaError(loadImage(file), 'EUNSUPPORTED_MEDIA_TYPE')

    const empty = join(root, 'empty.png')
    await writeFile(empty, Buffer.alloc(0))
    await expectMediaError(loadImage(empty), 'EUNSUPPORTED_MEDIA_TYPE')

    const riff = join(root, 'audio.png')
    const wav = Buffer.alloc(12)
    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(4, 4)
    wav.write('WAVE', 8, 'ascii')
    await writeFile(riff, wav)
    await expectMediaError(loadImage(riff), 'EUNSUPPORTED_MEDIA_TYPE')
  })

  it('rejects directories and missing files', async () => {
    await expectMediaError(loadImage(nestedDir), 'ENOT_A_FILE')
    await expectMediaError(loadImage(join(root, 'does-not-exist.png')), 'EIMAGE_NOT_FOUND')
  })

  it('never lets a shell-like path execute anything', async () => {
    const marker = join(root, 'pwned')
    const sneaky = join(root, `$(touch ${marker})`)
    await expectMediaError(loadImage(sneaky), 'EIMAGE_NOT_FOUND')
    await assert.rejects(access(marker), (error) => error.code === 'ENOENT')
  })

  it('rejects images larger than 5 MiB before reading the content', async () => {
    const file = join(root, 'huge.png')
    await makeSparseImage(file, MAX_IMAGE_BYTES + 1)
    await expectMediaError(loadImage(file), 'EIMAGE_TOO_LARGE')
  })
})

describe('loadImages', () => {
  it('returns images in input order', async () => {
    const one = join(root, 'one.png')
    const two = join(root, 'two.webp')
    await writeFile(one, imageBytes(PNG_HEADER))
    await writeFile(two, imageBytes(WEBP_HEADER))
    const images = await loadImages([one, two])
    assert.deepEqual(
      images.map((image) => [image.name, image.mediaType]),
      [
        ['one.png', 'image/png'],
        ['two.webp', 'image/webp'],
      ],
    )
  })

  it('returns an empty array for an empty list', async () => {
    assert.deepEqual(await loadImages([]), [])
  })

  it(`rejects more than ${MAX_IMAGES} images before touching the filesystem`, async () => {
    const missing = Array.from({ length: MAX_IMAGES + 1 }, (_, index) => join(root, `missing-${index}.png`))
    await expectMediaError(loadImages(missing), 'ETOO_MANY_IMAGES')
  })

  it('rejects a batch whose files exceed 12 MiB in total', async () => {
    const perFile = 4 * 1024 * 1024 + 100
    const files = []
    for (let index = 0; index < 3; index += 1) {
      const file = join(root, `batch-${index}.png`)
      await makeSparseImage(file, perFile)
      files.push(file)
    }
    assert.ok(3 * perFile > MAX_TOTAL_BYTES)
    await expectMediaError(loadImages(files), 'ETOTAL_TOO_LARGE')
  })

  it('rejects one image over the per-file limit and a directory in the batch', async () => {
    const huge = join(root, 'batch-huge.png')
    await makeSparseImage(huge, MAX_IMAGE_BYTES + 1)
    await expectMediaError(loadImages([huge]), 'EIMAGE_TOO_LARGE')
    await expectMediaError(loadImages([nestedDir]), 'ENOT_A_FILE')
  })

  it('accepts a dragged path list as one string', async () => {
    const first = join(nestedDir, 'drag one.png')
    const second = join(root, 'drag two.png')
    await writeFile(first, imageBytes(PNG_HEADER))
    await writeFile(second, imageBytes(GIF_HEADER))
    const dragText = `"${first}" ${second.replace(/ /g, '\\ ')}`
    const images = await loadImages(dragText, { cwd: root })
    assert.deepEqual(
      images.map((image) => image.name),
      ['drag one.png', 'drag two.png'],
    )
    assert.equal(images[1].mediaType, 'image/gif')
  })

  it('rejects non-path inputs with EINVALID_PATH', async () => {
    await expectMediaError(loadImages(42), 'EINVALID_PATH')
    await expectMediaError(loadImages(['']), 'EINVALID_PATH')
    assert.deepEqual(await loadImages(''), [])
  })
})

describe('readClipboardImage', () => {
  const png = imageBytes(PNG_HEADER)

  it('refuses non-macOS platforms without running anything', async () => {
    let calls = 0
    await assert.rejects(
      readClipboardImage({
        platform: 'linux',
        run: async () => {
          calls += 1
          return '{}'
        },
      }),
      (error) => {
        assert.ok(error instanceof MediaError)
        assert.equal(error.code, 'EUNSUPPORTED_PLATFORM')
        assert.match(error.message, /macOS/)
        return true
      },
    )
    assert.equal(calls, 0)
  })

  it('runs osascript in read-only mode and returns decoded base64', async () => {
    let captured
    const image = await readClipboardImage({
      platform: 'darwin',
      run: async (request) => {
        captured = request
        return JSON.stringify({ ok: true, mediaType: 'image/png', data: png.toString('base64') })
      },
    })
    assert.deepEqual(image, { mediaType: 'image/png', data: png.toString('base64'), name: 'clipboard.png' })
    assert.equal(typeof captured.script, 'string')
    assert.match(captured.script, /NSPasteboard\.generalPasteboard/)
    assert.match(captured.script, /public\.png/)
    assert.match(captured.script, /public\.tiff/)
    assert.match(captured.script, /representationUsingTypeProperties\(4, \$\(\)\)/)
    assert.match(captured.script, /base64EncodedStringWithOptions/)
    // The clipboard must only be read, never declared, cleared, or written.
    assert.doesNotMatch(captured.script, /setData|clearContents|declareTypes|writeObjects/)
    assert.equal(captured.timeoutMs, 8000)
    assert.equal(CLIPBOARD_JXA_SCRIPT, captured.script)
  })

  it('forwards a custom timeoutMs', async () => {
    let captured
    await readClipboardImage({
      platform: 'darwin',
      timeoutMs: 1234,
      run: async (request) => {
        captured = request
        return JSON.stringify({ ok: true, data: png.toString('base64') })
      },
    })
    assert.equal(captured.timeoutMs, 1234)
  })

  it('reports an empty clipboard as ECLIPBOARD_NO_IMAGE', async () => {
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: false, reason: 'no-image' }),
      }),
      'ECLIPBOARD_NO_IMAGE',
    )
  })

  it('reports an osascript timeout as ECLIPBOARD_TIMEOUT', async () => {
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => {
          const error = new Error('killed')
          error.killed = true
          error.signal = 'SIGTERM'
          throw error
        },
      }),
      'ECLIPBOARD_TIMEOUT',
    )
  })

  it('reports runner failures as ECLIPBOARD_FAILED', async () => {
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => {
          throw new Error('osascript exploded')
        },
      }),
      'ECLIPBOARD_FAILED',
    )
    await expectMediaError(
      readClipboardImage({ platform: 'darwin', run: async () => 'not json' }),
      'ECLIPBOARD_FAILED',
    )
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: false, reason: 'error', message: 'JXA broke' }),
      }),
      'ECLIPBOARD_FAILED',
    )
  })

  it('rejects mock results that are not real PNG data', async () => {
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true, mediaType: 'image/png', data: Buffer.from('hello').toString('base64') }),
      }),
      'ECLIPBOARD_BAD_PAYLOAD',
    )
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true, data: '!!!not-base64!!!' }),
      }),
      'ECLIPBOARD_BAD_PAYLOAD',
    )
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true }),
      }),
      'ECLIPBOARD_BAD_PAYLOAD',
    )
  })

  it('rejects non-canonical base64 clipboard payloads', async () => {
    // 70 bytes produces '==' padding, so stripping it yields a non-canonical length.
    const png = pngBytesOfSize(70).toString('base64')
    const cases = {
      whitespace: `${png.slice(0, 8)} ${png.slice(8)}`,
      newline: `${png}\n`,
      missingPadding: png.replace(/=+$/, ''),
      nonZeroPadBits: 'AB==',
    }
    for (const [label, data] of Object.entries(cases)) {
      await assert.rejects(
        readClipboardImage({
          platform: 'darwin',
          run: async () => JSON.stringify({ ok: true, mediaType: 'image/png', data }),
        }),
        (error) => {
          assert.equal(error.code, 'ECLIPBOARD_BAD_PAYLOAD', label)
          assert.match(error.message, /canonical base64/, label)
          return true
        },
      )
    }
  })

  it('rejects clipboard data whose PNG magic or declared type mismatches', async () => {
    const jpeg = imageBytes(JPEG_HEADER).toString('base64')
    await expectMediaError(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true, mediaType: 'image/png', data: jpeg }),
      }),
      'ECLIPBOARD_BAD_PAYLOAD',
    )
    const png = imageBytes(PNG_HEADER).toString('base64')
    await assert.rejects(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true, mediaType: 'image/jpeg', data: png }),
      }),
      (error) => {
        assert.equal(error.code, 'ECLIPBOARD_BAD_PAYLOAD')
        assert.match(error.message, /only PNG is accepted/)
        return true
      },
    )
  })

  it('rejects clipboard PNG payloads larger than 5 MiB', async () => {
    const bytes = pngBytesOfSize(MAX_IMAGE_BYTES + 1)
    await assert.rejects(
      readClipboardImage({
        platform: 'darwin',
        run: async () => JSON.stringify({ ok: true, mediaType: 'image/png', data: bytes.toString('base64') }),
      }),
      (error) => {
        assert.equal(error.code, 'ECLIPBOARD_BAD_PAYLOAD')
        assert.match(error.message, /too large/)
        return true
      },
    )
  })
})

describe('previewImage text fallbacks', () => {
  const itermEnv = { TERM_PROGRAM: 'iTerm.app' }

  it('never writes escapes to a non-TTY, even for forced modes', () => {
    for (const mode of ['auto', 'iterm', 'kitty']) {
      const output = fakeOutput({ isTTY: false })
      const result = previewImage(pngImage(), { output, mode, env: itermEnv })
      assert.equal(result.mode, 'text')
      assert.equal(result.rendered, false)
      assert.equal(result.reason, 'not-a-tty')
      assert.equal(output.text(), '[image] pixel.png (PNG, 70 B)\n')
      assert.ok(!output.text().includes('\x1b'))
      assert.ok(!output.text().includes('\x07'))
    }
  })

  it('honours mode=never on a TTY', () => {
    const output = fakeOutput({ isTTY: true, columns: 80, rows: 24 })
    const result = previewImage(pngImage(), { output, mode: 'never', env: itermEnv })
    assert.equal(result.mode, 'text')
    assert.equal(result.reason, 'mode-never')
    assert.ok(!output.text().includes('\x1b'))
  })

  it('falls back to text when NO_COLOR is set in auto mode', () => {
    const output = fakeOutput({ isTTY: true, columns: 80, rows: 24 })
    const result = previewImage(pngImage(), { output, env: { TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1' } })
    assert.equal(result.mode, 'text')
    assert.equal(result.reason, 'no-color')
    assert.ok(!output.text().includes('\x1b'))
  })

  it('falls back to text for dumb or unknown terminals', () => {
    for (const env of [{ TERM: 'dumb' }, { TERM_PROGRAM: 'Apple_Terminal' }, {}]) {
      const output = fakeOutput({ isTTY: true })
      const result = previewImage(pngImage(), { output, env })
      assert.equal(result.mode, 'text')
      assert.ok(!output.text().includes('\x1b'))
    }
    assert.equal(
      previewImage(pngImage(), { output: fakeOutput({ isTTY: true }), env: {} }).reason,
      'terminal-not-supported',
    )
  })

  it('keeps safety gates ahead of forced modes', () => {
    for (const [env, reason] of [
      [{ NO_COLOR: '' }, 'no-color'],
      [{ TERM: 'dumb' }, 'dumb-terminal'],
    ]) {
      const output = fakeOutput({ isTTY: true })
      const result = previewImage(pngImage(), { output, mode: 'iterm', env })
      assert.equal(result.mode, 'text')
      assert.equal(result.reason, reason)
      assert.ok(!output.text().includes('\x1b'))
    }
  })

  it('does not guess tmux/screen passthrough in auto mode', () => {
    const envs = [
      { TMUX: '/tmp/tmux-501/default,123,0', TERM_PROGRAM: 'iTerm.app' },
      { TMUX_PANE: '%1' },
      { TERM: 'screen-256color' },
      { TERM: 'tmux-256color' },
      { TERM_PROGRAM: 'tmux' },
    ]
    for (const env of envs) {
      const output = fakeOutput({ isTTY: true })
      const result = previewImage(pngImage(), { output, env })
      assert.equal(result.mode, 'text')
      assert.equal(result.reason, 'tmux-not-supported')
      assert.ok(!output.text().includes('\x1b'))
      assert.ok(!output.text().includes('\x07'))
    }
  })

  it('still honours an explicitly forced protocol inside tmux', () => {
    const output = fakeOutput({ isTTY: true })
    const result = previewImage(pngImage(), { output, mode: 'iterm', env: { TMUX: '1' } })
    assert.equal(result.mode, 'iterm')
    assert.match(output.text(), /^\x1b\]1337;File=/)
  })

  it('sanitizes control characters in the summary name', () => {
    const image = pngImage('shot\n\x1b[31m.png\x07')
    const output = fakeOutput({ isTTY: false })
    previewImage(image, { output })
    assert.equal(output.text(), '[image] shot .png (PNG, 70 B)\n')
    assert.ok(!output.text().includes('\x1b'))
  })

  it('rejects unknown modes and invalid images', () => {
    const output = fakeOutput({ isTTY: true })
    assert.throws(
      () => previewImage(pngImage(), { output, mode: 'sixel' }),
      (error) => error.code === 'EINVALID_MODE',
    )
    assert.throws(
      () => previewImage({ mediaType: 'image/png' }, { output }),
      (error) => error.code === 'EINVALID_IMAGE',
    )
    assert.throws(
      () => previewImage({ mediaType: 'image/png', data: 'not base64!', name: 'x.png' }, { output }),
      (error) => error.code === 'EINVALID_IMAGE',
    )
  })
})

describe('previewImage iTerm2 OSC 1337', () => {
  const itermEnv = { TERM_PROGRAM: 'iTerm.app' }
  const bytes = imageBytes(PNG_HEADER, Buffer.alloc(64))
  const image = pngImage('photo.png', bytes)

  it('emits a bounded inline image on a TTY', () => {
    const output = fakeOutput({ isTTY: true, columns: 80, rows: 24 })
    const result = previewImage(image, { output, env: itermEnv })
    const parsed = parseItermEscape(output.text())
    assert.equal(result.mode, 'iterm')
    assert.equal(result.rendered, true)
    assert.equal(parsed.name, 'photo.png')
    assert.equal(parsed.size, bytes.length)
    assert.equal(parsed.data, bytes.toString('base64'))
    assert.ok(parsed.width >= 1 && parsed.width <= 80)
    assert.ok(parsed.height >= 1 && parsed.height <= 24)
    assert.equal(result.width, parsed.width)
    assert.equal(result.height, parsed.height)
  })

  it('keeps the thumbnail inside small terminals', () => {
    const output = fakeOutput({ isTTY: true, columns: 20, rows: 10 })
    previewImage(image, { output, env: itermEnv })
    const parsed = parseItermEscape(output.text())
    assert.ok(parsed.width <= 20, `width ${parsed.width} exceeds 20 cells`)
    assert.ok(parsed.height <= 10, `height ${parsed.height} exceeds 10 rows`)
  })

  it('forces iTerm2 mode when asked, regardless of terminal env', () => {
    const output = fakeOutput({ isTTY: true })
    const result = previewImage(image, { output, mode: 'iterm', env: { TERM_PROGRAM: 'Apple_Terminal' } })
    assert.equal(result.mode, 'iterm')
    assert.match(output.text(), /^\x1b\]1337;File=/)
  })

  it('base64-encodes and sanitizes the filename in the escape', () => {
    const output = fakeOutput({ isTTY: true })
    const evil = pngImage('evil\x1b]0;owned\x07\x1b[31m.png', bytes)
    previewImage(evil, { output, env: itermEnv })
    const parsed = parseItermEscape(output.text())
    assert.equal(parsed.name, 'evil.png')
    assert.ok(!parsed.name.includes('\x1b'))
    assert.ok(!parsed.name.includes('\x07'))
  })

  it('supports JPEG/GIF/WEBP payloads because iTerm2 decodes them natively', () => {
    for (const [header, mediaType] of [
      [JPEG_HEADER, 'image/jpeg'],
      [GIF_HEADER, 'image/gif'],
      [WEBP_HEADER, 'image/webp'],
    ]) {
      const output = fakeOutput({ isTTY: true })
      const mediaBytes = imageBytes(header)
      previewImage({ mediaType, data: mediaBytes.toString('base64'), name: 'x' }, { output, env: itermEnv })
      assert.equal(parseItermEscape(output.text()).data, mediaBytes.toString('base64'))
    }
  })
})

describe('previewImage kitty graphics protocol', () => {
  const kittyEnv = { KITTY_WINDOW_ID: '1' }

  it('chunks base64 into <=4096-character escapes with first-frame c/r limits', () => {
    // 7500 PNG bytes -> 10000 base64 chars -> 4096 + 4096 + 1808.
    const image = pngImageOfSize('wide.png', 7500)
    assert.equal(image.data.length, 10000)
    const output = fakeOutput({ isTTY: true, columns: 80, rows: 24 })
    const result = previewImage(image, { output, env: kittyEnv })
    const sequences = parseKittyEscapes(output.text())
    assert.equal(result.mode, 'kitty')
    assert.equal(result.rendered, true)
    assert.equal(sequences.length, 3)
    assert.equal(result.chunks, 3)
    const first = parseKittyKeys(sequences[0])
    assert.equal(first.f, '100')
    assert.equal(first.a, 'T')
    assert.equal(first.q, '2')
    assert.equal(first.m, '1')
    assert.ok(Number(first.c) >= 1 && Number(first.c) <= 80, `c=${first.c}`)
    assert.ok(Number(first.r) >= 1 && Number(first.r) <= 24, `r=${first.r}`)
    assert.equal(result.columns, Number(first.c))
    assert.equal(result.rows, Number(first.r))
    assert.equal(sequences[1].keys, 'm=1')
    assert.equal(sequences[2].keys, 'm=0')
    for (const sequence of sequences) assert.ok(sequence.payload.length <= 4096)
    assert.equal(sequences.map((sequence) => sequence.payload).join(''), image.data)
  })

  it('uses a single sequence when the payload fits, still capped by c/r', () => {
    // 3072 PNG bytes -> exactly 4096 base64 characters.
    const image = pngImageOfSize('one.png', 3072)
    assert.equal(image.data.length, 4096)
    const output = fakeOutput({ isTTY: true, columns: 20, rows: 10 })
    const result = previewImage(image, { output, env: kittyEnv })
    const sequences = parseKittyEscapes(output.text())
    assert.equal(result.chunks, 1)
    assert.equal(sequences.length, 1)
    const keys = parseKittyKeys(sequences[0])
    assert.equal(keys.f, '100')
    assert.equal(keys.m, '0')
    assert.ok(Number(keys.c) >= 1 && Number(keys.c) <= 20, `c=${keys.c}`)
    assert.ok(Number(keys.r) >= 1 && Number(keys.r) <= 10, `r=${keys.r}`)
  })

  it('splits at the 4096-character boundary and round-trips PNG bytes', () => {
    const bytes = pngBytesOfSize(6144) // 8192 base64 chars -> 2 chunks
    const image = pngImage('real.png', bytes)
    const output = fakeOutput({ isTTY: true })
    previewImage(image, { output, mode: 'kitty', env: {} })
    const sequences = parseKittyEscapes(output.text())
    assert.equal(sequences.length, 2)
    assert.equal(parseKittyKeys(sequences[0]).m, '1')
    assert.equal(parseKittyKeys(sequences[1]).m, '0')
    assert.equal(parseKittyKeys(sequences[1]).c, undefined)
    const joined = sequences.map((sequence) => sequence.payload).join('')
    assert.deepEqual(Buffer.from(joined, 'base64'), bytes)
  })

  it('falls back to text for non-PNG images in kitty mode', () => {
    const image = { mediaType: 'image/jpeg', data: imageBytes(JPEG_HEADER).toString('base64'), name: 'photo.jpg' }
    const output = fakeOutput({ isTTY: true })
    const result = previewImage(image, { output, mode: 'kitty', env: {} })
    assert.equal(result.mode, 'text')
    assert.equal(result.reason, 'kitty-requires-png')
    assert.ok(!output.text().includes('\x1b'))
  })

  it('auto-detects kitty from TERM as well', () => {
    const output = fakeOutput({ isTTY: true })
    const result = previewImage(pngImage(), { output, env: { TERM: 'xterm-kitty' } })
    assert.equal(result.mode, 'kitty')
  })
})

describe('previewImage payload validation', () => {
  const valid = pngImage()

  function expectInvalid(payload, pattern) {
    assert.throws(
      () => previewImage(payload, { output: fakeOutput({ isTTY: true }) }),
      (error) => {
        assert.equal(error.code, 'EINVALID_IMAGE')
        assert.match(error.message, pattern)
        return true
      },
    )
  }

  it('rejects non-canonical base64', () => {
    expectInvalid({ ...valid, data: `${valid.data.slice(0, 8)} ${valid.data.slice(8)}` }, /canonical base64/)
    expectInvalid({ ...valid, data: `${valid.data}\n` }, /canonical base64/)
    expectInvalid({ ...valid, data: valid.data.replace(/=+$/, '') }, /canonical base64/)
    // "AB==" decodes, but its pad bits are non-zero; canonical re-encoding is "AA==".
    expectInvalid({ ...valid, data: 'AB==' }, /canonical base64/)
  })

  it('rejects a declared mediaType that does not match the magic bytes', () => {
    expectInvalid(
      { mediaType: 'image/png', data: imageBytes(JPEG_HEADER).toString('base64'), name: 'fake.png' },
      /does not match/,
    )
    expectInvalid(
      { mediaType: 'image/jpeg', data: imageBytes(PNG_HEADER).toString('base64'), name: 'fake.jpg' },
      /does not match/,
    )
    expectInvalid(
      { mediaType: 'image/png', data: Buffer.from('AAAA').toString('base64'), name: 'fake.png' },
      /magic number/,
    )
  })

  it('rejects preview payloads larger than 5 MiB', () => {
    const bytes = pngBytesOfSize(MAX_IMAGE_BYTES + 1)
    assert.throws(
      () => previewImage({ mediaType: 'image/png', data: bytes.toString('base64'), name: 'huge.png' }, {
        output: fakeOutput({ isTTY: true }),
      }),
      (error) => {
        assert.equal(error.code, 'EIMAGE_TOO_LARGE')
        assert.match(error.message, /too large/)
        return true
      },
    )
  })

  it('accepts Buffer image data after the same checks', () => {
    const output = fakeOutput({ isTTY: true })
    const result = previewImage(
      { mediaType: 'image/png', data: pngBytesOfSize(100), name: 'buffer.png' },
      { output, mode: 'iterm', env: {} },
    )
    assert.equal(result.mode, 'iterm')
    assert.equal(parseItermEscape(output.text()).size, 100)
  })
})

describe('previewImage iTerm2 multipart framing', () => {
  const itermEnv = { TERM_PROGRAM: 'iTerm.app' }

  it('keeps a normal image in a single File escape', () => {
    const image = pngImageOfSize('small.png', 3000)
    const output = fakeOutput({ isTTY: true, columns: 100, rows: 40 })
    const result = previewImage(image, { output, env: itermEnv })
    assert.equal(result.multipart, false)
    assert.equal(parseItermEscape(output.text()).name, 'small.png')
    assert.doesNotMatch(output.text(), /MultipartFile|FilePart|FileEnd/)
  })

  it('switches to MultipartFile/FilePart/FileEnd above the 1 MiB single OSC', () => {
    // 800000 bytes -> ~1.07 MiB of base64, past iTerm2's 1,048,576-byte cap.
    const image = pngImageOfSize('big.png', 800_000)
    const output = fakeOutput({ isTTY: true, columns: 100, rows: 40 })
    const result = previewImage(image, { output, env: itermEnv })
    assert.equal(result.mode, 'iterm')
    assert.equal(result.multipart, true)
    assert.equal(result.bytes, 800_000)
    assert.ok(result.chunks >= 2)
    const parsed = parseMultipartIterm(output.text())
    assert.equal(Buffer.from(parsed.args.name, 'base64').toString('utf8'), 'big.png')
    assert.equal(parsed.args.size, '800000')
    assert.ok(Number(parsed.args.width) >= 1 && Number(parsed.args.width) <= 100)
    assert.ok(Number(parsed.args.height) >= 1 && Number(parsed.args.height) <= 40)
    assert.ok(parsed.parts.length >= 2)
    for (const part of parsed.parts) assert.ok(part.length <= 64 * 1024, `part length ${part.length}`)
    assert.equal(parsed.parts.join(''), image.data)
    assert.equal(parsed.ended, true)
  })

  it('uses bounded 64 KiB parts for an image at the 5 MiB cap', () => {
    const image = pngImageOfSize('max.png', MAX_IMAGE_BYTES)
    const output = fakeOutput({ isTTY: true, columns: 100, rows: 40 })
    const result = previewImage(image, { output, env: itermEnv })
    assert.equal(result.multipart, true)
    const parsed = parseMultipartIterm(output.text())
    assert.equal(parsed.parts.join(''), image.data)
    assert.ok(parsed.parts.every((part) => part.length <= 64 * 1024))
    assert.equal(parsed.ended, true)
  })
})

describe('formatBytes', () => {
  it('formats byte counts for summaries', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(70), '70 B')
    assert.equal(formatBytes(1024), '1.0 KiB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB')
    assert.equal(formatBytes(12 * 1024 * 1024), '12 MiB')
  })
})
