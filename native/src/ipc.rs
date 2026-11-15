//! fd3 reader / fd4 writer.
//!
//! The parent process spawns this binary with two extra pipes (contract §1):
//!
//! * fd3 — parent → child, one JSON message per line (`render` / `stop`). EOF
//!   means the parent exited and is equivalent to `stop`.
//! * fd4 — child → parent, one JSON message per line (`ready` / `key` /
//!   `resize` / `error`), flushed after every line.
//!
//! Both fds are wrapped in plain `std::fs::File`s because the process owns them
//! for its whole lifetime; closing them on exit is expected. Nothing here writes
//! to stdout/stdin, and every error is surfaced through `io::Result` so the
//! event loop can decide between "parent is gone" (exit 0) and a fatal error.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

use crate::protocol::{Inbound, KeyPayload, Outbound};

/// Parent → child pipe (read side).
const INBOUND_FD: RawFd = 3;
/// Child → parent pipe (write side).
const OUTBOUND_FD: RawFd = 4;

/// One fd3 line may not exceed 16 MiB (contract §1). Longer lines are skipped
/// instead of buffered without bound.
const MAX_INBOUND_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Environment variable that enables stderr diagnostics for skipped lines.
const DEBUG_ENV: &str = "DSH_ASK_UI_DEBUG";

/// Writer for the fd4 line protocol.
///
/// The writer is boxed so [`Out`] stays a single concrete type, and guarded by a
/// mutex so one line is always one contiguous, always-flushed JSON frame even if
/// several threads emit at once.
pub struct Out {
    writer: Mutex<Box<dyn Write + Send>>,
}

impl Out {
    /// Wrap any writer. Tests pass an in-memory sink; [`open_fds`] passes fd4.
    pub fn new<W: Write + Send + 'static>(writer: W) -> Out {
        Out {
            writer: Mutex::new(Box::new(writer)),
        }
    }

    /// Serialize and write one protocol message as a single line.
    pub fn send(&self, message: Outbound) -> io::Result<()> {
        self.write_line(&message.to_line())
    }

    /// Announce that the terminal (alt screen + raw mode + paste + mouse) is up.
    pub fn ready(&self) -> io::Result<()> {
        self.send(Outbound::Ready)
    }

    /// Forward one key/paste/wheel event. `text` is the insertable text.
    pub fn key(&self, text: &str, key: KeyPayload) -> io::Result<()> {
        self.send(Outbound::Key {
            text: text.to_string(),
            key,
        })
    }

    /// Report a terminal size change (or the initial size right after `ready`).
    pub fn resize(&self, columns: u16, rows: u16) -> io::Result<()> {
        self.send(Outbound::Resize { columns, rows })
    }

    /// Report a fatal error; the caller restores the terminal and exits 2.
    pub fn error(&self, message: &str) -> io::Result<()> {
        self.send(Outbound::Error {
            message: message.to_string(),
        })
    }

    fn write_line(&self, line: &str) -> io::Result<()> {
        // A poisoned lock only means another sender panicked mid-write; the
        // underlying writer is still usable, so keep the parent informed.
        let mut writer = match self.writer.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut frame = Vec::with_capacity(line.len() + 1);
        frame.extend_from_slice(line.as_bytes());
        frame.push(b'\n');
        writer.write_all(&frame)?;
        writer.flush()
    }
}

/// Spawn a background thread that reads fd3 lines and delivers them on a
/// channel. `Stop` is sent on `{"type":"stop"}`, on EOF and on read errors;
/// unknown or malformed lines are skipped (logged only under
/// `DSH_ASK_UI_DEBUG=1`). The thread exits after `Stop` or when the receiver is
/// dropped.
pub fn spawn_reader<R: BufRead + Send + 'static>(mut reader: R) -> Receiver<Inbound> {
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("dsh-ask-ui-fd3".to_string())
        .spawn(move || read_loop(&mut reader, &sender));
    if let Err(error) = spawned {
        // A reader thread is required for keyboard input to reach the parent.
        // Returning the (now disconnected) receiver makes the event loop treat
        // this exactly like EOF: restore the terminal and exit 0.
        debug_log(&format!("failed to spawn the fd3 reader thread: {error}"));
    }
    receiver
}

