/**
 * dsh-i18n.mjs - language selection and the translation core for dsh-ask.
 *
 * This module is deliberately small and dependency-free: one resolver that
 * decides `zh` or `en` once per process, one catalog translator, and the fixed
 * `view.ui` labels the native display layer consumes. The catalogs are separate
 * data modules - `dsh-cli-messages.mjs` for the CLI and `dsh-tui-messages.mjs`
 * for the full-screen TUI - passed to `createTranslator` instead of being
 * merged here, so each surface can evolve without touching this file.
 *
 * Fixed contract (see `docs/architecture.md` §8.3 for the full write-up):
 *
 *   resolveLanguage({ lang, pluginLanguage, env, warn }) -> 'zh' | 'en'
 *   createTranslator(lang, catalog)                       -> t(key, params)
 *   nativeUiLabels(lang)                                  -> the seven `view.ui` fields
 *
 * Language priority, highest first:
 *
 *   1. explicit `lang` (the `--lang` option): only `zh` / `en`; anything else
 *      throws an Error whose `code` is `invalid-language` (the CLI turns that
 *      into a usage error and exit 2)
 *   2. `DSH_ASK_LANG`: same two values; an unsupported value warns once and is
 *      ignored, so a stray environment variable never breaks a whole session
 *   3. `pluginLanguage`: the Desktop plugin's language setting, read by the CLI
 *      from the Host health payload *after* it connects. Only `zh` / `en`
 *      count; `auto`, a Host that predates the field and any other value fall
 *      through silently - it is Host data, so it never warns and never throws
 *   4. `LC_ALL` > `LC_MESSAGES` > `LANG`: the first non-empty one decides,
 *      `zh*` -> zh, `en*` -> en (region and encoding are ignored)
 *   5. anything else - `C`, `POSIX`, `C.UTF-8`, an unknown language, or no
 *      locale at all - falls back to `DEFAULT_LANGUAGE`
 */

/** Languages this module can render. Order is also the documented preference. */
export const LANGUAGES = ['zh', 'en']

/** Fallback when neither the option, the environment nor the locale decides. */
export const DEFAULT_LANGUAGE = 'zh'

/** Environment variable that mirrors `--lang`. */
export const ENV_LANGUAGE = 'DSH_ASK_LANG'

/** POSIX locale variables, in precedence order (first non-empty wins). */
export const LOCALE_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG']

/** Error `code` for an unusable language value. */
export const INVALID_LANGUAGE_CODE = 'invalid-language'

/**
 * The `view.ui` fields, in the order `nativeUiLabels` returns them.
 * `backToBottom` is the only array; the rest are single lines.
 */
export const NATIVE_UI_FIELDS = [
  'placeholder',
  'emptyList',
  'searchPlaceholder',
  'hintFallback',
  'backToBottom',
  'modalTitleHelp',
  'modalTitleSessions',
]

const INVALID_LANGUAGE_MESSAGE = 'language must be zh or en'

function invalidLanguageError(value) {
  const shown = JSON.stringify(String(value))
  const error = new Error(`unsupported language ${shown}: ${INVALID_LANGUAGE_MESSAGE}`)
  error.code = INVALID_LANGUAGE_CODE
  return error
}

/**
 * The option and `DSH_ASK_LANG` accept exactly the two identifiers. Case is
 * folded (`ZH` = `zh`) and surrounding whitespace is ignored, but region and
 * encoding suffixes are *not* accepted here: `zh_CN` is a locale, not a
 * language choice. Use `classifyLocale` for the locale variables.
 */
function exactLanguage(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim().toLowerCase()
  return LANGUAGES.includes(text) ? text : null
}

/**
 * Classify a POSIX locale value: `zh_CN.UTF-8` -> zh, `en-US` -> en, `zh` -> zh.
 * `C`, `POSIX`, `C.UTF-8`, empty and unknown languages return `null` so the
 * caller can apply the default.
 */
