/**
 * Approval transport (item B): the official owner/answer Node Client carrier.
 *
 * This module is the `transport` half of the terminal approval channel. It
 * turns the Host's own launch token into an in-memory `/connect` Cookie, builds
 * an independent official Cordis client tree inside the Host process
 * (`dsh-client-connection` + `dsh-typert-registry` + `dsh-api-gateway`), and
 * exposes the `transport({ sessionId, onRequest, onDisconnect })` factory that
 * `approval-channel.js` consumes.
 *
 * Contract: docs/permissions.md (approval channel) and docs/architecture.md;
 * upstream behavior is the official Host `/connect` + `$events` contract.
 *
 * Security posture:
 * - The caller's identity is the Cookie minted by the Host's own
 *   `GET /connect?token=...&interactions=answer`; nothing here fabricates a
 *   principal or reads Host internals.
 * - The token, Cookie, and authenticated URL stay in memory and in fixed,
 *   redacted error messages. They are never logged, returned, or written.
 * - Only one Host Agent (the claimed session id) resolves to the local client
 *   Context. Every other forwarded waterfall is left to the Host's `next`.
 * - No Host patch, no profile access, no global event subscription that could
 *   take over the desktop approval card.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Explicit override for the Host runtime directory used to resolve official packages. */
export const HOST_RUNTIME_ENV = 'DSH_HOST_RUNTIME_DIR'

/**
 * Cordis compatibility for the DSH 0.2.2-rc.1 runtime (`~4.1.0` peer range).
 * Cordis is a separate version line from the DSH client packages, so it is
 * checked against this range instead of the Host version.
 */
const CORDIS_COMPATIBLE_MAJOR = 4
const CORDIS_COMPATIBLE_MINOR = 1

/** Official Host packages this transport builds its client tree from. */
export const HOST_MODULE_SPECIFIERS = Object.freeze({
  cordis: '@deepseek-ai/cordis',
  clientConnection: '@deepseek-ai/dsh-client-connection/client',
  typertClient: '@deepseek-ai/dsh-typert-registry/client',
  gatewayClient: '@deepseek-ai/dsh-api-gateway/client',
  websocket: 'ws',
})

/** How long one transport open may wait for the official client to reach `connected`. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** Stable code for a transport that cannot be built in this Host. */
export const TRANSPORT_UNAVAILABLE = 'transport-unavailable'

const AUTH_FAILED = 'transport-auth-failed'
const INVALID_REQUEST = 'invalid-request'
const ERROR_CODES = new Set([INVALID_REQUEST, TRANSPORT_UNAVAILABLE, AUTH_FAILED])

const HOST_PACKAGES = Object.freeze({
  cordis: '@deepseek-ai/cordis',
  clientConnection: '@deepseek-ai/dsh-client-connection',
  typertClient: '@deepseek-ai/dsh-typert-registry',
  gatewayClient: '@deepseek-ai/dsh-api-gateway',
})

const CONNECT_PATH = '/connect'
const MUX_PATH = '/api/remote.mux'
const INTERACTIONS = 'answer'
const TOKEN_QUERY = 'token'
const DETAIL_KEYS = Object.freeze(['toolName', 'callId', 'reason', 'displayReason'])
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

/** Business error carrying a stable machine-readable `code`. */
export class ApprovalTransportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApprovalTransportError'
    this.code = code
  }
}

function raise(code, message) {
  throw new ApprovalTransportError(code, message)
}