fn read_loop<R: BufRead>(reader: &mut R, sender: &Sender<Inbound>) {
    loop {
        match read_inbound_line(reader, MAX_INBOUND_LINE_BYTES) {
            Ok(Line::Message(line)) => {
                let Some(message) = Inbound::parse(&line) else {
                    // Unknown `type`, malformed JSON, or unknown fields: skip
                    // the line without tearing the screen down.
                    debug_log("skipping an unknown or malformed fd3 line");
                    continue;
                };
                let stop = matches!(message, Inbound::Stop);
                if sender.send(message).is_err() {
                    // The event loop is gone; nothing left to deliver.
                    return;
                }
                if stop {
                    return;
                }
            }
            Ok(Line::Skipped) => debug_log("skipping an oversized or non-UTF-8 fd3 line"),
            Ok(Line::Eof) => {
                // The parent exited and closed its end of the pipe.
                let _ = sender.send(Inbound::Stop);
                return;
            }
            Err(error) => {
                debug_log(&format!("fd3 read error, treating it as stop: {error}"));
                let _ = sender.send(Inbound::Stop);
                return;
            }
        }
    }
}

/// Outcome of reading one fd3 line.
#[derive(Debug, PartialEq)]
enum Line {
    /// A line that is valid UTF-8; may still fail to parse as JSON.
    Message(String),
    /// Oversized or non-UTF-8; the line was consumed and must be ignored.
    Skipped,
    /// The pipe is closed.
    Eof,
}

/// Read one line, bounded to `max_bytes` of content.
///
/// Reads at most `max_bytes + 1` bytes with `read_until` so a hostile or
/// buggy parent cannot grow this buffer without bound; an over-long line is
/// drained (in fixed-size chunks) and reported as [`Line::Skipped`].
fn read_inbound_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> io::Result<Line> {
    let mut buffer = Vec::new();
    // `Take` limits the read but keeps the same `BufRead`, so the byte stream
    // position is exactly after the line we consumed.
    let limit = max_bytes as u64 + 1;
    let read = reader.by_ref().take(limit).read_until(b'\n', &mut buffer)?;
    if read == 0 {
        return Ok(Line::Eof);
    }

    let terminated = buffer.last() == Some(&b'\n');
    if !terminated && buffer.len() > max_bytes {
        discard_line(reader)?;
        return Ok(Line::Skipped);
    }

    if terminated {
        buffer.pop();
    }
    if buffer.last() == Some(&b'\r') {
        buffer.pop();
    }

    Ok(match String::from_utf8(buffer) {
        Ok(line) => Line::Message(line),
        Err(_) => Line::Skipped,
    })
}

/// Drain the rest of an over-long line in fixed-size chunks.
fn discard_line<R: BufRead>(reader: &mut R) -> io::Result<()> {
    let mut scratch = Vec::new();
    loop {
        scratch.clear();
        let read = reader.by_ref().take(8192).read_until(b'\n', &mut scratch)?;
        if read == 0 || scratch.last() == Some(&b'\n') {
            return Ok(());
        }
    }
}

/// Open the fixed fds 3 (inbound pipe) and 4 (outbound pipe).
///
/// Fails with the underlying OS error (EBADF on unix) when the parent did not
/// provide them. The process owns both descriptors from here on.
pub fn open_fds() -> io::Result<(Receiver<Inbound>, Out)> {
    let input = adopt_fd(INBOUND_FD)?;
    let output = adopt_fd(OUTBOUND_FD)?;
    Ok((spawn_reader(BufReader::new(input)), Out::new(output)))
}

/// Take ownership of `fd`, verifying that the parent actually created it.
///
/// The descriptor is validated with `dup` (`try_clone`), which fails with EBADF
/// when it was never opened. A wrapper around a missing descriptor must *not*
/// be dropped: closing an already-closed fd is an IO-safety violation that the
/// standard library answers with a process abort, so it is leaked instead.
fn adopt_fd(fd: RawFd) -> io::Result<File> {
    // SAFETY: the parent creates fd3/fd4 as pipes before exec and hands them to
    // this process, which makes it the owner. When it did not, the `try_clone`
    // probe below fails and the wrapper is leaked rather than closed.
    let file = unsafe { File::from_raw_fd(fd) };
    match file.try_clone() {
        Ok(probe) => {
            drop(probe);
            Ok(file)
        }
        Err(error) => {
            // Do not drop `file`: a second close would abort the process. The
            // descriptor is not ours to close, so leaking the wrapper is right.
            std::mem::forget(file);
            Err(error)
        }
    }
}

