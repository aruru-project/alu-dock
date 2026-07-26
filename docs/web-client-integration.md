# Web 后端接入 Alu Dock Protocol V2

本文面向需要从 Rails 等本机 Web 后端接入 Alu Dock 的开发者。它描述 Alu Dock 已提供的控制面、Protocol V2 的消费规则以及当前尚未提供的能力。

## 结论

Alu Dock V0.2 已经具备多实例 WebConsole 的主要控制底座：

- 查看和管理多个 Dock instance；
- 获取权威 snapshot、当前会话历史、Queue 和运行统计；
- 接入正在运行的 instance，持续接收结构化事件；
- 提交文字或本机图片 prompt、steer 和 follow-up，执行整轮 abort 和 Queue 控制；
- 管理模型、thinking、tools、settings、resources 和 session/tree；
- 观察并回复 extension 的 select、confirm、input 和 editor 交互；
- Web 后端断开后，Host 中的 instance 和运行中的工作继续存在。

图片输入、generation error 与 controller 专属的 extension title/editor text 合同均已固定。Rails 可据此完成不低于现有 WebConsole 的正式切换；Web 适配层实现本身仍由 Card #183 负责。

推荐边界是：

```text
Browser
   │ HTTP / WebSocket
   ▼
Rails / Web backend
   │ private Unix socket · Protocol V2
   ▼
Alu Dock Host
   └── one isolated Worker/Pi runtime per active instance
```

浏览器不直接连接 Dock，不持有 interaction lease，也不接触 Pi SDK、Worker IPC 或 runtime object。Alu Dock 不提供 Redis/RPC 兼容层，也不负责 Rails、ActionCable 或页面状态机。

正式接入以功能不退化为底线。Rails 应直接采用本文已固定的 catalog、attach、conversation、Queue、图片与 Extension UI wire shape，不能自行猜测或复制 Pi 私有协议。

## 运行边界

### 本机同用户

Managed Host 的 socket 通常位于：

```text
${XDG_RUNTIME_DIR}/alu-dock/dock.sock
# 常见展开：/run/user/<uid>/alu-dock/dock.sock
```

systemd 创建的目录权限是 `0700`，socket 权限是 `0600`。Rails 必须与 Alu Dock Host 使用同一 OS 用户运行，并通过部署配置得到 socket 路径。不要放宽 socket 权限来支持其他用户或公网访问。

开发环境可通过 `ALU_DOCK_SOCKET` 为客户端和开发 Host 配置同一个绝对路径。Managed Host 自身不接受该变量覆盖 systemd 的 runtime socket。

### Service 生命周期

Protocol V2 客户端只连接已经运行的 Host。普通 Web 请求不得隐式安装、启动、重启或替换 Alu Dock service。Host 不可用时，Web 后端应报告控制面不可用。

## Wire 协议

### JSONL

Protocol V2 使用 Unix stream socket 上的 UTF-8 JSON Lines：

- 每条 frame 是一个完整 JSON object，以 `\n` 结束；
- 单条 frame 最大 1 MiB；
- 每个连接必须先完成 hello；
- hello 后每个连接只允许一个业务 request；
- 普通 request 返回一个 response 后关闭；
- `instance.attach` 的 follow 模式先返回一个 response，然后在同一连接持续返回 event frames。

请求 object 是 closed schema。不要向 request 或 hello 添加未定义字段。

### Hello

每个新连接先发送：

```json
{"kind":"hello","requestId":"hello-uuid","versions":[2],"client":{"name":"alubot-admin","version":"1.0.0","clientId":"rails-boot-uuid"},"requiredCapabilities":["core.v2","host.info"]}
```

成功响应：

```json
{"kind":"hello_ack","requestId":"hello-uuid","version":2,"host":{"pid":1234,"dockVersion":"0.2.0","piSdkVersion":"0.81.1","hostEpoch":"host-epoch","startedAt":"2026-01-01T00:00:00.000Z"},"catalogSchemaVersion":1,"capabilities":["catalog.maintenance.v1","catalog.v1","command.images.path.v1","core.v2","events.follow","events.replay-purpose.v1","extension_ui.controller-directives.v1","extension_ui.persistent-interactions.v1","extension_ui.tools-expanded.v1","extension_ui.v1","extension_ui.widgets.v1","git.branch-footer.v1","host.info","instance.catalog","instance.keys.v1","models.v1","projection.completeness.v1","queue.control.v1","resources.v1","run.abort.v1","service.managed.v1","session.adopt.v1","session.commands.v1","session.core","session.inventory-diagnostics.v1","session.inventory.v1","session.reopen","session.tree.v1","settings.v1","tool-result-presentation.v1","tools.v1","tui.projection.v1"],"limits":{"maxLineBytes":1048576,"maxPromptChars":256000,"maxReplayEvents":1000,"maxHistoryItems":200,"maxInstanceListItems":100,"maxInstanceListBytes":786432}}
```

