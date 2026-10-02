# 已知技术债

## 这份文档负责什么

这里记录当前明确接受的结构性代价、现有证据和重访条件，供后续维护时查阅。

它不是任务队列、版本承诺或实施授权。只有重访条件实际出现，并且主人明确点名后，某一项才进入分析或实施。产品语义仍以 [`STORY.md`](../STORY.md) 和对应架构文档为准；开始处理前必须重新核对届时的实现与运行证据。

## 极大首次响应下的历史读取恢复缺口

**优先级：非常低；尚无实际案例，未复现。**

### 已知边界

2026-09-11 调查 #278 时发现：Host 为缩小首次对话响应，会先裁剪较早历史和预览内容；如果仍超出单帧限制，可能将历史预览全部移除，并保留“还有历史可读”的标记。官方客户端目前要求带此标记的响应至少包含一条历史记录，因此这种组合会被拒绝。原始会话记录保留在原位置。

代码入口：`src/control/dock-host.ts` 的 `createBoundedReadResult`，以及 `clients/official/src-tauri/src/lib.rs` 的 `conversation_bootstrap`。

### 为什么现在接受

目前只有代码路径上的不匹配，缺少用户现场、实测复现和发生频率证据，对长会话及普通大量工具调用的实际影响尚未确认。用户已决定暂不处理，也不为这一未复现条件增加防御逻辑、恢复机制或测试工程；此项在 #278 的消息重复修复范围之外。

### 何时重访

实际出现切入工作后对话加载失败，并且现场响应或日志证明命中了“历史被全部裁剪”的路径时，再由主人决定是否处理。届时先核对实际负载、响应组成和当前代码。

## 取回 Queue 未完成时切 Host，返回内容可能丢失

**暂不处理；目前只有静态调用链证据，未做运行复现。**

### 已知边界

2026-09-27 的 #306 合并前评审发现：用户在 Host A 发起取回 Queue，回复尚未到达时切换到 Host B，客户端会关闭原连接。如果 Host A 已取出消息并清空对应 Queue，随后到达的成功回复仍会因原连接已关闭而被客户端当作“结果未确认”，其中的文字、附件关联和图片不会进入原 Work 草稿。返回 Host A 后再读 Queue，也可能已没有这些内容可供取回。

本项指跨 Host 切换，不是同一 Host 内切换 Work。现有 App 控件测试使用模拟原生接口，没有覆盖真实 Rust 连接关闭后的回复处理，不能作为此路径已安全的证据。

代码入口：`clients/official/src/stores/host.ts` 的 `switchSavedHost`；`clients/official/src-tauri/src/lib.rs` 的 `invalidate_connection_lifecycle`、`dequeue_messages`；`clients/official/crates/aludock-client-core/src/client.rs` 的 `request_with_host_epoch_fenced`。

### 为什么现在接受

用户已明确决定在 #306 中忽略这一特定操作组合，并允许其余整改合并。当前没有运行复现和发生频率证据；本轮不为它增加跨 Host 保护、自动重试或补偿机制，也不恢复影响常规操作的全页限制。

### 何时重访

- 实际出现取回 Queue 后内容没有进入草稿，且操作记录或日志指向途中切换 Host；
- 取回尚未完成就切换 Host 成为经常使用的流程，或产品明确要求这类操作也必须保留取回结果；
- 后续需要调整 Host 切换或已发出请求的结果接纳方式。

届时先复核实际时序及当前实现，再由主人决定是否处理。需要区分“用户切去看哪里”和“原操作的结果属于谁”；不能用自动重放取回请求代替保存已经返回的内容，也不把客户端限制搬到 Host。

## 链路上极慢或间歇的网络会让文件或会话内容读取超时，链路本身不断

**优先级：非常低；未在真机出现。**

### 已知边界

2026-09-29 #329 外部审查发现：官方客户端的 Host 链路（`transport.multiplex.v1`）把每条流的数据装在 `stream_data` 记录里，客户端要收齐整条记录才能把字节交给流的读取方。字节读取层只看到交付给它的字节，所以一条记录在链路上传输超过它的空闲上限，这次读取就会报空闲超时；链路的存活判断按字节计，链路和其他请求不受影响。受影响的读取及其边界：

