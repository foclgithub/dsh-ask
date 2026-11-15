/**
 * dsh-cli-messages.mjs - the English/Chinese message catalog for `dsh-ask`.
 *
 * Every string the CLI itself prints (help text, subcommand output, prompts of
 * the line-based connect UI and local errors) is defined here exactly once.
 * Strings that come from the Host, the user, a tool, a path or an id are never
 * listed: those pass through verbatim.
 *
 * The catalog is keyed by the English source template, so the `en` text always
 * equals the key and a call site reads like the message it prints:
 *
 *   msg('cannot reach {url}: {error} ({what})', { url, error, what })
 *
 * A key that is missing at runtime renders as `⟦key⟧` (see `createTranslator`),
 * which is visible in a terminal and caught by tests/i18n-cli.test.mjs.
 */

/** Chinese translations. Keys are the English source templates. */
const ZH = {
  // ---------------------------------------------------------------- fragments
  error: '错误',
  hint: '提示',
  warning: '警告',
  ready: '就绪',
  starting: '正在启动',
  'waiting for the Host to answer': '等待 Host 响应',
  nothing: '空值',
  session: '会话',
  cwd: '目录',
  state: '状态',
  attachments: '附件',
  images: '图片',
  endpoint: '端点',
  'last turn': '上一轮',
  'last error': '上次错误',
  running: '运行中',
  idle: '空闲',
  queued: '排队',
  steering: '插入',
  context: '上下文',
  blank: '空白',
  ok: '成功',
  failed: '失败',
  none: '无',
  unknown: '未知',
  yes: '是',
  no: '否',
  accepted: '已接收',
  available: '可用',
  'unavailable (this Host offers no /permission command)': '不可用（此 Host 没有 /permission 命令）',
  '(new Sessions)': '（新建会话）',
  '(empty)': '（空）',
  '(no prompt)': '（无提示词）',
  '(no messages yet)': '（还没有消息）',
  'new conversation': '新对话',
  workspace: '工作区',
  '(reused)': '（复用）',
  '(created)': '（已创建）',
  '(workspace created)': '（已创建工作区）',
  'recent Sessions': '最近的会话',
  'which one?': '选哪一个？',
  'nothing picked': '未选择',
  'connect commands': '连接命令',
  'no workspaces yet': '还没有工作区',
  'no Sessions yet': '还没有会话',
  'no Sessions yet · a new conversation will be created in {detail}':
    '还没有会话 · 将在 {detail} 创建新对话',
  'workspace {name}': '工作区 {name}',
  'no entry {text}': '没有编号 {text}',
  'no Session starts with {text}': '没有会话 ID 以 {text} 开头',
  '{count} Sessions start with {text}': '有 {count} 个会话 ID 以 {text} 开头',
  'no Sessions yet - run `dsh-ask "text"` first': '还没有会话 - 先运行 `dsh-ask "text"`',
  'earlier messages omitted': '更早的消息已省略',
  present: '存在',
  'confirm in the desktop app': '请在桌面端确认',
  'answer from here': '可在此应答',
  'answer in the desktop app': '请在桌面端应答',
  '[multi-select]': '[多选]',
  'options: {options}': '选项：{options}',
  questions: '问题',
  claim: '认领',
  lease: '租约',
  connected: '连接',
  note: '说明',
  'local claim only; the desktop UI may answer the same request first':
    '仅本地认领；桌面端可能先应答同一请求',
  'nothing selected · no conversation was created': '未选择 · 没有创建对话',
  'Enter / n for a new conversation in this directory': '回车 / n 新建当前目录对话',
  'number, id prefix, or Enter / n for a new conversation': '编号、id 前缀，或 Enter / n 新建对话',
  'number or id prefix': '编号或 id 前缀',
  'try `dsh-ask --help`': '试试 `dsh-ask --help`',
  '--lang must be zh or en (got {value})': '--lang 只能是 zh 或 en（收到 {value}）',
  'ignoring DSH_ASK_LANG={value}: expected zh or en': '忽略 DSH_ASK_LANG={value}：应为 zh 或 en',

  'no text given': '没有给出文本',
  '--edit needs the replacement text': '--edit 需要替换文本',
  'local wait stopped': '本地等待已停止',
  pending: '待处理',
  sent: '已发送',
  '(nothing queued)': '（队列为空）',
  effort: '强度',
  tokens: '令牌',
  in: '输入',
  out: '输出',
  'cache read': '缓存读',
  'cache write': '缓存写',
  total: '总计',
  'cache hit': '缓存命中',
  '{turns} turns · {steps} steps': '{turns} 轮 · {steps} 步',
  'cumulative llm {value}': '累计 llm {value}',
  'tool {value}': '工具 {value}',
  'ttft avg {value}': '首字平均 {value}',
  'decode {value}': '解码 {value}',
  '{speed} tok/s': '{speed} tok/s',
  expires: '到期',
  model: '模型',
  stats: '统计',
  projected: '预估',
  pressure: '压力',
  permission: '权限',
  current: '当前',
  presets: '预设',
  default: '默认',
  set: '设置',

  // ---------------------------------------------------------------- usage text
  usage: `usage: dsh-ask [options] [text...]

One command. With text it asks; without text it opens the interactive UI.

  dsh-ask                     open a local draft in the cwd; the first send creates the Session
  dsh-ask "text"              one prompt into a new Session
  dsh-ask -s <id> "text"      one prompt into an existing Session
  dsh-ask "text" -w <ws>      ...in a workspace (creates one with --create-workspace)

  dsh-ask list [n]            recent Sessions
  dsh-ask history [id]        print a Session's conversation
  dsh-ask resume              pick an existing Session and attach to it
  dsh-ask connect             open a new local draft in the cwd
  dsh-ask connect <id>        attach to an existing Session
  dsh-ask new -w <ws>         create a Session without asking
  dsh-ask workspaces          workspaces with their Session counts
  dsh-ask queue [id]          pending prompts a Session is holding
  dsh-ask status [id]         model, context, token and timing status
  dsh-ask permissions [id]    current permission preset and the available presets
  dsh-ask permissions set <preset> [id]  switch this Session's preset (see --yes)
  dsh-ask awaiting [id]       approvals/questions a Session is waiting on
  dsh-ask answer <id> <callId> --select <qid>=<label>[,<label>]  answer a continued question
  dsh-ask approval status [claimId]   approval channel claim and pending requests
  dsh-ask approval claim <session> [--lease <ms>]  claim a Session's approvals (default 60000 ms)
  dsh-ask approval release <claimId>  release the claim; pending requests are delegated
  dsh-ask approval answer <claimId> <requestId> --allow-once|--reject --confirm
                                      submit one explicit approval decision
                                      (local submission only; the Host result is not confirmed here)

  A new conversation starts in the effective cwd (-c, else $PWD): the workspace
  whose normalized absolute path is exactly that directory is reused, and one is
  created when missing. An explicit -w wins over the cwd for that conversation.

  The full-screen UI opens a local draft and creates nothing until the first
  send. --plain keeps the older picker: bare start lists Sessions there, and
  Enter / n opens a new conversation.

options:
  -s, --session <id>   existing Session instead of a new one
  -c, --cwd <dir>      working directory for a new Session (default: $PWD)
  -w, --workspace <ref>  workspace by id, id prefix, title or path
      --create-workspace register that path as a workspace when it is new
  -l, --list [n]       same as \`list\` (default 15, max 50)
  -n, --tail <n>       history messages to read (default 60, max 300)
  -t, --timeout <ms>   how long to wait for a settled turn (default 180000)
  -u, --url <origin>   endpoint origin, overriding the recorded one
      --json           print the raw JSON instead of rendered text
      --plain          keep the line-based UI on a TTY (no full-screen TUI);
                       DSH_ASK_PLAIN=1 does the same for one environment
      --no-history     connect without printing the earlier conversation
      --no-stream      wait for the whole turn instead of printing as it runs
      --color <mode>   always / never / auto (default: auto, honours NO_COLOR)
      --lang <zh|en>   output language; priority --lang > DSH_ASK_LANG >
                       the desktop setting (only after connecting) >
                       LC_ALL/LC_MESSAGES/LANG > zh
      --no-start       never launch the Desktop app, even when it is not running
      --start-timeout <ms>  how long to wait for a launched app (default 60000)
      --app <path>     the Desktop bundle to launch (default: /Applications/DeepSeek Harness.app)
      --image <path>   attach an image to the prompt (repeatable; quoted paths and
                       terminal drag-drops with spaces are accepted)
      --paste          attach the clipboard image (macOS)
      --preview <mode> auto / never / iterm / kitty (default: auto)
      --remove/--steer <item>  with \`queue\`: drop or promote a pending item
      --edit <item> <text>     with \`queue\`: rewrite a pending item
      --yes            confirm a high-impact preset switch (danger-full-access / auto)
      --select <qid>=<label>[,<label>]  with \`answer\`: choose offered label(s)
      --custom <qid>=<text>    with \`answer\`: free-text answer for one question
      --skip <qid>     with \`answer\`: explicitly skip one question (empty answer)
      --lease <ms>     with \`approval claim\`: lease length (default 60000; 10000-600000)
      --allow-once     with \`approval answer\`: allow this one request (needs --confirm)
      --reject         with \`approval answer\`: reject this request (needs --confirm)
      --confirm        with \`approval answer\`: the user made the decision; nothing is sent without it
      --               everything after this is prompt text (even if it starts with -)
  -h, --help           show this help

Inside connect: /attach <paths>, /paste, /attachments, /detach <n>|all,
/preview <n>, /send, /multiline (end with /end), /status, /clear, /help,
/id, /history, /pending, /edit <n> <text>, /drop <n>, /steer <n>,
/sessions, /switch [id], /new, /exit or Ctrl+D leaves. Tab completes the
command name.
Ctrl+C stops only the local wait; the remote Session may keep running.

On a TTY the default interface is a full-screen TUI (--plain keeps the old
line-based one; piped input, --json and TERM=dumb never start it).
  Enter sends · Alt+Enter inserts a newline · Tab completes a /command
  Ctrl+P session picker · Ctrl+N new Session in the cwd · Ctrl+V clipboard image
  Ctrl+L clears the local view · PgUp/PgDn scroll · F1 help · Ctrl+Q quits
  Waiting for a turn blocks switching and creating: press Ctrl+C first, which
  stops only the local wait and never claims the remote Session was cancelled.`,

  // ---------------------------------------------------------------- parser
  '--preview must be auto, never, iterm or kitty (got {value})': '--preview 只能是 auto、never、iterm 或 kitty（收到 {value}）',
  '{flag} needs a positive integer (got {value})': '{flag} 需要一个正整数（收到 {value}）',
  '{flag} needs a value': '{flag} 需要一个值',
  'unknown option: {option}': '未知选项：{option}',

  // ---------------------------------------------------------------- images
  'cannot attach image: {error}': '无法附加图片：{error}',
  'too many images: {count} (max {max}); use /attach inside connect for more turns':
    '图片过多：{count}（上限 {max}）；connect 里用 /attach 可以分多轮附加',
  'attached images are too large: {bytes} (max {max})': '附加的图片过大：{bytes}（上限 {max}）',
  'too many images: {count} (this Host accepts {max})': '图片过多：{count}（此 Host 最多接受 {max}）',
  'attached images are too large: {bytes} (this Host accepts {max})':
    '附加的图片过大：{bytes}（此 Host 最多接受 {max}）',
  'an attached image has no media type': '有一张附加图片没有媒体类型',
  'this Host does not accept {mediaType} images': '此 Host 不接受 {mediaType} 图片',
  'this Host does not advertise image support: its DSH Ask Terminal is older than this CLI. Update DeepSeek Harness (or the local-cli plugin) and retry; text prompts still work.':
    '此 Host 没有声明图片支持：它的 DSH Ask 终端比当前 CLI 旧。更新 DeepSeek Harness（或 local-cli 插件）后重试；纯文本提问仍然可用。',
  'the current model does not support image input. Choose a vision-capable model in the DeepSeek Harness app and retry; this CLI will not switch models for you.':
    '当前模型不支持图片输入。请在 DeepSeek Harness 应用里换一个支持视觉的模型后重试；本 CLI 不会替用户切换模型。',

  // ---------------------------------------------------------------- host
  'no Host answers at {endpoint}': '{endpoint} 上没有 Host 响应',
  ' (auto-start disabled)': '（已禁用自动启动）',
  'the Desktop app cannot be launched from this CLI on this platform': '此平台上本 CLI 无法启动桌面应用',
  'the Desktop app is running but its local-cli endpoint is not answering - the plugin row may be disabled or the app is still starting. Check Plugins for "DSH Ask Terminal", or wait and retry.':
    '桌面应用在运行，但它的 local-cli 端点没有响应 - 插件行可能被禁用，或应用还在启动。请在“插件”里检查 “DSH Ask 终端”，或者稍后重试。',
  'could not launch {path}: {error}': '无法启动 {path}：{error}',
  'DeepSeek Harness did not answer within {seconds}s': 'DeepSeek Harness 在 {seconds} 秒内没有响应',
  'cannot reach {url}: {error} ({what})': '无法访问 {url}：{error}（{what}）',
  '{what} failed': '{what}失败',
  '{message} (the Host may be older than this CLI: no /local-cli/{route} route)':
    '{message}（Host 可能比本 CLI 旧：没有 /local-cli/{route} 路由）',
  'status unavailable': '状态不可用',
  '{message} (the Host may be older than this CLI)': '{message}（Host 可能比本 CLI 旧）',
  '{code}: {message}': '{code}：{message}',
  'no such Session': '没有这个会话',
  list: '列表',
  transcript: '对话记录',
  workspaces: '工作区',
  create: '创建',
  queue: '队列',
  'queue update': '队列更新',
  status: '状态',
  permissions: '权限',
  awaiting: '待处理请求',
  approval: '审批',
  answer: '回答',
  sessions: '会话',
  'fetchSessionContext needs a Session id': 'fetchSessionContext 需要一个会话 id',
  'this Host does not expose workspace session scope; Session context is unavailable':
    '此 Host 没有提供工作区会话范围；无法读取会话上下文',
  'no Session given and stdin is not a terminal': '没有给出会话，且 stdin 不是终端',
  'no Session given and stdin is not a terminal - pass a Session id': '没有给出会话，且 stdin 不是终端 - 请传入会话 id',

  // ---------------------------------------------------------------- turns
  'local wait stopped (the remote Session may still be running)': '已停止本地等待（远端会话可能仍在运行）',
  'the turn waits for a human answer': '这一轮在等待人工回答',
  'no settled turn in time': '没有在限定时间内完成一轮',
  'the turn failed': '这一轮失败了',
  'the turn ended with reason: {reason}': '这一轮以原因结束：{reason}',
  'the stream was cut before the turn settled: {error}': '流在这一轮结束前被中断：{error}',
  'the stream ended before the done frame; the turn may still be running in the app':
    '流在 done 帧之前结束；这一轮可能仍在应用里运行',
  'unknown failure': '未知失败',
  'partial answer:': '部分回答：',
  'waiting for a human in the app: {pending}': '正在等应用里的人工处理：{pending}',
  'session: {id}': '会话：{id}',
  'the prompt was accepted by the Host; it will not be resent automatically. Check /status and /history in connect before prompting again.':
    'Host 已接收这条提示词；不会自动重发。再次提问前请先在 connect 里看 /status 和 /history。',
  'the remote Session may still be running; check the app before resending so the prompt is not queued twice.':
    '远端会话可能仍在运行；重发前请先看应用，避免提示词被排两次队。',
  'full-screen TUI unavailable': '全屏 TUI 不可用',
  'native UI unavailable': '原生 UI 不可用',
  'using the line-based UI': '改用行式界面',
  'falling back to the line-based UI (--plain)': '回退到行式界面（--plain）',

  // ---------------------------------------------------------------- connect
  'attach images: /attach <path> [path ...] (quoted drag-drops work)':
    '附加图片：/attach <path> [path ...]（引号包住的拖拽路径也支持）',
  'attach the clipboard image (macOS)': '附加剪贴板图片（macOS）',
  'list pending and already-sent attachments': '列出待发和已发送的附件',
  'remove attachments: /detach <n> | /detach all': '移除附件：/detach <n> | /detach all',
  'render an attachment in this terminal: /preview <n>': '在本终端里预览附件：/preview <n>',
  'send the pending attachments with no text': '只发送待发附件，不带文本',
  'compose one prompt over several lines, ending with /end': '写多行提示词，用 /end 结束',
  'Session, cwd, queue, attachments and the last turn': '会话、目录、队列、附件和上一轮',
  'clear the screen only; the conversation is untouched': '只清屏；对话本身不动',
  'reprint the conversation': '重新打印对话',
  'queued prompts: /edit <n> <text>, /drop <n>, /steer <n>': '排队的提示词：/edit <n> <text>、/drop <n>、/steer <n>',
  'print the full Session id': '打印完整会话 id',
  'this list': '本列表',
  'leave (also /quit or Ctrl+D)': '离开（也可 /quit 或 Ctrl+D）',
  'Ctrl+C stops only the local wait; the remote Session may keep running.': 'Ctrl+C 只停止本地等待；远端会话可能仍在运行。',
  'Tab completes a command name.': 'Tab 补全命令名。',
  'attachments · {pending} pending · {sent} sent': '附件 · {pending} 个待发 · {sent} 个已发',
  '(none) · /attach <path> or /paste adds one': '（无）· 用 /attach <path> 或 /paste 添加',
  'sent / unconfirmed - kept for reference, never queued again automatically:':
    '已发送 / 未确认 - 只作参考，绝不会再自动排队：',
  'usage: /detach <n> | /detach all': '用法：/detach <n> | /detach all',
  'detached {count} attachment(s)': '已移除 {count} 个附件',
  'detached {name}': '已移除 {name}',
  'no attachment {argument}': '没有附件 {argument}',
  'usage: /preview <n>': '用法：/preview <n>',
  'no attachments · /attach <path> or /paste adds one': '没有附件 · 用 /attach <path> 或 /paste 添加',
  'usage: /attach <path> [path ...]': '用法：/attach <path> [path ...]',
  'nothing to send': '没有要发送的内容',
  'nothing to send: no pending attachments': '没有要发送的内容：没有待发附件',
  'images unavailable': '图片不可用',  'cannot attach': '无法附加',
  'cannot paste': '无法粘贴',
  'cannot preview': '无法预览',
  'cannot send images': '无法发送图片',
  'attached {name} ({label}, {bytes})': '已附加 {name}（{label}，{bytes}）',
  '… waiting for the turn · Ctrl+C stops only this local wait · the remote Session may keep running':
    '… 等待这一轮 · Ctrl+C 只停止本地等待 · 远端会话可能仍在运行',
  'stopped local wait': '已停止本地等待',
  'the remote Session may still be running; the turn was not cancelled remotely':
    '远端会话可能仍在运行；这一轮并没有在远端取消',
  'the {count} attachment(s) are listed as unconfirmed and will not be resent automatically':
    '{count} 个附件已标记为未确认，不会自动重发',
  'delivery unknown': '投递未知',
  'delivery is unknown · session {session} · check /history before resending; the prompt may already be queued':
    '投递结果未知 · 会话 {session} · 重发前先看 /history；提示词可能已经排队',
  'the {count} attachment(s) are listed as unconfirmed and will not be attached to later text automatically':
    '{count} 个附件已标记为未确认，不会自动附加到后续文本',
  'attachments kept locally: the Host explicitly did not accept this prompt, so nothing was queued':
    '附件仍留在本地：Host 明确没有接收这条提示词，所以没有排队',
  'attachments marked unconfirmed · session {session} · check /history before resending; the prompt may already be queued':
    '附件已标记为未确认 · 会话 {session} · 重发前先看 /history；提示词可能已经排队',
  'model cannot see images': '模型看不到图片',
  'choose a vision-capable model in the app, then /send again; the CLI never switches models for you':
    '在应用里换成支持视觉的模型，然后再 /send；CLI 绝不会替用户切换模型',
  'not supported by this Host (update DeepSeek Harness)': '此 Host 不支持（请更新 DeepSeek Harness）',
  'supported (up to {count})': '支持（最多 {count} 张）',
  'images  not supported by this Host · update DeepSeek Harness for attachments':
    '图片  此 Host 不支持 · 更新 DeepSeek Harness 以使用附件',
  'images  supported · up to {count} attached per prompt': '图片  支持 · 每条提示词最多附加 {count} 张',
  'commands /help · /attach /paste /attachments · Ctrl+C stops only the local wait':
    '命令 /help · /attach /paste /attachments · Ctrl+C 只停止本地等待',
  '{count} pending': '{count} 个待处理',
  ' · /pending to see, /edit <n> <text>, /drop <n>, /steer <n>':
    ' · 用 /pending 查看，/edit <n> <text>、/drop <n>、/steer <n>',
  'multiline cancelled': '多行输入已取消',
  'multiline: compose one prompt, finish with a line that is exactly /end · Ctrl+C cancels':
    '多行输入：写完一段提示词，用单独一行 /end 结束 · Ctrl+C 取消',
  'multiline was empty: nothing sent': '多行输入为空：没有发送',
  'no pending item {index}': '没有待处理项 {index}',
  'usage: /edit <n> <new text>': '用法：/edit <n> <new text>',
  'unknown command {command} · /help for the command list': '未知命令 {command} · /help 查看命令列表',
  'clear needs a TTY; nothing was deleted': '清屏需要 TTY；没有删除任何东西',
  '/end is only meaningful inside /multiline': '/end 只在 /multiline 内有效',
  '── connected ──': '── 已连接 ──',
  'no conversation was created': '没有创建对话',

  // ---------------------------------------------------------------- subcommands
  'summary · {duration} · {tools} tool call · session {session}': '汇总 · {duration} · {tools} 次工具调用 · 会话 {session}',
  'summary · {duration} · {tools} tool calls · session {session}': '汇总 · {duration} · {tools} 次工具调用 · 会话 {session}',
  'tool call': '工具调用',
  'tool calls': '工具调用',
  'no turns yet': '还没有轮次',
  'claim       none': '认领        无',
  '{label} {suffix}': '{label}{suffix}',
  'released {claimId}; delegated {count} pending request(s)': '已释放 {claimId}；交还 {count} 个待处理请求',
  'submitted {outcome} for request {requestId} on claim {claimId}': '已提交 {outcome}：请求 {requestId}，认领 {claimId}',
  'waiting for the Host to confirm; not confirmed here': '等待 Host 确认；此处不做确认',
  'answered {id} ({questions})': '已回答 {id}（{questions}）',
  '{count} question': '{count} 个问题',
  '{count} questions': '{count} 个问题',
  'permissions set needs a preset name': 'permissions set 需要一个预设名',
  'preset {preset} on {sessionId}': '已在 {sessionId} 上设置预设 {preset}',
  'preset {preset} {effect}; pass --yes after deciding explicitly':
    '预设 {preset} {effect}；明确决定后请加 --yes',
  'adds an automatic reviewer and widens access': '会加入自动评审并扩大访问范围',
  'removes approval prompts': '会移除审批提示',
  'approval needs an action: status, claim, release or answer':
    'approval 需要一个动作：status、claim、release 或 answer',
  'approval status takes at most one claimId': 'approval status 最多接受一个 claimId',
  'approval claim needs exactly one Session': 'approval claim 需要恰好一个会话',
  'approval release needs exactly one claimId': 'approval release 需要恰好一个 claimId',
  'approval answer needs a claimId and a requestId': 'approval answer 需要 claimId 和 requestId',
  'approval answer needs exactly one of --allow-once or --reject':
    'approval answer 需要 --allow-once 或 --reject 二者之一',
  'approval answer needs --confirm: the user must decide explicitly, and nothing was sent':
    'approval answer 需要 --confirm：必须由用户明确决定，否则不会发送任何内容',
  'unknown approval action {action} (use status, claim, release or answer)':
    '未知的 approval 动作 {action}（可用 status、claim、release、answer）',

  // ---------------------------------------------------------------- answer flags
  '{flag} needs <questionId>=<value>': '{flag} 需要 <questionId>=<value>',
  '--select needs a question id before "="': '--select 在 "=" 之前需要问题 id',
  '--select for {id} was given twice': '{id} 的 --select 给了两次',
  '--select {id}= needs at least one label': '--select {id}= 至少需要一个标签',
  '--custom needs a question id before "="': '--custom 在 "=" 之前需要问题 id',
  '--custom for {id} was given twice': '{id} 的 --custom 给了两次',
  '--custom {id}= needs text': '--custom {id}= 需要文本',
  '--skip needs a question id': '--skip 需要一个问题 id',
  '--skip {id} was given twice': '{id} 的 --skip 给了两次',
  'no such question {unknown} in this request (ids: {ids})':
    '本次请求没有这些问题 {unknown}（id：{ids}）',
  'question {id} is both skipped and answered': '问题 {id} 既被跳过又被回答',
  'label {label} is not offered by question {id} (offered: {offered})':
    '问题 {id} 没有提供标签 {label}（提供：{offered}）',
  'question {id} takes one label': '问题 {id} 只接受一个标签',
  'question {id} takes either --select or --custom, not both': '问题 {id} 只能用 --select 或 --custom 之一',
  'question {id} needs --select {id}=<label>, --custom {id}=<text> or --skip {id}':
    '问题 {id} 需要 --select {id}=<label>、--custom {id}=<text> 或 --skip {id}',
  ' (offered: {offered})': '（提供：{offered}）',
  'answer needs at least one --select, --custom or --skip':
    'answer 至少需要一个 --select、--custom 或 --skip',
  'with --session give exactly one callId': '使用 --session 时只能给一个 callId',
  'answer takes a Session, a callId and flags': 'answer 接受一个会话、一个 callId 和若干参数',
  'answer needs a callId (run `dsh-ask awaiting <session>` to list them)':
    'answer 需要一个 callId（用 `dsh-ask awaiting <session>` 列出）',
  '; this Session has a pending approval, which can only be confirmed in the desktop app':
    '；此会话有待处理审批，只能在桌面端确认',
  'stale-request: no active question has callId {callId}{hint}':
    'stale-request：没有活跃问题的 callId 是 {callId}{hint}',
  'not-answerable: this question is still blocking its tool call in the desktop Remote Event waterfall; answer it in the desktop app':
    'not-answerable：这个问题仍在桌面 Remote Event 流程里阻塞它的工具调用；请在桌面端回答',
}

