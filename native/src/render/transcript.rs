//! Transcript: Codex-style message cells and bottom-anchored scrolling.
//!
//! Messages are rendered as visual-row blocks. Only the tail of the history
//! that the viewport (plus `scrollOffset`) needs is materialised, so a very
//! long transcript or a multi-thousand-line answer stays linear per frame.

use std::collections::VecDeque;

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::protocol::{Message, View};
use crate::render::theme;
use crate::text;

/// Hard cap on how many visual rows are materialised for one frame. Scrolling
/// further back than this simply pins the viewport to the oldest kept row.
const MAX_COLLECTED_LINES: usize = 20_000;

/// Upper bound on the bytes of one message that are parsed per frame. A
/// pathological single message must not stall the UI; only its tail is shown.
const MAX_MESSAGE_BYTES: usize = 1 << 20;

fn clamp_message_text(text: &str) -> &str {
    if text.len() <= MAX_MESSAGE_BYTES {
        return text;
    }
    let mut start = text.len() - MAX_MESSAGE_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn owned_blank(width: u16) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }
    Line::from(Span::styled(
        " ".repeat(usize::from(width)),
        theme::submitted_user_bg(),
    ))
}

/// Patch `line` onto the submitted-user-message background and pad it to the
/// full transcript width so the block reads as a solid band.
fn with_user_bg(mut line: Line<'static>, width: u16) -> Line<'static> {
    let width = usize::from(width);
    let mut used = 0usize;
    for span in line.spans.iter_mut() {
        let span_width = text::display_width(span.content.as_ref());
        used = used.saturating_add(span_width);
        span.style = span.style.bg(theme::SUBMITTED_USER_BG);
    }
    if width > used {
        line.spans.push(Span::styled(
            " ".repeat(width - used),
            theme::submitted_user_bg(),
        ));
    }
    line
}

fn user_block(messages: &[Message], index: usize, width: u16) -> Vec<Line<'static>> {
    let message = &messages[index];
    let previous_role = index
        .checked_sub(1)
        .and_then(|previous| messages.get(previous))
        .map(|previous| previous.role.as_str());
    let mut out: Vec<Line<'static>> = Vec::new();
    if previous_role != Some("user") {
        out.push(owned_blank(width));
    }
    let content_width = usize::from(width.saturating_sub(2)).max(1);
    let source = text::sanitize_display(clamp_message_text(&message.text));
    let markdown = text::in_markdown_lines(&source, content_width);
    for (line_index, line) in markdown.into_iter().enumerate() {
        let mut spans: Vec<Span<'static>> = Vec::new();
        if line_index == 0 {
            spans.push(Span::styled("› ", theme::accent_bold()));
        } else {
            spans.push(Span::raw("  "));
        }
        spans.extend(line.spans);
        out.push(with_user_bg(Line::from(spans), width));
    }
    out.push(owned_blank(width));
    out
}

fn assistant_block(messages: &[Message], index: usize, width: u16) -> Vec<Line<'static>> {
    let message = &messages[index];
    let previous_role = index
        .checked_sub(1)
        .and_then(|previous| messages.get(previous))
        .map(|previous| previous.role.as_str());
    let mut out: Vec<Line<'static>> = Vec::new();
    let source = text::sanitize_display(clamp_message_text(&message.text));
    let source = source.trim_matches('\n');
    if source.trim().is_empty() {
        return out;
    }
    if index > 0 && previous_role != Some("user") {
        out.push(Line::default());
    }
    let content_width = usize::from(width.saturating_sub(2)).max(1);
    let markdown = text::in_markdown_lines(source, content_width);
    for (line_index, line) in markdown.into_iter().enumerate() {
        // Fenced-code rows paint a full-width dark surface; extend it across the
        // assistant gutter so the block reads as one solid band.
        let code_surface = line
            .spans
            .iter()
            .any(|span| span.style.bg == Some(theme::CODE_BLOCK_BG));
        let mut spans: Vec<Span<'static>> = Vec::new();
        if line_index == 0 {
            spans.push(Span::styled("• ", theme::secondary()));
        } else if code_surface {
            spans.push(Span::styled(
                "  ",
                Style::new().bg(theme::CODE_BLOCK_BG),
            ));
        } else {
            spans.push(Span::raw("  "));
        }
        spans.extend(line.spans);
        out.push(Line::from(spans));
    }
    out
}

