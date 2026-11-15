//! crossterm 事件 → fd4 `key`/`resize` 映射契约（协议文档 §3）。
//!
//! 直接构造 `crossterm::event::Event`，不读真实终端：
//!
//! * 可打印 ASCII 用自身字符做 `name`/`str`，空格用 `"space"`；
//! * Ctrl/Alt 是命令（`str` 为空）；Enter/Tab/方向键等用 Node readline 小写名；
//! * 粘贴只产生一条 `name:"paste"` 的 key，正文（含换行）原样保留，绝不追加 Enter；
//! * 非 ASCII（中文/emoji）一律 `name:"text"`，`str` 为原字符；
//! * 滚轮上/下用独立名 `wheelup`/`wheeldown`（键盘 PageUp/PageDown 仍是 `pageup`/`pagedown`）；
//!   Resize 原样透传尺寸；Release 被忽略。

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use dsh_ask_ui::input::{self, InputEvent};
use dsh_ask_ui::protocol::KeyPayload;

/// 构造一次普通按键（Kind=Press）。
fn key_event(code: KeyCode, modifiers: KeyModifiers) -> Event {
    Event::Key(KeyEvent::new(code, modifiers))
}

/// 期望事件被翻译成一条 key 消息，返回 (可插入文本, key 载荷)。
fn expect_key(event: Event) -> (String, KeyPayload) {
    match input::translate(event) {
        Some(InputEvent::Key { text, key }) => (text, key),
        other => panic!("期望一条 key 事件，实际 {other:?}（契约 §3：每按键一条 key 消息）"),
    }
}

/// 期望事件被静默忽略。
fn expect_none(event: Event) {
    assert_eq!(
        input::translate(event),
        None,
        "该事件必须被忽略，不得转发给父进程（避免 readline 收到噪声）"
    );
}

/// 构造一个滚轮/鼠标事件，坐标固定（不依赖真实终端）。
fn mouse(kind: MouseEventKind) -> Event {
    Event::Mouse(MouseEvent {
        kind,
        column: 7,
        row: 9,
        modifiers: KeyModifiers::NONE,
    })
}

#[test]
fn printable_ascii_maps_to_its_own_character() {
    let (text, key) = expect_key(key_event(KeyCode::Char('a'), KeyModifiers::NONE));

    // 契约 §3：可打印字符 name 是单个字符，str 同字符，可直接插入。
    assert_eq!(text, "a", "普通字符的 str 必须可直接插入");
    assert_eq!(key.name, "a", "ASCII 字符的 name 就是该字符");
    assert!(!key.ctrl, "普通字符不得带 ctrl");
    assert!(!key.meta, "普通字符不得带 meta");
    assert!(!key.shift, "无 Shift 修饰时 shift=false");
    assert_eq!(key.sequence, None, "sequence 可选，默认不附带原始序列");
}

#[test]
fn space_uses_the_readline_name() {
    let (text, key) = expect_key(key_event(KeyCode::Char(' '), KeyModifiers::NONE));

    // 契约 §3：空格 name 为 "space"，str 为 " "。
    assert_eq!(key.name, "space");
    assert_eq!(text, " ");
    assert!(!key.ctrl && !key.meta && !key.shift);
}

#[test]
fn ctrl_letter_is_a_command_with_the_letter_name() {
    let (text, key) = expect_key(key_event(KeyCode::Char('c'), KeyModifiers::CONTROL));

    // 契约 §3：Ctrl 组合是命令键，str 为空，name 保留原字母。
    assert_eq!(text, "", "Ctrl 组合不得插入文本");
    assert_eq!(key.name, "c", "Ctrl+字母的 name 保留原字母");
    assert!(key.ctrl, "必须带 ctrl=true");
    assert!(!key.meta, "不得带 meta");
    assert!(!key.shift, "不得带 shift");
}

#[test]
fn alt_and_shift_enter_keep_modifiers() {
    // Alt+Enter：name 仍是 enter，meta=true（JS 用它做换行/提交区分）。
    let (text, key) = expect_key(key_event(KeyCode::Enter, KeyModifiers::ALT));
    assert_eq!(text, "");
    assert_eq!(key.name, "enter");
    assert!(key.meta, "Alt+Enter 必须带 meta=true");
    assert!(!key.ctrl && !key.shift);

    // Shift+Enter：name 仍是 enter，shift=true。
    let (text, key) = expect_key(key_event(KeyCode::Enter, KeyModifiers::SHIFT));
    assert_eq!(text, "");
    assert_eq!(key.name, "enter");
    assert!(key.shift, "Shift+Enter 必须带 shift=true");
    assert!(!key.meta && !key.ctrl);
}

#[test]
fn backtab_is_shift_tab() {
    let (text, key) = expect_key(key_event(KeyCode::BackTab, KeyModifiers::NONE));

    // 契约 §3：Shift+Tab 在终端里报为 BackTab，name 为 "tab" 且 shift=true。
    assert_eq!(text, "");
    assert_eq!(key.name, "tab", "BackTab 的 name 必须是 tab");
    assert!(key.shift, "BackTab 语义上等价 Shift+Tab，必须带 shift=true");
    assert!(!key.ctrl && !key.meta);
}

