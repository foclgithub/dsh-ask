//! fd3/fd4 线协议契约（协议文档 §1–§3）。
//!
//! 只测 `ipc` 公共 API 与 `protocol` 线格式，不启动真实进程、不碰 TTY：
//!
//! * fd3（父→子）：`spawn_reader` 逐行投递 `render` / `stop`；未知/非法行跳过，
//!   不中断阅读线程；EOF 等价 `stop`，随后 channel 关闭。
//! * fd4（子→父）：`Out` 的每条消息恰好一行 JSON、以 `\n` 结尾；
//!   `ready` / `key` / `resize` / `error` 的 `type` 字段正确；写失败返回 `Err`。

use std::io::{self, Cursor, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};

use std::time::Duration;

use dsh_ask_ui::ipc::{self, Out};
use dsh_ask_ui::protocol::{
    Attachment, Inbound, KeyPayload, Message, Modal, ModalItem, Ui, View,
};

/// 上限式等待：只作为“消息一定到达”的安全阀，不在断言里依赖真实时间。
const WAIT: Duration = Duration::from_secs(5);

/// 取一条 fd3 消息；超时即说明阅读线程没有按契约逐行投递。
fn recv(receiver: &Receiver<Inbound>) -> Inbound {
    receiver.recv_timeout(WAIT).unwrap_or_else(|error| {
        panic!("fd3 阅读线程未在 {WAIT:?} 内投递消息（契约 §1：逐行即时投递）: {error}")
    })
}

/// 断言 channel 已关闭（阅读线程结束）。
fn assert_channel_closed(receiver: &Receiver<Inbound>, why: &str) {
    match receiver.recv_timeout(WAIT) {
        Err(RecvTimeoutError::Disconnected) => {}
        other => panic!(
            "{why} 之后 fd3 channel 必须关闭（契约 §1：reader 线程结束），实际收到 {other:?}"
        ),
    }
}

/// 共享 sink：`Out` 拿走写端，测试保留读端检查字节。
struct SharedSink {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl SharedSink {
    fn new() -> (Self, Arc<Mutex<Vec<u8>>>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                bytes: Arc::clone(&bytes),
            },
            bytes,
        )
    }
}

