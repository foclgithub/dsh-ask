//! 渲染层快照/布局契约（协议文档 §4；视觉规格由本文件的快照固化）。
//!
//! 全部用 ratatui `TestBackend` 离屏渲染，不启动真实终端、不依赖时间/随机：
//!
//! * 空 transcript 的 header / composer / status / hint 位置与 composer 背景色；
//! * 多角色消息的角色前缀、user 整块背景、消息之间互不覆盖；
//! * Markdown（标题/列表/围栏代码块/行内 code）与中文+emoji 宽度；
//! * `scrollOffset` 的视口滚动语义与越界 clamp；
//! * `modal.kind == "commands"`：composer 仍可见、popup 贴 composer 上方且 ≤8 行，
//!   且 popup 不改变 header/composer/status/hint 的位置、不重绘 transcript 其余行；
//! * `sessions`/`help`：全屏页，不画 transcript/composer，光标隐藏；
//! * 窄屏/极小屏不 panic、任何一行显示宽度不超过屏宽；
//! * UTF-16 `inputCursor` → `render::cursor` 的单调、宽字符边界映射。
//!
//! 说明：`render::compute_layout` 未公开，因此布局断言全部从**渲染后的 buffer**
//! 反推（按内容找行、按背景色找 composer 块），不锁具体行号常量；popup 回归只断言
//! “非 popup 区域内容/位置不变”，这样渲染器之后调整 popup overlay 也不会误报。

use dsh_ask_ui::protocol::{Message, Modal, ModalItem, View};
use dsh_ask_ui::render;
use dsh_ask_ui::text;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::Color;
use ratatui::Terminal;
use unicode_width::UnicodeWidthStr;

// ---------------------------------------------------------------------------
// 渲染与 buffer 查询辅助
// ---------------------------------------------------------------------------

/// 用 TestBackend 渲染一帧并返回 buffer（纯离屏，无 TTY）。
fn render(view: &View, width: u16, height: u16) -> Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("TestBackend 必须能初始化 Terminal");
    terminal
        .draw(|frame| render::draw(frame, view))
        .expect("render::draw 不得失败：越界/panic 都算契约破坏");
    terminal.backend().buffer().clone()
}

fn area(width: u16, height: u16) -> Rect {
    Rect::new(0, 0, width, height)
}

/// 一行的**逻辑文本**：跳过宽字符（CJK/emoji）被 ratatui reset 掉的续行单元格，
/// 这样字符串与终端显示内容一一对应，`text::display_width` 就是该行占用的列数。
fn row_text(buffer: &Buffer, y: u16) -> String {
    let mut out = String::new();
    let mut x = buffer.area.left();
    while x < buffer.area.right() {
        let symbol = buffer[(x, y)].symbol();
        out.push_str(symbol);
        // 与 ratatui 写入时的宽度计算保持一致（同一 unicode-width 实现）。
        let advance = u16::try_from(UnicodeWidthStr::width(symbol))
            .unwrap_or(1)
            .max(1);
        x = x.saturating_add(advance);
    }
    out
}

fn rows_of(buffer: &Buffer) -> Vec<String> {
    (buffer.area.top()..buffer.area.bottom())
        .map(|y| row_text(buffer, y))
        .collect()
}

/// 找包含 `needle` 的行号；找不到时把当前画面打进 panic 便于定位。
fn find_row(rows: &[String], needle: &str) -> u16 {
    rows.iter()
        .position(|row| row.contains(needle))
        .unwrap_or_else(|| panic!("画面里找不到 {needle:?}；当前画面：{rows:#?}"))
        .try_into()
        .expect("行号必须落在 u16")
}

/// 断言整屏没有任何一行的显示宽度超过屏宽（宽字符不得越界/被劈开）。
fn assert_rows_fit(buffer: &Buffer) {
    let width = usize::from(buffer.area.width);
    for (y, row) in rows_of(buffer).iter().enumerate() {
        let display = text::display_width(row);
        assert!(
            display <= width,
            "第 {y} 行显示宽度 {display} 超过屏宽 {width}: {row:?}"
        );
    }
}

/// composer 背景块的行号（整块涂 `COMPOSER_BG`，可按背景色定位）。
fn composer_rows(buffer: &Buffer) -> Vec<u16> {
    (buffer.area.top()..buffer.area.bottom())
        .filter(|&y| buffer[(buffer.area.left(), y)].bg == Color::Rgb(38, 38, 38))
        .collect()
}

/// 取 composer 块的 (top, bottom)，并断言是连续的一整块。
fn composer_span(buffer: &Buffer) -> (u16, u16) {
    let rows = composer_rows(buffer);
    assert!(
        !rows.is_empty(),
        "composer 必须可见（应有 Rgb(38,38,38) 背景块），实际画面：{:#?}",
        rows_of(buffer)
    );
    for pair in rows.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "composer 背景必须是连续整块，实际行：{rows:?}"
        );
    }
    (rows[0], *rows.last().expect("非空"))
}

