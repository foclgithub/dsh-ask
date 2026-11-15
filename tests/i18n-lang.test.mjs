/**
 * Tests for the language core (`dsh-i18n.mjs`).
 *
 * Only the public contract is exercised: the resolver's precedence and failure
 * modes, the translator's interpolation/failure behaviour, and the seven
 * `view.ui` fields the native layer consumes. Every test passes its own `env`
 * object, so the host machine's locale can never leak into the result.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_LANGUAGE,
  ENV_LANGUAGE,
  INVALID_LANGUAGE_CODE,
  LANGUAGES,
  LOCALE_VARIABLES,
  NATIVE_UI_FIELDS,
  createTranslator,
  nativeUiLabels,
  resolveLanguage,
} from '../dsh-i18n.mjs'

/** Run the resolver with a private env and no warn output. */
function resolveWith(config) {
  return resolveLanguage({ env: {}, ...config })
}

function assertInvalidLanguage(run) {
  assert.throws(run, (error) => {
    assert.equal(error.code, INVALID_LANGUAGE_CODE)
    assert.ok(!(error instanceof TypeError), 'the language error keeps its own code')
    return true
  })
}

// ---------------------------------------------------------------- precedence

test('the explicit language wins over the environment and the locale', () => {
  const env = { [ENV_LANGUAGE]: 'zh', LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }
  assert.equal(resolveLanguage({ lang: 'en', env }), 'en')
  assert.equal(
    resolveLanguage({ lang: 'zh', env: { [ENV_LANGUAGE]: 'en', LC_ALL: 'en_US.UTF-8' } }),
    'zh',
  )
})

test('the explicit language is trimmed and case-folded, but not region-suffixed', () => {
  assert.equal(resolveWith({ lang: ' EN ' }), 'en')
  assert.equal(resolveWith({ lang: 'Zh' }), 'zh')
  for (const bad of ['', 'zh_CN', 'zh-CN', 'en_US', 'en-GB', 'ja', 'fr', 'C', 'english', 7, {}]) {
    assertInvalidLanguage(() => resolveWith({ lang: bad }))
  }
})

test('an invalid explicit language carries the stable error code', () => {
  assertInvalidLanguage(() => resolveWith({ lang: 'ja' }))
  assertInvalidLanguage(() => resolveWith({ lang: '' }))
  assertInvalidLanguage(() => resolveLanguage({ lang: 'fr', env: { LANG: 'en_US.UTF-8' } }))
})

test('DSH_ASK_LANG is consulted before the locale variables', () => {
  assert.equal(resolveWith({ env: { [ENV_LANGUAGE]: 'zh', LC_ALL: 'en_US.UTF-8' } }), 'zh')
  assert.equal(resolveWith({ env: { [ENV_LANGUAGE]: 'en', LANG: 'zh_CN.UTF-8' } }), 'en')
  assert.equal(resolveWith({ env: { [ENV_LANGUAGE]: 'en' } }), 'en')
})

test('an invalid DSH_ASK_LANG warns once and is ignored', () => {
  const warnings = []
  const language = resolveLanguage({
    env: { [ENV_LANGUAGE]: 'ja', LANG: 'en_US.UTF-8' },
    warn: (message) => warnings.push(message),
  })
  assert.equal(language, 'en')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /DSH_ASK_LANG/)
  assert.match(warnings[0], /ja/)
  assert.match(warnings[0], /zh or en/)
})

test('an ignored DSH_ASK_LANG still falls back to the default', () => {
  const warnings = []
  assert.equal(
    resolveLanguage({ env: { [ENV_LANGUAGE]: 'de_DE.UTF-8' }, warn: (m) => warnings.push(m) }),
    DEFAULT_LANGUAGE,
  )
  assert.equal(warnings.length, 1)
})

test('an empty DSH_ASK_LANG is unset, not an error', () => {
  let warned = false
  const language = resolveLanguage({
    env: { [ENV_LANGUAGE]: '', LANG: 'en_US.UTF-8' },
    warn: () => {
      warned = true
    },
  })
  assert.equal(language, 'en')
  assert.equal(warned, false)
})

