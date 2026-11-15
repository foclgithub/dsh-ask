//! Width, grapheme, sanitising, wrapping, cursor and lightweight Markdown
//! helpers shared by the renderer.
//!
//! Design constraints:
//! * No new dependencies: Markdown is parsed line-by-line with a small linear
//!   state machine (`pulldown-cmark` is deliberately not in `Cargo.toml`).
//! * Terminal-safe: view text is untrusted, so escape sequences and control
//!   characters are stripped before anything reaches the terminal buffer.
//! * Width-correct: every measurement is grapheme based (`unicode-segmentation`)
//!   with display widths from `unicode-width`, so CJK and emoji never straddle a
//!   boundary and the composer cursor lands on the right cell.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::render::theme;

// ---------------------------------------------------------------------------
// Grapheme helpers
// ---------------------------------------------------------------------------

/// Number of grapheme clusters in `text`.
pub fn grapheme_count(text: &str) -> usize {
    if text.is_ascii() {
        return text.len();
    }
    text.graphemes(true).count()
}

/// Clamp a UTF-16 code unit index into `text` to a grapheme boundary, returning
/// the grapheme index the cursor should sit at.
pub fn utf16_to_grapheme(text: &str, utf16_index: usize) -> usize {
    if text.is_ascii() {
        return utf16_index.min(text.len());
    }
    let mut units = 0usize;
    for (index, grapheme) in text.graphemes(true).enumerate() {
        if units >= utf16_index {
            return index;
        }
        units += grapheme.encode_utf16().count();
    }
    grapheme_count(text)
}

/// Inverse of [`utf16_to_grapheme`].
pub fn grapheme_to_utf16(text: &str, grapheme_index: usize) -> usize {
    if text.is_ascii() {
        return grapheme_index.min(text.len());
    }
    text.graphemes(true)
        .take(grapheme_index)
        .map(|g| g.encode_utf16().count())
        .sum()
}

fn grapheme_width(grapheme: &str) -> usize {
    if grapheme == "\t" {
        return 4;
    }
    UnicodeWidthStr::width(grapheme)
}

/// Display width in terminal cells (`unicode-width`), control characters
/// contribute nothing except a tab, which counts as four cells.
pub fn display_width(text: &str) -> usize {
    if text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return text.len();
    }
    text.graphemes(true).map(grapheme_width).sum()
}