/// 指定背景色的连续单元格片段（用来断言 inline code / code block 的底色范围）。
fn bg_runs(buffer: &Buffer, y: u16, bg: Color) -> Vec<String> {
    let mut runs: Vec<String> = Vec::new();
    let mut current = String::new();
    for x in buffer.area.left()..buffer.area.right() {
        let cell = &buffer[(x, y)];
        if cell.bg == bg {
            current.push_str(cell.symbol());
        } else if !current.is_empty() {
            runs.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}

// ---------------------------------------------------------------------------
// View 构造
// ---------------------------------------------------------------------------

fn message(role: &str, text: &str) -> Message {
    Message {
        role: role.to_string(),
        text: text.to_string(),
    }
}

/// 一段典型会话：四种角色各一条，输入框有草稿。
fn chat_view() -> View {
    View {
        project: "dsh-local-cli".to_string(),
        cwd: "/Users/example/workspace/dsh-local-cli".to_string(),
        session_title: "修复重试逻辑".to_string(),
        session_id: "session-1".to_string(),
        model: "deepseek-v4-flash".to_string(),
        status: "ready".to_string(),
        status_lines: Vec::new(),
        messages: vec![
            message("user", "帮我看看这个重试逻辑"),
            message("assistant", "好的，先看实现"),
            message("system", "read_file src/app.rs"),
            message("error", "请求失败 · timeout"),
        ],
        input: "继续".to_string(),
        input_cursor: 2,
        attachments: vec![],
        hint: "Enter 发送 · Alt+Enter 换行".to_string(),
        ui: Default::default(),
        scroll_offset: 0,
        modal: None,
    }
}

/// 空会话：没有消息，输入为空（显示 placeholder）。
fn empty_view() -> View {
    View {
        project: "dsh-local-cli".to_string(),
        cwd: "/Users/example/workspace/dsh-local-cli".to_string(),
        session_title: String::new(),
        session_id: String::new(),
        model: "deepseek-v4-flash".to_string(),
        status: "ready".to_string(),
        status_lines: Vec::new(),
        messages: Vec::new(),
        input: String::new(),
        input_cursor: 0,
        attachments: Vec::new(),
        hint: "Enter 发送 · Alt+Enter 换行".to_string(),
        ui: Default::default(),
        scroll_offset: 0,
        modal: None,
    }
}

fn commands_modal() -> Modal {
    Modal {
        kind: "commands".to_string(),
        title: "命令".to_string(),
        items: vec![
            ModalItem {
                label: "/help".to_string(),
                detail: "显示帮助".to_string(),
            },
            ModalItem {
                label: "/quit".to_string(),
                detail: "退出".to_string(),
            },
        ],
        selected: 0,
        query: "/".to_string(),
        footer: String::new(),
    }
}

// ---------------------------------------------------------------------------
// 1) 空 transcript 的 80x24 布局
// ---------------------------------------------------------------------------

#[test]
fn empty_transcript_80x24_has_codex_layout_and_grey_composer() {
    let view = empty_view();
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);
    assert_eq!(rows.len(), 24);

    // header：先一行留白，然后 brand 行 + cwd 行（Codex 启动快照规格）。
    let brand_y = find_row(&rows, ">_ dsh-ask");
    let cwd_y = find_row(&rows, &view.cwd);
    assert!(
        rows[brand_y as usize].starts_with("  >_ dsh-ask"),
        "brand 行必须前导 2 空格: {:?}",
        rows[brand_y as usize]
    );
    assert_eq!(cwd_y, brand_y + 1, "header 必须是连续的 brand 行 + cwd 行");
    assert!(
        rows[(brand_y - 1) as usize].trim().is_empty(),
        "header 上方必须留一行空白"
    );

    // 空 transcript：header 与 composer 之间（含 gap 行）全部留白。
    let (composer_top, composer_bottom) = composer_span(&buffer);
    for y in (cwd_y + 1)..composer_top {
        assert!(
            rows[y as usize].trim().is_empty(),
            "空 transcript 时第 {y} 行必须留白，实际 {:?}",
            rows[y as usize]
        );
    }

    // Codex composer 几何：整块 = 顶部留白行 + 输入行 + 底部留白行（空态 3 行）。
    let input_y = composer_top + 1;
    assert_eq!(
        composer_bottom,
        composer_top + 2,
        "空态 composer 必须恰好 3 行（上下 padding + 输入行）"
    );
    assert!(
        rows[composer_top as usize].trim().is_empty(),
        "composer 顶部必须是灰色留白行: {:?}",
        rows[composer_top as usize]
    );
    assert!(
        rows[input_y as usize].starts_with("› "),
        "composer 输入行必须以 `› ` 提示符开头: {:?}",
        rows[input_y as usize]
    );
    assert!(
        rows[input_y as usize].contains("Ask dsh-ask to do anything"),
        "空输入必须显示 placeholder"
    );
    assert!(
        rows[composer_bottom as usize].trim().is_empty(),
        "composer 底部必须是灰色留白行: {:?}",
        rows[composer_bottom as usize]
    );
    assert_eq!(
        render::theme::COMPOSER_BG,
        Color::Rgb(38, 38, 38),
        "composer 背景色必须是 Rgb(38,38,38)"
    );
    // 灰底覆盖 composer 整块（含上下 padding 行与提示符/文本行）。
    for y in composer_top..=composer_bottom {
        for x in [0u16, 1, 2, 3, 40, 79] {
            assert_eq!(
                buffer[(x, y)].bg,
                Color::Rgb(38, 38, 38),
                "composer 第 {y} 行必须整行铺 Rgb(38,38,38) 背景（x={x}）"
            );
        }
    }

    // 底部固定 chrome：composer → status → 贴底 hint。
    let status_y = composer_bottom + 1;
    let hint_y = 23u16;
    assert!(
        status_y < hint_y,
        "状态行必须在贴底提示行之上（status={status_y}, hint={hint_y}）"
    );
    assert!(
        rows[status_y as usize].contains(&view.model),
        "状态行必须含 model: {:?}",
        rows[status_y as usize]
    );
    assert!(
        rows[status_y as usize].contains(&view.project),
        "状态行必须含 project: {:?}",
        rows[status_y as usize]
    );
    assert!(
        rows[hint_y as usize].contains(&view.hint),
        "提示行必须显示 view.hint: {:?}",
        rows[hint_y as usize]
    );

    // 空输入的光标：输入行起点（`› ` gutter 之后、placeholder 之前）。
    let cursor = render::cursor(&view, area(80, 24)).expect("composer 可见时光标必须存在");
    assert_eq!(
        cursor,
        Position::new(2, input_y),
        "空输入时光标应停在 composer 输入行行首 `› ` 之后"
    );
    assert_rows_fit(&buffer);
}

// ---------------------------------------------------------------------------
// 2) 多角色消息：前缀 / 背景 / 互不覆盖
// ---------------------------------------------------------------------------

#[test]
fn multi_role_messages_keep_prefixes_and_user_block_background() {
    let view = chat_view();
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    let user_y = find_row(&rows, "帮我看看这个重试逻辑");
    let assistant_y = find_row(&rows, "好的，先看实现");
    let system_y = find_row(&rows, "read_file src/app.rs");
    let error_y = find_row(&rows, "请求失败 · timeout");

    // 顺序：user → assistant → system → error。
    assert!(user_y < assistant_y, "user 消息必须排在 assistant 之前");
    assert!(assistant_y < system_y, "assistant 必须先于后续 system 消息");
    assert!(system_y < error_y, "error 消息必须排在最后");

    // 角色前缀（Codex 视觉规格 §2）。
    assert!(
        rows[user_y as usize].starts_with("› "),
        "user 首行必须 `› ` 开头: {:?}",
        rows[user_y as usize]
    );
    assert!(
        rows[assistant_y as usize].starts_with("• "),
        "assistant 首行必须 `• ` 开头: {:?}",
        rows[assistant_y as usize]
    );
    assert!(
        rows[system_y as usize].starts_with("• "),
        "system 消息前缀必须是 `• `（spec §2 工具/运行结果样式）: {:?}",
        rows[system_y as usize]
    );
    assert!(
        rows[error_y as usize].starts_with("! "),
        "error 消息前缀必须是 `! `: {:?}",
        rows[error_y as usize]
    );

    // user 消息是整块背景（含前后各一行空白），左右都铺满 Rgb(52,52,52)。
    for y in [user_y - 1, user_y, user_y + 1] {
        assert_eq!(
            buffer[(0, y)].bg,
            Color::Rgb(52, 52, 52),
            "user 消息块第 {y} 行左侧必须涂 Rgb(52,52,52)"
        );
        assert_eq!(
            buffer[(79, y)].bg,
            Color::Rgb(52, 52, 52),
            "user 消息块第 {y} 行右侧也必须铺满背景"
        );
    }
    // assistant/system 正文不涂背景（保留终端默认底色）。
    assert_eq!(
        buffer[(0, assistant_y)].bg,
        Color::Reset,
        "assistant 消息不得涂背景"
    );

    // error 正文使用错误红。
    assert_eq!(
        buffer[(2, error_y)].fg,
        Color::Rgb(230, 100, 100),
        "error 正文必须是错误红 Rgb(230,100,100)"
    );

    // 每条消息正文只出现在一行，消息之间不互相覆盖。
    for needle in [
        "帮我看看这个重试逻辑",
        "好的，先看实现",
        "read_file src/app.rs",
        "请求失败 · timeout",
    ] {
        assert_eq!(
            rows.iter().filter(|row| row.contains(needle)).count(),
            1,
            "{needle:?} 必须恰好出现在一行（消息之间不得互相覆盖）"
        );
    }
    assert_rows_fit(&buffer);
}

#[test]
fn long_message_wraps_without_overflow() {
    let mut view = empty_view();
    // 无空格超长 ASCII + 超长中文/emoji 混合，强制软换行。
    view.messages = vec![message(
        "assistant",
        &format!("{}{}", "a".repeat(500), "中文😀测试".repeat(30)),
    )];
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    assert_rows_fit(&buffer);
    // 确实发生了换行：至少 6 行含连续 a。
    let rows_with_a: Vec<u16> = (0..24u16)
        .filter(|&y| rows[y as usize].contains("aaaa"))
        .collect();
    assert!(
        rows_with_a.len() >= 6,
        "500 字符长消息必须在 80 列内换成多行"
    );
    // 首行保留 assistant 的 `• ` 前缀，其余换行行保持 2 列缩进。
    assert!(
        rows[rows_with_a[0] as usize].starts_with("• "),
        "assistant 首行必须 `• ` 开头: {:?}",
        rows[rows_with_a[0] as usize]
    );
    for &wrapped_y in &rows_with_a[1..] {
        assert!(
            rows[wrapped_y as usize].starts_with("  "),
            "换行后的 assistant 正文行必须保持 2 列缩进: {:?}",
            rows[wrapped_y as usize]
        );
    }
}

// ---------------------------------------------------------------------------
// 3) Markdown：标题 / 列表 / 代码块 / 行内 code
// ---------------------------------------------------------------------------

#[test]
fn markdown_renders_headings_lists_fenced_code_and_inline_code() {
    let mut view = empty_view();
    view.messages = vec![message(
        "assistant",
        "# 一级标题\n\n- 列表项甲\n- 列表项乙\n\n```rust\nfn main() {}\n```\n\n行内 `code` 与中文😀测试",
    )];
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    // 标题保留 `# ` 标记。
    let heading_y = find_row(&rows, "一级标题");
    assert!(
        rows[heading_y as usize].contains("# 一级标题"),
        "标题必须渲染为 `# 一级标题`: {:?}",
        rows[heading_y as usize]
    );
    // 无序列表变成 `• ` 项目符号。
    assert!(
        rows.iter().any(|row| row.contains("• 列表项甲")),
        "无序列表项必须渲染为 `• ` 行"
    );
    // 围栏代码块：语言标签 + 左侧竖线规则 + 代码正文（Codex 视觉规格）。
    let lang_y = find_row(&rows, "rust");
    assert!(
        rows[lang_y as usize].contains('▌'),
        "代码块语言标签行必须带 `▌` 左规则: {:?}",
        rows[lang_y as usize]
    );
    let code_y = find_row(&rows, "fn main() {}");
    assert!(
        rows[code_y as usize].contains('▌'),
        "代码正文行必须带 `▌` 左规则: {:?}",
        rows[code_y as usize]
    );
    // 代码块正文涂深色底 Rgb(26,26,26)。assistant 正文整体缩进 2 列，
    // 因此底色块从 x=2 开始（与正文缩进一致，左侧 2 列保留默认底色）。
    assert_eq!(
        buffer[(2, code_y)].bg,
        Color::Rgb(26, 26, 26),
        "代码块正文必须铺 Rgb(26,26,26) 底色"
    );
    let rule = bg_runs(&buffer, code_y, Color::Rgb(26, 26, 26));
    assert!(
        rule.iter().any(|run| run.contains("fn main() {}")),
        "代码正文必须在 Rgb(26,26,26) 底色块内，实际底色段 {rule:?}"
    );

    // 行内 code：反引号去掉，渲染为 Rgb(58,58,58) 底色片段。
    let inline_y = find_row(&rows, "code");
    assert!(
        rows[inline_y as usize].contains("行内 code"),
        "行内 code 必须去掉反引号后显示: {:?}",
        rows[inline_y as usize]
    );
    let inline_runs = bg_runs(&buffer, inline_y, Color::Rgb(58, 58, 58));
    assert!(
        inline_runs.iter().any(|run| run == "code"),
        "行内 code 必须以 Rgb(58,58,58) 底色渲染，实际底色段 {inline_runs:?}"
    );
    // 中文+emoji 行完整保留。
    assert!(
        rows[inline_y as usize].contains("中文😀测试"),
        "中文+emoji 必须完整显示在一行内: {:?}",
        rows[inline_y as usize]
    );
    assert_rows_fit(&buffer);
}

#[test]
fn cjk_and_emoji_rows_fit_the_screen() {
    let mut view = empty_view();
    view.messages = vec![message(
        "assistant",
        &"中文😀测试中文😀测试".repeat(6),
    )];
    view.input = "中文😀输入".to_string();
    view.input_cursor = 7;
    for width in [80u16, 40, 20] {
        let buffer = render(&view, width, 24);
        assert_rows_fit(&buffer);
        let rows = rows_of(&buffer);
        assert!(
            rows.iter().any(|row| row.contains("中文😀测试")),
            "{width} 列下中文+emoji 正文必须可见"
        );
    }
}

// ---------------------------------------------------------------------------
// 4) scrollOffset 滚动语义
// ---------------------------------------------------------------------------

/// 30 条单行消息：足够撑满 transcript，便于断言“最新消息/更早消息”集合。
fn scroll_view(offset: usize) -> View {
    let mut view = empty_view();
    view.messages = (1..=30)
        .map(|index| message("assistant", &format!("message-{index:02}")))
        .collect();
    view.scroll_offset = offset;
    view
}

#[test]
fn scroll_offset_zero_shows_latest_and_positive_offset_shows_older_rows() {
    let buffer_latest = render(&scroll_view(0), 80, 24);
    let rows_latest = rows_of(&buffer_latest);
    let buffer_older = render(&scroll_view(5), 80, 24);
    let rows_older = rows_of(&buffer_older);

    // offset=0 贴最新消息：最后一条可见，最早一条不可见。
    assert!(
        rows_latest.iter().any(|row| row.contains("message-30")),
        "scrollOffset=0 必须显示最新消息 message-30"
    );
    assert!(
        !rows_latest.iter().any(|row| row.contains("message-01")),
        "scrollOffset=0 不应显示最早消息 message-01"
    );

    // offset=5 往回翻 5 行：视口整体上移，可见集合不同且不再显示最新消息。
    assert_ne!(
        rows_latest, rows_older,
        "scrollOffset=5 渲染出的 transcript 必须与 scrollOffset=0 不同"
    );
    assert!(
        rows_older.iter().any(|row| row.contains("message-27")),
        "scrollOffset=5 应能看到更早的 message-27"
    );
    assert!(
        !rows_older.iter().any(|row| row.contains("message-30")),
        "scrollOffset=5 视口上移后不应再显示最新消息 message-30"
    );

    // 滚动时 gap 行显示“回到最新”提示，且不改变底部 chrome 的位置。
    let (composer_top, _) = composer_span(&buffer_older);
    assert!(
        rows_older[(composer_top - 1) as usize].contains("Back to bottom"),
        "scrollOffset>0 时 composer 上方 gap 行必须显示回到底部的提示: {:?}",
        rows_older[(composer_top - 1) as usize]
    );
    let (composer_top_latest, _) = composer_span(&buffer_latest);
    assert_eq!(
        composer_top, composer_top_latest,
        "滚动只能移动 transcript 视口，不得改变 composer 位置"
    );
}

#[test]
fn scroll_offset_out_of_range_is_clamped_without_panic() {
    let view = scroll_view(9999);
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    // 越界偏移不得 panic；视口被钉在最早可显示的内容。
    assert_rows_fit(&buffer);
    assert!(
        rows.iter().any(|row| row.contains("message-01")),
        "越界 scrollOffset 必须 clamp 到最早消息而不是空屏"
    );
    let cursor = render::cursor(&view, area(80, 24));
    assert!(
        cursor.is_some(),
        "滚动不应影响 composer 光标可见性"
    );
}

// ---------------------------------------------------------------------------
// 5) modal kind=commands：composer 可见 + popup 贴其上方
// ---------------------------------------------------------------------------

#[test]
fn commands_modal_keeps_composer_visible_and_popup_above_it() {
    let mut view = chat_view();
    view.modal = Some(commands_modal());
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    // composer 仍然可见：`› ` + 输入正文。
    let composer_input_y = find_row(&rows, "› 继续");
    let (composer_top, composer_bottom) = composer_span(&buffer);
    assert!(
        (composer_top..=composer_bottom).contains(&composer_input_y),
        "commands popup 打开时 composer 必须可见"
    );

    // 光标仍在 composer 内。
    let cursor = render::cursor(&view, area(80, 24)).expect("commands 模式下光标必须可见");
    assert!(
        (composer_top..=composer_bottom).contains(&cursor.y)
            && cursor.x >= 2
            && cursor.x < 80,
        "commands 模式下光标必须落在 composer 文本区，实际 {cursor:?}，composer {composer_top}..={composer_bottom}"
    );

    // popup 位于 composer 正上方，且不超过 8 行。
    let help_y = find_row(&rows, "/help");
    let quit_y = find_row(&rows, "/quit");
    assert!(help_y < composer_top, "popup 必须在 composer 之上");
    assert!(quit_y < composer_top, "popup 必须在 composer 之上");
    let popup_bottom = help_y.max(quit_y);
    assert_eq!(
        popup_bottom,
        composer_top - 1,
        "popup 必须紧贴 composer 上方（不留空行）"
    );
    assert!(
        popup_bottom + 1 - help_y.min(quit_y) <= 8,
        "commands popup 最多 8 行"
    );
    assert!(
        help_y >= composer_top.saturating_sub(8),
        "popup 不得离 composer 超过 8 行"
    );

    // popup 是 overlay：transcript 仍然照常绘制。
    assert!(
        rows.iter().any(|row| row.contains("帮我看看这个重试逻辑")),
        "commands popup 不得清空 transcript"
    );
}

#[test]
fn commands_popup_shows_at_most_eight_rows() {
    let mut view = chat_view();
    view.modal = Some(Modal {
        kind: "commands".to_string(),
        title: "命令".to_string(),
        items: (1..=12)
            .map(|index| ModalItem {
                label: format!("/cmd-{index:02}"),
                detail: format!("第 {index} 个命令"),
            })
            .collect(),
        selected: 0,
        query: "/".to_string(),
        footer: String::new(),
    });
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);
    let (composer_top, _) = composer_span(&buffer);

    let item_rows: Vec<u16> = (0..24u16)
        .filter(|&y| rows[y as usize].contains("/cmd-"))
        .collect();
    assert!(
        !item_rows.is_empty(),
        "有匹配项时 commands popup 必须绘制条目"
    );
    assert!(
        item_rows.len() <= 8,
        "commands popup 最多 8 行，实际 {}",
        item_rows.len()
    );
    assert_eq!(
        *item_rows.iter().max().expect("非空"),
        composer_top - 1,
        "popup 必须紧贴 composer 上方"
    );
    assert!(
        rows.iter().any(|row| row.contains("/cmd-01")),
        "第一项必须可见"
    );
    assert!(
        !rows.iter().any(|row| row.contains("/cmd-12")),
        "超过 8 行的条目应被 popup 高度截断"
    );
    // 选中项行用 `› ` 前缀。
    let first_y = find_row(&rows, "/cmd-01");
    assert!(
        rows[first_y as usize].starts_with("› "),
        "选中条目必须用 `› ` 前缀: {:?}",
        rows[first_y as usize]
    );
}