/** The Chinese help text. The English original is the `usage` entry above. */
const USAGE_ZH = `用法：dsh-ask [options] [text...]

一条命令。带文本就是提问；不带文本就打开交互界面。

  dsh-ask                     在当前目录打开本地草稿，首条发送才创建会话
  dsh-ask "text"              向新会话发一条提示词
  dsh-ask -s <id> "text"      向已有会话发一条提示词
  dsh-ask "text" -w <ws>      ……在工作区中（配合 --create-workspace 可新建）

  dsh-ask list [n]            最近的会话
  dsh-ask history [id]        打印一个会话的对话
  dsh-ask resume              选择已有会话并接入
  dsh-ask connect             在当前目录打开新的本地草稿
  dsh-ask connect <id>        接入已有会话
  dsh-ask new -w <ws>         只创建会话、不提问
  dsh-ask workspaces          工作区及各自的会话数
  dsh-ask queue [id]          会话中待处理的提示词
  dsh-ask status [id]         模型、上下文、token 与时序状态
  dsh-ask permissions [id]    当前权限预设和可选预设
  dsh-ask permissions set <preset> [id]  切换该会话的预设（见 --yes）
  dsh-ask awaiting [id]       会话正在等待的审批/问题
  dsh-ask answer <id> <callId> --select <qid>=<label>[,<label>]  回答一个待答问题
  dsh-ask approval status [claimId]   审批通道的认领与待处理请求
  dsh-ask approval claim <session> [--lease <ms>]  认领会话的审批（默认 60000 毫秒）
  dsh-ask approval release <claimId>  释放认领；待处理请求会交还代理
  dsh-ask approval answer <claimId> <requestId> --allow-once|--reject --confirm
                                      提交一次明确的审批决定
                                      （仅在本地提交；Host 结果不在此确认）

  新对话在有效 cwd（-c，否则 $PWD）中开始：归一化绝对路径与之完全相同的
  工作区会被复用，没有则创建。显式 -w 优先于 cwd。

  全屏界面打开的是本地草稿，首条发送前既不创建会话也不创建工作区；--plain
  保留旧的选择界面：裸启动会列出会话，Enter / n 新建对话。

选项：
  -s, --session <id>   使用已有会话而不是新建
  -c, --cwd <dir>      新会话的工作目录（默认 $PWD）
  -w, --workspace <ref>  按 id、id 前缀、标题或路径指定工作区
      --create-workspace 工作区不存在时登记该路径
  -l, --list [n]       等同于 \`list\`（默认 15，最多 50）
  -n, --tail <n>       读取的历史消息数（默认 60，最多 300）
  -t, --timeout <ms>   等待一轮结束的时长（默认 180000）
  -u, --url <origin>   端点地址，覆盖已记录的地址
      --json           输出原始 JSON 而不是渲染后的文本
      --plain          在 TTY 上也保留行式界面（不启动全屏 TUI）；
                       DSH_ASK_PLAIN=1 效果相同
      --no-history     接入时不打印之前的对话
      --no-stream      等整轮结束再输出，而不是边跑边打印
      --color <mode>   always / never / auto（默认 auto，遵守 NO_COLOR）
      --lang <zh|en>   输出语言；优先级 --lang > DSH_ASK_LANG >
                       桌面设置（仅连接后生效）>
                       LC_ALL/LC_MESSAGES/LANG > zh
      --no-start       桌面应用没运行时也不尝试启动
      --start-timeout <ms>  等待启动的时长（默认 60000）
      --app <path>     要启动的桌面应用包（默认 /Applications/DeepSeek Harness.app）
      --image <path>   给提示词附加图片（可重复；支持带空格的引号路径和
                       终端拖拽）
      --paste          附加剪贴板图片（macOS）
      --preview <mode> auto / never / iterm / kitty（默认 auto）
      --remove/--steer <item>  配合 \`queue\`：删除或提前一个待处理项
      --edit <item> <text>     配合 \`queue\`：改写一个待处理项
      --yes            确认高影响预设切换（danger-full-access / auto）
      --select <qid>=<label>[,<label>]  配合 \`answer\`：选择给出的标签
      --custom <qid>=<text>    配合 \`answer\`：为某个问题自由作答
      --skip <qid>     配合 \`answer\`：明确跳过某个问题（空回答）
      --lease <ms>     配合 \`approval claim\`：租约时长（默认 60000；10000-600000）
      --allow-once     配合 \`approval answer\`：允许这一次（需 --confirm）
      --reject         配合 \`approval answer\`：拒绝这次请求（需 --confirm）
      --confirm        配合 \`approval answer\`：用户已做决定；没有它不发送任何内容
      --               之后的全部内容都当作提示词（即使以 - 开头）
  -h, --help           显示本帮助

connect 内：/attach <paths>, /paste, /attachments, /detach <n>|all,
/preview <n>, /send, /multiline（以 /end 结束）, /status, /clear, /help,
/id, /history, /pending, /edit <n> <text>, /drop <n>, /steer <n>,
/sessions, /switch [id], /new, /exit 或 Ctrl+D 离开。Tab 补全命令名。
Ctrl+C 只停止本地等待；远端会话可能仍在运行。

在 TTY 上默认是全屏 TUI（--plain 保留旧的行式界面；管道输入、--json 和
TERM=dumb 不会启动它）。
  Enter 发送 · Alt+Enter 换行 · Tab 补全 / 命令
  Ctrl+P 会话选择器 · Ctrl+N 在 cwd 新建会话 · Ctrl+V 剪贴板图片
  Ctrl+L 清屏本地视图 · PgUp/PgDn 滚动 · F1 帮助 · Ctrl+Q 退出
  等待一轮进行时不能切换或新建：先按 Ctrl+C，它只停止本地等待，绝不
  声称远端会话已取消。`

/** The catalog `createTranslator` consumes: `{ key: { en, zh } }`. */
export const CLI_CATALOG = Object.fromEntries(
  Object.entries(ZH).map(([en, zh]) => [en, { en, zh }]),
)

// The help text is keyed semantically: its English source is far too long to be
// a key, so the entry above holds the English text and this one the Chinese.
CLI_CATALOG.usage = { en: ZH.usage, zh: USAGE_ZH }
