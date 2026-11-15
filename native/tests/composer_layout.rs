//! Composer geometry contract, mirroring Codex's
//! `bottom_pane/chat_composer/composer_layout.rs`:
//!
//! * the grey surface covers the draft *and* one blank row above/below it, so
//!   the empty composer is three rows tall instead of one;
//! * the draft starts two columns in (`›` prompt + one gap) and keeps one column
//!   free on the right for the `↑`/`↓` scroll hints, i.e. it wraps at
//!   `width - 3` — the full usable width of a wide terminal;
//! * attachments sit on their own rows above a blank separator row;
//! * the composer grows with the draft and is capped at
//!   `max(2/3 * pane height, 8)` rows instead of a hard-coded line count.
//!
//! Everything is rendered off-screen with `TestBackend` (no TTY, no timing).

use dsh_ask_ui::protocol::{Attachment, Message, View};
use dsh_ask_ui::render;
use dsh_ask_ui::text;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

fn render(view: &View, width: u16, height: u16) -> Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("TestBackend terminal");
    terminal
        .draw(|frame| render::draw(frame, view))
        .expect("render::draw must not fail");
    terminal.backend().buffer().clone()
}

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

fn find_row(rows: &[String], needle: &str) -> u16 {
    rows.iter()
        .position(|row| row.contains(needle))
        .unwrap_or_else(|| panic!("画面里找不到 {needle:?}；当前画面：{rows:#?}"))
        .try_into()
        .expect("row fits u16")
}

fn composer_rows(buffer: &Buffer) -> Vec<u16> {
    (buffer.area.top()..buffer.area.bottom())
        .filter(|&y| buffer[(buffer.area.left(), y)].bg == dsh_ask_ui::render::theme::COMPOSER_BG)
        .collect()
}

fn composer_span(buffer: &Buffer) -> (u16, u16) {
    let rows = composer_rows(buffer);
    assert!(!rows.is_empty(), "composer grey block must be painted");
    for pair in rows.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "grey block must be contiguous: {rows:?}"
        );
    }
    (rows[0], *rows.last().expect("non-empty"))
}

