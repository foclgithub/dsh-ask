# dsh-ask

从终端驱动**本机正在运行的 DeepSeek Harness 桌面版**。

命令名统一为 `dsh-ask`，仓库目录为 `dsh-ask`；插件在桌面端的展示名为 `DSH Ask Terminal` / `DSH Ask 终端`。Host 插件包名和插件 ID 仍保留内部名 `dsh-local-cli` / `@local/dsh-local-cli`，这是兼容性约定，不随对外名称重命名。

它不启动第二个 Harness 进程：桥接插件在已经运行的 Host 内注册只允许 loopback 的 `/local-cli/*` 端点，CLI 通过 `$DSH_HOME/local-cli/{endpoint,token}` 找到端点并携带 token 访问。一次性问答、会话列表与历史、交互式聊天、图片附件和终端预览都在同一个命令里。在真实终端中，交互式聊天默认打开全屏界面；`--plain`、非 TTY 或 `--json` 时使用逐行界面。

## 组成

```text
dsh-ask.mjs            CLI 入口与逐行界面
dsh-media.mjs          图片读取、剪贴板、终端预览
dsh-tui.mjs            全屏业务层：会话、命令、按键、流式消息
dsh-native-screen.mjs  原生屏幕适配层（fd3/fd4 JSON）
dsh-i18n.mjs           语言判定与 catalog 翻译核心（resolveLanguage/createTranslator/nativeUiLabels）
dsh-cli-messages.mjs   CLI 与逐行界面的中英文案表
dsh-tui-messages.mjs   全屏界面的中英文案表
native/                Rust 原生显示层（dsh-ask-ui）
scripts/build-ui.sh    构建原生显示层
scripts/install.sh     安装 CLI
index.js               Host 侧桥接插件（@local/dsh-local-cli）
approval-channel.js    审批通道状态机（claim/lease/pending/answer）
approval-routes.js     `/local-cli/approval*` 路由适配
approval-transport.js  官方 owner/answer Node Client transport
cordis.patch.yml       桥接插件在 Host 中插入的插件行
```

`dsh-tui-screen.mjs` 是旧的纯 Node 屏幕层，仅保留给旧测试参考，不参与运行时，也不会被安装。全屏界面由原生层绘制。更细的进程边界和数据流见 [docs/architecture.md](docs/architecture.md)。

## 环境要求

- macOS。桌面版 Harness、剪贴板读取和应用拉起路径都按 macOS 提供。
- Node.js 20 或更新版本。需要内置 `fetch`；项目使用 ESM。
- 构建原生层时需要稳定版 Rust 工具链（`cargo`、`rustc`）；运行 CLI 不需要 Rust。
- 已安装并能正常启动 DeepSeek Harness 桌面版。
- 插件安装通过 `dsh` 启动器完成，由 Harness 自带的 pnpm 执行，不需要单独安装 pnpm。

## 安装桥接插件

桥接插件是 Host 侧的 `@local/dsh-local-cli`，不能只安装 CLI。先打开桌面版让它初始化一次 profile，然后**完全退出桌面版**（插件管理器会拒绝在桌面版运行时修改保留的 `desktop` profile），再在仓库根目录执行：

```sh
# 把路径换成仓库所在目录
dsh plugin --profile desktop add link:"$PWD"
```

这条命令把包加入 `desktop` profile 的依赖。`package.json` 中的 `dsh.bundle.patch: ./cordis.patch.yml` 会让插件管理器同时把 `@local/dsh-local-cli` 加入该 profile 的 `dsh.profile.bundles`；`cordis.patch.yml` 负责在 Host 插件树中插入 `local-cli` 行。正常情况下不需要手动修改 profile 的 YAML。

重新打开桌面版后，插件随 Host 启动注册 `/local-cli/health` 等端点。用 `dsh plugin --profile desktop remove @local/dsh-local-cli` 卸载时，插件管理器也会把 bundle 从 profile 中移除。手动安装或旧版 Host 的兜底方式：确认 profile 的 `package.json` 中依赖和 `dsh.profile.bundles` 都包含 `@local/dsh-local-cli`。

## 构建原生界面

全屏界面依赖 Rust 二进制 `dsh-ask-ui`。安装 CLI 前先构建：

