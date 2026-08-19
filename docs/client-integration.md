# Client 接入 Protocol V2

本文说明客户端怎样接入 Alu Dock。这里的客户端不特指 Web：它可以是 TUI、Web backend、桌面程序或已配对的远程客户端。只要遵守 Protocol V2，它们使用的是同一套 instance、conversation、event 和 operation 语义。

浏览器不能直接连接 Dock。Web 应用需要由本机后端代为连接：

```text
Browser ── HTTP / WebSocket ── Web backend ─┐
TUI / desktop / other local client ─────────┼── Protocol V2 · private Unix socket
                                             ▼
                                      Dock Host Service
                                             │
                                         Agent Worker
```

客户端负责自己的界面、前端鉴权、选择/预哈希文件、本地显示状态和用户反馈。Dock Host 负责 Protocol V2 attachment upload 与永久 bytes；此外还负责 instance、Agent session、operation、Queue、Extension UI 操作权和 Worker lifecycle。客户端不读取 Agent 私有 session 文件，也不接触 Worker IPC 或 runtime object。

## 连接方式

Protocol V2 使用 UTF-8 JSONL；transport 是私有 Unix socket，或已配对的 mutual-TLS 端口（见下文「Unix socket 与远程 TLS 端口」）。每个连接的流程是：

1. 发送 hello，协商版本和 capabilities；
2. hello 成功后发送一个业务 request；
3. 普通 request 收到一个 response 后结束；`session.tree.v2` 成功时先透明重组有界 `response_transfer` records，再得到这一个逻辑 response；
4. `attachment.upload` 在一个 header request 后发送专用多记录 body，再收到一个 terminal response；
5. `deliverable.download` 使用自己的 ready/chunk/complete-or-error 下载 records，不复用 `response_transfer`。
6. `instance.follow` 和 `interaction.control` 在初始 response 后继续接收 event。

读取、实时跟随、attachment upload 和 Extension UI 操作使用独立连接。不要在一条连接上发送多个业务 request，也不要把这些用途重新合成一条长连接。Upload body 是 `attachment.upload` 的专用 framing，不是可复用的通用 streaming RPC。

示例 hello：

```json
{"kind":"hello","requestId":"hello-id","versions":[2],"client":{"name":"my-client","version":"1.0.0","clientId":"process-id"},"requiredCapabilities":["core.v2","host.info"]}
```

示例 request：

```json
{"kind":"request","version":2,"requestId":"request-id","type":"host.info","params":{}}
```

客户端必须校验 response 的 request ID、Protocol version、Host epoch 和自己使用的已知字段。Client→Host 的 hello/request 是 closed shape；Host→Client 的 response/event 可以增加未知可选字段，客户端应忽略它们，而不是让连接失败。字段删除、既有字段类型或语义改变、以及未知 event type 仍是不兼容变化。单条 JSONL 有 frame 上限；大型 conversation 通过分页和 chunk 传输，不能把 frame 上限误当成内容上限。

`session.tree.v2` 请求固定为 `{instanceId}`，一次逻辑调用返回当前 Pi Session Tree 的完整 compact `{nodes, leafId?}`。compact node 只有 ID/parent/depth、kind/role/displayClass/state、可选 label/timestamp、summary 和 hasChildren；绝不包含 raw Session JSONL、完整 message 或 tool content。客户端不发送 revision、cursor 或 limit，也不拼接 Tree pages。

成功的 Tree response 在 wire 上始终由一组 `response_transfer` JSONL records 承载，即使内容只需一块。record 包含 `version:2 + requestId + hostEpoch + zero-based index + stable count + canonical-base64 data`；data 是正常成功 `ControlResponse` UTF-8 bytes 的 opaque slice。transport 必须验证 identity、连续顺序、count、canonical base64、decoded chunk bound 和 aggregate bound，全部收齐后再解析原 `ControlResponse`；每个合法 frame 刷新读取 idle deadline，断线、超时或缺块都不能返回 partial Tree。错误仍是普通 `response`，其他 request 也不能使用该 framing。Tree 打开后若目标已随 Session 变化而消失，操作返回 `invalid_tree_target`，客户端应重新打开 Tree 让用户选择，而不是沿用旧节点。该 invisible bounded framing 在 Unix socket 与 mTLS 上一致，只是 Tree success 的 transport 细节，不是通用 streaming RPC，业务/UI 层不应看到 frame。

