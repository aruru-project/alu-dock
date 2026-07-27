# Web 客户端接入 Protocol V2

本文描述 Rails 等本机 Web 后端如何接入 Alu Dock。浏览器不直接连接 Dock。

```text
Browser
   │ HTTP / WebSocket
   ▼
Web backend
   │ Protocol V2 · private Unix socket
   ▼
Dock Host Service
   │
Agent Worker
```

Web backend 负责浏览器鉴权、HTTP/WebSocket、上传、页面状态和用户可见反馈。Dock 负责 instance、Agent session、operation、Queue、Extension UI 操作权和 Worker lifecycle。Web 不读取 Agent 私有 session 文件，也不接触 Worker IPC 或 runtime object。

## 连接

Protocol V2 使用本机 Unix stream socket 和 UTF-8 JSONL。每个连接：

1. 发送 hello，协商版本与 capabilities；
2. hello 成功后发送一个业务 request；
3. 普通 request 收到一个 response 后结束；
4. `instance.follow` 和 `interaction.control` 在初始 response 后继续接收 event。

读取、实时跟随和 Extension UI 操作是三条独立连接。不要在一个连接发送多个业务 request，也不要把三种用途重新合成一条连接。

示例 hello：

```json
{"kind":"hello","requestId":"hello-id","versions":[2],"client":{"name":"web-client","version":"1.0.0","clientId":"process-id"},"requiredCapabilities":["core.v2","host.info"]}
```

示例 request：

```json
{"kind":"request","version":2,"requestId":"request-id","type":"host.info","params":{}}
```

客户端必须校验 response 的 request ID、Protocol version 和 Host epoch。单条 JSONL 有 frame 上限；大型 conversation 使用分页和 chunk，不把 frame 上限当成内容上限。

Wire shape、capability 名称和 bounds 的代码真相在：

- `src/control/protocol.ts`
- `src/control/dock-client.ts`

当前读取、跟随和操作连接分别使用：

- `instance.read` / `instance.read.v1`
- `instance.follow` / `events.follow.v2`
- `interaction.control` / `extension_ui.control.v1`

`events.follow.v2` 依赖 `instance.read.v1`。Extension UI 回答还需要 `extension_ui.v1` 和 `extension_ui.persistent-interactions.v1`。其他 snapshot、图片和客户端投影能力继续按实际页面需要协商。

## 身份

Web 需要区分：

- `hostEpoch`：当前 Host 进程；
- `instanceId`：Dock 工作实例；
- optional instance key：业务入口到 instance 的稳定映射；
- Agent session identity：当前 Worker 内的原生 session；
- `runtimeGeneration`：instance 内的 runtime/session generation；
- `operationId`：一次 mutation 意图；
- event cursor：read/follow 与 reconnect 的事件位置。

不要用 instance name、cwd、Agent session ID 或文件路径替代 `instanceId`。

## 常用流程

1. `host.info` 检查 Host 与 capabilities；
2. 用 instance key 查询/确保固定业务工作台，或使用 instance catalog；
3. 首次打开时发送 `instance.read`，使用 `replay: "conversation_bootstrap"`；
4. 先用 read response 中的 snapshot、bootstrap、Queue 和 `page.events` 建立页面；
5. 以 read response 的 `page.latest` 作为 `since` 发送 `instance.follow`；
6. 先处理 follow response 的 `page.events`，再按顺序消费同一连接后续的 live event；
7. 每接受一个事件就保存它对应的 cursor；
8. 只有需要操作 Extension UI 时，另开 `interaction.control` 连接。

首次读取请求：

```json
{"kind":"request","version":2,"requestId":"read-id","type":"instance.read","params":{"instanceId":"instance-id","replay":"conversation_bootstrap"}}
```

Read result 包含 `instance`、`page`、`recentHistory`、`historyTruncated` 和 `pendingMessages`。它是普通 response，不在该连接继续推送 event。

实时跟随请求中的 `since` 必须是完整 cursor：

```json
{"kind":"request","version":2,"requestId":"follow-id","type":"instance.follow","params":{"instanceId":"instance-id","since":{"hostEpoch":"host-epoch","instanceId":"instance-id","runtimeGeneration":3,"sequence":42}}}
```

Follow result 只包含 `page`。Read 和 follow 之间发生的事件会出现在这个初始 event page 中，处理完后再消费后续 event frame。

重连时先用最后接受的 cursor 和 `replay: "event_log"` 执行 `instance.read`，再从新的 `page.latest` follow；若 `truncated`、`epochChanged` 或 `generationChanged` 表明无法连续恢复，则重新读取 snapshot 与 conversation bootstrap。

