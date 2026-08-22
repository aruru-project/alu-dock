# Control、Protocol V2 与 Host

## 这部分负责什么

Protocol V2 是 Dock 对 Hub、Work、Rails/WebUI 和未来客户端的统一协议。Dock Host Service 通过它提供实例管理和 Agent 会话访问。

```text
Client
  │ Protocol V2
  ▼
Dock Host Service
  ├── control authority
  └── session gateway
         │
         ▼
      Agent Worker
```

Protocol V2 不暴露 Worker endpoint、Agent runtime object 或 Agent 私有存储。

## Host 的两类工作

### Control

Host 自己处理：

- instance create、ensure、list、get、stop、reopen、forget；
- 创建前的只读 workspace 目录浏览；
- catalog、project trust 与 persisted-session inventory；
- Worker lifecycle、runtime kind 与 generation；
- Queue、operation、Extension UI 操作权与 read/follow reconnect。

这些状态属于 Dock，不交给 Agent runtime 决定。Persisted-session inventory 的 response 可附带有界 `firstUserMessage`，供人类选择器在无 session name 时展示；它是可忽略的新增 response 字段，不改变 session file 作为采用目标的语义。

### Session gateway

Prompt、conversation、model、tools、settings、session、tree 和 Extension UI 等 Agent 会话能力，由 Host 完成必要的 instance、operation、controller 与 lifecycle 判断后路由给 Worker。

Host 不为这些能力维护第二套 Agent 实现，也不重复投影 Worker 已经产生的 Dock event/result。

## Main 与 SubHost

Main 是唯一面向客户端的 Host authority。SubHost 只持有一个到 Main 的加密上游连接和本机原生 Registry；它不监听客户端本地 IPC、不启用 Remote Access、不接子节点，也不把远端实例混进本机 Registry。

SubHost 只上报本机 Registry 的 native snapshots。初始和后续 inventory 都先把完整 canonical snapshot array 序列化，再按 machine-line 边界切成有序 base64 chunks；Main 收齐、按 durable catalog 的既有字节边界校验并逐项解析后才原子 reconcile，初次完成前不发送 `machine_ready`，替换 inventory 未完成时旧连接与旧目录继续权威。Main 在独立、持久的 route directory 中为每个 native instance 分配稳定的 Main `instanceId`；Main identity、trust 和 machine index 保存在 `main.json`，每个 SubHost 的 routes 使用各自 crash-safe atomic route file 和既有 catalog 字节边界，因此所有 SubHost 不共享一个 16 MiB route 上限。两种 ID 不要求相等。客户端只收到并发送 Main ID。普通 response、follow/control、response-transfer、workspace/deliverable stream 和 attachment upload body 都经过同一个 multiplexed Protocol V2 route seam；Host 不为每个 method 建 proxy，也不创建假的 remote `ManagedInstance`。

MainMachineController 是 Main ID、route 和 instance key 的唯一全局 authority；DockRegistry 仍只管理本机原生 instance。Key 没有 placement 含义：Main-local snapshot、持久 route 和正在进行的 ensure reservation 共同参与全局认领，已有 owner 保留 key，后来上报的重复 instance 仍按 Main ID 可见但其 Main snapshot 省略 key，SubHost catalog 不被改写。`instance.get_by_key` 始终全局查询；`instance.ensure` 先全局查询，只有 miss 时可选 `hostId` 才选择第一次创建的位置，省略时创建在 Main 本机。同 key ensure 在 authority 外执行实际本机或机器请求，并在 reservation 释放后统一返回最终 owner。

机器边界只有一个 identity mapper：它改写 Protocol V2 的 instance/Host identity 字段并始终投影 Main-authoritative key，但不进入 message、content、metadata、tool arguments 等 Agent/用户 opaque payload。无 instance 的 machine-local request 可带 `hostId`；省略时仍选择本机 Main，保持旧客户端行为。`attachment.upload` 的 `instanceId` 可选：省略时沿用 Main 本机 storage；提供 Main `instanceId` 时，Main 在 body 开始前路由到拥有该实例的 SubHost storage。

