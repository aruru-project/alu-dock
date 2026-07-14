# Alu Dock V0 可行性门禁

关联卡：#137；产品母题：#136。

日期：2026-07-14  
审查基线：`@earendil-works/pi-coding-agent` 0.80.6

## 结论

**ADJUST → GO**：继续使用官方 Pi SDK 做首个 executor，但不把 `AgentSession` 直接暴露为产品控制面。Alu Dock 必须补一层独立宿主语义：稳定实例身份、后台运行所有权、结构化状态投影、可重放事件和显式停止。

没有证据要求改成每实例 `pi --mode rpc` 子进程。RPC 会带来更强进程隔离，但会违反 #137 首个 executor 使用官方 SDK 的当前验收方向，并扩大进程监督与协议桥接范围。

## 已核实的公开契约

来源：

- Pi `docs/sdk.md`
- Pi `docs/rpc.md`
- Pi `docs/session-format.md`
- Pi `docs/extensions.md`
- Pi 0.80.6 导出的 `AgentSession` / `SessionManager` 类型与实现

关键事实：

1. `createAgentSession()` 可在 Node 进程内创建独立 `AgentSession`。
2. `AgentSession.subscribe()` 提供消息、工具、队列、重试、压缩和 agent 生命周期事件。
3. `prompt()` 的 Promise 在整段运行结束后才完成；请求处理器不能直接等待它后再回复客户端。
4. `PromptOptions.preflightResult` 可区分“已接受/入队”和“接受前拒绝”。
5. `steer()` / `followUp()` 只保证消息入队，不表示运行完成。
6. `agent_end` 后仍可能自动重试、压缩重试或处理排队消息；最终稳定点是 `agent_settled`。
7. `abort()` 会中止当前运行并等待 session 进入 idle；`clearQueue()` 可先清除排队消息。
8. `SessionManager.create(cwd)` 提供持久 JSONL 会话，但只能恢复对话上下文，不能恢复宿主进程中正在执行的 Promise、工具进程或事件订阅。
9. SDK 默认 headless UI 为 no-op：`hasUI=false`，`select/input/editor` 立即返回 `undefined`，`confirm` 返回 `false`，不会在无人接入时永久阻塞。

## 必须调整的语义

### 身份

- `instanceId`：Alu Dock 分配的稳定宿主身份，跨客户端使用。
- `piSessionId` / `sessionFile`：Pi 对话持久化身份，仅作为 executor 元数据。
- 两者不得混用。

### 状态

Pi 没有 #136 所需的单一产品状态枚举。V0 拆成三个正交维度：

- `lifecycle`: `active | stopping | stopped`
- `execution`: `idle | running | failed`
- `lastRun`: `never | succeeded | failed | aborted`

解释：

- `active + idle`：等待下一次交互；若 `lastRun=succeeded`，表示上一轮已稳定完成。
- `active + running`：运行、重试、压缩重试或排队续跑尚未最终稳定。
- `active + failed`：上一轮最终失败，但实例仍可接受后续交互。
- `stopped`：显式停止后的终态。

### 所有权

- 宿主启动 `prompt()` 后立即返回 `accepted + commandId`，后台 Promise 由宿主持有。
- 客户端 socket 断开只取消该客户端的事件订阅，不触发 `abort()` 或 `dispose()`。
- 只有显式 `stop` 或宿主关闭才结束实例。

## 旧链路冻结依据

`alu-daemon` 当前是：

- 一个全局 `pi --mode rpc` 子进程；
- 一个全局 `$busy`；
- 在 `agent_end` 时错误地视为 idle；
- Redis pub/sub 全局命令与广播；
- Rails/WebConsole 围绕“当前活动 session”工作。

它能远程控制单一 Pi 会话，但不是多实例生命周期权威，无法直接满足 #136 的稳定实例身份、跨客户端同实例接入和结构化实例列表。V0 不修改也不复用该链路。

冻结范围：

- `/home/luziyi/workshop/alu-daemon`
- `/home/luziyi/workshop/alubot_admin` 的 WebConsole / Redis bridge
- 现有 systemd 与生产部署配置

## 风险与限制

1. 同进程多实例没有故障隔离；宿主崩溃会结束全部活实例。
2. 宿主重启后不恢复正在执行的任务；这是 V0 明确非目标。
3. 多实例共享 cwd 可能产生文件写冲突；工作目录互斥与调度延期。
4. 默认扩展可能使用模块级全局状态；多 session 兼容性必须实测。
5. Headless UI 会让需要确认的扩展 fail closed；TUI-only 扩展不在 V0 兼容承诺内。
6. 事件环形缓冲只保证当前宿主生命周期内的近期重放。
7. 真实长任务验证受模型、额度和模型工具选择影响。

## 总停止条件

出现以下任一情况，应停止 SDK 路线并重新评估：

- 后台 `prompt()` 实际依赖创建客户端连接存活；
- 客户端断开会导致 session 或工具执行被 SDK 自动取消；
- 无法用 `agent_settled` 和最终 assistant 结果可靠区分成功、失败、aborted；
- 默认资源在 `hasUI=false` 时不可避免地永久阻塞；
- 第二客户端只能看到字符屏幕，无法得到结构化状态和近期活动；
- 结构化接入相对手动终端/远程终端复连没有明显体验收益。
