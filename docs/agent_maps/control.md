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
- catalog、project trust 与 persisted-session inventory；
- Worker lifecycle、runtime kind 与 generation；
- Queue、operation、Extension UI 操作权与 read/follow reconnect。

这些状态属于 Dock，不交给 Agent runtime 决定。

### Session gateway

Prompt、conversation、model、tools、settings、session、tree 和 Extension UI 等 Agent 会话能力，由 Host 完成必要的 instance、operation、controller 与 lifecycle 判断后路由给 Worker。

Host 不为这些能力维护第二套 Agent 实现，也不重复投影 Worker 已经产生的 Dock event/result。

## Protocol V2

连接使用本机私有 Unix socket 和 JSONL：

1. 客户端先发送 hello，并协商版本与 capabilities；
2. hello 成功后发送业务 request；
3. 普通 request 返回一个 response；
4. `instance.read` 读取当前权威视图，`instance.follow` 在初始 response 后持续接收 event；
5. Extension UI 操作使用独立连接，并与读取、实时跟随分别恢复。

Client 发给 Host 的 hello/request 使用 closed JSON-safe shape，未知字段会被拒绝。Host 发给 Client 的 response/event 仍严格校验已知字段、版本、类型和边界，但 Client 必须忽略新增的未知可选字段；只有删除字段、改变既有语义或新增无法忽略的类型时才需要 capability 或协议版本。单 frame 可以有传输上限，但业务内容不能因此永久截断；大型 conversation 使用分页和 chunk 继续读取。

Protocol V2 是外部合同。Host 与 Worker 的内部重构不应要求现有 TUI 或 Web 客户端重写。

## 身份

以下身份用途不同：

- `hostEpoch`：一次 Host 进程域；
- `instanceId`：Dock 工作实例；
- Agent 原生 session identity：当前 Worker 内的会话；
- `runtimeGeneration`：instance 内一次 runtime/session generation；
- `operationId`：一次调用者 mutation 意图；
- event cursor：一次 read/follow reconnect 的观察位置。

客户端不能用 name、cwd、Agent session ID 或文件路径代替 Dock instance identity。

## Mutation

Host 对 mutation 负责 admission、operation 去重和结果归属。客户端发送 mutation 后遇到断线或无法确认的 response，不能自动重放；应查询当前状态，并在仍无法确定时保留结果未知。

Worker 接受副作用前失联和接受后失联是不同结果。Host 必须保留这个区别，不能把可能已经执行的 mutation 当成普通失败重试。

消息提交中，Host 的 admission result 使用 Worker 报告的实际 delivery。`operationId` 是直接 prompt 与 Queue message 共用的提交身份；`queueItemId` 只属于确实等待过的 Queue item。一个 Host-deferred Queue item 可以在 Agent 恢复空闲后以 `prompt` delivery 被消费，此时 `message.submitted` 仍保留它真实的历史 Queue identity；普通 direct prompt 没有该 identity。若辅助关联异常，Host 省略这个可选 identity，而不是伪造一个或丢掉 canonical message。Host 不根据 catalog 中稍早的 running 状态替 Agent 决定最终 delivery。因此用户看到的状态必须始终可判定为未接受、Queue 中等待，或已经被 Agent 消费并出现在 conversation，不能两边都没有。

## Read、follow 与 Extension UI 操作

`instance.read` 返回当前 snapshot、conversation bootstrap、Queue 与读取边界。conversation bootstrap 由同一边界下的两部分组成：

- `recentHistory`：Worker 产生的当前分支权威持久 record；
- `page.events`：尚未被 Worker persistence checkpoint 接住的 active conversation frame，以及仍在等待的 interaction。

持久 record 使用通用的 `recordId / kind / source / visibility / content / metadata` shape。Worker adapter 保留 Agent 的 message、tool、custom message、bash、compaction/branch summary 和 session metadata 语义；Host 不把它们压成 role，也不按文本或 tool 内容猜测 live frame 是否已经持久化。

`instance.follow` 从 read boundary 开始补齐后续事件并持续跟随。保有本地画面且 cursor 连续时，客户端只消费 `event_log` replay 和 follow；不重新拉取历史。event ring 截断、Host epoch 改变、runtime generation 改变或本地状态丢失时，客户端丢弃旧 conversation，重新读取完整 bootstrap。不得把两次 history 读取边界拼成一个会话。普通 `session.history` page 与 bootstrap seed 都携带 Host `historyRevision`；分页中 revision 改变时客户端必须放弃该次 scan 并重新 bootstrap。

active frame 的释放完全由 Worker persistence checkpoint 驱动。Host 只按 generation、sequence 和 checkpoint 机械暂存/释放，不等待客户端 ACK，不维护接收名单，也不做内容 fingerprint、认亲或去重。任意数量的客户端可以同时读取和跟随；观察连接中断不等于 Agent runtime 失败，也不结束 instance。

Extension UI 操作使用独立连接，同一 instance 同时只有一个。新连接立即接手，旧操作连接结束但它的普通 follow 不受影响；等待中的 interaction 属于 runtime generation，不因接手或断线而被回答或取消。

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

新增功能时先判断它属于 Host control 还是 Agent session。不要把 Agent session 能力塞进 catalog/Managed state，也不要为同一 Protocol V2 shape 在 Worker、Host 和客户端分别维护重复定义。
