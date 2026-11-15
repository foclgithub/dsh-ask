#!/bin/sh
# Install the dsh-ask CLI from this checkout.
#
#   <root>/lib/dsh-ask/dsh-ask.mjs           (the real CLI)
#   <root>/lib/dsh-ask/dsh-media.mjs         (image, clipboard, preview helpers)
#   <root>/lib/dsh-ask/dsh-tui.mjs           (full-screen business layer)
#   <root>/lib/dsh-ask/dsh-native-screen.mjs (native screen adapter, fd3/fd4)
#   <root>/lib/dsh-ask/dsh-i18n.mjs          (language resolver + translator core)
#   <root>/lib/dsh-ask/dsh-cli-messages.mjs  (CLI message catalog, zh/en)
#   <root>/lib/dsh-ask/dsh-tui-messages.mjs  (TUI message catalog, zh/en)
#   <root>/lib/dsh-ask/dsh-ask-ui            (Rust/Ratatui native display layer)
#   <root>/bin/dsh-ask                       (thin launcher; works from any cwd)
#
# The seven JavaScript modules are one unit and the native binary is their
# required display layer, so all eight artifacts are validated together BEFORE
# anything is written:
#
#   * every module exists, is non-empty and passes `node --check`;
#   * the relative-import closure of `dsh-ask.mjs` is exactly these seven
#     modules: every relative module specifier in the set must resolve to a
#     file inside the set. Static catalog imports (`import { CLI_CATALOG } from
#     './dsh-cli-messages.mjs'`, `import { TUI_CATALOG } from
#     './dsh-tui-messages.mjs'`), bare side-effect imports, re-exports and
#     dynamic `import()` are all edges, so a catalog module can neither go
#     missing nor be pulled in without being installed;
#   * every module is reachable from the entry point (catalogs included), and
#     validation, backup and staging below all iterate the same MODULES list,
#     so nothing can be validated without being copied or copied without being
#     validated;
#   * `node dsh-ask.mjs --help` succeeds (no Host, no full-screen);
#   * the native binary exists, is executable and answers `--version` with
#     `dsh-ask-ui <semver>` on its first line, so a missing or stub build can
#     never be installed.
#
# The native binary is taken from DSH_UI_BINARY when that is set; otherwise it
# is discovered in this order: <checkout>/native/bin/dsh-ask-ui,
# ${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/dsh-ask-native-target}/release/dsh-ask-ui,
# and finally the already installed <root>/lib/dsh-ask/dsh-ask-ui (for a
# reinstall without a rebuild). Both build-ui.sh and this script honour
# CARGO_TARGET_DIR, so point them at the same directory when overriding it.
# The old JS screen module (dsh-tui-screen.mjs) stays in the checkout for
# reference and is deliberately NOT installed.
#
# <root> defaults to $HOME/.local. DSH_CLI_INSTALL_ROOT overrides it, which is
# how the test suite installs into an isolated /tmp root.
#
# Existing files at those nine paths are copied to <name>.bak.<timestamp>
# BEFORE any replacement, then each new file is staged next to its target and
# renamed into place (rename is atomic within one directory). Nothing is
# deleted: on failure the staged temporary file is kept and its path printed.
# No shell profile or Host configuration is touched, and the plugin/app is
# never restarted.
set -eu

PROG=dsh-ask-install
# Dependency order: every module is validated, backed up and staged after the
# modules it imports, so a failed install never leaves a module without its
# dependencies. The set is the CLI, its media/display helpers, the translator
# core and the two catalog modules (CLI and TUI).
ENTRY=dsh-ask.mjs
MODULES="dsh-i18n.mjs dsh-cli-messages.mjs dsh-tui-messages.mjs dsh-media.mjs dsh-native-screen.mjs dsh-tui.mjs dsh-ask.mjs"
UI_NAME=dsh-ask-ui
DEFAULT_TARGET_DIR=${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/dsh-ask-native-target}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
usage: scripts/install.sh [-h|--help]

Install dsh-ask into $DSH_CLI_INSTALL_ROOT (default: $HOME/.local):
  lib/dsh-ask/dsh-ask.mjs           the CLI
  lib/dsh-ask/dsh-media.mjs         image, clipboard and preview helpers
  lib/dsh-ask/dsh-tui.mjs           full-screen business layer
  lib/dsh-ask/dsh-native-screen.mjs native screen adapter (fd3/fd4 protocol)
  lib/dsh-ask/dsh-i18n.mjs          language resolver and translator core
  lib/dsh-ask/dsh-cli-messages.mjs  zh/en message catalog for the CLI
  lib/dsh-ask/dsh-tui-messages.mjs  zh/en message catalog for the TUI
  lib/dsh-ask/dsh-ask-ui            native Rust/Ratatui display layer
  bin/dsh-ask                       thin launcher, resolves the lib dir from its own path