function classifyLocale(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim().toLowerCase()
  if (text === '') return null
  const base = text.split(/[@.]/)[0].split(/[_-]/)[0]
  return LANGUAGES.includes(base) ? base : null
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * Resolve the language for this process.
 *
 * @param {object} [config]
 * @param {string} [config.lang] explicit language from `--lang`; `zh`/`en` only
 * @param {string} [config.pluginLanguage] the Desktop plugin's setting from the
 *   Host health payload (`health.cliPreferences.language`); `zh`/`en` only -
 *   `auto` and everything else means "no opinion" and is ignored silently
 * @param {Record<string, string|undefined>} [config.env] defaults to `process.env`
 * @param {(message: string) => void} [config.warn] receives at most one message
 * @returns {'zh'|'en'}
 * @throws {Error & { code: 'invalid-language' }} for an unsupported explicit `lang`
 */
export function resolveLanguage({ lang, pluginLanguage, env = process.env, warn = () => {} } = {}) {
  if (typeof warn !== 'function') throw new TypeError('warn must be a function')
  const environment = env !== null && typeof env === 'object' ? env : {}

  // 1. The explicit option is authoritative and never silently falls back: a
  //    typo must be reported, not turned into a different language. A present
  //    but empty value is a typo too, so it throws instead of counting as unset.
  if (lang !== undefined && lang !== null) {
    const chosen = exactLanguage(lang)
    if (chosen === null) throw invalidLanguageError(lang)
    return chosen
  }

  // 2. The environment variable is a convenience override. It is allowed to be
  //    wrong (inherited from a shell), so warn and keep looking.
  if (!isBlank(environment[ENV_LANGUAGE])) {
    const fromEnv = exactLanguage(environment[ENV_LANGUAGE])
    if (fromEnv !== null) return fromEnv
    warn(`ignoring ${ENV_LANGUAGE}=${JSON.stringify(String(environment[ENV_LANGUAGE]))}: ${INVALID_LANGUAGE_MESSAGE}`)
  }

  // 3. The Desktop plugin's own language setting, which the CLI only learns by
  //    connecting to the Host. It ranks below the two explicit sources and above
  //    the locale. `auto`, a missing field (older Host) and any unusable value
  //    mean "no opinion": Host data must not warn or throw at the user, so the
  //    locale below decides instead.
  const fromPlugin = exactLanguage(pluginLanguage)
  if (fromPlugin !== null) return fromPlugin

  // 4. Locale variables, POSIX precedence. The first non-empty one decides,
  //    even when its language is unknown: it is the *user's* locale, and an
  //    unknown language belongs to the fallback branch rather than to a lower
  //    precedence variable.
  for (const name of LOCALE_VARIABLES) {
    const value = environment[name]
    if (isBlank(value)) continue
    return classifyLocale(value) ?? DEFAULT_LANGUAGE
  }

  // 5. Nothing to go on.
  return DEFAULT_LANGUAGE
}

/** `{name}` placeholders; the name must start with a letter or underscore. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Build a translator over a flat catalog.
 *
 * The catalog is `{ key: { zh: '…', en: '…' } }`. Translation validates nothing
 * up front (catalogs are written by hand), so both failure modes stay visible
 * in the UI instead of disappearing:
 *
 *   - a missing key, or a key without the requested language, renders
 *     `⟦key⟧` - never an empty string;
 *   - a placeholder with no matching parameter stays as `{name}`, while the
 *     parameters that do exist are still substituted.
 *
 * Substitution is a single pass: parameter values are inserted verbatim and are
 * never re-scanned for placeholders, so user data (`{other}`, `$&`, …) is
 * carried through unchanged. The template and the `params` object are not
 * mutated.
 *
 * @param {'zh'|'en'} lang
 * @param {Record<string, { zh?: string, en?: string }>} catalog
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 * @throws {Error & { code: 'invalid-language' }} for a language this module cannot render
 */
export function createTranslator(lang, catalog) {
  const chosen = exactLanguage(lang)
  if (chosen === null) throw invalidLanguageError(lang)
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('catalog must be an object of { key: { zh, en } } entries')
  }

  return function translate(key, params = {}) {
    const name = String(key)
    const entry = Object.prototype.hasOwnProperty.call(catalog, name) ? catalog[name] : undefined
    const template = entry !== null && typeof entry === 'object' ? entry[chosen] : undefined
    if (typeof template !== 'string') return `⟦${name}⟧`
    return template.replace(PLACEHOLDER, (whole, placeholder) => {
      if (params === null || typeof params !== 'object') return whole
      if (!Object.prototype.hasOwnProperty.call(params, placeholder)) return whole
      const value = params[placeholder]
      if (value === undefined || value === null) return whole
      return String(value)
    })
  }
}

/**
 * The native display layer's language-dependent literals.
 *
 * The `en` values are what the JS layer sends for English; for `placeholder`,
 * `emptyList`, `searchPlaceholder`, `hintFallback` and `backToBottom` they equal
 * the strings the native layer hard-coded before the `ui` field existed. The
 * two `modalTitle*` defaults are the exception: native historically defaulted
 * those titles to Chinese, so `en` here is the English wording while `zh` keeps
 * the original text. The native built-in fallbacks live in
 * `native/src/protocol.rs` and are unchanged. `backToBottom` is ordered widest
 * first (the last entry is the bare arrow that always fits).
 *
 * The catalog is private on purpose: `nativeUiLabels` is the only supported
 * entry point, which keeps the field list in sync with `docs/architecture.md`
 * §8.3.
 */
const NATIVE_UI_CATALOG = {
  placeholder: {
    zh: '向 dsh-ask 提问或下达指令',
    en: 'Ask dsh-ask to do anything',
  },
  emptyList: {
    zh: '没有匹配项',
    en: 'no matches',
  },
  searchPlaceholder: {
    zh: '输入以搜索',
    en: 'Type to search',
  },
  hintFallback: {
    zh: '? 查看快捷键',
    en: '? for shortcuts',
  },
  modalTitleHelp: {
    zh: '帮助 · 按键与命令',
    en: 'Help · Keys and commands',
  },
  modalTitleSessions: {
    zh: '选择会话',
    en: 'Select a session',
  },
  'backToBottom.0': {
    zh: '↓ 回到底部 · esc',
    en: '↓ Back to bottom · esc',
  },
  'backToBottom.1': {
    zh: '↓ 到底部 · esc',
    en: '↓ Bottom · esc',
  },
  'backToBottom.2': {
    zh: '↓ 到底部',
    en: '↓ Bottom',
  },
  'backToBottom.3': {
    zh: '↓',
    en: '↓',
  },
}

/**
 * The `view.ui` payload for one language (`nativeUiLabels('zh')` / `'en'`).
 *
 * @param {'zh'|'en'} lang
 * @returns {{ placeholder: string, emptyList: string, searchPlaceholder: string,
 *   hintFallback: string, backToBottom: string[], modalTitleHelp: string,
 *   modalTitleSessions: string }}
 * @throws {Error & { code: 'invalid-language' }} for a language this module cannot render
 */
export function nativeUiLabels(lang) {
  const t = createTranslator(lang, NATIVE_UI_CATALOG)
  return {
    placeholder: t('placeholder'),
    emptyList: t('emptyList'),
    searchPlaceholder: t('searchPlaceholder'),
    hintFallback: t('hintFallback'),
    backToBottom: [t('backToBottom.0'), t('backToBottom.1'), t('backToBottom.2'), t('backToBottom.3')],
    modalTitleHelp: t('modalTitleHelp'),
    modalTitleSessions: t('modalTitleSessions'),
  }
}