/// Whole composer block (all rows, every column) must be painted grey: the
/// background has to cover the top/bottom padding, the prompt and the text.
fn assert_composer_surface(buffer: &Buffer, top: u16, bottom: u16) {
    for y in top..=bottom {
        let mut x = buffer.area.left();
        while x < buffer.area.right() {
            let symbol = buffer[(x, y)].symbol();
            // Skip the hidden continuation cell of a wide CJK/emoji glyph: the
            // terminal paints the glyph with the lead cell's background.
            let advance = u16::try_from(UnicodeWidthStr::width(symbol))
                .unwrap_or(1)
                .max(1);
            assert_eq!(
                buffer[(x, y)].bg,
                dsh_ask_ui::render::theme::COMPOSER_BG,
                "composer cell ({x},{y}) must be grey (symbol {symbol:?})"
            );
            x = x.saturating_add(advance);
        }
    }
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

fn base_view() -> View {
    View {
        project: "dsh-local-cli".into(),
        cwd: "/Users/example/workspace/dsh-local-cli".into(),
        session_title: "Fix retry logic".into(),
        session_id: "7a9c76c0".into(),
        model: "deepseek-v4-flash".into(),
        status: "ready".into(),
        status_lines: Vec::new(),
        messages: vec![Message {
            role: "assistant".into(),
            text: "先看实现：\n\n- 第一次请求\n- 第二次重试".into(),
        }],
        input: String::new(),
        input_cursor: 0,
        attachments: Vec::new(),
        hint: "Enter 发送 · Alt+Enter 换行".into(),
        ui: Default::default(),
        scroll_offset: 0,
        modal: None,
    }
}

fn print_frame(label: &str, view: &View, width: u16, height: u16) {
    println!("=== {label} {width}x{height} ===");
    for (y, line) in rows(&render(view, width, height)).iter().enumerate() {
        println!("{y:02}|{line}|");
    }
}

/// Renders the reference frames used in the task report (80x24 / 120x40 /
/// 40x12, empty and with a two-line CJK/emoji draft plus an attachment).
#[test]
fn print_composer_reference_frames() {
    let mut draft = base_view();
    draft.input = "第一条中文😀\nsecond line".into();
    draft.input_cursor = draft.input.encode_utf16().count();
    draft.attachments = vec![Attachment {
        name: "shot.png".into(),
    }];
    for (width, height) in [(80u16, 24u16), (120, 40), (40, 12)] {
        print_frame("EMPTY", &base_view(), width, height);
        print_frame("DRAFT", &draft, width, height);
    }
}

// ---------------------------------------------------------------------------
// Empty composer: three grey rows, prompt + placeholder on the draft row.
// ---------------------------------------------------------------------------

#[test]
fn empty_composer_is_three_grey_rows_with_placeholder() {
    let view = base_view();
    let width = 80u16;
    let buffer = render(&view, width, 24);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    assert_eq!(
        bottom - top + 1,
        3,
        "empty composer must be top padding + draft + bottom padding"
    );
    assert!(
        body[top as usize].trim().is_empty(),
        "top padding must be blank"
    );
    assert!(
        body[bottom as usize].trim().is_empty(),
        "bottom padding must be blank"
    );
    let input_y = top + 1;
    assert!(
        body[input_y as usize].starts_with("› "),
        "draft row must start with the `› ` prompt: {:?}",
        body[input_y as usize]
    );
    assert!(
        body[input_y as usize].contains("Ask dsh-ask to do anything"),
        "empty draft must show the placeholder"
    );
    assert_composer_surface(&buffer, top, bottom);

    let composer = Rect::new(0, top, width, bottom - top + 1);
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, width, 24)),
        Some(Position::new(2, input_y)),
        "caret starts after the two-column prompt gutter"
    );
    assert_eq!(composer.height, 3);

    // Effective text width is the full terminal minus the 2-column gutter and
    // the 1-column scroll-hint margin (Codex textarea inset): 77 cells at 80.
    let mut wrapped = base_view();
    wrapped.input = "x".repeat(77 * 2 + 10);
    wrapped.input_cursor = wrapped.input.len();
    let wrapped_buffer = render(&wrapped, width, 24);
    let wrapped_rows = rows(&wrapped_buffer);
    let (wrapped_top, wrapped_bottom) = composer_span(&wrapped_buffer);
    assert_eq!(
        wrapped_bottom - wrapped_top + 1,
        5,
        "3 draft rows + 2 padding"
    );
    assert_eq!(
        wrapped_rows[(wrapped_top + 1) as usize]
            .matches('x')
            .count(),
        77
    );
    assert_eq!(
        wrapped_rows[(wrapped_top + 2) as usize]
            .matches('x')
            .count(),
        77
    );
    assert_eq!(
        wrapped_rows[(wrapped_top + 3) as usize]
            .matches('x')
            .count(),
        10
    );
    assert!(wrapped_rows[(wrapped_top + 4) as usize].trim().is_empty());
}

// ---------------------------------------------------------------------------
// Attachments: one row each above a blank separator row, then the draft.
// ---------------------------------------------------------------------------

#[test]
fn attachments_sit_above_a_separator_and_the_draft() {
    let mut view = base_view();
    view.input = "第一条中文😀\nsecond line".into();
    view.input_cursor = view.input.encode_utf16().count();
    view.attachments = vec![
        Attachment {
            name: "shot.png".into(),
        },
        Attachment {
            name: "second-very-long-name.png".into(),
        },
    ];
    let buffer = render(&view, 80, 24);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    // 2 padding rows + 2 attachment rows + separator + 2 draft rows.
    assert_eq!(bottom - top + 1, 7, "composer height: {top}..={bottom}");
    assert!(body[top as usize].trim().is_empty(), "top padding");
    assert!(
        body[(top + 1) as usize].starts_with("  [Image #1] shot.png"),
        "attachment row 1 starts at the draft column: {:?}",
        body[(top + 1) as usize]
    );
    assert!(
        body[(top + 2) as usize].starts_with("  [Image #2] second-very-long-name.png"),
        "attachment row 2: {:?}",
        body[(top + 2) as usize]
    );
    assert!(
        body[(top + 3) as usize].trim().is_empty(),
        "attachment separator row must be blank"
    );
    assert!(
        body[(top + 4) as usize].starts_with("› 第一条中文😀"),
        "draft row: {:?}",
        body[(top + 4) as usize]
    );
    assert!(
        body[(top + 5) as usize].starts_with("  second line"),
        "wrapped draft row keeps the 2-column indent: {:?}",
        body[(top + 5) as usize]
    );
    assert!(body[bottom as usize].trim().is_empty(), "bottom padding");
    assert_composer_surface(&buffer, top, bottom);
    // The caret sits on the second draft row, after `second line`.
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, 80, 24)),
        Some(Position::new(
            2 + text::display_width("second line") as u16,
            top + 5
        ))
    );
}