The seven modules and the native binary are validated together before anything
is written; if any of them is missing, broken or not executable the install
stops without modifying the install root. Every relative import of the module
set (static catalog imports, re-exports and dynamic import() included) must
resolve inside the same seven modules, so a missing or extraneous module aborts
the install instead of producing a CLI that cannot start. The native binary is
read from DSH_UI_BINARY when set, else from native/bin/dsh-ask-ui, else from
${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/dsh-ask-native-target}/release/dsh-ask-ui,
else from the current install. Build it first with scripts/build-ui.sh.

Existing files at those nine paths are backed up as <name>.bak.<UTC timestamp>
before being replaced atomically. No file is deleted; a failed install keeps
its staged temporary file and prints its path. The old JS screen module
(dsh-tui-screen.mjs) is left in the checkout and is not installed. Other files
are left untouched.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $arg (try --help)"
      ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node.js first"
NODE=$(command -v node)

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || die "cannot locate this script"
SRC_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || die "cannot locate the source directory"

# --- resolve the isolated or real install root ------------------------------
# Pure string work; no directory is created until every check has passed.

if [ "${DSH_CLI_INSTALL_ROOT:-}" != "" ]; then
  ROOT=$DSH_CLI_INSTALL_ROOT
else
  ROOT=$HOME/.local
fi

case "$ROOT" in
  "~") ROOT=$HOME ;;
  "~/"*) ROOT=$HOME/${ROOT#\~/} ;;
esac
RAW_ROOT=$ROOT
ROOT=${ROOT%/}

case "$ROOT" in
  "" | /) die "refusing install root '$RAW_ROOT'" ;;
esac

LIB_DIR=$ROOT/lib/dsh-ask
BIN_DIR=$ROOT/bin
LAUNCHER=$BIN_DIR/dsh-ask
INSTALLED_UI=$LIB_DIR/$UI_NAME

# Never overwrite the checkout the script was run from.
if [ "$SRC_DIR" = "$LIB_DIR" ]; then
  die "install root resolves to the source tree: $ROOT"
fi
for name in $MODULES; do
  if [ "$SRC_DIR/$name" = "$LIB_DIR/$name" ]; then
    die "install root resolves to the source tree: $ROOT"
  fi
done
if [ "$SRC_DIR/native/bin/$UI_NAME" = "$INSTALLED_UI" ]; then
  die "install root resolves to the source tree: $ROOT"
fi

# --- validate the whole module set before touching the install root ----------

for name in $MODULES; do
  src=$SRC_DIR/$name
  [ -f "$src" ] || die "missing source: $src (the install needs all seven modules: $MODULES)"
  [ -s "$src" ] || die "empty source: $src"
done

for name in $MODULES; do
  "$NODE" --check "$SRC_DIR/$name" || die "node syntax check failed: $SRC_DIR/$name"
done

# The modules are one package: dsh-ask.mjs reaches the media, translator and
# CLI catalog modules, the TUI reaches the native screen adapter plus the
# translator and TUI catalog modules, and the TUI catalog reaches the
# translator core. Refuse a mix whose relative imports point at files that are
# not part of the set, or a module the entry never reaches, because either
# would install a CLI that cannot even start.
#
# Every relative specifier counts as an edge, so the static catalog imports
# (`import { CLI_CATALOG } from './dsh-cli-messages.mjs'` and
# `import { TUI_CATALOG } from './dsh-tui-messages.mjs'`), bare side-effect
# imports, re-exports and dynamic import() all take part in the closure. That
# is what keeps the check from being bypassed by a module that is only pulled
# in by a catalog or only dynamically loaded.
SRC_DIR=$SRC_DIR MODULES=$MODULES ENTRY=$ENTRY "$NODE" -e '
const fs = require("node:fs")
const path = require("node:path")
const srcDir = process.env.SRC_DIR
const names = process.env.MODULES.split(" ")
const entry = process.env.ENTRY
const allowed = new Set(names)
if (allowed.has(entry) !== true) {
  console.error("incomplete module set: entry " + entry + " is not one of the modules: " + names.join(" "))
  process.exit(1)
}
const edges = new Map()
for (const name of names) {
  const text = fs.readFileSync(path.join(srcDir, name), "utf8")
  const targets = []
  const re = /\b(?:from|import)\s*\(?\s*["\x27](\.[^"\x27]+)["\x27]/g
  let match
  while ((match = re.exec(text)) !== null) {
    const resolved = path.resolve(srcDir, match[1])
    if (fs.existsSync(resolved) !== true) {
      console.error("incomplete module set: " + name + " imports " + match[1] + ", but " + resolved + " is missing")
      process.exit(1)
    }
    const base = path.basename(resolved)
    if (allowed.has(base) !== true) {
      console.error("incomplete module set: " + name + " imports " + match[1] + " (" + base + ") which is not one of the " + names.length + " installed modules")
      process.exit(1)
    }
    targets.push(base)
  }
  edges.set(name, targets)
}
const seen = new Set()
const queue = [entry]
while (queue.length > 0) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)
  for (const target of edges.get(name) || []) if (seen.has(target) !== true) queue.push(target)
}
for (const name of names) {
  if (seen.has(name) !== true) {
    console.error("incomplete module set: " + name + " is never reached from " + entry)
    process.exit(1)
  }
}
' || die "refusing to install an incomplete module set"