客户端必须在发送业务 request 前验证：

- `kind == "hello_ack"`；
- hello `requestId` 相同；
- `version == 2`；
- `catalogSchemaVersion == 1`；
- 所有 required capabilities 都存在；
- 保存本次连接协商得到的 `host.hostEpoch`。

`hello_error` 表示业务 request 尚未发送，因此 mutation 尚未发生。常见 code 包括 `unsupported_protocol`、`capability_missing`、`host_starting` 和 `host_draining`。

### Request 与 response

Hello 成功后发送一个业务 request：

```json
{"kind":"request","version":2,"requestId":"request-uuid","type":"instance.get","params":{"instanceId":"instance-id"}}
```

成功 response envelope（下例的空 instance 仅表示省略具体 DTO 字段）：

```json
{"kind":"response","version":2,"requestId":"request-uuid","hostEpoch":"host-epoch","ok":true,"result":{"instance":{}}}
```

失败 response：

```json
{"kind":"response","version":2,"requestId":"request-uuid","hostEpoch":"host-epoch","ok":false,"error":{"code":"not_found","message":"...","retryable":false}}
```

必须校验 response 的 `requestId`、`version` 和 `hostEpoch`。业务 request 已发送后出现 timeout、断连、非法 response 或 correlation mismatch 时，read 可以重新查询；mutation 必须按“结果可能未知”处理，不能自动重放。

### 最小 Ruby transport 示例

下面只演示 wire state machine，不是完整 Rails client：

```ruby
require "json"
require "securerandom"
require "socket"

socket = UNIXSocket.new(ENV.fetch("ALU_DOCK_SOCKET"))
hello_id = SecureRandom.uuid

socket.write({
  kind: "hello",
  requestId: hello_id,
  versions: [2],
  client: {
    name: "alubot-admin",
    version: "1.0.0",
    clientId: "rails-#{Process.pid}"
  },
  requiredCapabilities: ["core.v2", "host.info"]
}.to_json << "\n")

hello = JSON.parse(socket.gets || raise("Dock closed during hello"))
required = ["core.v2", "host.info"]
raise "Protocol negotiation failed" unless
  hello["kind"] == "hello_ack" &&
  hello["requestId"] == hello_id &&
  hello["version"] == 2 &&
  hello["catalogSchemaVersion"] == 1 &&
  required.all? { |capability| hello.fetch("capabilities", []).include?(capability) }

request_id = SecureRandom.uuid
socket.write({
  kind: "request",
  version: 2,
  requestId: request_id,
  type: "host.info",
  params: {}
}.to_json << "\n")

response = JSON.parse(socket.gets || raise("Dock closed before response"))
raise "Response correlation failed" unless
  response["kind"] == "response" &&
  response["requestId"] == request_id &&
  response["hostEpoch"] == hello.dig("host", "hostEpoch")
```

生产客户端还必须实现 frame 大小限制、读取 timeout、closed response 校验和 mutation ambiguity 规则。

## 身份模型

以下身份不能混用：

| 身份 | 含义 |
|---|---|
| `instance.id` | Dock 工作身份；Web 应以它作为工作区主键 |
| `instance.key` | 可选的业务层唯一 key；只用于稳定找到同一个 Dock instance |
| `executor.piSessionId` | 当前 Pi session 身份 |
| `executor.sessionFile` | 当前 Pi session 的可选本机文件路径；某些状态下不存在 |
| `runtimeGeneration` | 当前 instance 内的 runtime/session generation |
| `hostEpoch` | 本次 Host 进程域 |
| `operationId` | 一次调用者意图对应的 mutation 身份 |
| catalog `revision` | 一次 catalog 分页读取所属的版本 |
| event `sequence` | 一个 instance generation 内的事件序号 |

成功且未取消的 session new/switch/fork/clone/reload 保留 `instance.id` 和可选 `instance.key`，并推进 `runtimeGeneration`。这些 request 即使 `ok: true` 也可能返回 `cancelled: true`；客户端必须先检查结果。Host 重启会改变 `hostEpoch`。不要使用 Pi session ID、文件路径、instance name、cwd 或更新时间替代 Dock instance identity/key。

### 业务 key 与唯一工作入口

Dock 不定义 `primary`、`alu` 或 `voice` 的业务含义。调用方先用只读 `instance.get_by_key {"key":"alu"}` 查询；没有结果时，可以用一个最长 128 字符、无控制字符的 opaque `key` 获取或创建唯一 instance：

