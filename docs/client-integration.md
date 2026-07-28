# Client 接入 Protocol V2

本文说明客户端怎样接入 Alu Dock。这里的客户端不特指 Web：它可以是 TUI、Web backend、桌面程序或其他本机进程。只要遵守 Protocol V2，它们使用的是同一套 instance、conversation、event 和 operation 语义。

浏览器不能直接连接 Dock。Web 应用需要由本机后端代为连接：

```text
Browser ── HTTP / WebSocket ── Web backend ─┐
TUI / desktop / other local client ─────────┼── Protocol V2 · private Unix socket
                                             ▼
                                      Dock Host Service
                                             │
                                         Agent Worker
```

客户端负责自己的界面、鉴权、上传、本地显示状态和用户反馈。Dock 负责 instance、Agent session、operation、Queue、Extension UI 操作权和 Worker lifecycle。客户端不读取 Agent 私有 session 文件，也不接触 Worker IPC 或 runtime object。

## 连接方式

Protocol V2 使用本机 Unix stream socket 和 UTF-8 JSONL。每个连接的流程是：

1. 发送 hello，协商版本和 capabilities；
2. hello 成功后发送一个业务 request；
3. 普通 request 收到一个 response 后结束；
4. `instance.follow` 和 `interaction.control` 在初始 response 后继续接收 event。

读取、实时跟随和 Extension UI 操作使用三条独立连接。不要在一条连接上发送多个业务 request，也不要把这三种用途重新合成一条长连接。

示例 hello：

```json
{"kind":"hello","requestId":"hello-id","versions":[2],"client":{"name":"my-client","version":"1.0.0","clientId":"process-id"},"requiredCapabilities":["core.v2","host.info"]}
```

示例 request：

```json
{"kind":"request","version":2,"requestId":"request-id","type":"host.info","params":{}}
```

客户端必须校验 response 的 request ID、Protocol version、Host epoch 和自己使用的已知字段。Client→Host 的 hello/request 是 closed shape；Host→Client 的 response/event 可以增加未知可选字段，客户端应忽略它们，而不是让连接失败。字段删除、既有字段类型或语义改变、以及未知 event type 仍是不兼容变化。单条 JSONL 有 frame 上限；大型 conversation 通过分页和 chunk 传输，不能把 frame 上限误当成内容上限。

Wire shape、capability 名称和 bounds 的代码真相在：

- `src/control/protocol.ts`
- `src/control/dock-client.ts`

当前读取、跟随和操作连接分别使用：

- `instance.read` / `instance.read.v1`
- `instance.follow` / `events.follow.v2`
- `interaction.control` / `extension_ui.control.v1`

`events.follow.v2` 依赖 `instance.read.v1`。回答 Extension UI 还需要 `extension_ui.v1` 和 `extension_ui.persistent-interactions.v1`。Snapshot、图片和其他投影能力按客户端实际需要协商，不要宣称自己支持尚未实现的 capability。

## 需要分清的身份

客户端会同时看到几种不同的身份：

- `hostEpoch`：当前 Host 进程；
- `instanceId`：一个 Dock 工作实例；
- optional instance key：业务入口到 instance 的稳定映射；
- Agent session identity：当前 Worker 内的原生 session；
- `runtimeGeneration`：instance 内当前 runtime/session generation；
- `operationId`：一次 mutation 意图；
- event cursor：read/follow 和重连的位置。

不要用 instance name、cwd、Agent session ID 或文件路径代替 `instanceId`。

## 建立并跟随一个 Work

常见流程如下：

1. 调用 `host.info`，确认 Host 和 capabilities；
2. 通过 instance key 查询或确保固定业务 Work，也可以使用 instance catalog；
3. 第一次打开时调用 `instance.read`，并使用 `replay: "conversation_bootstrap"`；
4. 用 read response 中的 snapshot、history、Queue 和 `page.events` 建立本地画面；
5. 使用 read response 的 `page.latest` 作为 `since`，调用 `instance.follow`；
6. 先处理 follow 初始 response 里的 `page.events`，再顺序消费同一连接上的 live event；
7. 每接受一个事件，都保存它对应的 cursor；
8. 只有客户端准备实际处理 Extension UI 时，才另开 `interaction.control` 连接。

首次读取示例：

```json
{"kind":"request","version":2,"requestId":"read-id","type":"instance.read","params":{"instanceId":"instance-id","replay":"conversation_bootstrap"}}
```

