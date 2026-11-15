//! Wire types for the fixed fd3/fd4 protocol.
//!
//! The parent (`dsh-tui.mjs` business layer) sends one JSON object per line on
//! fd3 (`render`, `stop`); this display layer answers with one JSON object per
//! line on fd4 (`ready`, `key`, `resize`, `error`). See `docs/architecture.md`
//! for the wire contract.
//!
//! Nothing in this module touches the terminal. It is pure (de)serialization
//! plus small safe helpers so unit and integration tests can exercise it
//! without a TTY.

use serde::{Deserialize, Serialize};

/// One complete screen description sent by the parent for every frame.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct View {
    pub project: String,
    pub cwd: String,
    pub session_title: String,
    pub session_id: String,
    pub model: String,
    /// `ready` | `waiting` | `streaming` | any other parent-side string.
    pub status: String,
    /// Parent-formatted status rows (at most two): the desktop DSH model/effort,
    /// permission, context, token, cache, turn/step and speed figures, already
    /// sanitised and formatted by the JS worker. This layer only lays them out;
    /// it never recomputes the numbers. Missing/empty keeps the legacy single
    /// `{model} · {project} · {sessionTitle}[ · {status}]` row.
    pub status_lines: Vec<String>,
    pub messages: Vec<Message>,
    pub input: String,
    /// UTF-16 code unit index into `input` (see `text::cursor`).
    pub input_cursor: usize,
    pub attachments: Vec<Attachment>,
    pub hint: String,
    /// Parent-translated user-visible strings. A missing or `null` object (old
    /// parents) keeps the built-in defaults, so the screen does not change.
    #[serde(default, deserialize_with = "deserialize_ui")]
    pub ui: Ui,
    /// `0` means pinned to the newest message; larger values scroll back.
    pub scroll_offset: usize,
    pub modal: Option<Modal>,
}

/// Built-in user-visible strings used when the parent sends no `view.ui`.
///
/// They are exactly the strings this display layer hard-coded before `ui`
/// existed, so an old view without `ui` renders byte-for-byte as before.
pub const DEFAULT_PLACEHOLDER: &str = "Ask dsh-ask to do anything";
pub const DEFAULT_EMPTY_LIST: &str = "no matches";
pub const DEFAULT_SEARCH_PLACEHOLDER: &str = "Type to search";
pub const DEFAULT_HINT_FALLBACK: &str = "? for shortcuts";
/// Back-to-bottom variants from longest to shortest; the renderer keeps the
/// longest one that fits the terminal width.
pub const DEFAULT_BACK_TO_BOTTOM: [&str; 4] =
    ["↓ Back to bottom · esc", "↓ Bottom · esc", "↓ Bottom", "↓"];
pub const DEFAULT_MODAL_TITLE_HELP: &str = "帮助 · 按键与命令";
pub const DEFAULT_MODAL_TITLE_SESSIONS: &str = "选择会话";

/// Parent-supplied, already-translated user-visible strings (`view.ui`).
///
/// This layer never resolves a locale or reads the environment: the JS worker
/// decides the language and sends the strings on every frame. Every field is
/// optional; a missing field (or a missing/`null` `ui` object) keeps the
/// built-in default so an old or partial parent renders as before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Ui {
    /// Composer placeholder while the draft is empty.
    pub placeholder: String,
    /// Empty-list row of the command popup and the full-screen pages.
    pub empty_list: String,
    /// Placeholder of the sessions search field while the query is empty.
    pub search_placeholder: String,
    /// Hint-row fallback when `view.hint` is blank.
    pub hint_fallback: String,
    /// Back-to-bottom control variants from longest to shortest (four at most).
    pub back_to_bottom: Vec<String>,
    /// Default title of the full-screen help page when `modal.title` is empty.
    pub modal_title_help: String,
    /// Default title of the sessions/unknown page when `modal.title` is empty.
    pub modal_title_sessions: String,
}

impl Default for Ui {
    fn default() -> Self {
        Ui {
            placeholder: DEFAULT_PLACEHOLDER.to_string(),
            empty_list: DEFAULT_EMPTY_LIST.to_string(),
            search_placeholder: DEFAULT_SEARCH_PLACEHOLDER.to_string(),
            hint_fallback: DEFAULT_HINT_FALLBACK.to_string(),
            back_to_bottom: DEFAULT_BACK_TO_BOTTOM
                .iter()
                .map(|variant| (*variant).to_string())
                .collect(),
            modal_title_help: DEFAULT_MODAL_TITLE_HELP.to_string(),
            modal_title_sessions: DEFAULT_MODAL_TITLE_SESSIONS.to_string(),
        }
    }
}

