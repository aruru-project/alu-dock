# Control、Protocol V2 与 Host

## 这部分负责什么

Protocol V2 是 Dock 对官方 Desktop/Android Client、Hub、Work、Rails/WebUI 和其他自定义 Client 的统一协议。Dock Host Service 通过它提供实例管理和 Agent 会话访问。

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

Inventory 是官方客户端 Resume 与“从保存的 Session 新建 Work”共用的列表来源，二者只差范围（Work 所在目录 / 所选机器全部）和最终动作；Resume 不再向 Worker 取列表。每条附带可忽略的 `lastActivityAt`（最后一条 user/assistant 消息时间，无消息时为 session 开始时间；改名、复制文件不改变它）和 `costTotal`（文件内全部调用已记录费用之和，只作辨认参考，分叉复制来的记录照算；没有记录时省略）。Host 按 `lastActivityAt` 倒序分页：不带 `cursor` 的请求就是第一页，内容与旧客户端读到的一致；还有后续时返回 `nextCursor`，带上它（并在 hello 要求 `session.inventory.pages.v1`）继续读。保存格式读取在 Pi adapter 的 `src/pi/session-inventory.ts`，其持久缓存只存时间、费用等数字和续读位置，不存对话文字；文件只追加时只读新增部分。

### Session gateway

Prompt、conversation、model、tools、settings、session、tree 和 Extension UI 等 Agent 会话能力，由 Host 完成必要的 instance、operation、controller 与 lifecycle 判断后路由给 Worker。

Agent 会话能力由 Worker 实现并产出 Dock event/result；Host 验证归属后沿同一协议转发。

## Main 与 SubHost

Main 是唯一面向客户端的 Host authority。SubHost 只持有一个到 Main 的加密上游连接和本机原生 Registry；它不监听客户端本地 IPC、不启用 Remote Access、不接子节点，也不把远端实例混进本机 Registry。

SubHost 本机状态文件记录进程最近一次观察到的连接状态，Hub 必须连同记录时间展示。它仅表达历史观察；无记录或记录进程已结束时，Main 当前可用性保持未确认。Main 根据自己的 transport 状态判断机器当前是否可用。

SubHost 只上报本机 Registry 的 native snapshots。初始和后续 inventory 都先把完整 canonical snapshot array 序列化，再按 machine-line 边界切成有序 base64 chunks；Main 收齐、按 durable catalog 的既有字节边界校验并逐项解析后才原子 reconcile，初次完成前不发送 `machine_ready`，替换 inventory 未完成时旧连接与旧目录继续权威。Main 在独立、持久的 route directory 中为每个 native instance 分配稳定的 Main `instanceId`；Main identity、trust 和 machine index 保存在 `main.json`，每个 SubHost 的 routes 使用各自 crash-safe atomic route file，并分别受既有 catalog 字节边界约束。两种 ID 不要求相等。客户端只收到并发送 Main ID。普通 response、follow/control、response-transfer、workspace/deliverable stream 和 attachment upload body 都经过同一个 multiplexed Protocol V2 route seam；Host 通过 RemoteInstance 统一转发，具体命令仍由 SubHost LocalInstance 处理。

InstanceManager 是 Main ID、位置和 instance key 的唯一应用 authority；DockRegistry 仍只管理本机原生 instance。MainMachineController 实现 InstanceManager 注入的私有 persistent remote-directory/transport backend：它保存由 Machine inventory 驱动的 binding、tombstone 与 key reservation，但不接收未分类的客户端请求，也不另做 local/remote 业务路由。Key 没有 placement 含义：Main-local snapshot、持久 route 和正在进行的 ensure reservation 共同参与全局认领，已有 owner 保留 key，后来上报的重复 instance 仍按 Main ID 可见但其 Main snapshot 省略 key，SubHost catalog 不被改写。`instance.get_by_key` 始终全局查询；`instance.ensure` 先全局查询，只有 miss 时可选 `hostId` 才选择第一次创建的位置，省略时创建在 Main 本机。同 key ensure 在 authority 外执行实际本机或机器请求，并在 reservation 释放后统一返回最终 owner。

`machine.list` 的每项可包含目标 Host 自报的 `platform`（`linux | windows`）、用户 Home 绝对路径 `homePath` 和原生文件系统根 `workspaceRoots`；Linux 根为 `/`，Windows 根为该 Host 运行用户可访问的盘符根。Main 保存 SubHost 最近一次上报的事实。Home 是 workspace 浏览默认起点，roots 是跨文件系统导航入口；虚拟 `Computer` 等位置只属于客户端投影，不作为 path 发送给 Host。公开 instance snapshot 的 `hostId` 与 machine list 使用同一个稳定 Machine identity，让客户端无需从路径或 Host epoch 推断 placement。

机器边界只有一个 identity mapper：它改写 Protocol V2 的 instance/Host identity 字段、补充稳定 `hostId` 并始终投影 Main-authoritative key，但不进入 message、content、metadata、tool arguments、`workerConfig` 等 Agent/adapter opaque payload。无 instance 的 machine-local request 可带 `hostId`；省略时仍选择本机 Main，保持旧客户端行为。`attachment.upload` 的 `instanceId` 可选：省略时沿用 Main 本机 storage；提供 Main `instanceId` 时，Main 在 body 开始前路由到拥有该实例的 SubHost storage。

Main 对每条转发流沿用 Protocol V2 hello，按 canonical request capability 要求目标 Host 的实际能力。相关联且已验证的 `hello_error` 转成原请求的结构化错误，保留缺失能力明细，经过既有 connection/stream 身份栅栏后只结束该流；不按 Main 的版本猜 SubHost 是否支持，也不把缺能力当机器断线。

每条 logical stream 都有独立的有界串行输入队列和 stream reset；某条 stream 的 backpressure、解析、投影、持久化或客户端输出失败只关闭该 stream，TLS machine link 仍继续处理其他 stream 与 heartbeat。SubHost 的 link liveness 检查不等待 inventory/write 维护任务；Windows 休眠造成旧 I/O 悬挂时，唤醒后的超时检查仍会丢弃半开连接并通过完整 inventory 重连，既有 Registry、Worker、Queue 和 Work 不重启。机器 route 对 `response_transfer` 逐帧复用 canonical Protocol V2 parser，并在 Main identity 投影后继续受同一组 chunk、count 和 aggregate bounds 约束。机器断线只让 Main 的远端目录进入可恢复状态，不停止 SubHost Worker 或已经接受的 Queue。`machine.remove` 是 Main-owned、operation-idempotent 的 trust removal：持久删除 SubHost trust 与 routes 后关闭现有连接，但不停止 SubHost Worker 或 work；重新使用必须再次 join。离线时对 Main entry 执行 stop 只删除 route mapping；成功路由的 stop/forget 则在向客户端发出成功前持久退役该 Main route，同 generation 的迟到 inventory 不能恢复它，更新 generation 可重新取得新的 Main identity。普通转发不在 Main 缓存或重放 mutation；Main-owned global ensure 保留 Main operation identity，转发时仍沿用原 operation ID。SubHost 的全局 Agent Dock tools 使用同一上游 authority，并以 Main source ID 执行；上游不可用时 list/inspect/watch/create/send 立即失败。`dock_create` 省略 Machine 时回到 source SubHost，提供唯一 Machine display name 时由 Main 解析到既有 `hostId` placement。`dock_deliver` 始终由 source SubHost 在本机登记，不依赖 Main 连接。

