//! Crossterm event translation.
//!
//! The display layer owns the inherited terminal and turns every crossterm
//! event into either one fd4 `key` message or one `resize` message. Everything
//! else (release events, focus changes, non-wheel mouse, bare modifiers) is
//! deliberately dropped here so the parent's readline never sees noise.
//!
//! Key names follow the Node readline naming the JS layer already understands,
//! which is why the mapping is explicit instead of relying on crossterm's names.

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind};

use crate::protocol::KeyPayload;

/// One translated terminal event.
#[derive(Debug, Clone, PartialEq)]
pub enum InputEvent {
    /// A key, paste or mouse-wheel event, ready to be forwarded on fd4.
    Key { text: String, key: KeyPayload },
    /// The terminal window changed size (SIGWINCH).
    Resize { columns: u16, rows: u16 },
}

/// Translate one crossterm event.
///
/// `None` means the display layer intentionally ignores the event; the caller
/// must not forward anything to the parent in that case.
pub fn translate(event: Event) -> Option<InputEvent> {
    match event {
        Event::Key(key) => translate_key(key),
        Event::Paste(text) => Some(InputEvent::Key {
            text,
            key: payload("paste", false, false, false),
        }),
        Event::Resize(columns, rows) => Some(InputEvent::Resize { columns, rows }),
        // Mouse wheel has its own names so the JS side can scroll exactly one
        // line per notch (Codex behaviour) instead of reusing PageUp/PageDown.
        // Keyboard PageUp/PageDown keep their readline names below.
        Event::Mouse(mouse) => match mouse.kind {
            MouseEventKind::ScrollUp => Some(command("wheelup")),
            MouseEventKind::ScrollDown => Some(command("wheeldown")),
            _ => None,
        },
        Event::FocusGained | Event::FocusLost => None,
    }
}

fn translate_key(key: KeyEvent) -> Option<InputEvent> {
    // Terminals that report both press and release would otherwise produce two
    // messages per keystroke; only presses (and auto-repeat) are meaningful.
    if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
        return None;
    }

    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    // crossterm reports Option/Alt as ALT on unix and may use META elsewhere;
    // both mean "meta" to the parent's readline.
    let meta = key
        .modifiers
        .intersects(KeyModifiers::ALT | KeyModifiers::META);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    let (name, text) = match key.code {
        KeyCode::Char(c) => translate_char(c, ctrl, meta)?,
        KeyCode::Enter => ("enter".to_string(), String::new()),
        // BackTab is Shift+Tab on every terminal that reports it.
        KeyCode::Tab | KeyCode::BackTab => ("tab".to_string(), String::new()),
        KeyCode::Esc => ("escape".to_string(), String::new()),
        KeyCode::Backspace => ("backspace".to_string(), String::new()),
        KeyCode::Delete => ("delete".to_string(), String::new()),
        KeyCode::Insert => ("insert".to_string(), String::new()),
        KeyCode::Home => ("home".to_string(), String::new()),
        KeyCode::End => ("end".to_string(), String::new()),
        KeyCode::Up => ("up".to_string(), String::new()),
        KeyCode::Down => ("down".to_string(), String::new()),
        KeyCode::Left => ("left".to_string(), String::new()),
        KeyCode::Right => ("right".to_string(), String::new()),
        KeyCode::PageUp => ("pageup".to_string(), String::new()),
        KeyCode::PageDown => ("pagedown".to_string(), String::new()),
        KeyCode::F(number) => (format!("f{number}"), String::new()),
        // Caps Lock, media keys, bare modifiers, ... are not user input.
        _ => return None,
    };

    // BackTab carries SHIFT semantically even when the modifier bit is absent.
    let shift = shift || key.code == KeyCode::BackTab;
    Some(InputEvent::Key {
        text,
        key: payload(&name, ctrl, meta, shift),
    })
}

/// Map a character to `(name, insertable text)`.
fn translate_char(c: char, ctrl: bool, meta: bool) -> Option<(String, String)> {
    if c == ' ' {
        // Ctrl+Space and Alt+Space are commands, plain space inserts a space.
        let text = if ctrl || meta { "" } else { " " };
        return Some(("space".to_string(), text.to_string()));
    }

    if c.is_ascii_control() {
        // Terminals without modifier reporting deliver Ctrl+letter as the raw
        // C0 control byte; recover the letter when we know it was modified.
        if !ctrl && !meta {
            return None;
        }
        return match c {
            '\u{0}' => Some(("space".to_string(), String::new())),
            '\u{1}'..='\u{1a}' => {
                let letter = b'a' + (c as u8) - 1;
                Some((char::from(letter).to_string(), String::new()))
            }
            _ => None,
        };
    }

    if c.is_ascii() {
        if ctrl || meta {
            // Ctrl/Alt combinations are commands for the parent's readline,
            // not text to insert into the composer.
            return Some((c.to_string(), String::new()));
        }
        return Some((c.to_string(), c.to_string()));
    }

    // Non-ASCII (CJK, emoji, combining marks) is inserted verbatim; the JS side
    // identifies it by `str`, not by a printable `name`.
    Some(("text".to_string(), c.to_string()))
}

