//! Event loop + terminal lifecycle for the native display layer.
//!
//! Two event sources are merged:
//! * fd3 line JSON from the parent (`render` / `stop`), delivered on a channel
//!   by `ipc::spawn_reader`;
//! * the inherited terminal (keys, paste, mouse wheel, resize), read through
//!   crossterm.
//!
//! Rendering is differential: `render::draw` is a pure function of the latest
//! `View`, and ratatui only flushes changed cells.
//!
//! Terminal restoration is RAII: [`TerminalGuard`] restores raw mode, the
//! alternate screen, bracketed paste, mouse capture and the cursor on drop, on
//! panic, and on SIGINT/SIGTERM/SIGHUP. `--version` never reaches this module.

use std::io::{self, IsTerminal};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::Arc;
use std::time::Duration;

use crossterm::cursor::{Hide, Show};
use crossterm::event::{self, EnableBracketedPaste, EnableMouseCapture};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use ratatui::Terminal;

use crate::input::{self, InputEvent};
use crate::ipc::{self, Out};
use crate::protocol::{Inbound, View};
use crate::render;

/// How often the loop wakes up to notice a signal or a parent message. The
/// parent's render messages are drained on every iteration; 16 ms keeps latency
/// under one 60 Hz frame without busy spinning.
const POLL_TIMEOUT: Duration = Duration::from_millis(16);

/// Run the display layer. Returns the process exit code (0 normal, 2 fatal).
pub fn run() -> i32 {
    let (receiver, out) = match ipc::open_fds() {
        Ok(pair) => pair,
        Err(error) => {
            eprintln!("dsh-ask-ui: cannot open fd3/fd4 pipes: {error}");
            return 2;
        }
    };

    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        let _ = out.error("stdin and stdout must be a terminal");
        eprintln!("dsh-ask-ui: stdin and stdout must be a terminal");
        return 2;
    }

    let terminate = Arc::new(AtomicBool::new(false));
    install_signal_handlers(&terminate);

    // From here on every early return restores the terminal through Drop.
    let _guard = match TerminalGuard::enter() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = out.error(&format!("failed to initialize the terminal: {error}"));
            return 2;
        }
    };

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = match Terminal::new(backend) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = out.error(&format!("failed to initialize the screen: {error}"));
            return 2;
        }
    };

    if let Err(error) = terminal.clear() {
        let _ = out.error(&format!("failed to clear the screen: {error}"));
        return 2;
    }
    if out.ready().is_err() {
        // The parent is already gone; the guard still restores the terminal.
        return 0;
    }
    if let Ok(size) = terminal.size() {
        let _ = out.resize(size.width, size.height);
    }

    let mut latest: Option<View> = None;
    let mut dirty = false;

    loop {
        if terminate.load(Ordering::Relaxed) {
            return 0;
        }

        // 1. Drain every parent message that is already available.
        let mut stop = false;
        loop {
            match receiver.try_recv() {
                Ok(Inbound::Render(view)) => {
                    latest = Some(view);
                    dirty = true;
                }
                Ok(Inbound::Stop) => {
                    stop = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    // fd3 EOF: the parent exited, treat it as `stop`.
                    stop = true;
                    break;
                }
            }
        }
        if stop {
            return 0;
        }

        // 2. Draw the newest view. Frames that arrive while a draw is in
        //    progress are coalesced by this loop.
        if dirty {
            if let Some(view) = latest.as_ref() {
                match terminal.draw(|frame| render::draw(frame, view)) {
                    Ok(_) => dirty = false,
                    Err(error) => {
                        let _ = out.error(&format!("failed to draw: {error}"));
                        return 2;
                    }
                }
            }
        }

        // 3. Handle terminal input. `poll` also bounds how long we wait before
        //    checking the parent channel and the termination flag again.
        match event::poll(POLL_TIMEOUT) {
            Ok(true) => match event::read() {
                Ok(event) => match input::translate(event) {
                    Some(InputEvent::Key { text, key }) => {
                        if out.key(&text, key).is_err() {
                            return 0;
                        }
                    }
                    Some(InputEvent::Resize { columns, rows }) => {
                        if let Err(error) =
                            terminal.resize(Rect::new(0, 0, columns.max(1), rows.max(1)))
                        {
                            let _ = out.error(&format!("failed to resize: {error}"));
                            return 2;
                        }
                        if out.resize(columns, rows).is_err() {
                            return 0;
                        }
                        // Redraw immediately at the new size; the parent will
                        // follow up with a `render` recalibrated for it.
                        dirty = latest.is_some();
                    }
                    None => {}
                },
                Err(error) => {
                    let _ = out.error(&format!("failed to read a terminal event: {error}"));
                    return 2;
                }
            },
            Ok(false) => {}
            Err(error) => {
                let _ = out.error(&format!("failed to poll the terminal: {error}"));
                return 2;
            }
        }
    }
}

/// RAII terminal state: raw mode, alternate screen, hidden cursor, bracketed
/// paste and mouse capture. Restoration order is fixed by the contract and is
/// idempotent, so `Drop`, the panic hook and the signal path can all call it.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(
            stdout,
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableMouseCapture,
            Hide
        ) {
            let _ = disable_raw_mode();
            return Err(error);
        }
        Ok(TerminalGuard)
    }

    fn restore() {
        let mut stdout = io::stdout();
        let _ = execute!(
            stdout,
            crossterm::event::DisableMouseCapture,
            crossterm::event::DisableBracketedPaste,
            Show,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        Self::restore();
    }
}

/// SIGINT/SIGTERM/SIGHUP set a flag; the event loop notices it within
/// [`POLL_TIMEOUT`] and exits normally so the RAII guard restores the terminal.
/// (SIGKILL cannot be caught; nothing can restore the terminal in that case.)
fn install_signal_handlers(flag: &Arc<AtomicBool>) {
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // Restore the terminal before the default hook prints the panic.
            TerminalGuard::restore();
            default_hook(info);
        }));
        for signal in [SIGINT, SIGTERM, SIGHUP] {
            // Registration failure only loses the graceful signal path; the
            // process still restores on normal exit/panic/drop.
            let _ = signal_hook::flag::register(signal, Arc::clone(flag));
        }
    }
}

/// Utility used by unit tests: what a fatal error looks like on fd4.
#[allow(dead_code)]
fn fatal(out: &Out, message: &str) -> i32 {
    let _ = out.error(message);
    2
}