Wire shape、capability 名称和 bounds 的代码真相在：

- `src/control/protocol.ts`
- `src/control/dock-client.ts`

### Unix socket 与远程 TLS 端口

本机 Unix socket 和网络 TLS 端口只是 Protocol V2 的两种 transport，不是两套 API：

```text
local client ── private Unix socket ─┐
                                     ├─ hello / request / response / event · Protocol V2
paired client ── mutual TLS port ────┘
```

当前 TypeScript `DockClient` 负责本机 Unix socket。独立的 Android、Web backend 或桌面客户端可以实现 TLS transport，但在证书 admission 之后必须复用本文其余部分定义的同一套 hello、capabilities、request、response、read/follow 和 operation 语义。不得把 Devices、Settings 或证书管理增加为 Protocol V2 request。

远程客户端必须长期保存自己生成的 RSA 2048-bit 或更强证书与私钥，并在每次 TLS handshake 中发送该证书。配对后还必须保存 Host 的完整 leaf certificate DER，之后在发送任何应用数据前做精确匹配。地址、域名和端口只负责找到 Host，不参与信任；切换 LAN 地址、外网域名或 NAT 映射端口不触发重新配对。

### 首次配对

配对入口默认不存在。用户必须先在 Host 本机运行 `aludock`，进入 Devices 并显式确认五分钟连接窗口。窗口外，无证书或未知证书连接都会快速关闭；远程客户端不能开启、延长或查询这个本机管理状态。

客户端配对流程如下：

1. 本地生成并持久化客户端证书、私钥、随机四位 PIN 和 16-byte `clientNonce`；PIN 只显示给用户，绝不能发送给 Host，也不能发送其 hash/verifier。
2. 使用客户端证书建立 TLS。此时 Host 证书只是 provisional candidate；保存本次看到的完整 DER，并在本次 pairing transaction 的所有后续重连中精确匹配。
3. 发送一条 `pairing.begin.v1`，包含安全设备名和 `clientNonce`。收到 `pairing.pending.v1` 后关闭连接并按 `retryAfterMs` 使用新的短 TLS 连接发送 `pairing.poll.v1`。
4. 用户在本机 Hub 选中该设备并输入客户端屏幕上的 PIN。随后 poll 返回 `pairing.srp-challenge.v1`。
5. 使用 `fast-srp-hap`/HomeKit 参数（3072-bit group、SHA-512、identity `Pair-Setup`）完成 `pairing.srp-proof.v1` 与 `pairing.srp-confirmed.v1`。错误 PIN 必须终止本次 transaction，不能自动尝试下一个 PIN。
6. 用确认出的 64-byte SRP key 完成 `pairing.client-identity.v1` / `pairing.server-identity.v1`。两条 identity record 使用 domain-separated HKDF-SHA-512、ChaCha20-Poly1305 和 RSA-PSS/SHA-256，签名内容绑定 pairing ID、clientNonce、双方完整证书与角色。字段、canonical framing、labels 和 nonce 的代码真相在 `src/control/remote-pairing.ts`；其他语言实现必须逐字匹配，并以 Dock 的 pairing contract tests 做互操作验证。
7. 验证 server identity 后持久化 exact Host certificate。重新建立一条同时发送客户端证书、精确 pin Host 证书的 TLS 连接，并发送正常 Protocol V2 hello。只有这次连接成功，客户端 UI 才报告配对完成。