```sh
./scripts/build-ui.sh
```

脚本执行两步，然后做一次 `--version` 冒烟：

```sh
cargo build --release --manifest-path native/Cargo.toml \
            --target-dir "$CARGO_TARGET_DIR"
cp "$CARGO_TARGET_DIR/release/dsh-ask-ui" native/bin/dsh-ask-ui
```

构建目录默认是 `${TMPDIR:-/tmp}/dsh-ask-native-target`；设置 `CARGO_TARGET_DIR` 可以改到其他位置，`scripts/install.sh` 会读取同一个变量。依赖由 cargo 从源码在本机编译，不下载预编译二进制；脚本不清理任何文件，构建失败时保留 target 目录以便排查。离线构建可设置 `CARGO_HOME` 和 `CARGO_NET_OFFLINE`，脚本会原样透传。

两个覆盖变量的用途不同：安装时用 `DSH_UI_BINARY` 指定要复制的构建产物；运行时用 `DSH_ASK_UI_BINARY` 指定 JS 适配层要启动的二进制路径。

## 安装 CLI

```sh
./scripts/install.sh
```

默认安装到 `$HOME/.local`，可以用 `DSH_CLI_INSTALL_ROOT` 改安装根目录：

```sh
DSH_CLI_INSTALL_ROOT="$HOME/.local/opt/dsh" ./scripts/install.sh
```

安装脚本写入以下路径：

```text
<root>/lib/dsh-ask/dsh-ask.mjs
<root>/lib/dsh-ask/dsh-media.mjs
<root>/lib/dsh-ask/dsh-tui.mjs
<root>/lib/dsh-ask/dsh-native-screen.mjs
<root>/lib/dsh-ask/dsh-i18n.mjs
<root>/lib/dsh-ask/dsh-cli-messages.mjs
<root>/lib/dsh-ask/dsh-tui-messages.mjs
<root>/lib/dsh-ask/dsh-ask-ui
<root>/bin/dsh-ask
```

安装前会一起校验七个 JS 模块和原生二进制：模块存在且能通过 `node --check`、相对 import 闭包正确（`dsh-ask.mjs` 静态引用 i18n 核心与 CLI 文案表，`dsh-tui.mjs` 引用 TUI 文案表）、`node dsh-ask.mjs --help` 能运行、原生二进制 `--version` 首行为 `dsh-ask-ui <semver>`。任何一项不满足都会在写入安装根之前失败。

已存在的文件会先备份为 `<文件名>.bak.<UTC时间戳>`，再用临时文件加 rename 原子替换。脚本不会删除文件，也不会修改 shell 配置、PATH、Host 配置或重启插件。安装后把 `<root>/bin` 加入 PATH，即可直接运行 `dsh-ask`。

`client.js` 是 Host 浏览器资源（插件包 `./client` 导出，随插件在桌面端加载），**不在**这个 CLI 安装脚本的复制清单里。

## 快速使用

```sh
dsh-ask "看一下 tests 为什么失败"      # 一次性问答（流式输出）
dsh-ask -s <session-id> "继续修复"     # 往已有会话提问
dsh-ask list                           # 最近会话
dsh-ask history <session-id>           # 打印会话记录
dsh-ask                                # 交互模式：当前目录打开本地草稿（默认全屏，首次发送才创建）
dsh-ask resume                         # 交互模式：会话列表（默认当前 workspace，可切全部）
dsh-ask connect <session-id>           # 进入已有会话
dsh-ask --plain                        # 逐行交互界面
dsh-ask new -w <workspace>             # 只建会话不发问
dsh-ask workspaces                     # 工作区与会话数
dsh-ask queue <session-id>             # 排队中的消息
dsh-ask status [session-id]            # 模型、上下文、token 与计时状态
dsh-ask permissions [session-id]       # 当前权限 preset 与可选值
dsh-ask permissions set <preset> [session-id] [--yes]  # 切换 preset；高危项需 --yes
dsh-ask awaiting [session-id]          # 待审批/待回答问题
dsh-ask answer <session-id> <callId> --select <qid>=<label>  # 仅回答 continued 问题
dsh-ask approval status [claimId]        # 终端审批通道状态与 pending
dsh-ask approval claim <session-id>      # 显式接入该会话的审批（租约默认 60s）
dsh-ask approval release <claimId>       # 释放 claim；pending 交回后续处理
dsh-ask approval answer <claimId> <requestId> --allow-once|--reject --confirm
                                         # 提交一次人工审批决定（本地提交，待 Host 确认）
dsh-ask --lang en status                 # 用英文输出状态
DSH_ASK_LANG=en dsh-ask list             # 用环境变量固定英文
```