- `file-transfer.v1` 的文件读取、工作区文件、交付文件、上传、`conversation.content.stream`：64 KiB 一块（编码后约 85 KiB），`file_io.rs` 的 `FILE_IDLE` 为 60 秒，持续匀速下约 1.5 KB/s 以下才会碰到。
- 会话初次加载与长记录（`instance_records.rs`）：64 KiB 一段，初次加载期间同为 60 秒；碰到时当前会话内容加载失败，链路上的其他请求正常。
- 对话图片（`conversation.image`）：512 KiB 一块，每帧 600 秒，约 1.2 KB/s 以下才会碰到。

原始内容未损坏。网络改善后重试可以成功；条件不变时重试仍会失败。裸连接（无链路能力的 Host）没有这个差异，因为字节是边到边读的。

代码入口：`clients/official/crates/aludock-client-core/src/link.rs` 的 `read_loop` / `VirtualStream`；`file_io.rs` 的 `read_byte_record`；`instance_records.rs`。

### 为什么现在接受

修法要么在链路读取侧对 `stream_data` 的 JSON 字符串做流式解码，要么把 Host 侧 `ByteTransitRelay` 的在途活动通知镜像到客户端（需要链路识别每条流的 requestId 与请求类型）。两条路都比问题本身重，且都在最热的读路径上。另一条更轻的备选是让这类长时间字节读取继续走普通连接、其他请求共享链路，代价是这些读取多一次握手，改动量未评估。用户 2026-09-29 决定：先记录，不为极慢网络现在动这些代码。

### 何时重访

真实使用中出现文件、图片或会话内容加载失败，且证据指向"链路仍活着、部分数据在途但没能续期"（链路存活、其他请求正常、读取报空闲超时），由主人决定是否处理。届时先复核当时的块大小与空闲上限，优先考虑上面的轻备选或链路读取侧的流式解码，不要把文件层的空闲上限抬高了事。

## SubHost 创建断线可能留下空实例

**优先级：非常低。**

### 当前权衡

客户端发起的 SubHost 创建只有在 SubHost 完成创建、Main 完成登记并向客户端返回成功后才算成功。过程中机器连接断开时，本次创建直接失败，不增加“结果未知”的产品状态，也不自动重试。

### 债务

在请求已经到达 SubHost、但完整创建链路尚未成功时断线，SubHost 可能留下一个尚未工作的空实例。它不会自行调用模型、执行 Agent、发送用户内容或修改 workspace；后续由正常实例对账处理。最坏结果是多占用少量本机资源，并可能多出一条可清理的 Work。

这项接受只适用于没有开始 Agent 工作的 `instance.create` 空实例，不扩大到 prompt、stop、forget 或其他已经产生用户业务结果的操作。

### 为什么现在接受

- 只会发生在创建过程中机器连接恰好中断的短窗口；
- 空实例没有实质业务副作用；
- 为该窗口增加新的用户状态、自动补偿或重放机制，会让产品复杂度大于当前风险；
- 该现象频繁出现时，优先检查 Main 与 SubHost 的连接稳定性。

### 何时重访

- 运行证据显示创建断线和空实例残留已经成为常见现象；
- 空实例明显干扰用户列表或形成可观测的资源压力；
- 创建流程以后会自动启动 Agent、调用模型或修改 workspace；
- 产品开始要求创建失败后绝不能留下任何本机实例。

未来重访时仍应保持：创建过程中断线对用户就是创建失败，不自动重放创建，也不把内部执行步骤暴露成新的用户状态。

## Host 生命周期内的 mutation identity 保留

**优先级：非常低。**

### 当前权衡

`OperationLedger` 只保留有限数量的完整 settled receipt；更早的唯一 `operationId + fingerprint` 会以 compact retired identity 保留到当前 Host 进程结束。这样即使完整 receipt 已淘汰，同一 Host epoch 内的旧 mutation 也不会被当成新副作用再次执行。

### 债务

Retired identity 的数量随一个 Host 生命周期内出现过的唯一 mutation 单调增长。普通只读请求和 TLS 连接不会增加它；长期、高 mutation 量且很少重启的 Host 可能因此产生缓慢的内存增长。

这些 identity 用于保留幂等事实。2026-08-21 的长期运行快照中，Host RSS、FD 和连接数均未显示该项已形成资源压力。

### 为什么现在接受

- 完整结果已经有界，长期保留的只是 compact identity；
- 当前没有运行证据表明它影响稳定性；
- 简单 TTL 或容量淘汰会重新放开旧副作用，破坏比内存成本更重要的 mutation 语义。

### 何时重访

- 产品开始承诺 Host 在高 mutation 量下连续运行数月或更久；
- 运行指标显示 retired identity 已成为 Host heap 的实质组成；
- operation identity 的持久化或 Host epoch 语义发生变化。

