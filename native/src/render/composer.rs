//! Borderless Codex-style composer: full-block background, `›` prompt,
//! attachment rows above the draft, soft-wrapped input and a visible cursor.
//!
//! The geometry is a port of Codex's
//! `codex-rs/tui/src/bottom_pane/chat_composer/composer_layout.rs` and
//! `codex-rs/tui/src/bottom_pane/textarea.rs`:
//!
//! ```text
//! composer rect (painted with `theme::composer_bg`)
//!   row 0            blank top padding            (VERTICAL_PADDING)
//!   attachment rows  one `[Image #N] <name>` row per attachment
//!   separator row    blank, only when attachments exist
//!   input rows       soft-wrapped draft, or the dim placeholder
//!   last row         blank bottom padding         (VERTICAL_PADDING)
//! ```
//!
//! * `LIVE_PREFIX_COLS` (=2) is the left inset. The `›` prompt is painted in
//!   that inset at column 0 and the draft text starts at column 2, so the
//!   prompt never eats a text cell.
//! * `RIGHT_MARGIN_COLS` (=1) is the right inset Codex keeps free for the
//!   `↑`/`↓` scroll hints, so the draft wraps at `width - 3`: the full usable
//!   width of a wide terminal, never artificially narrowed.
//! * The block grows with the draft, capped by [`max_height_for`]
//!   (`max(2/3 * pane, 8)` rows, Codex `max_composer_height`) rather than a
//!   fixed line count. Tiny panes degrade to fewer padding/attachment rows
//!   while always keeping the draft and its caret visible.