```json
{"kind":"request","version":2,"requestId":"request-uuid","type":"instance.ensure","params":{"operationId":"operation-uuid","key":"alu","cwd":"/home/luziyi/workshop/alu_workstation","name":"Alu Workstation"}}
```

协商能力为 `instance.keys.v1`。成功 result 包含 `created` 和完整 instance snapshot；以下只摘出相关字段：

```json
{"created":true,"instance":{"id":"instance-id","key":"alu"}}
```

若 `alu` 已存在，Host 忽略只供首次创建使用的 `cwd`/`name`，返回同一 instance 且 `created: false`。同一 Host 同时收到多个相同 key 的首次请求时，只创建一个 instance，后续请求等待并取得第一个已提交的 `instanceId`。session replacement、reopen 和 Host restart 不改变 key。

Key 是当前业务入口，不是权限、controller lease、Worker 类型、运行优先级或自动 reopen。调用方应核对返回 snapshot 的 authoritative `cwd`；若业务工作目录已搬迁或绑定错误，应显式 stop 旧 instance。`instance.stop` 的 durable intent 一经提交，旧 instance 立即释放 key，继续按原 `instanceId` 完成 cleanup 并保留无 key 的 history record；调用方无需等待 cleanup 即可在正确 cwd 再次 `instance.ensure`。stop intent 提交失败则 key 保持不变。forget 删除 record 时也自然移除 key。

## 推荐的 Web 初始流程

1. 用 `host.info` 检查 Host 和 capabilities。
2. 固定业务工作台先用 `instance.get_by_key` 查询约定 key；不存在时用 `instance.ensure` 创建，并核对返回的 canonical `cwd`。cwd 不符合当前配置时，显式 stop 旧 instance；stop intent 提交后即可在正确 cwd ensure 新 instance。若 ensure 结果因传输丢失而不确定，重新执行只读查询，不重放 mutation。多实例目录仍用 `instance.list` 分页读取 catalog。
3. 目标 instance active 后，用 `instance.attach`：
   - 首次打开使用 `replay: "conversation_bootstrap"`；
   - 只观察时使用 `controller: "observe"`；
   - 需要回复 extension interaction 时才使用 `controller: "claim"`。
4. 使用 attach response 中的 snapshot、recent history 和 pending messages 建立初始页面。
5. 按顺序消费同一 socket 后续的 event frames。
6. 更早历史通过 `session.history` 分页读取；models、settings、tools 等按页面需要延迟请求。

Catalog 当前没有全局 follow stream。Web 可以定期重新执行 revision-bound `instance.list`；打开某个 instance 后使用它自己的 attach stream。是否需要 catalog 级实时订阅，应由实际 Web 体验决定。

## Instance catalog 与生命周期

### Catalog 分页

请求：

```json
{"kind":"request","version":2,"requestId":"request-uuid","type":"instance.list","params":{"selector":"all","limit":100}}
```

- `selector: "all"` 返回全部 catalog records；
- `selector: "actionable"` 只排除 `stopped`，不代表其余记录一定可 reopen；
- response 的 `page` 包含 `revision`、`total`、`hiddenStopped` 和可选 `nextCursor`；
- 后续页必须原样发送 `nextCursor`；
- 收到 retryable `cursor_stale` 时丢弃已拼接页面并从第一页重新读取；
- 不得把不同 catalog revision 的页面拼成一份结果。

### 生命周期动作

| Snapshot 状态 | Web 可提供的主要动作 |
|---|---|
| `active` | attach、prompt、配置、session 操作、abort、stop |
| `stopping` | 只展示权威状态并等待终态 |
| `stopped` | 展示记录；如需继续其 Pi session，应 adopt 为新的 Dock instance |
| `host_lost` / `runtime_error` 且 `reopenable == true` | 显式 `instance.reopen` |
| `host_lost` / `runtime_error` 且不可 reopen | 展示失败事实；可 forget |

`instance.forget` 和 `catalog.prune` 只删除 Dock catalog record，不删除 Pi session 文件。

### 已支持的 catalog 操作

- `host.info`
- `instance.create`
- `instance.ensure`
- `instance.get_by_key`
- `instance.adopt`
- `instance.list`
- `instance.get`
- `instance.attach`
- `instance.stop`
- `instance.reopen`
- `instance.forget`
- `catalog.prune`
- `session.inventory`

Create、ensure（仅实际创建时）、adopt、reopen 和跨项目 switch 可能先返回 `project_trust_required`。参见“Project trust”。

## Attach、history 与实时事件

### 首次打开

首次打开 conversation 使用 follow attach，且不能带 `since`：

```json
{"kind":"request","version":2,"requestId":"attach-uuid","type":"instance.attach","params":{"instanceId":"instance-id","follow":true,"controller":"observe","replay":"conversation_bootstrap"}}
```

