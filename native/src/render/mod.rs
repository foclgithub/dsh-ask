//! Codex-style drawing. Owned by the render worker.
//!
//! `draw` is pure: it depends only on the `View` and the frame size, and it
//! paints every cell it owns each frame so ratatui's buffer diff stays correct.
//!
//! Layout, top to bottom (normal view):
//!
//! ```text
//! (blank)
//!   >_ dsh-ask
//!      {cwd}
//! {transcript, flexible}
//! {gap: back-to-bottom control while scrolled}
//! {composer: grey block with padding rows, attachments and the `›` draft}
//!   {statusLines[0], or the legacy {model} · {project} · {sessionTitle}[ · {status}]}
//!   {statusLines[1], optional}
//!   {hint}
//! ```

#[path = "../theme.rs"]
pub mod theme;

pub mod composer;
pub mod footer;
pub mod header;
pub mod modal;
pub mod transcript;

use ratatui::layout::{Position, Rect};
use ratatui::Frame;

use crate::protocol::View;
use crate::text;

/// One-row gap between the transcript and the composer.
const GAP_ROWS: u16 = 1;
const HINT_ROWS: u16 = 1;

/// Modal pages replace the whole screen.
fn is_page_modal(view: &View) -> bool {
    match &view.modal {
        Some(modal) => modal.kind != "commands",
        None => false,
    }
}

/// Cursor for the full-screen `sessions` picker: the search line is the second
/// row (title, then query), so the caret sits at the end of the query text on
/// that row. Widths come from `text::display_width`, so CJK/emoji land on the
/// right cell; an empty query puts the caret at the start of the query field.
///
/// `help` pages keep the cursor hidden (they are not text inputs), and
/// `commands` popups keep the composer cursor (handled by the normal path).
fn page_cursor(view: &View, area: Rect) -> Option<Position> {
    let modal = view.modal.as_ref()?;
    if !is_page_modal(view) || modal.kind != "sessions" {
        return None;
    }
    // render_page only draws the query row when there are at least two rows.
    if area.width < 2 || area.height < 2 {
        return None;
    }
    let width = usize::from(area.width);
    let query = text::single_line(&modal.query);
    let shown = text::truncate_to_width(&query, width.saturating_sub(2));
    let x = area
        .x
        .saturating_add(2)
        .saturating_add(text::display_width(&shown) as u16)
        .min(area.x.saturating_add(area.width).saturating_sub(1));
    Some(Position::new(x, area.y.saturating_add(1)))
}

#[derive(Debug, Clone)]
struct Layout {
    header: Option<Rect>,
    transcript: Rect,
    gap: Option<Rect>,
    popup: Option<Rect>,
    composer: Option<Rect>,
    status: Option<Rect>,
    hint: Option<Rect>,
}