/// Width of the first `count` grapheme clusters of `text`.
///
/// Shared with the composer so its caret columns match the wrapping used for
/// drawing (CJK/emoji are two cells, a tab is four).
pub fn width_of_prefix(text: &str, count: usize) -> usize {
    text.graphemes(true)
        .take(count)
        .map(grapheme_width)
        .sum::<usize>()
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

/// Strip ANSI/OSC escape sequences and neutralise remaining control characters
/// while keeping `\n` as a line separator (tabs expand to four spaces).
pub fn sanitize_display(text: &str) -> String {
    if !text.chars().any(|c| c.is_control()) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some('P') | Some('^') | Some('_') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match c {
            '\n' => out.push('\n'),
            '\t' => out.push_str("    "),
            '\r' => {}
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Sanitise composer input **without changing the grapheme count**: every
/// control char other than `\n` becomes a single space. This keeps the
/// UTF-16→grapheme→cell mapping valid even for pasted escape sequences.
pub fn sanitize_for_composer(text: &str) -> String {
    if !text.chars().any(|c| c != '\n' && c.is_control()) {
        return text.to_string();
    }
    text.chars()
        .map(|c| if c != '\n' && c.is_control() { ' ' } else { c })
        .collect()
}

/// Flatten untrusted single-line text: escapes stripped, newlines collapsed to
/// one space, whitespace trimmed.
pub fn single_line(text: &str) -> String {
    let cleaned = sanitize_display(text);
    let mut out = String::with_capacity(cleaned.len());
    let mut last_space = false;
    for c in cleaned.chars() {
        let c = if c == '\n' { ' ' } else { c };
        if c == ' ' {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/// Truncate `text` to at most `width` display cells, appending `…` when
/// something was dropped. Grapheme clusters are never split.
pub fn truncate_to_width(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if display_width(text) <= width {
        return text.to_string();
    }
    let budget = width.saturating_sub(1);
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let w = grapheme_width(grapheme);
        if used + w > budget {
            break;
        }
        used += w;
        out.push_str(grapheme);
    }
    out.push('…');
    out
}

/// Truncate from the left (paths, cwd), prefixing `…` when something was cut.
pub fn truncate_left_to_width(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if display_width(text) <= width {
        return text.to_string();
    }
    let budget = width.saturating_sub(1);
    let mut collected: Vec<&str> = Vec::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true).rev() {
        let w = grapheme_width(grapheme);
        if used + w > budget {
            break;
        }
        used += w;
        collected.push(grapheme);
    }
    let mut out = String::from("…");
    for grapheme in collected.into_iter().rev() {
        out.push_str(grapheme);
    }
    out
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/// One visual line produced by [`wrap_graphemes`].
///
/// `start`/`end` are grapheme indices into the source text (`end` exclusive),
/// and `hard` is true when the line was terminated by an explicit `\n` (as
/// opposed to a soft wrap). Cursor mapping needs both.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WrappedLine {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub hard: bool,
}

/// Wrap `text` to `width` display cells, keeping grapheme clusters intact and
/// preserving explicit `\n` breaks. English words break at spaces; CJK and
/// emoji break between clusters. Never panics, even for `width == 0`.
pub fn wrap_graphemes(text: &str, width: usize) -> Vec<WrappedLine> {
    let width = width.max(1);
    let graphemes: Vec<&str> = text.graphemes(true).collect();
    let mut out: Vec<WrappedLine> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut cur_width = 0usize;
    let mut cur_start = 0usize;
    let mut last_space: Option<usize> = None;
    let mut index = 0usize;

    while index < graphemes.len() {
        let grapheme = graphemes[index];
        if grapheme == "\n" {
            out.push(WrappedLine {
                text: cur.concat(),
                start: cur_start,
                end: index,
                hard: true,
            });
            cur.clear();
            cur_width = 0;
            last_space = None;
            index += 1;
            cur_start = index;
            continue;
        }
        let w = grapheme_width(grapheme);
        if cur_width + w <= width || cur.is_empty() {
            if grapheme == " " {
                last_space = Some(cur.len());
            }
            cur.push(grapheme);
            cur_width += w;
            index += 1;
            continue;
        }
        if let Some(space) = last_space.filter(|space| *space > 0) {
            let line_end = cur_start + space;
            out.push(WrappedLine {
                text: cur[..space].concat(),
                start: cur_start,
                end: line_end,
                hard: false,
            });
            cur.drain(..=space);
            cur_start = line_end + 1;
            cur_width = cur.iter().map(|g| grapheme_width(g)).sum();
            last_space = cur.iter().rposition(|g| *g == " ");
            continue;
        }
        let line_end = cur_start + cur.len();
        out.push(WrappedLine {
            text: cur.concat(),
            start: cur_start,
            end: line_end,
            hard: false,
        });
        cur_start = line_end;
        cur.clear();
        cur_width = 0;
        last_space = None;
    }
    out.push(WrappedLine {
        text: cur.concat(),
        start: cur_start,
        end: graphemes.len(),
        hard: false,
    });
    out
}

/// Convenience wrapper over [`wrap_graphemes`] returning plain strings.
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    wrap_graphemes(text, width)
        .into_iter()
        .map(|line| line.text)
        .collect()
}

/// Map a UTF-16 cursor index (`inputCursor`) into `(visual_row, cell_column)`
/// after soft-wrapping at `width`.
///
/// The UTF-16 index is clamped, then mapped onto a grapheme boundary; the cell
/// column is the display width of the graphemes before the cursor on its
/// wrapped line.
pub fn cursor_position(text: &str, utf16_index: usize, width: usize) -> (usize, usize) {
    let text = sanitize_for_composer(text);
    let utf16_len = text.encode_utf16().count();
    let grapheme_index = utf16_to_grapheme(&text, utf16_index.min(utf16_len));
    let lines = wrap_graphemes(&text, width);
    let mut fallback = (0usize, 0usize);
    for (row, line) in lines.iter().enumerate() {
        if grapheme_index < line.end {
            let offset = grapheme_index.saturating_sub(line.start);
            return (row, width_of_prefix(&line.text, offset));
        }
        if grapheme_index == line.end {
            if line.hard {
                return (row, display_width(&line.text));
            }
            fallback = (row, display_width(&line.text));
            // Soft break: a cursor exactly on the boundary belongs to the start
            // of the next visual line (the next grapheme is printed there).
            continue;
        }
    }
    if let Some((row, _)) = lines.iter().enumerate().next_back() {
        let _ = row;
    }
    let last = lines.len().saturating_sub(1);
    if let Some(line) = lines.get(last) {
        fallback = (last, display_width(&line.text));
    }
    fallback
}

// ---------------------------------------------------------------------------
// Inline Markdown
// ---------------------------------------------------------------------------

type InlineStyle = Style;

fn flush_span(spans: &mut Vec<Span<'static>>, buf: &mut String, style: InlineStyle) {
    if buf.is_empty() {
        return;
    }
    spans.push(Span::styled(std::mem::take(buf), style));
}

fn style_with(base: InlineStyle, bold: bool, italic: bool, strike: bool) -> InlineStyle {
    let mut style = base;
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if italic {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if strike {
        style = style.add_modifier(Modifier::CROSSED_OUT);
    }
    style
}

/// Parse inline Markdown (`code`, bold, italic, strikethrough, links) into
/// styled spans. Unsafe text must already be sanitised by the caller.
fn inline_spans(text: &str, base: InlineStyle) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut buf = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;
    let mut index = 0usize;
    while index < text.len() {
        let rest = &text[index..];
        let style = style_with(base, bold, italic, strike);
        if rest.starts_with("**") || rest.starts_with("__") {
            flush_span(&mut spans, &mut buf, style);
            bold = !bold;
            index += 2;
            continue;
        }
        if rest.starts_with("~~") {
            flush_span(&mut spans, &mut buf, style);
            strike = !strike;
            index += 2;
            continue;
        }
        if rest.starts_with('`') {
            if let Some(close) = rest[1..].find('`') {
                flush_span(&mut spans, &mut buf, style);
                let content = &rest[1..1 + close];
                if !content.is_empty() {
                    spans.push(Span::styled(content.to_string(), theme::inline_code()));
                }
                index += close + 2;
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("![") {
            if let Some((label, url, used)) = parse_link_body(after) {
                flush_span(&mut spans, &mut buf, style);
                if !label.is_empty() {
                    spans.push(Span::styled(label.to_string(), style));
                }
                if !url.is_empty() {
                    spans.push(Span::styled(
                        format!(" ({url})"),
                        theme::secondary().patch(style),
                    ));
                }
                index += 2 + used;
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix('[') {
            if let Some((label, url, used)) = parse_link_body(after) {
                flush_span(&mut spans, &mut buf, style);
                if !label.is_empty() {
                    spans.push(Span::styled(label.to_string(), style));
                }
                if !url.is_empty() {
                    spans.push(Span::styled(
                        format!(" ({url})"),
                        theme::secondary().patch(style),
                    ));
                }
                index += 1 + used;
                continue;
            }
        }
        if rest.starts_with('*') || rest.starts_with('_') {
            flush_span(&mut spans, &mut buf, style);
            italic = !italic;
            index += 1;
            continue;
        }
        if let Some(next) = rest.strip_prefix('\\') {
            if let Some(ch) = next.chars().next() {
                buf.push(ch);
                index += 1 + ch.len_utf8();
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        buf.push(ch);
        index += ch.len_utf8();
    }
    flush_span(&mut spans, &mut buf, style_with(base, bold, italic, strike));
    if spans.is_empty() {
        spans.push(Span::raw(String::new()));
    }
    spans
}

/// Parse `label](url)` (the opening `[` was already stripped).
/// Returns `(label, url, consumed_bytes_including_closing_paren)`.
fn parse_link_body(text: &str) -> Option<(&str, &str, usize)> {
    let close = text.find("](")?;
    let label = &text[..close];
    let rest = &text[close + 2..];
    let end = rest.find(')')?;
    let url = &rest[..end];
    Some((label, url, close + 2 + end + 1))
}

// ---------------------------------------------------------------------------
// Block level Markdown
// ---------------------------------------------------------------------------

fn leading_spaces(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn atx_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if rest.is_empty() {
        return Some((hashes, ""));
    }
    rest.strip_prefix(' ').map(|rest| (hashes, rest))
}

fn is_thematic_break(trimmed: &str) -> bool {
    let mut marker: Option<char> = None;
    let mut count = 0usize;
    for ch in trimmed.chars() {
        match ch {
            ' ' | '\t' => {}
            '-' | '*' | '_' => {
                if let Some(existing) = marker {
                    if existing != ch {
                        return false;
                    }
                } else {
                    marker = Some(ch);
                }
                count += 1;
            }
            _ => return false,
        }
    }
    count >= 3
}

fn ordered_marker(line: &str) -> Option<(&str, &str)> {
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &line[digits..];
    let rest = rest.strip_prefix(['.', ')'])?;
    let rest = rest.strip_prefix(' ')?;
    Some((&line[..digits + 2], rest))
}

fn unordered_marker(line: &str) -> Option<(&'static str, &str)> {
    if let Some(rest) = line.strip_prefix("- ") {
        Some(("• ", rest))
    } else if let Some(rest) = line.strip_prefix("* ") {
        Some(("• ", rest))
    } else if let Some(rest) = line.strip_prefix("+ ") {
        Some(("• ", rest))
    } else {
        None
    }
}

fn task_marker(rest: &str) -> Option<(&'static str, &str)> {
    let rest = rest.trim_start();
    if let Some(rest) = rest.strip_prefix("[ ] ") {
        Some(("☐ ", rest))
    } else if let Some(rest) = rest.strip_prefix("[x] ").or_else(|| rest.strip_prefix("[X] ")) {
        Some(("☑ ", rest))
    } else {
        None
    }
}

fn spans_width(spans: &[Span<'static>]) -> usize {
    spans
        .iter()
        .map(|span| display_width(span.content.as_ref()))
        .sum()
}

/// Append `content` wrapped to `width`, with `first`/`rest` prefixes.
fn push_prefixed_wrapped(
    out: &mut Vec<Line<'static>>,
    first: &[Span<'static>],
    rest: &[Span<'static>],
    content: &str,
    width: usize,
    body: InlineStyle,
) {
    let first_width = spans_width(first);
    let rest_width = spans_width(rest);
    let prefix_width = first_width.max(rest_width);
    let content_width = width.saturating_sub(prefix_width).max(1);
    let wrapped = wrap_text(content, content_width);
    for (index, text) in wrapped.into_iter().enumerate() {
        let mut spans: Vec<Span<'static>> = Vec::new();
        if index == 0 {
            spans.extend(first.iter().cloned());
        } else {
            spans.extend(rest.iter().cloned());
        }
        spans.extend(inline_spans(&text, body));
        out.push(Line::from(spans));
    }
}

fn code_row(indent: usize, content: Option<&str>, width: usize) -> Line<'static> {
    let indent = indent.min(width.saturating_sub(1));
    let prefix = format!("{}▌ ", " ".repeat(indent));
    let prefix_width = display_width(&prefix);
    let background = Style::new().bg(theme::CODE_BLOCK_BG);
    let mut spans: Vec<Span<'static>> = vec![Span::styled(
        prefix,
        theme::secondary().patch(background),
    )];
    let available = width.saturating_sub(prefix_width);
    let text = content.unwrap_or("");
    let truncated = if available == 0 {
        String::new()
    } else if display_width(text) > available {
        truncate_to_width(text, available)
    } else {
        text.to_string()
    };
    let used = display_width(&truncated);
    if !truncated.is_empty() {
        spans.push(Span::styled(
            truncated,
            Style::new()
                .fg(theme::CODE_FG)
                .patch(background),
        ));
    }
    let pad = width.saturating_sub(prefix_width + used);
    if pad > 0 {
        spans.push(Span::styled(" ".repeat(pad), background));
    }
    Line::from(spans)
}

/// Render a Markdown string into styled ratatui lines clamped to `width`.
///
/// Supported: ATX headings, unordered/ordered lists (with task-list boxes),
/// fenced code blocks (language tag + left rule + dark surface), block quotes,
/// thematic breaks, inline code/emphasis/strikethrough, and links degraded to
/// `label (url)`. Tables and HTML degrade to plain text lines.
pub fn in_markdown_lines(text: &str, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let source = sanitize_display(text);
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut lines = source.split('\n').peekable();
    while let Some(raw) = lines.next() {
        let indent = leading_spaces(raw).min(width.saturating_sub(1));
        let body = &raw[indent.min(raw.len())..];
        let trimmed = body.trim_start();

        // Fenced code block.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let fence_char = trimmed.chars().next().unwrap_or('`');
            let fence_len = trimmed.chars().take_while(|c| *c == fence_char).count();
            let info = trimmed[fence_len..].trim();
            let language = info.split_whitespace().next().unwrap_or("").to_string();
            if !language.is_empty() {
                out.push(code_row(indent, Some(&language), width));
            } else {
                out.push(code_row(indent, None, width));
            }
            while let Some(code_raw) = lines.next() {
                let code_trimmed = code_raw.trim_start();
                let is_close = code_trimmed.starts_with(fence_char)
                    && code_trimmed.chars().take_while(|c| *c == fence_char).count() >= fence_len
                    && code_trimmed.trim().chars().all(|c| c == fence_char);
                if is_close {
                    break;
                }
                out.push(code_row(indent, Some(code_raw), width));
            }
            continue;
        }

        // ATX heading.
        if let Some((level, content)) = atx_heading(trimmed) {
            let marker_style = theme::accent();
            let body_style = if level <= 2 {
                Style::new()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().add_modifier(Modifier::BOLD)
            };
            let marker = format!("{} ", "#".repeat(level));
            let first = vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(marker.clone(), marker_style),
            ];
            let rest = vec![Span::raw(" ".repeat(indent + marker.len()))];
            push_prefixed_wrapped(&mut out, &first, &rest, content.trim_end(), width, body_style);
            continue;
        }

        // Thematic break.
        if is_thematic_break(trimmed) {
            out.push(Line::from(Span::styled(
                "─".repeat(width),
                theme::secondary(),
            )));
            continue;
        }

        // Block quote.
        if let Some(quoted) = trimmed.strip_prefix('>') {
            let content = quoted.trim_start();
            let first = vec![
                Span::raw(" ".repeat(indent)),
                Span::styled("│ ", theme::secondary()),
            ];
            let rest = vec![Span::raw(" ".repeat(indent + 2))];
            let body = Style::new()
                .fg(theme::SECONDARY)
                .add_modifier(Modifier::ITALIC);
            push_prefixed_wrapped(&mut out, &first, &rest, content, width, body);
            continue;
        }

        // Unordered list item (with optional task box).
        if let Some((marker, content)) = unordered_marker(body) {
            let (marker, content) = match task_marker(content) {
                Some((task, rest)) => (task, rest),
                None => (marker, content),
            };
            let first = vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(marker, theme::secondary()),
            ];
            let rest = vec![Span::raw(" ".repeat(indent + 2))];
            push_prefixed_wrapped(&mut out, &first, &rest, content, width, theme::body());
            continue;
        }

        // Ordered list item: keep the original number marker, dimmed.
        if let Some((marker, content)) = ordered_marker(body) {
            let first = vec![
                Span::raw(" ".repeat(indent)),
                Span::styled(marker.to_string(), theme::secondary()),
            ];
            let rest = vec![Span::raw(" ".repeat(indent + marker.chars().count()))];
            push_prefixed_wrapped(&mut out, &first, &rest, content, width, theme::body());
            continue;
        }

        // Paragraph (tables and HTML also degrade to text here).
        if body.is_empty() {
            out.push(Line::default());
            continue;
        }
        for wrapped in wrap_text(body, width.saturating_sub(indent).max(1)) {
            let mut spans: Vec<Span<'static>> = Vec::new();
            if indent > 0 {
                spans.push(Span::raw(" ".repeat(indent)));
            }
            spans.extend(inline_spans(&wrapped, theme::body()));
            out.push(Line::from(spans));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths_cover_ascii_cjk_and_emoji() {
        assert_eq!(display_width("hello"), 5);
        assert_eq!(display_width("中文"), 4);
        assert_eq!(display_width("😀"), 2);
        assert_eq!(display_width("e\u{301}"), 1);
        assert_eq!(display_width("a\tb"), 6);
    }

    #[test]
    fn truncation_keeps_graphemes() {
        assert_eq!(truncate_to_width("中文中文", 5), "中文…");
        assert_eq!(truncate_to_width("abc", 3), "abc");
        assert_eq!(truncate_to_width("abc", 0), "");
        assert_eq!(truncate_to_width("😀😀", 3), "😀…");
        assert_eq!(truncate_left_to_width("/a/b/c", 5), "…/b/c");
    }

    #[test]
    fn wrapping_is_width_exact_and_preserves_newlines() {
        let wrapped = wrap_text("abcdef\ngh", 3);
        assert_eq!(wrapped, vec!["abc", "def", "gh"]);
        let cjk = wrap_text("中文中文", 4);
        assert_eq!(cjk, vec!["中文", "中文"]);
        for line in wrap_text("a b c d e", 3) {
            assert!(display_width(&line) <= 3, "line too wide: {line:?}");
        }
        assert_eq!(wrap_text("", 4), vec![""]);
        assert_eq!(wrap_text("ab\n", 4), vec!["ab", ""]);
    }

    #[test]
    fn cursor_mapping_handles_utf16_and_soft_wrap() {
        assert_eq!(cursor_position("abc", 1, 80), (0, 1));
        assert_eq!(cursor_position("中文", 2, 80), (0, 4));
        assert_eq!(cursor_position("😀a", 2, 80), (0, 2));
        // Clamp past the end.
        assert_eq!(cursor_position("ab", 99, 80), (0, 2));
        // Soft wrap: boundary belongs to the next visual line.
        assert_eq!(cursor_position("abcdef", 3, 3), (1, 0));
        // Hard wrap: boundary belongs to the end of the first line.
        assert_eq!(cursor_position("abc\ndef", 3, 3), (0, 3));
    }

    #[test]
    fn markdown_renders_common_constructs() {
        let lines = in_markdown_lines(
            "# Title\n\n- one\n- two\n\n```rust\nfn main() {}\n```\n\n> quote\n\n**bold** and `code`",
            40,
        );
        let rendered: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert!(rendered.iter().any(|l| l.contains("# Title")));
        assert!(rendered.iter().any(|l| l.contains("• one")));
        assert!(rendered.iter().any(|l| l.contains("▌ rust")));
        assert!(rendered.iter().any(|l| l.contains("fn main() {}")));
        assert!(rendered.iter().any(|l| l.contains("│ quote")));
        assert!(rendered.iter().any(|l| l.contains("bold") && l.contains("code")));
    }

    #[test]
    fn markdown_strips_escape_sequences() {
        let lines = in_markdown_lines("hello \u{1b}[31mred\u{1b}[0m", 40);
        let rendered: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        assert_eq!(rendered, vec!["hello red"]);
    }

    #[test]
    fn composer_sanitise_preserves_grapheme_count() {
        let text = "a\u{1b}[31mb\tc";
        assert_eq!(sanitize_for_composer(text).chars().count(), text.chars().count());
        assert_eq!(sanitize_display(text), "ab    c");
        assert_eq!(sanitize_for_composer(text), "a [31mb c");
    }
}
