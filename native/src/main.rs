//! `dsh-ask-ui` entry point. The version/help fast path must not touch the
//! TTY or fds 3/4 (installation contract), so argument parsing lives first.

fn main() {
    std::process::exit(dsh_ask_ui::cli::main());
}