未来方案必须继续保证：不能因为本地记录被淘汰，就把同一 Host epoch 内已经执行过的 mutation 当成第一次执行。

## Host 控制面与 Agent 工作负载共享 service cgroup

**优先级：非常低。**

### 当前权衡

Managed Host、Worker，以及 Agent 从 Worker 中启动并继续运行的开发进程，会继承同一个 `systemd --user` service cgroup。模拟器、编译器、dev server 和它们产生的 page cache 因而都计入 `alu-dock.service` 的 CPU、内存和 task 指标。

### 债务

- service 级指标不能直接区分 Dock 控制面与用户工作负载；
- 大型 Agent 工作负载会与 Host/Worker 共享 cgroup 资源压力；
- 未来若直接给整个 service 设置资源限额，控制面和工作负载会互相影响。

2026-08-21 的只读快照中，service cgroup 的主要占用来自 Android Emulator、Gradle/Kotlin、ADB、Vite 和可回收 file cache；这些是 Agent 启动的开发工作负载，Host 进程自身保持在正常规模。

2026-09-30 一个 Worker 里的测试进程占用 66 GiB 被内核 OOM 杀掉，systemd 默认的 `OOMPolicy=stop` 随即停掉整个 Dock。处理（#331）：unit 改为 `OOMPolicy=continue`，并给整个 service 设 `MemoryMax=64G`、`MemorySwapMax=0`。失控进程在拖垮机器前被杀，Host 和其他 Work 继续运行。仍未做的：按 Worker 分 cgroup，以便把「内存超限」归到具体 Work 并在客户端显示；目前只能从 journal 和内核日志查到被杀的进程。

### 为什么现在接受

- 当前产品是本机单用户工作主体，运行开发工具正是预期用途；
- 尚未定义 per-instance quota、控制面可用性 SLO 或后台子进程的独立生命周期契约；
- 现状未导致 Host 连接、Worker 数或 FD 累积。

### 何时重访

- 需要 per-instance 资源计量、限额或清理；
- 要求大型构建、模拟器或失控子进程不能影响 Host 控制面可用性；
- 需要在客户端看到是哪个 Work 因内存超限被停，或 64 GiB 的 service 总上限开始影响正常工作；
- 需要把后台子进程的归属和 instance stop/Host loss 行为定义为产品契约。

未来做隔离时，先定义 Agent 启动的后台进程由谁拥有、何时继续、何时终止。调整 cgroup 归属的方案必须保持 Worker fencing、Host-loss shutdown 和用户正在运行的工作。

## 插件接管或慢速处理输入时的两处偏差

**保持现状；Dock 自带插件和当前安装的插件都没有 `input` 或 `agent_settled` 处理，不会触发。**

### 已知边界

2026-10-02 #346（Pi 0.99.2）评审时，用隔离的真实 Pi 和本机假模型确认了两处偏差：

- 插件的 `input` 处理在另一轮回复进行中（含收尾期间）接管一条消息时，Protocol V2 回执只能用“已排队”的形式，随后才以 `command.handled` 结束。官方客户端命令区会显示“已加入 Queue”，`dock_send` 也会告诉发送方 Agent 消息在对方 Queue 里等待。0.85.1 起就是这样。
- 插件的 `input` 处理较慢并最终放行一条消息，而原回复在这期间结束、另一个插件的 `agent_settled` 处理还没完成时，Pi 会在上一轮收尾结束前开始新一轮。Host 把上一轮的结束记到新消息上，上一轮收不到自己的结束；新一轮比收尾更长时，Dock 会在回复进行中显示空闲。原因在 Pi：`prompt()` 只在入口检查是否正在收尾，而它的结束事件不标明属于哪一轮，Dock 侧无法可靠纠正。

代码入口：Dock `src/core/managed-instance.ts` 的 `submit`（handled 分支）与 `agent_settled` 处理；Pi `agent-session.ts` 的 `prompt()`、`_emitAgentSettled()`。

### 为什么现在接受

Dock 不需要兼容 Pi 插件的全部用法。这两处只影响带这类处理的插件，Dock 自己用到的部分不受影响；按主人确定的原则保持 Dock 现状，不为此改 Protocol V2 回执或 Pi fork。

### 何时重访

Dock 或实际使用的插件开始依赖 `input` 接管消息，或依赖较慢的 `input` 与 `agent_settled` 处理时。届时可考虑：回执表达“已被插件接管”；在 Pi fork 里让 `prompt()` 等上一轮收尾结束再开始新一轮。