Response 的 `result` 包含：

- `instance`：当前权威 snapshot；
- `page.events`：bootstrap 所需的 bounded events；
- `page.earliest` / `page.latest`：完整 cursor；
- `page.truncated`、`epochChanged`、`generationChanged`；
- `recentHistory`、`historyTruncated`；
- `pendingMessages`；
- `controller` 状态；
- `following: true`。

Attach response 必须先完成处理，随后再处理 event frames。

### Event frame

```json
{"kind":"event","version":2,"requestId":"attach-uuid","hostEpoch":"host-epoch","event":{"scope":"instance","sequence":42,"instanceId":"instance-id","runtimeGeneration":3,"occurredAt":"2026-01-01T00:00:00.000Z","type":"message.delta","data":{"messageId":"message-id","block":"text","delta":"hello"}}}
```

一个 generation 内 `sequence` 必须严格递增。正常 generation rollover 只能是：

- 新 generation 恰好为旧 generation `+1`；
- 第一条 event 是 `session.replaced`；
- `sequence == 1`；
- event data 中的 generation 与 envelope 一致。

### 断线重连

客户端确认接受一条 event 后，保存 cursor：

```json
{
  "hostEpoch": "event envelope hostEpoch",
  "instanceId": "event.instanceId",
  "runtimeGeneration": 3,
  "sequence": 42
}
```

重连使用：

```json
{"kind":"request","version":2,"requestId":"attach-uuid-2","type":"instance.attach","params":{"instanceId":"instance-id","since":{"hostEpoch":"host-epoch","instanceId":"instance-id","runtimeGeneration":3,"sequence":42},"follow":true,"controller":"observe","replay":"event_log"}}
```

遇到以下任一情况，不得假装拥有连续 delta：

- `page.truncated == true`；
- `epochChanged == true`；
- `generationChanged == true`；
- `attach_initial_overflow`；
- stream 因背压、timeout 或 transport error 中断。

此时重新读取 authoritative snapshot，并使用 fresh conversation bootstrap/history 重建页面。观察流断开不表示 runtime 失败，也不会终止 instance。

### 历史分页

`session.history` 每页最多 200 条，使用 `beforeEntryId` 向前分页；response 包含 `entries`、`hasEarlier`、可选 `nextBeforeEntryId` 和 `instance`。`historyTruncated` 只属于 fresh attach 的 bootstrap result。两种 surface 的不完整标记都必须按各自语义处理。

Content block 可能是：

- `text`
- `thinking`
- `image { mimeType }`（仅在协商 `command.images.path.v1` 后出现，不含 bytes/path）
- `tool_call`
- `tool_result`
- `omitted`，表示 image/binary 没有进入控制面；未协商图片能力的旧客户端也用它接收图片 presence 降级

客户端不得依赖 Pi 私有 message shape。

## 命令、Queue 与运行控制

### 提交文本

```json
{"kind":"request","version":2,"requestId":"request-uuid","type":"command.submit","params":{"operationId":"operation-uuid","instanceId":"instance-id","message":"继续处理这个问题","delivery":"auto"}}
```

`delivery`：

- `auto`：由 Host 根据当前状态确定 prompt/steer/follow-up；
- `prompt`：要求启动普通 prompt；运行中会被拒绝；
- `steer`：发送或排入 steering Queue；
- `followUp`：发送或排入 follow-up Queue。

Success receipt 返回实际 delivery、是否 queued、accepted time 和原 operation ID。

### 提交本机图片

图片输入必须在 hello 中协商 `command.images.path.v1`。每个 descriptor 是 closed `{path, mimeType}`；`path` 是 Host/Worker 同一 UID 可访问的绝对本机路径，`mimeType` 是 bounded `image/*`。一条 mutation 最多 10 张，单张最多 20 MiB、合计最多 80 MiB。支持图片-only消息：`message` 可为空，但 `images` 不可同时为空。

```json
{"kind":"request","version":2,"requestId":"image-request","type":"command.submit","params":{"operationId":"image-operation","instanceId":"instance-id","message":"比较这两张图","delivery":"auto","images":[{"path":"/srv/alubot/uploads/a.webp","mimeType":"image/webp"},{"path":"/srv/alubot/uploads/b.custom","mimeType":"image/x-project-preview"}]}}
```

文本与所有图片共享同一个 `operationId`；同一 ID 配不同路径或 MIME 会 `operation_conflict`。Host Queue 的 `message.queued`、fresh attach 的 `pendingMessages`、`queue.dequeue` 与 `message.submitted` 会为图片-capable客户端原样保留 descriptor，因此相同文字/不同图片不会混合。示例 queued surface：