Read、follow 或 Extension UI 操作连接断开都不表示 runtime 失败，也不停止 instance。

## Instance 与 Agent session

Host control 提供 instance create、ensure、list、get/get-by-key、read、follow、stop、reopen、adopt、forget、catalog prune 和 persisted-session inventory。

Agent session 能力包括 prompt、abort、Queue、conversation、model、thinking、tools、settings、resources、session replacement、tree、compaction 和 Extension UI。具体可用能力以 hello capability negotiation 为准。

Agent session replacement 保留 `instanceId`，但会推进 `runtimeGeneration`。旧 generation 的 event、cursor 和 interaction response 不能继续使用。

## Mutation

每个新的 mutation 意图使用新的 `operationId`。相同 Host epoch 内，重复 ID 只能表示同一意图；不能把同一个 ID 用于不同参数。

Mutation 发送后发生 timeout、断线或 correlation error 时，结果可能未知。客户端不能自动生成新 operation 重放，应先查询 instance、conversation 和 events。Worker 接受副作用前失联与接受后失联会返回不同错误；`effect_unknown` 表示副作用可能已经发生。

## Conversation

`instance.read` 的 conversation bootstrap 和普通 history 可以提供快速 preview；完整内容通过 conversation history/content 分页读取。Entry 的 `contentRef` 用于继续读取 text、thinking、tool call/result 和 structured image block。

Client 必须保持同一次读取的 revision、content ref、instance 和 generation 一致。Session、branch 或 generation 变化后，旧 cursor/ref 失效并重新开始。

Data URI、base64 和长文本都是普通内容。客户端根据结构处理 image block，不从普通文本猜测内容类型。

## 图片

图片 prompt 使用 Host/Worker 同一 UID 可读取的本机绝对路径 descriptor。文件上传、图库、缩略图和浏览器响应由 Web 应用负责。

进入 Agent session 后，structured image content 通过 conversation content 分页恢复。`show_image` 使用既有 tool call/result 和 `toolCallId + args.path` 关联，不需要额外的 Dock media 协议。

## Extension UI

只读的 `instance.read` 和 `instance.follow` 不取得 Extension UI 操作权。Web 只有在确实准备处理 interaction 时才另开 `interaction.control` 连接。

操作连接请求：

```json
{"kind":"request","version":2,"requestId":"control-id","type":"interaction.control","params":{"instanceId":"instance-id"}}
```

`interaction.control` 的初始 response 只包含 `instanceId`、`runtimeGeneration`、`leaseToken` 和 `controllerId`，不包含 snapshot 或 event page。随后同一连接接收定向的 `interaction.requested`、title 和 editor text event。`leaseToken` 只保留在 Web 后端；`controllerId` 只用于核对定向 event，不是回答凭证。

新的操作连接会立即接替旧操作连接，但不会关闭任何普通 follow。若已有问题等待回答，Host 会把同一个 `interactionId` 重新发送给新连接；Web 应恢复原交互界面，而不是创建第二个业务问题。操作连接断开只释放操作权，不回答或取消 pending interaction。

Web 使用当前 `leaseToken + interactionId` 发送 `interaction.respond`。只有 Host 明确确认 response 后，Web 才能关闭交互界面；传输结果未知时先重新查询权威状态，不自动重发。

Web 可以只实现自己需要的 Extension UI capability。未实现的 custom surface 不影响 Worker、Pi extension 或 SSH Work TUI，也不能返回假的默认答案。

## Project trust

Create、实际创建新 instance 的 ensure、adopt、reopen 或跨项目 session 操作可能要求显式 project trust decision。Challenge 与原 operation 和 canonical cwd 绑定；客户端应把用户选择作为原 mutation 的明确继续步骤，不自行猜测信任结果。

## 页面反馈

Protocol 字段和错误码只用于 Web 后端关联状态。页面不得直接显示 admission、projection、controller、lease、cursor、generation、mutation、UUID、异常类名等内部信息；应说明发生了什么、用户现在能做什么。任何操作超过一秒没有结果，都要显示仍在处理或正在恢复连接。

## 当前边界

Protocol V2 不提供：

- Browser 直连 Dock；
- 多用户或跨 UID 认证；
- arbitrary PTY / remote shell；
- Redis/Pi RPC compatibility；
- 隐式 service install、start 或 restart。

新增 Web 能力应来自真实产品需要。某项 Web UI 未实现，只是该客户端的 backlog，不应要求 Host、Worker 或其他客户端降级。
