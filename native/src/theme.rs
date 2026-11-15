//! Fixed display palette approximating local Codex 0.30 for a dark terminal.
//!
//! The renderer is intentionally a pure function of `View` + frame size, so the
//! palette cannot probe the real terminal background at draw time. These values
//! are the dark-terminal approximation agreed for dsh-ask:
//!
//! * `COMPOSER_BG` — Codex `user_message_style` (12% white blended over a dark
//!   background) as a concrete RGB.
//! * `SUBMITTED_USER_BG` — Codex `history_prompt_style` (16% white blend), one
//!   step brighter than the composer.
//! * Everything with no explicit colour keeps `Color::Reset` so the terminal's
//!   own foreground is used for body text.

use ratatui::style::{Color, Modifier, Style};

/// ChatGPT Blue 200 (`#63A8F8`), Codex's shared accent.
pub const ACCENT: Color = Color::Rgb(99, 168, 248);

/// Secondary/dim text (`header` cwd, hints, status line, tool steps).
pub const SECONDARY: Color = Color::Rgb(150, 150, 150);

/// Failure / error highlights.
pub const ERROR: Color = Color::Rgb(230, 100, 100);

/// Success glyphs (`✓`).
pub const SUCCESS: Color = Color::Green;

/// Composer surface, painted behind the whole input block.
pub const COMPOSER_BG: Color = Color::Rgb(38, 38, 38);

/// Submitted user-message block; slightly brighter than the composer.
pub const SUBMITTED_USER_BG: Color = Color::Rgb(52, 52, 52);

/// Fenced code block surface.
pub const CODE_BLOCK_BG: Color = Color::Rgb(26, 26, 26);

/// Code text on the block surface.
pub const CODE_FG: Color = Color::Rgb(214, 214, 214);

/// Inline `code` surface + foreground.
pub const INLINE_CODE_BG: Color = Color::Rgb(58, 58, 58);
pub const INLINE_CODE_FG: Color = Color::Rgb(222, 222, 222);

/// Accent foreground.
pub fn accent() -> Style {
    Style::new().fg(ACCENT)
}

/// Accent + bold, used for the `>_` brand mark and the `›` prompt.
pub fn accent_bold() -> Style {
    Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)
}

/// Dim/secondary text.
pub fn secondary() -> Style {
    Style::new().fg(SECONDARY)
}

/// Dim italic (placeholder, code-block language tags, `no matches`).
pub fn secondary_italic() -> Style {
    Style::new()
        .fg(SECONDARY)
        .add_modifier(Modifier::ITALIC)
}

/// Error text; red per the visual spec.
pub fn error() -> Style {
    Style::new().fg(ERROR)
}

/// Bold error prefix (`! `).
pub fn error_bold() -> Style {
    Style::new().fg(ERROR).add_modifier(Modifier::BOLD)
}

/// Success glyph (`✓`).
pub fn success() -> Style {
    Style::new().fg(SUCCESS)
}

/// Bold body text (headings, brand, selected rows).
pub fn bold() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

/// Accent + bold + underline for selected picker rows.
pub fn selected() -> Style {
    Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)
}

/// Composer background fill.
pub fn composer_bg() -> Style {
    Style::new().bg(COMPOSER_BG)
}

/// Submitted user message background fill.
pub fn submitted_user_bg() -> Style {
    Style::new().bg(SUBMITTED_USER_BG)
}

/// Fenced code block background fill.
pub fn code_block_bg() -> Style {
    Style::new().bg(CODE_BLOCK_BG)
}

/// Inline code span.
pub fn inline_code() -> Style {
    Style::new().fg(INLINE_CODE_FG).bg(INLINE_CODE_BG)
}

/// Plain body text, i.e. the terminal's own foreground.
pub fn body() -> Style {
    Style::new()
}