```json
{"type":"message.queued","data":{"queueItemId":"queue-1","operationId":"image-operation","delivery":"steer","text":"比较这两张图","images":[{"path":"/srv/alubot/uploads/a.webp","mimeType":"image/webp"}],"acceptedAt":"2026-01-01T00:00:00.000Z"}}
```

只有 Worker 在真正消费/dispatch 前打开 regular file 并编码为 Pi public structural image content；Protocol V2、Worker event/history、catalog 都不携带 bytes、base64 或 data URI。调用方必须保持文件内容稳定、同 UID 可读，直到 Queue item 被消费或 dequeue；路径只在当前 Host generation 的 custody/projection 中存在，不进 catalog。Host loss/replacement 后不会恢复路径或重放 Queue。历史只能保证图片 presence/MIME，不能保证原路径或媒体仍可恢复。

### `show_image` live/history 关联

不新增专用事件。Live client 按 `toolCallId` 合并 `tool.started` 与可选 `tool.args_updated`，取得最后的 `args.path`，并且只在同 ID/name 的 `tool.completed.isError == false` 后授权展示：

```json
{"type":"tool.started","data":{"toolCallId":"call-7","toolName":"show_image","args":{"path":"/tmp/result.png"}}}
{"type":"tool.completed","data":{"toolCallId":"call-7","toolName":"show_image","text":"shown","isError":false}}
```

History 使用同一关联规则；call/result 可能跨分页：

```json
{"entryId":"h-call","role":"assistant","content":[{"type":"tool_call","toolCallId":"call-7","toolName":"show_image","args":{"path":"/tmp/result.png"}}]}
{"entryId":"h-result","role":"tool","content":[{"type":"tool_result","toolCallId":"call-7","toolName":"show_image","text":"shown","isError":false}]}
```

缺少 path、result 为 error、history 尚未分页完整时都不得授权，也不得读取 Pi 私有 JSONL。

### 已支持的运行控制

- `command.abort`：中止当前 run；
- `queue.dequeue`：取回 Host Queue 中尚未消费的消息；
- attach snapshot/event：观察 Queue 计数和具体 pending messages。

当前没有 arbitrary PTY、直接 shell RPC 或独立 bash 控制 endpoint。Web 可以提交 Pi/extension command，但 Alu Dock 不把自己变成远程 shell 服务。

## Model、tools、settings 与资源

已支持：

- `model.list` / `model.set`
- `thinking.set`
- `tool.list` / `tool.set_active`
- `settings.get` / `settings.update`
- `resource.get`
- `command.catalog`

读取 collection 时应协商 `projection.completeness.v1`，并展示 `total` / `truncated`。不要把 truncated collection 当成完整结果。

Snapshot 的整个 `metrics` projection 都可能不存在。存在时包含：

- user/assistant/tool message counts；
- input/output/cache/total tokens；
- cost；
- 可选的 context object，其中 tokens 和 percent 还可能为空。

## Session 与 Tree

已支持：

- `session.list`
- `session.switch`
- `session.new`
- `session.name`
- `session.compact`
- `session.reload`
- `session.tree`
- `session.navigate`
- `session.fork`
- `session.clone`

Session replacement 会保留 Dock instance identity，并通过 `session.replaced` 公布新 generation。不要在 Web 中把它实现成新的 Dock instance，除非使用的是 `instance.adopt` 创建独立工作。

## Extension UI

### Controller lease

Attach 使用 `controller: "claim"` 时，成功 response 可能返回：

```json
{"status":"acquired","leaseToken":"lease-token","controllerId":"controller-routing-id"}
```

也可能返回 `observing` 或 `unavailable`。每个 instance 同时只有一个 interaction controller；其他连接仍可观察事件。

`leaseToken` 是唯一 authority credential，只保留在 Web 后端，不应发送给浏览器。`controllerId` 是独立生成的非授权 routing identity，只用于把 ephemeral controller directive 匹配到当前 lease；不能用它调用 `interaction.respond` 或 viewport control。浏览器提交的 select/confirm/input/editor 回复由 Rails 鉴权后映射为 `interaction.respond`。

`extension.widget_viewport.set` 不是交互回复，而是 ephemeral viewport-size control。它发送 `instanceId`、`leaseToken`、`expectedRuntimeGeneration`、`width` 和 `height`，没有 `operationId`，也不进入 operation ledger 或 mutation ambiguity 处理。

Controller stream 断开只释放该 transport lease，**不会**回答、拒绝或取消尚未完成的 interaction。无 controller、SSH/ActionCable 断线、Rails 重启和浏览器重连期间，interaction 仍属于原 runtime generation，Worker 中对应的 Pi UI Promise 与当前模型/tool boundary 继续保持 pending。只有真实的 `interaction.respond`、extension 明确提供的 `AbortSignal`/timeout、generation replacement、instance stop 或 Host drain 才能结束它；其中 replacement/stop/Host drain 会终止旧 runtime work 并让 UI bridge 以 lifecycle error 失败，不会向 extension 返回伪造的 `false`/`undefined`。