Read result 包含 `instance`、`page`、`recentHistory`、`historyRevision`、`historyTruncated` 和 `pendingMessages`。它是普通 response，不会在这条连接上继续推送事件。

`recentHistory` 是当前 branch 的 canonical persisted records。Conversation bootstrap 的 `page.events` 只包含尚未被 persistence checkpoint 覆盖的 active message/tool frames，以及当前仍有效的 interaction；它不是一份“最近 event log”。客户端应先投影 persisted records，再按 sequence 应用 active frames。

实时跟随请求中的 `since` 必须是完整 cursor：

```json
{"kind":"request","version":2,"requestId":"follow-id","type":"instance.follow","params":{"instanceId":"instance-id","since":{"hostEpoch":"host-epoch","instanceId":"instance-id","runtimeGeneration":3,"sequence":42}}}
```

Follow result 只包含 `page`。Read 和 follow 之间发生的事件会出现在 follow 的初始 event page 中；处理完这页以后，再消费后续 live event。

## 断线与重建

如果客户端仍保有完整的本地 conversation，就用最后接受的 cursor 和 `replay: "event_log"` 再做一次 `instance.read`，然后从新的 `page.latest` 继续 follow。这条连续重连路径只补事件，不能重新应用 history。

出现以下任一情况时，本地画面已经不能安全续接：

- `truncated` 表示 event ring 不再覆盖所需范围；
- `epochChanged` 表示 Host 已改变；
- `generationChanged` 表示 runtime/session generation 已改变；
- 客户端进程、页面或本地状态已经丢失原 conversation。

此时应清空旧 conversation，重新读取 snapshot 和 conversation bootstrap。不要拿旧画面、一次较新的 latest history page 和一次较早的 seed 拼成“看似完整”的会话。

一次 history scan 必须始终使用同一个 `historyRevision`。`instance.read` seed 和后续 `session.history` page 的 revision 不一致时，放弃整次 scan 并重新 bootstrap。

Event overlap 只按完整事件身份（`runtimeGeneration + sequence`）处理。不得按 role、text、thinking、tool arguments/result、custom details 或它们的 hash 合并；完全相同的内容也可能是两次真实发生的事实。

客户端不发送 conversation ACK。页面刷新、进程重启或本地状态丢失时，直接重新 bootstrap。Read、follow 或 Extension UI 操作连接断开，都不表示 Agent runtime 失败，也不会停止 instance。

## Instance 与 Agent session

Host control 提供 instance create、ensure、list、get/get-by-key、read、follow、stop、reopen、adopt、forget、catalog prune 和 persisted-session inventory。

Agent session 能力包括 prompt、abort、Queue、conversation、model、thinking、tools、settings、resources、session replacement、tree、compaction 和 Extension UI。实际可用能力以 hello capability negotiation 为准。

Agent session replacement 会保留 `instanceId`，但推进 `runtimeGeneration`。旧 generation 的 event、cursor 和 interaction response 不能继续使用。

## Mutation

每个新的 mutation 意图都使用新的 `operationId`。在同一个 Host epoch 中，重复 ID 只能表示同一个意图，不能换一组参数继续使用。

Mutation 发出后如果发生 timeout、断线或 correlation error，结果可能未知。客户端不能自动生成新的 operation 并重放；应先查询 instance、conversation 和 events。Worker 在接受副作用之前失联，与接受之后失联，会得到不同错误。`effect_unknown` 明确表示副作用可能已经发生。

## Conversation

`instance.read` 的 conversation bootstrap 和普通 history 提供有界 preview。完整内容通过 conversation history/content 分页读取。

每个 persisted record 使用：

- `recordId`
- 原生或 Worker 合成的稳定 `entryId`
- `kind`
- `source`
- `visibility`
- `content`
- 可选 metadata

客户端应按这些结构处理 `message`、`custom_message`、`bash_execution`、`compaction_summary`、`branch_summary` 和 metadata records，不要从 system text 反推 Agent 私有 role。Entry 的 `contentRef` 用于继续读取 text、thinking、tool call/result 和 structured image block。

Live `messageId` / `toolCallId` 只属于当前 event lifecycle。客户端不需要，也不应尝试把它们认领成 persisted `recordId` / `entryId`。在线 completion 原位收尾并留在本地画面；只有 fresh rebuild 才从 persisted records 重新生成组件。