use ratatui::layout::{Position, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::protocol::{text_or_default, View, DEFAULT_PLACEHOLDER};
use crate::render::theme;
use crate::text;
use crate::text::WrappedLine;

/// Codex `ui_consts::LIVE_PREFIX_COLS`: the `›` prompt plus its one-cell gap.
pub const LIVE_PREFIX_COLS: u16 = 2;

/// Column Codex keeps free on the right for the `↑`/`↓` overflow hints.
pub const RIGHT_MARGIN_COLS: u16 = 1;

/// Blank rows Codex paints above and below the textarea inside the grey block.
pub const VERTICAL_PADDING: u16 = 1;

/// Codex clamps the composer to at least this many rows before capping it at
/// two thirds of the pane (`owned_transcript.rs::max_composer_height`).
pub const MIN_MAX_COMPOSER_ROWS: u16 = 8;

/// Codex cap for the whole composer block: `max(2/3 * pane height, 8)` rows,
/// never taller than the pane. The draft, attachments and both padding rows
/// share this budget.
pub fn max_height_for(area_height: u16) -> u16 {
    ((u32::from(area_height) * 2 / 3) as u16)
        .max(MIN_MAX_COMPOSER_ROWS)
        .min(area_height)
}

struct Vertical {
    top_pad: u16,
    bottom_pad: u16,
    attach_visible: usize,
    attach_hidden: usize,
    attach_rows: u16,
    input_rows: u16,
}

struct Geometry {
    left_inset: u16,
    right_inset: u16,
    content_width: u16,
    top_pad: u16,
    attach_visible: usize,
    attach_hidden: usize,
    attach_rows: u16,
    input_rows: u16,
    lines: Vec<WrappedLine>,
    window_start: usize,
    cursor_row: u16,
    cursor_col: u16,
}

/// Left/right insets, mirroring Codex's `(LIVE_PREFIX_COLS, 1)` textarea inset
/// but degrading on terminals too narrow to hold both.
fn insets(width: u16) -> (u16, u16) {
    let left = LIVE_PREFIX_COLS.min(width.saturating_sub(1));
    let right = if width > left.saturating_add(1) {
        RIGHT_MARGIN_COLS
    } else {
        0
    };
    (left, right)
}

/// Split the composer row budget between padding, attachments and the draft.
///
/// Codex reserves one row above and one row below the textarea whenever the
/// block is at least three rows tall, puts one row per image above a blank
/// separator row, and always keeps the draft visible. The same priorities are
/// applied here so a clipped composer drops attachments before it hides text.
fn vertical_allocation(attachments: usize, height: u16) -> Vertical {
    let (top_pad, bottom_pad) = match height {
        0 | 1 => (0, 0),
        2 => (1, 0),
        _ => (VERTICAL_PADDING, VERTICAL_PADDING),
    };
    let interior = height.saturating_sub(top_pad.saturating_add(bottom_pad));
    // The draft keeps one row; everything above it is attachment space.
    let budget = interior.saturating_sub(1);
    let attachment_rows = u16::try_from(attachments).unwrap_or(u16::MAX);
    let (visible, hidden, attach_rows) = if attachments == 0 {
        (0, 0, 0)
    } else if attachment_rows.saturating_add(1) <= budget {
        // One row per attachment plus the blank separator row.
        (attachments, 0, attachment_rows.saturating_add(1))
    } else if budget >= 3 {
        // Separator + `… +N` summary + at least one attachment row.
        let visible = usize::from(budget.saturating_sub(2)).min(attachments - 1);
        let hidden = attachments - visible;
        (visible, hidden, budget)
    } else {
        // Not enough room for a meaningful attachment block.
        (0, 0, 0)
    };
    let input_rows = interior.saturating_sub(attach_rows).max(1);
    Vertical {
        top_pad,
        bottom_pad,
        attach_visible: visible,
        attach_hidden: hidden,
        attach_rows,
        input_rows,
    }
}

/// Wrap the draft the way Codex's textarea does, including its insertion row:
/// a logical line that fills the whole width reserves an empty continuation row
/// so the caret never has to sit past the last cell.
fn composer_lines(input: &str, width: usize) -> Vec<WrappedLine> {
    let width = width.max(1);
    let sanitized = text::sanitize_for_composer(input);
    let raw = text::wrap_graphemes(&sanitized, width);
    let last = raw.len().saturating_sub(1);
    let mut lines: Vec<WrappedLine> = Vec::with_capacity(raw.len().saturating_add(1));
    for (index, line) in raw.iter().enumerate() {
        lines.push(line.clone());
        let ends_logical_line = line.hard || index == last;
        if ends_logical_line && text::display_width(&line.text) >= width {
            lines.push(WrappedLine {
                text: String::new(),
                start: line.end,
                end: line.end,
                hard: false,
            });
        }
    }
    if lines.is_empty() {
        lines.push(WrappedLine::default());
    }
    lines
}

/// Map the protocol's UTF-16 cursor index onto the wrapped lines built above.
/// A caret sitting past a full logical line moves onto its insertion row, which
/// is exactly where Codex's textarea puts it.
fn cursor_in_lines(lines: &[WrappedLine], grapheme_index: usize, width: usize) -> (usize, usize) {
    let width = width.max(1);
    let mut fallback = (0usize, 0usize);
    for (index, line) in lines.iter().enumerate() {
        if grapheme_index < line.end {
            let offset = grapheme_index.saturating_sub(line.start);
            return (
                index,
                text::width_of_prefix(&line.text, offset).min(width - 1),
            );
        }
        if grapheme_index == line.end {
            let column = text::display_width(&line.text);
            if line.hard {
                if column < width {
                    return (index, column);
                }
                // A full hard line ends on its insertion row (if one follows).
                if let Some(next) = lines.get(index.saturating_add(1)) {
                    if next.start == line.end && next.text.is_empty() {
                        return (index.saturating_add(1), 0);
                    }
                }
                return (index, width - 1);
            }
            fallback = (index, column.min(width - 1));
            continue;
        }
    }
    fallback
}

fn build_geometry(view: &View, area: Rect) -> Geometry {
    let (left_inset, right_inset) = insets(area.width);
    let content_width = area
        .width
        .saturating_sub(left_inset.saturating_add(right_inset))
        .max(1);
    let lines = composer_lines(&view.input, usize::from(content_width));
    let vertical = vertical_allocation(view.attachments.len(), area.height);

    let sanitized = text::sanitize_for_composer(&view.input);
    let grapheme_index = text::utf16_to_grapheme(&sanitized, view.input_cursor);
    let (cursor_row, cursor_col) =
        cursor_in_lines(&lines, grapheme_index, usize::from(content_width));

    let visible = usize::from(vertical.input_rows).max(1);
    let window_start = if cursor_row < visible {
        0
    } else {
        cursor_row.saturating_add(1).saturating_sub(visible)
    };
    let max_start = lines.len().saturating_sub(visible);
    let window_start = window_start.min(max_start);

    Geometry {
        left_inset,
        right_inset,
        content_width,
        top_pad: vertical.top_pad,
        attach_visible: vertical.attach_visible,
        attach_hidden: vertical.attach_hidden,
        attach_rows: vertical.attach_rows,
        input_rows: vertical.input_rows,
        lines,
        window_start,
        cursor_row: u16::try_from(cursor_row.saturating_sub(window_start)).unwrap_or(u16::MAX),
        cursor_col: u16::try_from(cursor_col).unwrap_or(u16::MAX),
    }
}

/// Rows the composer wants at `width`, clamped to `max_rows` (the Codex
/// two-thirds cap). Returns the rows the renderer will actually fill so a
/// clipped attachment block does not leave dead space.
pub fn desired_height(view: &View, width: u16, max_rows: u16) -> u16 {
    if width == 0 || max_rows == 0 {
        return 0;
    }
    let (left_inset, right_inset) = insets(width);
    let content_width = width
        .saturating_sub(left_inset.saturating_add(right_inset))
        .max(1);
    let lines = composer_lines(&view.input, usize::from(content_width));
    let line_rows = u16::try_from(lines.len()).unwrap_or(u16::MAX);
    let attachment_rows = if view.attachments.is_empty() {
        0
    } else {
        u16::try_from(view.attachments.len())
            .unwrap_or(u16::MAX)
            .saturating_add(1)
    };
    let natural = VERTICAL_PADDING
        .saturating_mul(2)
        .saturating_add(attachment_rows)
        .saturating_add(line_rows);
    if natural <= max_rows {
        return natural;
    }
    let vertical = vertical_allocation(view.attachments.len(), max_rows);
    let input_rows = vertical.input_rows.min(line_rows);
    vertical
        .top_pad
        .saturating_add(vertical.attach_rows)
        .saturating_add(input_rows)
        .saturating_add(vertical.bottom_pad)
}

fn attachment_line(name: &str, index: usize, content_width: u16) -> Line<'static> {
    let label = format!("[Image #{}]", index.saturating_add(1));
    let name = text::single_line(name);
    let name = if name.is_empty() {
        "(unnamed)".to_string()
    } else {
        name
    };
    let width = usize::from(content_width);
    let label_width = text::display_width(&label);
    if label_width.saturating_add(1) >= width {
        return Line::from(Span::styled(
            text::truncate_to_width(&label, width),
            theme::accent(),
        ));
    }
    let shown = text::truncate_to_width(&name, width - label_width - 1);
    Line::from(vec![
        Span::styled(label, theme::accent()),
        Span::raw(" "),
        Span::styled(shown, theme::secondary()),
    ])
}