常用选项：`-c/--cwd`、`-w/--workspace`、`-t/--timeout <ms>`（默认 180000）、`--json`、`--no-stream`、`--no-history`、`--plain`、`--color`、`--lang zh|en`、`-u/--url`、`--no-start`、`--start-timeout`、`--app`。`--` 之后的内容都当作提示词文本。带提示词的一次性问答、`list`、`history`、`workspaces`、`queue`、`status` 不进入全屏界面。`--json` 下 stdout 保持纯 JSON；参数或附件错误退出码为 2，失败为 1。

## 语言：中文与 English

界面文字有两套：中文和英文，默认中文。它只切换**本工具自己打印的文字**，不影响会话内容，也不是给模型的回答语言指令。桌面版 **Plugins > DSH Ask 终端 > 组件配置** 里有语言下拉（`auto|zh|en`）和保存按钮；这个设置页由插件包里的 Host 浏览器资源 `client.js` 注册（不是 CLI 安装器安装的模块）。`auto` 表示交给系统 locale（最终回退中文）。

选择顺序，前者优先、命中即停：

1. 命令行 `--lang zh|en`，也接受 `--lang=zh` 写法。所有子命令和交互入口都认它，放在子命令前后均可：
   `dsh-ask --lang en status <id>`、`dsh-ask status <id> --lang en`、`dsh-ask --lang en`、
   `dsh-ask connect --lang en`、`dsh-ask resume --lang en`；`-h/--help` 的帮助文本同样跟随它。
2. 有效的 `DSH_ASK_LANG=zh|en`。
3. 桌面插件设置里非 `auto` 的语言（`zh` / `en`）：在 Plugins > DSH Ask 终端 > 组件配置 里选择并保存（设置页由 `client.js` 提供，保存经 Host settings 写入 profile）；CLI 成功连上 Host 后从 `/local-cli/health` 的 `cliPreferences.language` 读取该偏好（默认 `auto`，`auto` 表示不指定）。`Config` schema 只定义字段与文案，本身不生成 UI；volatile 只是插件读取时的实时配置引用，不代表不持久化。
4. 系统 locale，按 POSIX 顺序 `LC_ALL` > `LC_MESSAGES` > `LANG`。`zh*`（如 `zh_CN.UTF-8`、`zh-Hans`）→ 中文，`en*`（如 `en_US.UTF-8`、`en-GB`）→ 英文。
5. 都没有，或值为 `C` / `POSIX` / 无法识别的语言 → 中文。

- 非法的 `--lang` 是用法错误，退出码 2；非法的 `DSH_ASK_LANG` 只告警一次并忽略，继续按后续顺序判定。
- `--help`、参数错误和连接前错误是离线路径：只按 `--lang` / `DSH_ASK_LANG` / locale 判定，不会为了显示帮助或报错去连接或启动 Host。
- 语言只在启动阶段确定一次（连接 Host 后会按插件偏好再判定一次），之后整个命令期间不再变化。桌面改插件设置不会热更新已打开的全屏/逐行会话；重启 CLI 命令后生效（换 `--lang` / 环境变量同理）。
- 不翻译的内容：聊天内容（用户消息、模型回答、工具输出）、Host 数据（会话标题、cwd/路径、Session id、模型名、问题与审批标签）、JSON 的键与值、错误码（`code` 字段）。`--json` 输出与语言无关，两种语言逐字节相同。
- 全屏界面和原生显示层使用同一套判定：CLI 解析一次后把语言传给业务层，提示行、状态行、命令表、弹窗标题按该语言显示；原生层不读 locale 或环境变量，只绘制 JS 每帧传来的文字（`view.ui`，见 [docs/architecture.md](docs/architecture.md)）。
- 仓库里的 `locale/en.json`、`locale/zh.json` 目前仍只有 Host 插件清单的元信息（`meta.title` / `meta.description`）；插件设置项的展示文案目前内联在 `index.js` 的 `Config` schema（i18n 标签）和 `client.js` 里，尚未放进这两个文件。它们都不是 CLI 运行时 catalog，CLI 文案在 `dsh-cli-messages.mjs` / `dsh-tui-messages.mjs` 里。