/// **关键回归**：commands popup 是 overlay，不得挤占 transcript 几何。
///
/// 只断言“非 popup 区域完全一致”+“底部 chrome 行号不变”，不锁具体行数常量，
/// 这样渲染器之后把 popup 改成覆盖 transcript 也不会误报。
#[test]
fn commands_modal_does_not_move_chrome_or_repaint_transcript() {
    let view_plain = chat_view();
    let mut view_popup = chat_view();
    view_popup.modal = Some(commands_modal());

    let buffer_plain = render(&view_plain, 80, 24);
    let buffer_popup = render(&view_popup, 80, 24);
    let rows_plain = rows_of(&buffer_plain);
    let rows_popup = rows_of(&buffer_popup);

    // header 行号不变。
    let brand_plain = find_row(&rows_plain, ">_ dsh-ask");
    let brand_popup = find_row(&rows_popup, ">_ dsh-ask");
    assert_eq!(brand_plain, brand_popup, "popup 不得移动 header");
    let cwd_plain = find_row(&rows_plain, &view_plain.cwd);
    let cwd_popup = find_row(&rows_popup, &view_popup.cwd);
    assert_eq!(cwd_plain, cwd_popup, "popup 不得移动 cwd 行");

    // 底部 chrome（composer/status/hint）行号不变。
    let (composer_top_plain, composer_bottom_plain) = composer_span(&buffer_plain);
    let (composer_top_popup, composer_bottom_popup) = composer_span(&buffer_popup);
    assert_eq!(
        (composer_top_plain, composer_bottom_plain),
        (composer_top_popup, composer_bottom_popup),
        "popup 不得移动 composer"
    );
    assert_eq!(
        rows_plain[composer_bottom_plain as usize + 1],
        rows_popup[composer_bottom_popup as usize + 1],
        "popup 不得改变状态行"
    );
    assert_eq!(
        rows_plain[23], rows_popup[23],
        "popup 不得改变贴底的提示行"
    );

    // popup 覆盖的行：画面上包含 popup 条目文本。
    let popup_rows: Vec<u16> = (0..24u16)
        .filter(|&y| {
            rows_popup[y as usize].contains("/help") || rows_popup[y as usize].contains("/quit")
        })
        .collect();
    assert_eq!(popup_rows.len(), 2, "两个条目应各占 popup 一行");

    // 除 popup 行外，transcript 区域必须逐行一致（popup 不重绘、不挤占 transcript）。
    for y in (cwd_plain + 1)..composer_top_plain {
        if popup_rows.contains(&y) {
            continue;
        }
        assert_eq!(
            rows_plain[y as usize], rows_popup[y as usize],
            "第 {y} 行不在 popup 覆盖范围内，popup 不得改变其内容（transcript 几何不变）"
        );
    }
    // transcript 正文行位置不变。
    let user_plain = find_row(&rows_plain, "帮我看看这个重试逻辑");
    let user_popup = find_row(&rows_popup, "帮我看看这个重试逻辑");
    assert_eq!(user_plain, user_popup, "popup 不得移动 transcript 正文");
}

