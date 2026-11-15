# 权限 preset 与待应答应答

> 当前状态：权限 preset、`continued` 问题应答、工具审批的终端通道（状态机、路由、官方
> Node Client transport、CLI 与全屏界面）均已实现并通过离线/mock 测试。`index.js` 已接线
> 审批路由与惰性 transport（仅显式 claim 时才建立官方 owner/answer Node Client），并已在
> 真实桌面 Host 完成插件重载：审批端点已上线；在新建的专用空白会话中真实 claim 成功
> （`connected:true`、pending 0），release 成功（delegated 0）后 `claim:null`；验证未对任何
> 真实审批作答。旧 Host 缺少 `/local-cli/approval*` 路由时仍明确报旧 Host/不支持并降级到
> 桌面，聊天不受影响。`state:"open"` 问题仍没有 Host 答复 API；工具审批走独立的
> `approval/request` waterfall → 终端通道路径，不改变 `continued` 问题的答复方式。

本文是 bridge（`permissions.js`、`approval-channel.js`、`approval-routes.js`、
`approval-transport.js`）与 CLI（`dsh-ask.mjs`）之间权限/待应答/审批功能的接口契约，
依据已安装的 DeepSeek Harness **0.2.2-rc.1** 运行时静态代码与真实 API 契约，不依赖
`dev checkout`。相关源码：

- `@deepseek-ai/dsh-permission-presets/lib/types/index.js`
- `@deepseek-ai/dsh-user-approval/lib/index.js`（`approval/request` waterfall）
- `@deepseek-ai/dsh-user-questions/lib/{types/index.js,types/projection.js}`
- `@deepseek-ai/dsh-api-session-controller/lib/index.js`
- `@deepseek-ai/dsh-api-gateway/lib/index.js`（`$events` / `$events/result`）
- `@deepseek-ai/dsh-client-connection/lib/index.js`（`/connect`、owner/answer Peer）
- `@deepseek-ai/dsh-typert-registry/lib/client.node.js`（client `typert`）
- `@deepseek-ai/dsh-commands/lib/index.js`

## 1. 权限 preset

### 1.1 读取

- `ctx.permissionPresets.catalog()`（Host 服务）返回
  `{ options:[{value,name,description?}], defaultOptions, defaultPreset }`。`value` 是
  可选目标，`name`/`description` 只用于展示。
- 当前会话选择：`sessionController.projections({sessionId})` 的 `values.permissions`
  wire 视图只有 `{ currentValue }`；sandbox/approval 原始旋钮不暴露。
- 默认 preset（未来会话）来自 settings namespace `permission.defaultPreset`，本功能只读。

### 1.2 修改

唯一用户写入路径是 Host 的 `/permission <preset>` 命令（Web 端
`session.command("/permission …")` 走 Remote `commands.execute(agentId,line,[])`）。
bridge 调用 `ctx.commands.execute(agent, "/permission " + preset, [], signal)`，与桌面端
完全同一条路径，会写 `command/run` + `command/done` 并同步 sandbox 与 approval 两个旋钮。

- 只接受 catalog 中真实存在的 `value`，逐字节比较：不做 trim、折叠或截断。
- `custom` 是派生态，不可作为目标；`auto` 只在 Auto integration 活着时出现在 catalog。
- `danger-full-access`、`auto` 是高危切换，必须用户显式确认（CLI `--yes`，
  HTTP `confirmed:true`），与桌面端二次确认一致。
- 写后立即回读 `permissions.currentValue`，不一致返回 `switch-unverified`，不重试。
- 需要 live agent；冷会话返回 `session-not-live`，不静默 resume。

## 2. 待应答

### 2.1 读取

- `sessionController.state({sessionId})` 返回 `{cursor,active,running,queue,pendingInput}`；
  `pendingInput` 只有种类 `["approval","question","other"]`，没有内容 payload。
- 问题详情来自 projection `userQuestions`（wire）：
  `{ active:[{ callId, questions:[{id,question,detail?,header?,options?:[{label,description?}],multiSelect?}], state:"open"|"continued" }], settled:[{callId,answers}] }`。
  投影不含 `intent`（plan-review/approval 展示意图），只余 options 标签。
- 工具审批没有 Host 的只读投影；终端通道的 pending 来自本仓库状态机，通过
  `GET /local-cli/approval` 返回 claim 与 pending 的白名单视图（见 §4）。Remote API
  仍没有审批答复方法；官方扩展点是 Host 内的 `approval/request` waterfall answerer。

### 2.2 `continued` 问题答复（保持不变）

- 只有 `state:"continued"` 的问题可答复：
  `ctx.userQuestions.answer(agent, callId, { answers:[{id,selected:[label…],custom?}] })`
  → boolean（Remote `userQuestions/answer`）。Host 校验每个 question id 恰好一次
  （`BAD_ANSWER`）、已有排队回复（`REPLY_QUEUED`）、调用者必须是 live root
  （`CALLER_NOT_LIVE`/`DELEGATED_CALLER`）；已 settled 或不存在返回 false。
