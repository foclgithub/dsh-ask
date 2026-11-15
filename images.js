/**
 * Image-input vocabulary shared by the loopback bridge routes.
 *
 * The bridge accepts image bytes in the same wire form the Host's own prompt
 * endpoints accept: canonical base64 inside a `{ type: 'image', mediaType,
 * data, name? }` part. Everything in this module is pure - no I/O, no Host
 * services - so a payload can be rejected before any Session is resolved or
 * created, and so `/local-cli/ask` and `/local-cli/stream` enforce exactly the
 * same rules.
 *
 * The limits are deliberately stricter than the Host's default attachment
 * limits (20 images, 50 MiB each): one loopback request is buffered whole, so
 * the bridge caps it at 4 images, 5 MiB per image and 12 MiB of decoded image
 * bytes. Twelve MiB of bytes becomes about 16 MiB of base64 inside the JSON
 * envelope, so the request-body cap is 18 MiB.
 */

/** Raster formats the Host's version-one attachment path stores. */
export const IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** Intake limits enforced by the bridge before a Session is created. */
export const IMAGE_LIMITS = Object.freeze({
  /** At most this many images in one prompt. */
  maxImages: 4,
  /** Decoded bytes allowed for any single image. */
  maxImageBytes: 5 * 1024 * 1024,
  /** Decoded bytes allowed across all images in one prompt. */
  maxTotalBytes: 12 * 1024 * 1024,
  /** Whole JSON request body, including base64 and envelope overhead. */
  bodyLimitBytes: 18 * 1024 * 1024,
  mediaTypes: IMAGE_MEDIA_TYPES,
})

/** Whole-request JSON body cap; base64 inflates 12 MiB of bytes to ~16 MiB. */
export const IMAGE_BODY_LIMIT_BYTES = IMAGE_LIMITS.bodyLimitBytes

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Object.freeze([0xff, 0xd8, 0xff])
const MAX_IMAGE_NAME_LENGTH = 255

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

/**
 * Whether the bytes really are the image format the caller declared.
 * The Host re-checks this during admission; checking it here keeps a rejected
 * payload from creating a durable attachment it cannot use.
 *
 * @param {string} mediaType declared media type, already known to be supported
 * @param {Uint8Array} bytes decoded image bytes
 * @returns {boolean} true when the leading bytes match the format's signature
 */
export function matchesMediaType(mediaType, bytes) {
  switch (mediaType) {
    case 'image/png':
      return startsWith(bytes, PNG_SIGNATURE)
    case 'image/jpeg':
      return startsWith(bytes, JPEG_SIGNATURE)
    case 'image/gif': {
      if (bytes.length < 6) return false
      const header = Buffer.from(bytes.buffer, bytes.byteOffset, 6).toString('latin1')
      return header === 'GIF87a' || header === 'GIF89a'
    }
    case 'image/webp': {
      if (bytes.length < 12) return false
      const header = Buffer.from(bytes.buffer, bytes.byteOffset, 12)
      return header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP'
    }
    default:
      return false
  }
}

/**
 * Decode an upload payload only when it round-trips to the same string, which
 * is how the Host rejects non-canonical base64 (padding included).
 *
 * @param {string} data candidate base64 payload
 * @returns {Buffer | undefined} decoded bytes, or undefined when non-canonical
 */
export function decodeCanonicalBase64(data) {
  if (typeof data !== 'string' || data === '') return undefined
  const decoded = Buffer.from(data, 'base64')
  if (decoded.length === 0) return undefined
  if (decoded.toString('base64') !== data) return undefined
  return decoded
}

function failure(code, error, index) {
  const detail = { code, error }
  if (index !== undefined) detail.index = index
  return { ok: false, error: detail }
}

function normalizeName(value, index) {
  if (value === undefined) return { name: undefined }
  if (typeof value !== 'string') {
    return { error: failure('invalid-image-name', `images[${index}].name must be a string`, index).error }
  }
  const name = value.trim()
  if (name === '') {
    return { error: failure('invalid-image-name', `images[${index}].name must not be empty`, index).error }
  }
  if (name.length > MAX_IMAGE_NAME_LENGTH) {
    return {
      error: failure(
        'invalid-image-name',
        `images[${index}].name must be at most ${MAX_IMAGE_NAME_LENGTH} characters`,
        index,
      ).error,
    }
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return {
      error: failure('invalid-image-name', `images[${index}].name must not contain control characters`, index).error,
    }
  }
  return { name }
}