/// **关键回归（popup 是 overlay，不挤占 transcript）**。
///
/// 用长 transcript（bottom-anchored，可见区全是真实消息）比较 modal=None 与
/// modal=commands：transcript 高度必须固定，popup 只覆盖 composer 上方若干行；
/// 因此 header/composer 行号不变、**未被 popup 覆盖的行逐行一致**。
/// 若 popup 再从 transcript 借行，视口会上移，这些行的内容就会不同。
#[test]
fn commands_popup_is_an_overlay_over_a_long_transcript() {
    let view_plain = scroll_view(0);
    let mut view_popup = scroll_view(0);
    view_popup.modal = Some(commands_modal());

    let buffer_plain = render(&view_plain, 80, 24);
    let buffer_popup = render(&view_popup, 80, 24);
    let rows_plain = rows_of(&buffer_plain);
    let rows_popup = rows_of(&buffer_popup);

    // 长 transcript 真的撑满视口（否则“行内容一致”没有区分度）。
    assert!(
        rows_plain.iter().any(|row| row.contains("message-30")),
        "长 transcript 必须显示最新消息"
    );

    // header / composer 位置不变。
    let brand_plain = find_row(&rows_plain, ">_ dsh-ask");
    let brand_popup = find_row(&rows_popup, ">_ dsh-ask");
    assert_eq!(brand_plain, brand_popup, "popup 不得移动 header");
    let (composer_top_plain, composer_bottom_plain) = composer_span(&buffer_plain);
    let (composer_top_popup, composer_bottom_popup) = composer_span(&buffer_popup);
    assert_eq!(
        (composer_top_plain, composer_bottom_plain),
        (composer_top_popup, composer_bottom_popup),
        "popup 不得移动 composer"
    );

    // popup 覆盖行（动态识别，不锁行号常量）。
    let popup_rows: Vec<u16> = (0..24u16)
        .filter(|&y| {
            rows_popup[y as usize].contains("/help") || rows_popup[y as usize].contains("/quit")
        })
        .collect();
    assert_eq!(popup_rows.len(), 2, "两个命令条目应各占 popup 一行");

    let cwd_y = find_row(&rows_plain, &view_plain.cwd);
    // 回归断言有意义的前提：popup 之外的 transcript 区域里确实有真实消息内容。
    let content_rows: Vec<u16> = ((cwd_y + 1)..composer_top_plain)
        .filter(|&y| !popup_rows.contains(&y) && rows_plain[y as usize].contains("message-"))
        .collect();
    assert!(
        !content_rows.is_empty(),
        "popup 之外的 transcript 必须仍有真实消息内容，否则回归断言没有区分度"
    );
    for y in (cwd_y + 1)..composer_top_plain {
        if popup_rows.contains(&y) {
            continue;
        }
        assert_eq!(
            rows_plain[y as usize], rows_popup[y as usize],
            "第 {y} 行未被 popup 覆盖，内容必须与无 popup 时一致（popup 不得挤占 transcript）"
        );
    }
}