function unavailable(message) {
  return new ApprovalTransportError(TRANSPORT_UNAVAILABLE, message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

function noopLogger() {
  return { warn() {} }
}

function normalizeLogger(logger) {
  return isRecord(logger) && typeof logger.warn === 'function' ? logger : noopLogger()
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_CONNECT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    raise(INVALID_REQUEST, 'connectTimeoutMs must be a positive finite number')
  }
  return Math.floor(value)
}

/** Read one public Host service from a Cordis context or a plain service bag. */
function serviceOf(host, name) {
  if (host === undefined || host === null) return undefined
  if (typeof host.get === 'function') return host.get(name)
  return host[name]
}

/**
 * Normalize the Host origin and keep it as the single same-origin authority.
 * @param {object} host - Host context or `{ connection, webServer }`.
 * @param {string|undefined} override - explicit origin (tests or deployment).
 * @returns {string} normalized origin.
 */
function resolveOrigin(host, override) {
  let raw = override
  if (raw === undefined) {
    const webServer = serviceOf(host, 'webServer')
    if (typeof webServer?.getOrigin !== 'function') {
      raise(TRANSPORT_UNAVAILABLE, 'Host web server origin is unavailable')
    }
    try {
      raw = webServer.getOrigin()
    } catch {
      raise(TRANSPORT_UNAVAILABLE, 'Host web server origin is unavailable')
    }
  }
  if (typeof raw !== 'string' || raw === '') {
    raise(TRANSPORT_UNAVAILABLE, 'Host web server origin is unavailable')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    raise(TRANSPORT_UNAVAILABLE, 'Host web server origin is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    raise(TRANSPORT_UNAVAILABLE, 'Host web server origin is invalid')
  }
  return url.origin
}

/**
 * Mint the official `/connect` URL from the Host's public authenticated URL.
 * The launch token only exists in the local URL returned here.
 * @param {object} host - Host context or `{ connection }`.
 * @param {string} origin - normalized Host origin.
 * @returns {URL} connect URL carrying `token` and `interactions=answer`.
 */
function mintConnectUrl(host, origin) {
  const connection = serviceOf(host, 'connection')
  if (typeof connection?.authenticatedUrl !== 'function') {
    raise(TRANSPORT_UNAVAILABLE, 'Host connection service is unavailable')
  }
  let authenticated
  try {
    authenticated = connection.authenticatedUrl(origin)
  } catch {
    raise(TRANSPORT_UNAVAILABLE, 'Host could not mint an authentication URL')
  }
  let url
  try {
    url = new URL(String(authenticated))
  } catch {
    raise(AUTH_FAILED, 'Host authentication URL is invalid')
  }
  if (url.origin !== origin) {
    raise(AUTH_FAILED, 'Host authentication URL does not match the Host origin')
  }
  const tokens = url.searchParams.getAll(TOKEN_QUERY)
  if (tokens.length !== 1 || tokens[0] === '') {
    raise(AUTH_FAILED, 'Host authentication URL carries no single launch token')
  }
  const connect = new URL(CONNECT_PATH, origin)
  connect.searchParams.set(TOKEN_QUERY, tokens[0])
  connect.searchParams.set('interactions', INTERACTIONS)
  return connect
}

function readHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    if (typeof value === 'string') return value
  }
  const direct = headers[name]
  return typeof direct === 'string' ? direct : undefined
}

function readSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    const values = headers.getSetCookie()
    if (Array.isArray(values)) return values
  }
  const raw = readHeader(headers, 'set-cookie')
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

/**
 * Parse and validate the host-only session Cookie the Host's `/connect` mints.
 * @param {string} raw - one `Set-Cookie` value.
 * @param {boolean} secure - whether the Host listener is TLS.
 * @returns {{ cookie: string }|undefined} `name=value` pair or undefined.
 */
function parseSessionCookie(raw, secure) {
  if (typeof raw !== 'string' || raw === '') return undefined
  const segments = raw.split(';')
  const pair = segments[0] ?? ''
  const at = pair.indexOf('=')
  if (at <= 0) return undefined
  const name = pair.slice(0, at).trim()
  const value = pair.slice(at + 1).trim()
  if (!COOKIE_NAME.test(name) || value === '' || !COOKIE_VALUE.test(value)) return undefined
  const attributes = new Map()
  for (const segment of segments.slice(1)) {
    const text = segment.trim()
    if (text === '') continue
    const eq = text.indexOf('=')
    const key = (eq === -1 ? text : text.slice(0, eq)).trim().toLowerCase()
    const attributeValue = eq === -1 ? '' : text.slice(eq + 1).trim()
    if (key !== '') attributes.set(key, attributeValue)
  }
  if (!attributes.has('httponly')) return undefined
  if ((attributes.get('samesite') ?? '').toLowerCase() !== 'strict') return undefined
  if ((attributes.get('path') ?? '') !== '/') return undefined
  // A Domain attribute would widen the credential beyond the Host authority.
  if (attributes.has('domain')) return undefined
  if (attributes.has('secure') !== secure) return undefined
  return { cookie: `${name}=${value}` }
}