- `state:"open"`（含 intent approval/plan-review）由实时 owner Client 的 Remote Event
  waterfall 持有，Host 插件没有安全答复路径 → `not-answerable`，提示到桌面端。
- `cancelled` 表示请求 signal 被 abort，晚到答案丢弃；不得改写为拒绝或允许。

### 2.3 工具审批与终端通道

Host 契约（0.2.2-rc.1 核实）：

- 工具需要审批时，Host 调 `ctx.approval.request()`，在 `ask` 策略下于请求所属 Agent 的
  scope 上派发 Cordis waterfall `approval/request`；answerer 返回
  `allowed-once | rejected | cancelled | unavailable` 即作答，调用 `next()` 即委派。
  answerer 是 waterfall listener，agent-scoped listener 只收到该 agent 的请求；一个部署
  组合一个终结 answerer，同级顺序不是策略优先级机制。outcome 只有这四种，没有
  allow-always/规则存储；`cancelled`（请求 signal abort）与 `unavailable`
  （缺 answerer/失败）由 Host 决定，不是用户可选项。
- 本仓库不修改 Host、不注册 `prepend` 监听器抢占桌面。终端通道使用 Host 的公开 Node
  Client 路径：Host 侧 `connection.authenticatedUrl(origin)` +
  `GET /connect?token=…&interactions=answer` 取得 owner/answer Peer 与内存 Cookie，
  再用官方 `dsh-client-connection` / `dsh-typert-registry` / `dsh-api-gateway` 客户端包
  建立独立 client Cordis 树，订阅 `$events` 的 `approval/request`，通过 `$events/result`
  作答。身份由 Host 自己签发，不伪造 principal、不读 private 字段。
- 显式 claim：`POST /local-cli/approval/claim` 只对用户指定的当前会话生效；client 侧
  `agent` Context 适配器只把 `agentId === claimedSessionId` 映射到本地 root，其他会话由
  官方 gateway 直接回 `next`，不登记、不缓存、不暴露细节。claim 默认租约 60s，调用方
  （CLI 单次命令或 TUI adapter）负责在会话交互期间心跳续租；release、租约到期、连接断开
  时，在途请求一律交回后续 answerer/桌面（fail closed），不会被自动允许。
- 桌面与终端非排他：同一 pending 会投递给所有 owner/answer Client；先给出显式人工答复
  的一方生效，另一方收到 cancel。终端无法阻止桌面同时展示同一请求。
- 答复命令（`POST /local-cli/approval/answer`）只接受 `allowed-once` / `rejected`；
  成功响应带 `final:false`，只表示本地已提交、等待 Host 确认，不声称 Host 已允许或已写
  审计；不自动重试。旧 Host 没有该路由时，CLI/TUI 明确报旧 Host/不支持并降级到桌面。

## 3. 精确值规则（重要）

Host 用标识匹配身份，因此 bridge 对 **sessionId、callId、question id、option label、
selected 标签、custom 文本**不做任何净化、trim、折叠或截断：

- 展示用文本（question/detail/header/description）单独净化，且永远不会作为答复发回 Host。
- 无法安全 round-trip 的标识（含控制字符、超长、空）按 `schema-invalid` 拒绝，不猜。
- 重复的 question id、重复的 option label、重复的 callId 是歧义输入，按 `schema-invalid` 拒绝。
- 没有 options（或 options 为空）的问题不接受任何 `selected` 标签，只能用 `custom` 或显式
  skip（`selected: []`，Host 语义为跳过）。
- `custom` 超过 512 字符显式拒绝，不静默截断；空白 custom 拒绝。
- 答复批次必须逐题恰好一条；单问多选在 `multiSelect !== true` 时拒绝多标签。

## 4. 白名单 DTO

`GET /local-cli/permissions?sessionId=` →
`{ ok, sessionId, permission:{ currentValue, label?, options:[{value,name,description?}], defaultPreset }, canSet, source }`

`POST /local-cli/permissions` `{ sessionId, preset, confirmed? }` →
`{ ok, sessionId, preset, matched:true, text }`

`GET /local-cli/awaiting?sessionId=` →
`{ ok, sessionId, running, pendingInput, questions:{ active:[…], settledCount }, approvals:{ supported:false, present, reason }, answerable }`

`POST /local-cli/answer` `{ sessionId, callId, answers:[{id,selected:[],custom?}] }` →
`{ ok, sessionId, callId, accepted:true, source }`

审批通道（独立路由，不改变上面 `awaiting` 的 `approvals.supported:false` 语义）：

`GET /local-cli/approval?claimId=` →
`{ ok, claim:{claimId,sessionId,expiresAt,leaseMs}|null, connected, pendingCount, maxPending, pending:[{requestId,sessionId,toolName,callId,reason,displayReason,requestedAt}] }`

`POST /local-cli/approval/claim` `{ sessionId, leaseMs? }` →
`{ ok, claimId, sessionId, expiresAt, leaseMs }`（sessionId 是 Host 解析后的 canonical 值）

`POST /local-cli/approval/heartbeat` `{ claimId, leaseMs? }` → `{ ok, claimId, expiresAt, leaseMs }`