// ---------------------------------------------------------------------------
// 6) modal kind=sessions / help：全屏页
// ---------------------------------------------------------------------------

fn sessions_modal() -> Modal {
    Modal {
        kind: "sessions".to_string(),
        title: "选择会话".to_string(),
        items: vec![
            ModalItem {
                label: "新建会话".to_string(),
                detail: "workspace: ~/work".to_string(),
            },
            ModalItem {
                label: "修复重试逻辑".to_string(),
                detail: "session-1 · ~/dsh-local-cli".to_string(),
            },
        ],
        selected: 1,
        query: String::new(),
        footer: "↑↓ 选择 · Enter 切换 · Esc 关闭".to_string(),
    }
}

/// 全屏页的通用断言：占满整屏、只画 title/query/列表/footer，不画 transcript/composer。
fn assert_full_screen_page(buffer: &Buffer, view: &View) {
    let rows = rows_of(buffer);
    assert_rows_fit(buffer);

    // composer 背景块和 `› ` 输入行都不存在（composer/transcript 不画）。
    assert!(
        composer_rows(buffer).is_empty(),
        "全屏 modal 页不得绘制 composer 背景块"
    );
    assert!(
        !rows
            .iter()
            .any(|row| row.contains("Ask dsh-ask to do anything")),
        "全屏 modal 页不得绘制 composer placeholder"
    );
    for text in view.messages.iter().map(|message| message.text.as_str()) {
        assert!(
            !rows.iter().any(|row| row.contains(text)),
            "全屏 modal 页不得绘制 transcript 正文 {text:?}"
        );
    }
    assert!(
        !rows.iter().any(|row| row.contains(">_ dsh-ask")),
        "全屏 modal 页不画 transcript header"
    );
    // sessions 是搜索输入页：光标停在第二行 query 末尾；help 页隐藏光标。
    let expected = if view.modal.as_ref().is_some_and(|modal| modal.kind == "sessions") {
        Some(Position::new(2, 1))
    } else {
        None
    };
    assert_eq!(
        render::cursor(view, buffer.area),
        expected,
        "sessions 显示 query 光标 / help 隐藏光标"
    );
}

