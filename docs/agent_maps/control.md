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

这些状态属于 Dock，不交给 Agent runtime 决定。

### Session gateway

Prompt、conversation、model、tools、settings、session、tree 和 Extension UI 等 Agent 会话能力，由 Host 完成必要的 instance、operation、controller 与 lifecycle 判断后路由给 Worker。

Host 不为这些能力维护第二套 Agent 实现，也不重复投影 Worker 已经产生的 Dock event/result。

## Protocol V2

Protocol V2 的记录使用 UTF-8 JSONL，可以承载在两种不同 transport 上：

- **私有 Unix socket**：本机客户端按既有路径直接连接；文件系统所有权和 mode 是 admission，不使用 TLS、客户端证书或配对。
- **远程 TLS 端口**：默认关闭；启用后绑定所有网络接口。TLS admission 成功的可信客户端进入与 Unix socket 完全相同的 Host request handler，不存在远程专用 DTO、业务路由或兼容层。

Transport admission 完成以后，两条路径的 Protocol V2 行为一致：

1. 客户端先发送 hello，并协商版本与 capabilities；
2. hello 成功后发送业务 request；
3. 普通 request 返回一个 response；`attachment.upload` 是唯一的有界多记录 request body，完成后仍只返回一个 terminal response；
4. `instance.read` 读取当前权威视图，`instance.follow` 在初始 response 后持续接收 event；
5. Extension UI 操作使用独立连接，并与读取、实时跟随分别恢复。

TLS peer 必须在握手时提供 X.509 客户端证书并证明持有私钥。Host 只把与持久信任记录中 leaf certificate DER 完全相同的连接交给 Protocol V2。无证书或未知证书永远不能发送 hello，也不能调用任何 Protocol V2 request。

配对不是 Protocol V2，也不是远程管理 API。只有用户在本机 Hub 的 Pairing 页面显式打开五分钟窗口时，同一个 TLS 端口才临时允许未知证书发送 `pairing.*.v1` bootstrap。每条未知连接只接收一条有界 request、返回一条 response，然后立即关闭；人工确认只推进 Host 中有期限、有数量上限的 pairing transaction，不保留 socket、stream、callback 或等待中的网络 Promise。TLS handshake、首帧和 response close 分别有 5 秒、2 秒和 1 秒边界；用户批准后的完整证明最多持续 60 秒。

客户端首请求只携带 TLS 客户端证书、设备名和随机数，绝不发送 PIN 或可离线枚举的 PIN verifier。用户在本机选择明确请求并输入客户端显示的四位 PIN。PIN 阶段采用 HomeKit Pair Setup 使用的 SRP-6a 3072-bit/SHA-512 参数；确认出的 session key 再按 HomeKit 的 domain-separated HKDF、ChaCha20-Poly1305 和签名交换形状，绑定 server-generated pairing ID、双方完整证书、本次随机数和双方私钥证明。事务顺序同时遵循 Moonlight/Sunshine 的经验：候选证书保持 provisional、阶段严格单调、全部验证后才原子写入客户端信任，客户端最后以精确 Host certificate pin 建立新的 TLS/Protocol V2 连接再提交 Host 信任。

远程地址不属于身份。已配对客户端可以从新的 IP、域名或映射端口连接同一个 Host，只要双方仍使用原来的证书。每次连接仍执行完整 TLS handshake；session resumption 被关闭，不能替代证书检查。吊销删除精确客户端证书信任，并由 Host 关闭该证书的现有远程连接。

Remote Settings、attachment storage directory、开启/关闭配对窗口、待配对请求、PIN 确认、trusted device 列表和吊销是本机 `aludock` Hub 的 service-management surface。它们不属于 Protocol V2，不通过 Unix socket 或 TLS 暴露，也不在 DockClient、CLI JSON API 或额外 admin socket 中提供。远程客户端只能使用临时 pairing bootstrap 和配对后的 Protocol V2；它不能远程改变 Host 设置、开启或延长配对窗口。

Client 发给 Host 的 hello/request 使用 closed JSON-safe shape，未知字段会被拒绝。Host 发给 Client 的 response/event 仍严格校验已知字段、版本、类型和边界，但 Client 必须忽略新增的未知可选字段；只有删除字段、改变既有语义或新增无法忽略的类型时才需要 capability 或协议版本。单 frame 可以有传输上限，但业务内容不能因此永久截断；大型 conversation 使用分页和 chunk 继续读取。

Protocol V2 是外部合同。Host 与 Worker 的内部重构不应要求现有 TUI 或 Web 客户端重写。

`workspace.list.v1` 是创建实例前唯一的目录发现能力。客户端明确传入 Host 文件系统中的绝对路径；Host 返回规范当前路径、上级路径、目录/目录符号链接和分页事实。它只使用 Host 运行用户已有的文件系统权限，不设置额外根目录或白名单，不读取文件正文、不执行 shell，也不改变任何 Host 或 Worker 的进程 cwd。目录选择完成后仍由 `instance.create(cwd)` 执行既有校验和 project trust；浏览本身不产生信任。

## 附件存储与上传

