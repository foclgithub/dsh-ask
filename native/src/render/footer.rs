//! Bottom chrome: the persistent status block, the hint row and the
//! "back to bottom" gap row shown while the transcript is scrolled up.
//!
//! The status block has two shapes:
//!
//! * legacy views (no `statusLines`): one row
//!   `  {model} · {project} · {sessionTitle}[ · {status}]`, dim; and
//! * parent-formatted views: up to [`MAX_STATUS_ROWS`] rows whose text the JS
//!   worker already formatted from the desktop DSH model/effort, permission,
//!   context, token, cache, turn/step and speed figures. This layer never
//!   computes those numbers; it only sanitises, indents and truncates them.
//!
//! Every status row keeps two columns free on the left *and* on the right, and
//! the layout treats the block as separate rows *below* the composer, so it can
//! never eat into the composer block or its padding.

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::protocol::{text_or_default, Ui, View, DEFAULT_BACK_TO_BOTTOM, DEFAULT_HINT_FALLBACK};
use crate::render::theme;
use crate::text;

/// Maximum number of rows the parent-formatted status block may occupy.
pub const MAX_STATUS_ROWS: u16 = 2;

/// Columns kept free on both sides of each parent-formatted status row.
const STATUS_INSET: usize = 2;

/// Parent-formatted status rows after sanitising: escape sequences/control
/// characters neutralised, blank rows dropped (a row made only of control
/// characters must not consume a line), capped at [`MAX_STATUS_ROWS`].
fn formatted_status_rows(view: &View) -> Vec<String> {
    view.status_lines
        .iter()
        .map(|line| text::single_line(line))
        .filter(|line| !line.is_empty())
        .take(usize::from(MAX_STATUS_ROWS))
        .collect()
}

/// Rows the status block wants at full size: two when the parent sent two
/// usable rows, otherwise one. Legacy views (no `statusLines`) keep their one
/// row, exactly as before the field existed.
pub fn desired_height(view: &View) -> u16 {
    match formatted_status_rows(view).len() {
        0 => 1,
        rows => rows as u16,
    }
}

/// Legacy single status row: `  {model} · {project} · {sessionTitle}[ · {status}]`, dim.
///
/// Narrow terminals drop the session title first, then the project, exactly as
/// specified for the Codex snapshot footer.
pub fn status_line(view: &View, width: usize) -> Line<'static> {
    let mut status = String::new();
    if !view.status.is_empty() && view.status != "ready" {
        status = text::single_line(&view.status);
    }

    let model = text::single_line(&view.model);
    let project = text::single_line(&view.project);
    let title = text::single_line(&view.session_title);

    // Drop order on narrow terminals: session title first, then project, then
    // the status suffix; the model name is the last thing kept.
    let candidates: [(Vec<&str>, bool); 6] = [
        (vec![&model, &project, &title], true),
        (vec![&model, &project], true),
        (vec![&model], true),
        (vec![&model], false),
        (vec![], true),
        (vec![], false),
    ];
    let mut chosen: Vec<&str> = vec![];
    for (mut parts, include_status) in candidates {
        parts.retain(|part| !part.is_empty());
        if include_status && !status.is_empty() {
            parts.push(&status);
        }
        let join_width: usize = parts
            .iter()
            .map(|part| text::display_width(part))
            .sum::<usize>()
            + parts.len().saturating_sub(1) * 3;
        if join_width + 2 <= width {
            chosen = parts;
            break;
        }
    }

    let mut spans: Vec<Span<'static>> = vec![Span::raw("  ")];
    for (index, part) in chosen.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", theme::secondary()));
        }
        spans.push(Span::styled((*part).to_string(), theme::secondary()));
    }
    Line::from(spans)
}