/// Parent text when non-blank, otherwise the built-in default.
///
/// A parent that sets a field normally never sends a blank string, but a blank
/// one must not blank out the UI either.
pub fn text_or_default<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.trim().is_empty() {
        default
    } else {
        value
    }
}

/// `ui` is optional on the wire: `null` and a missing key both mean "use the
/// built-in defaults". Unknown fields inside the object are ignored by serde.
fn deserialize_ui<'de, D>(deserializer: D) -> Result<Ui, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Ui>::deserialize(deserializer).map(Option::unwrap_or_default)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Message {
    /// `user` | `assistant` | `system` | `error`.
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Modal {
    /// `commands` renders as a slash-command popup glued above the composer
    /// (composer stays visible); `sessions`/`help`/unknown render as the
    /// full-screen selection page. Missing `kind` is treated as `sessions`
    /// for old-view compatibility.
    pub kind: String,
    pub title: String,
    pub items: Vec<ModalItem>,
    /// Already filtered by the parent; indexes the list this layer draws.
    pub selected: usize,
    pub query: String,
    pub footer: String,
}

impl Default for Modal {
    fn default() -> Self {
        Modal {
            kind: default_modal_kind(),
            title: String::new(),
            items: Vec::new(),
            selected: 0,
            query: String::new(),
            footer: String::new(),
        }
    }
}

fn default_modal_kind() -> String {
    "sessions".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModalItem {
    pub label: String,
    pub detail: String,
}

/// Inbound (fd3) message kinds.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Render(View),
    Stop,
}

impl Inbound {
    /// Parse one line. Unknown or malformed messages return `None` so the
    /// reader can skip them without tearing the screen down (contract §1).
    pub fn parse(line: &str) -> Option<Inbound> {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        match value.get("type")?.as_str()? {
            "render" => {
                let view = serde_json::from_value(value.get("view")?.clone()).ok()?;
                Some(Inbound::Render(view))
            }
            "stop" => Some(Inbound::Stop),
            _ => None,
        }
    }
}

/// Key event payload. `str` travels next to it as the insertable text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KeyPayload {
    pub name: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outbound {
    Ready,
    Key { text: String, key: KeyPayload },
    Resize { columns: u16, rows: u16 },
    Error { message: String },
}

impl Outbound {
    /// Serialize to exactly one line (without the trailing newline).
    ///
    /// The wire shape is an internally tagged enum so `type` is always the
    /// first field, matching the contract examples and making the line easy to
    /// scan in logs (`serde_json`'s map-based macros sort keys alphabetically).
    pub fn to_line(&self) -> String {
        let wire = match self {
            Outbound::Ready => WireOut::Ready,
            Outbound::Key { text, key } => WireOut::Key { text, key },
            Outbound::Resize { columns, rows } => WireOut::Resize {
                columns: *columns,
                rows: *rows,
            },
            Outbound::Error { message } => WireOut::Error { message },
        };
        serde_json::to_string(&wire).unwrap_or_else(|_| {
            // Serialization of these plain types cannot fail; keep the code
            // total rather than panicking inside the event loop.
            "{\"type\":\"error\",\"message\":\"failed to serialize message\"}".to_string()
        })
    }
}

/// Wire form of [`Outbound`]. Keep `type` first for deterministic lines.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WireOut<'a> {
    Ready,
    Key {
        #[serde(rename = "str")]
        text: &'a str,
        key: &'a KeyPayload,
    },
    Resize {
        columns: u16,
        rows: u16,
    },
    Error {
        message: &'a str,
    },
}