impl Write for SharedSink {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.bytes
            .lock()
            .expect("共享 sink 锁未中毒")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 无修饰的 `key` 载荷。
fn payload(name: &str) -> KeyPayload {
    KeyPayload {
        name: name.to_string(),
        ctrl: false,
        meta: false,
        shift: false,
        sequence: None,
    }
}

/// 一行完整 render 消息：覆盖 view 的每个字段，并故意带未知字段验证“忽略未知”。
const RENDER_LINE: &str = r#"{"type":"render","unknownTopLevel":true,"view":{"project":"dsh-local-cli","cwd":"/Users/example/workspace/dsh-local-cli","sessionTitle":"会话标题","sessionId":"session-1","model":"deepseek-chat","status":"streaming","messages":[{"role":"user","text":"你好"},{"role":"assistant","text":"**bold**"},{"role":"system","text":"sys"},{"role":"error","text":"err"}],"input":"中文😀","inputCursor":3,"attachments":[{"name":"a.png"}],"hint":"提示","ui":{"placeholder":"输入点什么","emptyList":"没有匹配","searchPlaceholder":"搜索会话","hintFallback":"? 快捷键","backToBottom":["↓ 回到最新 · esc","↓ 最新 · esc","↓ 最新","↓"],"modalTitleHelp":"帮助 · 按键","modalTitleSessions":"选择要切换的会话","unknownUiField":true},"scrollOffset":2,"modal":{"kind":"commands","title":"命令","items":[{"label":"/help","detail":"帮助"},{"label":"/quit","detail":"退出"}],"selected":1,"query":"h","footer":"↑↓ 选择"},"unknownViewField":true}}"#;

/// 构造一个 `{"type":..., ...}` 单行并补 `\n`。
fn line_of(value: serde_json::Value) -> String {
    let mut line = value.to_string();
    line.push('\n');
    line
}

// ---------------------------------------------------------------------------
// fd3：spawn_reader
// ---------------------------------------------------------------------------

#[test]
fn reader_delivers_render_then_stop_then_closes() {
    let mut input = String::from(RENDER_LINE);
    input.push('\n');
    input.push_str("{\"type\":\"stop\"}\n");
    let receiver = ipc::spawn_reader(Cursor::new(input.into_bytes()));

    let Inbound::Render(view) = recv(&receiver) else {
        panic!("第一行必须是 render（契约 §2）");
    };

    // 完整 view 逐字段比对：render 必须完整还原父进程的 view 结构（契约 §4）。
    let expected = View {
        project: "dsh-local-cli".to_string(),
        cwd: "/Users/example/workspace/dsh-local-cli".to_string(),
        session_title: "会话标题".to_string(),
        session_id: "session-1".to_string(),
        model: "deepseek-chat".to_string(),
        status: "streaming".to_string(),
        // 旧 render 行没有 statusLines：按空数组兜底（协议 §4）。
        status_lines: Vec::new(),
        messages: vec![
            Message {
                role: "user".to_string(),
                text: "你好".to_string(),
            },
            Message {
                role: "assistant".to_string(),
                text: "**bold**".to_string(),
            },
            Message {
                role: "system".to_string(),
                text: "sys".to_string(),
            },
            Message {
                role: "error".to_string(),
                text: "err".to_string(),
            },
        ],
        input: "中文😀".to_string(),
        input_cursor: 3,
        attachments: vec![Attachment {
            name: "a.png".to_string(),
        }],
        hint: "提示".to_string(),
        ui: Ui {
            placeholder: "输入点什么".to_string(),
            empty_list: "没有匹配".to_string(),
            search_placeholder: "搜索会话".to_string(),
            hint_fallback: "? 快捷键".to_string(),
            back_to_bottom: vec![
                "↓ 回到最新 · esc".to_string(),
                "↓ 最新 · esc".to_string(),
                "↓ 最新".to_string(),
                "↓".to_string(),
            ],
            modal_title_help: "帮助 · 按键".to_string(),
            modal_title_sessions: "选择要切换的会话".to_string(),
        },
        scroll_offset: 2,
        modal: Some(Modal {
            kind: "commands".to_string(),
            title: "命令".to_string(),
            items: vec![
                ModalItem {
                    label: "/help".to_string(),
                    detail: "帮助".to_string(),
                },
                ModalItem {
                    label: "/quit".to_string(),
                    detail: "退出".to_string(),
                },
            ],
            selected: 1,
            query: "h".to_string(),
            footer: "↑↓ 选择".to_string(),
        }),
    };
    assert_eq!(
        view, expected,
        "render 必须完整还原 view（未知顶层/view 字段按契约忽略）"
    );

    // 契约 §2：stop 表示进入退出流程。
    assert_eq!(recv(&receiver), Inbound::Stop);
    assert_channel_closed(&receiver, "stop");
}

#[test]
fn reader_skips_malformed_unknown_and_empty_lines() {
    let mut input = String::new();
    input.push_str("not json\n"); // 非法 JSON
    input.push_str("{\"type\":\"bogus\"}\n"); // 未知顶层 type
    input.push_str("{\"type\":\"render\"}\n"); // render 缺 view
    input.push_str("{\"type\":\"render\",\"view\":42}\n"); // view 不是对象
    input.push('\n'); // 空行
    input.push_str("{\"type\":\"render\",\"view\":{}}\n"); // 合法：全默认 view
    let receiver = ipc::spawn_reader(Cursor::new(input.into_bytes()));

    // 契约 §1：非法/未知行打印可忽略并跳过，不得中断阅读线程或退出。
    assert_eq!(
        recv(&receiver),
        Inbound::Render(View::default()),
        "非法/未知行必须被跳过，只有合法的空 view 被投递"
    );
    // 没有 stop 消息，文件结束等价 stop；随后 channel 关闭。
    assert_eq!(recv(&receiver), Inbound::Stop, "EOF 等价 stop（契约 §1）");
    assert_channel_closed(&receiver, "EOF");
}

#[test]
fn reader_delivers_stop_on_eof_without_any_data() {
    // 父进程刚启动就关闭 fd3：必须立即视为 stop（契约 §1）。
    let receiver = ipc::spawn_reader(Cursor::new(Vec::new()));
    assert_eq!(recv(&receiver), Inbound::Stop);
    assert_channel_closed(&receiver, "空 fd3（父进程已退出）");
}

#[test]
fn reader_accepts_a_final_line_without_newline_and_crlf() {
    // CRLF 行：尾部 \r 必须被剥掉，否则 JSON 解析失败。
    let mut crlf = String::from(RENDER_LINE);
    crlf.push_str("\r\n");
    let receiver = ipc::spawn_reader(Cursor::new(crlf.into_bytes()));
    assert!(
        matches!(recv(&receiver), Inbound::Render(_)),
        "CRLF 结尾的 render 行必须被接受"
    );
    assert_eq!(recv(&receiver), Inbound::Stop);
    assert_channel_closed(&receiver, "CRLF 行 + EOF");

    // 末行没有换行符也必须被当作一条完整消息（契约 §1：逐行 JSON）。
    let receiver = ipc::spawn_reader(Cursor::new(RENDER_LINE.as_bytes().to_vec()));
    assert!(
        matches!(recv(&receiver), Inbound::Render(_)),
        "最后一行没有 \\n 也必须被投递"
    );
    assert_eq!(recv(&receiver), Inbound::Stop);
    assert_channel_closed(&receiver, "无结尾换行 + EOF");
}

#[test]
fn reader_keeps_render_order() {
    let mut input = String::new();
    input.push_str(&line_of(
        serde_json::json!({"type":"render","view":{"input":"第一"}}),
    ));
    input.push_str(&line_of(
        serde_json::json!({"type":"render","view":{"input":"第二"}}),
    ));
    input.push_str(&line_of(serde_json::json!({"type":"stop"})));
    let receiver = ipc::spawn_reader(Cursor::new(input.into_bytes()));

    // 高频 render 必须按发送顺序投递，由事件循环合并到下一帧。
    let Inbound::Render(first) = recv(&receiver) else {
        panic!("期望第一条 render");
    };
    let Inbound::Render(second) = recv(&receiver) else {
        panic!("期望第二条 render");
    };
    assert_eq!(first.input, "第一");
    assert_eq!(second.input, "第二");
    assert_eq!(recv(&receiver), Inbound::Stop);
    assert_channel_closed(&receiver, "stop");
}

// ---------------------------------------------------------------------------
// fd4：Out
// ---------------------------------------------------------------------------

#[test]
fn out_emits_one_newline_terminated_json_line_per_message() {
    let (sink, bytes) = SharedSink::new();
    let out = Out::new(sink);

    out.ready().expect("ready 写入成功");
    out.key("a", payload("a")).expect("key 写入成功");
    out.resize(100, 30).expect("resize 写入成功");
    out.error("fatal: 父进程已退出").expect("error 写入成功");

    let text = String::from_utf8(bytes.lock().expect("sink 锁").clone())
        .expect("fd4 必须是 UTF-8 单行 JSON");
    // 契约 §1/§3：每条消息一行、以 \n 结尾，绝不写空行。
    assert!(text.ends_with('\n'), "每条 fd4 消息都必须以 \\n 结尾");
    assert_eq!(
        text.matches('\n').count(),
        4,
        "四条消息必须恰好四个换行（每条立即 flush，不合并、不多写）"
    );
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 4);