/// One parent-formatted status row: two-column left inset, two columns kept
/// free on the right, control characters already neutralised by
/// [`text::single_line`] and Unicode-safe truncation (grapheme clusters are
/// never split; a dropped tail becomes `…`).
pub fn parent_status_line(line: &str, width: usize) -> Line<'static> {
    let clean = text::single_line(line);
    let left = STATUS_INSET.min(width);
    let right = STATUS_INSET.min(width.saturating_sub(left));
    let available = width.saturating_sub(left).saturating_sub(right);
    let shown = text::truncate_to_width(&clean, available);
    Line::from(vec![
        Span::raw(" ".repeat(left)),
        Span::styled(shown, theme::secondary()),
    ])
}

/// Lines to draw for the status block: parent-formatted rows when present,
/// otherwise the legacy single row. `rows` is the layout's allowance; when the
/// window is too small for two rows the first (identity) row is kept and the
/// metrics row is dropped before the input starts shrinking.
pub fn status_block(view: &View, width: usize, rows: u16) -> Vec<Line<'static>> {
    let rows = usize::from(rows.min(MAX_STATUS_ROWS));
    if rows == 0 {
        return Vec::new();
    }
    let formatted = formatted_status_rows(view);
    if formatted.is_empty() {
        return vec![status_line(view, width)];
    }
    formatted
        .iter()
        .take(rows)
        .map(|line| parent_status_line(line, width))
        .collect()
}

/// Draw the persistent status block (up to [`MAX_STATUS_ROWS`] rows).
pub fn render_status(frame: &mut Frame, area: Rect, view: &View) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let lines = status_block(view, usize::from(area.width), area.height);
    if lines.is_empty() {
        return;
    }
    let rect = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: u16::try_from(lines.len()).unwrap_or(MAX_STATUS_ROWS),
    };
    frame.render_widget(Paragraph::new(lines), rect);
}

/// Draw the contextual hint row. An empty hint falls back to
/// `view.ui.hintFallback` and then to the built-in `? for shortcuts`, so old
/// views without `ui` keep the old row.
pub fn render_hint(frame: &mut Frame, area: Rect, hint: &str, ui: &Ui) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let hint = text::single_line(hint);
    let hint = if hint.is_empty() {
        text::single_line(text_or_default(&ui.hint_fallback, DEFAULT_HINT_FALLBACK))
    } else {
        hint
    };
    let available = usize::from(area.width).saturating_sub(2);
    let shown = text::truncate_to_width(&hint, available);
    let line = Line::from(vec![
        Span::raw("  "),
        Span::styled(shown, theme::secondary()),
    ]);
    let rect = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: 1,
    };
    frame.render_widget(Paragraph::new(line), rect);
}

/// Candidate "back to bottom" labels, longest first: the parent-translated
/// `view.ui.backToBottom` variants, or the built-in four when the list is
/// missing/blank. Each label is sanitised to a single line and capped at four.
fn back_to_bottom_variants(ui: &Ui) -> Vec<String> {
    let mut variants: Vec<String> = ui
        .back_to_bottom
        .iter()
        .map(|variant| text::single_line(variant))
        .filter(|variant| !variant.is_empty())
        .take(DEFAULT_BACK_TO_BOTTOM.len())
        .collect();
    if variants.is_empty() {
        variants = DEFAULT_BACK_TO_BOTTOM
            .iter()
            .map(|variant| (*variant).to_string())
            .collect();
    }
    variants
}

/// First (longest) variant that fits `width`; the shortest one otherwise (the
/// caller truncates it), matching the legacy fallback.
fn gap_label<'a>(variants: &'a [String], width: usize) -> &'a str {
    if let Some(variant) = variants
        .iter()
        .find(|variant| text::display_width(variant) <= width)
    {
        return variant;
    }
    variants
        .last()
        .map(String::as_str)
        .unwrap_or(DEFAULT_BACK_TO_BOTTOM[3])
}

