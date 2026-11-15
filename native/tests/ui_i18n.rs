//! `view.ui` display-layer i18n contract (native side).
//!
//! The JS worker resolves the language and sends already-translated strings in
//! the optional `view.ui` object; this layer only lays them out. The tests pin
//! three guarantees:
//!
//! 1. an old view **without** `ui` renders exactly the strings this layer
//!    hard-coded before the field existed (byte-for-byte compatibility);
//! 2. Chinese and English `ui` objects replace every runtime string
//!    (placeholder, empty list, search placeholder, hint fallback,
//!    back-to-bottom variants, modal default titles);
//! 3. a missing/partial/`null` `ui` falls back per field to the built-in
//!    default, and narrow windows never let a translated string overflow.
//!
//! Everything is rendered off-screen through ratatui `TestBackend`; no TTY, no
//! timing, no environment/locale reads.

use dsh_ask_ui::protocol::{Inbound, Message, Modal, Ui, View};
use dsh_ask_ui::render;
use dsh_ask_ui::text;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

// ---------------------------------------------------------------------------
// Off-screen rendering helpers (same read-back strategy as render_snapshot.rs)
// ---------------------------------------------------------------------------

fn render(view: &View, width: u16, height: u16) -> Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("TestBackend terminal");
    terminal
        .draw(|frame| render::draw(frame, view))
        .expect("render::draw must not fail");
    terminal.backend().buffer().clone()
}

/// Logical row text: wide cells' reset continuations are skipped so the string
/// matches what a terminal shows and `text::display_width` is the cell count.
fn row_text(buffer: &Buffer, y: u16) -> String {
    let mut out = String::new();
    let mut x = buffer.area.left();
    while x < buffer.area.right() {
        let symbol = buffer[(x, y)].symbol();
        out.push_str(symbol);
        let advance = u16::try_from(UnicodeWidthStr::width(symbol))
            .unwrap_or(1)
            .max(1);
        x = x.saturating_add(advance);
    }
    out
}

fn rows(buffer: &Buffer) -> Vec<String> {
    (buffer.area.top()..buffer.area.bottom())
        .map(|y| row_text(buffer, y))
        .collect()
}

