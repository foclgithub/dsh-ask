/**
 * tests/i18n-install.test.mjs - installation closure for the i18n module set.
 *
 * `scripts/install.sh` installs seven flat JavaScript runtime modules (the CLI,
 * its media/display helpers, the translator core and the CLI/TUI message
 * catalogs) plus the native `dsh-ask-ui` binary and a launcher. This suite pins:
 *
 *   * the seven-module set is validated, backed up and copied as one unit, and
 *     the installed files are byte-identical to the checkout;
 *   * the relative-import closure honours *static catalog imports* as well as
 *     dynamic `import()`, so a catalog module can neither be left out of the
 *     copy list nor be installed without a check;
 *   * every path is backed up as `<name>.bak.<UTC stamp>`; nothing is ever
 *     deleted, including on a failed install;
 *   * validation failures abort before the install root is written at all.
 *
 * Every install runs into a fresh `mkdtemp` root under `tmpdir()` and with a
 * stub `DSH_UI_BINARY`, so nothing under `$HOME/.local` is touched. The suite
 * never deletes files (missing-module cases are built by copying a subset, not
 * by deleting from a full copy), which also exercises the installer's own
 * "nothing is deleted" policy.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL_SH = join(REPO, 'scripts', 'install.sh')

/** The installed runtime modules, in the dependency order install.sh stages. */
const MODULE_SET = [
  'dsh-i18n.mjs',
  'dsh-cli-messages.mjs',
  'dsh-tui-messages.mjs',
  'dsh-media.mjs',
  'dsh-native-screen.mjs',
  'dsh-tui.mjs',
  'dsh-ask.mjs',
]
const ENTRY = 'dsh-ask.mjs'
const UI_NAME = 'dsh-ask-ui'
const UI_STUB_VERSION = 'dsh-ask-ui 0.9.9-install-test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readInstallScript() {
  return readFileSync(INSTALL_SH, 'utf8')
}

function moduleSetFromScript() {
  const match = readInstallScript().match(/^MODULES="([^"]*)"$/m)
  assert.ok(match, 'scripts/install.sh 必须有单行 MODULES="..." 定义')
  return match[1].split(' ')
}

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `dsh-ask-install-${label}-`))
}

/** A stand-in native display binary: the installer only runs `--version`. */
function writeUiStub(dir) {
  const path = join(dir, UI_NAME)
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      `  --version) printf '%s\\n' '${UI_STUB_VERSION}'; exit 0 ;;`,
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return path
}

function runInstall({ root, uiBinary, script = INSTALL_SH }) {
  return spawnSync('/bin/sh', [script], {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DSH_CLI_INSTALL_ROOT: root,
      DSH_UI_BINARY: uiBinary,
    },
  })
}

/**
 * Copy the checkout sources (and install.sh) into an isolated temp tree.
 * `exclude` builds the "incomplete set" fixtures by omission: this suite never
 * deletes a file it copied.
 */