每条 logical stream 都有独立的有界串行输入队列和 stream reset；某条 stream 的 backpressure、解析、投影、持久化或客户端输出失败只关闭该 stream，TLS machine link 仍继续处理其他 stream 与 heartbeat。机器 route 对 `response_transfer` 逐帧复用 canonical Protocol V2 parser，并在 Main identity 投影后继续受同一组 chunk、count 和 aggregate bounds 约束。机器断线只让 Main 的远端目录进入可恢复状态，不停止 SubHost Worker 或已经接受的 Queue。离线时对 Main entry 执行 stop 只删除 route mapping；成功路由的 stop/forget 则在向客户端发出成功前持久退役该 Main route，同 generation 的迟到 inventory 不能恢复它，更新 generation 可重新取得新的 Main identity。普通转发不在 Main 缓存或重放 mutation；Main-owned global ensure 保留 Main operation identity，转发时仍沿用原 operation ID。SubHost 的全局 Agent Dock tools 使用同一上游 authority，并以 Main source ID 执行；上游不可用时 list/inspect/watch/create/send 立即失败，`dock_create` 默认回到 source SubHost。`dock_deliver` 始终由 source SubHost 在本机登记，不依赖 Main 连接。

## Protocol V2

Protocol V2 的记录使用 UTF-8 JSONL，可以承载在两类 transport 上：

- **私有本地 IPC**：POSIX 使用 Unix domain socket，以文件系统所有权和 mode 做 admission；Windows 使用 Named Pipe，以 Windows 本地访问控制做 admission。本机入口不使用 TLS、客户端证书或配对。
- **远程 TLS 端口**：默认关闭；启用后绑定所有网络接口。TLS admission 成功的可信客户端进入与本地 IPC 完全相同的 Host request handler，不存在远程专用 DTO、业务路由或兼容层。

Transport admission 完成以后，两条路径的 Protocol V2 行为一致：

1. 客户端先发送 hello，并协商版本与 capabilities；
2. hello 成功后发送业务 request；
3. 普通 request 返回一个 response；`session.tree.v2` 成功时改用透明的有界 response-transfer records 重组同一个逻辑 response；`attachment.upload` 是唯一的有界多记录 request body，完成后仍只返回一个 terminal response；
4. `instance.read` 读取当前权威视图，`instance.follow` 在初始 response 后持续接收 event；
5. Extension UI 操作使用独立连接，并与读取、实时跟随分别恢复。

TLS peer 必须在握手时提供 X.509 客户端证书并证明持有私钥。Host 只把与持久信任记录中 leaf certificate DER 完全相同的连接交给 Protocol V2。无证书或未知证书永远不能发送 hello，也不能调用任何 Protocol V2 request。

配对不是 Protocol V2，也不是远程管理 API。只有用户在本机 Hub 的 Devices 页面显式确认并打开五分钟窗口时，同一个 TLS 端口才临时允许未知证书发送 `pairing.*.v1` bootstrap。每条未知连接只接收一条有界 request、返回一条 response，然后立即关闭；人工确认只推进 Host 中有期限、有数量上限的 pairing transaction，不保留 socket、stream、callback 或等待中的网络 Promise。TLS handshake、首帧和 response close 分别有 5 秒、2 秒和 1 秒边界；用户批准后的完整证明最多持续 60 秒。

客户端首请求只携带 TLS 客户端证书、设备名和随机数，绝不发送 PIN 或可离线枚举的 PIN verifier。用户在本机选择明确请求并输入客户端显示的四位 PIN。PIN 阶段采用 HomeKit Pair Setup 使用的 SRP-6a 3072-bit/SHA-512 参数；确认出的 session key 再按 HomeKit 的 domain-separated HKDF、ChaCha20-Poly1305 和签名交换形状，绑定 server-generated pairing ID、双方完整证书、本次随机数和双方私钥证明。事务顺序同时遵循 Moonlight/Sunshine 的经验：候选证书保持 provisional、阶段严格单调、全部验证后才原子写入客户端信任，客户端最后以精确 Host certificate pin 建立新的 TLS/Protocol V2 连接再提交 Host 信任。

