/**
 * dsh-tui-messages.mjs - the language catalog for the full-screen TUI.
 *
 * One flat `{ key: { zh, en } }` table, consumed by `createTranslator(lang,
 * TUI_CATALOG)` from `dsh-i18n.mjs`. This module is pure data: it never reads
 * `--lang`, the environment or a Session, so `dsh-tui.mjs` stays the only place
 * that decides *when* a string is shown.
 *
 * Scope: only text this tool owns - the composer hints, the slash-command and
 * shortcut tables, the status-row words, and the startup / draft / send /
 * attachment prompts. Host data (titles, cwd/paths, session ids, model names,
 * question and approval options), user messages and model output are never
 * catalogued: they are carried through `view` verbatim.
 *
 * Placeholders are `{name}`; `createTranslator` substitutes them in one pass,
 * so a value coming from the Host can never be re-scanned as a template.
 *
 * The zh column is the wording this CLI already shipped (the earlier core
 * tests and the `view.ui` contract both depend on it); the en column is the
 * translation of the same meaning, not a re-design.
 */

export const TUI_CATALOG = {
  // ------------------------------------------------------------- hints
  'hint.ready': {
    zh: 'Enter 发送 · / 命令 · ? 快捷键 · Esc 中断 · Ctrl+C 退出',
    en: 'Enter to send · / commands · ? shortcuts · Esc interrupt · Ctrl+C quit',
  },
  'hint.draft': {
    zh: '本地草稿 · 发送时创建会话 · / 命令 · ? 快捷键 · Ctrl+C 退出',
    en: 'Local draft · a session is created when you send · / commands · ? shortcuts · Ctrl+C quit',
  },
  'hint.busy': {
    zh: '等待本轮 · Esc 中断本地等待（远端不会取消） · Ctrl+C 先清空草稿',
    en: 'Waiting for this turn · Esc stops the local wait (the remote turn is not cancelled) · Ctrl+C clears the draft first',
  },
  'hint.pick': {
    zh: '↑↓ 选择 · Enter 恢复 · 输入过滤 · Esc 新建会话 · Ctrl+C 退出',
    en: '↑↓ select · Enter resume · type to filter · Esc new session · Ctrl+C quit',
  },
  'hint.help': {
    zh: '↑↓ 选择 · Esc / F1 / ? 关闭帮助',
    en: '↑↓ select · Esc / F1 / ? close help',
  },
  'hint.creating': {
    zh: '正在新建会话…',
    en: 'Creating a new session…',
  },
  'hint.commands': {
    zh: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
    en: '↑↓ select · Tab complete · Enter run · Esc close',
  },
  'hint.watch': {
    zh: '已提交 · 正在监看远端真实进度（没有重发原 prompt）',
    en: 'Submitted · watching real remote progress (the original prompt was not resent)',
  },
  'hint.initializing': {
    zh: '正在读取会话…',
    en: 'Loading sessions…',
  },
  'hint.submitting': {
    zh: '正在提交，请稍候（不会重复提交）',
    en: 'Submitting, please wait (nothing is submitted twice)',
  },
  'hint.exitShortcut': {
    zh: 'Ctrl+C 退出 · ? 快捷键',
    en: 'Ctrl+C quit · ? shortcuts',
  },

  // ------------------------------------------------------- status row
  'status.attention': {
    zh: '⚠待处理',
    en: '⚠ attention',
  },
  'status.turnsSteps': {
    zh: '{turns}轮/{steps}步',
    en: '{turns} turns/{steps} steps',
  },

  // ----------------------------------------------------------- help modal
  'help.title': {
    zh: '帮助 · 按键与命令',
    en: 'Help · Keys and commands',
  },

  // ------------------------------------------------- slash command table
  'cmd.resume': {
    zh: '恢复已有会话：打开会话列表（也 /sessions、/switch <id>）',
    en: 'Resume an existing session: open the session list (also /sessions, /switch <id>)',
  },
  'cmd.new': {
    zh: '新建当前目录会话',
    en: 'New session in the current directory',
  },
  'cmd.quit': {
    zh: '退出（也 /exit、Ctrl+Q）',
    en: 'Quit (also /exit, Ctrl+Q)',
  },
  'cmd.help': {
    zh: '命令与快捷键（也 F1、?）',
    en: 'Commands and shortcuts (also F1, ?)',
  },
  'cmd.status': {
    zh: '会话、cwd、队列、附件与上一轮状态',
    en: 'Session, cwd, queue, attachments and the last turn',
  },
  'cmd.permissions': {
    zh: '权限预设：显示当前值，选择后再明确确认才切换',
    en: 'Permission presets: show the current value; switching needs explicit confirmation',
  },
  'cmd.approvals': {
    zh: '待处理请求：查看审批/问题；只有 continued 问题可答',
    en: 'Pending requests: view approvals and questions; only continued questions can be answered',
  },
  'cmd.history': {
    zh: '重新拉取会话记录',
    en: 'Fetch the session transcript again',
  },
  'cmd.clear': {
    zh: '只清空当前界面的消息，会话不变（等同 Ctrl+L）',
    en: 'Clear only the on-screen messages; the session is unchanged (same as Ctrl+L)',
  },
  'cmd.attach': {
    zh: '附加图片：/attach <path> [path ...]',
    en: 'Attach images: /attach <path> [path ...]',
  },
  'cmd.paste': {
    zh: '读取剪贴板图片（等同 Ctrl+V）',
    en: 'Read an image from the clipboard (same as Ctrl+V)',
  },
  'cmd.attachments': {
    zh: '列出待发与已发送的附件',
    en: 'List pending and sent attachments',
  },
  'cmd.detach': {
    zh: '移除附件：/detach <n> | /detach all',
    en: 'Remove attachments: /detach <n> | /detach all',
  },
  'cmd.preview': {
    zh: '查看附件信息：/preview <n>',
    en: 'Show attachment info: /preview <n>',
  },
  'cmd.send': {
    zh: '只发送附件，不带文本',
    en: 'Send attachments only, without text',
  },
  'cmd.pending': {
    zh: '待处理队列：/edit <n> <text>、/drop <n>、/steer <n>',
    en: 'Pending queue: /edit <n> <text>, /drop <n>, /steer <n>',
  },
  'cmd.id': {
    zh: '显示完整 Session id',
    en: 'Show the full Session id',
  },

  // --------------------------------------------------- shortcut table
  'key.enter': {
    zh: '发送当前输入；在命令菜单里执行选中项，在会话列表里恢复选中项',
    en: 'Send the current input; run the selection in the command menu, resume the selection in the session list',
  },
  'key.slash': {
    zh: '在输入框行首打开就地命令菜单（最多 8 行，贴着输入框）',
    en: 'Open the inline command menu at the start of the input line (up to 8 rows, next to the composer)',
  },
  'key.question': {
    zh: '输入框为空时打开快捷键帮助',
    en: 'Open the shortcut help when the input is empty',
  },
  'key.tab': {
    zh: '命令菜单里补全选中项；普通输入里补全 / 开头的命令',
    en: 'Complete the selection in the command menu; complete a / command in normal input',
  },
  'key.arrows': {
    zh: '输入为空/光标在边界时召回输入历史；菜单里选择；多行里移动光标',
    en: 'Recall input history when the input is empty or the cursor is at an edge; select in menus; move the cursor across lines',
  },
  'key.altEnter': {
    zh: '在草稿里插入换行（Enter 始终提交整段草稿）',
    en: 'Insert a newline in the draft (Enter always submits the whole draft)',
  },
  'key.move': {
    zh: '在草稿里移动光标，中文按字移动',
    en: 'Move the cursor in the draft; CJK text moves by character',
  },
  'key.backspace': {
    zh: '删除光标前 / 后的一个字符',
    en: 'Delete one character before / after the cursor',
  },
  'key.killLine': {
    zh: '删除光标前 / 后的整行内容',
    en: 'Delete the whole line before / after the cursor',
  },
  'key.escape': {
    zh: '等待本轮时中断本地等待（远端不会取消）；关闭菜单/弹窗；回到最新消息',
    en: 'Interrupt the local wait while waiting for this turn (the remote turn is not cancelled); close menus/modals; jump to the newest message',
  },
  'key.ctrlC': {
    zh: '清空草稿；草稿为空时中断等待或退出（不会声称远端已取消）',
    en: 'Clear the draft; when it is empty, interrupt the wait or quit (never claims the remote turn was cancelled)',
  },
  'key.ctrlV': {
    zh: '明确读取剪贴板图片作为附件',
    en: 'Explicitly read an image from the clipboard as an attachment',
  },
  'key.ctrlL': {
    zh: '只清空当前界面的消息，会话不变',
    en: 'Clear only the on-screen messages; the session is unchanged',
  },
  'key.page': {
    zh: '翻页滚动消息（一屏）；鼠标滚轮逐行滚动；Esc 回到最新',
    en: 'Scroll messages by one page; the mouse wheel scrolls line by line; Esc jumps to the newest',
  },
  'key.ctrlPN': {
    zh: '兼容旧习惯：会话列表 / 新建当前目录会话（菜单打开时改为移动选中项）',
    en: 'Legacy habits: session list / new session in the current directory (move the selection while a menu is open)',
  },
  'key.f1': {
    zh: '显示 / 关闭帮助（与 ? 相同）',
    en: 'Show / hide help (same as ?)',
  },
  'key.f2': {
    zh: '待处理请求入口（/approvals）：审批说明与 continued 问题回答；不动草稿',
    en: 'Pending-request entry (/approvals): approval details and continued-question answers; the draft is untouched',
  },
  'key.f3': {
    zh: '权限预设（/permissions）：显示当前值，选择后需显式确认',
    en: 'Permission presets (/permissions): show the current value; switching needs explicit confirmation',
  },
  'key.ctrlQ': {
    zh: '退出；等待本轮时先按 Esc 或 Ctrl+C 停止本地等待',
    en: 'Quit; while waiting for this turn press Esc or Ctrl+C to stop the local wait first',
  },

  // ------------------------------------------------------- attachment area
  'attach.unsupported': {
    zh: '当前 Host 不支持图片附件 · 它的 DSH Ask 终端比本 CLI 旧。更新 DeepSeek Harness（或 local-cli 插件）后重试；纯文本对话仍可用。',
    en: 'This Host does not advertise image attachments · its DSH Ask Terminal is older than this CLI. Update DeepSeek Harness (or the local-cli plugin) and retry; plain-text chat still works.',
  },
  'attach.addFailed': {
    zh: '无法附加 · {message}',
    en: 'Cannot attach · {message}',
  },
  'attach.usage': {
    zh: '用法：/attach <path> [path ...]',
    en: 'Usage: /attach <path> [path ...]',
  },
  'attach.added': {
    zh: '已附加 {image}',
    en: 'Attached {image}',
  },
  'attach.clipboardReading': {
    zh: '正在读取剪贴板…',
    en: 'Reading the clipboard…',
  },
  'attach.clipboardAdded': {
    zh: '已从剪贴板附加 {image}',
    en: 'Attached from the clipboard: {image}',
  },
  'attach.clipboardFailed': {
    zh: '无法读取剪贴板 · {message}',
    en: 'Cannot read the clipboard · {message}',
  },
  'attach.detachUsage': {
    zh: '用法：/detach <n> | /detach all',
    en: 'Usage: /detach <n> | /detach all',
  },
  'attach.detachAll': {
    zh: '已移除 {count} 个附件',
    en: 'Removed {count} attachment(s)',
  },
  'attach.detached': {
    zh: '已移除 {name}',
    en: 'Removed {name}',
  },
  'attach.missing': {
    zh: '没有第 {index} 个附件',
    en: 'There is no attachment #{index}',
  },
  'attach.listHeader': {
    zh: '附件 · {pending} 待发 · {sent} 已发送/未确认',
    en: 'Attachments · {pending} pending · {sent} sent/unconfirmed',
  },
  'attach.listEmpty': {
    zh: '（没有附件）· /attach <path>、/paste 或 Ctrl+V 添加',
    en: '(no attachments) · add one with /attach <path>, /paste or Ctrl+V',
  },
  'attach.listSentHeader': {
    zh: '已发送 / 未确认（不会自动重发）：',
    en: 'sent / unconfirmed (never resent automatically):',
  },
  'attach.listSentLine': {
    zh: '{image} · {reason} {time} · session {session}',
    en: '{image} · {reason} {time} · session {session}',
  },
  'attach.noPending': {
    zh: '没有待发附件',
    en: 'No pending attachments',
  },
  'attach.noAttachment': {
    zh: '没有附件 · /attach <path>、/paste 或 Ctrl+V 添加',
    en: 'No attachments · add one with /attach <path>, /paste or Ctrl+V',
  },
  'attach.previewUsage': {
    zh: '用法：/preview <n>',
    en: 'Usage: /preview <n>',
  },
  'attach.previewInfo': {
    zh: '附件 {index} · {image} · 全屏 TUI 不渲染图片；如需在终端预览，退出后用 dsh-ask --plain（/preview）',
    en: 'Attachment {index} · {image} · the full-screen TUI does not render images; to preview in the terminal, quit and use dsh-ask --plain (/preview)',
  },
  'attach.onlyAttachments': {
    zh: '（仅附件：{names}）',
    en: '(attachments only: {names})',
  },
  'attach.nameSeparator': {
    zh: '、',
    en: ', ',
  },
  'attach.unconfirmedBatch': {
    zh: '{count} 个附件已标记为未确认，不会被再次自动发送',
    en: '{count} attachment(s) marked unconfirmed and never sent automatically again',
  },

  // --------------------------------------- startup / draft / send prompts
  'session.creating': {
    zh: '正在创建会话…',
    en: 'Creating the session…',
  },
  'session.created': {
    zh: '已创建会话 {id} · {cwd}',
    en: 'Session created {id} · {cwd}',
  },
  'session.draftNotCreated': {
    zh: '尚未创建会话（本地草稿）· 首次发送时创建',
    en: 'No session yet (local draft) · it is created on the first send',
  },
  'session.createUnknownPrevious': {
    zh: '上一次创建会话的结果未知 · 不会自动重复创建；草稿保留，请重新启动或用会话选择器显式新建',
    en: 'The previous session creation result is unknown · it will not be retried automatically; the draft is kept, restart or create a session explicitly from the session picker',
  },
  'session.createUnknown': {
    zh: '创建会话结果未知 · {message} · 草稿保留；不会自动重复创建，请重新启动或用会话选择器显式新建',
    en: 'Session creation result unknown · {message} · the draft is kept; it will not be retried automatically, restart or create a session explicitly from the session picker',
  },
  'session.createFailed': {
    zh: '创建会话失败 · {message} · 草稿保留，未发送',
    en: 'Session creation failed · {message} · the draft is kept and nothing was sent',
  },
  'send.noContent': {
    zh: '没有可发送的内容',
    en: 'Nothing to send',
  },
  'send.noSession': {
    zh: '尚未创建会话 · 没有发送',
    en: 'No session yet · nothing was sent',
  },
  'send.imageModelUnsupported': {
    zh: '当前模型不支持图片：请在桌面应用里换成支持图片的模型，再显式 /send；CLI 不会替你切换模型',
    en: 'The current model cannot see images: switch to a vision-capable model in the desktop app and run /send explicitly; the CLI never switches models for you',
  },
  'send.attachmentSent': {
    zh: '{count} 个附件已随本轮发送（session {session}）',
    en: '{count} attachment(s) sent with this turn (session {session})',
  },
  'send.turnDone': {
    zh: '完成 · {duration} · {tools} 次工具调用 · session {session}',
    en: 'Done · {duration} · {tools} tool calls · session {session}',
  },
  'send.attachmentKept': {
    zh: '附件保留在本地：Host 明确没有受理这条消息，没有排队',
    en: 'Attachments kept locally: the Host explicitly did not accept this message, so nothing was queued',
  },
  'send.attachmentAccepted': {
    zh: '附件已被受理，不会自动重发',
    en: 'Attachments were accepted and are never resent automatically',
  },
  'send.attachmentUnconfirmed': {
    zh: '附件已标记为未确认 · 先 /history 核对，可能已经排队',
    en: 'Attachments marked unconfirmed · check /history first, they may already be queued',
  },
  'draft.cleared': {
    zh: '已清空草稿 · Ctrl+C 再按一次退出',
    en: 'Draft cleared · press Ctrl+C again to quit',
  },
  'draft.keptOnEsc': {
    zh: 'Esc 不删除输入 · Ctrl+C 清空草稿',
    en: 'Esc does not delete the input · Ctrl+C clears the draft',
  },

  // ------------------------------------------------- modal / system text (I4)
  'picker.newSession': {
    zh: '新建当前目录会话',
    en: 'New session in the current directory',
  },
  'approval.a-claim-covers-only-the-current-session-and': {
    zh: '接入仅针对当前会话，需要你显式确认；不会自动接入，也不会全局捕获其他会话。',
    en: 'A claim covers only the current session and needs your explicit confirmation; it never claims automatically or captures other sessions.',
  },
  'approval.a-decision-applies-to-this-request-only': {
    zh: '决策只对本次请求有效：允许一次=allowed-once；拒绝=rejected；不支持 always / 记住规则。',
    en: 'A decision applies to this request only: allow once=allowed-once; reject=rejected; always / remember rules are not supported.',
  },
  'approval.a-terminal-approval-claim-already-exists': {
    zh: '已有终端审批接入；先释放后再接第二个会话',
    en: 'A terminal approval claim already exists; release it before claiming a second session',
  },
  'approval.a-terminal-approval-claim-is-already-active': {
    zh: '已有活动的终端审批接入（可能来自另一个终端/CLI）· 不会自动抢占；先释放或等租约到期',
    en: 'A terminal approval claim is already active (possibly from another terminal/CLI) · it is never taken over automatically; release it or wait for the lease to expire',
  },
  'approval.about-to-submit': {
    zh: '即将提交：{p1}',
    en: 'About to submit: {p1}',
  },
  'approval.after-release-the-terminal-stops-receiving': {
    zh: '释放后，终端不再接收该会话的新审批；后续审批回到桌面处理。',
    en: 'After release the terminal stops receiving new approvals for this session; later approvals return to the desktop.',
  },
  'approval.allow-once': {
    zh: '允许一次…',
    en: 'Allow once…',
  },
  'approval.allow-once-applies-to-this-request-only-and': {
    zh: '允许一次只对本次请求生效，不会扩大为 always / 会话允许；工具若再次请求会重新询问。',
    en: 'Allow once applies to this request only and never grows into always / session-wide allow; if the tool asks again the question returns.',
  },
  'approval.allow-once-submitted-waiting-for-host': {
    zh: '已提交允许一次 · 等待 Host 确认',
    en: 'Allow once submitted · waiting for Host confirmation',
  },
  'approval.allowed-once-this-request-only': {
    zh: 'allowed-once，仅本次请求',
    en: 'allowed-once, this request only',
  },
  'approval.approval': {
    zh: '审批 · {p1}',
    en: 'Approval · {p1}',
  },
  'approval.approval-decision-submitted-request-waiting': {
    zh: '已提交审批决定：{p1}（request {p2}）· 等待 Host 确认（本地已接受，Host 结果不在此观察；不会扩大为 always）',
    en: 'Approval decision submitted: {p1} (request {p2}) · waiting for Host confirmation (accepted locally; the Host result is not observed here and it never grows into always)',
  },
  'approval.approval-submit-result-unknown-refresh-the': {
    zh: '审批提交结果未知 · {p1} · 先刷新终端审批通道核对，不要连续重试',
    en: 'Approval submit result unknown · {p1} · refresh the terminal approval channel to check first; do not retry repeatedly',
  },
  'approval.approvals-are-pending-this-host-version-has': {
    zh: '⚠ 有待审批事项：本版本 Host 没有 CLI 读取/答复审批的 API。请到桌面应用确认；这里不会替你允许或拒绝。',
    en: '⚠ approvals are pending: this Host version has no CLI API to read or answer approvals. Confirm in the desktop app; nothing is allowed or rejected for you here.',
  },
  'approval.approvals-are-waiting-on-the-desktop-other': {
    zh: '⚠ 桌面端/其它通道有审批等待：审批由桌面端或已接入的终端通道处理；这里不会替你允许或拒绝。',
    en: '⚠ approvals are waiting on the desktop/other channels: they are handled by the desktop or a claimed terminal channel; nothing is allowed or rejected for you here.',
  },
  'approval.cancel-do-not-claim': {
    zh: '取消（不接入）',
    en: 'Cancel (do not claim)',
  },
  'approval.cancel-keep-the-claim': {
    zh: '取消（保持接入）',
    en: 'Cancel (keep the claim)',
  },
  'approval.cancel-submit-nothing': {
    zh: '取消（不提交）',
    en: 'Cancel (submit nothing)',
  },
  'approval.cannot-read-the-terminal-approval-channel': {
    zh: '无法读取终端审批通道 · {p1}',
    en: 'Cannot read the terminal approval channel · {p1}',
  },
  'approval.channel-error': {
    zh: '通道错误：{p1}',
    en: 'Channel error: {p1}',
  },
  'approval.checking-and-submitting-the-approval': {
    zh: '正在核对并提交审批决定…（不会重复提交）',
    en: 'Checking and submitting the approval decision… (nothing is submitted twice)',
  },
  'approval.claim-failed': {
    zh: '接入失败（{p1}）· {p2}',
    en: 'Claim failed ({p1}) · {p2}',
  },
  'approval.claim-result-unknown-refresh-the-approval': {
    zh: '接入结果未知 · 先刷新审批通道核对，不要自动重复接入',
    en: 'Claim result unknown · refresh the approval channel to check first; never claim twice automatically',
  },
  'approval.claim-terminal-approval': {
    zh: '接入终端审批？',
    en: 'Claim terminal approval?',
  },
  'approval.claim-terminal-approval-for-the-current': {
    zh: '将为当前会话 {p1} 接入终端审批。',
    en: 'Claim terminal approval for the current session {p1}.',
  },
  'approval.claim-terminal-approval-for-the-current-2': {
    zh: '接入当前会话终端审批…',
    en: 'Claim terminal approval for the current session…',
  },
  'approval.claiming-allows-or-rejects-nothing-by': {
    zh: '接入本身不会允许/拒绝任何请求；每个决定都需要再确认一次，默认取消。',
    en: 'Claiming allows or rejects nothing by itself; every decision needs one more confirmation and defaults to cancel.',
  },
  'approval.claiming-allows-rejects-nothing': {
    zh: '接入不会自动允许/拒绝；会显示当前会话仍待处理的请求（含接入前已挂起），不会自动答复；已处理/取消的请求不能再答。',
    en: 'Claiming allows/rejects nothing automatically; it lists the requests this session still has pending (including ones suspended before the claim), answers nothing automatically, and handled/cancelled requests can no longer be answered.',
  },
  'approval.claiming-terminal-approval': {
    zh: '正在接入终端审批…',
    en: 'Claiming terminal approval…',
  },
  'approval.close-esc-submit-nothing': {
    zh: '关闭（Esc，不提交）',
    en: 'Close (Esc, submit nothing)',
  },
  'approval.confirm-allow-once': {
    zh: '确认允许一次？',
    en: 'Confirm allow once?',
  },
  'approval.confirm-reject': {
    zh: '确认拒绝？',
    en: 'Confirm reject?',
  },
  'approval.confirm-release-back-to-the-desktop': {
    zh: '确认释放回桌面',
    en: 'Confirm release back to the desktop',
  },
  'approval.confirm-submit-allow-once': {
    zh: '确认提交允许一次',
    en: 'Confirm submit allow once',
  },
  'approval.confirm-submit-reject': {
    zh: '确认提交拒绝',
    en: 'Confirm submit reject',
  },
  'approval.confirm-terminal-approval-claim': {
    zh: '确认接入终端审批',
    en: 'Confirm terminal approval claim',
  },
  'approval.display-reason': {
    zh: '展示原因：{p1}',
    en: 'Display reason: {p1}',
  },
  'approval.enter-confirms-the-claim-esc-cancels-never': {
    zh: 'Enter 确认接入 · Esc 取消（不会自动接入）',
    en: 'Enter confirms the claim · Esc cancels (never claimed automatically)',
  },
  'approval.enter-confirms-the-release-esc-cancels': {
    zh: 'Enter 确认释放 · Esc 取消',
    en: 'Enter confirms the release · Esc cancels',
  },
  'approval.enter-confirms-the-submission-esc-cancels': {
    zh: 'Enter 确认提交 · Esc 取消（不会默认允许/拒绝）',
    en: 'Enter confirms the submission · Esc cancels (never allowed/rejected by default)',
  },
  'approval.esc-close': {
    zh: 'Esc 关闭',
    en: 'Esc close',
  },
  'approval.failed-to-release-the-terminal-approval': {
    zh: '释放终端审批失败（{p1}）· {p2}；可重试或等租约到期',
    en: 'Failed to release the terminal approval claim ({p1}) · {p2}; retry or wait for the lease to expire',
  },
  'approval.host-note': {
    zh: 'Host 说明：{p1}',
    en: 'Host note: {p1}',
  },
  'approval.if-the-desktop-shows-the-same-request': {
    zh: '桌面端如果同时显示该请求，先显式答复者生效；另一方会收到取消。',
    en: 'If the desktop shows the same request, whichever side answers explicitly first wins; the other receives a cancellation.',
  },
  'approval.needs-a-second-confirmation-release-it-back': {
    zh: '需要二次确认；可随时释放回桌面',
    en: 'Needs a second confirmation; release it back to the desktop at any time',
  },
  'approval.no-pending-approvals-or-questions': {
    zh: '（没有待处理的审批或问题）',
    en: '(no pending approvals or questions)',
  },
  'approval.no-session-yet-it-is-created-on-the-first': {
    zh: '尚未创建会话 · 发送第一条文字/附件后才会创建，之后才能查看审批/问题（不会隐式创建）',
    en: 'No session yet · it is created on the first text/attachment send, and only then can approvals/questions be viewed (never implicitly created)',
  },
  'approval.no-terminal-approval-requests-are-waiting': {
    zh: '（当前没有待答复的终端审批请求）',
    en: '(no terminal approval requests are waiting)',
  },
  'approval.nothing-is-claimed-until-you-explicitly': {
    zh: '需要你在这里显式确认后才接入；不会自动接入，也不会全局捕获其他会话。',
    en: 'Nothing is claimed until you explicitly confirm here; it never claims automatically or captures other sessions.',
  },
  'approval.open-question-s-are-blocking-tool-calls-and': {
    zh: '⚠ {p1} 个 open 问题正阻塞工具调用，只能由桌面端实时事件流回答；本 CLI 不会替你作答。',
    en: '⚠ {p1} open question(s) are blocking tool calls and can only be answered by the desktop live event stream; this CLI will not answer for you.',
  },
  'approval.other-pending-input-informational-only': {
    zh: '其他待处理输入（仅提示）',
    en: 'Other pending input (informational only)',
  },
  'approval.pending-requests-loading': {
    zh: '待处理请求 · 读取中',
    en: 'Pending requests · loading',
  },
  'approval.question-s-call': {
    zh: '{p1} 问 · call {p2} · {p3}{p4}',
    en: '{p1} question(s) · call {p2} · {p3}{p4}',
  },
  'approval.re-read-pending-requests': {
    zh: '重新读取待处理请求',
    en: 'Re-read pending requests',
  },
  'approval.reading-pending-approvals-questions': {
    zh: '正在读取待处理审批/问题…',
    en: 'Reading pending approvals/questions…',
  },
  'approval.reason': {
    zh: '原因：{p1}',
    en: 'Reason: {p1}',
  },
  'approval.refresh-the-terminal-approval-channel': {
    zh: '刷新终端审批通道',
    en: 'Refresh the terminal approval channel',
  },
  'approval.reject': {
    zh: '拒绝…',
    en: 'Reject…',
  },
  'approval.reject-applies-to-this-request-only-it': {
    zh: '拒绝只对本次请求生效；不会改写 Host 的取消/不可用结果。',
    en: 'Reject applies to this request only; it never rewrites the Host cancel/unavailable result.',
  },
  'approval.reject-submitted-waiting-for-host': {
    zh: '已提交拒绝 · 等待 Host 确认',
    en: 'Reject submitted · waiting for Host confirmation',
  },
  'approval.rejected-this-request-only': {
    zh: 'rejected，仅本次请求',
    en: 'rejected, this request only',
  },
  'approval.release-back-to-the-desktop': {
    zh: '释放回桌面…',
    en: 'Release back to the desktop…',
  },
  'approval.release-it-back-to-the-desktop-at-any-time': {
    zh: '可随时释放回桌面；切换会话/退出会释放（租约到期也会自动失效）。',
    en: 'Release it back to the desktop at any time; switching sessions/quitting releases it (and an expired lease stops it too).',
  },
  'approval.release-terminal-approval': {
    zh: '释放终端审批？',
    en: 'Release terminal approval?',
  },
  'approval.release-the-current-terminal-claim': {
    zh: '释放当前终端接入…',
    en: 'Release the current terminal claim…',
  },
  'approval.release-the-terminal-approval-claim-claim': {
    zh: '将释放终端审批接入（claim {p1}）。',
    en: 'Release the terminal approval claim (claim {p1}).',
  },
  'approval.releasing-submits-no-decision': {
    zh: '释放不会提交任何决定。',
    en: 'Releasing submits no decision.',
  },
  'approval.releasing-terminal-approval': {
    zh: '正在释放终端审批…',
    en: 'Releasing terminal approval…',
  },
  'approval.requested-at': {
    zh: '请求时间：{p1}',
    en: 'Requested at: {p1}',
  },
  'approval.running-pendinginput': {
    zh: '运行：{p1} · pendingInput：{p2}',
    en: 'Running: {p1} · pendingInput: {p2}',
  },
  'approval.scope-the-host-approval-request-only': {
    zh: '范围：Host 审批请求只提供工具名与原因/展示原因；协议不提供参数、路径或命令正文，这里不猜测。',
    en: 'Scope: the Host approval request only provides the tool name and the reason/display reason; the protocol carries no arguments, paths or command text, so nothing is guessed here.',
  },
  'approval.scroll-enter-choose-an-action-esc-close': {
    zh: '↑↓ 滚动 · Enter 选择动作 · Esc 关闭（默认不提交）',
    en: '↑↓ scroll · Enter choose an action · Esc close (nothing is submitted by default)',
  },
  'approval.select-enter-view-answer-esc-close': {
    zh: '↑↓ 选择 · Enter 查看/回答 · Esc 关闭',
    en: '↑↓ select · Enter view/answer · Esc close',
  },
  'approval.select-enter-view-reply-esc-close': {
    zh: '↑↓ 选择 · Enter 查看/答复 · Esc 关闭',
    en: '↑↓ select · Enter view/reply · Esc close',
  },
  'approval.session-connection-lease-remaining-lease-ms': {
    zh: '会话 {p1} · 连接：{p2} · 租约剩余 {p3}（lease {p4}ms）',
    en: 'Session {p1} · connection: {p2} · lease remaining {p3} (lease {p4}ms)',
  },
  'approval.session-switched-the-terminal-approval': {
    zh: '会话切换 · 已释放终端审批接入，审批回到桌面（未答复请求不会被自动允许）',
    en: 'Session switched · the terminal approval claim was released and approvals return to the desktop (unanswered requests are never allowed automatically)',
  },
  'approval.shows-the-requests-this-session-still-has': {
    zh: '显示当前会话仍待处理的请求（含接入前已挂起）；不会自动答复；已处理/取消的请求不能再答。',
    en: 'Shows the requests this session still has pending (including ones suspended before the claim); nothing is answered automatically and handled/cancelled requests can no longer be answered.',
  },
  'approval.submit-failed-choose-again': {
    zh: '提交失败：请重新选择',
    en: 'Submit failed: choose again',
  },
  'approval.submitting-only-means-the-terminal-accepted': {
    zh: '提交只表示终端本地已接受；Host 最终结果不在这里观察。',
    en: 'Submitting only means the terminal accepted it locally; the final Host result is not observed here.',
  },
  'approval.submitting-only-means-the-terminal-accepted-2': {
    zh: '提交只表示终端本地已接受；Host 最终结果不在这里观察。桌面端若先答复，本次会失败/取消。',
    en: 'Submitting only means the terminal accepted it locally; the final Host result is not observed here. If the desktop answers first, this submission fails/is cancelled.',
  },
  'approval.submitting-please-wait-before-opening': {
    zh: '正在提交，请稍候再打开待处理请求',
    en: 'Submitting, please wait before opening pending requests',
  },
  'approval.terminal-approval': {
    zh: '终端审批 · {p1}',
    en: 'Terminal approval · {p1}',
  },
  'approval.terminal-approval-channel-claimed-claim': {
    zh: '终端审批通道：已接入（claim {p1}）。',
    en: 'Terminal approval channel: claimed (claim {p1}).',
  },
  'approval.terminal-approval-channel-not-claimed': {
    zh: '终端审批通道：未接入（审批目前由桌面端处理）。',
    en: 'Terminal approval channel: not claimed (approvals are handled on the desktop for now).',
  },
  'approval.terminal-approval-claim-released': {
    zh: '已释放终端审批接入{p1}',
    en: 'Terminal approval claim released{p1}',
  },
  'approval.terminal-approval-claimed-claim-the-desktop': {
    zh: '已接入终端审批（claim {p1}）· 桌面端仍可答复，先显式答复者生效；会显示当前会话仍待处理的请求（含接入前已挂起），不会自动答复',
    en: 'Terminal approval claimed (claim {p1}) · the desktop can still answer; whoever answers explicitly first wins; pending requests of this session (including ones suspended before the claim) are listed and nothing is answered automatically',
  },
  'approval.terminal-approval-claimed-desktop-terminal': {
    zh: '已接入终端审批 · 桌面/终端先答复者生效（不会自动允许/拒绝）',
    en: 'Terminal approval claimed · desktop/terminal, whoever answers first wins (nothing is allowed or rejected automatically)',
  },
  'approval.terminal-approval-is-already-claimed-by': {
    zh: '终端审批已接入其他会话{p1}。',
    en: 'Terminal approval is already claimed by another session{p1}.',
  },
  'approval.terminal-approval-requests-handle-with': {
    zh: '🔐 有终端审批请求 · /approvals 处理（不会自动允许/拒绝）',
    en: '🔐 terminal approval requests · handle with /approvals (nothing is allowed or rejected automatically)',
  },
  'approval.terminal-approval-requests-were-handled-on': {
    zh: '终端审批请求已被桌面/其他终端处理、取消或过期（{p1} 个）· 不重试旧答案',
    en: 'Terminal approval requests were handled on the desktop/another terminal, cancelled or expired ({p1}) · stale answers are not retried',
  },
  'approval.the-approval-decision-did-not-pass': {
    zh: '审批决定未通过校验 · {p1} · 没有提交',
    en: 'The approval decision did not pass validation · {p1} · nothing was submitted',
  },
  'approval.the-claim-ended-while-it-was-being': {
    zh: '接入在建立过程中结束（过期/释放）· 请重新接入',
    en: 'The claim ended while it was being established (expired/released) · claim again',
  },
  'approval.the-desktop-can-still-answer-at-the-same': {
    zh: '桌面端仍可同时答复；先显式答复者生效，另一方会收到取消。',
    en: 'The desktop can still answer at the same time; whoever answers explicitly first wins and the other receives a cancellation.',
  },
  'approval.the-desktop-still-sees-the-approval': {
    zh: '桌面端仍可同时看到审批请求；桌面或终端谁先显式答复谁生效，另一方会收到取消。',
    en: 'The desktop still sees the approval requests; whichever side answers explicitly first wins and the other receives a cancellation.',
  },
  'approval.the-desktop-still-sees-the-requests-desktop': {
    zh: '桌面端仍可同时看到请求；桌面/终端谁先显式答复谁生效，另一方会收到取消。',
    en: 'The desktop still sees the requests; desktop/terminal, whichever answers explicitly first wins and the other receives a cancellation.',
  },
  'approval.the-host-bridge-has-no-usable-terminal': {
    zh: 'Host bridge 没有可用的终端审批通道（需要更新 Host / local-cli）',
    en: 'The Host bridge has no usable terminal approval channel (update the Host / local-cli)',
  },
  'approval.the-host-has-no-usable-terminal-approval': {
    zh: 'Host 没有可用的终端审批通道 · {p1} · 没有提交',
    en: 'The Host has no usable terminal approval channel · {p1} · nothing was submitted',
  },
  'approval.the-host-returned-no-pending-state-older': {
    zh: 'Host 没有返回待处理状态（旧版本或缺 projection）。',
    en: 'The Host returned no pending state (older version or missing projection).',
  },
  'approval.the-request-was-handled-on-the-desktop': {
    zh: '请求已被桌面/其他终端处理、取消或过期 · 没有提交，也不会重试旧答案',
    en: 'The request was handled on the desktop/another terminal, cancelled or expired · nothing was submitted and stale answers are not retried',
  },
  'approval.the-request-was-handled-on-the-desktop-2': {
    zh: '请求已被桌面/其他终端处理、取消或过期 · 没有提交',
    en: 'The request was handled on the desktop/another terminal, cancelled or expired · nothing was submitted',
  },
  'approval.the-session-changed-no-approval-was': {
    zh: '会话已切换 · 审批没有提交；请切回原会话后重新打开 /approvals',
    en: 'The session changed · no approval was submitted; switch back and reopen /approvals',
  },
  'approval.the-session-changed-no-terminal-approval': {
    zh: '会话已切换 · 终端审批接入没有提交；请切回原会话后重新打开 /approvals',
    en: 'The session changed · no terminal approval claim was submitted; switch back and reopen /approvals',
  },
  'approval.the-session-has-no-live-agent-open-it-on': {
    zh: '会话没有 live Agent · 先在桌面打开它或发送一条消息，再接入',
    en: 'The session has no live Agent · open it on the desktop or send a message first, then claim',
  },
  'approval.the-terminal-approval-claim-ended-expired': {
    zh: '终端审批接入已结束/过期（可能已被释放）· 审批回到桌面；需要时重新接入',
    en: 'The terminal approval claim ended/expired (it may have been released) · approvals return to the desktop; claim again if needed',
  },
  'approval.the-terminal-approval-claim-is-no-longer': {
    zh: '终端审批接入已失效（{p1}）· 审批回到桌面；未提交任何决定，需要时重新接入',
    en: 'The terminal approval claim is no longer valid ({p1}) · approvals return to the desktop; no decision was submitted, claim again if needed',
  },
  'approval.the-terminal-approval-claim-is-no-longer-2': {
    zh: '终端审批接入已失效（{p1}）· 审批回到桌面',
    en: 'The terminal approval claim is no longer valid ({p1}) · approvals return to the desktop',
  },
  'approval.the-terminal-approval-claim-is-no-longer-3': {
    zh: '终端审批接入已失效 · 没有提交；请重新打开 /approvals',
    en: 'The terminal approval claim is no longer valid · nothing was submitted; reopen /approvals',
  },
  'approval.the-terminal-approval-claim-is-no-longer-4': {
    zh: '终端审批接入已失效/过期 · 没有提交；审批回到桌面，需要时重新接入',
    en: 'The terminal approval claim is no longer valid/expired · nothing was submitted; approvals return to the desktop, claim again if needed',
  },
  'approval.the-terminal-approval-claim-scope-changed': {
    zh: '终端审批接入作用域已变化（claim/session 不匹配）· 审批回到桌面；未提交任何决定',
    en: 'The terminal approval claim scope changed (claim/session mismatch) · approvals return to the desktop; no decision was submitted',
  },
  'approval.the-terminal-received-approval-requests': {
    zh: '🔐 终端收到审批请求：{p1} · /approvals 处理；不会自动答复',
    en: '🔐 the terminal received approval requests: {p1} · handle with /approvals; nothing is answered automatically',
  },
  'approval.this-cli-does-not-handle-this-kind-of-input': {
    zh: '本 CLI 不处理这类输入，请到桌面端查看',
    en: 'This CLI does not handle this kind of input; check on the desktop',
  },
  'approval.this-cli-holds-only-one-terminal-claim-at-a': {
    zh: '本 CLI 同时只保持一个终端接入；不会在这里接管第二个会话，也不会自动抢走。',
    en: 'This CLI holds only one terminal claim at a time; it never takes over a second session here or grabs it automatically.',
  },
  'approval.this-cli-host-cannot-read-pending-requests': {
    zh: '当前 CLI/Host 不支持读取待处理请求（需要新版 dsh-ask 与 Host bridge 的 /local-cli/awaiting）。',
    en: 'This CLI/Host cannot read pending requests (needs a newer dsh-ask and the Host bridge /local-cli/awaiting).',
  },
  'approval.this-cli-host-does-not-support-the-terminal': {
    zh: '当前 CLI/Host 不支持终端审批通道（能力探测失败）；审批只能在桌面端处理。',
    en: 'This CLI/Host does not support the terminal approval channel (capability probe failed); approvals can only be handled on the desktop.',
  },
  'approval.this-lists-the-requests-this-session-still': {
    zh: '这里显示当前会话仍待处理的请求（含接入前已挂起）；不会自动答复；已处理/取消的请求不能再答。',
    en: 'This lists the requests this session still has pending (including ones suspended before the claim); nothing is answered automatically and handled/cancelled requests can no longer be answered.',
  },
  'approval.this-terminal-approval-request-was-handled': {
    zh: '该终端审批请求已被桌面/其他终端处理、取消或过期 · 已关闭旧页面，不会提交旧答案',
    en: 'This terminal approval request was handled on the desktop/another terminal, cancelled or expired · the old page is closed and no stale answer is submitted',
  },
  'approval.tip-lists-the-requests-this-session-still': {
    zh: '提示：会显示当前会话仍待处理的请求（含接入前已挂起）；不会自动答复，已处理/取消的请求不能再答；任一先显式答复者生效。',
    en: 'Tip: lists the requests this session still has pending (including ones suspended before the claim); nothing is answered automatically, handled/cancelled requests can no longer be answered, and whichever explicit answer comes first wins.',
  },
  'approval.tool': {
    zh: '工具：{p1}',
    en: 'Tool: {p1}',
  },
  'approval.unanswered-requests-are-handed-back-to-the': {
    zh: '当前未答复的请求会交回后续 answerer/桌面，不会被自动允许，也不会被自动拒绝。',
    en: 'Unanswered requests are handed back to the next answerer/desktop; they are never allowed or rejected automatically.',
  },
  'approval.unanswered-requests-are-never-allowed': {
    zh: '未答复请求不会被自动允许',
    en: 'Unanswered requests are never allowed automatically',
  },
  'approval.unsupported-approval-outcome-nothing-was': {
    zh: '不支持的审批结果 · 没有提交',
    en: 'Unsupported approval outcome · nothing was submitted',
  },
  'approval.view-enter-act-esc-close-a-terminal-claim': {
    zh: '↑↓ 查看 · Enter 操作 · Esc 关闭（已有终端接入）',
    en: '↑↓ view · Enter act · Esc close (a terminal claim is active)',
  },
  'approval.view-enter-claim-answer-esc-close': {
    zh: '↑↓ 查看 · Enter 接入/回答 · Esc 关闭',
    en: '↑↓ view · Enter claim/answer · Esc close',
  },
  'approval.view-esc-close-handle-approvals-open': {
    zh: '↑↓ 查看 · Esc 关闭（审批/open 问题请在桌面处理）',
    en: '↑↓ view · Esc close (handle approvals/open questions on the desktop)',
  },
  'approval.waiting-max': {
    zh: '待答复：{p1} 个（上限 {p2}）',
    en: 'Waiting: {p1} (max {p2})',
  },
  'attention.approval-needs-desktop-confirmation-view': {
    zh: '⚠ 审批需桌面端确认 · F2 或 /approvals 查看',
    en: '⚠ approval needs desktop confirmation · view with F2 or /approvals',
  },
  'attention.cannot-read-pending-requests': {
    zh: '无法读取待处理请求 · {p1}',
    en: 'Cannot read pending requests · {p1}',
  },
  'attention.pending-question-view-with-f2-or-approvals': {
    zh: '⚠ 待处理问题 · F2 或 /approvals 查看',
    en: '⚠ pending question · view with F2 or /approvals',
  },
  'attention.pending-requests-cleared-or-already-handled': {
    zh: '待处理请求已清空（或已在桌面端处理）',
    en: 'Pending requests cleared (or already handled on the desktop)',
  },
  'attention.pending-requests-detected-press-f2-or': {
    zh: '⚠ 检测到待处理请求 · 按 F2（或 /approvals）查看（不会自动允许/回答）',
    en: '⚠ pending requests detected · press F2 (or /approvals) to view (nothing is allowed or answered automatically)',
  },
  'attention.pending-requests-view-with-f2-or-approvals': {
    zh: '⚠ 有待处理请求 · F2 或 /approvals 查看',
    en: '⚠ pending requests · view with F2 or /approvals',
  },
  'attention.question-can-only-be-answered-on-the': {
    zh: '⚠ 问题仅桌面可答 · F2 或 /approvals 查看',
    en: '⚠ question can only be answered on the desktop · view with F2 or /approvals',
  },
  'attention.question-waiting-for-an-answer-handle-with': {
    zh: '⚠ 待回答问题 · F2 或 /approvals 处理',
    en: '⚠ question waiting for an answer · handle with F2 or /approvals',
  },
  'attention.terminal-approval-request-handle-with-f2-or': {
    zh: '🔐 终端审批请求 · F2 或 /approvals 处理',
    en: '🔐 terminal approval request · handle with F2 or /approvals',
  },
  'attention.the-draft-and-attachments-are-unchanged': {
    zh: '{p1} · 草稿与附件保持不变',
    en: '{p1} · the draft and attachments are unchanged',
  },
  'attention.the-request-is-no-longer-pending-pending': {
    zh: '请求已不在待办中 · 已刷新待办',
    en: 'The request is no longer pending · pending list refreshed',
  },
  'cmd.cannot-read-the-queue': {
    zh: '无法读取队列 · {p1}',
    en: 'Cannot read the queue · {p1}',
  },
  'cmd.cannot-reload-the-session': {
    zh: '无法重新拉取会话 · {p1}',
    en: 'Cannot reload the session · {p1}',
  },
  'cmd.cleared-the-on-screen-messages-the-session': {
    zh: '已清空当前界面的消息 · 会话本身没有被修改',
    en: 'Cleared the on-screen messages · the session itself is unchanged',
  },
  'cmd.end-only-matters-in-the-old-plain-multiline': {
    zh: '/end 只在旧的 --plain 多行模式里有意义；TUI 用 Alt+Enter 换行',
    en: '/end only matters in the old --plain multiline mode; the TUI uses Alt+Enter for newlines',
  },
  'cmd.press-alt-enter-in-the-draft-to-add-a': {
    zh: '在草稿里按 Alt+Enter 即可换行；Enter 始终发送整段草稿',
    en: 'Press Alt+Enter in the draft to add a newline; Enter always sends the whole draft',
  },
  'cmd.queue-action-failed': {
    zh: '队列操作失败 · {p1}',
    en: 'Queue action failed · {p1}',
  },
  'cmd.session-transcript-reloaded-messages': {
    zh: '已重新拉取会话记录 · {p1} 条消息',
    en: 'Session transcript reloaded · {p1} messages',
  },
  'cmd.unknown-command-press-for-commands-or-f1': {
    zh: '未知命令 {p1} · 按 / 查看命令，? 或 F1 查看快捷键',
    en: 'Unknown command {p1} · press / for commands, ? or F1 for shortcuts',
  },
  'misc.answer-submitted-this-turn-is-still-waiting': {
    zh: '回答已提交 · 本轮仍在等待 Host 返回（没有重发原 prompt）',
    en: 'Answer submitted · this turn is still waiting for the Host (the original prompt was not resent)',
  },
  'misc.back-to-the-newest-message': {
    zh: '已回到最新消息',
    en: 'Back to the newest message',
  },
  'misc.cannot-open-session': {
    zh: '无法打开会话 {p1} · {p2}',
    en: 'Cannot open session {p1} · {p2}',
  },
  'misc.completions': {
    zh: '补全：{p1}',
    en: 'Completions: {p1}',
  },
  'misc.delivery-result-unknown-check-history-first': {
    zh: '投递结果未知 · 先 /history 核对，不要直接重发（可能已经排队）',
    en: 'Delivery result unknown · check /history first; do not resend directly (it may already be queued)',
  },
  'misc.earlier-messages-omitted': {
    zh: '（更早的消息已省略）',
    en: '(earlier messages omitted)',
  },
  'misc.internal-error': {
    zh: '内部错误 · {p1}',
    en: 'Internal error · {p1}',
  },
  'misc.no-matching-items': {
    zh: '没有匹配的项',
    en: 'No matching items',
  },
  'misc.no-session-found-for': {
    zh: '没有找到会话 {p1}',
    en: 'No session found for {p1}',
  },
  'misc.not-provided-by-the-host': {
    zh: 'Host 未提供',
    en: 'not provided by the Host',
  },
  'misc.request-failed': {
    zh: '请求失败 · {p1}',
    en: 'Request failed · {p1}',
  },
  'misc.scroll-to-view-enter-only-acts-on-action': {
    zh: '↑↓ 滚动查看；Enter 只在操作行生效',
    en: '↑↓ scroll to view; Enter only acts on action rows',
  },
  'misc.sessions-start-with-give-a-longer-prefix': {
    zh: '{p1} 个会话都以 {p2} 开头，请给更长的前缀',
    en: '{p1} sessions start with {p2}; give a longer prefix',
  },
  'misc.stopped-the-local-wait-the-remote-may-still': {
    zh: '已停止本地等待 · 远端可能仍在运行，本轮并没有被远端取消',
    en: 'Stopped the local wait · the remote may still be running; this turn was not cancelled remotely',
  },
  'misc.stopped-watching-the-remote-automatically': {
    zh: '已停止自动监看远端（超时）· 用 /history 或 /status 手动刷新；没有重发原 prompt',
    en: 'Stopped watching the remote automatically (timeout) · refresh manually with /history or /status; the original prompt was not resent',
  },
  'misc.submitting-permissions-answers-please-wait': {
    zh: '正在提交权限/回答，请稍候再新建草稿',
    en: 'Submitting permissions/answers, please wait before starting a new draft',
  },
  'misc.the-host-returned-no-sessionid': {
    zh: 'Host 没有返回 sessionId',
    en: 'The Host returned no sessionId',
  },
  'misc.the-remote-has-pending-requests-again-view': {
    zh: '远端又出现了待处理请求 · /approvals 查看（不会自动允许/回答）',
    en: 'The remote has pending requests again · view with /approvals (nothing is allowed or answered automatically)',
  },
  'misc.the-remote-has-pending-requests-approvals': {
    zh: '远端有待处理请求 · /approvals',
    en: 'The remote has pending requests · /approvals',
  },
  'misc.the-remote-session-may-still-be-running': {
    zh: '远端会话可能仍在运行',
    en: 'The remote session may still be running',
  },
  'misc.the-remote-session-may-still-be-running-2': {
    zh: '远端会话可能仍在运行 · 重发前先在 /history 核对',
    en: 'The remote session may still be running · check /history before resending',
  },
  'misc.the-remote-turn-completed-the-real-remote': {
    zh: '远端本轮已完成 · 已恢复显示远端真实记录（没有重发原 prompt）',
    en: 'The remote turn completed · the real remote transcript is shown again (the original prompt was not resent)',
  },
  'misc.this-action-is-not-available-in-this': {
    zh: '这个操作在当前版本不可用',
    en: 'This action is not available in this version',
  },
  'misc.this-cli-does-not-handle-this-kind-of': {
    zh: '这类待处理输入本 CLI 不处理 · 请到桌面端查看',
    en: 'This CLI does not handle this kind of pending input · check on the desktop',
  },
  'misc.this-cli-host-cannot-watch-the-remote': {
    zh: '当前 CLI/Host 不支持监看远端状态 · 用 /history 手动刷新（没有重发原 prompt）',
    en: 'This CLI/Host cannot watch the remote status · refresh manually with /history (the original prompt was not resent)',
  },
  'misc.this-entry-has-no-session-to-resume': {
    zh: '这个条目没有可恢复的会话',
    en: 'This entry has no session to resume',
  },
  'misc.unknown': {
    zh: '未知',
    en: 'unknown',
  },
  'misc.waiting-for-a-human-answer-in-the-app': {
    zh: '等待应用内的人工回答 · {p1}',
    en: 'Waiting for a human answer in the app · {p1}',
  },
  'misc.waiting-for-this-turn-press-esc-or-ctrl-c': {
    zh: '正在等待本轮 · 先按 Esc 或 Ctrl+C 停止本地等待（远端可能仍在运行），再切换或新建',
    en: 'Waiting for this turn · press Esc or Ctrl+C to stop the local wait first (the remote may still be running), then switch or create',
  },
  'misc.you-can-pick-another-session-from-the': {
    zh: '可以先从会话选择器里换一个会话',
    en: 'You can pick another session from the session picker first',
  },
  'msg.all-sessions': {
    zh: '全部会话',
    en: 'All sessions',
  },
  'msg.allow-once-allowed-once': {
    zh: '允许一次（allowed-once）',
    en: 'allow once (allowed-once)',
  },
  'msg.answer': {
    zh: '回答',
    en: 'Answer',
  },
  'msg.answerable': {
    zh: '（可答）',
    en: ' (answerable)',
  },
  'msg.connected': {
    zh: '已连接',
    en: 'connected',
  },
  'msg.desktop-only': {
    zh: '仅桌面可答',
    en: 'desktop only',
  },
  'msg.desktop-only-2': {
    zh: '（仅桌面可答）',
    en: ' (desktop only)',
  },
  'msg.disconnected-waiting-for-reconnect-lease': {
    zh: '断开（等待重连/租约）',
    en: 'disconnected (waiting for reconnect/lease)',
  },
  'msg.empty': {
    zh: '（空）',
    en: '(empty)',
  },
  'msg.high-risk-second-confirmation-done': {
    zh: '（高危，已二次确认）',
    en: ' (high-risk, second confirmation done)',
  },
  'msg.idle': {
    zh: '空闲',
    en: 'idle',
  },
  'msg.later-approvals-return-to-the-desktop': {
    zh: ' · 后续审批回到桌面',
    en: ' · later approvals return to the desktop',
  },
  'msg.may-still-be-running': {
    zh: '可能仍在运行',
    en: 'may still be running',
  },
  'msg.multi-select': {
    zh: '多选',
    en: 'multi-select',
  },
  'msg.multi-select-pick-several-optional-free': {
    zh: '多选（可同时选多项，可补充自定义文字）',
    en: 'multi-select (pick several, optional free text)',
  },
  'msg.no-reason': {
    zh: '无原因',
    en: 'no reason',
  },
  'msg.none': {
    zh: '无',
    en: 'none',
  },
  'msg.not-reported': {
    zh: '未报告',
    en: 'not reported',
  },
  'msg.not-supported-by-this-host-update-deepseek': {
    zh: '这个 Host 不支持（需要更新 DeepSeek Harness）',
    en: 'not supported by this Host (update DeepSeek Harness)',
  },
  'msg.pending-requests': {
    zh: '待处理请求',
    en: 'Pending requests',
  },
  'msg.pending-requests-action-needed': {
    zh: '待处理请求（需要你处理）',
    en: 'Pending requests (action needed)',
  },
  'msg.reject-rejected': {
    zh: '拒绝（rejected）',
    en: 'reject (rejected)',
  },
  'msg.running': {
    zh: '运行中',
    en: 'running',
  },
  'msg.single-select': {
    zh: '单选',
    en: 'single-select',
  },
  'msg.single-select-pick-one-or-use-free-text': {
    zh: '单选（选一项，或改用自定义文字）',
    en: 'single-select (pick one, or use free text)',
  },
  'msg.supported-up-to-per-turn': {
    zh: '支持 · 每轮最多 {p1} 张',
    en: 'supported · up to {p1} per turn',
  },
  'msg.the-request-is-no-longer-pending-refreshed': {
    zh: '请求已不在待办中 · 已刷新',
    en: 'The request is no longer pending · refreshed',
  },
  'msg.the-request-was-handled-on-the-desktop': {
    zh: '请求已被桌面/其他终端处理、取消或过期 · 已刷新；不会提交旧答案',
    en: 'The request was handled on the desktop/another terminal, cancelled or expired · refreshed; no stale answer is submitted',
  },
  'msg.the-terminal-approval-claim-is-no-longer': {
    zh: '终端审批接入已失效 · 请重新打开 /approvals',
    en: 'The terminal approval claim is no longer valid · reopen /approvals',
  },
  'msg.the-terminal-approval-claim-lease-expired': {
    zh: '终端审批接入租约已过期 · 需重新接入；审批回到桌面（未答复请求不会被自动允许）',
    en: 'The terminal approval claim lease expired · claim again if needed; approvals return to the desktop (unanswered requests are never allowed automatically)',
  },
  'msg.the-w-option': {
    zh: ' + -w 选项',
    en: ' + the -w option',
  },
  'msg.this-cli-cannot-submit': {
    zh: ' · 当前 CLI 无提交能力',
    en: ' · this CLI cannot submit',
  },
  'msg.turns-steps-llm-total-tool-decode': {
    zh: '{p1} turns · {p2} steps · 累计 LLM {p3} · tool {p4}{p5} · decode {p6}{p7}',
    en: '{p1} turns · {p2} steps · LLM total {p3} · tool {p4}{p5} · decode {p6}{p7}',
  },
  'msg.unanswered-request-s-handed-back-to-the': {
    zh: ' · {p1} 个未答复请求已交回后续 answerer/桌面（不会被自动允许）',
    en: ' · {p1} unanswered request(s) handed back to the next answerer/desktop (never allowed automatically)',
  },
  'msg.unknown-the-host-did-not-provide-it': {
    zh: '未知（Host 未给出）',
    en: 'unknown (the Host did not provide it)',
  },
  'perm.already-nothing-was-submitted': {
    zh: '当前已经是 {p1} · 没有提交',
    en: 'Already {p1} · nothing was submitted',
  },
  'perm.cancel-do-not-switch': {
    zh: '取消（不切换）',
    en: 'Cancel (do not switch)',
  },
  'perm.choosing-a-target-preset-still-needs-one': {
    zh: '选择目标 preset 后还需要一步明确确认；Esc 取消不会改变权限。',
    en: 'Choosing a target preset still needs one explicit confirmation; Esc cancels without changing permissions.',
  },
  'perm.close-esc': {
    zh: '关闭（Esc）',
    en: 'Close (Esc)',
  },
  'perm.confirm-again': {
    zh: '再次确认 · {p1}',
    en: 'Confirm again · {p1}',
  },
  'perm.confirm-permission-switch': {
    zh: '确认切换权限 · {p1}',
    en: 'Confirm permission switch · {p1}',
  },
  'perm.confirm-switch': {
    zh: '确认切换',
    en: 'Confirm switch',
  },
  'perm.confirm-switch-to-risk-understood': {
    zh: '确认切换为 {p1}（已理解风险）',
    en: 'Confirm switch to {p1} (risk understood)',
  },
  'perm.continue-to-the-high-risk-confirmation': {
    zh: '继续高危二次确认',
    en: 'Continue to the high-risk confirmation',
  },
  'perm.current-preset': {
    zh: '当前预设：{p1}{p2}',
    en: 'Current preset: {p1}{p2}',
  },
  'perm.current-session': {
    zh: '当前会话：{p1}',
    en: 'Current session: {p1}',
  },
  'perm.default-preset-new-sessions': {
    zh: '默认预设（新会话）：{p1}',
    en: 'Default preset (new sessions): {p1}',
  },
  'perm.enter-confirms-the-switch-esc-cancels-never': {
    zh: 'Enter 确认切换 · Esc 取消（不会默认允许）',
    en: 'Enter confirms the switch · Esc cancels (never allowed by default)',
  },
  'perm.final-confirmation-enter-submits-esc': {
    zh: '最终确认：Enter 提交 · Esc 取消',
    en: 'Final confirmation: Enter submits · Esc cancels',
  },
  'perm.high-risk-action-enter-opens-the-second': {
    zh: '高危操作：Enter 进入二次确认 · Esc 取消',
    en: 'High-risk action: Enter opens the second confirmation · Esc cancels',
  },
  'perm.high-risk-preset-it-widens-what-the-agent': {
    zh: '高危 preset：会放宽 Agent 可执行的范围，Host 要求二次确认。',
    en: 'High-risk preset: it widens what the Agent may do, so the Host requires a second confirmation.',
  },
  'perm.loading': {
    zh: '正在读取…',
    en: 'Loading…',
  },
  'perm.no-session-yet-it-is-created-on-the-first': {
    zh: '尚未创建会话 · 发送第一条文字/附件后才会创建，之后才能读取/切换权限（不会隐式创建）',
    en: 'No session yet · it is created on the first text/attachment send, and only then can permissions be read or switched (never implicitly created)',
  },
  'perm.note-under-the-base-config-danger-full': {
    zh: '注意：base 配置下 danger-full-access 会把 approval policy 设为 never，之后不再弹审批。',
    en: 'Note: under the base config, danger-full-access sets the approval policy to never, so no approval prompts appear afterwards.',
  },
  'perm.nothing-is-submitted-until-you-confirm-here': {
    zh: '只有你在这里确认后才会提交；Esc 取消不会改变权限。',
    en: 'Nothing is submitted until you confirm here; Esc cancels without changing permissions.',
  },
  'perm.only-presets-that-really-exist-in-the-host': {
    zh: '只列出 Host catalog 中真实存在的 preset；custom 是派生态，不能直接选。',
    en: 'Only presets that really exist in the Host catalog are listed; custom is a derived state and cannot be selected directly.',
  },
  'perm.permission-preset-switched': {
    zh: '权限预设已切换：{p1} → {p2}{p3}{p4}',
    en: 'Permission preset switched: {p1} → {p2}{p3}{p4}',
  },
  'perm.permission-presets': {
    zh: '权限预设',
    en: 'Permission presets',
  },
  'perm.permission-presets-are-not-loaded-yet-re': {
    zh: '还没有读到权限预设 · 先重新读取',
    en: 'Permission presets are not loaded yet · re-read them first',
  },
  'perm.permission-presets-loading': {
    zh: '权限预设 · 读取中',
    en: 'Permission presets · loading',
  },
  'perm.permissions-switched': {
    zh: '已切换权限：{p1}',
    en: 'Permissions switched: {p1}',
  },
  'perm.re-read-permission-presets': {
    zh: '重新读取权限预设',
    en: 'Re-read permission presets',
  },
  'perm.read-back-mismatch-after-the-switch-re-read': {
    zh: '切换后回读不一致 · {p1} · 已重新读取，未自动重试',
    en: 'Read-back mismatch after the switch · {p1} · re-read, not retried automatically',
  },
  'perm.read-failed': {
    zh: '读取失败：{p1}',
    en: 'Read failed: {p1}',
  },
  'perm.read-only-display-the-current-value-is': {
    zh: '只读展示；不会猜测当前值。',
    en: 'Read-only display; the current value is never guessed.',
  },
  'perm.reading-host-permission-presets-and-catalog': {
    zh: '正在读取 Host 权限预设与 catalog…',
    en: 'Reading Host permission presets and catalog…',
  },
  'perm.select-preset-enter-confirm-esc-close': {
    zh: '↑↓ 选择 preset · Enter 进入确认 · Esc 关闭',
    en: '↑↓ select preset · Enter confirm · Esc close',
  },
  'perm.session': {
    zh: '会话 {p1}',
    en: 'Session {p1}',
  },
  'perm.submitting-please-wait-before-opening': {
    zh: '正在提交，请稍候再打开权限预设',
    en: 'Submitting, please wait before opening permission presets',
  },
  'perm.submitting-the-permission-switch-nothing-is': {
    zh: '正在提交权限切换…（不会重复提交）',
    en: 'Submitting the permission switch… (nothing is submitted twice)',
  },
  'perm.switch-failed': {
    zh: '切换失败（{p1}）· {p2}',
    en: 'Switch failed ({p1}) · {p2}',
  },
  'perm.switch-from-to': {
    zh: '从 {p1} 切换为 {p2}（{p3}）。',
    en: 'Switch from {p1} to {p2} ({p3}).',
  },
  'perm.the-host-catalog-does-not-offer-this-preset': {
    zh: 'Host catalog 不提供这个 preset · {p1}',
    en: 'The Host catalog does not offer this preset · {p1}',
  },
  'perm.the-host-catalog-has-no-nothing-was': {
    zh: 'Host catalog 没有 {p1} · 没有提交',
    en: 'The Host catalog has no {p1} · nothing was submitted',
  },
  'perm.the-host-catalog-has-no-such-preset-nothing': {
    zh: 'Host catalog 没有这个 preset · 不提交',
    en: 'The Host catalog has no such preset · nothing is submitted',
  },
  'perm.the-host-has-no-permission-preset-service': {
    zh: 'Host 没有权限预设服务（可能需要更新 DeepSeek Harness / local-cli）',
    en: 'The Host has no permission-preset service (DeepSeek Harness / local-cli may need updating)',
  },
  'perm.the-host-refused-the-switch-re-read-not': {
    zh: 'Host 拒绝切换 · {p1} · 已重新读取，未自动重试',
    en: 'The Host refused the switch · {p1} · re-read, not retried automatically',
  },
  'perm.the-host-requires-a-second-high-risk': {
    zh: 'Host 要求高危二次确认 · 没有提交；请重新选择并完成二次确认',
    en: 'The Host requires a second high-risk confirmation · nothing was submitted; choose again and complete the confirmation',
  },
  'perm.the-host-returned-no-permission-presets': {
    zh: 'Host 没有返回权限预设（旧版本或缺少 projection）。',
    en: 'The Host returned no permission presets (older version or missing projection).',
  },
  'perm.the-session-changed-permissions-were-not': {
    zh: '会话已切换 · 权限没有提交；请切回原会话后重新打开 /permissions',
    en: 'The session changed · permissions were not submitted; switch back and reopen /permissions',
  },
  'perm.the-session-does-not-exist-or-is-closed': {
    zh: '会话不存在或已关闭',
    en: 'The session does not exist or is closed',
  },
  'perm.the-session-has-no-live-agent-open-it-on': {
    zh: '会话当前没有 live Agent · 先在桌面端打开它或发送一条消息，再切换预设',
    en: 'The session has no live Agent · open it on the desktop or send a message first, then switch presets',
  },
  'perm.this-cli-cannot-submit-permission-switches': {
    zh: '当前 CLI 没有提交权限切换的能力（需要更新 dsh-ask）',
    en: 'This CLI cannot submit permission switches (dsh-ask needs updating)',
  },
  'perm.this-cli-host-does-not-support-permission': {
    zh: '当前 CLI/Host 不支持权限预设（需要新版 dsh-ask 与 Host bridge 的 /local-cli/permissions）',
    en: 'This CLI/Host does not support permission presets (needs a newer dsh-ask and the Host bridge /local-cli/permissions)',
  },
  'perm.this-host-is-read-only-and-cannot-switch': {
    zh: '当前 Host 只读，不能切换权限',
    en: 'This Host is read-only and cannot switch permissions',
  },
  'perm.this-host-offers-no-switch-entry-read-only': {
    zh: '当前 Host 不提供切换入口：只读展示。',
    en: 'This Host offers no switch entry: read-only display.',
  },
  'perm.this-is-the-second-confirmation-the-switch': {
    zh: '这是第二次确认：继续后才会真正提交切换。',
    en: 'This is the second confirmation: the switch is only submitted if you continue.',
  },
  'perm.view-esc-close-read-only': {
    zh: '↑↓ 查看 · Esc 关闭（只读）',
    en: '↑↓ view · Esc close (read-only)',
  },
  'perm.you-can-retry-the-read-nothing-changes': {
    zh: '可以重试读取；不会自动做任何权限修改。',
    en: 'You can retry the read; nothing changes permissions automatically.',
  },
  'picker.created-on-the-first-send': {
    zh: '{p1} · {p2} · 首次发送时创建',
    en: '{p1} · {p2} · created on the first send',
  },
  'picker.created-on-the-first-send-2': {
    zh: '{p1} · 首次发送时创建',
    en: '{p1} · created on the first send',
  },
  'picker.empty-session': {
    zh: '(空会话)',
    en: '(empty session)',
  },
  'picker.explicitly-restore-the-default-workspace': {
    zh: '显式恢复默认 workspace/cwd 范围',
    en: 'Explicitly restore the default workspace/cwd scope',
  },
  'picker.explicitly-switch-to-all-sessions-no': {
    zh: '显式切到全部会话；不会自动创建会话',
    en: 'Explicitly switch to all sessions; no session is created automatically',
  },
  'picker.failed-to-read-the-session-list-not-falling': {
    zh: '读取会话列表失败（{p1}）· {p2} · 未回退全部会话',
    en: 'Failed to read the session list ({p1}) · {p2} · not falling back to all sessions',
  },
  'picker.failed-to-read-the-session-scope-keeping': {
    zh: '读取会话范围失败 · 保持当前范围（未回退全部会话）',
    en: 'Failed to read the session scope · keeping the current scope (not falling back to all sessions)',
  },
  'picker.keep-the-current-scope-never-silently': {
    zh: '保持当前范围（不会偷偷切到全部会话）',
    en: 'Keep the current scope (never silently switches to all sessions)',
  },
  'picker.no-prompt': {
    zh: '(无提示词)',
    en: '(no prompt)',
  },
  'picker.no-sessions-in-the-current-scope': {
    zh: '（当前范围内没有会话）',
    en: '(no sessions in the current scope)',
  },
  'picker.scope-all-sessions-enter-shows-only': {
    zh: '范围：全部会话 · Enter 只显示 {p1}',
    en: 'Scope: all sessions · Enter shows only {p1}',
  },
  'picker.scope-enter-shows-all-sessions': {
    zh: '范围：{p1} · Enter 查看全部会话',
    en: 'Scope: {p1} · Enter shows all sessions',
  },
  'picker.select-a-session': {
    zh: '选择会话',
    en: 'Select a session',
  },
  'picker.select-enter-resume-switch-scope-type-to': {
    zh: '↑↓ 选择 · Enter 恢复/切换范围 · 输入过滤 · Esc 新建会话',
    en: '↑↓ select · Enter resume/switch scope · type to filter · Esc new session',
  },
  'picker.select-enter-switch-switch-scope-type-to': {
    zh: '↑↓ 选择 · Enter 切换/切换范围 · 输入过滤 · Esc 关闭',
    en: '↑↓ select · Enter switch/switch scope · type to filter · Esc close',
  },
  'picker.session-scope-resolution-failed-not-falling': {
    zh: '会话范围解析失败（{p1}）· 未回退全部会话',
    en: 'Session scope resolution failed ({p1}) · not falling back to all sessions',
  },
  'picker.start-a-local-new-conversation-right-away': {
    zh: '可直接开始本地新对话（首次发送时创建，不创建空会话）',
    en: 'Start a local new conversation right away (created on the first send, no empty session is created)',
  },
  'picker.submitting-permissions-answers-please-wait': {
    zh: '正在提交权限/回答，请稍候再切换会话',
    en: 'Submitting permissions/answers, please wait before switching sessions',
  },
  'picker.switch-session': {
    zh: '切换会话',
    en: 'Switch session',
  },
  'picker.the-host-rejected-the-scope-argument-not': {
    zh: '范围参数被 Host 拒绝 · 未回退全部会话',
    en: 'The Host rejected the scope argument · not falling back to all sessions',
  },
  'picker.this-host-does-not-support-scope-filtering': {
    zh: '⚠ 当前 Host 不支持范围筛选 · 已显示全部会话',
    en: '⚠ this Host does not support scope filtering · showing all sessions',
  },
  'picker.updating-the-host-bridge-restores-workspace': {
    zh: '升级 Host/bridge 后可恢复 workspace 范围；本项不改会话创建',
    en: 'Updating the Host/bridge restores workspace scoping; this does not change session creation',
  },
  'picker.workspace-created-on-the-first-send': {
    zh: 'workspace {p1} · 首次发送时创建',
    en: 'workspace {p1} · created on the first send',
  },
  'picker.workspace-not-found-keeping-the-current': {
    zh: '找不到 workspace {p1} · 保持当前范围，未回退全部会话',
    en: 'workspace {p1} not found · keeping the current scope, not falling back to all sessions',
  },
  'question.about-to-submit-the-answer-to-question-s': {
    zh: '即将提交对 {p1} 的回答（{p2} 问）。',
    en: 'About to submit the answer to {p1} ({p2} question(s)).',
  },
  'question.an-answer-for-this-question-was-already': {
    zh: '这个问题已经提交过回答',
    en: 'An answer for this question was already submitted',
  },
  'question.answer-cancelled-nothing-was-submitted': {
    zh: '已取消回答 · 没有提交任何内容',
    en: 'Answer cancelled · nothing was submitted',
  },
  'question.answer-question': {
    zh: '回答问题',
    en: 'Answer question',
  },
  'question.answer-question-2': {
    zh: '回答 · 第 {p1}/{p2} 题',
    en: 'Answer · question {p1}/{p2}',
  },
  'question.answer-submitted-call-question-s-the': {
    zh: '已提交回答（call {p1}，{p2} 问）· 不会重发原 prompt，改为监看远端',
    en: 'Answer submitted (call {p1}, {p2} question(s)) · the original prompt is not resent; the remote is watched instead',
  },
  'question.answer-submitted-watching-real-remote': {
    zh: '回答已提交 · 正在监看远端真实进度',
    en: 'Answer submitted · watching real remote progress',
  },
  'question.cancel-submit-nothing-esc': {
    zh: '取消（不提交，Esc）',
    en: 'Cancel (submit nothing, Esc)',
  },
  'question.checking-and-submitting-the-answer-nothing': {
    zh: '正在核对并提交回答…（不会重复提交）',
    en: 'Checking and submitting the answer… (nothing is submitted twice)',
  },
  'question.confirm-answer-submission': {
    zh: '确认提交回答',
    en: 'Confirm answer submission',
  },
  'question.current-input': {
    zh: '当前输入：{p1}',
    en: 'Current input: {p1}',
  },
  'question.detail': {
    zh: '详情：{p1}',
    en: 'Detail: {p1}',
  },
  'question.enter-confirms-the-submission-esc-cancels': {
    zh: 'Enter 确认提交 · Esc 取消（不会默认提交）',
    en: 'Enter confirms the submission · Esc cancels (never submitted by default)',
  },
  'question.enter-uses-this-text-esc-cancels': {
    zh: 'Enter 使用这段文字 · Esc 取消',
    en: 'Enter uses this text · Esc cancels',
  },
  'question.finish-this-question-go-to-the-next': {
    zh: '完成本题（继续下一题）',
    en: 'Finish this question (go to the next)',
  },
  'question.free-text': {
    zh: '自定义：{p1}',
    en: 'Free text: {p1}',
  },
  'question.free-text-answer': {
    zh: '自定义文字回答…',
    en: 'Free-text answer…',
  },
  'question.free-text-answer-question': {
    zh: '自定义回答 · 第 {p1}/{p2} 题',
    en: 'Free-text answer · question {p1}/{p2}',
  },
  'question.free-text-enter-to-edit': {
    zh: '自定义文字：{p1}（Enter 修改）',
    en: 'Free text: {p1} (Enter to edit)',
  },
  'question.free-text-is-added-to-the-multi-select': {
    zh: '自定义文字会补充到多选结果',
    en: 'Free text is added to the multi-select result',
  },
  'question.it-cannot-be-changed-after-submission-the': {
    zh: '提交后不能修改；Host 会按当前会话与请求状态校验。',
    en: 'It cannot be changed after submission; the Host validates it against the current session and request state.',
  },
  'question.multi-select-needs-at-least-one-option-or': {
    zh: '多选至少勾选一项，或使用自定义文字/跳过',
    en: 'Multi-select needs at least one option, or use free text/skip',
  },
  'question.no-option-checked-yet': {
    zh: '尚未勾选任何选项',
    en: 'No option checked yet',
  },
  'question.option-of-question-is-not-among-the-options': {
    zh: '第 {p1} 题的选项 {p2} 不在 Host 提供的选项里',
    en: 'Option {p2} of question {p1} is not among the options the Host provided',
  },
  'question.option-s-checked': {
    zh: '已勾选 {p1} 项',
    en: '{p1} option(s) checked',
  },
  'question.options': {
    zh: '选项：\n{p1}',
    en: 'Options:\n{p1}',
  },
  'question.options-2': {
    zh: '选项：{p1}',
    en: 'Options: {p1}',
  },
  'question.options-free-text': {
    zh: '选项：{p1} · 自定义：{p2}',
    en: 'Options: {p1} · free text: {p2}',
  },
  'question.options-the-host-provided-no-preset-options': {
    zh: '选项：Host 没有提供预设选项（可自定义文字）。',
    en: 'Options: the Host provided no preset options (free text is allowed).',
  },
  'question.question': {
    zh: '第 {p1}/{p2} 题{p3}',
    en: 'Question {p1}/{p2}{p3}',
  },
  'question.question-2': {
    zh: '题目：{p1}',
    en: 'Question: {p1}',
  },
  'question.question-3': {
    zh: '第 {p1} 题：{p2}',
    en: 'Question {p1}: {p2}',
  },
  'question.question-is-not-answered-yet-pick-an-option': {
    zh: '第 {p1} 题还没有回答（请选择选项、自定义文字或显式跳过）',
    en: 'Question {p1} is not answered yet (pick an option, use free text or skip explicitly)',
  },
  'question.question-waiting': {
    zh: '待回答问题 · {p1}',
    en: 'Question waiting · {p1}',
  },
  'question.scroll-enter-start-answering-esc-back': {
    zh: '↑↓ 滚动 · Enter 开始回答 · Esc 返回',
    en: '↑↓ scroll · Enter start answering · Esc back',
  },
  'question.scroll-esc-back-desktop-only': {
    zh: '↑↓ 滚动 · Esc 返回（仅桌面可答）',
    en: '↑↓ scroll · Esc back (desktop only)',
  },
  'question.select-enter-check-finish-this-question-to': {
    zh: '↑↓ 选择 · Enter 勾选 · 完成本题后继续 · Esc 取消',
    en: '↑↓ select · Enter check · finish this question to continue · Esc cancel',
  },
  'question.select-enter-choose-and-continue-esc-cancel': {
    zh: '↑↓ 选择 · Enter 选定并继续 · Esc 取消（不提交）',
    en: '↑↓ select · Enter choose and continue · Esc cancel (submit nothing)',
  },
  'question.skip-selected': {
    zh: '跳过（selected: []）',
    en: 'Skip (selected: [])',
  },
  'question.skip-this-question-selected': {
    zh: '跳过这题（selected: []）',
    en: 'Skip this question (selected: [])',
  },
  'question.start-answering': {
    zh: '开始回答',
    en: 'Start answering',
  },
  'question.state': {
    zh: '状态：{p1}{p2}',
    en: 'State: {p1}{p2}',
  },
  'question.submit-failed-edit-the-answer-and-confirm': {
    zh: '提交失败：请修改回答后重新确认',
    en: 'Submit failed: edit the answer and confirm again',
  },
  'question.submit-result-unknown-reopen-approvals-to': {
    zh: '提交结果未知 · {p1} · 先重新打开 /approvals 核对，不要连续重试',
    en: 'Submit result unknown · {p1} · reopen /approvals to check first; do not retry repeatedly',
  },
  'question.the-answer-did-not-pass-validation-edit-it': {
    zh: '回答未通过校验 · {p1} · 请修改后重试',
    en: 'The answer did not pass validation · {p1} · edit it and retry',
  },
  'question.the-answer-flow-was-cancelled': {
    zh: '回答流程已取消',
    en: 'The answer flow was cancelled',
  },
  'question.the-answer-is-submitted-only-after-the': {
    zh: '只有最后一步明确确认后才会提交回答；Esc 取消不会提交任何内容。',
    en: 'The answer is submitted only after the final explicit confirmation; Esc cancels and submits nothing.',
  },
  'question.the-free-text-answer-cannot-be-empty-esc': {
    zh: '自定义回答不能为空 · Esc 取消',
    en: 'The free-text answer cannot be empty · Esc cancels',
  },
  'question.the-free-text-answer-is-limited-to': {
    zh: '自定义回答最多 {p1} 字符',
    en: 'The free-text answer is limited to {p1} characters',
  },
  'question.the-free-text-answer-to-question-exceeds': {
    zh: '第 {p1} 题自定义回答超过 {p2} 字符',
    en: 'The free-text answer to question {p1} exceeds {p2} characters',
  },
  'question.the-host-refused-the-submission-it-may-need': {
    zh: 'Host 拒绝提交 · {p1} · 可能需要在桌面端回答',
    en: 'The Host refused the submission · {p1} · it may need to be answered on the desktop',
  },
  'question.the-request-expired-or-was-handled': {
    zh: '请求已过期或在别处处理 · 没有提交回答；已刷新待办',
    en: 'The request expired or was handled elsewhere · no answer was submitted; the pending list was refreshed',
  },
  'question.the-request-expired-or-was-handled-2': {
    zh: '请求已过期或已在别处处理 · 没有提交（{p1}）· 已刷新待办',
    en: 'The request expired or was handled elsewhere · nothing was submitted ({p1}) · the pending list was refreshed',
  },
  'question.the-session-changed-and-the-answer-was-not': {
    zh: '会话已切换，回答没有提交 · 请切回原会话后重新打开 /approvals',
    en: 'The session changed and the answer was not submitted · switch back and reopen /approvals',
  },
  'question.this-cli-cannot-submit-answers': {
    zh: '当前 CLI 没有提交回答的能力',
    en: 'This CLI cannot submit answers',
  },
  'question.this-cli-cannot-submit-answers-dsh-ask': {
    zh: '当前 CLI 没有提交回答的能力（需要更新 dsh-ask）；不会自动作答。',
    en: 'This CLI cannot submit answers (dsh-ask needs updating); nothing is answered automatically.',
  },
  'question.this-cli-version-cannot-answer-open': {
    zh: '本版本 CLI 不能回答 open 问题；请到桌面应用回答，这里不会自动作答。',
    en: 'This CLI version cannot answer open questions; answer in the desktop app, nothing is answered automatically here.',
  },
  'question.this-question-already-has-a-queued-reply': {
    zh: '该问题已有一条排队回复 · 没有重复提交',
    en: 'This question already has a queued reply · nothing was submitted twice',
  },
  'question.this-question-can-only-be-answered-on-the': {
    zh: '这个问题只能在桌面端回答；CLI 没有答复入口',
    en: 'This question can only be answered on the desktop; the CLI has no answer entry',
  },
  'question.type': {
    zh: '类型：{p1}',
    en: 'Type: {p1}',
  },
  'question.type-the-text-and-press-enter-to-use-it-esc': {
    zh: '输入文字后按 Enter 使用；Esc 取消，不会提交。',
    en: 'Type the text and press Enter to use it; Esc cancels and submits nothing.',
  },
  'question.unanswered': {
    zh: '未回答',
    en: 'unanswered',
  },
  'question.using-free-text-clears-the-selected-options': {
    zh: '使用自定义文字时，已选选项会被清空',
    en: 'Using free text clears the selected options',
  },
  'queue.no-pending-item': {
    zh: '没有待处理项 {p1}',
    en: 'No pending item {p1}',
  },
  'queue.pending': {
    zh: '{p1} · {p2} · {p3} 待处理',
    en: '{p1} · {p2} · {p3} pending',
  },
  'queue.queue-empty': {
    zh: '（队列为空）',
    en: '(queue empty)',
  },
  'queue.usage-edit-n-new-text': {
    zh: '用法：/edit <n> <new text>',
    en: 'Usage: /edit <n> <new text>',
  },
  'statusdetail.attachments-pending-sent-unconfirmed': {
    zh: 'attachments {p1} 待发 · {p2} 已发送/未确认',
    en: 'attachments {p1} pending · {p2} sent/unconfirmed',
  },
  'statusdetail.last-turn-tool-calls-session': {
    zh: 'last turn   {p1} · {p2} · {p3} 次工具调用 · session {p4}',
    en: 'last turn   {p1} · {p2} · {p3} tool calls · session {p4}',
  },
  'statusdetail.nothing-is-created-implicitly-and-no-empty': {
    zh: '不会隐式创建，也不会新增 Host 空对话。',
    en: 'Nothing is created implicitly, and no empty Host conversation is added.',
  },
  'statusdetail.session-not-created-local-draft': {
    zh: 'session     未创建（本地草稿）',
    en: 'session     not created (local draft)',
  },
  'statusdetail.state-draft-created-on-the-first-send-using': {
    zh: 'state       draft · 首次发送时按当前 cwd{p1} 创建会话',
    en: 'state       draft · created on the first send using the current cwd{p1}',
  },
  'statusdetail.state-remote': {
    zh: 'state       {p1} · 远端{p2}',
    en: 'state       {p1} · remote {p2}',
  },
  'statusdetail.status-no-host-status-yet-older-version': {
    zh: 'status      未取到 Host 状态（旧版本没有 /local-cli/status，或尚未刷新）',
    en: 'status      no Host status yet (older version without /local-cli/status, or not refreshed yet)',
  },
}