fn parse_view(view_json: &str) -> View {
    let line = format!(r#"{{"type":"render","view":{view_json}}}"#);
    let Inbound::Render(view) = Inbound::parse(&line).expect("合法 render 行") else {
        panic!("expected render");
    };
    view
}

fn assert_rows_fit(buffer: &Buffer) {
    let width = usize::from(buffer.area.width);
    for (y, row) in rows(buffer).iter().enumerate() {
        assert!(
            text::display_width(row) <= width,
            "第 {y} 行显示宽度 {} 超过屏宽 {width}: {row:?}",
            text::display_width(row)
        );
    }
}

fn assert_some_row(rows: &[String], needle: &str) {
    assert!(
        rows.iter().any(|row| row.contains(needle)),
        "画面里找不到 {needle:?}；当前画面：{rows:#?}"
    );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn base_view() -> View {
    View {
        project: "dsh-local-cli".to_string(),
        cwd: "/Users/example/workspace/dsh-local-cli".to_string(),
        session_title: "Fix retry logic".to_string(),
        session_id: "session-1".to_string(),
        model: "deepseek-v4-flash".to_string(),
        status: "ready".to_string(),
        ..View::default()
    }
}

fn with_ui(ui: Ui) -> View {
    View { ui, ..base_view() }
}

/// Composer is empty, so the placeholder row is drawn.
fn empty_composer(ui: Ui) -> View {
    with_ui(ui)
}

/// Transcript scrolled up, so the gap row carries the back-to-bottom control.
fn scrolled(ui: Ui) -> View {
    View {
        ui,
        scroll_offset: 3,
        messages: vec![Message {
            role: "assistant".to_string(),
            text: "早先的消息".to_string(),
        }],
        ..base_view()
    }
}

/// Command popup with no matching items: the empty-list row is drawn.
fn commands_empty(ui: Ui) -> View {
    View {
        ui,
        modal: Some(Modal {
            kind: "commands".to_string(),
            query: "/zzz".to_string(),
            ..Modal::default()
        }),
        ..base_view()
    }
}

fn sessions_page(ui: Ui) -> View {
    View {
        ui,
        modal: Some(Modal {
            kind: "sessions".to_string(),
            ..Modal::default()
        }),
        ..base_view()
    }
}

fn help_page(ui: Ui) -> View {
    View {
        ui,
        modal: Some(Modal {
            kind: "help".to_string(),
            ..Modal::default()
        }),
        ..base_view()
    }
}

fn hint_blank(ui: Ui) -> View {
    with_ui(ui)
}

fn zh_ui() -> Ui {
    Ui {
        placeholder: "输入内容，交给 dsh-ask".to_string(),
        empty_list: "没有匹配项".to_string(),
        search_placeholder: "输入以搜索会话".to_string(),
        hint_fallback: "? 查看快捷键".to_string(),
        back_to_bottom: vec![
            "↓ 回到最新 · esc".to_string(),
            "↓ 最新 · esc".to_string(),
            "↓ 最新".to_string(),
            "↓".to_string(),
        ],
        modal_title_help: "帮助 · 按键与命令".to_string(),
        modal_title_sessions: "选择要切换的会话".to_string(),
    }
}

fn en_ui() -> Ui {
    Ui {
        placeholder: "Ask dsh-ask to do anything".to_string(),
        empty_list: "No matches".to_string(),
        search_placeholder: "Type to search sessions".to_string(),
        hint_fallback: "? for shortcuts".to_string(),
        back_to_bottom: vec![
            "↓ Back to bottom · esc".to_string(),
            "↓ Bottom · esc".to_string(),
            "↓ Bottom".to_string(),
            "↓".to_string(),
        ],
        modal_title_help: "Help · keys & commands".to_string(),
        modal_title_sessions: "Switch session".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 1) No `ui`: the pre-i18n strings are preserved
// ---------------------------------------------------------------------------

#[test]
fn view_without_ui_keeps_the_pre_i18n_strings() {
    // 旧 view 解析后 ui 必须是内置默认，且默认值就是 i18n 之前的文案。
    let old_view = parse_view("{}");
    assert_eq!(old_view.ui, Ui::default(), "旧 view 必须走内置默认");
    assert_eq!(old_view.ui.placeholder, "Ask dsh-ask to do anything");

    let empty = rows(&render(&empty_composer(Ui::default()), 80, 24));
    assert_some_row(&empty, "Ask dsh-ask to do anything");
    assert_some_row(&empty, "? for shortcuts");

    let scrolled_rows = rows(&render(&scrolled(Ui::default()), 80, 24));
    assert_some_row(&scrolled_rows, "↓ Back to bottom · esc");

    let commands = rows(&render(&commands_empty(Ui::default()), 80, 24));
    assert_some_row(&commands, "no matches");

    let sessions = rows(&render(&sessions_page(Ui::default()), 80, 24));
    assert!(
        sessions[0].contains("选择会话"),
        "sessions 首行: {:?}",
        sessions[0]
    );
    assert_some_row(&sessions, "Type to search");

    let help = rows(&render(&help_page(Ui::default()), 80, 24));
    assert!(
        help[0].contains("帮助 · 按键与命令"),
        "help 首行: {:?}",
        help[0]
    );
}

#[test]
fn absent_null_and_explicit_default_ui_are_byte_identical() {
    // 与 `base_view()` 相同的非 ui 字段，只是 `ui` 的三种线上形态。
    let fields = concat!(
        r#""project":"dsh-local-cli","cwd":"/Users/example/workspace/dsh-local-cli","#,
        r#""sessionTitle":"Fix retry logic","sessionId":"session-1","#,
        r#""model":"deepseek-v4-flash","status":"ready""#,
    );
    let variants = [
        parse_view(&format!("{{{fields}}}")),
        parse_view(&format!("{{{fields},\"ui\":null}}")),
        parse_view(&format!("{{{fields},\"ui\":{{}}}}")),
        with_ui(Ui::default()),
    ];
    let reference = with_ui(Ui::default());
    for (index, view) in variants.iter().enumerate() {
        assert_eq!(
            view, &reference,
            "variant {index} 的 view 必须与内置默认完全一致"
        );
        for (width, height) in [(80u16, 24u16), (40, 12), (20, 6)] {
            let frame = rows(&render(view, width, height));
            let expected = rows(&render(&reference, width, height));
            assert_eq!(frame, expected, "variant {index} @ {width}x{height}");
        }
    }
}

// ---------------------------------------------------------------------------
// 2) Chinese / English `ui` replaces every runtime string
// ---------------------------------------------------------------------------

#[test]
fn chinese_ui_replaces_every_runtime_string() {
    let ui = zh_ui();

    let empty = rows(&render(&empty_composer(ui.clone()), 80, 24));
    assert_some_row(&empty, "输入内容，交给 dsh-ask");
    assert_some_row(&empty, "? 查看快捷键");

    let scrolled_rows = rows(&render(&scrolled(ui.clone()), 80, 24));
    assert_some_row(&scrolled_rows, "↓ 回到最新 · esc");

    let commands = rows(&render(&commands_empty(ui.clone()), 80, 24));
    assert_some_row(&commands, "没有匹配项");

    let sessions = rows(&render(&sessions_page(ui.clone()), 80, 24));
    assert!(
        sessions[0].contains("选择要切换的会话"),
        "sessions 首行: {:?}",
        sessions[0]
    );
    assert_some_row(&sessions, "输入以搜索会话");

    let help = rows(&render(&help_page(ui), 80, 24));
    assert!(
        help[0].contains("帮助 · 按键与命令"),
        "help 首行: {:?}",
        help[0]
    );
}

#[test]
fn english_ui_replaces_every_runtime_string() {
    let ui = en_ui();

    let empty = rows(&render(&empty_composer(ui.clone()), 80, 24));
    assert_some_row(&empty, "Ask dsh-ask to do anything");
    assert_some_row(&empty, "? for shortcuts");

    let scrolled_rows = rows(&render(&scrolled(ui.clone()), 80, 24));
    assert_some_row(&scrolled_rows, "↓ Back to bottom · esc");

    let commands = rows(&render(&commands_empty(ui.clone()), 80, 24));
    assert_some_row(&commands, "No matches");

    let sessions = rows(&render(&sessions_page(ui.clone()), 80, 24));
    assert!(
        sessions[0].contains("Switch session"),
        "sessions 首行: {:?}",
        sessions[0]
    );
    assert_some_row(&sessions, "Type to search sessions");

    let help = rows(&render(&help_page(ui), 80, 24));
    assert!(
        help[0].contains("Help · keys & commands"),
        "help 首行: {:?}",
        help[0]
    );
}

#[test]
fn non_blank_hint_wins_over_the_ui_fallback() {
    let mut view = hint_blank(zh_ui());
    view.hint = "Enter 发送 · Esc 取消".to_string();
    let rows = rows(&render(&view, 80, 24));
    assert_some_row(&rows, "Enter 发送 · Esc 取消");
    assert!(
        !rows.iter().any(|row| row.contains("? 查看快捷键")),
        "有 view.hint 时不得使用 hintFallback: {rows:#?}"
    );
}

#[test]
fn explicit_modal_title_wins_over_the_ui_default_title() {
    let mut view = sessions_page(zh_ui());
    if let Some(modal) = view.modal.as_mut() {
        modal.title = "父进程给的标题".to_string();
    }
    let rows = rows(&render(&view, 80, 24));
    assert!(
        rows[0].contains("父进程给的标题"),
        "显式 title 优先: {:?}",
        rows[0]
    );
    assert!(
        !rows.iter().any(|row| row.contains("选择要切换的会话")),
        "显式 title 存在时不得出现默认标题"
    );
}

// ---------------------------------------------------------------------------
// 3) Partial / blank / null `ui` falls back per field
// ---------------------------------------------------------------------------

#[test]
fn partial_ui_falls_back_per_field() {
    let view = parse_view(r#"{"ui":{"placeholder":"type here"}}"#);
    let empty = rows(&render(&view, 80, 24));
    assert_some_row(&empty, "type here");

    // 其余字段逐项保持原默认。
    let defaults = Ui::default();
    let commands = rows(&render(
        &View {
            ui: view.ui.clone(),
            modal: Some(Modal {
                kind: "commands".to_string(),
                ..Modal::default()
            }),
            ..base_view()
        },
        80,
        24,
    ));
    assert_some_row(&commands, &defaults.empty_list);
}

#[test]
fn blank_ui_strings_fall_back_to_the_builtin_defaults() {
    let blank = Ui {
        placeholder: String::new(),
        empty_list: "   ".to_string(),
        search_placeholder: String::new(),
        hint_fallback: String::new(),
        back_to_bottom: Vec::new(),
        modal_title_help: String::new(),
        modal_title_sessions: String::new(),
    };
    let defaults = Ui::default();

    let empty = rows(&render(&with_ui(blank.clone()), 80, 24));
    assert_some_row(&empty, &defaults.placeholder);
    assert_some_row(&empty, &defaults.hint_fallback);

    let scrolled_rows = rows(&render(&scrolled(blank.clone()), 80, 24));
    assert_some_row(&scrolled_rows, &defaults.back_to_bottom[0]);

    let sessions = rows(&render(&sessions_page(blank), 80, 24));
    assert!(sessions[0].contains(&defaults.modal_title_sessions));
    assert_some_row(&sessions, &defaults.search_placeholder);
}

// ---------------------------------------------------------------------------
// 4) Narrow windows: translated (wide-glyph) strings never overflow
// ---------------------------------------------------------------------------

#[test]
fn narrow_windows_with_translated_ui_never_overflow() {
    let ui = zh_ui();
    let scenarios: Vec<(&str, View)> = vec![
        ("empty", empty_composer(ui.clone())),
        ("scrolled", scrolled(ui.clone())),
        ("commands", commands_empty(ui.clone())),
        ("sessions", sessions_page(ui.clone())),
        ("help", help_page(ui)),
    ];
    for width in 0..=24u16 {
        for height in 0..=8u16 {
            for (label, view) in &scenarios {
                let buffer = render(view, width, height);
                assert!(
                    buffer.area.width == width && buffer.area.height == height,
                    "{label} {width}x{height}"
                );
                assert_rows_fit(&buffer);
            }
        }
    }
}

#[test]
fn long_translated_strings_are_truncated_instead_of_overflowing() {
    let long = Ui {
        placeholder: "这是一段很长很长的中文占位文案，用来验证窄窗口下会被截断而不会越界"
            .to_string(),
        empty_list: "这是一段很长很长的空列表提示文案".to_string(),
        search_placeholder: "这是一段很长很长的搜索占位文案".to_string(),
        hint_fallback: "这是一段很长很长的快捷键提示文案".to_string(),
        back_to_bottom: vec![
            "↓ 回到最新的一条消息 · esc".to_string(),
            "↓ 回到底部".to_string(),
        ],
        modal_title_help: "帮助 · 非常长的按键与命令说明".to_string(),
        modal_title_sessions: "选择要切换的会话 · 非常长的标题".to_string(),
    };
    for width in 1..=30u16 {
        for (label, view) in [
            ("empty", empty_composer(long.clone())),
            ("scrolled", scrolled(long.clone())),
            ("commands", commands_empty(long.clone())),
            ("sessions", sessions_page(long.clone())),
            ("help", help_page(long.clone())),
        ] {
            let buffer = render(&view, width, 12);
            assert_rows_fit(&buffer);
            // 编译期标签仅用于失败信息；此处断言已由 assert_rows_fit 覆盖。
            let _ = label;
        }
    }
}

#[test]
fn back_to_bottom_uses_the_longest_variant_that_fits() {
    let ui = zh_ui();
    let long = &ui.back_to_bottom[0];
    let medium = &ui.back_to_bottom[1];
    let short = &ui.back_to_bottom[2];
    let arrow = &ui.back_to_bottom[3];

    // 宽度恰好等于某档文案时该档可用，更宽时选最长可用档。
    for (width, expected) in [
        (60u16, long.as_str()),
        (text::display_width(long) as u16, long.as_str()),
        ((text::display_width(long) - 1) as u16, medium.as_str()),
        ((text::display_width(medium) - 1) as u16, short.as_str()),
        ((text::display_width(short) - 1) as u16, arrow.as_str()),
    ] {
        let rows = rows(&render(&scrolled(ui.clone()), width, 12));
        assert_some_row(&rows, expected);
    }
}

// ---------------------------------------------------------------------------
// 5) Chinese `ui` on a realistic frame: transcript/hint/chrome stay intact
// ---------------------------------------------------------------------------

#[test]
fn chinese_ui_keeps_the_rest_of_the_frame_intact() {
    let mut view = scrolled(zh_ui());
    view.messages = vec![
        Message {
            role: "user".to_string(),
            text: "帮我看看这个重试逻辑".to_string(),
        },
        Message {
            role: "assistant".to_string(),
            text: "好的，先看实现".to_string(),
        },
    ];
    view.input = "继续".to_string();
    view.input_cursor = 2;
    let rows = rows(&render(&view, 80, 24));
    assert_some_row(&rows, "帮我看看这个重试逻辑");
    assert_some_row(&rows, "好的，先看实现");
    assert_some_row(&rows, "继续");
    assert_some_row(&rows, "↓ 回到最新 · esc");
    assert_some_row(&rows, "? 查看快捷键");
}