附件是 Host-owned、单用户、永久文件，不属于 durable catalog、Worker DTO 中的字节载荷或某个 TUI 的私有目录。Hub Settings 在本机私有 state 中配置一个绝对 storage directory；Unix socket 和已配对 mTLS 客户端共享它。Settings change 与 active upload 使用跨进程 claim/lease 协调：有 upload 尚未 complete/abort 时拒绝改目录，避免成功 receipt 指向旧 root。首次提交后目录不能直接改到另一处；需要迁移时先整体移动 `files/` 与 `.alu-dock/` store，再修改配置。Host 不做病毒扫描、格式转换、MIME 强制、自动解压、TTL、GC、quota、per-device/per-instance ACL 或引用计数。

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

1. 发送一个 upload header request：`operationId + name + sizeBytes + optional mediaType + sha256`；
2. Host 返回 `attachment_upload_ready` 与 `maxChunkBytes`，或者直接返回同一 operation 的既有 terminal receipt；
3. 客户端按从 0 开始的连续 index 发送 canonical-base64 `attachment_chunk`；decoded chunk 不超过 Host 宣告值，当前上限 512 KiB，因此每条 JSONL 仍小于 1 MiB control-line bound；
4. 客户端发送一个 `attachment_complete`，其 `chunks` 必须等于已发送数量；
5. Host 只返回一个普通 terminal `response` 并关闭连接。

Host 对 socket input 串行处理、pause/resume backpressure，并以 60 秒 idle deadline 约束未完成 body。`operationId` 仍遵守同一 Host epoch 的 mutation identity：相同 header 重试共享进行中或已完成 receipt，不重复请求 body；同一 ID 换参数得到 `operation_conflict`。若 complete 后 response 丢失，客户端保留结果未知并以相同 operation/header 恢复；receipt 已淘汰时也可用新 operation 重传相同 bytes，content digest 会安全复用。普通 request 的一请求一响应规则不因此变成通用 streaming RPC。

`command.submit` 只携带结构化 opaque `attachments: fileId[]`。Host 在 admission 时解析为 canonical DTO，再与 message 一起进入 direct prompt、Host Queue、runtime Queue、`message.submitted`、`message.completed` 和 persisted conversation。文件 bytes 始终留在 Host store，不进入 catalog、event JSONL 或 `MAX_WORKER_TRANSFER_BYTES` IPC。`attachments.v1` 只约束 `attachment.upload` 以及实际携带 attachment IDs 的 `command.submit` input；一旦消息被接受，attachment metadata 就是 canonical message 的可选组成部分，随 read、follow、history 和 `queue.dequeue` 原样返回。无需显示附件的客户端直接忽略该可选字段，不需要 attachment projection 协商、兼容重试或 Queue 特判。

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

## Agent 观察兄弟实例

只读跨实例观察是 Host-owned control capability。授权绑定发起 `instanceId`、默认关闭并持久化在 catalog；Host 从 authenticated Worker connection 取得 caller identity，每次 list/inspect/watch/cancel 都重新校验授权，并永远排除 caller 自己。目标不是授权白名单：主人把能力交给一个来源实例后，它可以读取任意 sibling，但不能向 sibling 提交消息、停止任务或回答 interaction。

观察状态复用 instance snapshot 的 canonical lifecycle/execution fact；`executionChangedAt` 与当前 running 区间的 `runStartedAt` 是权威时钟，不能用会被 Queue/settings 等变化刷新的 `updatedAt` 猜运行时长。Host-side `InstanceObservationService` 是隔离的 Agent BFF：它通过与 Protocol V2 相同的 instance/history query boundary 读取 canonical facts，默认只列 live sibling，并按普通 `types + limit + cursor` 语义返回清洗后的 conversation message page。它不把 TUI attach DTO、live transport event 或 Host 内部对象暴露给 Worker，也不生成 Host 摘要。

watch 是 Host 内存中的一次性 subscription，不轮询、不占模型 turn。目标已经 idle/stopped/error 时调用同步返回当前结果；否则 Host 订阅 instance state，固定首次 terminal transition 的状态后删除 watch，再向当前来源 Worker 投递仅含 target/reason/time 的 completion。来源/目标 session generation replacement 不改变 stable instance watch；来源 stop/forget、授权关闭会清理，目标 forget 按 unavailable 完成。cancel/off 与 completion delivery 在来源实例栅栏内排序；取消确认后，尚未交付的 completion 不能再次唤醒。watch 不跨 Host restart 恢复或补发。

## Capabilities

Capability 表示当前 Host、Agent Worker 或客户端是否实现某项能力。

- Agent 提供但客户端未实现的能力，只在该客户端不可用；
- 新 Agent 实现现有能力时，不修改 Protocol V2 和其他客户端；
- 真正的新 Agent 能力在 Protocol V2 定义一次，再由需要它的客户端实现；
- capability negotiation 不能成为删除内容或降低其他客户端能力的理由。

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
- `src/control/workspace-browser.ts`：Host 文件系统目录浏览与可恢复错误。

新增功能时先判断它属于 Host control 还是 Agent session。不要把 Agent session 能力塞进 catalog/Managed state，也不要为同一 Protocol V2 shape 在 Worker、Host 和客户端分别维护重复定义。