#[test]
fn sessions_modal_is_a_full_screen_page() {
    let mut view = chat_view();
    view.modal = Some(sessions_modal());
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    // title 在首行。
    assert!(
        rows[0].contains("选择会话"),
        "sessions 页首行必须是标题: {:?}",
        rows[0]
    );
    // 空 query 显示 `Type to search`。
    assert!(
        rows.iter().any(|row| row.contains("Type to search")),
        "sessions 页空 query 必须显示 `Type to search`"
    );
    // 条目 + 详情。
    for needle in [
        "新建会话",
        "workspace: ~/work",
        "修复重试逻辑",
        "session-1 · ~/dsh-local-cli",
    ] {
        assert!(
            rows.iter().any(|row| row.contains(needle)),
            "sessions 页必须显示条目内容 {needle:?}"
        );
    }
    // footer 贴底。
    assert!(
        rows[23].contains("Esc 关闭"),
        "sessions 页 footer 必须贴底: {:?}",
        rows[23]
    );
    // selected 索引由父进程给定：第二项显示 `› ` 选中前缀，第一项不显示。
    let selected_y = find_row(&rows, "修复重试逻辑");
    assert!(
        rows[selected_y as usize].starts_with("› "),
        "sessions 页选中行必须用 `› ` 前缀: {:?}",
        rows[selected_y as usize]
    );
    let unselected_y = find_row(&rows, "新建会话");
    assert!(
        !rows[unselected_y as usize].starts_with("› "),
        "sessions 页未选中行不得带 `› ` 前缀: {:?}",
        rows[unselected_y as usize]
    );

    assert_full_screen_page(&buffer, &view);
}