# --help returns before the CLI probes a Host or starts the full-screen UI, so
# this is a safe smoke test of the module set (imports included) with no
# side effects.
"$NODE" "$SRC_DIR/dsh-ask.mjs" --help >/dev/null 2>&1 || die "source CLI failed its --help smoke test"

# --- resolve and validate the native display layer --------------------------
# The binary must answer --version without a TTY and without the protocol fds;
# that is also what proves it is a real build rather than a stub artifact.

UI_SOURCE=''
if [ "${DSH_UI_BINARY:-}" != "" ]; then
  UI_SOURCE=$DSH_UI_BINARY
  UI_ORIGIN='DSH_UI_BINARY'
else
  for candidate in \
    "$SRC_DIR/native/bin/$UI_NAME" \
    "$DEFAULT_TARGET_DIR/release/$UI_NAME" \
    "$INSTALLED_UI"; do
    if [ -f "$candidate" ]; then
      UI_SOURCE=$candidate
      UI_ORIGIN=$candidate
      break
    fi
  done
fi

[ "$UI_SOURCE" != "" ] || die "no native UI binary found; build it with scripts/build-ui.sh, or point DSH_UI_BINARY at a build artifact (checked native/bin/$UI_NAME, $DEFAULT_TARGET_DIR/release/$UI_NAME, $INSTALLED_UI)"
[ -f "$UI_SOURCE" ] || die "native UI binary is not a regular file: $UI_SOURCE (from $UI_ORIGIN)"
[ -x "$UI_SOURCE" ] || die "native UI binary is not executable: $UI_SOURCE (from $UI_ORIGIN; run chmod 0755 or rebuild)"

if ! UI_VERSION_OUT=$("$UI_SOURCE" --version 2>/dev/null); then
  die "native UI binary failed '$UI_SOURCE --version' (from $UI_ORIGIN); rebuild with scripts/build-ui.sh"
fi
UI_VERSION_LINE=$(printf '%s\n' "$UI_VERSION_OUT" | head -n 1)
case "$UI_VERSION_LINE" in
  dsh-ask-ui\ *) ;;
  *) die "native UI binary reported an unexpected --version line: '$UI_VERSION_LINE' (from $UI_ORIGIN; expected 'dsh-ask-ui <semver>'; rebuild with scripts/build-ui.sh or set DSH_UI_BINARY)" ;;
