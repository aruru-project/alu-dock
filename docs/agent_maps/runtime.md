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
- admission、Queue、operation 与 controller；
- 把请求和事件路由到正确的客户端与 Worker。

Worker 负责：

- Agent runtime 与原生 session；
- tools、extensions、components、callbacks 与 Promise；
- Agent 的 conversation、model、settings、tree、compaction 等实际机制；
- 把 Agent 行为转换成 Dock 的 command、event 和 result。

Host 可以因为 instance、generation、operation、controller 或 lifecycle 不正确而拒绝请求，但不重新解释 Agent 内容，也不为 Agent 的每个方法建立本地代理。

## Worker 通信

Protocol V2 定义 Dock 的业务语义。Host 与 Worker 之间的私有通信只补充进程所需的信息，例如 Worker identity、generation、调用关联、接收确认、分帧和背压。

同一项能力不能分别维护一套 RuntimeSession 方法、Worker capability、Host projection 和客户端 DTO。Worker 返回 Dock 已定义的结果和事件，Host 验证归属后转发。

客户端不直接连接 Worker。这样 Worker replacement、旧 generation 隔离、controller 与 reconnect 仍由 Host 统一处理。

## Pi adapter

Pi runtime、Pi session、extension runner、component 和 Pi SDK object 全部留在 Worker。Pi adapter 只在 Worker 内使用 Pi API，并把 Pi 的行为转换成 Dock 协议。

Pi 是当前成熟基底。真实工作需要且 Pi 已经具备的能力，应完整接入 Dock；不能因为某个客户端尚未实现、跨进程不方便或未来 Agent 可能不同而降低能力。

## Extension UI

Extension component 和 Promise 留在 Worker。Worker 负责 component render、input、invalidate 与完成回调；Host 负责 controller、generation 和路由；TUI 或 WebUI 负责各自支持的显示与输入。

某个客户端没有实现一种 Extension UI，只影响该客户端，不影响 extension runtime、Agent 或其他客户端，也不能产生假的用户回答。

## 新增 Agent 或能力

新增使用现有 Dock 能力的 Agent时，只增加 Worker adapter 和 runtime kind 注册，不修改 Pi adapter和不相关客户端。

Agent 出现新的真实能力时，在 Protocol V2 定义一次，由提供该能力的 Worker adapter 产生，再由需要它的客户端实现。Host 只有在这项能力确实增加新的控制或生命周期规则时才需要变化。

## 代码范围

- `src/pi/`：当前 Pi Worker、Pi adapter 与 Worker 进程实现。
- `src/control/`：Host control、Worker supervision 与 session routing。
- `src/core/`：Dock 自己的协议数据与跨实现概念，不依赖 Pi runtime。
- `src/tui/`：SSH 客户端，不持有 Agent runtime。

具体实现应服从以上边界。任何普通 Agent 能力如果需要在多个层次重复定义和投影，应先修正边界，而不是继续增加转发代码。