#[test]
fn function_keys_use_lowercase_names() {
    // 契约 §3：F1–F12 用 f1…f12 小写名，str 为空。
    for number in 1..=12u8 {
        let (text, key) = expect_key(key_event(KeyCode::F(number), KeyModifiers::NONE));
        assert_eq!(text, "", "功能键不得插入文本");
        assert_eq!(key.name, format!("f{number}"), "F{number} 必须映射为 f{number}");
    }

    // 显式确认题目要求的 F1。
    let (_, key) = expect_key(key_event(KeyCode::F(1), KeyModifiers::NONE));
    assert_eq!(key.name, "f1");
}

#[test]
fn navigation_and_editing_keys_use_readline_names() {
    for (code, expected) in [
        (KeyCode::Backspace, "backspace"),
        (KeyCode::Delete, "delete"),
        (KeyCode::Home, "home"),
        (KeyCode::End, "end"),
        (KeyCode::PageUp, "pageup"),
        (KeyCode::PageDown, "pagedown"),
        (KeyCode::Up, "up"),
        (KeyCode::Down, "down"),
        (KeyCode::Left, "left"),
        (KeyCode::Right, "right"),
    ] {
        let (text, key) = expect_key(key_event(code, KeyModifiers::NONE));
        // 契约 §3：命令键 name 使用 Node readline 小写名，str 为空。
        assert_eq!(text, "", "{expected} 不得插入文本");
        assert_eq!(key.name, expected, "命令键必须使用 Node readline 小写名");
        assert!(!key.ctrl && !key.meta && !key.shift, "{expected} 不得带修饰位");
    }
}

#[test]
fn paste_is_exactly_one_key_with_verbatim_text() {
    // 契约 §3：Event::Paste → 恰好一条 key，name="paste"，正文原样，绝不追加 Enter。
    let body = "a\n中😀";
    let (text, key) = expect_key(Event::Paste(body.to_string()));

    assert_eq!(text, body, "粘贴正文必须原样保留（含换行/中文/emoji）");
    assert_eq!(key.name, "paste");
    assert!(!key.ctrl && !key.meta && !key.shift);
    // 换行原样保留，且没有被追加的 Enter。
    assert_eq!(text.matches('\n').count(), 1, "粘贴内部的换行不得被丢弃或改写");
    assert!(!text.ends_with("enter"), "粘贴不得自动追加 Enter（契约 §3）");
}

#[test]
fn non_ascii_characters_use_the_text_name() {
    for character in ['中', '😀'] {
        let (text, key) = expect_key(key_event(KeyCode::Char(character), KeyModifiers::NONE));

        // 契约 §3：非 ASCII 用 name="text"，str 为完整字符。
        assert_eq!(text, character.to_string(), "非 ASCII 字符的 str 必须是原字符");
        assert_eq!(key.name, "text", "非 ASCII 一律 name=\"text\"");
        assert!(!key.ctrl && !key.meta && !key.shift);
    }
}

#[test]
fn release_events_are_ignored() {
    // 部分终端同时上报 press/release；release 必须静默丢弃，避免一次按键两条消息。
    for code in [KeyCode::Char('a'), KeyCode::Enter, KeyCode::Up] {
        let release = KeyEvent::new_with_kind(code, KeyModifiers::NONE, KeyEventKind::Release);
        expect_none(Event::Key(release));
    }
}

#[test]
fn mouse_wheel_maps_to_wheel_keys() {
    // 契约 §3：滚轮上滚 → wheelup，下滚 → wheeldown（JS 每格滚动 1 行）。
    let (text, key) = expect_key(mouse(MouseEventKind::ScrollUp));
    assert_eq!(text, "");
    assert_eq!(key.name, "wheelup", "上滚必须是独立的 wheelup");
    assert!(!key.ctrl && !key.meta && !key.shift);

    let (text, key) = expect_key(mouse(MouseEventKind::ScrollDown));
    assert_eq!(text, "");
    assert_eq!(key.name, "wheeldown", "下滚必须是独立的 wheeldown");
    assert!(!key.ctrl && !key.meta && !key.shift);
}

#[test]
fn keyboard_page_keys_do_not_use_wheel_names() {
    // 键盘 PageUp/PageDown 与滚轮解耦：仍传 pageup/pagedown，JS 翻页语义不变。
    for (code, expected) in [(KeyCode::PageUp, "pageup"), (KeyCode::PageDown, "pagedown")] {
        let (text, key) = expect_key(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
        assert_eq!(text, "");
        assert_eq!(key.name, expected, "键盘 {code:?} 必须保持 {expected}");
        assert!(!key.ctrl && !key.meta && !key.shift);
    }
}

#[test]
fn mouse_clicks_and_moves_are_ignored() {
    // 契约 §3：除滚轮外其他鼠标事件一律忽略。
    for kind in [
        MouseEventKind::Moved,
        MouseEventKind::Down(MouseButton::Left),
        MouseEventKind::Up(MouseButton::Left),
        MouseEventKind::ScrollLeft,
        MouseEventKind::ScrollRight,
    ] {
        expect_none(mouse(kind));
    }
}

#[test]
fn resize_passes_through_columns_and_rows() {
    // 契约 §3：真实尺寸变化 → {type:"resize",columns,rows}，原样透传。
    assert_eq!(
        input::translate(Event::Resize(100, 30)),
        Some(InputEvent::Resize {
            columns: 100,
            rows: 30
        }),
        "Resize(100,30) 必须原样透传列/行数"
    );
}