远程地址不属于身份。已配对客户端可以从新的 IP、域名或映射端口连接同一个 Host，只要双方仍使用原来的证书。每次连接仍执行完整 TLS handshake；session resumption 被关闭，不能替代证书检查。吊销删除精确客户端证书信任，并由 Host 关闭该证书的现有远程连接。

Devices 中的 Remote Access/port、开启/关闭连接窗口、待连接请求、PIN 确认、saved device 列表和移除，以及 Settings 中的 attachment storage directory，是本机 `aludock` Hub 的 service-management surface。它们不属于 Protocol V2，不通过本地 IPC 或 TLS 暴露，也不在 DockClient、CLI JSON API 或额外 admin endpoint 中提供。远程客户端只能使用临时 pairing bootstrap 和配对后的 Protocol V2；它不能远程改变 Host 设置、开启或延长连接窗口。

Client 发给 Host 的 hello/request 使用 closed JSON-safe shape，未知字段会被拒绝。Host 发给 Client 的 response/event 仍严格校验已知字段、版本、类型和边界，但 Client 必须忽略新增的未知可选字段；只有删除字段、改变既有语义或新增无法忽略的类型时才需要 capability 或协议版本。单 frame 可以有传输上限，但业务内容不能因此永久截断；大型 conversation 使用分页和 chunk 继续读取。持久 record 的 `contentRef` 由 Agent 原生 session 与 entry identity 决定，append、refresh 和 Worker restart 不改变它；revision 与 cursor 只隔离一次分页 scan。

`conversation.images.v1` 在独立 Protocol V2 连接上以 `conversation.image {instanceId,contentRef}` 读取原生 conversation image。Host 先发送包含 MIME、decoded size 和 lowercase SHA-256 的 ready，再发送从零连续、decoded bytes 最大 512 KiB 的 chunk，最后发送带总 chunk 数、size 和 SHA-256 的 complete；ready 后失败发送专用 error，客户端丢弃已收 bytes。DockClient 逐块调用 callback、独立 hash 且不缓存完整图片。Host 从当前 generation Worker 的分页内容顺序产出并按 socket drain 背压；既有 `conversation.content` 保留。Main/SubHost 仍通过通用 machine stream route，identity mapper 只改 frame root 的 Host/instance identity。

`session.tree.v2` 专指当前 Pi Session Tree。请求只有 `{instanceId}`，一次逻辑调用返回一个完整 compact snapshot `{nodes, leafId?}`；node 只含 ID、拓扑、kind/role、展示标签、时间、摘要和 children fact，不含 Pi JSONL entry、完整 message 或 tool content。Host 不缓存、分页、revision 或解释树拓扑，只做 lifecycle、admission、generation fencing 和路由。

完整 Tree response 即使只有一块，也使用 transport-only `response_transfer` records。每块是普通成功 `ControlResponse` UTF-8 序列化后的 opaque canonical-base64 byte slice；DockClient 检查同一 request/Host identity、从零连续 index、稳定 count、单块和 aggregate transport bounds，收齐后才解析原 response。缺块或越界没有 partial result。该 framing 在本地 IPC 与 mTLS Protocol V2 上相同，只承载成功的 `session.tree.v2` response；错误仍是一条普通 response，也不形成通用 streaming RPC。

Protocol V2 是外部合同。Host 与 Worker 的内部重构不应要求现有 TUI 或 Web 客户端重写。

`workspace.list.v1` 是创建实例前唯一的目录发现能力。客户端明确传入 Host 文件系统中的绝对路径；Host 返回规范当前路径、上级路径、目录/目录符号链接和分页事实。它只使用 Host 运行用户已有的文件系统权限，不设置额外根目录或白名单，不读取文件正文、不执行 shell，也不改变任何 Host 或 Worker 的进程 cwd。目录选择完成后仍由 `instance.create(cwd)` 执行既有校验和 project trust；浏览本身不产生信任。