fn compute_layout(area: Rect, view: &View) -> Layout {
    let mut header_rows = header::height_for(area.height);
    // One leading blank row, matching the Codex startup snapshot, when there is
    // room for it.
    let mut top_pad = if area.height >= 10 && header_rows > 0 {
        1
    } else {
        0
    };
    if area.height < 8 {
        header_rows = header_rows.min(1);
        top_pad = 0;
    }

    let composer_max_rows = composer::max_height_for(area.height);
    let composer_desired = composer::desired_height(view, area.width, composer_max_rows);
    let mut gap_rows = GAP_ROWS;
    // `statusLines` can ask for two rows; the loop below shrinks it to one
    // before dropping it entirely, so the input keeps its space longest.
    let mut status_rows = footer::desired_height(view);
    let mut hint_rows = HINT_ROWS;
    let mut composer_rows = composer_desired;
    let used = header_rows.saturating_add(top_pad);
    let available = area.height.saturating_sub(used);

    // Degrade bottom chrome until it fits, keeping the input visible.
    loop {
        let wanted = composer_rows
            .saturating_add(gap_rows)
            .saturating_add(status_rows)
            .saturating_add(hint_rows);
        if wanted <= available {
            break;
        }
        if hint_rows > 0 {
            hint_rows = 0;
        } else if status_rows > 1 {
            // Two parent-formatted status rows shrink to the identity row
            // before the whole block disappears.
            status_rows = 1;
        } else if status_rows > 0 {
            status_rows = 0;
        } else if gap_rows > 0 {
            gap_rows = 0;
        } else if composer_rows > 1 {
            composer_rows -= 1;
        } else {
            break;
        }
    }
    if composer_rows > available {
        composer_rows = available;
    }
    let bottom = composer_rows
        .saturating_add(gap_rows)
        .saturating_add(status_rows)
        .saturating_add(hint_rows)
        .min(available);
    // The transcript keeps a fixed height: the command popup is an overlay and
    // must not reflow the chat area (Codex keeps the transcript geometry stable
    // while the `/` menu opens and closes).
    let transcript_rows = available.saturating_sub(bottom);

    let mut y = area.y;
    let header = if header_rows > 0 {
        y = y.saturating_add(top_pad);
        let rect = Rect {
            x: area.x,
            y,
            width: area.width,
            height: header_rows.min(area.height),
        };
        y = y.saturating_add(header_rows);
        Some(rect)
    } else {
        None
    };
    let transcript = Rect {
        x: area.x,
        y,
        width: area.width,
        height: transcript_rows,
    };
    y = y.saturating_add(transcript_rows);
    let gap = if gap_rows > 0 {
        let rect = Rect {
            x: area.x,
            y,
            width: area.width,
            height: 1,
        };
        y = y.saturating_add(1);
        Some(rect)
    } else {
        None
    };
    let composer_rect = if composer_rows > 0 {
        let rect = Rect {
            x: area.x,
            y,
            width: area.width,
            height: composer_rows,
        };
        y = y.saturating_add(composer_rows);
        Some(rect)
    } else {
        None
    };
    // Command popup: overlay glued to the composer's top edge. It covers the
    // bottom rows of the transcript (and the gap row), never the header.
    let popup = match (
        view.modal
            .as_ref()
            .filter(|modal| modal.kind == "commands"),
        composer_rect,
    ) {
        (Some(modal), Some(composer)) => {
            let content_top = area.y.saturating_add(top_pad).saturating_add(header_rows);
            let max_height = composer.y.saturating_sub(content_top);
            let wanted = modal::popup_rows(modal).max(1).min(modal::MAX_POPUP_ROWS);
            let height = wanted.min(max_height);
            if height > 0 {
                Some(Rect {
                    x: area.x,
                    y: composer.y - height,
                    width: area.width,
                    height,
                })
            } else {
                None
            }
        }
        _ => None,
    };
    let status = if status_rows > 0 {
        let rect = Rect {
            x: area.x,
            y,
            width: area.width,
            height: status_rows,
        };
        y = y.saturating_add(status_rows);
        Some(rect)
    } else {
        None
    };
    let hint = if hint_rows > 0 {
        Some(Rect {
            x: area.x,
            y,
            width: area.width,
            height: 1,
        })
    } else {
        None
    };
    Layout {
        header,
        transcript,
        gap,
        popup,
        composer: composer_rect,
        status,
        hint,
    }
}

fn hint_text<'a>(view: &'a View) -> &'a str {
    match view.modal.as_ref() {
        Some(modal) if !modal.footer.trim().is_empty() => modal.footer.as_str(),
        _ => view.hint.as_str(),
    }
}

fn cursor_in_layout(view: &View, layout: &Layout) -> Option<Position> {
    layout.composer.and_then(|area| composer::cursor(view, area))
}

/// Draw one complete frame for `view`. Pure with respect to process state:
/// ratatui's buffer diffing makes this cheap to call on every message.
pub fn draw(frame: &mut Frame, view: &View) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }
    if let Some(modal) = view.modal.as_ref() {
        if is_page_modal(view) {
            modal::render_page(frame, area, modal, view);
            // The sessions picker is a text input too: keep its search caret
            // visible at the end of the query row while the user types filters.
            if let Some(position) = page_cursor(view, area) {
                frame.set_cursor_position(position);
            }
            return;
        }
    }
    let layout = compute_layout(area, view);
    if let Some(rect) = layout.header {
        header::render(frame, rect, view);
    }
    transcript::render(frame, layout.transcript, view);
    if let Some(rect) = layout.gap {
        footer::render_gap(frame, rect, view.scroll_offset, &view.ui);
    }
    if let (Some(rect), Some(modal)) = (layout.popup, view.modal.as_ref()) {
        modal::render_commands(frame, rect, modal, &view.ui);
    }
    if let Some(rect) = layout.composer {
        composer::render(frame, rect, view);
    }
    if let Some(rect) = layout.status {
        footer::render_status(frame, rect, view);
    }
    if let Some(rect) = layout.hint {
        footer::render_hint(frame, rect, hint_text(view), &view.ui);
    }
    if let Some(position) = cursor_in_layout(view, &layout) {
        frame.set_cursor_position(position);
    }
}

