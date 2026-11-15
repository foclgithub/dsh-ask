//! Modal surfaces:
//!
//! * `kind == "commands"` — a slash-command popup glued directly above the
//!   composer (composer, input and cursor stay visible).
//! * everything else (`sessions`, `help`, missing/unknown) — a dedicated
//!   full-screen selection page: title, query, list, footer. The transcript and
//!   composer are not painted and the cursor is hidden.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};
use ratatui::Frame;

use crate::protocol::{
    text_or_default, Modal, Ui, View, DEFAULT_EMPTY_LIST, DEFAULT_MODAL_TITLE_HELP,
    DEFAULT_MODAL_TITLE_SESSIONS, DEFAULT_SEARCH_PLACEHOLDER,
};
use crate::render::theme;
use crate::text;

/// Maximum popup rows for the command menu.
pub const MAX_POPUP_ROWS: u16 = 8;

/// Popup rows the command menu would like to occupy (including the empty row).
pub fn popup_rows(modal: &Modal) -> u16 {
    if modal.items.is_empty() {
        1
    } else {
        modal.items.len().min(usize::from(MAX_POPUP_ROWS)) as u16
    }
}

/// Default page title when the parent sent no `modal.title`. The strings come
/// from `view.ui` (translated by the JS worker) and fall back to the built-in
/// titles, so an old view without `ui` keeps the old page.
fn default_title<'a>(kind: &str, ui: &'a Ui) -> &'a str {
    match kind {
        "help" => text_or_default(&ui.modal_title_help, DEFAULT_MODAL_TITLE_HELP),
        _ => text_or_default(&ui.modal_title_sessions, DEFAULT_MODAL_TITLE_SESSIONS),
    }
}

/// Empty-list row text: parent-translated `view.ui.emptyList`, built-in default
/// when missing/blank, sanitised and truncated never to overflow the area.
fn empty_list_line(ui: &Ui, width: usize) -> String {
    let text = text::single_line(text_or_default(&ui.empty_list, DEFAULT_EMPTY_LIST));
    text::truncate_to_width(&text, width.saturating_sub(2))
}

/// Draw the command popup into `area` (fixed height already allocated).
pub fn render_commands(frame: &mut Frame, area: Rect, modal: &Modal, ui: &Ui) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let width = usize::from(area.width);
    // Overlay: clear whatever transcript rows are underneath before painting
    // the menu so the popup reads as a stable surface.
    frame.render_widget(Clear, area);
    if modal.items.is_empty() {
        let line = Line::from(vec![
            Span::raw("  "),
            Span::styled(empty_list_line(ui, width), theme::secondary_italic()),
        ]);
        frame.render_widget(Paragraph::new(line), area);
        return;
    }
    let max_labels = modal
        .items
        .iter()
        .map(|item| text::display_width(&text::single_line(&item.label)))
        .max()
        .unwrap_or(0);
    let desc_column = (2 + max_labels + 2).min(width * 70 / 100);
    let selected = modal.selected.min(modal.items.len().saturating_sub(1));
    let visible = usize::from(area.height).min(modal.items.len());
    let start = if selected >= visible {
        (selected + 1 - visible).min(modal.items.len() - visible)
    } else {
        0
    };
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (offset, item) in modal.items.iter().skip(start).take(visible).enumerate() {
        let item_index = start + offset;
        let label = text::single_line(&item.label);
        let detail = text::single_line(&item.detail);
        let is_selected = item_index == selected;
        let mut spans: Vec<Span<'static>> = Vec::new();
        if is_selected {
            spans.push(Span::styled("› ", theme::accent_bold()));
        } else {
            spans.push(Span::raw("  "));
        }
        let name_budget = desc_column.saturating_sub(2).max(1);
        let label = text::truncate_to_width(&label, name_budget);
        let label_width = text::display_width(&label);
        spans.push(Span::styled(
            label.clone(),
            if is_selected {
                theme::selected()
            } else {
                theme::body()
            },
        ));
        let used = 2 + label_width;
        if width > used {
            let pad = desc_column.saturating_sub(used);
            if pad > 0 {
                spans.push(Span::raw(" ".repeat(pad)));
            }
            let detail_budget = width.saturating_sub(used + pad);
            if !detail.is_empty() && detail_budget > 2 {
                spans.push(Span::styled(
                    text::truncate_to_width(&detail, detail_budget),
                    theme::secondary(),
                ));
            }
        }
        lines.push(Line::from(spans));
    }
    if !lines.is_empty() {
        frame.render_widget(Paragraph::new(lines), area);
    }
}

fn page_footer_text<'a>(modal: &'a Modal, view: &'a View) -> &'a str {
    if modal.footer.trim().is_empty() {
        view.hint.as_str()
    } else {
        modal.footer.as_str()
    }
}