    // ready：唯一合法的初始化完成通知。
    let ready: serde_json::Value = serde_json::from_str(lines[0]).expect("ready 必须是合法 JSON 单行");
    assert_eq!(ready, serde_json::json!({"type": "ready"}));

    // key：type/str/key 四修饰位齐全（契约 §3 必填字段）。
    let key: serde_json::Value = serde_json::from_str(lines[1]).expect("key 必须是合法 JSON 单行");
    assert_eq!(key["type"], "key");
    assert_eq!(key["str"], "a");
    assert_eq!(key["key"]["name"], "a");
    assert_eq!(key["key"]["ctrl"], false);
    assert_eq!(key["key"]["meta"], false);
    assert_eq!(key["key"]["shift"], false);
    assert!(
        key["key"].get("sequence").is_none(),
        "sequence 可选：未提供时不得出现在线格式里（契约 §3）"
    );

    // resize：列/行数为数字。
    let resize: serde_json::Value =
        serde_json::from_str(lines[2]).expect("resize 必须是合法 JSON 单行");
    assert_eq!(resize["type"], "resize");
    assert_eq!(resize["columns"], 100);
    assert_eq!(resize["rows"], 30);

    // error：仅致命错误，message 原样。
    let error: serde_json::Value =
        serde_json::from_str(lines[3]).expect("error 必须是合法 JSON 单行");
    assert_eq!(error["type"], "error");
    assert_eq!(error["message"], "fatal: 父进程已退出");
}