`workspace.files.v1` 是 active instance 的 Host workspace 只读能力。每次请求以受理时 snapshot 的 `cwd` 为根，path 使用 workspace-relative 形状且根为 `.`；`workspace.entry.list/get` 返回隐藏条目和不含 Host 绝对路径的 workspace metadata，`workspace.file.read` 在独立连接中按 ready/chunk/complete-or-error 顺序读取正文。Host 拒绝 absolute、`..` 与逃出根目录的符号链接，并在 open 后再次核对实际文件对象仍位于根内。安全的 contained symlink 可按目标类型读取或遍历；外部、断链或 loop symlink 仍可列出为 `targetKind: unavailable`，但不能打开。stop 后的新请求拒绝，reopen 后按普通 active instance 使用。

## 附件存储与上传

附件是 Host-owned、单用户、永久文件，不属于 durable catalog、Worker DTO 中的字节载荷或某个 TUI 的私有目录。Hub Settings 在本机私有 state 中配置一个绝对 storage directory；本地 IPC 和已配对 mTLS 客户端共享它。Settings change 与 active upload 使用跨进程 claim/lease 协调：有 upload 尚未 complete/abort 时拒绝改目录，避免成功 receipt 指向旧 root。首次提交后目录不能直接改到另一处；需要迁移时先整体移动 `files/` 与 `.alu-dock/` store，再修改配置。Host 不做病毒扫描、格式转换、MIME 强制、自动解压、TTL、GC、quota、per-device/per-instance ACL 或引用计数。

`attachments.v1` 的公开 metadata 始终使用同一个 path-free shape：

```ts
interface AttachmentDto {
  fileId: string;
  name: string;
  sizeBytes: number;
  mediaType?: string;
  sha256: string;
  storedAt: string;
}
```

`fileId` 是 opaque logical-attachment identity；Protocol V2 response、Queue、event 和 conversation 不得出现 Host absolute path。人类文件名保留 Unicode、空格、扩展名和常见标点，只替换 path separator、NUL/control。内容与展示 metadata 分开持久化：相同 SHA-256 bytes 只保存一份，但不同的清洗后名称或 media type 拥有独立 `fileId` 和 `AttachmentDto`；完全相同的 digest/name/media type 可复用既有逻辑附件。不同内容即使同名也保持各自的原显示名，物理存储碰撞不会改写公开 metadata。结果用 `status: "stored" | "reused"` 表示本次是否创建底层内容，而不是是否创建新的逻辑附件。

上传最大 decoded size 是 `536870912` bytes（512 MiB）。客户端先计算并声明 size 与 lowercase SHA-256，Host 在写 provisional file 时独立计数和 hash，只有 size/digest 完全相同才 fsync、原子发布内容和 manifest。失败、断开和 Host restart 会清理 provisional file；成功附件没有自动到期。已发布文件在 Agent resolve 时再次检查 regular-file、size、digest 与 managed-directory containment。

`attachment.upload` 使用普通 authenticated Protocol V2 hello，并要求 `attachments.v1`。其专用连接顺序是：

1. 发送一个 upload header request：`operationId + optional instanceId + name + sizeBytes + optional mediaType + sha256`；
2. Host 返回 `attachment_upload_ready` 与 `maxChunkBytes`，或者直接返回同一 operation 的既有 terminal receipt；
3. 客户端按从 0 开始的连续 index 发送 canonical-base64 `attachment_chunk`；decoded chunk 不超过 Host 宣告值，当前上限 512 KiB，因此每条 JSONL 仍小于 1 MiB control-line bound；
4. 客户端发送一个 `attachment_complete`，其 `chunks` 必须等于已发送数量；
5. Host 只返回一个普通 terminal `response` 并关闭连接。

Host 对 socket input 串行处理、pause/resume backpressure，并以 60 秒 idle deadline 约束未完成 body。`operationId` 仍遵守同一 Host epoch 的 mutation identity：相同 header 重试共享进行中或已完成 receipt，不重复请求 body；同一 ID 换参数得到 `operation_conflict`。若 complete 后 response 丢失，客户端保留结果未知并以相同 operation/header 恢复；receipt 已淘汰时也可用新 operation 重传相同 bytes，content digest 会安全复用。普通 request 的一请求一响应规则不因此变成通用 streaming RPC。

