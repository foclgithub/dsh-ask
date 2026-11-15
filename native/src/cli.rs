//! Argument fast path + top-level run.
//!
//! `--version` / `--help` must exit 0 **without** touching the TTY or fds 3/4
//! (installation contract), because the installer and the JS layer call the
//! binary for version discovery outside any terminal session.

use std::io::Write;

use crate::app;
use crate::protocol::version_line;

pub const USAGE: &str = "\
dsh-ask-ui - native terminal display layer for dsh-ask

The binary is normally spawned by the JS layer with the terminal on
stdin/stdout and line-delimited JSON on fd3 (in) and fd4 (out). It is not
meant to be run by hand.

Usage:
  dsh-ask-ui --version    print the version and exit 0 (no terminal needed)
  dsh-ask-ui --help       print this help and exit 0 (no terminal needed)
  dsh-ask-ui              run the display layer (requires fd3/fd4 + a TTY)
";

/// Process entry point. Returns the process exit code.
pub fn main() -> i32 {
    for arg in std::env::args_os().skip(1) {
        let text = arg.to_string_lossy();
        match text.as_ref() {
            "--version" | "-V" => {
                let mut stdout = std::io::stdout();
                let _ = writeln!(stdout, "{}", version_line());
                let _ = stdout.flush();
                return 0;
            }
            "--help" | "-h" => {
                let mut stdout = std::io::stdout();
                let _ = stdout.write_all(USAGE.as_bytes());
                let _ = stdout.flush();
                return 0;
            }
            other => {
                eprintln!("dsh-ask-ui: unexpected argument {other:?}");
                eprintln!("usage: dsh-ask-ui [--version|--help]");
                return 2;
            }
        }
    }
    app::run()
}