## Protocol V2

Protocol V2 的记录使用 UTF-8 JSONL，可以承载在两类 transport 上：

- **私有本地 IPC**：POSIX 使用 Unix domain socket，以文件系统所有权和 mode 做 admission；Windows 使用 Named Pipe，以 Windows 本地访问控制做 admission。本机入口不使用 TLS、客户端证书或配对。
- **远程 TLS 端口**：默认关闭；启用后绑定所有网络接口。TLS admission 成功的可信客户端复用本地 IPC 的同一个 Host request handler、DTO 与业务路由。

Transport admission 完成以后，两条路径的 Protocol V2 行为一致：

1. 客户端先发送 hello，并协商版本与 capabilities；
2. hello 成功后发送业务 request；
3. 普通 request 返回一个 response；`session.tree.v2` 成功时改用透明的有界 response-transfer records 重组同一个逻辑 response；未协商整文件模式时 `attachment.upload` 是唯一的多记录 request body；协商 `file-transfer.v1` 的文件请求见下文，仍各自只有一个 terminal response；
4. `instance.read` 读取当前权威视图，`instance.follow` 在初始 response 后持续接收 event；
5. Extension UI 操作使用独立连接，并与读取、实时跟随分别恢复。

### 一条连接多条流（`transport.multiplex.v1`）

上面每一步都以「一条连接 = 一次 hello + 一个 request」计。远程使用时每个操作都要重新 TCP + TLS + hello，切 Work 或读图片就是一串握手；`transport.multiplex.v1` 让客户端把所有请求放在一条已经验证过的连接上：

- 客户端在 hello 的 `requiredCapabilities` 里要求它。hello 成功后这条连接成为**链路**，之后的记录只能是链路记录：`{kind:"stream_open",streamId}`、`{kind:"stream_data",streamId,data}`、`{kind:"stream_close",streamId}`、`{kind:"stream_reset",streamId,reason}`、`{kind:"ping"}`、`{kind:"pong"}`。`data` 是一条完整的 Protocol V2 JSONL 记录（不含换行），链路记录因此最长可达普通记录上限的两倍。链路 hello 里的其他能力不起作用；每条流自己协商。
- 每条流就是上面 1–5 的一条普通连接：客户端 `stream_open` 后在流上发 hello（可与 request 同发，不必等回包）、一个 request，Host 在流上回 hello 回包、response 或 follow event、文件帧。Host 把每条流交给和裸连接相同的处理入口，所以 Main→SubHost 转发、文件窗口、instance records 的行为与裸连接一致。任一方 `stream_close` 等同于这条流的连接关闭；`stream_reset` 只结束这条流并说明原因，链路和其他流继续。
- 客户端定期 `ping`，Host 回 `pong`；客户端在一个 ping 间隔加等待期内没有任何来包就放弃链路，Host 对 60 秒没有任何来包的链路直接关闭。链路关闭时它上面的流全部结束，客户端按各自的规则重连（follow 进入「连接已中断」再重试）。链路记录不合法时 Host 关闭整条链路而不是回错误。
- 一条链路最多 256 条流；输出按紧急（ping/pong/reset）、控制、各流轮流三档排队，单条流的输出或输入超过上限只 reset 这条流。这套流框架与 Main↔SubHost 机器链路是同一份实现（`src/control/stream-link.ts`），机器链路保留 `machine_*` 记录名以兼容已部署的 SubHost。
- 未要求此能力的客户端（Hub/Work TUI、Rails WebConsole、旧版官方客户端）行为不变，hello 后仍只允许一个 request。吊销设备证书时 Host 照旧关闭该证书的所有连接，链路随之结束。

官方 Rust core（`connection_router.rs` / `link.rs`）对每个 Host 的第一条连接仍是普通连接，从它的 hello 回包得知 Host 是否提供此能力；之后同一路由的每次请求都是链路上的一条流，链路断了才重新选址。流上的传输错误不算地址失败，链路自己的存活检测才算。

TLS peer 必须在握手时提供 X.509 客户端证书并证明持有私钥。Host 只把与持久信任记录中 leaf certificate DER 完全相同的连接交给 Protocol V2。无证书或未知证书永远不能发送 hello，也不能调用任何 Protocol V2 request。

配对使用独立于 Protocol V2 的 `pairing.*.v1` bootstrap，仅用于建立设备信任。用户在本机 Hub 的 Devices 页面显式确认并打开五分钟窗口后，同一个 TLS 端口才临时接收未知证书的配对请求。每条未知连接只接收一条有界 request、返回一条 response，然后立即关闭；人工确认只推进 Host 中有期限、有数量上限的 pairing transaction，不保留 socket、stream、callback 或等待中的网络 Promise。TLS handshake、首帧和 response close 分别有 5 秒、2 秒和 1 秒边界；用户批准后的完整证明最多持续 60 秒。

客户端首请求只携带 TLS 客户端证书、设备名和随机数，绝不发送 PIN 或可离线枚举的 PIN verifier。用户在本机选择明确请求并输入客户端显示的四位 PIN。PIN 阶段采用 HomeKit Pair Setup 使用的 SRP-6a 3072-bit/SHA-512 参数；确认出的 session key 再按 HomeKit 的 domain-separated HKDF、ChaCha20-Poly1305 和签名交换形状，绑定 server-generated pairing ID、双方完整证书、本次随机数和双方私钥证明。事务顺序同时遵循 Moonlight/Sunshine 的经验：候选证书保持 provisional、阶段严格单调、全部验证后才原子写入客户端信任，客户端最后以精确 Host certificate pin 建立新的 TLS/Protocol V2 连接再提交 Host 信任。

配对最终保存通过原子认领窗口文件与本机关闭互斥：关闭先认领则不写信任，保存先认领则由保存任务负责收尾。窗口轮询不能把保存认领造成的文件暂时消失当成手动关闭；期间同一次配对的重复请求仍返回正在保存。listener 停止及正常窗口到期仍按原关闭规则处理。

远程地址不属于身份。已配对客户端可以从新的 IP、域名或映射端口连接同一个 Host，只要双方仍使用原来的证书。每次连接仍执行完整 TLS handshake；session resumption 被关闭，不能替代证书检查。吊销删除精确客户端证书信任，并由 Host 关闭该证书的现有远程连接。

Host 设置按一条分界线开放：决定“谁能连进来、从哪连进来”的设置只在本机改，其余 Agent 工作相关的设置配对过的设备也能改。这是防君子不防小人：配对过的设备本就能通过 Worker 做任何事，这里只保证设置页上不能随手改掉信任关系。