能处理该语义的客户端必须在 hello 中协商 `extension_ui.persistent-interactions.v1`；没有该 capability 的连接不能 claim controller，Host 也不会向它投影 persistent interaction 状态。新 controller claim 成功后，Host 会把当前 pending interaction 的完整原始 `interaction.requested` 重新加入 attach 初始 `page.events`，interaction ID 保持不变。客户端必须处理初始页而不只监听后续 live frames，并按 interaction ID 幂等地恢复同一个弹窗。

无 extension 明确 timeout 的请求不包含 `expiresAt`，表示没有绝对期限：

```json
{"type":"interaction.requested","data":{"interactionId":"interaction-id","method":"confirm","title":"Approve command","message":"Allow this operation?","issuedAt":"2026-01-01T00:00:00.000Z"}}
```

只有 extension 明确要求 timeout 时才带 `expiresAt`。基础设施断线不得合成 `{cancelled:true}`、`false` 或 `undefined`。若 Web 无法恢复弹窗，应停止/冻结当前 run 并向用户展示诊断，绝不能让模型在无人决定时继续。

`interaction.respond` 是有 operation ID 的 mutation。Host 成功确认时，result 为 `{"interactionId":"…","state":"resolved"}`；同一 lease 对同一 interaction 重复提交完全相同的 response 时可返回 `state: "already_resolved"`。两者都表示 Host 已确认该答案，Web 此时才能关闭弹窗；其他 error 或连接断开都不是确认。

响应传输失败时，不要假定用户答案已经生效，也不要自动生成新 operation 重发：先用 `instance.get` 查看 `activeInteraction.id`，必要时重新 claim/attach。若相同 ID 仍 pending，重新呈现原问题；若已消失，以 Host 的 `interaction.resolved`/snapshot 为准。

### 支持的交互与投影

- select
- confirm
- input
- editor
- extension notification
- extension status
- 当前 controller 的 terminal title / editor text 单向 directive
- terminal-rendered text widget lines
- tools-expanded state

协商 `extension_ui.controller-directives.v1` 的 controller stream 可收到以下 closed one-way events；Host 只向拥有完全匹配 `controllerId` 的 stream 投递，observer、旧 client 和其他 lease 不会收到 payload：

```json
{"kind":"event","version":2,"requestId":"attach-uuid","hostEpoch":"host-epoch","event":{"scope":"instance","sequence":43,"instanceId":"instance-id","runtimeGeneration":3,"occurredAt":"2026-01-01T00:00:01.000Z","type":"extension.title_set","data":{"controllerId":"controller-routing-id","title":"Review queue"}}}
{"kind":"event","version":2,"requestId":"attach-uuid","hostEpoch":"host-epoch","event":{"scope":"instance","sequence":44,"instanceId":"instance-id","runtimeGeneration":3,"occurredAt":"2026-01-01T00:00:02.000Z","type":"extension.editor_text_set","data":{"controllerId":"controller-routing-id","text":"Draft from extension\nSecond line"}}}
```

两者不进入 snapshot，不为新 lease/generation replay；无 controller 或 replacement suspension 期间的调用直接丢弃。`getEditorText` 仍不支持。Pi component object、callback、Promise 和任意 binary 不会跨过 Protocol V2。

## Mutation 与 operation identity

所有进入 Host operation ledger 的 mutation 都由调用方生成独立 `operationId`。它与 transport `requestId` 不同。Ephemeral `extension.widget_viewport.set` 是例外：它没有 operation ID，也不具有 ledger dedup/ambiguity 语义。

规则：

1. 一个新的用户意图使用一个新的 operation ID。
2. 相同 Host epoch 内，相同 ID 和相同 mutation 会共享 in-flight/settled receipt。
3. 相同 ID 配不同参数或不同 mutation 会返回 `operation_conflict`。
4. 旧 receipt 淘汰后返回 `operation_receipt_expired`，Host 不会再次执行该 ID。
5. mutation 发送后的 timeout、断连或非法 response 必须显示为 outcome unknown，并保留原 operation ID。
6. 不自动重试 mutation，尤其不能在 `hostEpoch` 已变化后重放。
7. 使用 `instance.get`、history 和 events 查询当前权威事实；无法确定时保留“结果未知”，不要把它改写成失败。

`runtime_unavailable` 表示 Worker 在取得 mutation effect custody 前丢失；`effect_unknown` 表示 effect 可能已经发生。这两个结果不能合并。