`command.submit` 只携带结构化 opaque `attachments: fileId[]`。Host 在 admission 时解析为 canonical DTO，再与 message 一起进入 direct prompt、Host Queue、runtime Queue、`message.submitted`、`message.completed` 和 persisted conversation。文件 bytes 始终留在 Host store，不进入 catalog、event JSONL 或 `MAX_WORKER_TRANSFER_BYTES` IPC。`attachments.v1` 只约束 `attachment.upload` 以及实际携带 attachment IDs 的 `command.submit` input；一旦消息被接受，attachment metadata 就是 canonical message 的可选组成部分，随 read、follow、history 和 `queue.dequeue` 原样返回。无需显示附件的客户端直接忽略该可选字段，不需要 attachment projection 协商、兼容重试或 Queue 特判。

聊天消息中 media type 为 `image/*` 的附件同时具有两项 canonical 语义：它仍是可 resolve、下载和交给工具的永久 attachment，并由 Agent adapter 通过私有 resolve path 加入同一条 Agent 请求的原生 image input。Dock 不按当前模型判断视觉能力，也不要求客户端增加 image mode 或让 Agent 先 read；模型能力与旁路处理由 Agent runtime 决定。持久和 live user content 中对应 image block 使用可选 `fileId` 关联同一 `AttachmentDto`。两项事实都保留，客户端按关联决定展示一次还是分别展示；Host 不为了 UI 去重而删除其中一项。

## Published files 与读取

`published-files.v1` 提供 authenticated `file.read`。公开 `PublishedFileDto` 固定为 `presentation: "image" + fileRef + name + sizeBytes + optional mediaType`，不含 Worker path；客户端按 `presentation` 决定显示意图，不从 tool name、文件扩展名或文本猜测。Host 只校验 instance/lifecycle 并把同一 Protocol V2 request 路由到当前 generation 的 Worker，Unix socket 与 mTLS 共用这条 route；这条 `show_image` 路径不在 Host 维护 registry 或 media store。

`file.read` 使用明确的 `fileRef + offset`，每页 decoded bytes 最多 256 KiB。response 的 `offset` 必须等于请求 offset，`nextOffset` 必须精确等于本页末尾；complete page 必须恰好到达 `sizeBytes`。registry 只在 Worker 当前 session/generation 内存活，session replacement、dispose、handle 淘汰、源文件删除或改写都返回 `file_unavailable`，客户端应让用户要求 Agent 重新发布，而不是重试任意 path。

## Instance 临时交付文件

`instance.deliverables.v1` 与 `show_image` 分离。Agent 在 owner-enabled Dock tools 中调用 closed `dock_deliver_file({path})`；Host 从 authenticated Worker connection 推导 source instance，绝不接受 Worker 提供 instance/session/generation identity。当前 `ManagedInstance` 只在内存登记 canonical source path、`dev/ino/size/mtime/ctime` 和 opaque `deliveryRef`，不读取全文、不 hash、不复制、不上传、不创建 data file，也不写 catalog/session。登记跨 Pi session reload/new/switch/replacement 保留，instance stop 清空；Host restart/reopen 可以丢失。每个 instance 的登记集合有 producer-owned safety bound，满时拒绝新登记而不淘汰正常条目；没有 delete、claim、TTL、ack 或管理 API。

公开 `DeliverableDto` 只有 `deliveryRef + name + sizeBytes`，不含 path。任意 readable regular file 可登记到 **104857600 bytes（100 MiB，含边界）**。客户端用 `deliverable.list {instanceId}` 读取 instance tray；下载在一个独立连接发送 `deliverable.download {instanceId,deliveryRef}`。Host 在 ready 前的失败是普通 error；ready 后发送从零连续的 canonical-base64 chunk records，最后发送 `chunks + sizeBytes + lowercase SHA-256` complete。若 source 在 ready 后消失、改变或读取失败，Host 发送专用 terminal error，客户端丢弃结果。Host 按需 open 并在流前后核对登记的文件身份，以 socket backpressure 发送且边发边算 SHA-256，不经 Worker、不写 Host disk、不复用 attachment storage 或 session-tree `response_transfer`。临时交付与 workspace read 共用同一个 Host source-file read/chunk/backpressure/hash pump 及 100 MiB / 512 KiB 上限；交付仍固定读取登记 size 并做最终 identity verify，workspace 则顺序读取到 EOF，不做最终 identity verify。