/// Draw the full-screen selection page for `sessions`/`help`/unknown kinds.
pub fn render_page(frame: &mut Frame, area: Rect, modal: &Modal, view: &View) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let width = usize::from(area.width);
    let height = usize::from(area.height);
    let footer = text::single_line(page_footer_text(modal, view));
    let footer_rows = if !footer.is_empty() && height >= 2 { 1 } else { 0 };
    let footer_top = area.y + area.height - footer_rows as u16;

    let show_query = modal.kind == "sessions" || !modal.query.trim().is_empty();
    let mut row = 0usize;
    let title = text::single_line(&modal.title);
    let title = if title.is_empty() {
        text::single_line(default_title(&modal.kind, &view.ui))
    } else {
        title
    };
    let title_line = Line::from(vec![
        Span::raw("  "),
        Span::styled(
            text::truncate_to_width(&title, width.saturating_sub(2)),
            theme::bold(),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(title_line),
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 1,
        },
    );
    row += 1;

    if show_query && row < height {
        let query = text::single_line(&modal.query);
        let query = if query.is_empty() {
            text::single_line(text_or_default(
                &view.ui.search_placeholder,
                DEFAULT_SEARCH_PLACEHOLDER,
            ))
        } else {
            query
        };
        let line = Line::from(vec![
            Span::raw("  "),
            Span::styled(
                text::truncate_to_width(&query, width.saturating_sub(2)),
                theme::secondary(),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(line),
            Rect {
                x: area.x,
                y: area.y + row as u16,
                width: area.width,
                height: 1,
            },
        );
        row += 1;
    }

    // Blank spacer between header and list when there is room.
    let list_top = row + 1;
    if list_top >= height.saturating_sub(footer_rows) {
        // Not enough room for a list; still draw the footer row below.
        if footer_rows > 0 {
            draw_page_footer(frame, area, footer_top, &footer);
        }
        return;
    }
    let list_height = height - list_top - footer_rows;
    if list_height > 0 {
        let list_area = Rect {
            x: area.x,
            y: area.y + list_top as u16,
            width: area.width,
            height: list_height as u16,
        };
        let lines = page_list_lines(modal, width, list_height, &view.ui);
        if !lines.is_empty() {
            frame.render_widget(Paragraph::new(lines), list_area);
        }
    }
    if footer_rows > 0 {
        draw_page_footer(frame, area, footer_top, &footer);
    }
}

fn draw_page_footer(frame: &mut Frame, area: Rect, y: u16, footer: &str) {
    let line = Line::from(vec![
        Span::raw("  "),
        Span::styled(
            text::truncate_to_width(footer, usize::from(area.width).saturating_sub(2)),
            theme::secondary(),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line),
        Rect {
            x: area.x,
            y,
            width: area.width,
            height: 1,
        },
    );
}

fn page_list_lines(modal: &Modal, width: usize, list_height: usize, ui: &Ui) -> Vec<Line<'static>> {
    if modal.items.is_empty() {
        return vec![Line::from(vec![
            Span::raw("  "),
            Span::styled(empty_list_line(ui, width), theme::secondary_italic()),
        ])];
    }
    let heights: Vec<usize> = modal
        .items
        .iter()
        .map(|item| {
            if text::single_line(&item.detail).is_empty() {
                1
            } else {
                2
            }
        })
        .collect();
    let selected = modal.selected.min(modal.items.len() - 1);
    let mut start = selected;
    let mut used = heights[selected];
    while start > 0 && used + heights[start - 1] <= list_height {
        start -= 1;
        used += heights[start];
    }
    let mut end = selected + 1;
    while end < modal.items.len() && used + heights[end] <= list_height {
        used += heights[end];
        end += 1;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut rows_left = list_height;
    for (index, item) in modal.items.iter().enumerate().skip(start).take(end - start) {
        let label = text::single_line(&item.label);
        let detail = text::single_line(&item.detail);
        let is_selected = index == selected;
        let mut label_spans: Vec<Span<'static>> = Vec::new();
        if is_selected {
            label_spans.push(Span::styled("› ", theme::accent_bold()));
        } else {
            label_spans.push(Span::raw("  "));
        }
        label_spans.push(Span::styled(
            text::truncate_to_width(&label, width.saturating_sub(2)),
            if is_selected {
                theme::selected()
            } else {
                theme::body()
            },
        ));
        if rows_left == 0 {
            break;
        }
        lines.push(Line::from(label_spans));
        rows_left -= 1;
        if !detail.is_empty() && rows_left > 0 {
            let line = Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    text::truncate_to_width(&detail, width.saturating_sub(2)),
                    theme::secondary(),
                ),
            ]);
            lines.push(line);
            rows_left -= 1;
        }
    }
    lines
}
