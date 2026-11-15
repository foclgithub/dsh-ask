//! Codex-style startup header: one blank row, the brand row, then the cwd row.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::protocol::View;
use crate::render::theme;
use crate::text;

/// Brand row: `  >_ dsh-ask` (`>_` accent bold, name bold).
pub fn title_line() -> Line<'static> {
    Line::from(vec![
        Span::raw("  "),
        Span::styled(">_ ", theme::accent_bold()),
        Span::styled("dsh-ask", theme::bold()),
    ])
}

/// Directory row: `     {cwd}` dim, truncated from the left when too wide.
pub fn cwd_line(view: &View, width: u16) -> Line<'static> {
    let width = usize::from(width);
    let available = width.saturating_sub(5);
    let cwd = text::single_line(&view.cwd);
    let shown = text::truncate_left_to_width(&cwd, available);
    Line::from(vec![
        Span::raw("     "),
        Span::styled(shown, theme::secondary()),
    ])
}

/// How many rows the header should occupy for a given terminal height.
/// `1` = brand row only, `2` = brand + cwd, `0` = skip the header entirely.
pub fn height_for(area_height: u16) -> u16 {
    match area_height {
        0..=2 => 0,
        3..=5 => 1,
        _ => 2,
    }
}

/// Draw the header rows into `area` (its height is `height_for(..)`).
pub fn render(frame: &mut Frame, area: Rect, view: &View) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let title_area = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: 1,
    };
    frame.render_widget(Paragraph::new(title_line()), title_area);
    if area.height >= 2 {
        let cwd_area = Rect {
            x: area.x,
            y: area.y + 1,
            width: area.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(cwd_line(view, area.width)), cwd_area);
    }
}