DockClient 的下载 API 把 chunk 逐块交给 sink/callback并独立计算 SHA-256，不缓存完整 100 MiB；只有 request/Host/ref identity、连续 index、总字节数和 terminal digest 全部匹配才返回成功。transport failure 是普通失败读取，不是 `effect_unknown`。客户端可在 initial/open/run 边界刷新 list；没有新的 Dock event 或 TUI surface。

## 身份

以下身份用途不同：

- Host TLS certificate：跨 Host 进程长期保持的远程 Host identity；
- trusted client certificate：一个已配对远程设备的精确 leaf certificate identity；
- `hostEpoch`：一次 Host 进程域，不是 TLS identity；
- `instanceId`：Dock 工作实例；
- Agent 原生 session identity：当前 Worker 内的会话；
- `runtimeGeneration`：instance 内一次 runtime/session generation；
- `operationId`：一次调用者 mutation 意图；
- attachment `fileId`：Host logical attachment metadata 的 opaque identity；多个 `fileId` 可以引用同一份 content bytes，它不是路径；
- event cursor：一次 read/follow reconnect 的观察位置。

客户端不能用 name、cwd、Agent session ID 或文件路径代替 Dock instance identity。Snapshot 中可选的 `name` 是当前 Agent session name，不是稳定的 Dock 实例名称。Snapshot 始终携带 `displayName`：Host 统一按 `name → key → cwd fallback → Work` 生成安全的人类展示标签；其中 cwd fallback 只保留 ASCII 字母、数字、空格、下划线和横杠，最长 20 个字符，任意异常都降级而不能使 snapshot/list 失败。`displayName` 不持久化为 session name，不参与 TARGET、key 或 instance identity；客户端只负责渲染，操作仍使用 `instanceId`。

## Mutation

Host 对 mutation 负责 admission、operation 去重和结果归属。客户端发送 mutation 后遇到断线或无法确认的 response，不能自动重放；应查询当前状态，并在仍无法确定时保留结果未知。

显式 stop 先持久化 stopping intent，再清理 Worker；完成提交直接把 instance 从 catalog 退役，同时向调用者和已连接客户端发布最终 stopped 状态。Agent 自己的持久 session 不属于 Dock catalog，stop 不删除它。Host shutdown、Host loss 和可恢复 runtime error 不是显式 stop，必须继续保留 reopen 所需的 catalog 记录。

Worker 接受副作用前失联和接受后失联是不同结果。Host 必须保留这个区别，不能把可能已经执行的 mutation 当成普通失败重试。

附件上传的 `operationId` 在 header admission 时保留；同一参数的并发、completed 或 response-loss 重试共享 receipt，不重新执行 body effect，不同参数冲突。内容 SHA-256 另提供跨 operation 的永久 bytes 去重，不把 endpoint、文件名或客户端路径当 content identity；清洗后的 name/media type 只参与 logical attachment identity。

消息提交中，Host 的 admission result 使用 Worker 报告的实际 delivery。`operationId` 是直接 prompt 与 Queue message 共用的提交身份；`queueItemId` 只属于确实等待过的 Queue item。一个 Host-deferred Queue item 可以在 Agent 恢复空闲后以 `prompt` delivery 被消费，此时 `message.submitted` 仍保留它真实的历史 Queue identity；普通 direct prompt 没有该 identity。若辅助关联异常，Host 省略这个可选 identity，而不是伪造一个或丢掉 canonical message。Host 不根据 catalog 中稍早的 running 状态替 Agent 决定最终 delivery。因此用户看到的状态必须始终可判定为未接受、Queue 中等待，或已经被 Agent 消费并出现在 conversation，不能两边都没有。

## Read、follow 与 Extension UI 操作

`instance.read` 返回当前 snapshot、conversation bootstrap、Queue 与读取边界。conversation bootstrap 由同一边界下的两部分组成：