客户端必须保持同一次读取的 revision、content ref、instance 和 generation 一致。Session、branch 或 generation 改变后，旧 cursor/ref 失效，应重新开始读取。

Data URI、base64 和长文本都是普通内容。客户端根据结构处理 image block，不从普通文本猜测内容类型。

## 图片

图片 prompt 使用 Host 和 Worker 同一 UID 能读取的本机绝对路径 descriptor。上传、图库、缩略图和远端传输属于客户端平台自己的职责。

进入 Agent session 后，structured image content 通过 conversation content 分页恢复。`show_image` 使用已有的 tool call/result 和 `toolCallId + args.path` 关联，不需要新增 Dock media 协议。

Web 应用通常由后端接收浏览器上传、保存为受控本机文件，再向 Dock 提交 path descriptor；浏览器本身不能把自己的文件路径交给 Dock。

## Extension UI

只读的 `instance.read` 和 `instance.follow` 不取得 Extension UI 操作权。客户端只有在确实准备处理 interaction 时，才另开 `interaction.control` 连接。

请求示例：

```json
{"kind":"request","version":2,"requestId":"control-id","type":"interaction.control","params":{"instanceId":"instance-id"}}
```

`interaction.control` 的初始 response 只包含 `instanceId`、`runtimeGeneration`、`leaseToken` 和 `controllerId`，不包含 snapshot 或 event page。随后，同一连接接收定向的 `interaction.requested`、title 和 editor text event。

`leaseToken` 是回答凭证，应只留在负责操作的 client process；Web 场景中只留在后端。`controllerId` 用来核对定向 event，不是回答凭证。

新的操作连接会立即接替旧连接，但不会关闭普通 follow。若已有问题等待回答，Host 会把同一个 `interactionId` 重新发送给新连接。客户端应恢复原来的交互，而不是创建第二个业务问题。操作连接断开只释放操作权，不回答也不取消 pending interaction。

客户端使用当前 `leaseToken + interactionId` 发送 `interaction.respond`。只有 Host 明确确认 response 后，才能关闭交互状态；传输结果未知时先重新查询权威状态，不自动重发。

客户端可以只实现自己真正支持的 Extension UI capability。没有实现某个 custom surface，不影响 Worker、Pi extension 或其他客户端；但客户端不能返回假的默认答案。

已注册的 Extension command 继续使用 `command.submit`。如果 command handler 在执行期间调用 `ui.notify`，对应的 `extension.notification` 会携带该提交已有的 `operationId`；客户端可以把它与自己发起的命令关联并选择显示位置。没有 `operationId` 的 notification 是被动通知。这个字段不是订阅 token，也不会把 notification 变成 Conversation、Run 或 Queue 内容；handler 返回后的后台通知不再带该 ID。

## Project trust

Create、实际创建新 instance 的 ensure、adopt、reopen 或跨项目 session 操作，可能要求明确的 project trust decision。Challenge 与原 operation 和 canonical cwd 绑定。客户端应把用户选择作为原 mutation 的明确继续步骤，不能自行猜测信任结果。

## 面向人的反馈

如果客户端有用户界面，Protocol 字段和错误码只用于关联状态。界面不要直接展示 admission、projection、controller、lease、cursor、generation、mutation、UUID 或异常类名；应说明发生了什么，以及用户现在能做什么。任何操作超过一秒仍未完成，都应提示还在处理或正在恢复连接。

机器客户端也应保留结构化错误和 operation identity，不能把一次未知结果简化成“失败后自动重试”。

## Web 平台补充

Web backend 负责浏览器鉴权、HTTP/WebSocket、上传、页面状态和用户可见反馈。浏览器只连接 Web backend，不接触 Dock socket。`leaseToken`、本机文件路径和其他本机凭证不能发送给浏览器。

浏览器 reload/F5 会丢失本地 conversation，因此按 fresh bootstrap 处理。某个浏览器页面不支持某项 capability，只是这个客户端的能力边界，不影响 Dock 或其他客户端。

## 当前边界

Protocol V2 当前不提供：

- Browser 直连 Dock；
- 多用户或跨 UID 认证；
- arbitrary PTY / remote shell；
- Redis/Pi RPC compatibility；
- 隐式 service install、start 或 restart。

新增客户端能力应来自真实产品需要。某个客户端尚未实现一项 UI 或 interaction，只是该客户端自己的 backlog，不应要求 Host、Worker 或其他客户端降级。
