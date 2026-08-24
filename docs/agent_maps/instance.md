# Instance、InstanceManager 与命令接纳

## 这部分负责什么

本文件定义 Dock 的工作身份、位置透明性和实例命令顺序。它约束 Host 内部实现，不改变 Protocol V2 的公开 request、response、event 或 stream shape。

```text
Client / Agent-facing Dock capability
                 │ Protocol V2
                 ▼
             Dock Host
                 │ canonical request
                 ▼
          InstanceManager
       ┌─────────┴─────────┐
       ▼                   ▼
 LocalInstance       RemoteInstance
       │                   │
 command scheduler     private transport
       │                   │
 managed Worker       SubHost LocalInstance
```

## Instance 是什么

**Instance（用户看到的 Work）是 Dock 可独立寻址、托管和控制的工作身份。**

- 一个存活的 Instance 同一时刻最多有一个有效 Worker generation；一个 Worker generation 只属于一个 Instance。
- Worker 是 Instance 当前的执行载体，不是 Instance identity。Worker 意外丢失不代表用户结束 Work；可恢复的 Instance 可以安装新的 Worker generation。
- 显式 Stop 永久退役该 Instance identity。Stop 与 Host loss、Worker fault、runtime error 不同；被 Stop 的 identity 不得 Reopen。
- 当前唯一 Worker adapter 是 Pi。Pi runtime 和当前 Pi session 属于 Worker；Pi session 不构成 Instance identity。切换 Pi session 不创建新的 Instance，从保存的 Pi session 创建 Work 也不恢复一个已经 Stop 的 Instance。
- 客户端只能使用 Main-authoritative `instanceId`。name、cwd、key、Agent session ID、native instance ID、Machine location 和文件路径都不能代替它。

Instance identity 在存活期间不因客户端、临时断线、Worker generation 或本机/SubHost location 改变。

## LocalInstance 与 RemoteInstance

InstanceManager 解析出的 endpoint 只有两种实现：

- **LocalInstance**：当前 Host 持有该 Instance 的状态、命令接纳权和受管 Worker。
- **RemoteInstance**：Main 上同一 Work identity 的控制端点。它持有转发所需的 Machine、native identity、generation 与最近 snapshot，并把请求交给拥有 Worker 的 SubHost LocalInstance。

RemoteInstance 不是假的本地 ManagedInstance。它不复制 Worker 状态机，也不重新实现具体命令。route 只是 RemoteInstance 的私有位置/连接数据，不是独立业务实体、第二个实例 identity 或第二个路由权威。

Main 与 SubHost 的临时断线不会自动改变存活 RemoteInstance 的 identity。断线时 endpoint 不再具有物理 Worker 控制能力，但仍可表达最近已知状态和连接不可用事实。

### RemoteInstance Stop

Stop 的 terminal 语义作用于 Main-authoritative Instance identity：

- SubHost 在线时，RemoteInstance 把 Stop 转发给 owner LocalInstance；owner 正常关闭 Worker，Main 随后退役该 Instance。
- SubHost 离线时，Main 无法控制物理 Worker。RemoteInstance 直接永久退役 Main Instance identity，不建立 pending Stop、不自动重试，也不声称保留了对该 Worker 的控制。
- 已退役 identity 不能因旧 inventory 或重连恢复。若相同 native Worker 以后再次申报，它只能成为新的 Main Instance，而不是复活旧 identity。

同一个物理 Worker 进程不等于同一个永久 Work identity。网络分区下无法取得的物理控制事实，不得迫使 Main 保留一个用户已经 Stop、却永远无法操作的幽灵 Instance。

## InstanceManager

**InstanceManager 是 Dock 唯一的实例目录和位置 authority。**

它负责：

- 分配、保存和解析 Main-authoritative Instance identity；
- 管理 LocalInstance 与 RemoteInstance 的成员关系；
- 决定第一次创建的位置；
- 维护 Main/native identity binding 与 RemoteInstance location；
- 合并本机与 SubHost Instance list；
- 在 Instance terminal retirement 后从目录移除；
- 持有全局 key claim：同一个 key 在绑定存续期间始终指向同一个 Instance；显式 Stop 退役 Instance 时释放绑定，之后该 key 可以创建并绑定新的 Instance。