`pairing.begin`、poll、SRP proof 和 identity exchange 都各自使用一条 request/response TLS 连接；Host 返回 response 后立即关闭。客户端不得期待 long poll、keep-alive、follow 或等待用户输入的连接。重复发送完全相同的 SRP proof 可获得同一 confirmation，用于恢复丢失的 response；其他跳步、重放或字段变化都会使 transaction 失败。Host 成功提交但最终 response 丢失时，客户端使用 provisional Host pin 尝试正常双向 TLS/Protocol V2 连接来确认结果，不重新生成证书或自动开启另一场配对。

当前读取、跟随和操作连接分别使用：

- `instance.read` / `instance.read.v1`
- `instance.follow` / `events.follow.v2`
- `interaction.control` / `extension_ui.control.v1`

`events.follow.v2` 依赖 `instance.read.v1`。回答 Extension UI 还需要 Host 提供 `extension_ui.v1` 与 `extension_ui.control.v1`。

hello 的 `requiredCapabilities` 是 fail-fast 功能探测：Host 缺少任何一项就拒绝连接并列出缺失项，让客户端在第一步就发现 Host 过旧，而不是运行到一半失败。它不是响应内容开关：Host 对所有客户端返回同一份 canonical response，不按客户端声明裁剪、改写或降级字段。图片、附件、`presentation`、`displayName`、`gitBranch`、`toolsExpanded`、`activeInteraction` 等可选字段是否出现只取决于事实本身（例如没有 git repo 就没有 `gitBranch`），与客户端声明无关；不渲染某个字段的客户端直接忽略它。`attachments.v1` 只用于发起 attachment upload 或提交 attachment IDs。Unix socket 与 mTLS 上的 wire 完全相同。

## 需要分清的身份

客户端会同时看到几种不同的身份：

- `hostEpoch`：当前 Host 进程；
- `instanceId`：一个 Dock 工作实例；
- optional instance key：业务入口到 instance 的稳定映射；
- Agent session identity：当前 Worker 内的原生 session；
- `runtimeGeneration`：instance 内当前 runtime/session generation；
- `operationId`：一次 mutation 意图，也是后续异步事件回到发起界面区域的关联锚点；
- event cursor：read/follow 和重连的位置。

不要用 instance name、cwd、Agent session ID 或文件路径代替 `instanceId`。Snapshot 的可选 `name` 表示当前 Agent session name；始终存在的 `displayName` 是 Dock 已经清洗和兜底的人类展示标签。实例列表直接渲染 `displayName`，点击、连接和 mutation 仍传 `instanceId`，客户端不要再自行实现 `name/key/id` fallback。

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

一次 history scan 必须始终使用同一个 `historyRevision`。`instance.read` seed 和后续 `session.history` page 的 revision 不一致时，放弃整次 scan 并重新 bootstrap。History page 不会拆开 persisted Assistant tool call 与已经存在的对应 tool results；`limit` 是目标 record 数，完整工具语义单元可以使实际条目数超过 limit。客户端继续使用既有 `toolCallId` 关联，不需要额外的 persisted owner identity。

Event overlap 只按完整事件身份（`runtimeGeneration + sequence`）处理。不得按 role、text、thinking、tool arguments/result、custom details 或它们的 hash 合并；完全相同的内容也可能是两次真实发生的事实。

客户端不发送 conversation ACK。页面刷新、进程重启或本地状态丢失时，直接重新 bootstrap。Read、follow 或 Extension UI 操作连接断开，都不表示 Agent runtime 失败，也不会停止 instance。

## 创建前浏览工作目录

需要让用户选择 cwd 的客户端使用 `workspace.list.v1`，不自行扫描目录，也不为某种界面增加专用接口。`workspace.list` 接收 Host 文件系统中的绝对 `path` 以及可选分页 cursor，返回规范 `path`、可选 `parent`、目录条目和继续读取所需事实。客户端可以用键盘列表、点击列表或自己的视觉组件呈现同一份结果。

