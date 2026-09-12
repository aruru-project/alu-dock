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

### 为什么现在接受

- 当前产品是本机单用户工作主体，运行开发工具正是预期用途；
- 尚未定义 per-instance quota、控制面可用性 SLO 或后台子进程的独立生命周期契约；
- 现状未导致 Host 连接、Worker 数或 FD 累积。

### 何时重访

- 需要 per-instance 资源计量、限额或清理；
- 要求大型构建、模拟器或失控子进程不能影响 Host 控制面可用性；
- managed deployment 开始依赖 service 级 Memory/CPU/Tasks 限制；
- 需要把后台子进程的归属和 instance stop/Host loss 行为定义为产品契约。

未来做隔离时，先定义 Agent 启动的后台进程由谁拥有、何时继续、何时终止。调整 cgroup 归属的方案必须保持 Worker fencing、Host-loss shutdown 和用户正在运行的工作。