fn attachment_summary_line(hidden: usize, content_width: u16) -> Line<'static> {
    let text = format!("… +{hidden}");
    Line::from(Span::styled(
        text::truncate_to_width(&text, usize::from(content_width)),
        theme::secondary(),
    ))
}

/// Draw the composer block. The cursor is reported separately by [`cursor`].
pub fn render(frame: &mut Frame, area: Rect, view: &View) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    frame.render_widget(Block::default().style(theme::composer_bg()), area);
    let geometry = build_geometry(view, area);

    // Attachments: one row each, then a blank separator row, like Codex's
    // remote image rows. The rows sit at the same left inset as the draft.
    let attach_top = area.y.saturating_add(geometry.top_pad);
    let attach_x = area.x.saturating_add(geometry.left_inset);
    for index in 0..geometry.attach_visible {
        let rect = Rect {
            x: attach_x,
            y: attach_top.saturating_add(index as u16),
            width: geometry.content_width,
            height: 1,
        };
        let line = attachment_line(&view.attachments[index].name, index, geometry.content_width);
        frame.render_widget(Paragraph::new(line), rect);
    }
    if geometry.attach_hidden > 0 {
        let rect = Rect {
            x: attach_x,
            y: attach_top.saturating_add(geometry.attach_visible as u16),
            width: geometry.content_width,
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(attachment_summary_line(
                geometry.attach_hidden,
                geometry.content_width,
            )),
            rect,
        );
    }

    let input_top = attach_top.saturating_add(geometry.attach_rows);
    if geometry.input_rows == 0 {
        return;
    }

    // The `›` prompt is a fixed affordance on the top visible input row (Codex
    // paints it at `textarea_rect.y`), so it stays visible while scrolling.
    if geometry.left_inset > 0 {
        let rect = Rect {
            x: area.x,
            y: input_top,
            width: geometry.left_inset,
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(Span::styled("›", theme::accent_bold())),
            rect,
        );
    }

    let text_x = area.x.saturating_add(geometry.left_inset);
    let visible = usize::from(geometry.input_rows);
    if view.input.is_empty() {
        // Parent-translated placeholder (`view.ui.placeholder`); a missing or
        // blank value keeps the built-in default, so old views are unchanged.
        let placeholder =
            text::single_line(text_or_default(&view.ui.placeholder, DEFAULT_PLACEHOLDER));
        let placeholder =
            text::truncate_to_width(&placeholder, usize::from(geometry.content_width));
        let rect = Rect {
            x: text_x,
            y: input_top,
            width: geometry.content_width,
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(Span::styled(placeholder, theme::secondary())),
            rect,
        );
    } else {
        let start = geometry.window_start;
        for (offset, wrapped) in geometry.lines.iter().skip(start).take(visible).enumerate() {
            let rect = Rect {
                x: text_x,
                y: input_top.saturating_add(offset as u16),
                width: geometry.content_width,
                height: 1,
            };
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(wrapped.text.clone(), Style::new()))),
                rect,
            );
        }
        // Overflow hints in the reserved right column, exactly like Codex.
        if geometry.right_inset > 0 {
            let right_x = area.x.saturating_add(area.width).saturating_sub(1);
            if start > 0 {
                let rect = Rect {
                    x: right_x,
                    y: input_top,
                    width: 1,
                    height: 1,
                };
                frame.render_widget(Paragraph::new(Span::styled("↑", theme::secondary())), rect);
            }
            if start.saturating_add(visible) < geometry.lines.len() {
                let rect = Rect {
                    x: right_x,
                    y: input_top.saturating_add(geometry.input_rows.saturating_sub(1)),
                    width: 1,
                    height: 1,
                };
                frame.render_widget(Paragraph::new(Span::styled("↓", theme::secondary())), rect);
            }
        }
    }
}

/// Absolute cursor position for the draft, or `None` when it is not visible.
pub fn cursor(view: &View, area: Rect) -> Option<Position> {
    if area.width == 0 || area.height == 0 {
        return None;
    }
    let geometry = build_geometry(view, area);
    if geometry.input_rows == 0 || geometry.cursor_row >= geometry.input_rows {
        return None;
    }
    let row = geometry
        .top_pad
        .saturating_add(geometry.attach_rows)
        .saturating_add(geometry.cursor_row);
    if row >= area.height {
        return None;
    }
    let column = geometry
        .left_inset
        .saturating_add(geometry.cursor_col)
        .min(area.width.saturating_sub(1));
    Some(Position::new(
        area.x.saturating_add(column),
        area.y.saturating_add(row),
    ))
}