- 只在本机：Devices 中的 Remote Access/port、开启/关闭连接窗口、待连接请求、PIN 确认、saved device 列表和移除，SubHost 加入 Main 的信任，以及本机 Dock 角色和 Main 地址。它们是本机 `aludock` Hub 的 service-management surface，不属于 Protocol V2，不通过本地 IPC 或 TLS 暴露，也不在 DockClient、CLI JSON API 或额外 admin endpoint 中提供；远程客户端不能开启或延长连接窗口。既有的 `machine.remove` 仍对所有连接开放，收紧待单独处理。
- 配对过的设备也能改：逐项以 Protocol V2 能力开放，当前是模型隐藏列表（`model.visibility.v1`，见下文）。attachment storage directory 仍只在 Hub Settings 中提供。

Client 发给 Host 的 hello/request 使用 closed JSON-safe shape，未知字段会被拒绝。Host 发给 Client 的 response/event 仍严格校验已知字段、版本、类型和边界，但 Client 必须忽略新增的未知可选字段；只有删除字段、改变既有语义或新增无法忽略的类型时才需要 capability 或协议版本。单 frame 可以有传输上限，但业务内容不能因此永久截断；大型 conversation 使用分页和 chunk 继续读取。持久 record 的 `contentRef` 由 Agent 原生 session 与 entry identity 决定，append、refresh 和 Worker restart 不改变它；revision 与 cursor 只隔离一次分页 scan。

`conversation.references.v1` 允许显式发送 `conversation.history / conversation.content` 的 `view: "references"`。此视图的 `contentComplete` 表示文字、工具信息与图片位置/引用已齐全，不表示图片已下载；正文分页的图片块为 `image_ref {blockIndex,mimeType,contentRef?,fileId?}`，没有 `data`，原图仍由 `conversation.image` 读取。普通文字即使像 Base64 也原样保留。省略 view 的旧请求保留原 `contentComplete` 与 image/data chunks，hello 广告能力不改变请求语义；新旧视图共享生产器与稳定 contentRef，但 continuation 绑定请求视图。Main 在转发业务前向 SubHost 要求同一能力；TS 显式引用调用和官方 Rust reader 仅在明确 `capability_missing` 且 missing 指向此能力时回到旧接口，不按未知参数或其他读取错误降级。同一次历史 scan 与正文续读沿用首次确定的视图：官方 Rust 把它放在既有读取上下文与 descriptor；TS 通过调用者传入并沿链复用的 `ConversationReadContext` 明确选择引用读取。没有全局能力缓存、预查询，也不解析 opaque cursor。

`conversation.content.stream.v1` 提供显式 `conversation.content.stream {instanceId,contentRef}`：一次连接完整读取一个引用视图正文。它同时要求 `conversation.content.v1`、`conversation.references.v1` 与 `file-transfer.v1`，不改变旧 history/content 请求。Host 按需读取现有 Worker 引用页，把每个 canonical content chunk 编为一条 UTF-8 JSONL，经共用字节窗口交付；不读取会话磁盘文件、不聚合整篇正文，也不在网络等待期间持有 Worker 查询。`file_ready.metadata` 仅含 `contentRef/revision/runtimeGeneration`；terminal response 的 result 在这些字段外含根 `instanceId` 及 `chunks/sizeBytes/sha256`。Main 只映射根身份，metadata 和正文仍不透明。每条记录沿用协议 record 上限，没有额外正文总长限制。整个读取核对来源与运行代次，正常追加不作全局 revision 失效。

官方 Rust 在固定 References 上下文中优先使用连续读取；仅 ready/bytes 前明确缺新 stream 或 file-transfer 能力时，回到相同引用视图的旧分页，不改成 Legacy，不对普通错误或部分结果重试。已选择 Legacy 的读取直接沿用旧页。JSONL 接收器逐记录调用既有正文 assembler，全部完整性、终端身份和块连续性检查完成后才提交。TS 的 `conversationContentStream` 是显式新入口，逐块 callback 在 promise 成功前均为临时结果；旧 `conversationContent` 不变。未选择下述 instance records 的首次读取与 follow/event 保留旧 framing。

`conversation.images.v1` 在独立 Protocol V2 连接上以 `conversation.image {instanceId,contentRef}` 读取原生 conversation image。Host 先发送包含 MIME、decoded size 和 lowercase SHA-256 的 ready，再发送从零连续、decoded bytes 最大 512 KiB 的 chunk，最后发送带总 chunk 数、size 和 SHA-256 的 complete；ready 后失败发送专用 error，客户端丢弃已收 bytes。DockClient 逐块调用 callback、独立 hash 且不缓存完整图片。Worker adapter 在一次 Agent request 中产出 immutable image body，Worker 边界与 Host 复用同一 parser 校验 bytes/size/SHA；Host 只按 socket drain 背压切成公开 stream frame，既有 `conversation.content` 保留。Main/SubHost 仍通过通用 machine stream route，identity mapper 只改 frame root 的 Host/instance identity。

`session.tree.v2` 专指当前 Pi Session Tree。请求只有 `{instanceId}`，一次逻辑调用返回一个完整 compact snapshot `{nodes, leafId?}`；node 只含 ID、拓扑、kind/role、展示标签、时间、摘要和 children fact，不含 Pi JSONL entry、完整 message 或 tool content。Host 不缓存、分页、revision 或解释树拓扑，只做 lifecycle、admission、generation fencing 和路由。

完整 Tree response 即使只有一块，也使用 transport-only `response_transfer` records。每块是普通成功 `ControlResponse` UTF-8 序列化后的 opaque canonical-base64 byte slice；DockClient 检查同一 request/Host identity、从零连续 index、稳定 count、单块和 aggregate transport bounds，收齐后才解析原 response。缺块或越界没有 partial result。该 framing 在本地 IPC 与 mTLS Protocol V2 上相同，只承载成功的 `session.tree.v2` response；错误仍是一条普通 response，也不形成通用 streaming RPC。

`session.compaction-prompts.v1` 提供只读 `session.compaction.prompts {instanceId}`，返回完整 `{system, summarize, update, turnPrefix}` 四个字符串。它是 instance/query/unary，无 operation、snapshot、分页或文件 contentRef。Pi adapter 直接返回 public SDK 的原生默认模板；Worker 与 DockClient 复用唯一 result parser，Host 只路由。它不是当前 provider 请求，也不代表扩展接管压缩时使用的自定义提示，动态对话/旧摘要和可编辑补充说明不混入模板。

普通 Follow 的同代 sequence 只要求递增，不要求相邻：Host 从共用 journal 过滤 controller-only 事件，但不重新编号，也不把私有事件广播来补号。Client 仍校验 Host/Work/generation、重复倒序、truncated 与真实断线边界；只见序号跳跃不能触发重建。

Protocol V2 是外部合同。Host 与 Worker 的内部重构不应要求现有 TUI 或 Web 客户端重写。

`instance.worker-config.v1` 允许 `instance.create` 增加可选 `workerConfig` bounded JSON object。Generic Host 只在 wire、operation 和 durable catalog 边界验证 JSON 大小/深度并原样路由、恢复；字段名称和含义完全属于目标 Worker adapter，Host、Main/SubHost identity mapper 与客户端通用 DTO 不解释 Pi option。使用该字段的客户端必须在 hello 中要求 capability；不使用时 `instance.create` 保持既有 shape。`instance.ensure` 和 adopt 不接受该创建配置；Agent-facing `dock_create` 只允许选择 system ID，不开放 generic workerConfig 编辑。

