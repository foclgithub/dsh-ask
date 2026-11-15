#!/bin/sh
# Build the native display layer for dsh-ask (Rust + Ratatui + Crossterm).
#
# The full-screen UI is a separate native binary, `dsh-ask-ui`, spawned by
# `dsh-native-screen.mjs` over the fixed fd3/fd4 JSON protocol. This script
# compiles it from the checkout and copies the release artifact next to the
# sources:
#
#   cargo build --release --manifest-path native/Cargo.toml \
#               --target-dir "$TARGET_DIR"
#   cp "$TARGET_DIR/release/dsh-ask-ui" native/bin/dsh-ask-ui
#
# Every Rust dependency is compiled from source by cargo on this machine; this
# script never fetches a prebuilt binary. `DSH_UI_BINARY` is not involved here:
# it is the installer's override for choosing which build artifact to install.
#
# `TARGET_DIR` defaults to $TMPDIR/dsh-ask-native-target (or
# /tmp/dsh-ask-native-target when TMPDIR is unset), so a rebuild does not pollute
# the checkout. Set CARGO_TARGET_DIR to put the build cache elsewhere; both this
# script and scripts/install.sh honour it. Existing files are replaced in place,
# never deleted.
#
# Cargo environment variables (CARGO_HOME, CARGO_NET_OFFLINE, ...) are passed
# through unchanged. No private Cargo home is assumed: a normal cargo/rustup
# setup works, and an offline rebuild can point CARGO_HOME at a prepared
# registry cache with CARGO_NET_OFFLINE=true.
set -eu

PROG=dsh-ask-ui-build
TARGET_DIR=${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/dsh-ask-native-target}
BIN_NAME=dsh-ask-ui

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
usage: scripts/build-ui.sh [-h|--help]

Build the native full-screen display layer (native/bin/dsh-ask-ui) from this
checkout with cargo:

  1. cargo build --release --manifest-path native/Cargo.toml \
                 --target-dir "$TARGET_DIR"
  2. copy "$TARGET_DIR/release/dsh-ask-ui"
         to native/bin/dsh-ask-ui (mode 0755, replacement in place)
  3. run the fresh native/bin/dsh-ask-ui --version as a smoke test

TARGET_DIR defaults to ${TMPDIR:-/tmp}/dsh-ask-native-target and can be
overridden with CARGO_TARGET_DIR.

The dependencies are compiled locally from the Rust sources; the script never
downloads a prebuilt binary. Cargo environment variables (CARGO_HOME,
CARGO_NET_OFFLINE, ...) are inherited as-is; no private cache is required. No
file is deleted.

After a successful build, scripts/install.sh installs the binary from
native/bin/dsh-ask-ui (or from DSH_UI_BINARY when that is set) into the
install root as <root>/lib/dsh-ask/dsh-ask-ui.
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

command -v cargo >/dev/null 2>&1 || die "cargo is not on PATH; install the Rust toolchain first"
command -v rustc >/dev/null 2>&1 || die "rustc is not on PATH; install the Rust toolchain first"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || die "cannot locate this script"
SRC_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || die "cannot locate the source directory"

MANIFEST=$SRC_DIR/native/Cargo.toml
ENTRY=$SRC_DIR/native/src/main.rs
BIN_DIR=$SRC_DIR/native/bin
TARGET_BIN=$BIN_DIR/$BIN_NAME
BUILT_BIN=$TARGET_DIR/release/$BIN_NAME

[ -f "$MANIFEST" ] || die "missing $MANIFEST (is this a dsh-ask checkout?)"
[ -f "$ENTRY" ] || die "missing $ENTRY (the native crate source is incomplete)"

note "building $BIN_NAME (release) from $MANIFEST"
note "  target dir $TARGET_DIR"
if ! cargo build --release --manifest-path "$MANIFEST" --target-dir "$TARGET_DIR"; then
  die "cargo build failed (the target dir was left in place for inspection: $TARGET_DIR)"
fi

[ -f "$BUILT_BIN" ] || die "cargo finished but $BUILT_BIN is missing"
[ -x "$BUILT_BIN" ] || die "cargo produced $BUILT_BIN but it is not executable"

mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"
tmp=$TARGET_BIN.tmp.$$
cp "$BUILT_BIN" "$tmp" || die "cannot write $tmp (left in place for inspection)"
chmod 0755 "$tmp" || die "cannot set mode 0755 on $tmp (left in place for inspection)"
mv -f "$tmp" "$TARGET_BIN" || die "cannot replace $TARGET_BIN; staged file kept at $tmp"

VERSION_LINE=$("$TARGET_BIN" --version 2>/dev/null | head -n 1) ||
  die "$TARGET_BIN --version failed; the copied artifact is not usable"
case "$VERSION_LINE" in
  "dsh-ask-ui "?*) ;;
  *) die "unexpected --version output from $TARGET_BIN: '$VERSION_LINE'" ;;
esac

note "built $VERSION_LINE"
note "  target $BUILT_BIN"
note "  copied $TARGET_BIN"
note "next: ./scripts/install.sh  (or DSH_UI_BINARY=$TARGET_BIN ./scripts/install.sh)"