fn system_block(messages: &[Message], index: usize, width: u16) -> Vec<Line<'static>> {
    let message = &messages[index];
    let previous_role = index
        .checked_sub(1)
        .and_then(|previous| messages.get(previous))
        .map(|previous| previous.role.as_str());
    let mut out: Vec<Line<'static>> = Vec::new();
    let source = text::single_line(clamp_message_text(&message.text));
    if source.is_empty() {
        return out;
    }
    if index > 0 && previous_role != Some("user") {
        out.push(Line::default());
    }
    let content_width = usize::from(width.saturating_sub(2)).max(1);
    let wrapped = text::wrap_text(&source, content_width);
    // Codex renders tool/run results as `• ...`; when the business layer already
    // supplies a tree marker (`└`/`•`/`│`) keep it verbatim and never double up.
    let has_own_marker = source.starts_with(['└', '•', '│']);
    for (line_index, text_line) in wrapped.into_iter().enumerate() {
        let mut spans: Vec<Span<'static>> = Vec::new();
        if line_index == 0 {
            if !has_own_marker {
                spans.push(Span::styled("• ", theme::secondary()));
            }
        } else {
            spans.push(Span::raw("  "));
        }
        if line_index == 0 && text_line.starts_with('✓') {
            let mut chars = text_line.chars();
            chars.next();
            spans.push(Span::styled("✓", theme::success()));
            spans.push(Span::styled(chars.as_str().to_string(), theme::secondary()));
        } else if line_index == 0 && text_line.starts_with('✗') {
            let mut chars = text_line.chars();
            chars.next();
            spans.push(Span::styled("✗", theme::error()));
            spans.push(Span::styled(chars.as_str().to_string(), theme::secondary()));
        } else {
            spans.push(Span::styled(text_line, theme::secondary()));
        }
        out.push(Line::from(spans));
    }
    out
}

fn error_block(messages: &[Message], index: usize, width: u16) -> Vec<Line<'static>> {
    let message = &messages[index];
    let previous_role = index
        .checked_sub(1)
        .and_then(|previous| messages.get(previous))
        .map(|previous| previous.role.as_str());
    let mut out: Vec<Line<'static>> = Vec::new();
    let source = text::single_line(clamp_message_text(&message.text));
    if source.is_empty() {
        return out;
    }
    if index > 0 && previous_role != Some("user") {
        out.push(Line::default());
    }
    let content_width = usize::from(width.saturating_sub(2)).max(1);
    for (line_index, text_line) in text::wrap_text(&source, content_width).into_iter().enumerate() {
        let mut spans: Vec<Span<'static>> = Vec::new();
        if line_index == 0 {
            spans.push(Span::styled("! ", theme::error_bold()));
        } else {
            spans.push(Span::raw("  "));
        }
        spans.push(Span::styled(text_line, theme::error()));
        out.push(Line::from(spans));
    }
    out
}

fn block_for(messages: &[Message], index: usize, width: u16) -> Vec<Line<'static>> {
    match messages[index].role.as_str() {
        "user" => user_block(messages, index, width),
        "assistant" => assistant_block(messages, index, width),
        "error" => error_block(messages, index, width),
        _ => system_block(messages, index, width),
    }
}

fn build_viewport_lines(view: &View, width: u16, height: u16) -> Vec<Line<'static>> {
    let viewport = usize::from(height);
    if viewport == 0 || view.messages.is_empty() {
        return Vec::new();
    }
    let offset = view.scroll_offset.min(MAX_COLLECTED_LINES);
    let wanted = viewport.saturating_add(offset).min(MAX_COLLECTED_LINES);
    let mut collected: VecDeque<Line<'static>> = VecDeque::new();
    for index in (0..view.messages.len()).rev() {
        let mut block = block_for(&view.messages, index, width);
        let remaining = wanted.saturating_sub(collected.len());
        if remaining == 0 {
            break;
        }
        // Only the tail of each block can land inside the window; keeping just
        // that slice bounds memory even for one very long message.
        if block.len() > remaining {
            block = block.split_off(block.len() - remaining);
        }
        for line in block.into_iter().rev() {
            collected.push_front(line);
        }
        if collected.len() >= wanted {
            break;
        }
    }
    let total = collected.len();
    let lines: Vec<Line<'static>> = if total >= wanted {
        collected
            .into_iter()
            .skip(total - wanted)
            .take(viewport)
            .collect()
    } else {
        // Short transcript: content sits at the top of the viewport.
        collected.into_iter().take(viewport).collect()
    };
    lines
}

/// Draw the transcript viewport, bottom-anchored with `scrollOffset` lines of
/// history kept in view.
pub fn render(frame: &mut Frame, area: Rect, view: &View) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let lines = build_viewport_lines(view, area.width, area.height);
    if lines.is_empty() {
        return;
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// Convenience for tests/debug: the content that `render` would paint.
pub fn visual_lines(view: &View, width: u16, height: u16) -> Vec<String> {
    build_viewport_lines(view, width, height)
        .into_iter()
        .map(|line| line.to_string())
        .collect()
}