`workspace.list.v1` 是创建实例前唯一的目录发现能力。客户端明确传入 Host 文件系统中的绝对路径；Host 返回规范当前路径、上级路径、目录/目录符号链接和分页事实。它只使用 Host 运行用户已有的文件系统权限，不设置额外根目录或白名单，不读取文件正文、不执行 shell，也不改变任何 Host 或 Worker 的进程 cwd。目录选择完成后仍由 `instance.create(cwd)` 执行既有校验和 project trust；浏览本身不产生信任。

`workspace.files.v1` 是 active instance 的 Host workspace 只读能力。每次请求以受理时 snapshot 的 `cwd` 为根，path 使用 workspace-relative 形状且根为 `.`；`workspace.entry.list/get` 返回隐藏条目和不含 Host 绝对路径的 workspace metadata，`workspace.file.read` 在独立连接中按 ready/chunk/complete-or-error 顺序读取正文。Host 拒绝 absolute、`..` 与逃出根目录的符号链接，并在 open 后再次核对实际文件对象仍位于根内。安全的 contained symlink 可按目标类型读取或遍历；外部、断链或 loop symlink 仍可列出为 `targetKind: unavailable`，但不能打开。stop 后的新请求拒绝，reopen 后按普通 active instance 使用。

## 整文件传输

客户端在既有 hello 的 `requiredCapabilities` 加入 `file-transfer.v1`，随后仍发送原业务请求：`attachment.upload`、`workspace.file.read`、`deliverable.download`、`file.read`、`resource.content` 或 `system.content`。它不开放任意路径，也不需要先查能力。未要求此能力的旧调用保留原帧/分页行为；整文件读取只接受起点 offset 0。`conversation.image` 与 history 不属于这个能力；会话正文仅上文显式的新 stream 请求复用这些字节帧，不属于六种文件业务，也不因 hello 广告而改写旧正文请求。

协议在 `protocol.ts` 定义一次，各帧带 `version: 2 + requestId + hostEpoch`：

- `file_ready`：`direction: upload | download`、`maxChunkBytes`、`windowBytes`，下载可含原业务的 `metadata`（entry、deliverable、file 或 revision）。既有 workspace 接收策略在写 sink 前检查 metadata。
- `file_chunk`：从零连续的 `index` 与 canonical-base64 `data`。内容仅是字节，传输不解释图片或文本。
- `file_progress`：累计 `receivedWireBytes`（实际收到的 JSONL 字节，仅作进度，不是跨转发的精确记录匹配）和 `consumedBytes`（sink 成功消费的字节）。两者不能倒退，至少一项前进才算进度；消费量不能超过发送量。
- `file_activity`：`inTransitBytes` 只累计中转处实际收到的半帧数据字节，用于存活判断，不放出任何消费窗口。转发出口分别记住两侧已接纳的累计量，只合并新增量，不回送放大；重复值不能续命。
- `file_complete`：`chunks + sizeBytes + sha256`。收发双方独立核对计数和 SHA-256，之后仍须收到普通 terminal `ControlResponse`，才能取得业务结果。上传完整不等于附件已提交；操作去重、fsync、发布与 receipt 仍由 AttachmentService/operation ledger 管理。

当前正常 chunk 为 64 KiB，消费窗口为 256 KiB；单块安全上限复用 control base64 上限。窗口在两个方向都只由最终接收端的消费确认释放，最后一块消费后才发 complete。Main/SubHost 只转发帧，不拼装或重新编码文件。本项目文件编码器先写可识别的共同头；JSON parser 仍接受其它字段顺序。半帧观察只认有界的标准头和已协商流，不从正文猜类型；activity/progress 自身不产生 activity。Main 等目标 hello 成功后才发原业务请求，并只反向映射帧根部 hostEpoch。现有 MachineWriter 在跨流容量不足时按序等待，每流生产者仍有界，heartbeat/control 保持优先，不增加私有机器协议。

文件字节阶段以真实数据传输（包含未收齐一整行时实际到达的字节）或前进的接收/消费进度计算 60 秒空闲；重复进度不能续命，不沿用旧五秒 drain 截止。Rust 字节写入按实际 partial write 和并行接收的前进进度续期，不再套普通 RPC 的固定整帧写入截止；慢 sink 按实际成功写入部分报告消费。TS 上传在 ready 后只用文件空闲规则，complete 后回到业务回执计时。客户端慢于五秒仍能继续，窗口不足时发送者等待，不占用 Worker query reservation。关闭连接、取消、实例结束或来源 generation 改变会释放 source/sink/等待者。整文件 source 只打开一次；published/resource/system 的文件身份在传输后再次核对，workspace 保留读到 EOF 的语义。

TS `downloadPublishedFile/resourceContentAll/systemContentAll` 与既有 workspace/download/upload 方法、Rust public 文件方法使用共用收发器。仅在执行/数据开始前明确收到缺 `file-transfer.v1`，才用旧帧或显式旧页 API 重试；普通错误、取消或部分数据不得降级。TUI/官方资源正文阅读调用整文件方法，Vue 不再自行分页。原来的 `readFile/resourceContent/systemContent` 页方法仍可显式使用。

实现入口：`file-transfer.ts` 管字节收发/校验/消费窗口，`file-channel.ts` 管专用 socket 与空闲，`client-file-transfer.ts` 管客户端文件握手与新旧 wire codec，`host-file-transfer.ts` 选择已授权来源并收尾；磁盘 byte producer 在 `core/source-file.ts`，旧分页和连续读取共用它。官方 Rust 的同一职责在 `file_transfer.rs`，各业务模块只保留请求、metadata、旧帧 codec 与提交语义。

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

`command.submit` 只携带结构化 opaque `attachments: fileId[]`。Host 在 admission 时解析为 canonical DTO，再与 message 一起进入 direct prompt、Host Queue、runtime Queue、`message.submitted`、`message.completed` 和 persisted conversation。文件 bytes 始终留在 Host store，不进入 catalog、event JSONL 或 `MAX_WORKER_TRANSFER_BYTES` IPC。`attachments.v1` 只约束 `attachment.upload` 以及实际携带 attachment IDs 的 `command.submit` input；一旦消息被接受，attachment metadata 就是 canonical message 的可选组成部分，随 read、follow、history 和 `queue.dequeue` 原样返回。无需显示附件的客户端按通用可选字段规则忽略它；附件展示共用同一响应与 Queue 语义。

聊天消息中 media type 为 `image/*` 的附件同时具有两项 canonical 语义：它仍是可 resolve、下载和交给工具的永久 attachment，并由 Agent adapter 通过私有 resolve path 加入同一条 Agent 请求的原生 image input。Dock 不按当前模型判断视觉能力，也不要求客户端增加 image mode 或让 Agent 先 read；模型能力与旁路处理由 Agent runtime 决定。持久和 live user content 中对应 image block 使用可选 `fileId` 关联同一 `AttachmentDto`。Host 完整保留两项事实，客户端按 `fileId` 关联决定合并展示或分别展示。

## Published files 与读取