**English summary.** `--lang zh|en` (or `--lang=zh`) selects the text this tool prints and works for every subcommand and interactive entry (`connect`, `resume`, bare `dsh-ask`), before or after the subcommand; `-h/--help` follows it too. `DSH_ASK_LANG=zh|en` does the same. The desktop **Plugins > DSH Ask Terminal > Component config** language setting (`auto|zh|en`) is rendered by the plugin's browser resource `client.js` (not a CLI-installer module); saving writes the profile through the Host settings form. The setting applies only after the CLI reaches the Host (read from `health.cliPreferences.language`; `Config` only defines the field and labels, and `volatile` is a live read reference, not a non-persistence claim): a non-`auto` value wins over the POSIX locale chain `LC_ALL` > `LC_MESSAGES` > `LANG` (`zh*` → Chinese, `en*` → English), and `C`/`POSIX`/unknown/unset falls back to Chinese. `--help`, argument errors and pre-connection errors are offline: they use `--lang`/`DSH_ASK_LANG`/locale only and never connect to or start the Host. The language is settled during startup (after reaching the Host it is resolved again from the plugin preference), so a running TUI or line session needs a CLI restart to pick up a changed plugin setting or flag. It localizes this tool's own wording only: chat content, Host data, paths/ids, JSON keys and values and error codes pass through verbatim, and `--json` is byte-identical in both languages. It is not an instruction for the model's answer language. `locale/en.json` and `locale/zh.json` currently hold only the Host plugin manifest metadata (`meta.title`/`meta.description`); the plugin-settings labels (language) live inline in the `index.js` `Config` schema i18n labels and in `client.js`, not in those files. Neither is a runtime CLI catalog.

## 全屏界面

stdin 和 stdout 都是终端时，裸 `dsh-ask`、`connect`、`resume` 以及不带提示词的 `-s <id>` 默认进入独占全屏界面；`--plain`、`DSH_ASK_PLAIN=1`、`--json`、`TERM=dumb` 或非 TTY 时退回逐行界面。原生层负责终端 raw 模式、备用屏幕、光标、bracketed paste、鼠标滚轮和 SIGWINCH；会话、草稿、命令、附件和流式消息仍由 Node 业务层处理。协议 JSON 只走 fd3/fd4，原生层不访问网络、不读 token、不启动 Host。

TTY 交互启动打开的是**本地草稿**，不会立即创建 Host 会话；第一次实际发送才按当前 cwd（或 `-w` / `--create-workspace`）创建。`/new`、Ctrl+N 和会话选择器里的“新建”同样先开草稿，首次发送才创建；显式非交互的 `dsh-ask new` 仍立即创建。

会话选择器（picker）随本仓库小项完成并已安装；已在真实 PTY 验证：裸启动进入草稿、Ctrl+P 默认当前 workspace、可切换到全部会话、退出不新增空会话（验证前后当前 workspace 会话数 26→26）。

界面按 Codex CLI 的交互习惯组织：

- 顶部是标题和当前 cwd，中间是 transcript，底部是无边框灰底输入区。
- 新输入区按 Codex composer 的几何：最少 3 行（上留白 1 行、输入行、下留白 1 行），左内缩 2 列、右内缩 1 列；有附件时依次是附件行、分隔行和草稿；多行草稿按窗口高度增长，最多约面板高度的 2/3。
- 输入区下方最多两行状态信息：首行是模型、effort、权限预设和运行状态，次行是上下文占用、累计 token、cache 命中、轮/步和输出速度；窄屏先缩为一行再隐藏。
- 会话列表和帮助是整页；`/` 命令菜单贴在输入区上方，不重排 transcript。
- 鼠标只用于滚轮逐行滚动；点击、拖拽和复制选择暂不支持。