浏览范围就是 Dock Host 运行用户已有的文件系统权限。目录不可读、已经消失或符号链接不可用时，Host 返回可恢复错误；客户端显示错误并允许修改路径。浏览不会读取文件正文、改变进程 cwd 或授予 project trust。用户确认后仍调用 `instance.create(cwd)`。

## Instance 与 Agent session

Host control 提供 workspace list、instance create、ensure、list、get/get-by-key、read、follow、stop、reopen、adopt、forget、catalog prune 和 persisted-session inventory。

Agent session 能力包括 prompt、abort、Queue、conversation、model、thinking、tools、settings、resources、session replacement、tree、compaction 和 Extension UI。实际可用能力以 hello capability negotiation 为准。

Agent session replacement 会保留 `instanceId`，但推进 `runtimeGeneration`。旧 generation 的 event、cursor 和 interaction response 不能继续使用。

## Mutation

每个新的 mutation 意图都使用新的 `operationId`。在同一个 Host epoch 中，重复 ID 只能表示同一个意图，不能换一组参数继续使用。

`operationId` 同时是异步渲染的关联锚点。由某次 mutation 引发的后续事件携带发起者的 `operationId`：`message.submitted`、`run.started`、`run.settled`、`compaction.started/completed`，以及执行期间的 `extension.notification`。Web 这类界面用它把异步更新定位回发起控件的显示区域：提交时本地记住 ID，事件到达时按 ID 收敛对应区域，而不是按文本或时间猜归属。这个关联由 Host 权威解析——包括 deferred 队列消费和 extension 发起的 run，Worker 不知道客户端的 operation 身份；runtime 自主发起、无外部 mutation 的 run 以 `runtime-initiated` 标记。它是关联字段，不是展示文本；界面不应把 ID 本身渲染给用户。

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

图片 prompt 可以来自 Host/Worker 同一 UID 可读的本机绝对路径 descriptor，也可以来自聊天消息中已经上传的 `image/*` attachment。远程客户端不提交自己的本机路径：它只上传附件并在 `command.submit.attachments` 中引用 fileId，Dock 在 Agent 私有边界 resolve 后自动加入同一条原生图片输入。

进入 Agent session 后，Pi 原生 structured image content 在普通 event/history 中携带 MIME type、可选 opaque `contentRef`，以及图片来自聊天附件时的可选 `fileId`。完整 bytes 由客户端显式调用 `conversation.content` 分页恢复；`fileId` 关联同一消息的 canonical `AttachmentDto`，不替代 image block 或 attachment。客户端可以据此只显示一个附件缩略图，但不得删除底层任一事实。

Dock 内建的 `show_image` 只负责把本机文件发布给用户界面显示，不把图片注入模型 context（模型要看图时使用 `read`）。成功的 tool result 在 live、history preview 与 `conversation.content` 的完整 tool-result block 中携带同一个 path-free `publishedFile`：`presentation: "image" + fileRef + name + sizeBytes + optional mediaType`。客户端使用 authenticated `file.read` 按 offset 获取最多 256 KiB 的 base64 chunk；文件被删除、改写、session replacement 或 Worker dispose 后返回 `file_unavailable`，界面应提示用户让 Agent 重新发布。`toolCallId` 只用于 tool 关联，客户端不得从 tool text/path 猜 metadata，也不得把 `fileRef` 当路径。

Web 应用通常由后端接收浏览器上传、保存为受控本机文件，再向 Dock 提交 path descriptor；浏览器本身不能把自己的文件路径交给 Dock。Unix socket 与 mTLS 使用完全相同的 `file.read` route。

## Instance 临时交付文件

要求 `instance.deliverables.v1`。`deliverable.list {instanceId}` 返回 path-free tray：每项 `DeliverableDto` 只有 opaque `deliveryRef`、显示 `name` 和 `sizeBytes`。它是 Agent 通过 owner-enabled `dock_deliver_file({path})` 登记的 Host 内存状态，不是 attachment storage：Host 不复制、不上传、不持久化，source 改写/删除、instance stop 或 Host restart 后可能不可用。单文件最大 **104857600 bytes（100 MiB，含边界）**；没有 delete、claim、TTL、ack 或 management request。