`published-files.v1` 提供 authenticated `file.read`。公开 `PublishedFileDto` 固定为 `presentation: "image" + fileRef + name + sizeBytes + optional mediaType`，不含 Worker path；客户端按 `presentation` 决定显示意图，不从 tool name、文件扩展名或文本猜测。Host 校验 instance/lifecycle，经私有 `resolve_file_source` 向当前 Worker 取得已登记的文件路径和发布时的文件身份，再由 Host 直接读取。Unix socket 与 mTLS 共用这条读取路径；Worker 不传文件字节，Host 不另建 registry 或 media store，来源路径不进入公开响应。

未协商整文件模式的 `file.read` 使用明确的 `fileRef + offset`，每页 decoded bytes 最多 256 KiB。response 的 `offset` 必须等于请求 offset，`nextOffset` 必须精确等于本页末尾；complete page 必须恰好到达 `sizeBytes`。registry 只在 Worker 当前 session/generation 内存活，session replacement、dispose、handle 淘汰、源文件删除或改写都返回 `file_unavailable`，客户端应让用户要求 Agent 重新发布，而不是重试任意 path。

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
- `runtimeGeneration`：instance 内一次 runtime/session generation；tool、setting、resource、command catalog 和 Extension UI 也属于该 generation，客户端不得把旧缓存带入新 generation，也不得把 generation 切换时的本地清空解释为 Worker 返回了空 catalog；
- `operationId`：一次调用者 mutation 意图；
- attachment `fileId`：Host logical attachment metadata 的 opaque identity；多个 `fileId` 可以引用同一份 content bytes，它不是路径；
- event cursor：一次 read/follow reconnect 的观察位置。

客户端不能用 name、cwd、Agent session ID 或文件路径代替 Dock instance identity。Snapshot 中可选的 `name` 是当前 Agent session name，不是稳定的 Dock 实例名称。Snapshot 始终携带 `displayName`：Host 统一按 `name → key → cwd fallback → Work` 生成安全的人类展示标签；其中 cwd fallback 只保留 ASCII 字母、数字、空格、下划线和横杠，最长 20 个字符，任意异常都降级而不能使 snapshot/list 失败。`displayName` 不持久化为 session name，不参与 TARGET、key 或 instance identity；客户端只负责渲染，操作仍使用 `instanceId`。

## Mutation

Host 对 mutation 负责 admission、operation 去重和结果归属。客户端发送 mutation 后遇到断线或无法确认的 response，不能自动重放；应查询当前状态，并在仍无法确定时保留结果未知。

显式 stop 先持久化 stopping intent，再清理 Worker；完成提交直接把 instance 从 catalog 退役，同时向调用者和已连接客户端发布最终 stopped 状态。Agent 自己的持久 session 不属于 Dock catalog，stop 不删除它。Host shutdown、Host loss 和可恢复 runtime error 不是显式 stop，必须继续保留 reopen 所需的 catalog 记录。

CLI 启动 Host 完成后，执行一次后台恢复批次，对本机 catalog 中可 reopen 的实例各尝试一次，并发复用手动 `instance.reopen` 的同一 operation/Registry 处理及 Host 在途请求收尾；不阻塞启动、不触发模型续跑、失败留给手动处理，明确 Stop 退役的实例不恢复。Main 不触发远端实例恢复。SubHost 同样处理本机实例，初次握手清单与心跳照常；启动恢复期间暂缓常规 inventory 更新，批次成功/失败全部收尾后集中刷新一次，断线重连仍发送当前完整清单。

Worker 接受副作用前失联和接受后失联是不同结果。Host 必须保留这个区别，不能把可能已经执行的 mutation 当成普通失败重试。

附件上传的 `operationId` 在 header admission 时保留；同一参数的并发、completed 或 response-loss 重试共享 receipt，不重新执行 body effect，不同参数冲突。内容 SHA-256 另提供跨 operation 的永久 bytes 去重，不把 endpoint、文件名或客户端路径当 content identity；清洗后的 name/media type 只参与 logical attachment identity。

消息提交中，Host 的 admission result 使用 Worker 报告的实际 delivery。`operationId` 是直接 prompt 与 Queue message 共用的提交身份；`queueItemId` 只属于确实等待过的 Queue item。一个 Host-deferred Queue item 可以在 Agent 恢复空闲后以 `prompt` delivery 被消费，此时 `message.submitted` 仍保留它真实的历史 Queue identity；普通 direct prompt 没有该 identity。若辅助关联异常，Host 省略这个可选 identity，canonical message 仍正常发布。Host 不根据 catalog 中稍早的 running 状态替 Agent 决定最终 delivery。用户必须始终能确认消息处于以下哪种状态：未接受、在 Queue 中等待，或已被 Agent 消费并出现在 conversation。Agent 的 input hook 接管的消息不进 Queue、不出现在 conversation，Host 以 `command.handled`（`no_run`）结束这次提交；Protocol V2 receipt 只有正在运行的 command 才能是 immediate，所以另一轮运行中接管的消息 receipt 按 queued 形式返回，随后同样以 `command.handled` 结束。Host 未要求 defer、Worker 却报告 Host custody，表示 Agent 正在收尾：Host 像 compaction 期间一样保管消息，等 Agent 发布 `agent_settled` 后再交出。运行中送达 Agent 的中止让这一轮以 `aborted` 结束，即使最后一条回复本身已完成（例如中止发生在自动压缩期间）。

`run.abort-restore-queue.v1` 提供 `command.abort_restore_queue {operationId,instanceId}`：一次 mutation 停掉当前回复（含压缩和 Tree 摘要），同时取回所有尚未交给 Agent 的 Queue 消息。结果与 `queue.dequeue` 相同，为 `{receipt:{operationId,instanceId,restored,inFlight},instance}`，instance 已不在运行、Queue 为空；`restored` 按原消费顺序给调用者放回输入框，`inFlight` 只列出已被 Agent 取走、会出现在对话中的消息。旧的 `command.abort` 与 `queue.dequeue` 语义不变。官方客户端与 Work TUI 的“中止”只调用它；仅在请求开始前明确收到缺少此能力时，才对旧 Host 依次调用取回与中止。

### 用户 shell 命令（`bash.v1`）

`bash.run {operationId,instanceId,command,excludeFromContext}` 对应 Pi 的 `!`（`excludeFromContext:false`）与 `!!`（`true`）：在 Work 所在机器和目录运行一条命令，并由 Agent 记进 session。Worker 一开始执行就返回 `{receipt:{operationId,instanceId,startedAt},instance}`；输出与结束以 conversation frame 到达：`bash.started {operationId,command,excludeFromContext}`、`bash.output {operationId,delta}`、`bash.completed {operationId,exitCode?,cancelled,truncated,fullOutputPath?,error?}`。运行中的命令不改变 `execution`，也不占用 admission；Agent 正在回复时也可以执行，记录由 Pi 在本轮结束后按序写入。`bash.abort {operationId,instanceId}` 让这个 Work 正在跑的**全部**命令停止，与 `command.abort` 无关，各命令仍各自发 `bash.completed`。会话替换期间拒绝为 `instance_busy`；替换本身会让 Pi 中止旧命令并把已中止记录留在旧 session，新 generation 不出现它们。