当前没有独立 `operation.get` endpoint。只有实际 Web 流程证明 snapshot/event 无法完成必要 reconciliation 时，才应考虑由 Dock 增加 outcome query。

## Project trust

Create、ensure（仅实际创建时）、adopt、reopen 或跨项目 switch 可能返回：

```json
{
  "code": "project_trust_required",
  "details": {
    "challengeId": "challenge-id",
    "operationId": "operation-uuid",
    "cwd": "/canonical/project",
    "choices": [
      "trust_once",
      "trust_and_remember",
      "deny_once",
      "deny_and_remember"
    ],
    "expiresAt": "2026-01-01T00:05:00.000Z"
  }
}
```

用户选择后，重复原 mutation 的类型、operation ID、目标参数，并增加 `trustChallengeId` 和 `projectTrustDecision`。Challenge 与原操作及 canonical cwd 绑定，过期或改变参数会被拒绝。

`deny_*` 的含义是继续构造一个不信任 project resources 的 runtime，不是取消本次操作。取消应由 Web 自己停止提交第二次 request。

## Capability 速查

所有现代 request 都应协商 `core.v2` 和对应 operation capability：

| Request | Capability |
|---|---|
| `host.info` | `host.info` |
| `instance.create/list/get/stop` | `instance.catalog` |
| `instance.ensure`、`instance.get_by_key`、snapshot `key` | `instance.keys.v1` |
| `instance.attach` | `events.follow` |
| 带 `replay` 的 attach | 再加 `events.replay-purpose.v1` |
| `instance.adopt` | `session.adopt.v1` |
| `instance.reopen` | `session.reopen` |
| `instance.forget`, `catalog.prune` | `catalog.maintenance.v1` |
| `command.submit`, `session.list` | `session.core`；带图片再要求 `command.images.path.v1` |
| `command.abort` | `run.abort.v1` |
| `queue.dequeue` | `queue.control.v1` |
| `model.*`, `thinking.set` | `models.v1` |
| `tool.*` | `tools.v1` |
| `settings.*` | `settings.v1` |
| `resource.get`, `command.catalog` | `resources.v1` |
| `session.history` | `tui.projection.v1` |
| `session.inventory` | `session.inventory.v1` |
| `session.switch/new/name/compact/reload` | `session.commands.v1` |
| `session.tree/navigate/fork/clone` | `session.tree.v1` |
| controller claim、persistent interaction 投影 | `extension_ui.persistent-interactions.v1`（另需 `events.follow`） |
| `interaction.respond` | `extension_ui.v1` + `extension_ui.persistent-interactions.v1` |
| controller title/editor directives | `extension_ui.controller-directives.v1`（另需 controller claim） |
| tools-expanded control | `extension_ui.tools-expanded.v1` |
| widget projection/viewport | `extension_ui.widgets.v1` |

推荐同时按需协商：

- `projection.completeness.v1`
- `session.inventory-diagnostics.v1`
- `git.branch-footer.v1`
- `tool-result-presentation.v1`

Capability 会改变 closed response/event shape：

- 未协商 `instance.keys.v1` 时，Host 从 snapshot 省略 `key`，旧客户端仍按普通 instance 工作；
- 未协商 `extension_ui.persistent-interactions.v1` 时，Host 省略 snapshot 的 `activeInteraction` 并过滤 interaction events；这类连接不能 claim controller 或发送 `interaction.respond`；
- 未协商 `extension_ui.controller-directives.v1` 时，Host 从 acquired controller shape 省略 `controllerId`，并过滤 title/editor directive events；即使协商，非匹配 controller stream 仍被过滤；
- 未协商 `extension_ui.tools-expanded.v1` 时，Host 省略 snapshot 的 `toolsExpanded` 并过滤对应 change event；
- 未协商 `extension_ui.widgets.v1` 时，Host 过滤 widget change events；
- 未协商 `git.branch-footer.v1` 时，Host 省略 snapshot/replacement 的 `gitBranch` 并过滤 branch event；
- 未协商 `tool-result-presentation.v1` 时，Host 省略 tool result 的 typed `presentation`；
- 未协商 `command.images.path.v1` 时，Host 省略 pending/submitted 的 `images` path fields，并把 canonical image block 降级为既有 `omitted/image`；event sequence 不改变；
- 未协商 `projection.completeness.v1` 时，部分 collection response 省略 `total` / `truncated`；
- 未协商 `session.inventory-diagnostics.v1` 时，inventory response 省略 `incomplete`、diagnostics 和 diagnostic truncation；
- 被 capability 过滤的 event 仍占用原始 sequence，因此客户端只要求 sequence 严格递增，不能要求连续。

严格 Ruby schema 必须按当前连接协商的 capability 选择对应 projection shape。不要在 capability negotiation 失败后降级重发 mutation。

## 常见错误处理