- `recentHistory`：Worker 产生的当前分支权威持久 record；
- `page.events`：尚未被 Worker persistence checkpoint 接住的 active conversation frame，以及仍在等待的 interaction。

持久 record 使用通用的 `recordId / kind / source / visibility / content / metadata` shape。Worker adapter 保留 Agent 的 message、tool、custom message、bash、compaction/branch summary 和 session metadata 语义；Host 不把它们压成 role，也不按文本或 tool 内容猜测 live frame 是否已经持久化。

`instance.follow` 从 read boundary 开始补齐后续事件并持续跟随。保有本地画面且 cursor 连续时，客户端只消费 `event_log` replay 和 follow；不重新拉取历史。event ring 截断、Host epoch 改变、runtime generation 改变或本地状态丢失时，客户端丢弃旧 conversation，重新读取完整 bootstrap。不得把两次 history 读取边界拼成一个会话。普通 `session.history` page 与 bootstrap seed 都携带 Host `historyRevision`；分页中 revision 改变时客户端必须放弃该次 scan 并重新 bootstrap。History 只在完整语义单元之间分页：包含 tool call 的 Assistant record 与已经持久化的对应 tool-result records 不得被 record limit 或 Host 传输裁剪拆到两页。请求的 limit 是目标 record 数，单个完整语义单元可以使响应超过该数。

active frame 的释放完全由 Worker persistence checkpoint 驱动。Host 只按 generation、sequence 和 checkpoint 机械暂存/释放，不等待客户端 ACK，不维护接收名单，也不做内容 fingerprint、认亲或去重。任意数量的客户端可以同时读取和跟随；观察连接中断不等于 Agent runtime 失败，也不结束 instance。

Extension UI 操作使用独立连接，同一 instance 同时只有一个。新连接立即接手，旧操作连接结束但它的普通 follow 不受影响；等待中的 interaction 属于 runtime generation，不因接手或断线而被回答或取消。

## Agent-facing Dock tools

Dock tools 是 Host-owned、按来源 `instanceId` 绑定的本机工作能力。开关默认关闭并持久化在 catalog；Host 从 authenticated Worker connection 取得 caller identity，每次操作都重新校验，Worker request 不能声明或替换 source。目标不是白名单：主人为一个来源实例开启后，它可以发现 sibling、按需读取、等待、创建 peer 或发送明确带来源的消息，但不能停止实例、回答 interaction 或调用任意 Agent 私有方法。新实例永远从 off 开始，也不继承创建者状态。

`dock_list` 与 `dock_inspect` 是两条 closed request：list 只投影 instance snapshot 的短状态，`scope=live` 排除 terminal catalog history，`scope=all` 才包含；它不读取任何 conversation。inspect 必须提供一个 human target，Host 解析后永远排除 caller 自己，再按普通 `types + limit + cursor` 语义返回按消息条数分页的清洗后 conversation page；选中的消息正文保持完整，不做字符截断。状态复用 canonical lifecycle/execution fact；`executionChangedAt` 与当前 running 区间的 `runStartedAt` 是权威时钟，不能用会被 Queue/settings 等变化刷新的 `updatedAt` 猜运行时长。Host-side `InstanceObservationService` 不把 TUI attach DTO、live transport event 或 Host 内部对象暴露给 Worker，也不生成 Host 摘要。

watch 是 Host 内存中的一次性 subscription，不轮询、不占模型 turn。目标已经 idle/stopped/error 时调用同步返回当前结果；否则 Host 订阅 instance state，固定首次 terminal transition 的状态后删除 watch，再向当前来源 Worker 投递仅含 target/reason/time 的 completion。来源/目标 session generation replacement 不改变 stable instance watch；来源 stop/forget、Dock tools 关闭会清理，目标 forget 按 unavailable 完成。cancel/off 与 completion delivery 在来源实例栅栏内排序；取消确认后，尚未交付的 completion 不能再次唤醒。watch 不跨 Host restart 恢复或补发。