#[test]
fn many_attachments_keep_the_draft_visible() {
    let mut view = base_view();
    view.input = "hi".into();
    view.input_cursor = 2;
    view.attachments = (1..=20)
        .map(|index| Attachment {
            name: format!("image-{index}.png"),
        })
        .collect();
    let buffer = render(&view, 80, 24);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    // Codex caps the composer at max(2/3 * 24, 8) = 16 rows.
    assert_eq!(bottom - top + 1, 16, "composer must be capped at 16 rows");
    assert!(body[top as usize].trim().is_empty(), "top padding survives");
    assert!(
        body[(top + 1) as usize].starts_with("  [Image #1]"),
        "first attachments are shown"
    );
    let summary_y = find_row(&body, "… +");
    assert!(
        (top..bottom).contains(&summary_y),
        "hidden attachments must be summarised inside the composer"
    );
    assert!(summary_y > top + 1);
    assert!(
        body[(summary_y + 1) as usize].trim().is_empty(),
        "separator follows the attachment block"
    );
    let draft_y = summary_y + 2;
    assert!(
        body[draft_y as usize].starts_with("› hi"),
        "draft must stay visible below the attachment block: {:?}",
        body[draft_y as usize]
    );
    assert!(body[bottom as usize].trim().is_empty(), "bottom padding");
    assert_composer_surface(&buffer, top, bottom);
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, 80, 24)),
        Some(Position::new(2 + 2, draft_y)),
        "caret follows the draft, attachments never push it out"
    );
}

// ---------------------------------------------------------------------------
// Growth and the Codex two-thirds cap.
// ---------------------------------------------------------------------------

#[test]
fn long_draft_grows_to_the_codex_two_thirds_cap() {
    let mut view = base_view();
    view.messages.clear();
    let lines: Vec<String> = (1..=60).map(|index| format!("line {index}")).collect();
    view.input = lines.join("\n");
    // Caret parked on line 40: the viewport then has overflow both above and
    // below, which is when Codex shows the `↑`/`↓` hints.
    view.input_cursor = lines[..40].join("\n").encode_utf16().count();
    let height = 40u16;
    let buffer = render(&view, 120, height);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    // max(2/3 * 40, 8) = 26 rows: 24 draft rows between the two padding rows.
    assert_eq!(bottom - top + 1, 26, "composer must grow to the cap");
    assert!(body[top as usize].trim().is_empty(), "top padding");
    assert!(body[bottom as usize].trim().is_empty(), "bottom padding");
    assert_composer_surface(&buffer, top, bottom);
    // Overflow hints live in the reserved right column (↑ above, ↓ below).
    assert_eq!(
        char_at(&buffer, 119, top + 1),
        '↑',
        "up hint on the top row"
    );
    assert_eq!(
        char_at(&buffer, 119, bottom - 1),
        '↓',
        "down hint on the last draft row"
    );
    let cursor = render::cursor(&view, Rect::new(0, 0, 120, height)).expect("caret visible");
    assert!(
        (top + 1..=bottom - 1).contains(&cursor.y),
        "caret must stay on a visible draft row: {cursor:?} in {top}..={bottom}"
    );
    // Caret follows line 40 to the last visible draft row, after `line 40`.
    assert_eq!(cursor, Position::new(2 + 7, bottom - 1));
    // The first visible row is line 17 (offset 16 of the 60-line draft).
    assert!(
        body[(top + 1) as usize]
            .trim_start_matches('›')
            .trim_start()
            .starts_with("line 17"),
        "first visible draft row must be line 17: {:?}",
        body[(top + 1) as usize]
    );
}