#[test]
fn help_modal_is_a_full_screen_page_with_query() {
    let mut view = chat_view();
    view.modal = Some(Modal {
        kind: "help".to_string(),
        title: "帮助 · 按键".to_string(),
        items: vec![
            ModalItem {
                label: "Enter".to_string(),
                detail: "提交输入".to_string(),
            },
            ModalItem {
                label: "Esc".to_string(),
                detail: "关闭弹窗".to_string(),
            },
        ],
        selected: 0,
        query: "filter-me".to_string(),
        footer: "Esc 关闭帮助".to_string(),
    });
    let buffer = render(&view, 80, 24);
    let rows = rows_of(&buffer);

    assert!(
        rows[0].contains("帮助 · 按键"),
        "help 页首行必须是标题: {:?}",
        rows[0]
    );
    assert!(
        rows.iter().any(|row| row.contains("filter-me")),
        "help 页有 query 时必须显示 query"
    );
    for needle in ["Enter", "提交输入", "Esc", "关闭弹窗"] {
        assert!(
            rows.iter().any(|row| row.contains(needle)),
            "help 页必须显示条目内容 {needle:?}"
        );
    }
    assert!(
        rows[23].contains("Esc 关闭帮助"),
        "help 页 footer 必须贴底: {:?}",
        rows[23]
    );

    assert_full_screen_page(&buffer, &view);
}

// ---------------------------------------------------------------------------
// 7) 窄屏 / 极小屏自适应
// ---------------------------------------------------------------------------