esac
UI_VERSION=${UI_VERSION_LINE#dsh-ask-ui }
[ "$UI_VERSION" != "" ] || die "native UI binary reported an empty version: '$UI_VERSION_LINE' (from $UI_ORIGIN; rebuild with scripts/build-ui.sh or set DSH_UI_BINARY)"

mkdir -p "$LIB_DIR" "$BIN_DIR" || die "cannot create $LIB_DIR and $BIN_DIR"

# --- back up the old entry, modules and native binary (nothing deleted) -----

STAMP=$(date -u +%Y%m%dT%H%M%SZ) || die "cannot read the current time"

backup() {
  target=$1
  [ -e "$target" ] || return 0
  base=$target.bak.$STAMP
  candidate=$base
  suffix=1
  while [ -e "$candidate" ]; do
    suffix=$((suffix + 1))
    candidate=$base-$suffix
  done
  cp -p "$target" "$candidate" || die "cannot back up $target"
  BACKUPS="$BACKUPS$candidate
"
}

BACKUPS=""
backup "$LAUNCHER"
for name in $MODULES; do
  backup "$LIB_DIR/$name"
done
backup "$INSTALLED_UI"

# --- stage next to the target, then rename into place -----------------------
# A failed install leaves the staged file in place; the error message says where
# it is, so the problem can be inspected instead of being cleaned up silently.

stage_file() {
  source=$1
  target=$2
  mode=$3
  tmp=$target.tmp.$$
  cp "$source" "$tmp" || die "cannot write $tmp (left in place for inspection)"
  chmod "$mode" "$tmp" || die "cannot set mode $mode on $tmp (left in place for inspection)"
  mv -f "$tmp" "$target" || die "cannot replace $target; staged file kept at $tmp"
}

write_launcher() {
  target=$1
  tmp=$target.tmp.$$
  cat >"$tmp" <<'LAUNCHER'
#!/bin/sh
# Thin launcher generated by scripts/install.sh.
# The real CLI, its image helpers, the full-screen business layer and the
# native screen adapter (plus the dsh-ask-ui binary it spawns) live in
# ../lib/dsh-ask/.
set -eu
self=$0
case $self in
  */*) ;;
  *) self=$(command -v -- "$self" 2>/dev/null) || self=$0 ;;
esac
bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd -P) || {
  printf 'dsh-ask: cannot resolve the launcher directory\n' >&2
  exit 1
}
lib_dir=$(CDPATH= cd -P -- "$bin_dir/../lib/dsh-ask" && pwd -P) || {
  printf 'dsh-ask: missing %s (run scripts/install.sh again)\n' "$bin_dir/../lib/dsh-ask" >&2
  exit 1
}
exec node "$lib_dir/dsh-ask.mjs" "$@"
LAUNCHER
  chmod 0755 "$tmp" || die "cannot set mode 0755 on $tmp (left in place for inspection)"
  sh -n "$tmp" 2>/dev/null || die "generated launcher failed sh -n; file kept at $tmp"
  mv -f "$tmp" "$target" || die "cannot replace $target; staged file kept at $tmp"
}

# Dependencies first (MODULES is in dependency order): the translator and both
# catalogs are installed before the CLI/TUI that import them, the media and
# native-screen helpers before the modules that use them, and dsh-ask.mjs last,
# right before the native binary it spawns. Iterating MODULES is deliberate:
# the exact set that was validated and backed up above is the set that gets
# copied, so no module can be skipped.
for name in $MODULES; do
  stage_file "$SRC_DIR/$name" "$LIB_DIR/$name" 0644
done

# Each installed module must be byte-identical to its source. `stage_file`
# already dies on a failed copy; this also catches a copy that silently changed
# and keeps the "validated, backed up and installed as one unit" guarantee.
for name in $MODULES; do
  cmp -s "$SRC_DIR/$name" "$LIB_DIR/$name" || die "installed module differs from source: $LIB_DIR/$name (left in place for inspection)"
done

stage_file "$UI_SOURCE" "$INSTALLED_UI" 0755
cmp -s "$UI_SOURCE" "$INSTALLED_UI" || die "installed native binary differs from source: $INSTALLED_UI (left in place for inspection)"
write_launcher "$LAUNCHER"

# --- post-install checks from a foreign working directory -------------------

post_failed=''
(
  cd "${TMPDIR:-/tmp}" || exit 1
  "$LAUNCHER" --help >/dev/null 2>&1
) || post_failed=launcher

if ! INSTALLED_VERSION_OUT=$("$INSTALLED_UI" --version 2>/dev/null); then
  post_failed="${post_failed:+$post_failed,}native-version"
else
  INSTALLED_VERSION_LINE=$(printf '%s\n' "$INSTALLED_VERSION_OUT" | head -n 1)
  if [ "$INSTALLED_VERSION_LINE" != "$UI_VERSION_LINE" ]; then
    post_failed="${post_failed:+$post_failed,}native-version-mismatch"
  fi
fi

if [ "$post_failed" != "" ]; then
  printf '%s: warning: post-install check failed (%s)\n' "$PROG" "$post_failed" >&2
  if [ "$BACKUPS" != "" ]; then
    printf 'old files are still available at:\n%s' "$BACKUPS" >&2
  fi
  exit 1
fi

# --- summary ----------------------------------------------------------------

note "installed dsh-ask"
note "  lib  $LIB_DIR"
for name in $MODULES; do
  note "       $name"
done
note "       $UI_NAME  ($UI_VERSION_LINE)"
note "  bin  $LAUNCHER"
note "native UI source: $UI_SOURCE (from $UI_ORIGIN)"
if [ "$BACKUPS" != "" ]; then
  printf 'backed up (timestamped):\n%s' "$BACKUPS"
fi
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *) note "note: $BIN_DIR is not on PATH; no profile was modified." ;;
esac