fn char_at(buffer: &Buffer, x: u16, y: u16) -> char {
    buffer[(x, y)].symbol().chars().next().unwrap_or(' ')
}

#[test]
fn short_draft_does_not_reserve_the_cap() {
    let mut view = base_view();
    view.messages.clear();
    view.input = "hi".into();
    view.input_cursor = 2;
    let buffer = render(&view, 120, 40);
    let (top, bottom) = composer_span(&buffer);
    assert_eq!(
        bottom - top + 1,
        3,
        "single-line draft keeps the 3-row composer"
    );
}

// ---------------------------------------------------------------------------
// Wide terminals are not narrowed; CJK / emoji / long lines never misclip.
// ---------------------------------------------------------------------------

#[test]
fn draft_wraps_at_full_terminal_width() {
    let mut view = base_view();
    view.messages.clear();
    view.input = "x".repeat(400);
    view.input_cursor = view.input.len();
    let buffer = render(&view, 120, 40);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    // 120 columns - 2 gutter - 1 scroll margin = 117 cells per draft row.
    assert_eq!(bottom - top + 1, 6, "4 wrapped draft rows + 2 padding");
    let first = &body[(top + 1) as usize];
    assert_eq!(
        first.matches('x').count(),
        117,
        "first draft row must use 117 cells, got {:?}",
        first
    );
    assert_eq!(body[(top + 2) as usize].matches('x').count(), 117);
    assert_eq!(body[(top + 3) as usize].matches('x').count(), 117);
    // 400 = 117 + 117 + 117 + 49: the last row is a partial line, never truncated.
    assert_eq!(body[(top + 4) as usize].matches('x').count(), 49);
    assert!(body[bottom as usize].trim().is_empty(), "bottom padding");
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, 120, 40)),
        Some(Position::new(2 + 49, top + 4)),
        "caret sits after the final wrapped row"
    );
    assert_rows_fit(&buffer);
    assert_composer_surface(&buffer, top, bottom);
}

#[test]
fn cjk_and_emoji_wrap_without_splitting_graphemes() {
    let mut view = base_view();
    view.messages.clear();
    view.input = "中文😀".repeat(15);
    view.input_cursor = view.input.encode_utf16().count();
    let buffer = render(&view, 40, 12);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    assert_eq!(bottom - top + 1, 5, "3 wrapped rows + 2 padding rows");
    assert_rows_fit(&buffer);
    for y in top + 1..=bottom - 1 {
        let row = &body[y as usize];
        assert!(
            text::display_width(row) <= 40,
            "draft row {y} must fit the 40-column terminal: {row:?}"
        );
    }
    assert!(
        body[(top + 1) as usize].starts_with("› 中文😀中文😀"),
        "CJK/emoji text must start after the prompt: {:?}",
        body[(top + 1) as usize]
    );
    let cursor = render::cursor(&view, Rect::new(0, 0, 40, 12)).expect("caret");
    assert!(
        (top + 1..=bottom - 1).contains(&cursor.y),
        "caret stays on a draft row: {cursor:?}"
    );
}

// ---------------------------------------------------------------------------
// Small panes degrade without losing the draft or the caret.
// ---------------------------------------------------------------------------