test('locale precedence is LC_ALL > LC_MESSAGES > LANG', () => {
  assert.equal(resolveWith({ env: { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN', LANG: 'zh_CN' } }), 'en')
  assert.equal(resolveWith({ env: { LC_ALL: '', LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_CN' } }), 'en')
  assert.equal(resolveWith({ env: { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } }), 'zh')
  assert.equal(resolveWith({ env: { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' } }), 'zh')
  assert.equal(resolveWith({ env: { LANG: 'en_US.UTF-8' } }), 'en')
  assert.deepEqual(LOCALE_VARIABLES, ['LC_ALL', 'LC_MESSAGES', 'LANG'])
})

test('zh* and en* locale values are recognised with region and encoding', () => {
  for (const value of ['zh_CN.UTF-8', 'zh-Hans', 'zh_TW', 'zh', 'ZH_CN.utf8']) {
    assert.equal(resolveWith({ env: { LANG: value } }), 'zh', value)
  }
  for (const value of ['en_US.UTF-8', 'en-GB', 'en', 'EN_us']) {
    assert.equal(resolveWith({ env: { LANG: value } }), 'en', value)
  }
})

test('C, POSIX, unknown languages and an empty env fall back to zh', () => {
  for (const value of ['C', 'POSIX', 'C.UTF-8', 'ja_JP.UTF-8', 'de_DE', 'fr_FR.UTF-8', 'xx_YY.UTF-8']) {
    assert.equal(resolveWith({ env: { LC_ALL: value } }), 'zh', value)
  }
  assert.equal(resolveWith({}), 'zh')
  assert.equal(resolveWith({ env: { LANG: '' } }), 'zh')
  assert.equal(resolveWith({ env: { LANG: '   ' } }), 'zh')
  assert.equal(DEFAULT_LANGUAGE, 'zh')
})

test('an unknown first locale variable decides instead of falling through', () => {
  // LC_ALL is set, so it is the user's locale even though the language is not
  // one we render; falling through to LANG would contradict POSIX precedence.
  assert.equal(resolveWith({ env: { LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' } }), 'zh')
})

test('missing or unusable configuration never throws', () => {
  assert.equal(resolveLanguage({ env: null }), DEFAULT_LANGUAGE)
  assert.equal(resolveLanguage({ env: {} }), DEFAULT_LANGUAGE)
  assert.equal(resolveLanguage({ env: { LANG: '' } }), DEFAULT_LANGUAGE)
  assert.equal(resolveWith({ env: { [ENV_LANGUAGE]: 'nope' } }), 'zh')
})

test('the exported language list is zh and en', () => {
  assert.deepEqual(LANGUAGES, ['zh', 'en'])
})

// ---------------------------------------------------- desktop plugin language

test('the desktop plugin language ranks below the explicit sources and above the locale', () => {
  // The Desktop setting only exists once the CLI has connected, so it beats the
  // machine locale in both directions.
  assert.equal(resolveWith({ pluginLanguage: 'en', env: { LANG: 'zh_CN.UTF-8' } }), 'en')
  assert.equal(resolveWith({ pluginLanguage: 'zh', env: { LC_ALL: 'en_US.UTF-8' } }), 'zh')
  // Both explicit sources still win, including the environment one.
  assert.equal(resolveLanguage({ lang: 'en', pluginLanguage: 'zh', env: {} }), 'en')
  assert.equal(resolveLanguage({ lang: 'zh', pluginLanguage: 'en', env: {} }), 'zh')
  assert.equal(
    resolveLanguage({ pluginLanguage: 'zh', env: { [ENV_LANGUAGE]: 'en', LANG: 'zh_CN.UTF-8' } }),
    'en',
  )
})

test('an unusable DSH_ASK_LANG does not outrank the plugin language', () => {
  const warnings = []
  const language = resolveLanguage({
    pluginLanguage: 'zh',
    env: { [ENV_LANGUAGE]: 'ja', LANG: 'en_US.UTF-8' },
    warn: (message) => warnings.push(message),
  })
  assert.equal(language, 'zh')
  assert.equal(warnings.length, 1)
})

test('auto, a missing field and unusable Host values fall back to the locale', () => {
  // `auto` is the documented "follow the app" value; a Host that predates the
  // field sends nothing; a broken value must never leak into the UI.
  const unusable = [undefined, null, 'auto', 'AUTO', '', '   ', 'ja', 'zh_CN', 'en_US', 'english', 7, {}, []]
  for (const pluginLanguage of unusable) {
    const shown = JSON.stringify(pluginLanguage)
    assert.equal(resolveWith({ pluginLanguage, env: { LANG: 'en_US.UTF-8' } }), 'en', shown)
    assert.equal(resolveWith({ pluginLanguage, env: { LANG: 'zh_CN.UTF-8' } }), 'zh', shown)
  }
  assert.equal(resolveLanguage({ pluginLanguage: 'auto', env: null }), DEFAULT_LANGUAGE)
})

test('without a usable locale the plugin fallback still ends at the default', () => {
  for (const pluginLanguage of [undefined, 'auto', 'ja', null]) {
    assert.equal(resolveWith({ pluginLanguage }), DEFAULT_LANGUAGE, JSON.stringify(pluginLanguage))
  }
})

test('the plugin language is trimmed and case-folded, and never warns', () => {
  assert.equal(resolveWith({ pluginLanguage: ' EN ' }), 'en')
  assert.equal(resolveWith({ pluginLanguage: 'Zh' }), 'zh')
  const warnings = []
  const language = resolveLanguage({
    pluginLanguage: 'ja',
    env: { LANG: 'en_US.UTF-8' },
    warn: (message) => warnings.push(message),
  })
  assert.equal(language, 'en')
  assert.deepEqual(warnings, [], 'Host data is not a user typo; it must not warn')
})

// ---------------------------------------------------------------- translator

const GREETING = {
  greet: { zh: '你好，{name}！', en: 'Hello, {name}!' },
  plain: { zh: '只有这一句', en: 'Only this line' },
}

test('the translator renders both languages', () => {
  const zh = createTranslator('zh', GREETING)
  const en = createTranslator('en', GREETING)
  assert.equal(zh('greet', { name: '世界' }), '你好，世界！')
  assert.equal(en('greet', { name: 'World' }), 'Hello, World!')
  assert.equal(zh('plain'), '只有这一句')
  assert.equal(en('plain'), 'Only this line')
})

test('interpolation replaces every occurrence and keeps data verbatim', () => {
  const t = createTranslator('zh', {
    pair: { zh: '{a}-{a}', en: '{a}-{a}' },
    slot: { zh: '[{value}]', en: '[{value}]' },
  })
  assert.equal(t('pair', { a: 'x' }), 'x-x')
  // A value that looks like a placeholder must not be expanded again.
  assert.equal(t('slot', { value: '{a}' }), '[{a}]')
  // Replacement text is literal: `$&`, `$1` and backslashes stay put.
  assert.equal(t('slot', { value: '$& $1 \\0' }), '[$& $1 \\0]')
  assert.equal(t('slot', { value: 0 }), '[0]')
  assert.equal(t('slot', { value: false }), '[false]')
})

test('interpolation does not mutate the catalog or the params', () => {
  const catalog = { greet: { zh: '你好，{name}！', en: 'Hello, {name}!' } }
  const params = { name: '世界' }
  const t = createTranslator('zh', catalog)
  assert.equal(t('greet', params), '你好，世界！')
  assert.deepEqual(params, { name: '世界' })
  assert.equal(catalog.greet.zh, '你好，{name}！')
})

test('a placeholder without a parameter stays visible', () => {
  const t = createTranslator('zh', GREETING)
  assert.equal(t('greet'), '你好，{name}！')
  assert.equal(t('greet', {}), '你好，{name}！')
  assert.equal(t('greet', { name: null }), '你好，{name}！')
  assert.equal(t('greet', { name: undefined }), '你好，{name}！')
  // Extra parameters are ignored, and known ones are still substituted.
  assert.equal(t('greet', { name: '世界', extra: 'x' }), '你好，世界！')
  assert.equal(t('greet', '{name}'), '你好，{name}！')
})

test('a missing key stays diagnosable instead of rendering nothing', () => {
  const t = createTranslator('zh', GREETING)
  const rendered = t('no-such-key')
  assert.equal(typeof rendered, 'string')
  assert.ok(rendered.length > 0)
  assert.match(rendered, /no-such-key/)
  assert.notEqual(rendered, '')
  assert.notEqual(rendered, 'undefined')
})

test('a key without the requested language stays diagnosable', () => {
  const t = createTranslator('en', { onlyZh: { zh: '仅中文' } })
  const rendered = t('onlyZh')
  assert.match(rendered, /onlyZh/)
  assert.ok(!rendered.includes('仅中文'))
})

test('the translator rejects an unsupported language and a broken catalog', () => {
  assertInvalidLanguage(() => createTranslator('ja', GREETING))
  assertInvalidLanguage(() => createTranslator('zh_CN', GREETING))
  assert.throws(() => createTranslator('zh', null), TypeError)
  assert.throws(() => createTranslator('zh', []), TypeError)
  assert.throws(() => createTranslator('zh', 'nope'), TypeError)
})

// ------------------------------------------------------------ native ui labels

test('nativeUiLabels returns exactly the seven contract fields for both languages', () => {
  for (const lang of LANGUAGES) {
    const labels = nativeUiLabels(lang)
    assert.deepEqual(Object.keys(labels), NATIVE_UI_FIELDS, lang)
    assert.deepEqual(NATIVE_UI_FIELDS, [
      'placeholder',
      'emptyList',
      'searchPlaceholder',
      'hintFallback',
      'backToBottom',
      'modalTitleHelp',
      'modalTitleSessions',
    ])
    for (const field of NATIVE_UI_FIELDS) {
      if (field === 'backToBottom') continue
      assert.equal(typeof labels[field], 'string', `${lang}.${field}`)
      assert.ok(labels[field].length > 0, `${lang}.${field} is not empty`)
    }
    assert.ok(Array.isArray(labels.backToBottom))
    assert.equal(labels.backToBottom.length, 4)
    for (const variant of labels.backToBottom) {
      assert.equal(typeof variant, 'string')
      assert.ok(variant.length > 0)
    }
  }
})

test('the English labels are the strings the native layer hard-codes today', () => {
  const en = nativeUiLabels('en')
  assert.equal(en.placeholder, 'Ask dsh-ask to do anything')
  assert.equal(en.emptyList, 'no matches')
  assert.equal(en.searchPlaceholder, 'Type to search')
  assert.equal(en.hintFallback, '? for shortcuts')
  assert.equal(en.modalTitleHelp, 'Help · Keys and commands')
  assert.equal(en.modalTitleSessions, 'Select a session')
  assert.deepEqual(en.backToBottom, [
    '↓ Back to bottom · esc',
    '↓ Bottom · esc',
    '↓ Bottom',
    '↓',
  ])
})

test('the Chinese labels match the wording this CLI already uses', () => {
  const zh = nativeUiLabels('zh')
  assert.equal(zh.placeholder, '向 dsh-ask 提问或下达指令')
  assert.equal(zh.emptyList, '没有匹配项')
  assert.equal(zh.searchPlaceholder, '输入以搜索')
  assert.equal(zh.hintFallback, '? 查看快捷键')
  assert.equal(zh.modalTitleHelp, '帮助 · 按键与命令')
  assert.equal(zh.modalTitleSessions, '选择会话')
  assert.deepEqual(zh.backToBottom, [
    '↓ 回到底部 · esc',
    '↓ 到底部 · esc',
    '↓ 到底部',
    '↓',
  ])
})

test('backToBottom is ordered widest first and always ends with the bare arrow', () => {
  for (const lang of LANGUAGES) {
    const { backToBottom } = nativeUiLabels(lang)
    assert.equal(backToBottom.at(-1), '↓', lang)
    let previous = Number.POSITIVE_INFINITY
    for (const variant of backToBottom) {
      assert.ok(variant.length <= previous, `${lang}: ${variant} is wider than the one before`)
      previous = variant.length
    }
  }
})

test('the two languages define the same native fields', () => {
  assert.deepEqual(Object.keys(nativeUiLabels('zh')), Object.keys(nativeUiLabels('en')))
})

test('nativeUiLabels rejects an unsupported language', () => {
  assertInvalidLanguage(() => nativeUiLabels('ja'))
  assertInvalidLanguage(() => nativeUiLabels(undefined))
})