#[test]
fn paste_key_keeps_newlines_and_never_appends_enter() {
    let (sink, bytes) = SharedSink::new();
    let out = Out::new(sink);

    // 契约 §3：粘贴只发一条 key，name="paste"，正文原样（含换行/中文/emoji），
    // 绝不自动追加 Enter。
    let body = "a\n中😀";
    out.key(body, payload("paste")).expect("paste 写入成功");

    let text = String::from_utf8(bytes.lock().expect("sink 锁").clone())
        .expect("fd4 必须是 UTF-8");
    assert_eq!(
        text.matches('\n').count(),
        1,
        "粘贴正文内部的换行必须被 JSON 转义，物理行只有一条"
    );
    let line = text.strip_suffix('\n').expect("必须以换行结尾");
    let value: serde_json::Value = serde_json::from_str(line).expect("一行合法 JSON");
    assert_eq!(value["type"], "key");
    assert_eq!(value["key"]["name"], "paste");
    let text_field = value["str"].as_str().expect("str 必须是字符串");
    assert_eq!(
        text_field, body,
        "粘贴正文必须原样保留换行/中文/emoji，且不得追加 Enter"
    );
    assert!(!text_field.ends_with("enter"));
    assert_eq!(
        text.lines().count(),
        1,
        "一次粘贴只能产生一条 fd4 消息（契约 §3）"
    );
}

#[test]
fn out_surfaces_write_and_flush_failures_as_err() {
    // 父进程已退出（EPIPE）时写失败必须冒泡，事件循环据此恢复终端并 exit 0。
    struct FailingWrite;
    impl Write for FailingWrite {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "父进程已退出"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let out = Out::new(FailingWrite);
    assert_eq!(
        out.ready().unwrap_err().kind(),
        io::ErrorKind::BrokenPipe,
        "fd4 写失败必须返回 Err"
    );
    assert_eq!(
        out.key("x", payload("text")).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(
        out.resize(80, 24).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(
        out.error("fatal").unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );

    // 写入成功但 flush 失败（缓冲未送达）同样必须返回 Err：每行都要 flush。
    struct FailingFlush;
    impl Write for FailingFlush {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            Ok(buffer.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::other("flush 失败"))
        }
    }
    let out = Out::new(FailingFlush);
    assert!(
        out.ready().is_err(),
        "flush 失败必须返回 Err（契约 §1：每行立即 flush）"
    );
}