/// The one-row gap between transcript and composer. While the transcript is
/// scrolled up it carries the centred "back to bottom" control, labelled with
/// the parent-translated `view.ui.backToBottom` variants when provided.
pub fn render_gap(frame: &mut Frame, area: Rect, scroll_offset: usize, ui: &Ui) {
    if area.width == 0 || area.height == 0 || scroll_offset == 0 {
        return;
    }
    let width = usize::from(area.width);
    let variants = back_to_bottom_variants(ui);
    let chosen = gap_label(&variants, width);
    let shown = text::truncate_to_width(chosen, width);
    let pad = width.saturating_sub(text::display_width(&shown)) / 2;
    let line = Line::from(vec![
        Span::raw(" ".repeat(pad)),
        Span::styled(shown, theme::secondary()),
    ]);
    let rect = Rect {
        x: area.x,
        y: area.y,
        width: area.width,
        height: 1,
    };
    frame.render_widget(Paragraph::new(line), rect);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view_with(lines: &[&str]) -> View {
        View {
            model: "deepseek-v4-flash".into(),
            project: "dsh-local-cli".into(),
            session_title: "Fix retry logic".into(),
            status: "ready".into(),
            status_lines: lines.iter().map(|line| (*line).to_string()).collect(),
            ..View::default()
        }
    }

    fn line_text(line: &Line<'static>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn legacy_view_without_status_lines_keeps_one_old_row() {
        let view = view_with(&[]);
        assert_eq!(desired_height(&view), 1);
        let block = status_block(&view, 80, 2);
        assert_eq!(block.len(), 1, "无 statusLines 时只渲染旧状态行");
        let text = line_text(&block[0]);
        assert!(text.contains("deepseek-v4-flash"), "{text:?}");
        assert!(text.contains("dsh-local-cli"), "{text:?}");
        assert!(text.contains("Fix retry logic"), "{text:?}");
        assert!(text.starts_with("  "), "旧状态行保留 2 列缩进: {text:?}");
    }

    #[test]
    fn two_parent_rows_are_rendered_with_side_insets() {
        let view = view_with(&[
            "deepseek-v4 · high · acceptEdits",
            "ctx 42% · tok 12.3k · cache 88% · 3轮/7步 · 18 tok/s",
        ]);
        assert_eq!(desired_height(&view), 2);
        let block = status_block(&view, 100, 2);
        assert_eq!(block.len(), 2);
        for line in &block {
            let text = line_text(line);
            assert!(text.starts_with("  "), "每行左侧 2 列缩进: {text:?}");
            assert!(
                text::display_width(&text) <= 100 - 4,
                "左侧 2 列 + 右侧 2 列之外才是内容区，行宽 {} 超限: {text:?}",
                text::display_width(&text)
            );
        }
        assert!(line_text(&block[0]).contains("deepseek-v4"));
        assert!(line_text(&block[1]).contains("ctx 42%"));
    }

    #[test]
    fn narrow_chinese_window_truncates_on_grapheme_boundaries() {
        let view = view_with(&[
            "深度求索模型 · 高推理 · 默认权限",
            "上下文 88% · 缓存命中 91% · 每秒 42 个令牌",
        ]);
        let block = status_block(&view, 16, 2);
        assert_eq!(block.len(), 2);
        for line in &block {
            let text = line_text(line);
            assert!(
                text::display_width(&text) <= 14,
                "16 列窗口扣除左右各 2 列后最多 14 列: {text:?} ({} 列)",
                text::display_width(&text)
            );
            assert!(text.ends_with('…'), "被裁掉的行必须以 … 结尾: {text:?}");
        }
    }

    #[test]
    fn control_characters_are_scrubbed_before_drawing() {
        let view = view_with(&[
            "\u{1b}[31mdeepseek-v4\u{1b}[0m\u{7}",
            "\u{1b}]0;title\u{7}ctx 42%",
        ]);
        let block = status_block(&view, 60, 2);
        let first = line_text(&block[0]);
        let second = line_text(&block[1]);
        assert!(!first.contains('\u{1b}') && !first.contains('\u{7}'), "{first:?}");
        assert!(first.contains("deepseek-v4"), "{first:?}");
        assert!(!second.contains('\u{1b}') && !second.contains('\u{7}'), "{second:?}");
        assert!(second.contains("ctx 42%"), "{second:?}");
    }

    #[test]
    fn control_only_rows_fall_back_to_the_legacy_row() {
        let view = view_with(&["\u{1b}[0m", "\u{7}"]);
        assert_eq!(desired_height(&view), 1);
        let block = status_block(&view, 80, 2);
        assert_eq!(block.len(), 1);
        assert!(line_text(&block[0]).contains("deepseek-v4-flash"));
    }

    #[test]
    fn extra_rows_are_capped_and_shrinking_keeps_the_first_row() {
        let view = view_with(&["row one", "row two", "row three"]);
        assert_eq!(desired_height(&view), 2, "statusLines 最多两行");
        let full = status_block(&view, 60, 2);
        assert_eq!(full.len(), 2);
        let shrunk = status_block(&view, 60, 1);
        assert_eq!(shrunk.len(), 1);
        assert!(line_text(&shrunk[0]).contains("row one"));
    }

    #[test]
    fn zero_allowance_draws_nothing() {
        let view = view_with(&["a", "b"]);
        assert!(status_block(&view, 40, 0).is_empty());
    }

    #[test]
    fn back_to_bottom_variants_default_to_the_builtin_four() {
        let variants = back_to_bottom_variants(&Ui::default());
        assert_eq!(
            variants,
            DEFAULT_BACK_TO_BOTTOM
                .iter()
                .map(|variant| (*variant).to_string())
                .collect::<Vec<_>>(),
            "没有 ui 时四档文案必须保持原样"
        );
    }

    #[test]
    fn back_to_bottom_variants_use_parent_labels_and_cap_at_four() {
        let ui = Ui {
            back_to_bottom: vec![
                "↓ 回到最新 · esc".into(),
                "↓ 最新 · esc".into(),
                "↓ 最新".into(),
                "↓".into(),
                "第五档不应被使用".into(),
            ],
            ..Ui::default()
        };
        assert_eq!(
            back_to_bottom_variants(&ui),
            vec!["↓ 回到最新 · esc", "↓ 最新 · esc", "↓ 最新", "↓"]
        );
    }

    #[test]
    fn blank_back_to_bottom_entries_fall_back_to_the_builtin_four() {
        for blank in [vec![], vec!["".into(), "  ".into()]] {
            let ui = Ui {
                back_to_bottom: blank.clone(),
                ..Ui::default()
            };
            assert_eq!(
                back_to_bottom_variants(&ui).len(),
                DEFAULT_BACK_TO_BOTTOM.len(),
                "{blank:?}"
            );
        }
        // 单档空白被过滤，其余正常保留。
        let ui = Ui {
            back_to_bottom: vec!["↓ 回到最新 · esc".into(), "   ".into(), "↓".into()],
            ..Ui::default()
        };
        assert_eq!(back_to_bottom_variants(&ui), vec!["↓ 回到最新 · esc", "↓"]);
    }

    #[test]
    fn gap_label_picks_the_longest_variant_that_fits() {
        let variants = back_to_bottom_variants(&Ui::default());
        let long = text::display_width("↓ Back to bottom · esc");
        let medium = text::display_width("↓ Bottom · esc");
        let short = text::display_width("↓ Bottom");
        let arrow = text::display_width("↓");
        assert_eq!(gap_label(&variants, long), "↓ Back to bottom · esc");
        assert_eq!(gap_label(&variants, long - 1), "↓ Bottom · esc");
        assert_eq!(gap_label(&variants, medium - 1), "↓ Bottom");
        assert_eq!(gap_label(&variants, short - 1), "↓");
        assert_eq!(gap_label(&variants, arrow - 1), "↓", "全都不够宽时用最短档");
    }
}