/// Cursor position for the current `view` at the given terminal `area`.
///
/// Matches what [`draw`] would place: the composer caret for the normal view and
/// the `commands` popup, the query caret for the full-screen `sessions` picker,
/// and `None` when the cursor is hidden (`help` pages, zero-sized areas, or a
/// composer that does not fit).
pub fn cursor(view: &View, area: Rect) -> Option<Position> {
    if area.width == 0 || area.height == 0 {
        return None;
    }
    if is_page_modal(view) {
        return page_cursor(view, area);
    }
    let layout = compute_layout(area, view);
    cursor_in_layout(view, &layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Attachment, Message, Modal, ModalItem};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render(view: &View, width: u16, height: u16) -> Vec<String> {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| draw(frame, view)).expect("draw");
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| {
                let mut line = String::new();
                for x in 0..width {
                    line.push_str(buffer[(x, y)].symbol());
                }
                line
            })
            .collect()
    }

    fn chat_view() -> View {
        View {
            project: "dsh-local-cli".into(),
            cwd: "/Users/example/workspace/dsh-local-cli".into(),
            session_title: "Fix retry logic".into(),
            session_id: "7a9c76c0".into(),
            model: "deepseek-v4-flash".into(),
            status: "ready".into(),
            status_lines: Vec::new(),
            messages: vec![
                Message {
                    role: "user".into(),
                    text: "帮我看看这个重试逻辑".into(),
                },
                Message {
                    role: "assistant".into(),
                    text: "好的，先看一下实现：\n\n- 第一次请求\n- 第二次重试\n\n```rust\nfn retry() {}\n```".into(),
                },
                Message {
                    role: "system".into(),
                    text: "⚙ read_file src/app.rs".into(),
                },
                Message {
                    role: "system".into(),
                    text: "✓ 已读取 42 行".into(),
                },
                Message {
                    role: "error".into(),
                    text: "请求失败 · timeout".into(),
                },
            ],
            input: "继续".into(),
            input_cursor: 2,
            attachments: vec![Attachment { name: "shot.png".into() }],
            hint: "Enter 发送 · Alt+Enter 换行".into(),
            ui: Default::default(),
            scroll_offset: 0,
            modal: None,
        }
    }

    #[test]
    fn main_frame_smoke() {
        let view = chat_view();
        for line in render(&view, 80, 24) {
            println!("{line}");
        }
        let cursor = cursor(&view, Rect::new(0, 0, 80, 24));
        println!("cursor = {cursor:?}");
        assert!(cursor.is_some());
    }

    #[test]
    fn session_page_smoke() {
        let mut view = chat_view();
        view.modal = Some(Modal {
            kind: "sessions".into(),
            title: "切换会话".into(),
            items: vec![
                ModalItem { label: "新建会话".into(), detail: "workspace ~/w".into() },
                ModalItem { label: "Fix retry logic".into(), detail: "7a9c76c0 · ~/dsh-local-cli".into() },
            ],
            selected: 1,
            query: String::new(),
            footer: "↑↓ 选择 · Enter 切换 · Esc 关闭".into(),
        });
        // sessions picker 是搜索输入：光标停在第二行 query 末尾（空 query 为列 2）。
        assert_eq!(
            cursor(&view, Rect::new(0, 0, 80, 24)),
            Some(Position::new(2, 1))
        );
        for line in render(&view, 80, 24) {
            println!("{line}");
        }
    }

    #[test]
    fn commands_popup_smoke() {
        let mut view = chat_view();
        view.modal = Some(Modal {
            kind: "commands".into(),
            title: "命令".into(),
            items: vec![
                ModalItem { label: "/help".into(), detail: "显示帮助".into() },
                ModalItem { label: "/attachments".into(), detail: "列出附件".into() },
            ],
            selected: 0,
            query: "/".into(),
            footer: String::new(),
        });
        assert!(cursor(&view, Rect::new(0, 0, 80, 24)).is_some());
        for line in render(&view, 80, 24) {
            println!("{line}");
        }
    }

    #[test]
    fn empty_view_smoke() {
        let view = View::default();
        for line in render(&view, 60, 16) {
            println!("{line}");
        }
        let cursor = cursor(&view, Rect::new(0, 0, 60, 16));
        println!("cursor = {cursor:?}");
        let composer = compute_layout(Rect::new(0, 0, 60, 16), &view)
            .composer
            .expect("composer");
        // Codex geometry: one grey padding row above the draft row.
        assert_eq!(cursor, Some(Position::new(2, composer.y + 1)));
    }

    #[test]
    fn long_input_window_keeps_cursor_visible() {
        let mut view = chat_view();
        view.input = (1..=30).map(|i| format!("line {i}\n")).collect::<String>();
        view.input_cursor = view.input.encode_utf16().count();
        view.attachments.clear();
        let lines = render(&view, 60, 16);
        for line in &lines {
            println!("{line}");
        }
        let cursor = cursor(&view, Rect::new(0, 0, 60, 16));
        println!("cursor = {cursor:?}");
        assert!(cursor.is_some());
        let position = cursor.unwrap();
        assert!(position.y < 16);
    }

    fn commands_view(base: &View, count: usize) -> View {
        let mut view = base.clone();
        let items = (0..count)
            .map(|index| {
                let label = if index == 0 {
                    "/model".to_string()
                } else {
                    format!("/command-{index}")
                };
                ModalItem {
                    label,
                    detail: format!("说明 {index}"),
                }
            })
            .collect();
        view.modal = Some(Modal {
            kind: "commands".into(),
            title: "命令".into(),
            items,
            selected: 0,
            query: "/".into(),
            footer: String::new(),
        });
        view
    }

    #[test]
    fn command_popup_is_overlay_and_does_not_reflow_transcript() {
        let area = Rect::new(0, 0, 80, 24);
        let base = chat_view();
        let base_layout = compute_layout(area, &base);
        let base_frame = render(&base, 80, 24);
        for count in [2usize, 8, 20] {
            let view = commands_view(&base, count);
            let layout = compute_layout(area, &view);
            // Fixed transcript geometry: the popup is an overlay only.
            assert_eq!(base_layout.transcript, layout.transcript, "count {count}");
            assert_eq!(base_layout.composer, layout.composer, "count {count}");
            assert_eq!(base_layout.status, layout.status, "count {count}");
            assert_eq!(base_layout.hint, layout.hint, "count {count}");
            let popup = layout.popup.expect("popup rect");
            if count == 8 {
                println!("base layout: {base_layout:?}");
                println!("commands layout: {layout:?}");
            }
            let composer = layout.composer.expect("composer rect");
            assert_eq!(popup.bottom(), composer.top(), "popup glued to composer");
            assert!((1..=8).contains(&popup.height), "popup height {}", popup.height);

            let frame = render(&view, 80, 24);
            let transcript_top = usize::from(base_layout.transcript.top());
            let popup_top = usize::from(popup.top());
            for row in transcript_top..popup_top {
                assert_eq!(
                    base_frame[row], frame[row],
                    "transcript row {row} changed when the popup opened"
                );
            }
            let covered = frame[popup_top..popup_top + usize::from(popup.height)].join("\n");
            assert!(
                covered.contains("/model"),
                "popup should show item labels, got:\n{covered}"
            );
            // The prompt sits on the first visible draft row, below the grey
            // top padding and any attachment rows (Codex composer geometry).
            let composer_start = usize::from(composer.y);
            let composer_end = usize::from(composer.bottom());
            let prompt_row = (composer_start..composer_end)
                .find(|&row| frame[row].contains('›'))
                .unwrap_or_else(|| {
                    panic!(
                        "composer prompt must stay visible: {:?}",
                        &frame[composer_start..composer_end]
                    )
                });
            assert!(prompt_row < composer_end);
            assert_eq!(cursor(&base, area), cursor(&view, area));
            assert!(cursor(&view, area).is_some());
        }
    }

    #[test]
    fn draw_is_pure_for_identical_inputs() {
        let view = chat_view();
        assert_eq!(render(&view, 80, 24), render(&view, 80, 24));
    }

    #[test]
    fn scroll_offset_moves_the_viewport_up_by_rows() {
        let mut view = chat_view();
        view.messages = vec![Message {
            role: "assistant".into(),
            text: (1..=60)
                .map(|index| format!("row {index}"))
                .collect::<Vec<_>>()
                .join("\n"),
        }];
        let layout = compute_layout(Rect::new(0, 0, 60, 16), &view);
        let transcript_top = usize::from(layout.transcript.top());
        let transcript_height = usize::from(layout.transcript.height);
        assert!(transcript_height >= 4, "need room to observe the shift");
        let bottom = render(&view, 60, 16);
        let mut scrolled = view.clone();
        scrolled.scroll_offset = 2;
        let up = render(&scrolled, 60, 16);
        // Scrolling up by 2 lines keeps the same content band, shifted so that
        // whatever was at the first transcript row is now 2 rows lower.
        for row in 0..2 {
            assert_eq!(
                up[transcript_top + row + 2],
                bottom[transcript_top + row],
                "scrolled transcript row {row} should match the bottom viewport"
            );
        }
    }

    #[test]
    fn cursor_clamps_and_tracks_emoji_and_cjk() {
        let mut view = chat_view();
        view.attachments.clear();
        view.input = "中文😀a".into();
        view.input_cursor = 2;
        let area = Rect::new(0, 0, 80, 24);
        let position = cursor(&view, area).expect("cursor");
        let composer = compute_layout(area, &view).composer.expect("composer");
        // The draft row sits below the composer's one-row grey top padding.
        assert_eq!(position.y, composer.y + 1);
        assert_eq!(position.x, 2 + 4, "中文 is four cells");
        view.input_cursor = 3; // inside the emoji surrogate pair -> next boundary
        let position = cursor(&view, area).expect("cursor");
        assert_eq!(position.x, 2 + 6);
        view.input_cursor = 999;
        let position = cursor(&view, area).expect("cursor");
        assert_eq!(position.x, 2 + 7);
    }

    #[test]
    fn narrow_and_tiny_never_panic() {
        let view = chat_view();
        for width in 0..=12u16 {
            for height in 0..=6u16 {
                let _ = render(&view, width, height);
                let _ = cursor(&view, Rect::new(0, 0, width, height));
                let _ = transcript::visual_lines(&view, width, height);
            }
        }
    }

    #[test]
    fn scrolled_view_shows_back_control() {
        let mut view = chat_view();
        view.scroll_offset = 3;
        let lines = render(&view, 80, 24);
        assert!(lines.iter().any(|line| line.contains("Back to bottom")));
    }

    #[test]
    fn sessions_picker_shows_query_cursor_on_second_row() {
        let mut view = chat_view();
        view.modal = Some(Modal {
            kind: "sessions".into(),
            title: "会话".into(),
            items: vec![ModalItem {
                label: "Fix retry logic".into(),
                detail: "7a9c76c0 · ~/dsh-local-cli".into(),
            }],
            selected: 0,
            query: String::new(),
            footer: String::new(),
        });
        let area = Rect::new(0, 0, 80, 24);
        // Empty query: caret at the start of the search field (column 2, row 1).
        assert_eq!(cursor(&view, area), Some(Position::new(2, 1)));

        // CJK text advances by display width (each char is two cells).
        view.modal.as_mut().unwrap().query = "中文".into();
        assert_eq!(cursor(&view, area), Some(Position::new(6, 1)));

        // Emoji is two cells wide as well.
        view.modal.as_mut().unwrap().query = "a😀b".into();
        assert_eq!(cursor(&view, area), Some(Position::new(6, 1)));

        // Long queries are clipped to the last usable cell like the drawn row.
        view.modal.as_mut().unwrap().query = "x".repeat(200);
        assert_eq!(cursor(&view, area), Some(Position::new(79, 1)));

        // The caret follows the drawn (truncated) query text, not the raw string.
        let drawn = {
            let lines = render(&view, 80, 24);
            lines[1].clone()
        };
        assert!(drawn.contains("xxx"));
    }

    #[test]
    fn help_page_hides_cursor_and_commands_keeps_composer_cursor() {
        let mut view = chat_view();
        view.modal = Some(Modal {
            kind: "help".into(),
            title: "帮助".into(),
            items: vec![],
            selected: 0,
            query: String::new(),
            footer: String::new(),
        });
        let area = Rect::new(0, 0, 80, 24);
        assert_eq!(cursor(&view, area), None);

        view.modal = Some(Modal {
            kind: "commands".into(),
            title: String::new(),
            items: vec![ModalItem {
                label: "/help".into(),
                detail: "显示帮助".into(),
            }],
            selected: 0,
            query: String::new(),
            footer: String::new(),
        });
        let composer = compute_layout(area, &view).composer.expect("composer");
        let position = cursor(&view, area).expect("composer cursor");
        assert!(
            (composer.y..composer.y + composer.height).contains(&position.y),
            "commands 光标必须在 composer 内: {position:?} vs {composer:?}"
        );
        assert!(position.x >= composer.x + 2);
    }
}