状态信息依赖桥接插件新增的 `/local-cli/status` 端点。bridge 代码更新后需要让 Host 重新加载插件才会生效：开发时通过 `link:` 安装的包可在 profile 重组时由 Host HMR 单独重载，**不需要重启桌面版**；已安装的正式包按 Host 的插件更新流程重新加载。未重载 bridge 的实例上这两行显示 `—`，`dsh-ask status` 会明确报错，聊天不受影响。该端点已在真实运行的桌面 Host 上通过 HMR 重载验证，能读到真实字段。

### 主要键位

| 按键 | 作用 |
| --- | --- |
| Enter | 发送草稿；菜单/列表里执行当前项 |
| Alt+Enter / Ctrl+J | 插入换行 |
| `/` | 输入框行首打开命令菜单 |
| `?` / F1 | 打开快捷键帮助 |
| Tab | 补全 `/` 命令或菜单选中项 |
| ↑ / ↓ | 选择菜单/列表项，或召回输入历史 |
| ← → / Home / End | 移动光标 |
| PgUp / PgDn | 按屏滚动 transcript |
| Esc | 关菜单/弹层；等待时中断本地等待；已上滚时回到底部 |
| Ctrl+C | 先关弹层/清草稿；等待时中断本地等待；否则退出 |
| Ctrl+P / Ctrl+N | 打开会话列表 / 在当前目录新建会话 |
| F2 / F3 | 打开待处理请求 / 权限预设 |
| Ctrl+V | 把剪贴板图片加为附件（macOS） |
| Ctrl+L | 只清空当前界面消息 |
| Ctrl+Q / Ctrl+D | 退出 |

### 斜杠命令

主命令：`/resume`、`/new`、`/quit`、`/help`、`/status`、`/history`、`/clear`、`/attach <paths>`、`/paste`、`/attachments`、`/detach <n>|all`、`/preview <n>`、`/send`、`/pending`（含 `/edit <n> <text>`、`/drop <n>`、`/steer <n>`）、`/permissions`、`/approvals`、`/id`。兼容别名：`/sessions`、`/switch`、`/exit`、`/queue`、`/multiline`、`/end`。

## 逐行模式

逐行模式保留先选会话/新建再逐行聊天的流程。交互命令包括 `/attach`、`/paste`、`/attachments`、`/detach`、`/preview`、`/send`、`/multiline`（用单独一行 `/end` 提交）、`/status`、`/clear`、`/help`、`/history`、`/id`、`/pending`、`/edit`、`/drop`、`/steer`、`/exit`（或 Ctrl+D）。

`--preview auto|never|iterm|kitty` 只影响逐行模式和一次性问答：`auto` 在 iTerm2 / kitty 中画图，其他终端退化为一行文本摘要；全屏界面的 `/preview` 只显示附件信息。

## 图片附件

```sh
dsh-ask --image shot.png "这张图里有什么"
dsh-ask --image a.png --image b.png "对比一下"
dsh-ask --paste "看剪贴板里的图"
```

- 最多 4 张；单张不超过 5 MiB，合计不超过 12 MiB；支持 PNG / JPEG / GIF / WEBP，按文件头判断真实格式。超限在发送前拒绝。
- 相对路径按 `--cwd`（默认当前目录）解析；路径按字面处理，不经过 shell。
- `--paste` 和 Ctrl+V 通过 macOS 剪贴板读取图片；Linux/Windows 上不可用。
- 图片通道与模型视觉能力是两件事：当前桌面默认的 DeepSeek 模型不支持图片输入，带图请求会被 Host 以 `image-model-unsupported`（HTTP 422）拒绝。是否能看图取决于你在桌面版中选择的模型；CLI 不会替用户切换模型。

## 状态与限制

