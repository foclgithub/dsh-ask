//! `view.statusLines` rendering contract:
//!
//! * a legacy view without `statusLines` keeps the old single
//!   `{model} · {project} · {sessionTitle}[ · {status}]` row;
//! * one or two parent-formatted rows are drawn *below* the composer block and
//!   *above* the hint row, each with two columns free on both sides;
//! * narrow terminals truncate on grapheme boundaries (CJK never straddles a
//!   cell) and shrink the block to one row before the input suffers;
//! * control characters / escape sequences from the parent are scrubbed, never
//!   reaching the terminal buffer.
//!
//! Everything is rendered off-screen through ratatui `TestBackend`; no TTY, no
//! timing, no network.

use dsh_ask_ui::protocol::{Message, View};
use dsh_ask_ui::render;
use dsh_ask_ui::text;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Color;
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

// ---------------------------------------------------------------------------
// Helpers (same read-back strategy as `render_snapshot.rs`)
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

/// Rows painted with the composer grey background.
fn composer_rows(buffer: &Buffer) -> Vec<u16> {
    (buffer.area.top()..buffer.area.bottom())
        .filter(|&y| buffer[(buffer.area.left(), y)].bg == Color::Rgb(38, 38, 38))
        .collect()
}

fn composer_span(buffer: &Buffer) -> (u16, u16) {
    let rows = composer_rows(buffer);
    assert!(!rows.is_empty(), "composer grey block must be painted");
    for pair in rows.windows(2) {
        assert_eq!(pair[1], pair[0] + 1, "grey block must be contiguous: {rows:?}");
    }
    (rows[0], *rows.last().expect("non-empty"))
}

fn assert_rows_fit(buffer: &Buffer) {
    let width = usize::from(buffer.area.width);
    for (y, row) in rows(buffer).iter().enumerate() {
        assert!(
            text::display_width(row) <= width,
            "row {y} exceeds width {width}: {row:?}"
        );
    }
}

fn base_view(status_lines: &[&str]) -> View {
    View {
        project: "dsh-local-cli".to_string(),
        cwd: "/Users/example/workspace/dsh-local-cli".to_string(),
        session_title: "Fix retry logic".to_string(),
        session_id: "7a9c76c0".to_string(),
        model: "deepseek-v4-flash".to_string(),
        status: "ready".to_string(),
        status_lines: status_lines.iter().map(|line| (*line).to_string()).collect(),
        messages: vec![Message {
            role: "assistant".to_string(),
            text: "先看实现".to_string(),
        }],
        input: "继续".to_string(),
        input_cursor: 2,
        attachments: Vec::new(),
        hint: "Enter 发送 · Alt+Enter 换行".to_string(),
        ui: Default::default(),
        scroll_offset: 0,
        modal: None,
    }
}

// ---------------------------------------------------------------------------
// 1) Legacy view: the field is absent, the old row is unchanged
// ---------------------------------------------------------------------------

#[test]
fn legacy_view_without_status_lines_draws_the_old_row() {
    let view = base_view(&[]);
    let buffer = render(&view, 80, 24);
    let rows = rows(&buffer);
    let (_, composer_bottom) = composer_span(&buffer);

    let status_y = usize::from(composer_bottom) + 1;
    let hint_y = status_y + 1;
    assert_eq!(hint_y, rows.len() - 1, "hint must stick to the last row");
    assert!(
        rows[status_y].contains(&view.model),
        "legacy status row must keep the model: {:?}",
        rows[status_y]
    );
    assert!(
        rows[status_y].contains(&view.project),
        "legacy status row must keep the project: {:?}",
        rows[status_y]
    );
    assert!(
        rows[status_y].starts_with("  "),
        "legacy status row keeps the 2-column inset: {:?}",
        rows[status_y]
    );
    assert!(
        rows[hint_y].contains(&view.hint),
        "hint row must still be drawn: {:?}",
        rows[hint_y]
    );
    assert_rows_fit(&buffer);
}

// ---------------------------------------------------------------------------
// 2) Two parent rows: below the composer, above the hint, two-column insets
// ---------------------------------------------------------------------------

#[test]
fn two_status_lines_sit_between_composer_and_hint() {
    let view = base_view(&[
        "deepseek-v4 · high · acceptEdits",
        "ctx 42% (8.4k/20k) · tok 12.3k · cache 88% · 3轮/7步 · 18 tok/s",
    ]);
    let buffer = render(&view, 100, 24);
    let rows = rows(&buffer);
    let (_, composer_bottom) = composer_span(&buffer);

    let first = usize::from(composer_bottom) + 1;
    let second = first + 1;
    let hint_y = second + 1;
    assert_eq!(hint_y, rows.len() - 1, "hint must stick to the last row");
    assert!(
        rows[first].contains("deepseek-v4 · high · acceptEdits"),
        "第一行状态必须完整显示: {:?}",
        rows[first]
    );
    assert!(
        rows[second].contains("ctx 42%"),
        "第二行状态必须完整显示: {:?}",
        rows[second]
    );
    assert!(
        rows[second].contains("18 tok/s"),
        "第二行状态必须完整显示: {:?}",
        rows[second]
    );
    for y in [first, second] {
        assert!(
            rows[y].starts_with("  "),
            "每行状态左侧必须有 2 列缩进: {:?}",
            rows[y]
        );
        assert!(
            !rows[y].trim().is_empty(),
            "状态行不能是空行"
        );
    }
    // The composer block itself (and its padding rows) keeps its grey surface.
    for y in composer_rows(&buffer) {
        assert_eq!(
            buffer[(0, y)].bg,
            Color::Rgb(38, 38, 38),
            "composer row {y} must keep the grey padding block"
        );
    }
    for y in [first, second] {
        assert_ne!(
            buffer[(0, y as u16)].bg,
            Color::Rgb(38, 38, 38),
            "status row {y} must be outside the composer block"
        );
    }
    assert_rows_fit(&buffer);
}