#[test]
fn tiny_panes_degrade_but_keep_the_draft_and_caret() {
    let mut view = base_view();
    view.input = "hello".into();
    view.input_cursor = view.input.len();
    for (width, height) in [
        (80u16, 8u16),
        (40, 12),
        (20, 8),
        (8, 4),
        (4, 3),
        (3, 2),
        (2, 1),
        (1, 1),
    ] {
        let buffer = render(&view, width, height);
        assert_rows_fit(&buffer);
        if let Some(cursor) = render::cursor(&view, Rect::new(0, 0, width, height)) {
            assert!(
                cursor.x < width && cursor.y < height,
                "{width}x{height} caret {cursor:?} must stay on screen"
            );
        }
        if width >= 4 && height >= 3 {
            let body = rows(&buffer);
            assert!(
                body.iter().any(|row| row.contains('›')),
                "{width}x{height} must still paint the prompt: {body:#?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// `/` command popup stays an overlay above the padded composer.
// ---------------------------------------------------------------------------

#[test]
fn commands_popup_stays_above_the_padded_composer() {
    fn with_commands(mut view: View) -> View {
        view.modal = Some(dsh_ask_ui::protocol::Modal {
            kind: "commands".into(),
            title: "命令".into(),
            items: (1..=6)
                .map(|index| dsh_ask_ui::protocol::ModalItem {
                    label: format!("/command-{index}"),
                    detail: "说明".into(),
                })
                .collect(),
            selected: 0,
            query: "/".into(),
            footer: String::new(),
        });
        view
    }
    let plain = base_view();
    let popup = with_commands(base_view());
    let plain_buffer = render(&plain, 80, 24);
    let popup_buffer = render(&popup, 80, 24);
    let plain_rows = rows(&plain_buffer);
    let popup_rows = rows(&popup_buffer);
    // Composer and transcript geometry must not move when the menu opens.
    assert_eq!(composer_span(&plain_buffer), composer_span(&popup_buffer));
    let (top, _) = composer_span(&plain_buffer);
    for y in 0..top {
        let is_popup_row = popup_rows[y as usize].contains("/command-");
        if !is_popup_row {
            assert_eq!(
                plain_rows[y as usize], popup_rows[y as usize],
                "row {y} outside the popup must not change"
            );
        }
    }
    // The popup's last row is glued to the composer's top padding row.
    let popup_last = (0..top)
        .filter(|&y| popup_rows[y as usize].contains("/command-"))
        .max()
        .expect("popup rows");
    assert_eq!(
        popup_last,
        top - 1,
        "popup must be glued above the composer"
    );
}

// ---------------------------------------------------------------------------
// Full logical lines reserve an insertion row for the caret (Codex textarea).
// ---------------------------------------------------------------------------

#[test]
fn caret_gets_an_insertion_row_after_a_full_line() {
    // Exactly 77 cells fill the draft row at 80 columns.
    let mut view = base_view();
    view.messages.clear();
    view.input = "x".repeat(77);
    view.input_cursor = 77;
    let buffer = render(&view, 80, 24);
    let body = rows(&buffer);
    let (top, bottom) = composer_span(&buffer);
    assert_eq!(
        bottom - top + 1,
        4,
        "a full logical line reserves an empty insertion row"
    );
    assert_eq!(
        body[(top + 1) as usize].matches('x').count(),
        77,
        "the full line keeps its 77 cells"
    );
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, 80, 24)),
        Some(Position::new(2, top + 2)),
        "caret moves to the insertion row instead of the hidden 78th cell"
    );
}

#[test]
fn caret_after_a_full_hard_line_moves_to_its_insertion_row() {
    let mut view = base_view();
    view.messages.clear();
    view.input = format!("{}\nnext", "x".repeat(77));
    view.input_cursor = 77;
    let buffer = render(&view, 80, 24);
    let body = rows(&buffer);
    let (top, _) = composer_span(&buffer);
    assert_eq!(
        render::cursor(&view, Rect::new(0, 0, 80, 24)),
        Some(Position::new(2, top + 2)),
        "caret sits at the start of the insertion row"
    );
    assert!(
        body[(top + 3) as usize].starts_with("  next"),
        "the next logical line follows the insertion row: {:?}",
        body[(top + 3) as usize]
    );
}

// ---------------------------------------------------------------------------
// Attachment labels are bounded by the same draft width.
// ---------------------------------------------------------------------------

#[test]
fn long_attachment_names_are_truncated_not_overlapped() {
    let mut view = base_view();
    view.messages.clear();
    view.input = "hi".into();
    view.input_cursor = 2;
    view.attachments = vec![Attachment {
        name: "a-very-long-attachment-name-that-would-overflow-the-composer-width.png".into(),
    }];
    let buffer = render(&view, 80, 24);
    let body = rows(&buffer);
    let (top, _) = composer_span(&buffer);
    let row = &body[(top + 1) as usize];
    assert!(
        row.starts_with("  [Image #1] "),
        "attachment label keeps its Codex prefix: {row:?}"
    );
    assert!(
        row.contains('…'),
        "truncated attachment name must be marked: {row:?}"
    );
    assert_rows_fit(&buffer);
    // The draft stays on the row after the separator.
    assert!(body[(top + 3) as usize].starts_with("› hi"));
}

// ---------------------------------------------------------------------------
// Final preview: composer + two parent-formatted `statusLines` rows.
//
// The status block owns the rows *below* the composer. This test both prints
// the reference frames and asserts that neither status row paints into the
// composer surface: the bottom padding row stays blank grey and the status rows
// carry the terminal background.
// ---------------------------------------------------------------------------

fn two_line_status_view() -> View {
    let mut view = base_view();
    view.status_lines = vec![
        "deepseek-v4-flash · high · default".into(),
        "ctx 42% · tok 12.3k · cache 88% · 3轮/7步".into(),
    ];
    view
}

#[test]
fn two_line_status_does_not_intrude_on_composer_padding() {
    fn draft_view() -> View {
        let mut view = two_line_status_view();
        view.input = "第一条中文😀\nsecond line".into();
        view.input_cursor = view.input.encode_utf16().count();
        view.attachments = vec![Attachment {
            name: "shot.png".into(),
        }];
        view
    }

    for (width, height) in [(80u16, 24u16), (120, 40)] {
        for (label, view) in [("EMPTY", two_line_status_view()), ("DRAFT", draft_view())] {
            let buffer = render(&view, width, height);
            let body = rows(&buffer);
            let (top, bottom) = composer_span(&buffer);

            // Codex composer geometry: top padding + draft + bottom padding,
            // plus one attachment row and one blank separator row for DRAFT.
            let expected_height = if label == "DRAFT" { 6 } else { 3 };
            assert_eq!(
                bottom - top + 1,
                expected_height,
                "{label} {width}x{height}: composer height"
            );
            assert!(body[top as usize].trim().is_empty(), "top padding blank");
            assert!(
                body[(top + 1) as usize].starts_with("  [Image #1]")
                    || body[(top + 1) as usize].starts_with("› "),
                "draft/attachment row: {:?}",
                body[(top + 1) as usize]
            );
            assert!(
                body[bottom as usize].trim().is_empty(),
                "bottom padding row must stay blank: {:?}",
                body[bottom as usize]
            );
            assert_composer_surface(&buffer, top, bottom);
            // The two status rows start immediately below the composer and do
            // not repaint any composer cell.
            let status_rows = [bottom + 1, bottom + 2];
            assert!(
                status_rows[1] < height,
                "two status rows must fit above the bottom hint"
            );
            assert!(
                body[status_rows[0] as usize].contains("deepseek-v4-flash"),
                "first status row: {:?}",
                body[status_rows[0] as usize]
            );
            assert!(
                body[status_rows[1] as usize].contains("ctx 42%"),
                "second status row: {:?}",
                body[status_rows[1] as usize]
            );
            assert!(
                body[(height - 1) as usize].contains("Enter 发送"),
                "hint row sticks to the bottom"
            );
            for y in top..=bottom {
                assert!(
                    !body[y as usize].contains("ctx 42%"),
                    "status text must not intrude on composer row {y}: {:?}",
                    body[y as usize]
                );
            }
            for &y in &status_rows {
                assert_ne!(
                    buffer[(0, y)].bg,
                    dsh_ask_ui::render::theme::COMPOSER_BG,
                    "status row {y} must not carry the composer background"
                );
            }
            // Nothing is drawn between the composer and its status block.
            assert_eq!(
                status_rows[0],
                bottom + 1,
                "status block must follow the composer padding directly"
            );
            assert!(
                !body[(bottom + 1) as usize].contains("  [Image #1]"),
                "status row must not re-render composer content"
            );
            assert_rows_fit(&buffer);

            println!("=== {label} {width}x{height} WITH 2 statusLines ===");
            println!(
                "composer rows {top}..={bottom} (height {}); status rows {}..={}; hint row {}",
                bottom - top + 1,
                status_rows[0],
                status_rows[1],
                height - 1
            );
            for (y, line) in body.iter().enumerate() {
                println!("{y:02}|{line}|");
            }
        }
    }
}