/// Version string printed by `--version`. Must not touch the TTY or fds 3/4.
pub fn version_line() -> String {
    format!("dsh-ask-ui {}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_render_line() {
        let line = r#"{"type":"render","view":{"project":"p","cwd":"/w","sessionTitle":"t","sessionId":"s","model":"m","status":"ready","statusLines":["deepseek-v4 · high · default","ctx 42% · tok 12.3k · cache 88%"],"messages":[{"role":"user","text":"hi"}],"input":"ab","inputCursor":2,"attachments":[{"name":"a.png"}],"hint":"h","scrollOffset":1,"modal":{"title":"T","items":[{"label":"L","detail":"D"}],"selected":1,"query":"q","footer":"f"}}}"#;
        let Inbound::Render(view) = Inbound::parse(line).expect("render") else {
            panic!("expected render");
        };
        assert_eq!(view.project, "p");
        assert_eq!(view.session_title, "t");
        assert_eq!(
            view.status_lines,
            vec![
                "deepseek-v4 · high · default".to_string(),
                "ctx 42% · tok 12.3k · cache 88%".to_string(),
            ],
            "statusLines 必须按 camelCase 反序列化"
        );
        assert_eq!(view.input_cursor, 2);
        assert_eq!(view.messages.len(), 1);
        assert_eq!(view.attachments[0].name, "a.png");
        assert_eq!(view.scroll_offset, 1);
        let modal = view.modal.expect("modal");
        assert_eq!(modal.items[0].label, "L");
        assert_eq!(modal.selected, 1);
    }

    #[test]
    fn missing_view_fields_default() {
        let Inbound::Render(view) =
            Inbound::parse(r#"{"type":"render","view":{}}"#).expect("render")
        else {
            panic!("expected render");
        };
        assert_eq!(view, View::default());
        assert!(
            view.status_lines.is_empty(),
            "旧 view 没有 statusLines 时必须按空值兜底"
        );
    }

    #[test]
    fn status_lines_round_trip_as_camel_case() {
        let view = View {
            status_lines: vec!["a".into(), "b".into()],
            ..View::default()
        };
        let line = serde_json::to_string(&view).expect("serialize view");
        assert!(line.contains("\"statusLines\":[\"a\",\"b\"]"), "{line}");
        let parsed: View = serde_json::from_str(&line).expect("deserialize view");
        assert_eq!(parsed.status_lines, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn missing_ui_keeps_the_legacy_display_strings() {
        let Inbound::Render(view) =
            Inbound::parse(r#"{"type":"render","view":{}}"#).expect("render")
        else {
            panic!("expected render");
        };
        assert_eq!(view.ui, Ui::default(), "旧 view 没有 ui 时必须退回内置默认");
        // 默认值就是 i18n 之前写死的文案，保证无 ui 时显示逐字节不变。
        assert_eq!(view.ui.placeholder, "Ask dsh-ask to do anything");
        assert_eq!(view.ui.empty_list, "no matches");
        assert_eq!(view.ui.search_placeholder, "Type to search");
        assert_eq!(view.ui.hint_fallback, "? for shortcuts");
        assert_eq!(
            view.ui.back_to_bottom,
            vec![
                "↓ Back to bottom · esc".to_string(),
                "↓ Bottom · esc".to_string(),
                "↓ Bottom".to_string(),
                "↓".to_string(),
            ]
        );
        assert_eq!(view.ui.modal_title_help, "帮助 · 按键与命令");
        assert_eq!(view.ui.modal_title_sessions, "选择会话");
    }

    #[test]
    fn null_ui_is_treated_as_missing() {
        for line in [
            r#"{"type":"render","view":{"ui":null}}"#,
            r#"{"type":"render","view":{}}"#,
        ] {
            let Inbound::Render(view) = Inbound::parse(line).expect("render") else {
                panic!("expected render");
            };
            assert_eq!(view.ui, Ui::default(), "{line}");
        }
    }

    #[test]
    fn ui_parses_camel_case_and_ignores_unknown_fields() {
        let line = r#"{"type":"render","view":{"ui":{"placeholder":"输入","emptyList":"无匹配","searchPlaceholder":"搜索会话","hintFallback":"? 快捷键","backToBottom":["↓ 回到最新 · esc","↓ 最新 · esc","↓ 最新","↓"],"modalTitleHelp":"帮助","modalTitleSessions":"会话","unknownUiField":true}}}"#;
        let Inbound::Render(view) = Inbound::parse(line).expect("render") else {
            panic!("expected render");
        };
        let ui = view.ui;
        assert_eq!(ui.placeholder, "输入");
        assert_eq!(ui.empty_list, "无匹配");
        assert_eq!(ui.search_placeholder, "搜索会话");
        assert_eq!(ui.hint_fallback, "? 快捷键");
        assert_eq!(
            ui.back_to_bottom,
            vec![
                "↓ 回到最新 · esc".to_string(),
                "↓ 最新 · esc".to_string(),
                "↓ 最新".to_string(),
                "↓".to_string(),
            ]
        );
        assert_eq!(ui.modal_title_help, "帮助");
        assert_eq!(ui.modal_title_sessions, "会话");
    }

    #[test]
    fn partial_ui_keeps_the_default_for_each_missing_field() {
        let Inbound::Render(view) = Inbound::parse(
            r#"{"type":"render","view":{"ui":{"placeholder":"type here","modalTitleSessions":"Sessions"}}}"#,
        )
        .expect("render")
        else {
            panic!("expected render");
        };
        let ui = view.ui;
        assert_eq!(ui.placeholder, "type here");
        assert_eq!(ui.modal_title_sessions, "Sessions");
        assert_eq!(ui.empty_list, DEFAULT_EMPTY_LIST, "缺少单字段必须用原默认");
        assert_eq!(ui.search_placeholder, DEFAULT_SEARCH_PLACEHOLDER);
        assert_eq!(ui.hint_fallback, DEFAULT_HINT_FALLBACK);
        assert_eq!(ui.modal_title_help, DEFAULT_MODAL_TITLE_HELP);
        assert_eq!(
            ui.back_to_bottom,
            DEFAULT_BACK_TO_BOTTOM
                .iter()
                .map(|variant| (*variant).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn ui_round_trips_as_camel_case() {
        let view = View {
            ui: Ui {
                placeholder: "输入".into(),
                empty_list: "无匹配".into(),
                search_placeholder: "搜索".into(),
                hint_fallback: "? 快捷键".into(),
                back_to_bottom: vec!["↓ 回到最新".into(), "↓".into()],
                modal_title_help: "帮助".into(),
                modal_title_sessions: "会话".into(),
            },
            ..View::default()
        };
        let line = serde_json::to_string(&view).expect("serialize view");
        assert!(line.contains("\"ui\":{"), "{line}");
        assert!(line.contains("\"emptyList\":"), "{line}");
        assert!(line.contains("\"backToBottom\":["), "{line}");
        assert!(line.contains("\"modalTitleSessions\":"), "{line}");
        let parsed: View = serde_json::from_str(&line).expect("deserialize view");
        assert_eq!(parsed.ui, view.ui);
    }

    #[test]
    fn blank_ui_strings_fall_back_to_the_builtin_default() {
        assert_eq!(
            text_or_default("", DEFAULT_PLACEHOLDER),
            DEFAULT_PLACEHOLDER
        );
        assert_eq!(
            text_or_default("   ", DEFAULT_HINT_FALLBACK),
            DEFAULT_HINT_FALLBACK
        );
        assert_eq!(text_or_default("输入", DEFAULT_PLACEHOLDER), "输入");
    }

    #[test]
    fn parses_stop_and_skips_unknown() {
        assert_eq!(Inbound::parse(r#"{"type":"stop"}"#), Some(Inbound::Stop));
        assert_eq!(Inbound::parse(r#"{"type":"bogus"}"#), None);
        assert_eq!(Inbound::parse("not json"), None);
        assert_eq!(Inbound::parse(r#"{"type":"render"}"#), None);
    }

    #[test]
    fn serializes_outbound_lines() {
        assert_eq!(Outbound::Ready.to_line(), r#"{"type":"ready"}"#);
        let key = KeyPayload {
            name: "paste".into(),
            ctrl: false,
            meta: false,
            shift: false,
            sequence: None,
        };
        let line = Outbound::Key {
            text: "a\nb".into(),
            key,
        }
        .to_line();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "key");
        assert_eq!(value["str"], "a\nb");
        assert_eq!(value["key"]["name"], "paste");
        assert!(value["key"].get("sequence").is_none());

        let resize = Outbound::Resize {
            columns: 80,
            rows: 24,
        };
        let value: serde_json::Value = serde_json::from_str(&resize.to_line()).unwrap();
        assert_eq!(value["type"], "resize");
        assert_eq!(value["columns"], 80);
        assert_eq!(value["rows"], 24);
        let error = Outbound::Error {
            message: "x".into(),
        };
        let value: serde_json::Value = serde_json::from_str(&error.to_line()).unwrap();
        assert_eq!(value["type"], "error");
        assert_eq!(value["message"], "x");
    }

    #[test]
    fn modal_kind_defaults_to_sessions_and_commands_parses() {
        let Inbound::Render(view) =
            Inbound::parse(r#"{"type":"render","view":{"modal":{"title":"t","items":[]}}}"#)
                .expect("render")
        else {
            panic!("expected render");
        };
        assert_eq!(view.modal.expect("modal").kind, "sessions");

        let Inbound::Render(view) = Inbound::parse(
            r#"{"type":"render","view":{"modal":{"kind":"commands","title":"t","items":[]}}}"#,
        )
        .expect("render")
        else {
            panic!("expected render");
        };
        assert_eq!(view.modal.expect("modal").kind, "commands");
    }

    #[test]
    fn outbound_lines_start_with_type_for_log_scannability() {
        let key = KeyPayload {
            name: "a".into(),
            ctrl: false,
            meta: false,
            shift: false,
            sequence: None,
        };
        for line in [
            Outbound::Ready.to_line(),
            Outbound::Key { text: "x".into(), key }.to_line(),
            Outbound::Resize { columns: 80, rows: 24 }.to_line(),
            Outbound::Error { message: "e".into() }.to_line(),
        ] {
            assert!(
                line.starts_with("{\"type\":"),
                "type must be the first field: {line}"
            );
        }
    }

    #[test]
    fn version_line_is_stable_shape() {
        let line = version_line();
        assert!(line.starts_with("dsh-ask-ui "));
        assert!(!line.contains('\n'));
    }
}
