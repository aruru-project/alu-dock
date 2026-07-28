# Agent Worker 与 Runtime

## 这部分负责什么

Agent Worker 负责运行真正的 Agent。当前实现是 Pi，未来可以增加其他 Agent adapter。

Host 管理 Worker，但不在 Host 中模拟 Agent runtime。客户端通过 Protocol V2 与 Dock 通话，Host 完成控制判断后把 Agent 会话流量路由给对应 Worker。

```text
Protocol V2 client
        │
        ▼
Dock Host Service
 control + routing
        │
 private Worker transport
        │
        ▼
Agent Worker
        │
   Agent adapter
        │
 Pi / future Agent
```

## Host 与 Worker 的边界

Host 负责：

- instance、catalog 与 runtime kind；
- Worker 创建、停止、replacement 与 generation；
- admission、Queue、operation 与 Extension UI 操作权；
- 把请求和事件路由到正确的客户端与 Worker。

Worker 负责：

- Agent runtime 与原生 session；
- tools、extensions、components、callbacks 与 Promise；
- Agent 的 conversation、model、settings、tree、compaction 等实际机制；
- 把 Agent 行为转换成 Dock 的 command、event 和 result。

Host 可以因为 instance、generation、operation、Extension UI 操作权或 lifecycle 不正确而拒绝请求，但不重新解释 Agent 内容，也不为 Agent 的每个方法建立本地代理。

## Worker 通信

Protocol V2 定义 Dock 的业务语义。Host 与 Worker 之间的私有通信只补充进程所需的信息，例如 Worker identity、generation、调用关联、接收确认、分帧和背压。

同一项能力不能分别维护一套 RuntimeSession 方法、Worker capability、Host projection 和客户端 DTO。Worker 返回 Dock 已定义的结果和事件，Host 验证归属后转发。

客户端不直接连接 Worker。这样 Worker replacement、旧 generation 隔离、controller 与 reconnect 仍由 Host 统一处理。

## Pi adapter

Pi runtime、Pi session、extension runner、component 和 Pi SDK object 全部留在 Worker。Pi adapter 只在 Worker 内使用 Pi API，并把 Pi 的行为转换成 Dock 协议。

消息提交的实际 delivery 也由 adapter 在 Pi 真正接收输入时确定。调用者的 `auto / prompt / steer / followUp` 原样到达 Worker；Pi 完成 input hook 并再次检查运行状态后，Worker 的私有 preflight result 报告这次实际采用的 `prompt / steer / followUp`。Host 只按这个结果提交 receipt 和 Queue 状态，不根据自己稍早看到的 `isStreaming` 再猜一次。`operationId` 贯穿直接执行和排队执行；只有确实进入 Queue 的消息才创建 `queueItemId`，也只有实际消费 Queue item 时才产生 queue-consumed lifecycle。Queue provenance 与最终 delivery 分开保存：compaction 期间由 Host 保管的 Queue item 可能在 Pi 恢复空闲后以 fresh prompt 启动，但它仍消费原来的真实 Queue identity；普通 direct prompt 则不会产生 queue-consumed。

Conversation projector 使用同一个实际 delivery 生成 `message.submitted`。Canonical conversation frame 不以 Host 的辅助 Queue identity 为发布前提：即使 Queue 关联异常，已经被 Worker 接受的用户消息也必须先出现在 conversation，不能被内部错误替代。

Conversation 的持久语义也在 adapter 内完成。Pi adapter 把当前 branch entry 投影成 canonical persisted record，显式保留 message、tool result、custom/custom message、bash execution、compaction/branch summary、model/thinking/session/label record 及其 visibility/metadata；Host 不读取 Pi role 或 Pi session 私有 shape。大型内容的 record 只承载有界 preview，完整内容由 conversation history/content 的 revision、content ref 和 chunk 提供。Adapter 与 Host 的 history 分页都以 canonical `toolCallId` 形成完整语义单元，不能把 Assistant tool call 与已有的对应 results 拆页；这不增加另一套 owner identity。Worker 私有协议还限制整个 conversation history page 的传输字节数；adapter 应先去除可由 content ref 读取的 preview，而不是拆开语义单元。

实时事件与持久 record 不需要共享 identity。在线客户端在 `message_update`/tool event 上原位更新组件，完成后直接保留；重建时才从持久 record 重新生成。Adapter 在一个 turn、run、compaction 或独立持久写入形成安全边界后发出私有 `conversation_checkpoint`。Checkpoint 携带该边界的精确权威 branch history snapshot，表示它之前的 conversation frame 都已由这份 snapshot 表达；Host 原子安装 snapshot 并释放 active buffer，不能在稍后读取一个可能已经前进的 history 来猜测边界。Checkpoint 不等待任何客户端确认。

Pi 是当前成熟基底。真实工作需要且 Pi 已经具备的能力，应完整接入 Dock；不能因为某个客户端尚未实现、跨进程不方便或未来 Agent 可能不同而降低能力。

Pi 的 abort 会等待 Agent 回到 idle；如果客户端没有先恢复 Queue，已排队输入可以在当前输出终止后合法启动下一轮，因此 abort 的完成时间不是 Worker 存活探针。Host 不因 abort 尚未返回而切断 Worker。需要像 Pi TUI 一样把排队文本恢复到输入框的客户端，应先调用既有 Queue dequeue，再在确认没有正在进入 Pi 消费的消息后 abort；Host 不替客户端合并这两个不同意图。

## Extension UI

Extension component 和 Promise 留在 Worker。Worker 负责 component render、input、invalidate 与完成回调；Host 负责 generation、当前操作者和定向路由；TUI 或 WebUI 负责各自支持的显示与输入。读取和实时跟随不取得操作权；新的操作连接会立即替换旧连接，但不会取消 Worker 中等待的 interaction。

某个客户端没有实现一种 Extension UI，只影响该客户端，不影响 extension runtime、Agent 或其他客户端，也不能产生假的用户回答。

Extension command 仍通过完整 Agent input 语义执行，不另建第二条命令通道。Worker 在执行前确认当前输入确实命中已注册的 Extension command，并只在该 handler 尚未结束时，把同一次提交已有的 `operationId` 附到 `extension.notification`。它只表达来源关联：通知仍不是 conversation record。handler 返回后遗留的 timer、后台任务以及其他被动 Extension 通知不携带该 ID；Host 不按文本、时间或命令名称猜测来源。

## 新增 Agent 或能力

新增使用现有 Dock 能力的 Agent时，只增加 Worker adapter 和 runtime kind 注册，不修改 Pi adapter和不相关客户端。

Agent 出现新的真实能力时，在 Protocol V2 定义一次，由提供该能力的 Worker adapter 产生，再由需要它的客户端实现。Host 只有在这项能力确实增加新的控制或生命周期规则时才需要变化。

## 代码范围

- `src/pi/`：当前 Pi Worker、Pi adapter 与 Worker 进程实现。
- `src/control/`：Host control、Worker supervision 与 session routing。
- `src/core/`：Dock 自己的协议数据与跨实现概念，不依赖 Pi runtime。
- `src/tui/`：SSH 客户端，不持有 Agent runtime。

具体实现应服从以上边界。任何普通 Agent 能力如果需要在多个层次重复定义和投影，应先修正边界，而不是继续增加转发代码。