#[test]
fn narrow_sizes_render_without_panic_or_overflow() {
    let mut view = chat_view();
    view.messages = vec![
        message("user", &"中文😀很长的用户消息".repeat(8)),
        message("assistant", &"中文😀很长的回答".repeat(12)),
        message("error", "失败"),
    ];
    view.input = "中文😀abc".to_string();
    view.input_cursor = 7;

    // 40x12 / 20x8 / 8x4 是任务要求的自适应尺寸；1x1 作为极小屏防御性检查。
    for (width, height) in [(40u16, 12u16), (20, 8), (8, 4), (1, 1)] {
        let buffer = render(&view, width, height);
        assert_eq!(rows_of(&buffer).len(), usize::from(height));
        // 中文/emoji 截断不得导致行宽超过屏宽（即不得画出“半个宽字符”）。
        assert_rows_fit(&buffer);
        // 光标（若存在）必须落在屏幕内。
        if let Some(cursor) = render::cursor(&view, area(width, height)) {
            assert!(
                cursor.x < width && cursor.y < height,
                "{width}x{height} 下光标 {cursor:?} 必须落在屏幕内"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 8) Unicode 光标：UTF-16 索引 → (x, y)
// ---------------------------------------------------------------------------

#[test]
fn sessions_picker_query_cursor_tracks_display_width() {
    let mut view = chat_view();
    view.modal = Some(sessions_modal());
    let area80 = area(80, 24);

    // 空 query：第二行 query 区起点。
    assert_eq!(render::cursor(&view, area80), Some(Position::new(2, 1)));

    let cases: &[(&str, u16)] = &[
        ("abc", 2 + 3),
        ("中文", 2 + 4),
        ("a😀b", 2 + 4),
        ("中文😀x", 2 + 7),
    ];
    for (query, expected_x) in cases {
        view.modal.as_mut().unwrap().query = (*query).to_string();
        assert_eq!(
            render::cursor(&view, area80),
            Some(Position::new(*expected_x, 1)),
            "query={query:?} 光标列必须按显示宽度定位"
        );
    }

    // 超长 query 截断到最后一个可用单元格，不越界。
    view.modal.as_mut().unwrap().query = "x".repeat(500);
    assert_eq!(
        render::cursor(&view, area80),
        Some(Position::new(79, 1)),
        "超长 query 光标必须 clamp 到屏内"
    );

    // 极窄/极矮页：query 行画不出来时隐藏光标，不 panic。
    assert_eq!(render::cursor(&view, area(80, 1)), None);
    assert_eq!(render::cursor(&view, area(1, 24)), None);

    // help 不是文本输入：始终隐藏光标；commands 仍用 composer 光标。
    view.modal.as_mut().unwrap().kind = "help".to_string();
    view.modal.as_mut().unwrap().query.clear();
    assert_eq!(render::cursor(&view, area80), None);
    view.modal = Some(commands_modal());
    assert!(render::cursor(&view, area80).is_some());
}

#[test]
fn unicode_cursor_is_monotonic_and_respects_grapheme_boundaries() {
    let mut view = chat_view();
    // 中(1) 文(1) 😀(2) a b c → UTF-16 共 7 个 code unit。
    view.input = "中文😀abc".to_string();
    let buffer = render(&view, 80, 24);
    let (composer_top, composer_bottom) = composer_span(&buffer);
    // Codex composer: the grey top padding row sits above the draft row.
    let input_y = composer_top + 1;

    // (UTF-16 inputCursor, 光标左侧文本)，8 越界必须 clamp 到末尾。
    let cases = [
        (0usize, ""),
        (2, "中文"),
        (4, "中文😀"),
        (5, "中文😀a"),
        (6, "中文😀ab"),
        (8, "中文😀abc"),
    ];
    let mut last_x = 0u16;
    for (utf16_cursor, prefix) in cases {
        view.input_cursor = utf16_cursor;
        let cursor = render::cursor(&view, area(80, 24))
            .unwrap_or_else(|| panic!("inputCursor={utf16_cursor} 时光标必须存在"));
        // 光标在 composer 输入行：x >= 2（跳过 `› ` gutter）。
        assert_eq!(cursor.y, input_y, "inputCursor={utf16_cursor} 光标行错误");
        assert!(
            (composer_top..=composer_bottom).contains(&cursor.y),
            "光标必须落在 composer 内"
        );
        assert!(
            cursor.x >= 2,
            "光标不得落在 `› ` 前缀里（inputCursor={utf16_cursor}）"
        );
        // x = 2 + 光标左侧文本的显示宽度（中文/emoji 各占其实际宽度）。
        let expected_x = 2 + text::display_width(prefix);
        assert_eq!(
            cursor.x as usize, expected_x,
            "inputCursor={utf16_cursor}（左侧 {prefix:?}）光标列错误"
        );
        assert!(
            cursor.x >= last_x,
            "UTF-16 索引增大时光标必须单调前进或不动"
        );
        last_x = cursor.x;
    }

    // sessions picker 的搜索行显示光标（第二行、query 末尾）；help 页隐藏。
    view.modal = Some(sessions_modal());
    assert_eq!(
        render::cursor(&view, area(80, 24)),
        Some(Position::new(2, 1)),
        "sessions 搜索行空 query 时光标在 query 起点"
    );
    view.modal = Some(commands_modal());
    assert!(
        render::cursor(&view, area(80, 24)).is_some(),
        "commands popup 打开时 composer 光标仍必须可见"
    );
}