Host 只记「有哪些命令在跑」：`bash.started` 与 `bash.completed` 进入 conversation bootstrap 的 active frame，并在 Worker checkpoint 指名该命令记录尚未写入时继续保留；`bash.output` 只走 event ring 和 follow，不为迟到的读者缓冲或补发。

**路径显示特例**：`bash.completed.fullOutputPath` 与持久 `bash_execution.fullOutputPath` 是 Pi 在 Worker 所在机器写下的临时完整输出文件路径。Dock 只显示它（供用户复制、或让 Agent 用自己的 `read` 去读），不接受客户端拿任何路径让 Host 读文件；这不是欠账。

## Read、follow 与 Extension UI 操作

`instance.records.v1` 为完整初始内容和持续事件提供显式逐条交付。客户端必须在 hello 要求该能力，并在 `instance.read / instance.follow` 发送 `delivery: "records"`；仅广告能力不改变旧 V2 响应、字段、错误、游标或传输预算。Main 同样向目标 SubHost 要求该能力，不按 Main 的版本猜测目标支持。

每条逻辑记录分别编码为 UTF-8 JSON，经 `instance_record_fragment {version:2,requestId,hostEpoch,recordIndex,index,count,data}` 交付；`data` 是 canonical base64，recordIndex 从零递增，每条记录的 index 从零重置、count 固定。复用文件字节传输的 64 KiB fragment、256 KiB 窗口和共享的 256 MiB **单记录**安全界限，没有初始总量界限。初始顺序为原成功 response（events/recentHistory 空数组的 metadata）、read 的逐项 `instance_history {entry}`、原 event envelope、`instance_ready {historyEntries,eventCount}`；这两种逻辑标记同样带 version/requestId/hostEpoch。只有 ready 计数与已收内容一致，客户端才提交同一个原结果。read 随后结束；follow 在同一连接继续独立事件记录。原历史范围、隐藏的 controller 事件、真实 truncated/epochChanged/generationChanged 不变，不再为单行或 1,000 条限制丢内容。

`instance_record_progress {receivedWireBytes,consumedBytes}` 逐块确认有界当前记录的接收，不表示 UI 或会话游标已提交。Main 每次只拼装、按既有 identity mapper 映射一条，再在下游窗口发送；两段各自计字节，不能把身份改写前后的 ACK 直接互转。`instance_record_activity {inTransitBytes}` 只转达实际半帧字节或映射后下游的真实进展，不释放消费额度；重复通知、普通 heartbeat 不能续命。小记录共享尚未耗尽的窗口，不逐条等待 ACK 往返；只在初始交接、正常结束或退役收尾等交付边界等待全部消费确认。应用队列已空但仍有未确认字节时，空闲期限继续生效。文件传输的原端到端 credit 语义不变。新模式有待交付内容时使用真实进度空闲期限，稳定 follow 无事件时无限安静；慢链路不套旧五秒 drain 或三十秒整次请求期限。

Host 初始仍只取同一次权威投影，follow 仍先订阅再取投影、按原边界交接去重。发送中记录与普通 backlog 分开计账，普通 backlog 外允许一个超出旧队列字节预算、但合法的大项；初始化期间同样适用。持续过载可以断流，不能据此声称无限积压或整个 App 常量内存。接收端初始内容仍按请求范围暂存，ready 前的取消不提交半份结果。

TS 默认 read/follow 不变；传入并复用 `InstanceDeliveryContext`（或 streamEvents/follow 的显式 records 选项）选择新模式。Work TUI 的观察调用显式复用该上下文。官方 Rust `ConversationObservation` 在 owner 内自动选择 records，仍由既有 `SessionContent` 接纳初始和 live。仅首次任何 fragment 之前明确 `capability_missing` 且 missing 含此能力时，才允许用原请求回到旧模式；同一观察一旦选定 records，重连也不得换回旧模式。没有能力预查询、全局缓存或额外 UI/storage owner。

`instance.read` 返回当前 snapshot、conversation bootstrap、Queue 与读取边界。conversation bootstrap 由同一边界下的两部分组成：

- `recentHistory`：Worker 产生的当前分支权威持久 record；
- `page.events`：尚未被 Worker persistence checkpoint 接住的 active conversation frame，以及仍在等待的 interaction。

持久 record 使用通用的 `recordId / kind / source / visibility / content / metadata` shape。Worker adapter 保留 Agent 的 message、tool、custom message、bash、compaction/branch summary 和 session metadata 语义；Host 不把它们压成 role，也不按文本或 tool 内容猜测 live frame 是否已经持久化。

`instance.follow` 从 read boundary 开始补齐后续事件并持续跟随。保有本地画面且 cursor 连续时，客户端只消费 `event_log` replay 和 follow；不重新拉取历史。event ring 截断、Host epoch 改变、runtime generation 改变或本地状态丢失时，客户端丢弃旧 conversation，重新读取完整 bootstrap。不得把两次 history 读取边界拼成一个会话。普通 `session.history` page 与 bootstrap seed 都携带 Host `historyRevision`；分页中 revision 改变时客户端必须放弃该次 scan 并重新 bootstrap。History 只在完整语义单元之间分页：包含 tool call 的 Assistant record 与已经持久化的对应 tool-result records 不得被 record limit 或 Host 传输裁剪拆到两页。请求的 limit 是目标 record 数，单个完整语义单元可以使响应超过该数。

Worker persistence checkpoint 确定 active frame 的释放边界。Host 按 generation、sequence 和 checkpoint 暂存或释放 frame，不等待客户端 ACK，也不维护接收名单；不按内容 fingerprint 做匹配或去重。任意数量的客户端可以同时读取和跟随，观察连接中断时 Agent runtime 和 instance 继续运行。

Extension UI 操作使用独立连接，同一 instance 同时只有一个。新连接立即接手，旧操作连接结束但它的普通 follow 不受影响；等待中的 interaction 属于 runtime generation，不因接手或断线而被回答或取消。

## Agent-facing Dock tools

Dock tools 是 Host-owned、按来源 `instanceId` 绑定的本机工作能力。开关默认关闭并持久化在 catalog；Host 从 authenticated Worker connection 取得 caller identity，每次操作都重新校验，Worker request 不能声明或替换 source。开关按来源实例授权：主人开启后，该来源可以访问同一 Dock 中的 Machine 与 sibling，按需读取、等待、创建 peer 或发送明确带来源的消息；不设置目标白名单，也不能停止实例、回答 interaction 或调用任意 Agent 私有方法。新实例永远从 off 开始，也不继承创建者状态。

`dock_list` 与 `dock_inspect` 是两条 closed request：list 只投影 instance snapshot 的短状态，`scope=live` 排除 terminal catalog history，`scope=all` 才包含；它不读取任何 conversation。inspect 必须提供一个 human target，Host 解析后永远排除 caller 自己，再按普通 `types + limit + cursor` 语义返回按消息条数分页的清洗后 conversation page；选中的消息正文保持完整，不做字符截断。状态复用 canonical lifecycle/execution fact；`executionChangedAt` 与当前 running 区间的 `runStartedAt` 是权威时钟，不能用会被 Queue/settings 等变化刷新的 `updatedAt` 猜运行时长。Host-side `InstanceObservationService` 不把 TUI attach DTO、live transport event 或 Host 内部对象暴露给 Worker，也不生成 Host 摘要。