下载必须另开一个 authenticated Protocol V2 connection，发送 `deliverable.download {instanceId,deliveryRef}`。ready 前失败是普通 response error；ready 包含同一 DTO，之后是 zero-based contiguous `deliverable_download_chunk`（canonical base64），最后是 `deliverable_download_complete {chunks,sizeBytes,sha256}`。ready 后 source 消失、改变或 read 失败时收到 `deliverable_download_error`，sink 必须丢弃 provisional result。客户端逐块写 sink、独立计算 SHA-256，并验证每帧的 request/Host/instance/ref identity、index、总字节数和 lowercase terminal digest 后才提交成功；不得在内存缓存完整 100 MiB。断线是普通 failed read，不是 mutation `effect_unknown`，不要求 resume。

这与 `show_image` 的 `published-files.v1/file.read` 不同：后者仍是 inline image、Worker session/generation scoped。临时交付的 bytes 由 Host 直接流向客户端，不经 Worker、不使用 attachment store，也不复用 Tree `response_transfer`。没有新 Dock event；客户端可在 initial/open/run 边界重新 list。

## 附件

附件由 Host 永久保存，所有文件类型使用同一机制。它不是 S3-style object service 或某个 Web/TUI 的临时上传目录。Host 不扫描、转换、强制 MIME、自动提取或设置 TTL；最大 decoded file size 是 **536,870,912 bytes（512 MiB / 0.5 GiB）**。本机 Unix socket 与配对后的 mTLS client 使用同一个由 Host 本机 Settings 配置的 storage directory。聊天消息中的 `image/*` attachment 仍使用同一永久附件机制，同时由 Agent adapter 作为原生视觉输入交给 runtime。

客户端应使用一个新的、独立的 authenticated Protocol V2 connection，并在 hello 中要求 `attachments.v1`。先本地读取文件，计算确切 `sizeBytes` 与 lowercase SHA-256；之后发送 header：

```json
{"kind":"request","version":2,"requestId":"upload-request","type":"attachment.upload","params":{"operationId":"upload-operation","name":"报告 final.pdf","sizeBytes":123456,"mediaType":"application/pdf","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}
```

新的 operation 收到 readiness：

```json
{"kind":"attachment_upload_ready","version":2,"requestId":"upload-request","hostEpoch":"host-epoch","maxChunkBytes":524288}
```

按顺序发送从 0 开始的 canonical-base64 chunks。每块 decoded bytes 不得超过 `maxChunkBytes`；当前 512 KiB 上限让 encoded JSONL frame 保持在 1 MiB control record limit 内。客户端必须对 socket backpressure 停止读取 source，而不是把 512 MiB 全部放进内存。

```json
{"kind":"attachment_chunk","version":2,"requestId":"upload-request","index":0,"data":"...canonical base64..."}
{"kind":"attachment_complete","version":2,"requestId":"upload-request","chunks":1}
```

Host 独立计数并计算 SHA-256。只有 declared/received size 和 client/Host digest 都一致才原子发布；断开、超时或验证失败不会创建 metadata。完成 response 的 result 是：

```json
{
  "attachment": {
    "fileId": "123e4567-e89b-42d3-a456-426614174000",
    "name": "报告 final.pdf",
    "sizeBytes": 123456,
    "mediaType": "application/pdf",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "storedAt": "2026-08-16T00:00:00.000Z"
  },
  "status": "stored"
}
```

`status` 只有 `stored | reused`，表示本次是否创建底层 content bytes。相同 content digest 只保存一份，但 display metadata 是独立的：不同的清洗后 name 或 media type 会得到不同 `fileId` 和各自的 `AttachmentDto`，完全相同的 digest/name/media type 可以复用既有逻辑附件。因此 `reused` 仍可能伴随一个新的 `fileId`。`name` 只用于显示；Host 保留 Unicode、空格、扩展名和常见标点，只 neutralize separator/NUL/control；物理文件重名不会给公开 name 添加序号。客户端必须保存 Host 返回的 DTO，不能从 `status` 推断 identity，也绝不能期待 absolute Host path。