`POST /local-cli/approval/release` `{ claimId, reason? }` → `{ ok, released:true, delegated }`

`POST /local-cli/approval/answer` `{ claimId, requestId, outcome:"allowed-once"|"rejected" }` →
`{ ok, claimId, requestId, outcome, submittedAt, final:false, note }`

所有响应只含上述白名单字段；不返回 Session header、provider 配置、凭据、原始投影，也不
返回 token/cookie/连接句柄。

## 5. 错误码

`invalid-body`、`unknown-preset`、`no-such-session`、`preset-not-available`、
`confirmation-required`、`session-not-live`、`permission-unavailable`、`switch-failed`、
`switch-unverified`、`invalid-answer`、`label-not-offered`、`not-answerable`、
`stale-request`、`reply-queued`、`answer-unavailable`、`approval-answer-unsupported`、
`internal-error`、`schema-invalid`。

审批通道另有：`invalid-request`、`invalid-session`、`invalid-lease`、
`outcome-not-supported`、`claim-conflict`、`claim-mismatch`、`claim-expired`、
`channel-disposed`、`channel-unavailable`、`agent-registry-unavailable`、
`request-not-pending`、`route-failed`、`transport-unavailable`、`transport-auth-failed`。
其中 `transport-*` 表示终端 Node Client 通道不可用（旧 Host、官方运行时包缺失/版本不匹配、
认证失败），CLI/TUI 据此降级到桌面。

## 6. CLI 与 TUI adapter

子命令允许前置全局参数（`dsh-ask -u URL permissions …`）；解析器跳过已知带值参数后
取第一个位置参数作为子命令，绝不把权限类子命令退化为 prompt。裸 `--` 强制其后全部
作为 prompt 文本（例如 `dsh-ask -- permissions`），这是字面量词的逃生口。
回归测试见 `tests/permissions-cli.test.mjs`（断言权限命令不触达 `/ask`、`/stream`、
`/create`）。

- `dsh-ask permissions [session] [--json]`
- `dsh-ask permissions set <preset> [session] [--yes] [--json]`
- `dsh-ask awaiting [session] [--json]`
- `dsh-ask answer <session> <callId> --select <qid>=<label>[,<label>] [--custom <qid>=<text>] [--skip <qid>] [--json]`

adapter（`createTuiAdapter`）提供 `fetchPermissions(sessionId)`、`submitPermission(body)`、
`fetchAwaiting(sessionId)`、`submitAnswer(body)`；失败时抛出带 `code`/`status` 的 Error，
TUI 依据 `code` 决定降级行为。

审批通道子命令：

- `dsh-ask approval status [claimId] [--json]`
- `dsh-ask approval claim <session> [--lease <ms>] [--json]`（默认 60000ms，响应必须显示租约）
- `dsh-ask approval release <claimId> [--json]`
- `dsh-ask approval answer <claimId> <requestId> --allow-once|--reject --confirm [--json]`
  （未选择或未确认的调用 exit 2，不触达 Host；成功只表示本地已提交、等待 Host 确认）

审批 adapter 方法（命名固定）：`fetchApprovalChannel(claimId?)`、
`claimApprovalChannel({sessionId,leaseMs?})`、`heartbeatApprovalChannel({claimId})`、
`releaseApprovalChannel({claimId,reason?})`、`submitApprovalDecision({claimId,requestId,outcome})`。
`claimApprovalChannel` 成功后由 adapter 自动心跳（周期按租约夹取），心跳失败即停、不重试；
`releaseApprovalChannel` 停止心跳。全屏 `/approvals` 只在 adapter 具备这些方法时提供终端
审批入口，并以 `/local-cli/health` 的 `capabilities.approvalChannel` 作为 Host 能力探测：
缺失即显示“不支持终端审批通道，审批只能在桌面端处理”。`continued` 问题仍复用原有
`submitAnswer` 流程。

## 7. 不可绕过

- 不自动允许/拒绝任何真实 pending 审批或问题；只有用户显式命令+显式选择才提交。
- 不写 `approval/decided`、不伪造 outcome；不把 `allowed-once` 扩大为 session/always。
- 不改 approval policy / sandbox 旋钮来"让动作通过"；切 preset 本身即切策略，必须用户显式选择。
- 不答复 open 问题；不绕过插件管理与审批机制。
- 审批通道只允许显式 claim 当前会话；不 claim 其他会话、不全局订阅、不 `prepend` 抢占桌面；
  桌面与终端先答者生效，另一方 cancel 是正常多客户端语义。
- 不自动允许/拒绝/重试审批；只提交用户显式选择并确认的 `allowed-once`/`rejected`；
  不把 `submitted` 写成 Host 已允许；不写 `approval/decided`。
- token、认证 URL、Cookie 只在 Host 进程内存中使用，不返回、不落盘、不写日志。
- 真实 Host 验证只用新建空白会话，可逆设置后恢复原 preset；不动用户现有会话；
  审批的真实验收由用户在空白会话中手动确认，不做试探性作答。