| Code | 客户端含义 |
|---|---|
| `capability_missing` / `protocol_incompatible` | 停止该功能，不发送 mutation |
| `not_found` | instance 不存在 |
| `instance_not_active` / `instance_not_reopenable` | 当前 lifecycle 不允许动作 |
| `instance_busy` / `admission_pending` | 显示权威忙碌状态；不要盲目循环请求 |
| `invalid_delivery` | 当前运行状态不接受指定 delivery |
| `queue_capacity` | Queue 已达边界 |
| `cursor_stale` | 丢弃 catalog 分页并从第一页重读 |
| `invalid_cursor` | 放弃增量并重新 bootstrap |
| `project_trust_required` | 走显式 trust 决策流程 |
| `effect_unknown` | 查询权威状态；绝不自动重放 |
| `runtime_unavailable` | mutation 未取得 effect custody，可由用户基于新状态决定下一步 |
| `operation_conflict` | operation ID 被用于不同意图，是调用方错误 |
| `operation_receipt_expired` | 该 ID 不可再次执行；查询当前状态 |
| `mutation_faulted` / `host_draining` | Host 不再接受 mutation，等待人工处理/service 恢复 |

Error code 是可扩展字符串。未知 code 应作为普通明确失败展示；只有明确属于 transport-after-send 的 mutation failure 才能由客户端提升为 outcome unknown。

## 当前没有提供的能力

以下不是 Protocol V2 当前承诺：

- Browser 直连 Dock；
- Redis/Pi RPC 兼容；
- 多用户、跨 UID、容器或远程认证；
- arbitrary PTY / shell RPC；
- binary、base64 或 data URI 穿过控制面；
- catalog-wide 实时事件流；
- stopped/host-lost record 在不恢复 runtime 时的完整 conversation 浏览；
- 独立 operation outcome 查询；
- 通过 Protocol V2 管理 systemd service。

图片输入现已由 `command.images.path.v1` 提供；Rails 继续拥有上传、StudioImage、图库、文件生命周期和浏览器图片响应。

其余能力只有被 Web 的真实产品需求证明需要、且权威数据确实属于 Host/runtime 边界时，才在 Alu Dock 增加：

1. **Catalog 实时更新**：只有轮询无法满足体验时，再增加 Host-owned catalog revision stream；conversation events 仍保持 instance-scoped。
2. **Operation outcome 查询**：只有 snapshot/event reconciliation 无法满足真实流程时再增加。
3. **跨用户/远程访问**：需要单独设计认证与授权 transport，不能放宽当前 socket 权限。

## Alu Dock 侧接入合同

Card #216 已固定本文所示的 hello、业务 key ensure、instance list、fresh attach、cursor reconnect、Queue、图片、interaction、controller directive 与 ambiguous mutation 规则。Dock 不解释 `alu` 等 key 的业务含义；Alubot Admin 可用 `instance.ensure` 在 Alu Workstation cwd 首次创建并稳定取得唯一工作台，普通 New Work 仍创建无 key 的并行 instance。Extension title 更新和 editor text 注入通过独立 capability 只到达当前 controller client；图片 prompt/steer/follow-up/Queue、用户图片 metadata、`show_image` live/history 关联和 `stale_runtime_generation` details 也不再需要 Rails 猜测或读取 Pi 私有协议。

Alubot Admin 接入当前版本时还必须：

1. hello 增加 required capability `extension_ui.persistent-interactions.v1`；
2. controller attach 的初始 `page.events` 与后续 live frames 使用同一套 interaction handler；
3. 将 `interaction.requested.data.expiresAt` 解析为可选字段，缺省时不得启动本地倒计时；
4. controller socket/ActionCable/browser 断开时只丢弃本地 lease，不向 Dock 发送取消或默认答案；
5. 新 lease 收到相同 interaction ID 时恢复/替换原弹窗，不创建第二个业务确认；
6. `interaction.respond` 传输结果不确定时先查询 `activeInteraction`，不自动重放 mutation。

不增加独立 `abort_bash`；当前需求只保留整轮 abort。Alu Dock 侧接入能力已具备，Rails/WebConsole 的正式切换继续由 Card #183 推进。

## 权威代码入口

- Request、response、capability、bounds 与 wire parser：`src/control/protocol.ts`
- Host routing 与 attach stream：`src/control/dock-host.ts`
- TypeScript 参考客户端：`src/control/dock-client.ts`
- Snapshot、history、event 与 cursor DTO：`src/core/instance-dto.ts`
- Model/tool/settings/resource DTO：`src/core/config-projection.ts`
- Socket 路径：`src/control/socket-path.ts`
- Protocol/Host 集成证据：`test/control-protocol.test.ts`、`test/dock-control.test.ts`