它不负责：

- 解释 Prompt、Abort、Stop、Tree、Session 或设置命令；
- 为每种 Protocol request 建立逐方法 proxy；
- 复制 LocalInstance 状态到假的 remote ManagedInstance；
- 读取或改写 Agent/用户 opaque payload；
- 实现 Machine transport、Pi runtime 或客户端 stream framing。

所有指向既有 Instance 的请求都先交给 InstanceManager。DockHost 不自行判断本机还是 SubHost；Machine transport 只执行 RemoteInstance 已经决定的转发。

```text
resolve(global instanceId)
  → LocalInstance endpoint
  → RemoteInstance endpoint
  → not_found
```

Main 使用带 LocalInstance 与 RemoteInstance 的 global profile；SubHost 使用只登记 native LocalInstance 的 local profile。两者复用同一个 request classification 和 endpoint contract，SubHost 不建立第二套业务入口。

InstanceManager 在 global profile 中组合一个 persistent `RemoteInstanceDirectory` backend；该目录拥有 Main/native binding 与 retirement tombstone，当前实现由 Machine controller 依靠 inventory/connection 事实提供。这个 backend 不接收未分类的客户端请求，也不形成另一套 local/remote decision。存活的 RemoteInstance 只持有当前连接和 location binding；endpoint 退役后，tombstone 仍由目录保留并阻止旧 inventory 复活原 Main identity。

创建、list、key lookup 等目录命令同样进入 InstanceManager，但不伪装成对某个既有 Instance 的命令。

## Protocol request 内部分类

Protocol V2 wire shape 保持不变。`protocol.ts` 在 canonical request 定义旁边为每种 request 提供唯一的内部分类；客户端不发送、也不能选择这些 metadata。

分类使用三个正交事实：

```text
target:    dock | directory | instance
effect:    query | command
transport: unary | follow | request_stream | response_stream | response_transfer
```

- `target` 决定 DockHost、InstanceManager 或一个既有 Instance endpoint 谁接收请求。
- `effect` 决定是否进入实例命令接纳权威。它不等价于 HTTP method，也不由是否带 `operationId` 猜测。
- `transport` 只描述连接和 framing。一次 attachment upload 同时可以是 command 与 request stream；`session.tree` 仍是 query，只是成功 response 使用透明 transfer frames。

`attachment.upload` 等可选 `instanceId` 的 request 由同一个 canonical classifier 根据已解析参数产生 directory 或 instance target，不在 Host 和 Machine transport 各写一次判断。

示例：

| Request | Target | Effect | Transport |
|---|---|---|---|
| `host.info` | dock | query | unary |
| `instance.create` | directory | command | unary |
| `instance.list` | directory | query | unary |
| `command.submit` | instance | command | unary |
| `instance.get` | instance | query | unary |
| `instance.follow` | instance | query | follow |
| `attachment.upload` | directory/instance | command | request_stream |
| `workspace.file.read` | instance | query | response_stream |
| `session.tree` | instance | query | response_transfer |
| `instance.stop` | instance | command | unary |

Capability、wire parser、result parser 和 request classification 各表达不同事实，但同一事实不得在多个层次重复维护。新增 request 时，TypeScript 必须强制补齐 canonical classification。

## Instance command scheduler

每个 LocalInstance 只有一个 **command scheduler**。所有 `target=instance, effect=command` 请求必须由它原子完成：

1. 读取当前已提交的 Dock state；
2. 判断命令是否可接纳；
3. 为 operation 占住唯一顺序位置；
4. 返回 `start`、`enqueue`、`reject` 或 `preempt`；
5. 维护 effect custody、generation 和 completion 归属。

命令的到达顺序不是一个持续数分钟的 Promise 队列。Scheduler 只串行化业务决定；耗时 Worker effect 可以在队列外运行，但其提交位置和完成归属必须由 scheduler 保留。存在产品级阻塞关系的命令可以持有 exclusive slot，直到 effect 达到定义的完成边界。

### 调度类别