- `dsh-ask status` 和全屏状态行只读取 Host 的模型/effort、上下文压力、token 累计、会话统计、权限预设和运行状态；不返回原始投影、Session header、provider 配置或凭据。旧 Host 缺少 `/local-cli/status` 时，`status` 会明确报错，全屏状态行降级为 `—`。
- 桌面版没有费用字段，CLI 不显示费用；上下文占用和累计 token 是不同概念。
- Esc / Ctrl+C 只停止本地等待，不向 Host 发送取消；远端会话可能继续运行。被中断的附件会标为未确认，不会自动重发。
- 工具审批可通过终端审批通道处理：先对当前会话显式 `approval claim`，桌面与终端谁先给出显式人工答复谁生效；旧 Host 缺审批路由时明确降级到桌面。`open` 问题仍只能到桌面处理；只有 `continued` 问题可由人用 `dsh-ask answer` 显式回答。CLI 不会自动作答，也不会切换模型或启动第二个 Host。
- 全屏界面不渲染图片；预览只在逐行模式和一次性问答中可用，且可能退化为文本摘要。
- 桥接端点只监听 loopback，token 文件权限为 0600；仓库不包含 token、endpoint 或真实会话日志。
- 全屏退出时由原生层恢复终端。原生进程异常退出会以非零码结束，不会挂在死终端上。

## 权限与待应答

权限 preset 与 `continued` 问题的应答已按本仓库契约实现。终端审批通道（状态机、路由、官方 Node Client transport、CLI 与全屏界面）已实现并通过离线测试；`index.js` 已接线审批路由与惰性 transport（只在显式 claim 时才建立官方 owner/answer Node Client）。桥接插件已在真实桌面 Host 完成插件重载：`GET /local-cli/approval` 已上线；安装的 `dsh-ask` 在新建的专用空白会话中真实 `claim` 成功（`connected:true`、pending 0），`release` 成功（delegated 0）后 `claim:null`；验证未对任何真实审批作答。旧 Host 缺少 `/local-cli/approval*` 路由或 `/local-cli/health` 无 `capabilities.approvalChannel` 时，相关命令明确报旧 Host/不支持并降级到桌面，聊天不受影响。

- `dsh-ask permissions [session]` 读取当前 preset 和 Host catalog；`permissions set <preset> [session] [--yes]` 切换 preset。`danger-full-access`、`auto` 是高危切换，必须显式加 `--yes`；全屏界面用 `/permissions`（F3）并在独立确认页二次确认。
- `dsh-ask awaiting [session]` 列出 pending 种类和 `userQuestions` 投影中的问题；全屏界面用 `/approvals`（F2）。`open` 问题仍只显示桌面端处理指引；工具审批只有在审批通道可用时才有允许/拒绝入口。
- 工具审批的终端通道是**显式、逐会话、非排他**的：`approval claim <session>` 由用户二次确认后接入当前会话（默认租约 60s，需由调用方心跳续租），`approval release <claimId>` 主动交回；桌面端与终端都可能收到同一 pending，**先给出显式人工答复的一方生效**，另一方收到取消通知。终端不能阻止桌面同时展示同一请求。
- 人工只能选择 `allowed-once` 或 `rejected`；`cancelled`/`unavailable` 由 Host 的请求取消或通道缺失决定，不是用户选项。答复命令的返回只表示**本地已提交、等待 Host 确认**，不表示 Host 已允许或已写入审计。
- claim 到期、主动 release、连接断开、请求 signal 取消时，未答复请求一律交回后续 answerer/桌面（fail closed），不会被终端自动允许或拒绝；不会自动重连旧 claim，也不会自动重试旧答复。
- `continued` 问题的回答流程保持不变：只有 `state:"continued"` 的问题可以由人用 `dsh-ask answer` 显式选择 Host 提供的标签（或 `--custom`、`--skip`）后提交；`open` 问题没有 Host 答复 API，必须到桌面端处理。
- 不自动允许/拒绝，不伪造审批结果，不把一次性允许扩大为会话级允许，不猜测标签。`answer` 只供用户显式操作；agent/自动化调用不得用它代答审批或问题。

## 测试

```sh
node --test tests/*.test.mjs
cargo test --manifest-path native/Cargo.toml
```

Node 测试使用假 Host，覆盖参数解析、子命令输出、逐行界面、全屏业务层和桥接协议；Rust 测试使用 TestBackend，覆盖布局、按键/粘贴解码、fd3/fd4 协议和状态行。两者都不读写真实会话或凭据。

## 许可

本仓库按 [MIT](./LICENSE) 许可证发布（根目录 `LICENSE`、`package.json` 与 `native/Cargo.toml` 均为 `MIT`）。

全屏界面的布局与按键参考 Codex CLI 的交互形态，未复制其源码；原生层使用 Ratatui + Crossterm。