/**
 * Validate and normalize the `images` member of a request body.
 *
 * Accepts the Host's prompt-content shape (`type: 'image'` optional, must be
 * `'image'` when present) and returns decoded sizes without exposing the
 * payloads in any error. An absent member (`undefined`) or an empty array
 * means "no images"; an explicit `null` is a malformed member, not an
 * omission, and is rejected like any other non-array value.
 *
 * @param {unknown} input value of `body.images`
 * @returns {{ ok: true, images: Array<{ mediaType: string, data: string, bytes: number, name?: string }> }
 *   | { ok: false, error: { code: string, error: string, index?: number } }}
 */
export function validateImages(input) {
  if (input === undefined) return { ok: true, images: [] }
  if (!Array.isArray(input)) {
    return failure('invalid-images', 'images must be an array of image parts')
  }
  if (input.length === 0) return { ok: true, images: [] }
  if (input.length > IMAGE_LIMITS.maxImages) {
    return failure(
      'too-many-images',
      `at most ${IMAGE_LIMITS.maxImages} images are allowed; got ${input.length}`,
    )
  }

  const images = []
  let totalBytes = 0
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return failure('invalid-image', `images[${index}] must be an object`, index)
    }
    if (entry.type !== undefined && entry.type !== 'image') {
      return failure('invalid-image-type', `images[${index}].type must be "image"`, index)
    }
    if (typeof entry.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(entry.mediaType)) {
      return failure(
        'unsupported-image-media-type',
        `images[${index}].mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`,
        index,
      )
    }
    if (typeof entry.data !== 'string' || entry.data === '') {
      return failure('invalid-image-data', `images[${index}].data must be a non-empty base64 string`, index)
    }

    const named = normalizeName(entry.name, index)
    if (named.error !== undefined) return { ok: false, error: named.error }

    const bytes = decodeCanonicalBase64(entry.data)
    if (bytes === undefined) {
      return failure('invalid-image-base64', `images[${index}].data is not canonical base64`, index)
    }
    if (bytes.length > IMAGE_LIMITS.maxImageBytes) {
      return failure(
        'image-too-large',
        `images[${index}] is ${bytes.length} bytes; the per-image limit is ${IMAGE_LIMITS.maxImageBytes} bytes`,
        index,
      )
    }
    if (!matchesMediaType(entry.mediaType, bytes)) {
      return failure(
        'image-type-mismatch',
        `images[${index}] bytes do not match the declared mediaType ${entry.mediaType}`,
        index,
      )
    }

    totalBytes += bytes.length
    if (totalBytes > IMAGE_LIMITS.maxTotalBytes) {
      return failure(
        'images-too-large',
        `images exceed the ${IMAGE_LIMITS.maxTotalBytes}-byte total limit`,
        index,
      )
    }

    const image = {
      mediaType: entry.mediaType,
      data: entry.data,
      bytes: bytes.length,
    }
    if (named.name !== undefined) image.name = named.name
    images.push(image)
  }

  return { ok: true, images }
}

/**
 * Build the `content` array handed to `sessionController.prompt`.
 *
 * A trimmed text part comes first when text survives trimming; image parts
 * follow in caller order. An image-only prompt therefore yields image parts
 * alone, and a text-only prompt yields exactly the old text part.
 *
 * @param {unknown} text raw `body.text`
 * @param {Array<{ mediaType: string, data: string, name?: string }>} images validated images
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', mediaType: string, data: string, name?: string }>}
 */
export function buildPromptContent(text, images) {
  const content = []
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed !== '') content.push({ type: 'text', text: trimmed })
  for (const image of images ?? []) {
    const part = { type: 'image', mediaType: image.mediaType, data: image.data }
    if (image.name !== undefined) part.name = image.name
    content.push(part)
  }
  return content
}

/** Machine-readable intake limits for the health response. */
export function imageCapabilities() {
  return {
    supported: true,
    maxImages: IMAGE_LIMITS.maxImages,
    maxImageBytes: IMAGE_LIMITS.maxImageBytes,
    maxTotalBytes: IMAGE_LIMITS.maxTotalBytes,
    bodyLimitBytes: IMAGE_LIMITS.bodyLimitBytes,
    mediaTypes: [...IMAGE_MEDIA_TYPES],
  }
}