`dock_create(cwd,name?)` 与 Protocol V2 `instance.create` 进入同一个 `InstanceMutationService`，因此复用 operation ledger、canonical cwd、project trust 与 catalog transaction；它不另开 Host socket，也不接受 Pi 启动参数。`dock_send(target,message)` 先在 Host 解析 target 和 source display name，再把固定可见来源包装后的正文交给同一个 `command.submit` service，并使用普通 `auto` delivery。目标看到的是持久化的普通 user message，Queue 与 receipt 语义不分叉；正文逐字保留，来源显示人类名称而不是 UUID。

## 命令发现

`command.catalog` 返回命令所有者提供的名称、说明、来源和能力事实。静态参数用法保留为可选 `argumentHint`；`argumentCompletions` 只表示命令所有者能根据当前参数前缀提供候选，不把动态候选伪装成静态参数表；`contentAvailable` 表示该命令有可按需检查的权威内容。Host 不按命令名维护用法表，也不从 description 或 handler 猜参数。

`command.discovery.v1` 提供两条只读能力：`command.content` 分页读取命令所有者当前加载的 Markdown 内容，`command.complete` 取得命令所有者针对给定参数前缀生成的候选。请求使用 catalog 中的 canonical `{name,source}` 引用，避免同名的 prompt、extension 或 skill 被错误认领。Prompt 正文来自 Worker 已加载的模板对象，不暴露文件读取接口；Host 只做 instance/lifecycle 判断并原样路由。某个客户端不展示详情或动态候选，不影响其他客户端使用这项能力。

## Capabilities

Capability 表示当前 Host、Agent Worker 或客户端是否实现某项能力。

- Agent 提供但客户端未实现的能力，只在该客户端不可用；
- 新 Agent 实现现有能力时，不修改 Protocol V2 和其他客户端；
- 真正的新 Agent 能力在 Protocol V2 定义一次，再由需要它的客户端实现；
- capability negotiation 不能成为删除内容或降低其他客户端能力的理由；也不得要求客户端预先声明 capability 才能使用已存在的能力。capability 是客户端对 Host 的 fail-fast 功能探测，不是客户端向 Host 的准入申报；不为尚不存在的客户端预埋兼容门或多形状响应。

## 代码范围

- `src/control/protocol.ts`：Protocol V2 shape、hello、capabilities 与 wire parser。
- `src/control/dock-client.ts`：TypeScript 客户端 transport。
- `src/control/dock-host.ts`：Host socket、request routing 与 event follow。
- `src/control/dock-registry.ts`：instance 与 catalog lifecycle。
- `src/control/operation-ledger.ts`：Host epoch 内的 mutation identity。
- `src/control/catalog-*.ts`：durable catalog transaction 与 recovery。
- `src/control/json-lines.ts`：JSONL framing。
- `src/control/remote-access-state.ts`：Host TLS identity、listener settings、pairing 与 certificate trust 的私有持久状态。
- `src/control/remote-access-server.ts`：TLS admission、pairing bootstrap、listener reconfiguration 与 revocation。
- `src/control/remote-pairing.ts`：客户端可复用的 pairing wire types，以及 SRP、identity encryption 和 certificate proof helpers。
- `src/control/attachment-storage-state.ts`：本机 storage directory 设置。
- `src/control/attachment-service.ts`：stream sink、hash verification、manifest、dedupe 与 Agent path resolution。
- `src/core/instance-deliverables.ts`：instance-lifetime 临时交付 registry、path-free DTO 与 producer bounds。
- `src/core/source-file.ts`：`show_image` 与临时交付共用的 source canonicalize/stat/open/unchanged check。
- `src/control/workspace-browser.ts`：Host 文件系统目录浏览与可恢复错误。
- `src/control/instance-workspace.ts`：active instance workspace 的相对路径、符号链接与 canonical containment。
- `src/control/source-file-transfer.ts`：workspace 与临时交付共用的 Host source-file streaming pump。

新增功能时先判断它属于 Host control 还是 Agent session。不要把 Agent session 能力塞进 catalog/Managed state，也不要为同一 Protocol V2 shape 在 Worker、Host 和客户端分别维护重复定义。