watch 是 Host 内存中的一次性 subscription，不轮询、不占模型 turn。目标已经 idle/stopped/error 时调用同步返回当前结果；否则 Host 订阅 instance state，固定首次 terminal transition 的状态后删除 watch，再向当前来源 Worker 投递仅含 target/reason/time 的 completion。来源/目标 session generation replacement 不改变 stable instance watch；来源 stop/forget、Dock tools 关闭会清理，目标 forget 按 unavailable 完成。cancel/off 与 completion delivery 在来源实例栅栏内排序；取消确认后，尚未交付的 completion 不能再次唤醒。watch 不跨 Host restart 恢复或补发。

`dock_machines()` 复用 Main 的 canonical Machine facts，并只在 Agent-facing 文本中呈现名称、在线状态、平台、Home 与 roots，不呈现内部 `hostId`。`dock_create(cwd,name?,machine?,systemId?,saveDefault?)` 由 Main 将可选的精确 Machine display name 解析为 `hostId`，省略时使用来源 Machine，然后通过普通 DockClient → DockHost → InstanceManager 路径执行 Protocol V2 `instance.create(hostId)`，因此复用 operation ledger、canonical cwd、project trust 与 catalog transaction；它不新增 placement 协议，也不接受 Pi 启动参数。`dock_send(target,message)` 同样通过普通 `command.submit` 路径，在 Host 解析 target 和 source display name 后提交固定可见来源包装的正文，并使用普通 `auto` delivery。目标看到的是持久化的普通 user message，Queue 与 receipt 语义不分叉；正文逐字保留，来源显示人类名称而不是 UUID。

## 资源正文阅读

`resource.get` 的可读资源附带可选 `contentRef`。`resource.content.v1` 提供 `resource.content {instanceId,contentRef,offset?,revision?}`，返回 `{text,revision,nextOffset?}`；没有 `nextOffset` 表示完整读取。首请求读取磁盘当前文件，续读携带返回的字节位置和 revision，文件变化或不可读取时返回 `resource_unavailable`。不接收客户端文件路径，不改写 `command.content` 的已加载模板正文语义。

Worker 只解析当前登记的资源引用并通过私有 `resolve_file_source` 返回路径；拥有该实例的 Host 使用 `readResourceContent` 读取当前磁盘文件，产出既有结果并复用 `protocol.ts` 的唯一 parser。旧页读取在同一次 instance 查询内完成；连续读取只让来源解析占用短查询，随后由 Host 订阅生命周期取消长传输，来源不跨请求缓存。官方客户端在项目状态点击资源后复用 MarkdownDocumentSurface 的阅读、原文和复制功能，返回列表后再次打开重新读盘。

## 模型隐藏列表（`model.visibility.v1`）

每台 Host（Main 与各 SubHost）持有自己的隐藏列表，按 Pi 的 `provider + id` 精确到单个模型。它只是选择列表的显示过滤，不是禁用：

- 拥有 Worker 的 Host 在 `model.list` 把 Worker 结果返回前删去隐藏条目，`total` 同步减去，响应形状不变，所有客户端不改就搜不到它们。Main 把 SubHost Work 的 `model.list` 原样转给 SubHost，因此各机器只用自己的列表。
- `model.set`、Pi 自己的 scoped models 与 extension 的模型调用不受影响；当前模型即使被隐藏，snapshot 仍照常报告它。
- `model.visibility.get {hostId?}` → `{models,total,truncated,hidden,fileProblem?}`：`models` 是这台机器新建 Work 时可选的模型，和 Work 的 `model.list` 同一生产者、同一上限；不需要该机器上有 Work。Pi adapter 用一个短命进程按 Worker 的方式加载 Pi（用户 login shell 环境、全局 extensions），extension 代码不进入 Host 进程；只由项目级 extension 提供的模型不在其中。同一 Host 同时只运行一个这样的进程，并发读取共用结果；整次读取在 20 秒内给出结果或错误，留在客户端 30 秒请求期限之内。`fileProblem` 说明手工编辑的文件为何不可用，此时 `hidden` 为空且该机器暂不隐藏任何模型。读不到可选模型时返回 `model_catalog_unavailable`。
- `model.visibility.set {operationId,hostId?,hidden}` → `{hidden}`：整份替换，去重并排序后原子写入，最后一次保存为准；沿用 operation ledger。写入失败返回 `model_visibility_write_failed`，原列表不变。
- 两条请求都是 directory-scoped，按可选 `hostId` 复用 InstanceManager 的机器路由；Main 向目标 SubHost 要求同一能力，旧 SubHost 得到 `capability_missing`。模型列表上限（`MAX_MODEL_LIST_BYTES` 等）与 `hidden` 的序列化上限 `MAX_HIDDEN_MODELS_BYTES` 都定义在 `protocol.ts`，后者取一条控制记录减去完整模型列表后剩余的空间；请求、响应和文件共用同一 parser。