| Class | 产品含义 |
|---|---|
| `terminal` | 永久结束 Instance。Stop 接纳后关闭后续命令，清除等待项并驱动 graceful Worker shutdown。 |
| `interrupt` | 控制当前运行但保留 Instance，例如 Abort。 |
| `exclusive` | Session、Tree 或配置变更；同一时刻只允许一个冲突 effect。 |
| `input` | Prompt/Steer/Follow-up 的统一输入入口；保持接纳因果，不替 Agent 猜实际 delivery。 |
| `control` | 对当前 interaction/controller 的响应与控制。 |

每种 command request 只映射到一个 scheduler descriptor。Descriptor 定义：

- 允许的 lifecycle / committed state；
- 冲突时 start、enqueue、reject 或 preempt；
- 是否持有 exclusive slot 到 effect completion；
- observation 是否继续读取旧 committed snapshot；
- Stop 接纳后的处理。

优先级来自用户语义，不来自接口名称或代码层级。Stop 是 terminal；其他命令默认保持已接受意图的因果顺序，不因“看起来更高级”而插队。

例如，如果产品定义回答运行中不能切换 Tree，则唯一规则是：

```text
session.navigate + run active → reject
```

客户端可以提前禁用入口，但所有能够到达 owner 的命令，其最终业务判断都来自 owner LocalInstance scheduler。离线 RemoteInstance 的 Stop 是唯一无法到达 owner 的 terminal admission：RemoteInstance 只退役 Main identity 和当前等待项，不解释任何 Agent 命令，也不建立第二套普通调度规则。

### Scheduler 与 Worker acceptance

Scheduler 是 Dock 命令顺序、lifecycle、operation 和 Queue custody 的 authority；Worker adapter 是 Agent 实际接受 effect 的 authority。两者不能同时猜同一个事实。

`command.submit` 的顺序是：

```text
scheduler reserve operation
→ Worker adapter 解析 input kind，并在真正取得 custody 时报告 input kind / actual delivery / custody owner
→ scheduler 以该 preflight fact 提交 receipt / Queue ownership
→ Worker conversation/event 继续使用同一 operation identity
```

Scheduler 不根据较早的 `isStreaming` 自行决定 prompt/steer/followUp，也不读取 Pi 私有 Queue 或 extension command 文本规则。普通 prompt 的 preflight 在 Pi input hook 决定实际 delivery 时产生；registered extension command 在 adapter 已解析并取得 invocation custody、但可能长时间运行的 handler 开始前产生；compaction 期间不能交给 Pi 的普通 input 则明确报告 Host custody。这个 preflight 是 Worker→Host 的事实通知，不为每条输入增加一次批准往返。

Worker 接受副作用前失联与接受后失联仍是不同结果。Scheduler 不能自动重放 effect-unknown mutation。

## Query 与 stream observation

Query 和 stream 不占用 command scheduler 的 exclusive slot，也不能被长时间 Agent effect 阻塞。但“不排队”不等于没有一致性边界。

每次 instance query/stream 在开始时取得不可混用的 observation binding：

```text
{ instanceId, lifecycle, runtimeGeneration, endpoint/location, committed boundary }
```

- Host projection query 读取同一次 committed snapshot。
- Worker-backed query 的 response 必须仍属于开始时的 generation；generation 改变后丢弃旧结果。
- follow/read 使用同一 snapshot + cursor 边界；不能在其间漏 event。
- explicit Stop、可恢复故障后的 Reopen、session/runtime generation replacement 会按各自既有 Protocol V2 规则关闭或 reset 旧 observation；explicit Stop 本身永远不能 Reopen。
- Remote mapping 只改写 canonical identity 字段，不进入 message、content、metadata、tool arguments 等 opaque payload。

因此 command scheduler 与 observation path 是两个不同通道，但共享同一个 committed Instance fact 和 generation fence。

## Worker boundary

Instance scheduler 只依赖通用 Worker connection：

- invoke canonical Agent request；
- 接收 effect preflight/custody；
- 接收 canonical Agent event/result；
- 读取当前 generation 的 bounded state projection；
- graceful dispose；
- supervisor-owned process termination fallback。

具体 Agent 差异留在 adapter：