fn debug_log(message: &str) {
    if std::env::var(DEBUG_ENV).is_ok_and(|value| value == "1") {
        eprintln!("dsh-ask-ui: {message}");
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use crate::protocol::View;

    use super::*;

    /// In-memory writer shared with the test so writes can be inspected.
    struct SharedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        flushes: Arc<AtomicUsize>,
    }

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn shared_out() -> (Out, Arc<Mutex<Vec<u8>>>, Arc<AtomicUsize>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let flushes = Arc::new(AtomicUsize::new(0));
        let out = Out::new(SharedWriter {
            bytes: Arc::clone(&bytes),
            flushes: Arc::clone(&flushes),
        });
        (out, bytes, flushes)
    }

    fn payload(name: &str) -> KeyPayload {
        KeyPayload {
            name: name.to_string(),
            ctrl: false,
            meta: false,
            shift: false,
            sequence: None,
        }
    }

    fn expect_message(receiver: &Receiver<Inbound>, timeout: Duration) -> Inbound {
        receiver.recv_timeout(timeout).expect("a message on fd3")
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn out_writes_one_json_line_per_message_and_flushes_each() {
        let (out, bytes, flushes) = shared_out();
        out.ready().unwrap();
        out.key("第一行\n第二行", payload("paste")).unwrap();
        out.resize(100, 30).unwrap();
        out.error("fatal: boom").unwrap();

        assert_eq!(flushes.load(Ordering::SeqCst), 4);
        let text = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        // Four lines, each newline-terminated, so split yields a trailing "".
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[4], "");
        assert_eq!(lines[0], r#"{"type":"ready"}"#);

        let key: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(key["type"], "key");
        assert_eq!(key["str"], "第一行\n第二行");
        assert_eq!(key["key"]["name"], "paste");
        assert_eq!(key["key"]["ctrl"], false);
        assert!(key["key"].get("sequence").is_none());

        let resize: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(resize["type"], "resize");
        assert_eq!(resize["columns"], 100);
        assert_eq!(resize["rows"], 30);

        let error: serde_json::Value = serde_json::from_str(lines[3]).unwrap();
        assert_eq!(error["type"], "error");
        assert_eq!(error["message"], "fatal: boom");
    }

    #[test]
    fn out_keeps_lines_contiguous_when_shared_between_threads() {
        let (out, bytes, _flushes) = shared_out();
        let out = Arc::new(out);
        let handles: Vec<_> = (0..4)
            .map(|thread| {
                let out = Arc::clone(&out);
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        out.key(&format!("t{thread}"), payload("text")).unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let text = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 100);
        for line in lines {
            let value: serde_json::Value = serde_json::from_str(line).expect("a whole JSON line");
            assert_eq!(value["type"], "key");
        }
    }

    #[test]
    fn out_propagates_write_errors() {
        struct FailingWriter;
        impl Write for FailingWriter {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let out = Out::new(FailingWriter);
        let error = out.ready().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn reader_delivers_stop_message_then_stops() {
        let receiver = spawn_reader(Cursor::new(b"{\"type\":\"stop\"}\n".to_vec()));
        assert_eq!(expect_message(&receiver, WAIT), Inbound::Stop);
        // The thread exits after `stop`, so the channel disconnects.
        assert!(receiver.recv_timeout(WAIT).is_err());
    }

    #[test]
    fn reader_delivers_stop_on_eof() {
        let receiver = spawn_reader(Cursor::new(Vec::new()));
        assert_eq!(expect_message(&receiver, WAIT), Inbound::Stop);
        assert!(receiver.recv_timeout(WAIT).is_err());
    }

    #[test]
    fn reader_delivers_stop_on_read_error() {
        struct FailingReader;
        impl Read for FailingReader {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "boom"))
            }
        }
        impl BufRead for FailingReader {
            fn fill_buf(&mut self) -> io::Result<&[u8]> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "boom"))
            }
            fn consume(&mut self, _amount: usize) {}
        }

        let receiver = spawn_reader(FailingReader);
        assert_eq!(expect_message(&receiver, WAIT), Inbound::Stop);
    }

    #[test]
    fn reader_skips_unknown_and_malformed_lines() {
        let input = concat!(
            "not json\n",
            "{\"type\":\"bogus\"}\n",
            "{\"type\":\"render\"}\n",
            "\n",
            "{\"type\":\"render\",\"view\":{}}\n",
            "{\"type\":\"stop\"}\n",
        );
        let receiver = spawn_reader(Cursor::new(input.as_bytes().to_vec()));

        assert_eq!(expect_message(&receiver, WAIT), Inbound::Render(View::default()));
        assert_eq!(expect_message(&receiver, WAIT), Inbound::Stop);
    }

    #[test]
    fn reader_accepts_a_final_line_without_newline_and_crlf() {
        let input = b"{\"type\":\"render\",\"view\":{\"input\":\"hi\",\"inputCursor\":2}}\r\n{\"type\":\"stop\"}\n";
        let receiver = spawn_reader(Cursor::new(input.to_vec()));

        let Inbound::Render(view) = expect_message(&receiver, WAIT) else {
            panic!("expected a render message");
        };
        assert_eq!(view.input, "hi");
        assert_eq!(view.input_cursor, 2);
        assert_eq!(expect_message(&receiver, WAIT), Inbound::Stop);
    }

    #[test]
    fn oversized_and_invalid_utf8_lines_are_skipped() {
        let mut input = Vec::new();
        input.extend_from_slice(b"{\"type\":\"render\",\"view\":{}}\n");
        input.extend(std::iter::repeat(b'x').take(64));
        input.push(b'\n');
        input.extend_from_slice(&[0xff, 0xfe, b'\n']);
        input.extend_from_slice(b"{\"type\":\"stop\"}\n");

        let mut cursor = Cursor::new(input);
        assert!(matches!(
            read_inbound_line(&mut cursor, 32).unwrap(),
            Line::Message(_)
        ));
        assert_eq!(read_inbound_line(&mut cursor, 32).unwrap(), Line::Skipped);
        assert_eq!(read_inbound_line(&mut cursor, 32).unwrap(), Line::Skipped);
        assert!(matches!(
            read_inbound_line(&mut cursor, 32).unwrap(),
            Line::Message(_)
        ));
        assert_eq!(read_inbound_line(&mut cursor, 32).unwrap(), Line::Eof);
    }

    #[test]
    fn a_line_at_exactly_the_limit_is_accepted() {
        // 8 bytes of content + newline, then a 16-byte content line + newline:
        // both fit the limit of 16 and must not be treated as oversized.
        let mut input = vec![b'x'; 8];
        input.push(b'\n');
        input.extend_from_slice(b"{\"type\":\"stop\"}\n");
        let mut cursor = Cursor::new(input);
        assert!(matches!(
            read_inbound_line(&mut cursor, 16).unwrap(),
            Line::Message(_)
        ));
        assert!(matches!(
            read_inbound_line(&mut cursor, 16).unwrap(),
            Line::Message(_)
        ));
    }

    #[test]
    fn empty_pipe_is_eof_immediately() {
        let mut cursor = Cursor::new(Vec::new());
        assert_eq!(read_inbound_line(&mut cursor, 16).unwrap(), Line::Eof);
    }

    #[test]
    fn adopt_fd_takes_ownership_of_a_valid_descriptor() {
        use std::os::fd::{AsRawFd, IntoRawFd};

        let path = std::env::temp_dir().join(format!("dsh-ask-ui-adopt-{}", std::process::id()));
        let file = File::create(&path).expect("a temporary file");
        let raw = file.into_raw_fd();
        let adopted = adopt_fd(raw).expect("a valid descriptor");
        assert_eq!(adopted.as_raw_fd(), raw);
        drop(adopted);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn adopt_fd_reports_ebadf_instead_of_aborting_for_a_missing_descriptor() {
        // A descriptor number far above any real table entry: `dup` fails with
        // EBADF. `adopt_fd` must leak the wrapper instead of dropping it, since
        // closing an already-closed fd makes the standard library abort the
        // process (this is the "IO Safety violation" runtime abort).
        let error = adopt_fd(1_000_000).expect_err("a missing descriptor must fail");
        assert_eq!(error.raw_os_error(), Some(9)); // EBADF on unix
    }
}