function copySourceTree(label, { exclude = [] } = {}) {
  const dir = tempDir(label)
  for (const name of MODULE_SET) {
    if (exclude.includes(name)) continue
    copyFileSync(join(REPO, name), join(dir, name))
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const script = join(dir, 'scripts', 'install.sh')
  copyFileSync(INSTALL_SH, script)
  chmodSync(script, 0o755)
  return { dir, script }
}

/** Replace the MODULES line of the temp install.sh copy (never the checkout). */
function patchModuleSet(script, modules) {
  const patched = readFileSync(script, 'utf8').replace(
    /^MODULES="[^"]*"$/m,
    `MODULES="${modules.join(' ')}"`,
  )
  writeFileSync(script, patched)
  chmodSync(script, 0o755)
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertNoInstallRoot(root) {
  assert.equal(existsSync(join(root, 'lib')), false, `失败的安装不得写出 ${root}/lib`)
  assert.equal(existsSync(join(root, 'bin')), false, `失败的安装不得写出 ${root}/bin`)
}

function backupsOf(dir, base) {
  return readdirSync(dir).filter((name) => name.startsWith(`${base}.bak.`))
}

function sortedNames(dir) {
  return readdirSync(dir).sort()
}

// ---------------------------------------------------------------------------
// 1) Script surface: seven-module set, dependency order, no stale wording
// ---------------------------------------------------------------------------

test('install.sh validates the seven-module set and advertises it', () => {
  const syntax = spawnSync('/bin/sh', ['-n', INSTALL_SH], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `install.sh 语法错误: ${syntax.stderr}`)

  assert.deepEqual(moduleSetFromScript(), MODULE_SET, 'MODULES 必须正好是七个模块、依赖优先顺序')
  assert.equal(MODULE_SET.length, 7)
  assert.equal(MODULE_SET[MODULE_SET.length - 1], ENTRY, '入口模块最后复制')
  for (const name of MODULE_SET) {
    assert.ok(existsSync(join(REPO, name)), `仓库缺少运行时模块 ${name}`)
  }
  assert.match(readInstallScript(), /^ENTRY=dsh-ask\.mjs$/m, '入口必须单独声明为 ENTRY')

  // Staging and backup must iterate the same single list instead of a second
  // hard-coded list: that is what makes "validated but not copied" impossible.
  const script = readInstallScript()
  assert.match(script, /for name in \$MODULES; do/)
  assert.match(script, /stage_file "\$SRC_DIR\/\$name" "\$LIB_DIR\/\$name" 0644/)
  assert.doesNotMatch(script, /stage_file "\$SRC_DIR\/dsh-ask\.mjs"/, '不得再硬编码单个模块的复制')
  assert.doesNotMatch(script, /four modules|four installed|six paths/, '旧的四模块/六路径文案必须清干净')

  const help = spawnSync('/bin/sh', [INSTALL_SH, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  for (const name of MODULE_SET) {
    assert.match(help.stdout, new RegExp(escapeRegExp(name)), `--help 必须列出 ${name}`)
  }
  assert.match(help.stdout, /seven modules/)
  assert.match(help.stdout, /dsh-tui-screen\.mjs/, '旧 screen 模块必须仍明确声明不安装')
})

// ---------------------------------------------------------------------------
// 2) Isolated install: all seven modules + native + launcher, byte-identical
// ---------------------------------------------------------------------------

test('isolated install copies all seven modules, the native binary and the launcher', () => {
  const root = tempDir('happy')
  const uiBinary = writeUiStub(tempDir('stub-happy'))

  const result = runInstall({ root, uiBinary })
  assert.equal(result.status, 0, combinedOutput(result))
  assert.ok(root.startsWith(tmpdir()), '安装根目录必须位于临时目录，绝不写真实 ~/.local')

  const lib = join(root, 'lib', 'dsh-ask')
  const expectedLibNames = [...MODULE_SET, UI_NAME].sort()
  assert.deepEqual(sortedNames(lib), expectedLibNames, 'lib 目录只能有七个模块 + native 二进制')
  assert.equal(existsSync(join(lib, 'dsh-tui-screen.mjs')), false, '旧 screen 模块不得安装')

  for (const name of MODULE_SET) {
    const installed = readFileSync(join(lib, name))
    assert.deepEqual(installed, readFileSync(join(REPO, name)), `${name} 必须逐字节一致`)
    assert.equal(statSync(join(lib, name)).mode & 0o777, 0o644, `${name} 必须是 0644`)
    assert.match(result.stdout, new RegExp(escapeRegExp(name)), `安装输出必须列出 ${name}`)
  }
  assert.deepEqual(readFileSync(join(lib, UI_NAME)), readFileSync(uiBinary), 'native 二进制必须逐字节一致')
  assert.equal(statSync(join(lib, UI_NAME)).mode & 0o777, 0o755)

  const launcher = join(root, 'bin', 'dsh-ask')
  assert.ok(existsSync(launcher))
  assert.equal(statSync(launcher).mode & 0o777, 0o755)
  assert.deepEqual(
    readdirSync(join(root, 'bin')).filter((name) => name.includes('.tmp.')),
    [],
    '安装成功后不得留下 .tmp. 暂存文件',
  )
  assert.deepEqual(
    readdirSync(lib).filter((name) => name.includes('.tmp.')),
    [],
    '安装成功后不得留下 .tmp. 暂存文件',
  )

  // The launcher resolves ../lib/dsh-ask from its own path, so it must work from
  // a foreign working directory; --help imports the whole module set.
  const help = spawnSync(launcher, ['--help'], { cwd: tmpdir(), encoding: 'utf8', timeout: 120_000 })
  assert.equal(help.status, 0, combinedOutput(help))
  // The launcher follows the run language; the smoke check must not pin one.
  assert.match(help.stdout, /(?:usage|用法)[:：] ?dsh-ask/)
})

// ---------------------------------------------------------------------------
// 3) Backup: timestamped, complete, and nothing is deleted (also on reinstall)
// ---------------------------------------------------------------------------

test('reinstall backs up every path and never deletes old files', () => {
  const root = tempDir('backup')
  const uiBinary = writeUiStub(tempDir('stub-backup'))
  const lib = join(root, 'lib', 'dsh-ask')
  const bin = join(root, 'bin')
  mkdirSync(lib, { recursive: true })
  mkdirSync(bin, { recursive: true })

  const oldContents = new Map()
  for (const name of MODULE_SET) {
    const content = `OLD ${name}\n`
    writeFileSync(join(lib, name), content)
    oldContents.set(name, content)
  }
  writeFileSync(join(lib, UI_NAME), 'OLD native binary\n')
  chmodSync(join(lib, UI_NAME), 0o755)
  oldContents.set(UI_NAME, 'OLD native binary\n')
  writeFileSync(join(bin, 'dsh-ask'), 'OLD launcher\n')
  oldContents.set('dsh-ask', 'OLD launcher\n')
  // Unrelated files must survive untouched.
  writeFileSync(join(lib, 'keep-me.txt'), 'do not touch\n')
  writeFileSync(join(bin, 'keep-me-too.txt'), 'do not touch\n')

  const first = runInstall({ root, uiBinary })
  assert.equal(first.status, 0, combinedOutput(first))

  // One backup for every replaced path (seven modules, native, launcher).
  for (const name of MODULE_SET) {
    const backups = backupsOf(lib, name)
    assert.equal(backups.length, 1, `${name} 必须有一个 .bak.<stamp> 备份: ${backups}`)
    assert.equal(readFileSync(join(lib, backups[0]), 'utf8'), oldContents.get(name), `${name} 备份内容必须是旧文件`)
    assert.deepEqual(readFileSync(join(lib, name)), readFileSync(join(REPO, name)), `${name} 已被新文件替换`)
  }
  const uiBackups = backupsOf(lib, UI_NAME)
  assert.equal(uiBackups.length, 1, 'native 二进制必须备份')
  assert.equal(readFileSync(join(lib, uiBackups[0]), 'utf8'), 'OLD native binary\n')
  const launcherBackups = backupsOf(bin, 'dsh-ask')
  assert.equal(launcherBackups.length, 1, 'launcher 必须备份')
  assert.equal(readFileSync(join(bin, launcherBackups[0]), 'utf8'), 'OLD launcher\n')

  assert.equal(readFileSync(join(lib, 'keep-me.txt'), 'utf8'), 'do not touch\n', '无关文件不得被删除或改写')
  assert.equal(readFileSync(join(bin, 'keep-me-too.txt'), 'utf8'), 'do not touch\n')

  const firstBackups = sortedNames(lib).filter((name) => name.includes('.bak.'))
  assert.equal(firstBackups.length, 8, 'lib 下应有七个模块 + native 共八个备份')

  // A second install in the same second must not clobber the first backups;
  // the timestamp collision gets a numeric suffix and older files stay.
  const second = runInstall({ root, uiBinary })
  assert.equal(second.status, 0, combinedOutput(second))
  const secondBackups = sortedNames(lib).filter((name) => name.includes('.bak.'))
  assert.equal(secondBackups.length, 16, '第二次安装必须再备份一份（同秒时用 -N 后缀）')
  for (const name of firstBackups) {
    assert.ok(secondBackups.includes(name), `${name} 的旧备份不得被删除或覆盖`)
    assert.equal(readFileSync(join(lib, name), 'utf8'), oldContents.get(name.replace(/\.bak\..*$/, '')), `${name} 内容必须保持旧文件`)
  }
  assert.equal(backupsOf(bin, 'dsh-ask').length, 2, '第二次安装也必须备份 launcher')
  assert.equal(readFileSync(join(lib, 'keep-me.txt'), 'utf8'), 'do not touch\n', '第二次安装也不得删除无关文件')
})

// ---------------------------------------------------------------------------
// 4) Missing modules and missing catalogs abort before any write
// ---------------------------------------------------------------------------

test('a missing module aborts before the install root is written', () => {
  for (const missing of ['dsh-i18n.mjs', 'dsh-cli-messages.mjs', 'dsh-tui-messages.mjs']) {
    const { script } = copySourceTree(`missing-${missing.replace('.mjs', '')}`, {
      exclude: [missing],
    })
    const root = tempDir(`missing-root-${missing.replace('.mjs', '')}`)
    const uiBinary = writeUiStub(tempDir(`stub-missing-${missing.replace('.mjs', '')}`))
    const result = runInstall({ root, uiBinary, script })
    assert.notEqual(result.status, 0, `${missing} 缺失时安装必须失败`)
    const output = combinedOutput(result)
    assert.match(output, /missing source:/, output)
    assert.match(output, new RegExp(escapeRegExp(missing)), output)
    assertNoInstallRoot(root)
  }
})

test('validation failure leaves an existing isolated install untouched', () => {
  const { script } = copySourceTree('untouched', { exclude: ['dsh-cli-messages.mjs'] })
  const root = tempDir('untouched-root')
  const lib = join(root, 'lib', 'dsh-ask')
  const bin = join(root, 'bin')
  mkdirSync(lib, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(lib, 'dsh-ask.mjs'), 'sentinel old entry\n')
  writeFileSync(join(bin, 'dsh-ask'), 'sentinel old launcher\n')
  const beforeLib = sortedNames(lib)
  const beforeBin = sortedNames(bin)

  const uiBinary = writeUiStub(tempDir('stub-untouched'))
  const result = runInstall({ root, uiBinary, script })
  assert.notEqual(result.status, 0)
  assert.match(combinedOutput(result), /missing source:/)

  assert.deepEqual(sortedNames(lib), beforeLib, '失败时不得新增/删除 lib 文件（含备份）')
  assert.deepEqual(sortedNames(bin), beforeBin, '失败时不得新增/删除 bin 文件')
  assert.equal(readFileSync(join(lib, 'dsh-ask.mjs'), 'utf8'), 'sentinel old entry\n')
  assert.equal(readFileSync(join(bin, 'dsh-ask'), 'utf8'), 'sentinel old launcher\n')
})

// ---------------------------------------------------------------------------
// 5) Closure check follows static catalog imports (it cannot be bypassed)
// ---------------------------------------------------------------------------

test('a statically imported catalog left out of the module set is rejected', () => {
  // dsh-ask.mjs imports ./dsh-cli-messages.mjs and dsh-tui.mjs imports
  // ./dsh-tui-messages.mjs; dropping a catalog from MODULES must fail the
  // closure check even though every remaining file exists.
  for (const dropped of ['dsh-cli-messages.mjs', 'dsh-tui-messages.mjs']) {
    const { script } = copySourceTree(`drop-${dropped.replace('.mjs', '')}`)
    const remaining = MODULE_SET.filter((name) => name !== dropped)
    patchModuleSet(script, remaining)

    const root = tempDir(`drop-root-${dropped.replace('.mjs', '')}`)
    const uiBinary = writeUiStub(tempDir(`stub-drop-${dropped.replace('.mjs', '')}`))
    const result = runInstall({ root, uiBinary, script })
    assert.notEqual(result.status, 0, `${dropped} 不在 MODULES 时必须拒绝安装`)
    const output = combinedOutput(result)
    assert.match(output, /incomplete module set:/, output)
    assert.match(output, new RegExp(escapeRegExp(dropped)), output)
    assert.match(output, /not one of the 6 installed modules/, output)
    assertNoInstallRoot(root)
  }
})

test('a catalog importing a module outside the set is rejected', () => {
  const { dir, script } = copySourceTree('outside')
  writeFileSync(join(dir, 'dsh-extra.mjs'), 'export const EXTRA = 1\n')
  const catalogPath = join(dir, 'dsh-tui-messages.mjs')
  writeFileSync(
    catalogPath,
    `${readFileSync(catalogPath, 'utf8')}\nimport { EXTRA } from './dsh-extra.mjs'\nvoid EXTRA\n`,
  )

  const root = tempDir('outside-root')
  const uiBinary = writeUiStub(tempDir('stub-outside'))
  const result = runInstall({ root, uiBinary, script })
  assert.notEqual(result.status, 0, '目录外模块必须让闭包检查失败')
  const output = combinedOutput(result)
  assert.match(output, /dsh-tui-messages\.mjs imports \.\/dsh-extra\.mjs/, output)
  assert.match(output, /dsh-extra\.mjs\) which is not one of the 7 installed modules/, output)
  assertNoInstallRoot(root)
})

test('a module nothing reaches is rejected', () => {
  const { dir, script } = copySourceTree('unreached')
  writeFileSync(join(dir, 'dsh-unused.mjs'), 'export const UNUSED = 1\n')
  patchModuleSet(script, [...MODULE_SET, 'dsh-unused.mjs'])

  const root = tempDir('unreached-root')
  const uiBinary = writeUiStub(tempDir('stub-unreached'))
  const result = runInstall({ root, uiBinary, script })
  assert.notEqual(result.status, 0, '无人引用的模块必须让闭包检查失败')
  assert.match(combinedOutput(result), /dsh-unused\.mjs is never reached from dsh-ask\.mjs/)
  assertNoInstallRoot(root)
})

test('the checkout really imports the catalog modules statically', () => {
  // The closure check's static-import support is only meaningful while the
  // entry points import the catalogs with `import ... from './<catalog>'`.
  const entry = readFileSync(join(REPO, 'dsh-ask.mjs'), 'utf8')
  const tui = readFileSync(join(REPO, 'dsh-tui.mjs'), 'utf8')
  assert.match(entry, /from\s+['"]\.\/dsh-cli-messages\.mjs['"]/, 'dsh-ask.mjs 必须静态 import CLI catalog')
  assert.match(entry, /from\s+['"]\.\/dsh-i18n\.mjs['"]/, 'dsh-ask.mjs 必须静态 import 翻译核心')
  assert.match(entry, /await import\(['"]\.\/dsh-tui\.mjs['"]\)/, 'dsh-ask.mjs 仍通过动态 import 加载 TUI')
  assert.match(tui, /from\s+['"]\.\/dsh-tui-messages\.mjs['"]/, 'dsh-tui.mjs 必须静态 import TUI catalog')
  assert.match(tui, /await import\(['"]\.\/dsh-native-screen\.mjs['"]\)/, 'dsh-tui.mjs 仍通过动态 import 加载 native screen')
})