列表存为 Host 私有状态目录下的普通 JSON `model-visibility.json`（位置与格式见 [local-install](../local-install.md#隐藏的模型)）。Host 每次返回模型列表时现读，人或 Agent 直接改文件无需重启。没有持久状态目录的 Host 不提供这项能力，模型列表原样返回。

## 创建前 system 选择

`system.templates.v1` 提供 directory-scoped 能力，三条请求都接受绝对 `cwd` 和可选 `hostId`；Main/SubHost 复用 InstanceManager 的 directory routing，不创建临时 Work、不触发 trust 或加载 extensions。

- `system.catalog {cwd,hostId?,cursor?,limit?}` → `{cwd,candidates,total,revision,warnings,defaultSelection?,nextCursor?}`。候选按项目 `.pi/SYSTEM.md`、原生 agentDir 的 `SYSTEM.md`、目标 Host Home 下 `.aludock/systems/*.json` 文件名顺序返回。`nextCursor` 必须续读到缺省，不能只展示第一页；有效 `defaultSelection` 独立返回，即使不在当前页也可直接用于创建。
- 候选的唯一 DTO 是 `protocol.ts` 中的 `SystemCandidate`：`{id,name,kind,path,workerConfig,warning?}`；`kind` 为 `project-system | global-system | dock-template`。`id` 是 cwd-bound opaque identity，不是文件路径。`warning` 表示该候选当前不可使用；可以预览原文并让用户修复或重选。
- `system.content {cwd,hostId?,id,offset?,revision?}` 只读当前目录候选，不接受任意路径。与 `resource.content` 共用 `readResourceContent` 和唯一的 `ResourceContentResult` parser：`{text,revision,nextOffset?}`，字节续读、UTF-8 和文件变化处理完全一致。
- `system.default.set {cwd,hostId?,id,operationId}` → `{selection}`。这是独立的显式保存操作，复用 operation ledger。只写本目录 `.aludock/system-default.json` 的 `{id}`，不继承父目录、不保存正文。普通查询和本次确认都不写这个文件。

创建默认归实际创建 Worker 的 Host：`DockRegistry.createNew` 在 project trust 完成、cwd 规范化后解析最终 `workerConfig`，覆盖 `instance.create` 和 `instance.ensure` 新建。显式 system 选择优先；省略时使用本目录保存的默认；仅在未配置目录默认时使用 Pi 原生行为。其他 `workerConfig` 字段不会关闭 system 默认。已配置但损坏、不可读或目标缺失时返回 `system_default_unavailable`，不静默换正文，新旧客户端一致。最终配置进入既有 creation/catalog 路径；同一创建操作不重选默认，ensure 命中已有 Work、adopt 和 reopen 不重新应用目录默认。

客户端只在用户明确选择时，将候选 `workerConfig` 原样传给 `instance.create`；使用 Host 默认时省略选择，不把 catalog 的旧快照变成本次 override。显式选择、目标 Host/cwd 在 project trust continuation 中保留。预览、刷新、返回、取消均不创建 Work。坏默认在 catalog 中仍作为 warning 展示，让支持选择的客户端可以明确改选；不代替创建边界的报错。保存默认与 create 有各自的 operation/失败结果，不合并成一次成功提示。

Host 的 `SystemService` 由 Registry 持有，Host 的 system API 复用同一实例；它拥有目录默认和 Dock 模板文件事实。Pi 原生来源、五字段模板校验、显式选择识别及 opaque workerConfig 合并由组合入口注入的 provider 负责。CLI 的 Main/SubHost 均使用已解析的原生 agentDir 与机器本地 Home。首次 catalog 发现触发初始化；默认解析、content 和 default.set 不初始化模板，不能通过读取缺失来源来复活它。首次初始化（尚无 marker）时，即使 systems 目录已存在，也会在缺少 `pi-default.json` 时由 fork SDK 的 `getDefaultSystemPromptBody()` 原样序列化生成；已有用户正文不覆盖。完整正文以不覆盖目标的方式发布，校验可用后才写 Home `.aludock/systems-initialized`，生成或写入失败可重试。这个文件是一次初始化标记，不是目录选择；标记存在后删除模板或整个 systems 目录都不会重建文件来冒充保存默认仍有效。

官方 Client、Hub/direct new 保留选择和阅读界面；有效目录默认可直接进入创建，由 Host 在创建时应用，否则由用户明确选择。owner-enabled `dock_system` 使用同一发现/阅读请求；`dock_create` 有 `systemId` 时显式覆盖，无 ID 时直接走普通创建，不先查 catalog 或要求默认必须存在。`saveDefault: true` 必须同时提供显式 ID。Main/local 工具复用 OperationLedger 保存调用意图及独立保存/创建结果，不另写默认规则或机器代理。

## 命令发现

`command.catalog` 返回命令所有者提供的名称、说明、来源和能力事实。静态参数用法保留为可选 `argumentHint`；`argumentCompletions` 表示命令所有者能根据当前参数前缀动态提供候选，与静态参数用法分别表达；`contentAvailable` 表示该命令有可按需检查的权威内容。Host 不按命令名维护用法表，也不从 description 或 handler 猜参数。

`command.discovery.v1` 提供两条只读能力：`command.content` 分页读取命令所有者当前加载的 Markdown 内容，`command.complete` 取得命令所有者针对给定参数前缀生成的候选。请求使用 catalog 中的 canonical `{name,source}` 引用，避免同名的 prompt、extension 或 skill 被错误认领。Prompt 正文来自 Worker 已加载的模板对象，不暴露文件读取接口；Host 只做 instance/lifecycle 判断并原样路由。某个客户端不展示详情或动态候选，不影响其他客户端使用这项能力。

## Capabilities

Capability 表示当前 Host、Agent Worker 或客户端是否实现某项能力。

- Agent 提供但客户端未实现的能力，只在该客户端不可用；
- 新 Agent 实现现有能力时，不修改 Protocol V2 和其他客户端；
- 真正的新 Agent 能力在 Protocol V2 定义一次，再由需要它的客户端实现；
- capability 是客户端对 Host 的 fail-fast 功能探测。Host 按同一 canonical shape 完整返回内容；客户端使用既有能力无需预先申报，其他客户端的能力保持独立。兼容门和响应形状的扩展以真实客户端需求为依据。

## 代码范围

- `src/control/protocol.ts`：Protocol V2 shape、hello、capabilities 与 wire parser。
- `src/control/dock-client.ts`：TypeScript 客户端 transport。
- `src/control/dock-host.ts`：Host socket、request routing 与 event follow。
- `src/control/instance-manager.ts`：唯一 instance identity/location 应用入口与 local/global profile。
- `src/control/dock-registry.ts`：本机原生 instance 与 catalog lifecycle。
- `src/control/stream-link.ts`：一条连接上多条 Protocol V2 流的框架——虚拟 socket、流表与输入上限、分道输出写入器、客户端链路（`transport.multiplex.v1`）的 ping/pong 与空闲关闭；机器链路复用同一套。
- `src/control/machine-transport.ts`：InstanceManager 的 persistent remote-directory/transport backend 与 multiplexed Machine connection；不承担第二套客户端请求分类。
- `src/control/operation-ledger.ts`：Host epoch 内的 mutation identity。
- `src/control/catalog-*.ts`：durable catalog transaction 与 recovery。
- `src/control/json-lines.ts`：JSONL framing。
- `src/control/remote-access-state.ts`：Host TLS identity、listener settings、pairing 与 certificate trust 的私有持久状态。
- `src/control/remote-access-server.ts`：TLS admission、pairing bootstrap、listener reconfiguration 与 revocation。
- `src/control/remote-pairing.ts`：客户端可复用的 pairing wire types，以及 SRP、identity encryption 和 certificate proof helpers。
- `src/control/attachment-storage-state.ts`：本机 storage directory 设置。
- `src/control/model-visibility.ts`：本机模型隐藏列表文件与 `model.list` 过滤；可选模型由 `src/pi/pi-model-catalog.ts` 的短命 Pi 进程提供。
- `src/control/attachment-service.ts`：stream sink、hash verification、manifest、dedupe 与 Agent path resolution。
- `src/core/instance-deliverables.ts`：instance-lifetime 临时交付 registry、path-free DTO 与 producer bounds。
- `src/core/source-file.ts`：文件来源 canonicalize/stat/open/unchanged check；`src/control/published-file-reader.ts`：Host 对既有 `file.read` 分页接口的字节读取。
- `src/control/workspace-browser.ts`：Host 文件系统目录浏览与可恢复错误。
- `src/control/instance-workspace.ts`：active instance workspace 的相对路径、符号链接与 canonical containment。
- `src/control/source-file-transfer.ts`：workspace 与临时交付共用的 Host source-file streaming pump。

新增功能时先确定归属：Host control 留在 Host，Agent session 由 Worker adapter 实现；catalog/Managed state 只保存 Dock 自身的状态。Worker、Host 和客户端复用同一个 Protocol V2 shape 定义。

资源/system 的完整字符串是原有阅读结果，不是传输队列上限承诺。官方正文返回/切页只沿 context/readEpoch 防止过期结果显示，不新增自动停止下载策略；TUI 明示的 Esc cancel、显式 signal 与断连清理保留。