Upload header 的 `operationId` 遵守普通 mutation identity。相同 ID 和相同 header 的并发/重连可以直接收到进行中或已完成 receipt，此时 Host 不发送 readiness，客户端不得发送 body；同一 ID 换 header 会得到 `operation_conflict`。发送 `attachment_complete` 后 transport 失败属于结果未知：先以同一 operation/header 重连恢复；如果 Host 已不保留 receipt，可用新 operation 重新发送相同 bytes，content digest 会返回 `reused`。发送 body 前失败可以安全修复连接后重试同一 operation。

提交给 Agent 时不发送 path，也不把文件名拼到 prompt：

```json
{"kind":"request","version":2,"requestId":"prompt-request","type":"command.submit","params":{"operationId":"prompt-operation","instanceId":"instance-id","message":"请检查附件","attachments":["123e4567-e89b-42d3-a456-426614174000"],"delivery":"auto"}}
```

每个 command 最多 32 个 unique `fileId`。Host 在接受命令前解析全部 ID；任一 missing/corrupt ID 使整个提交失败。Canonical `AttachmentDto[]` 会出现在 pending Queue、`message.queued`、`message.submitted`、user `message.completed` 和 persisted user conversation record 中，也会由 `queue.dequeue` 随完整 queued message 返回。实现附件展示的客户端用同一 attachment card renderer 处理这些位置，并继续按 event identity/revision 去重；它不自行从 message text 恢复附件。无需附件 UI 的客户端照常显示文本并忽略可选 attachment metadata，Host 不为它删字段、降级重试或改变共享 Queue 语义。

如果 attachment 的 canonical media type 是 `image/*`，客户端仍只提交 fileId。Agent adapter 会自动把它加入原生 image input，同时保留已认证附件上下文；Agent 不需要先调用 read 才能看到图片。Pi/其他 Agent runtime 决定当前模型如何处理视觉能力，Dock 不做 model/provider capability 判断。之后的 user image block 通过 `fileId` 指向同一附件；两项都属于预期协议事实，是否合并显示是客户端职责。

Agent 通过 Host reverse capability 和 `dock_attachment_resolve` 获取私有路径。图片附件已经作为视觉输入时，resolve 只在 Agent 还需要原始文件路径进行复制、转换、OCR 或其他工具处理时使用。外部 Protocol V2 conversation 会固定遮蔽 resolve tool 的 path；客户端没有、也不需要 attachment path API。如果文件需要在网页下载或预览，那是另一项明确的产品能力，不能从 metadata 猜 Host path。

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

Web backend 负责浏览器鉴权、HTTP/WebSocket ingress、逐块读取与预哈希、页面状态和用户可见反馈。浏览器只连接 Web backend，不接触 Dock socket；backend 再用上述 Protocol V2 upload stream 把 bytes 交给 Host，不长期建立第二份应用私有附件库。`leaseToken`、Host attachment path 和其他本机凭证不能发送给浏览器；浏览器只接收 path-free `AttachmentDto`。

浏览器 reload/F5 会丢失本地 conversation，因此按 fresh bootstrap 处理。某个浏览器页面不支持某项 capability，只是这个客户端的能力边界，不影响 Dock 或其他客户端。

## 当前边界

Protocol V2 当前不提供：

- Browser 直连 Dock；
- 多用户或跨 UID 认证；
- arbitrary PTY / remote shell；
- Redis/Pi RPC compatibility；
- 隐式 service install、start 或 restart。

新增客户端能力应来自真实产品需要。某个客户端尚未实现一项 UI 或 interaction，只是该客户端自己的 backlog，不应要求 Host、Worker 或其他客户端降级。