function isMuxRedirect(location, connectUrl) {
  let target
  try {
    target = new URL(location, connectUrl)
  } catch {
    return false
  }
  return target.origin === connectUrl.origin && target.pathname === MUX_PATH
}

/**
 * Exchange the Host launch token for its in-memory API Cookie.
 * @param {URL} connectUrl - official `/connect` URL.
 * @param {typeof fetch} fetchImpl - fetch implementation.
 * @returns {Promise<string>} `name=value` Cookie header value.
 */
async function exchangeConnect(connectUrl, fetchImpl) {
  let response
  try {
    response = await fetchImpl(connectUrl.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/plain' },
    })
  } catch {
    raise(AUTH_FAILED, 'launch-token exchange could not reach the Host')
  }
  if (response === undefined || response === null || response.status !== 302) {
    raise(AUTH_FAILED, 'launch-token exchange was rejected')
  }
  const location = readHeader(response.headers, 'location')
  if (location === undefined || !isMuxRedirect(location, connectUrl)) {
    raise(AUTH_FAILED, 'launch-token exchange returned an unexpected redirect')
  }
  const secure = connectUrl.protocol === 'https:'
  const cookies = readSetCookies(response.headers)
  for (const raw of cookies) {
    const parsed = parseSessionCookie(raw, secure)
    if (parsed !== undefined) return parsed.cookie
  }
  raise(AUTH_FAILED, 'launch-token exchange returned no usable session cookie')
  return undefined
}

/**
 * fetch for the official client tree: same-origin only, Cookie always attached.
 * @param {object} options - origin, mutable credential holder, fetch implementation.
 * @returns {(input: string|URL, init?: object) => Promise<Response>} authenticated fetch.
 */
function createCookieFetch({ origin, credentials, fetchImpl }) {
  return async function cookieFetch(input, init = {}) {
    const cookie = credentials.cookie
    if (cookie === undefined) raise(AUTH_FAILED, 'the approval connection is closed')
    let url
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : String(input), origin)
    } catch {
      raise(AUTH_FAILED, 'the approval request target is invalid')
    }
    if (url.origin !== origin) raise(AUTH_FAILED, 'the approval request target is outside the Host origin')
    const headers = new Headers(init.headers ?? {})
    headers.set('cookie', cookie)
    return fetchImpl(url.href, { ...init, headers, redirect: 'error' })
  }
}

/**
 * WebSocket factory for the official client tree: same-origin only, Cookie attached.
 * @param {object} options - origin, mutable credential holder, WebSocket constructor.
 * @returns {(url: string|URL) => object} socket factory.
 */
function createCookieSocketFactory({ origin, credentials, WebSocketImpl }) {
  const host = new URL(origin)
  const protocol = host.protocol === 'https:' ? 'wss:' : 'ws:'
  return function createWebSocket(input) {
    const cookie = credentials.cookie
    if (cookie === undefined) raise(AUTH_FAILED, 'the approval connection is closed')
    let target
    try {
      target = new URL(String(input))
    } catch {
      raise(AUTH_FAILED, 'the approval stream target is invalid')
    }
    if (target.protocol !== protocol || target.host !== host.host) {
      raise(AUTH_FAILED, 'the approval stream target is outside the Host origin')
    }
    return new WebSocketImpl(target.href, { headers: { cookie } })
  }
}

function pluginFunction(plugin) {
  if (typeof plugin === 'function') return plugin
  if (isRecord(plugin) && typeof plugin.apply === 'function') return plugin.apply
  return undefined
}

function assertModules(modules, createWebSocket) {
  if (!isRecord(modules)) raise(TRANSPORT_UNAVAILABLE, 'official Host client modules are unavailable')
  if (typeof modules.Context !== 'function' || typeof modules.installConnection !== 'function') {
    raise(TRANSPORT_UNAVAILABLE, 'official Host client modules are incomplete')
  }
  if (pluginFunction(modules.typertClient) === undefined || pluginFunction(modules.gatewayClient) === undefined) {
    raise(TRANSPORT_UNAVAILABLE, 'official Host client plugins are incomplete')
  }
  if (typeof createWebSocket !== 'function' && typeof modules.WebSocket !== 'function') {
    raise(TRANSPORT_UNAVAILABLE, 'official Host WebSocket module is unavailable')
  }
}