#[test]
fn parent_rows_replace_the_legacy_composite_row() {
    let view = base_view(&["deepseek-v4 · high", "ctx 42% · tok 12.3k"]);
    let buffer = render(&view, 80, 24);
    let rows = rows(&buffer);
    let (_, composer_bottom) = composer_span(&buffer);

    // Exactly two rows carry status content; no extra legacy row duplicates
    // the model/project/session title a second time.
    let mut status_rows = 0;
    for y in (usize::from(composer_bottom) + 1)..rows.len() {
        if rows[y].contains("deepseek-v4 · high") || rows[y].contains("ctx 42%") {
            status_rows += 1;
        }
    }
    assert_eq!(status_rows, 2, "statusLines 存在时不得再画旧的三段式状态行");
}

// ---------------------------------------------------------------------------
// 3) Narrow window: shrink to one row, keep the input, truncate safely
// ---------------------------------------------------------------------------

#[test]
fn narrow_window_keeps_input_and_shrinks_status_to_one_row() {
    let view = base_view(&[
        "deepseek-v4 · high · acceptEdits",
        "ctx 42% · tok 12.3k · cache 88% · 3轮/7步 · 18 tok/s",
    ]);
    let buffer = render(&view, 40, 6);
    let rows = rows(&buffer);
    let (composer_top, composer_bottom) = composer_span(&buffer);

    // Input block survived: the `›` prompt row and its grey padding are there.
    assert!(
        rows[usize::from(composer_top)..=usize::from(composer_bottom)]
            .iter()
            .any(|row| row.contains('›')),
        "窄窗必须保住输入块: {rows:#?}"
    );
    // Two-row status shrank to one row: the identity row survives, the metrics
    // row is dropped, and nothing draws over the composer rows.
    let status_y = usize::from(composer_bottom) + 1;
    assert_eq!(status_y, rows.len() - 1, "6 行窗口只剩一行状态");
    assert!(
        rows[status_y].contains("deepseek-v4"),
        "缩到一行时保留第一行（模型/effort/权限）: {:?}",
        rows[status_y]
    );
    assert!(
        !rows[status_y].contains("ctx 42%"),
        "第二行应在空间不足时先丢: {:?}",
        rows[status_y]
    );
    assert_rows_fit(&buffer);
}

#[test]
fn chinese_status_lines_truncate_on_grapheme_boundaries() {
    let view = base_view(&[
        "深度求索模型 · 高推理 · 默认权限",
        "上下文占用 88% · 缓存命中 91% · 每秒 42 个令牌",
    ]);
    let buffer = render(&view, 24, 12);
    let rows = rows(&buffer);
    let (_, composer_bottom) = composer_span(&buffer);
    let first = usize::from(composer_bottom) + 1;
    let second = first + 1;

    for y in [first, second] {
        let row = &rows[y];
        assert!(
            text::display_width(row) <= 24,
            "中文状态行不得越界: {row:?}"
        );
        assert!(
            row.starts_with("  "),
            "中文状态行左侧 2 列缩进: {row:?}"
        );
        // Right inset: content ends at least two cells before the edge.
        let content = row.trim_end();
        assert!(
            text::display_width(content) <= 22,
            "中文状态行右侧须留 2 列: {row:?}"
        );
        assert!(
            row.trim_end().ends_with('…') || text::display_width(row.trim_end()) <= 18,
            "被裁剪的中文行应以 … 结尾: {row:?}"
        );
    }
    assert_rows_fit(&buffer);
}

// ---------------------------------------------------------------------------
// 4) Sanitising: escapes / control characters never reach the terminal
// ---------------------------------------------------------------------------

#[test]
fn control_characters_are_scrubbed_from_status_lines() {
    let view = base_view(&[
        "\u{1b}[31mdeepseek-v4 · high\u{1b}[0m\u{7}",
        "\u{1b}]0;owned\u{7}ctx 42% · tok 12.3k",
    ]);
    let buffer = render(&view, 80, 24);
    let rows = rows(&buffer);
    let joined = rows.join("\n");
    assert!(!joined.contains('\u{1b}'), "escape sequences must be stripped");
    assert!(!joined.contains('\u{7}'), "control characters must be scrubbed");
    assert!(joined.contains("deepseek-v4 · high"), "{joined:?}");
    assert!(joined.contains("ctx 42%"), "{joined:?}");
    assert_rows_fit(&buffer);
}