/// A command key: no insertable text, no modifiers.
fn command(name: &str) -> InputEvent {
    InputEvent::Key {
        text: String::new(),
        key: payload(name, false, false, false),
    }
}

fn payload(name: &str, ctrl: bool, meta: bool, shift: bool) -> KeyPayload {
    KeyPayload {
        name: name.to_string(),
        ctrl,
        meta,
        shift,
        sequence: None,
    }
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyEventState, MouseEvent};

    use super::*;

    fn key_event(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    fn translated(event: Event) -> (String, KeyPayload) {
        match translate(event) {
            Some(InputEvent::Key { text, key }) => (text, key),
            other => panic!("expected a key event, got {other:?}"),
        }
    }

    fn mouse(kind: MouseEventKind) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column: 3,
            row: 4,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn printable_ascii_maps_to_its_own_name() {
        let (text, key) = translated(key_event(KeyCode::Char('a'), KeyModifiers::NONE));
        assert_eq!(text, "a");
        assert_eq!(key.name, "a");
        assert!(!key.ctrl && !key.meta && !key.shift);
        assert_eq!(key.sequence, None);

        let (text, key) = translated(key_event(KeyCode::Char('7'), KeyModifiers::NONE));
        assert_eq!(text, "7");
        assert_eq!(key.name, "7");
    }

    #[test]
    fn shifted_letter_keeps_the_delivered_character() {
        let (text, key) = translated(key_event(KeyCode::Char('A'), KeyModifiers::SHIFT));
        assert_eq!(text, "A");
        assert_eq!(key.name, "A");
        assert!(key.shift);
        assert!(!key.ctrl);
    }

    #[test]
    fn space_is_named_space() {
        let (text, key) = translated(key_event(KeyCode::Char(' '), KeyModifiers::NONE));
        assert_eq!(text, " ");
        assert_eq!(key.name, "space");
    }

    #[test]
    fn ctrl_space_is_a_command() {
        let (text, key) = translated(key_event(KeyCode::Char(' '), KeyModifiers::CONTROL));
        assert_eq!(text, "");
        assert_eq!(key.name, "space");
        assert!(key.ctrl);
    }

    #[test]
    fn ctrl_letter_is_a_command_with_the_letter_as_name() {
        let (text, key) = translated(key_event(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(text, "");
        assert_eq!(key.name, "c");
        assert!(key.ctrl);
        assert!(!key.meta && !key.shift);
    }

    #[test]
    fn control_character_is_mapped_back_to_its_letter() {
        // Some terminals send Ctrl+C as the raw 0x03 control character.
        let (text, key) = translated(key_event(KeyCode::Char('\u{3}'), KeyModifiers::CONTROL));
        assert_eq!(text, "");
        assert_eq!(key.name, "c");
        assert!(key.ctrl);

        let (text, key) = translated(key_event(KeyCode::Char('\u{1a}'), KeyModifiers::CONTROL));
        assert_eq!(text, "");
        assert_eq!(key.name, "z");
    }

    #[test]
    fn alt_letter_is_a_meta_command() {
        let (text, key) = translated(key_event(KeyCode::Char('b'), KeyModifiers::ALT));
        assert_eq!(text, "");
        assert_eq!(key.name, "b");
        assert!(key.meta);
        assert!(!key.ctrl);
    }

    #[test]
    fn alt_enter_sets_meta_and_keeps_enter() {
        let (text, key) = translated(key_event(KeyCode::Enter, KeyModifiers::ALT));
        assert_eq!(text, "");
        assert_eq!(key.name, "enter");
        assert!(key.meta);
        assert!(!key.shift);
    }

    #[test]
    fn shift_enter_and_shift_tab() {
        let (text, key) = translated(key_event(KeyCode::Enter, KeyModifiers::SHIFT));
        assert_eq!(text, "");
        assert_eq!(key.name, "enter");
        assert!(key.shift);

        // crossterm reports Shift+Tab as BackTab; shift is implied.
        let (text, key) = translated(key_event(KeyCode::BackTab, KeyModifiers::NONE));
        assert_eq!(text, "");
        assert_eq!(key.name, "tab");
        assert!(key.shift);
    }

    #[test]
    fn function_keys_use_lowercase_names() {
        for number in 1..=12u8 {
            let (text, key) = translated(key_event(KeyCode::F(number), KeyModifiers::NONE));
            assert_eq!(text, "");
            assert_eq!(key.name, format!("f{number}"));
        }
    }

    #[test]
    fn backspace_and_delete_are_command_keys() {
        for (code, name) in [
            (KeyCode::Backspace, "backspace"),
            (KeyCode::Delete, "delete"),
            (KeyCode::Insert, "insert"),
        ] {
            let (text, key) = translated(key_event(code, KeyModifiers::NONE));
            assert_eq!(text, "");
            assert_eq!(key.name, name);
        }
    }

    #[test]
    fn navigation_and_enter_keys_use_readline_names() {
        for (code, name) in [
            (KeyCode::Esc, "escape"),
            (KeyCode::Home, "home"),
            (KeyCode::End, "end"),
            (KeyCode::Up, "up"),
            (KeyCode::Down, "down"),
            (KeyCode::Left, "left"),
            (KeyCode::Right, "right"),
            (KeyCode::PageUp, "pageup"),
            (KeyCode::PageDown, "pagedown"),
            (KeyCode::Enter, "enter"),
            (KeyCode::Tab, "tab"),
        ] {
            let (text, key) = translated(key_event(code, KeyModifiers::NONE));
            assert_eq!(text, "");
            assert_eq!(key.name, name);
        }
    }

    #[test]
    fn non_ascii_uses_the_text_name() {
        for character in ['中', '文', '😀', 'é'] {
            let (text, key) = translated(key_event(KeyCode::Char(character), KeyModifiers::NONE));
            assert_eq!(text, character.to_string());
            assert_eq!(key.name, "text");
            assert!(!key.ctrl && !key.meta && !key.shift);
        }
    }

    #[test]
    fn paste_is_one_key_with_verbatim_text() {
        let body = "第一行\n第二行\n第三行";
        let event = Event::Paste(body.to_string());
        let Some(InputEvent::Key { text, key }) = translate(event) else {
            panic!("expected a paste key");
        };
        assert_eq!(text, body);
        assert_eq!(key.name, "paste");
        assert!(!key.ctrl && !key.meta && !key.shift);
        // Exactly one message, no appended Enter, embedded newlines preserved.
        assert!(!text.ends_with("\r\n") && !text.ends_with("enter"));
    }

    #[test]
    fn mouse_wheel_maps_to_wheel_keys() {
        // 滚轮专名：JS 按行滚动（Codex 手感），不再与 PageUp/PageDown 混用。
        let (text, key) = translated(mouse(MouseEventKind::ScrollUp));
        assert_eq!(text, "");
        assert_eq!(key.name, "wheelup");
        assert!(!key.ctrl && !key.meta && !key.shift);

        let (text, key) = translated(mouse(MouseEventKind::ScrollDown));
        assert_eq!(text, "");
        assert_eq!(key.name, "wheeldown");
        assert!(!key.ctrl && !key.meta && !key.shift);
    }

    #[test]
    fn keyboard_page_keys_keep_their_own_names() {
        // 键盘 PageUp/PageDown 仍是 pageup/pagedown，和滚轮区分开。
        let (text, key) = translated(key_event(KeyCode::PageUp, KeyModifiers::NONE));
        assert_eq!(text, "");
        assert_eq!(key.name, "pageup");

        let (text, key) = translated(key_event(KeyCode::PageDown, KeyModifiers::NONE));
        assert_eq!(text, "");
        assert_eq!(key.name, "pagedown");
    }

    #[test]
    fn other_mouse_events_are_ignored() {
        for kind in [
            MouseEventKind::Moved,
            MouseEventKind::Down(crossterm::event::MouseButton::Left),
            MouseEventKind::Up(crossterm::event::MouseButton::Left),
            MouseEventKind::ScrollLeft,
            MouseEventKind::ScrollRight,
        ] {
            assert_eq!(translate(mouse(kind)), None);
        }
    }

    #[test]
    fn resize_maps_to_a_resize_event() {
        assert_eq!(
            translate(Event::Resize(120, 40)),
            Some(InputEvent::Resize {
                columns: 120,
                rows: 40
            })
        );
    }

    #[test]
    fn release_is_ignored_and_repeat_is_kept() {
        let release = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        assert_eq!(translate(Event::Key(release)), None);

        let repeat = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        );
        assert!(translate(Event::Key(repeat)).is_some());
    }

    #[test]
    fn focus_events_and_bare_modifiers_are_ignored() {
        assert_eq!(translate(Event::FocusGained), None);
        assert_eq!(translate(Event::FocusLost), None);
        assert_eq!(
            translate(Event::Key(KeyEvent::new(
                KeyCode::Null,
                KeyModifiers::NONE
            ))),
            None
        );
        // A bare modifier press (only visible with keyboard enhancement) must
        // not reach the parent.
        assert_eq!(
            translate(Event::Key(KeyEvent::new(
                KeyCode::Modifier(crossterm::event::ModifierKeyCode::LeftShift),
                KeyModifiers::NONE
            ))),
            None
        );
    }

    #[test]
    fn state_field_does_not_change_translation() {
        let mut event = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE);
        event.kind = KeyEventKind::Press;
        event.state = KeyEventState::KEYPAD;
        let (text, key) = translated(Event::Key(event));
        assert_eq!(text, "x");
        assert_eq!(key.name, "x");
    }
}