function readService(root, name) {
  if (typeof root?.get === 'function') return root.get(name)
  return root?.[name]
}

function pickApprovalDetails(request) {
  const details = {}
  for (const key of DETAIL_KEYS) {
    const value = request[key]
    if (typeof value === 'string') details[key] = value
  }
  return details
}

/**
 * Map one forwarded waterfall request to the transport contract.
 * Only the claimed session's Context reaches this function.
 * @param {object} context - request, waterfall receiver, local root, callbacks.
 * @returns {Promise<unknown>} waterfall value or the `next()` continuation.
 */
async function answerApprovalRequest({ request, receiver, root, next, isClosed, onRequest, sessionId, logger }) {
  if (isClosed()) return next()
  if (receiver !== root || !isRecord(request)) return next()
  if (request.agent !== root) return next()
  const signal = request.signal
  if (signal !== undefined && signal !== null && signal.aborted) return next()
  let outcome
  try {
    outcome = await onRequest({ sessionId, details: pickApprovalDetails(request), signal })
  } catch {
    logger.warn('approval-transport: approval request handler failed; delegating')
    return next()
  }
  if (isClosed()) return next()
  if (signal !== undefined && signal !== null && signal.aborted) return next()
  if (outcome === 'allowed-once' || outcome === 'rejected') return outcome
  return next()
}

/**
 * Observe the official client's connection state.
 * @param {object} connection - installed connection handle.
 * @param {number} timeoutMs - readiness timeout.
 * @param {Function|undefined} onDisconnect - notified once per loss after readiness.
 * @param {object} logger - redacted logger.
 * @returns {{ ready: Promise<void>, cleanup: Function }} readiness and teardown.
 */