- Pi input hook 与实际 delivery；
- Pi Queue API 和文本/identity 适配；
- Pi Tree navigation、compaction 和 Abort 方式；
- Pi session replacement、model、tools、settings、resources；
- Pi extension command、conversation 与 persistence projection；
- Pi runtime disposal 和进程内资源清理。

Host 不根据某个 Pi Promise、SDK method、setting key、extension command 文本或 Pi 私有 compaction 时序设计通用 Instance admission。Dock 已公开的 `compacting` lifecycle fact 仍可参与 scheduler 规则；具体 Pi Promise、abort API 和 event ordering 只由 adapter 解释。

## Stop

Stop 是正常、完整地结束 Dock Work identity，不等于 Abort，也不等于 supervisor hard kill。拥有物理控制能力的 Local/online endpoint 同时负责结束 Worker；离线 RemoteInstance 使用前述不可达条件下的 identity retirement 语义。

Local/online 正常路径：

```text
scheduler terminal admission
→ lifecycle=stopping，拒绝新命令
→ Worker adapter graceful dispose
→ Worker supervisor 确认受管进程树释放
→ lifecycle=stopped，发布 terminal snapshot/event
→ InstanceManager retire identity
```

- `stopped` 可以存在于最终 receipt、已连接客户端的 terminal event 和并发 Stop 的 single-flight result中；它不构成可恢复历史。
- 正常关闭的 Agent-specific cleanup 由 Worker adapter 负责。Instance 不逐项理解 Pi Queue、compaction、interaction 或 session Promise。Terminal admission 不等待可能无限挂起的 input hook 才开始 cleanup；Worker connection 的 disposal 必须让既有 invoke settle/reject，supervisor timeout 则保证 owner release 有界。
- hard kill 是 supervisor 在 graceful shutdown 超时或 Worker 不响应时的异常兜底，不是 Stop 的产品定义。
- project files 和 Agent 自己的持久 session 不因 Instance Stop 删除。
- Stop operation 的 transport/idempotency result 保持 Protocol V2 既有形状。
- Remote offline Stop 使用前述 Main identity retirement 语义。

## 持久化、generation 与唯一提交

- Catalog 保存 Work identity、lifecycle intent、location 所需事实和 recovery material；不保存 Agent runtime 私有对象。
- 每个 LocalInstance 的 durable transition 与 Worker event projection只有一个提交顺序。Command scheduler 决定谁可产生 effect，不取代 catalog/event 单写者。
- 每个 active Instance 同时只有一个有效 runtime generation。旧 generation 的 event、response、query result、Extension UI 和 delayed completion不得提交到新 generation。
- explicit Stop、Worker fault、Host drain 和 runtime replacement 使用不同 intent；它们不能通过同一个模糊 stopped/error shell 互相冒充。
- Main/native identity mapping 与 retirement tombstone 只由 InstanceManager 的持久 location directory 维护；RemoteInstance 持有存活 endpoint 的连接数据。Machine transport 不创建第二份 authority。

## 性能约束

这次重构不能产生用户可见性能回退：

- 普通 local query/command 不增加网络或 Worker round-trip；
- InstanceManager resolve 使用内存 identity index，不扫描所有 Machine routes；
- request classifier 是 O(1) canonical metadata lookup；
- query/stream 不等待长 command effect；
- RemoteInstance 继续复用一条 multiplexed Machine connection和每 logical stream 的既有背压边界；
- 不创建 remote ManagedInstance 状态副本，不复制 conversation 或 stream body；
- Stop、reload 和所有超过一秒的操作继续满足 STORY.md 的反馈要求。

## 实施边界

- Protocol V2、DockClient 和现有第三方客户端 shape 不变；classification metadata 只在 Host 内部。
- 新实现可以在独立文件中建立，但接入时每项 authority 只有一条 live path。不得长期保留旧/新双轨 scheduler、directory 或 route decision。
- 迁移按可独立回退的提交推进；每迁移一项旧 boundary，即删除对应 flag、特判或无调用方代码。
- 当前实现只作为外部行为、真实竞态和平台限制的证据，不作为新职责边界的定义。
- Main/SubHost、Windows/POSIX process supervision、catalog durability 和 effect-unknown 语义必须经过现有真实入口验证。
