//! `dsh-ask-ui` 命令行快速路径契约（协议文档 §6）。
//!
//! 契约点：`--version` / `--help` 必须能在**没有终端、没有 fd3/fd4** 的环境里
//! 直接 exit 0，因为安装器和 JS 层会在非交互环境调用二进制做版本探测；未知参数
//! 必须 exit 2 且只写 stderr。
//!
//! 测试直接用 Cargo 注入的真实二进制（`CARGO_BIN_EXE_dsh-ask-ui`），不 mock：
//! 子进程的 stdin/stdout 全部换成管道（因此不是 TTY），另有两个用例用 `sh`
//! 显式关闭或重定向 fd3/fd4，验证快速路径确实不依赖这两个管道。

use std::process::{Command, Output, Stdio};

/// Cargo 编译集成测试时注入的二进制绝对路径。
const BIN: &str = env!("CARGO_BIN_EXE_dsh-ask-ui");

/// 期望的版本行：`dsh-ask-ui <version>\n`（`CARGO_PKG_VERSION` 与二进制同包）。
fn expected_version_line() -> String {
    format!("dsh-ask-ui {}\n", env!("CARGO_PKG_VERSION"))
}

/// 以“非 TTY、无 fd3/fd4”的方式运行二进制：stdin/stdout/stderr 全部为管道。
fn run(args: &[&str]) -> Output {
    let mut child = Command::new(BIN)
        .args(args)
        // 不让调试开关影响 stderr 断言（契约 §1 默认静默）。
        .env_remove("DSH_ASK_UI_DEBUG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("无法启动 {BIN}: {error}"));
    // 立刻关闭子进程 stdin：读端立即 EOF，且它一定不是 TTY。
    drop(child.stdin.take());
    child
        .wait_with_output()
        .unwrap_or_else(|error| panic!("等待 {BIN} 退出失败: {error}"))
}

/// 借助 sh 构造精确的 fd3/fd4 状态后 exec 二进制；`$0` 就是二进制路径。
#[cfg(unix)]
fn run_via_sh(script: &str) -> Output {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(script)
        .arg(BIN)
        .env_remove("DSH_ASK_UI_DEBUG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("启动 sh");
    drop(child.stdin.take());
    child.wait_with_output().expect("等待 sh 退出")
}

#[test]
fn version_prints_exactly_one_line_and_exits_zero() {
    let output = run(&["--version"]);

    // 契约 §6：--version 打印 `dsh-ask-ui <semver>` 到 stdout 并 exit 0。
    assert_eq!(output.status.code(), Some(0), "--version 必须 exit 0");
    assert_eq!(
        String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8"),
        expected_version_line(),
        "--version 的 stdout 必须恰好是 `dsh-ask-ui <version>\\n`（不得有协议 JSON 或其他输出）"
    );
    // 契约 §1：stderr 默认静默，快速路径不应写任何错误/调试信息。
    assert!(
        output.stderr.is_empty(),
        "--version 不得写 stderr，实际: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn short_version_alias_matches_long_form() {
    // cli 模块同时接受 `-V`；两者输出必须一致，安装器只依赖其一。
    let output = run(&["-V"]);
    assert_eq!(output.status.code(), Some(0), "-V 必须 exit 0");
    assert_eq!(
        String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8"),
        expected_version_line(),
        "-V 的输出必须与 --version 完全一致"
    );
    assert!(output.stderr.is_empty(), "-V 不得写 stderr");
}

#[test]
fn help_exits_zero_and_contains_usage() {
    let output = run(&["--help"]);

    // 契约 §6：--help 同样安全（不碰 TTY/fd3/fd4）且 exit 0。
    assert_eq!(output.status.code(), Some(0), "--help 必须 exit 0");
    let stdout = String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8");
    assert!(
        stdout.contains("Usage:"),
        "--help 必须包含用法说明，实际: {stdout:?}"
    );
    assert!(
        stdout.contains("--version") && stdout.contains("--help"),
        "--help 必须列出 --version/--help 两个安全参数"
    );
    assert!(stdout.contains("dsh-ask-ui"), "--help 必须包含二进制名");
    assert!(output.stderr.is_empty(), "--help 不得写 stderr");
}

#[test]
fn short_help_alias_contains_usage() {
    let output = run(&["-h"]);
    assert_eq!(output.status.code(), Some(0), "-h 必须 exit 0");
    let stdout = String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8");
    assert!(stdout.contains("Usage:"), "-h 必须包含用法说明");
    assert!(output.stderr.is_empty(), "-h 不得写 stderr");
}

#[test]
fn unknown_argument_exits_two_and_only_writes_stderr() {
    let output = run(&["--definitely-not-an-option"]);

    // cli 的“意外参数”路径返回 2；必须在这里就失败，而不是走到 app::run。
    assert_eq!(
        output.status.code(),
        Some(2),
        "未知参数必须 exit 2（协议文档的致命错误码）"
    );
    // 契约 §1：stdout 只用于终端控制序列，绝不能出现人类可读错误文本。
    assert!(
        output.stdout.is_empty(),
        "未知参数不得写 stdout，实际: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8(output.stderr).expect("stderr 必须是 UTF-8");
    assert!(
        stderr.contains("unexpected argument"),
        "stderr 必须说明是参数错误，实际: {stderr:?}"
    );
    assert!(
        stderr.contains("usage:"),
        "stderr 必须附带用法提示，实际: {stderr:?}"
    );
}

#[cfg(unix)]
#[test]
fn version_works_with_fd3_and_fd4_closed() {
    // 显式关闭 3/4 后 exec：子进程完全没有 fd3/fd4。
    // 契约 §6：--version 不校验也不读取 fd3、不写 fd4，因此仍须 exit 0。
    let output = run_via_sh("exec 3<&- 4>&-; exec \"$0\" --version");

    assert_eq!(
        output.status.code(),
        Some(0),
        "缺少 fd3/fd4 时 --version 仍必须 exit 0"
    );
    assert_eq!(
        String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8"),
        expected_version_line(),
        "--version 的 stdout 必须只有版本行"
    );
    assert!(output.stderr.is_empty(), "--version 不得写 stderr");
}

#[cfg(unix)]
#[test]
fn version_neither_reads_fd3_nor_writes_fd4() {
    // fd3 = /dev/null（存在且可读，但立即 EOF）；fd4 = stdout 的副本。
    // 如果 --version 误把 ready/error 等协议 JSON 写到 fd4，这些字节会混进
    // 被捕获的 stdout，使“恰好一行版本号”的断言失败。
    let output = run_via_sh("exec 3</dev/null 4>&1; exec \"$0\" --version");

    assert_eq!(output.status.code(), Some(0), "提供 fd3/fd4 时 --version 仍须 exit 0");
    assert_eq!(
        String::from_utf8(output.stdout).expect("stdout 必须是 UTF-8"),
        expected_version_line(),
        "--version 不得读写 fd3/fd4：stdout 里只能有版本行（契约 §6）"
    );
    assert!(output.stderr.is_empty(), "--version 不得写 stderr");
}

#[test]
fn bare_invocation_without_a_tty_is_a_fatal_error_without_stdout() {
    // 无参启动需要 TTY + fd3/fd4（契约 §5）。本用例用管道替代，必须走致命
    // 错误路径 exit 2，且 stdout 上绝不能出现协议 JSON 或错误文本。
    let output = run(&[]);

    assert_eq!(
        output.status.code(),
        Some(2),
        "非 TTY（或缺少 fd3/fd4）时无参启动必须 exit 2"
    );
    assert!(
        output.stdout.is_empty(),
        "致命错误不得写 stdout，实际: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
}