function watchConnection(connection, timeoutMs, onDisconnect, logger) {
  const state = connection?.state
  if (state === undefined || typeof state.getSnapshot !== 'function' || typeof state.subscribe !== 'function') {
    raise(TRANSPORT_UNAVAILABLE, 'official client connection state is unavailable')
  }
  let settleReady
  let failReady
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve
    failReady = reject
  })
  let connected = false
  let lost = false
  let disposed = false
  let timer

  const evaluate = () => {
    if (disposed) return
    let value
    try {
      value = state.getSnapshot()
    } catch {
      return
    }
    if (value === 'connected') {
      const first = !connected
      connected = true
      lost = false
      if (first) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        settleReady()
      }
      return
    }
    if (connected && !lost) {
      lost = true
      if (typeof onDisconnect === 'function') {
        try {
          onDisconnect('connection-lost')
        } catch {
          logger.warn('approval-transport: disconnect handler failed')
        }
      }
    }
  }

  let unsubscribe
  try {
    unsubscribe = state.subscribe(evaluate)
  } catch {
    raise(TRANSPORT_UNAVAILABLE, 'official client connection state is unavailable')
  }
  evaluate()
  if (!connected) {
    timer = setTimeout(() => {
      timer = undefined
      if (!connected && !disposed) {
        failReady(unavailable('official client connection was not ready before the timeout'))
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    try {
      unsubscribe?.()
    } catch {
      // Teardown must not throw.
    }
    failReady(unavailable('official client connection was closed before it became ready'))
  }

  return { ready, cleanup }
}

function sanitizeFailure(error, message) {
  if (error instanceof ApprovalTransportError) return error
  const code = isRecord(error) && typeof error.code === 'string' && ERROR_CODES.has(error.code) ? error.code : TRANSPORT_UNAVAILABLE
  return new ApprovalTransportError(code, message)
}

function packageJsonUrl(moduleUrl, packageName) {
  const marker = `/node_modules/${packageName}/`
  const index = moduleUrl.lastIndexOf(marker)
  if (index < 0) return undefined
  return `${moduleUrl.slice(0, index + marker.length)}package.json`
}

async function readHostVersions(urls, readText) {
  const versions = {}
  for (const [key, packageName] of Object.entries(HOST_PACKAGES)) {
    const manifestUrl = packageJsonUrl(urls[key], packageName)
    if (manifestUrl === undefined) {
      raise(TRANSPORT_UNAVAILABLE, `official Host package ${key} resolved outside node_modules`)
    }
    let text
    try {
      text = await readText(manifestUrl)
    } catch {
      raise(TRANSPORT_UNAVAILABLE, `official Host package ${key} has no readable manifest`)
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      raise(TRANSPORT_UNAVAILABLE, `official Host package ${key} has an invalid manifest`)
    }
    if (!isRecord(manifest) || !isNonEmptyString(manifest.version)) {
      raise(TRANSPORT_UNAVAILABLE, `official Host package ${key} has no version`)
    }
    versions[key] = manifest.version
  }
  return versions
}

const DSH_CLIENT_KEYS = Object.freeze(['clientConnection', 'typertClient', 'gatewayClient'])

function parseVersion(version) {
  if (!isNonEmptyString(version)) return undefined
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function assertHostVersions(versions, expectedVersion) {
  // The three DSH client packages ship as one version line.
  const dshVersions = new Set(DSH_CLIENT_KEYS.map((key) => versions[key]))
  if (dshVersions.size !== 1) {
    raise(TRANSPORT_UNAVAILABLE, 'official Host client package versions are inconsistent')
  }
  if (expectedVersion !== undefined) {
    if (!isNonEmptyString(expectedVersion)) {
      raise(INVALID_REQUEST, 'expectedVersion must be a non-empty string when provided')
    }
    if (!dshVersions.has(expectedVersion)) {
      raise(TRANSPORT_UNAVAILABLE, 'official Host client packages do not match the expected runtime version')
    }
  }
  // Cordis is a separate version line: the Host declares a compatible peer
  // range, not the Host version, so it is checked against `~4.1.0`.
  const cordis = parseVersion(versions.cordis)
  if (cordis === undefined || cordis.major !== CORDIS_COMPATIBLE_MAJOR || cordis.minor !== CORDIS_COMPATIBLE_MINOR) {
    raise(TRANSPORT_UNAVAILABLE, 'official Host Cordis version is not compatible')
  }
}

function runtimeManifestPath(runtimeDir) {
  return join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'package.json')
}

/**
 * Candidate anchors for the Host runtime, in preference order: an explicit
 * anchor, an explicit runtime directory, the runtime env override, the Host
 * process entry (a public path for non-Electron Node hosts), then the packaged
 * Electron runtime. This list is fixed; nothing scans the filesystem.
 * @param {object} options - loadHostModules inputs.
 * @returns {string[]} candidate anchor paths.
 */
function hostAnchorCandidates(options) {
  const candidates = []
  if (isNonEmptyString(options.anchor)) candidates.push(options.anchor)
  if (isNonEmptyString(options.runtimeDir)) candidates.push(runtimeManifestPath(options.runtimeDir))
  const fromEnv = process.env[HOST_RUNTIME_ENV]
  if (isNonEmptyString(fromEnv)) candidates.push(runtimeManifestPath(fromEnv))
  const entry = isNonEmptyString(options.entry) ? options.entry : process.argv[1]
  if (isNonEmptyString(entry)) candidates.push(entry)
  if (isNonEmptyString(process.resourcesPath)) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
    candidates.push(join(process.resourcesPath, 'dsh', 'package.json'))
  }
  return candidates
}

async function createSpecifierResolver(options) {
  for (const candidate of hostAnchorCandidates(options)) {
    let require
    try {
      const anchorPath = candidate.startsWith('file:') ? fileURLToPath(candidate) : candidate
      require = createRequire(anchorPath)
      // The Gateway package is this runtime's marker; a candidate that cannot
      // resolve it is not the Host runtime being driven.
      require.resolve('@deepseek-ai/dsh-api-gateway/client')
    } catch {
      continue
    }
    return (specifier) => pathToFileURL(require.resolve(specifier)).href
  }
  return (specifier) => import.meta.resolve(specifier)
}

/**
 * Resolve the official Host client packages from the Host's own runtime, using
 * one explicit/public anchor (never a disk scan, never another runtime copy).
 * The three DSH client packages must share one version; Cordis is checked
 * separately against its compatible `~4.1.0` line.
 * @param {object} options - anchor/runtimeDir/entry/resolveSpecifier/importModule/readFile/expectedVersion.
 * @returns {Promise<object>} modules consumed by {@link createApprovalTransport}.
 */
export async function loadHostModules(options = {}) {
  if (!isRecord(options)) raise(INVALID_REQUEST, 'host module options must be an object')
  const importModule = typeof options.importModule === 'function' ? options.importModule : (url) => import(url)
  const readText = typeof options.readFile === 'function' ? options.readFile : (url) => readFile(new URL(url), 'utf8')
  const resolveSpecifier =
    typeof options.resolveSpecifier === 'function' ? options.resolveSpecifier : await createSpecifierResolver(options)

  const loaded = {}
  const urls = {}
  for (const [key, specifier] of Object.entries(HOST_MODULE_SPECIFIERS)) {
    let url
    try {
      url = resolveSpecifier(specifier)
    } catch {
      raise(TRANSPORT_UNAVAILABLE, `official Host package for ${key} is unavailable`)
    }
    if (!isNonEmptyString(url)) raise(TRANSPORT_UNAVAILABLE, `official Host package for ${key} is unavailable`)
    let namespace
    try {
      namespace = await importModule(url)
    } catch {
      raise(TRANSPORT_UNAVAILABLE, `official Host client module for ${key} could not load`)
    }
    loaded[key] = namespace
    urls[key] = url
  }

  const versions = await readHostVersions(urls, readText)
  assertHostVersions(versions, options.expectedVersion)

  const socketModule = loaded.websocket
  const WebSocket =
    typeof socketModule?.WebSocket === 'function'
      ? socketModule.WebSocket
      : typeof socketModule?.default === 'function'
        ? socketModule.default
        : typeof socketModule === 'function'
          ? socketModule
          : undefined

  const modules = {
    Context: loaded.cordis?.Context,
    installConnection: loaded.clientConnection?.installConnection,
    typertClient: loaded.typertClient,
    gatewayClient: loaded.gatewayClient,
    versions,
    ...(WebSocket === undefined ? {} : { WebSocket }),
  }
  if (
    typeof modules.Context !== 'function' ||
    typeof modules.installConnection !== 'function' ||
    modules.typertClient === undefined ||
    modules.gatewayClient === undefined ||
    modules.WebSocket === undefined
  ) {
    raise(TRANSPORT_UNAVAILABLE, 'official Host client modules are incomplete')
  }
  return modules
}

/**
 * Create the official Node Client transport factory for one Host.
 * @param {object} options - host, origin, modules/resolveModules, expectedVersion,
 *   fetch, createWebSocket, connectTimeoutMs and logger; see docs/permissions.md
 *   and docs/architecture.md.
 * @returns {(options: object) => Promise<{close: Function}>} transport factory.
 */
export function createApprovalTransport(options = {}) {
  if (!isRecord(options)) raise(INVALID_REQUEST, 'createApprovalTransport options must be an object')
  const host = options.host
  if (typeof host !== 'object' || host === null) raise(INVALID_REQUEST, 'host is required')
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  if (typeof fetchImpl !== 'function') raise(TRANSPORT_UNAVAILABLE, 'fetch is not available')
  const logger = normalizeLogger(options.logger)
  const connectTimeoutMs = normalizeTimeout(options.connectTimeoutMs)
  const createWebSocketOverride = options.createWebSocket
  if (createWebSocketOverride !== undefined && typeof createWebSocketOverride !== 'function') {
    raise(INVALID_REQUEST, 'createWebSocket must be a function')
  }
  const originOverride = options.origin
  if (originOverride !== undefined && typeof originOverride !== 'string') {
    raise(INVALID_REQUEST, 'origin must be a string')
  }
  const configuredModules = options.modules
  if (configuredModules !== undefined && !isRecord(configuredModules)) {
    raise(INVALID_REQUEST, 'modules must be an object')
  }
  const resolveModules = options.resolveModules
  if (resolveModules !== undefined && typeof resolveModules !== 'function') {
    raise(INVALID_REQUEST, 'resolveModules must be a function')
  }
  const expectedVersion = options.expectedVersion
  const cache = { modules: undefined }

  async function getModules() {
    if (configuredModules !== undefined) return configuredModules
    if (cache.modules !== undefined) return cache.modules
    let modules
    if (typeof resolveModules === 'function') {
      try {
        modules = await resolveModules()
      } catch (error) {
        throw sanitizeFailure(error, 'official Host client modules could not be resolved')
      }
    } else {
      try {
        modules = await loadHostModules(expectedVersion === undefined ? {} : { expectedVersion })
      } catch (error) {
        throw sanitizeFailure(error, 'official Host client modules could not be resolved')
      }
    }
    cache.modules = modules
    return modules
  }

  return async function transport(transportOptions = {}) {
    if (!isRecord(transportOptions)) raise(INVALID_REQUEST, 'transport options must be an object')
    const sessionId = transportOptions.sessionId
    if (!isNonEmptyString(sessionId)) raise(INVALID_REQUEST, 'sessionId must be a non-empty string')
    const onRequest = transportOptions.onRequest
    const onDisconnect = transportOptions.onDisconnect
    if (typeof onRequest !== 'function') raise(INVALID_REQUEST, 'onRequest must be a function')
    if (onDisconnect !== undefined && typeof onDisconnect !== 'function') {
      raise(INVALID_REQUEST, 'onDisconnect must be a function when provided')
    }

    const modules = await getModules()
    assertModules(modules, createWebSocketOverride)
    const origin = resolveOrigin(host, originOverride)
    const connectUrl = mintConnectUrl(host, origin)
    const cookie = await exchangeConnect(connectUrl, fetchImpl)

    const credentials = { cookie }
    const WebSocketImpl = createWebSocketOverride === undefined ? modules.WebSocket : undefined
    const createWebSocket =
      createWebSocketOverride ?? createCookieSocketFactory({ origin, credentials, WebSocketImpl })

    let root
    let offListener
    let disposeAdapter
    let watch
    let closed = false
    let closing

    const isClosed = () => closed

    async function teardown() {
      credentials.cookie = undefined
      try {
        watch?.cleanup()
      } catch {
        // Teardown must not throw.
      }
      try {
        offListener?.()
      } catch {
        // Teardown must not throw.
      }
      try {
        disposeAdapter?.()
      } catch {
        // Teardown must not throw.
      }
      if (root !== undefined) {
        try {
          if (typeof root.fiber?.dispose === 'function') await root.fiber.dispose()
        } catch {
          logger.warn('approval-transport: client tree teardown failed')
        }
      }
    }

    async function close() {
      if (closed) return closing
      closed = true
      closing = teardown()
      return closing
    }

    try {
      root = new modules.Context()
      modules.installConnection(root, {
        interactions: INTERACTIONS,
        transport: {
          fetch: createCookieFetch({ origin, credentials, fetchImpl }),
          createWebSocket,
          streamBaseUrl: origin,
        },
      })

      await root.plugin(modules.typertClient)
      const typert = readService(root, 'typert')
      if (typert === undefined || typeof typert.contexts?.registerClient !== 'function') {
        raise(TRANSPORT_UNAVAILABLE, 'official client Context registry is unavailable')
      }
      disposeAdapter = typert.contexts.registerClient('agent', {
        resolve: (agentId) => (agentId === sessionId ? root : undefined),
      })

      await root.plugin(modules.gatewayClient)
      const remote = readService(root, 'remote')
      if (remote === undefined || typeof remote.$on !== 'function') {
        raise(TRANSPORT_UNAVAILABLE, 'official client Remote service is unavailable')
      }
      offListener = remote.$on('approval/request', function approvalListener(request, next) {
        return answerApprovalRequest({
          request,
          receiver: this,
          root,
          next,
          isClosed,
          onRequest,
          sessionId,
          logger,
        })
      })

      const connection = readService(root, 'connection')
      watch = watchConnection(connection, connectTimeoutMs, onDisconnect, logger)
      await watch.ready
    } catch (error) {
      await close()
      throw sanitizeFailure(error, 'official client connection could not start')
    }

    return { close }
  }
}
