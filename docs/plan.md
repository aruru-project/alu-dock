# Alu Dock V0 分阶段计划

## 原则

- 每阶段单独实现、验证和提交；上一阶段通过门禁后才进入下一阶段。
- 只有一个写入线程；旧 daemon、Rails WebConsole、Redis bridge 和生产部署保持只读。
- V0 是可废弃探针，不提前建设通用调度、账号、跨机、PTY/TUI 或完整恢复平台。

## 阶段 0：实施前门禁（已通过）

交付：

- `docs/feasibility.md`
- 本计划

结论：ADJUST → GO；采用同进程 Pi SDK + 宿主适配层。

## 阶段 1：SDK 单实例探针（已通过）

目标：证明运行所有权可以从调用方移到宿主对象。

范围：

- 最小 TypeScript 工程，固定 Pi SDK 0.80.6。
- `ManagedInstance`：宿主身份与 Pi session identity 分离。
- 持久 `SessionManager`。
- `prompt()` 后台持有与 preflight receipt。
- 结构化状态、单调事件序号和有限事件环。
- `agent_settled` 最终稳定判定。
- `clearQueue()` + `abort()` + `dispose()` 显式 stop。
- 不调用真实模型的状态/生命周期单元测试。
- 可选真实 SDK smoke 脚本。

验证合同：

- submit 在 preflight 接受后返回，不等待完整运行。
- listener 抛错不能破坏实例事件处理。
- `agent_end` 不会提前转 idle；`agent_settled` 才转稳定。
- success / failed / aborted / stopped 可区分。
- stop 幂等，且新命令在 stopping/stopped 时被拒绝。

停止门禁：SDK 无法 detached prompt，或 headless 默认资源必然阻塞。

## 阶段 2：本地宿主与跨客户端观察（已通过）

目标：证明创建客户端退出后，第二客户端仍能识别并观察同一实例。

范围：

- Node 常驻 host。
- 用户私有 Unix domain socket。
- `Map<instanceId, ManagedInstance>` 为唯一权威。
- JSONL 请求/响应；事件使用 NDJSON 流。
- CLI：`serve`、`create`、`list`、`status`、`events --since`。
- client A 创建后退出；client B 使用稳定 `instanceId` 查询和接入。

验证合同：

- 断开创建/观察客户端只移除 socket，不终止后台任务。
- 第二客户端获得同一实例快照、Pi session 元数据和近期事件。
- 事件游标可补取断线期间的近期活动。
- socket 权限仅当前用户可访问。

停止门禁：客户端断开会取消后台运行，或事件无法可靠重放。

## 阶段 3：继续交互与显式停止（已通过）

目标：证明第二客户端能控制同一实例，而不仅是观看。

范围：

- CLI：`prompt`（空闲时新一轮；运行时显式 steer/follow-up）和 `stop`。
- 接受回执含 `commandId`，不把“已入队”误报为“已完成”。
- stop 状态机、队列清理、abort、幂等控制结果。
- host 的 SIGTERM/SIGINT 有界关闭。

验证合同：

- 第二客户端可对同一实例继续交互。
- 长任务不因客户端切换被杀死。
- stop 请求、aborted 运行结果和 stopped 生命周期可区分。
- `agent_end` 后的 retry/compaction/queue 不会产生假 idle。

停止门禁：控制结果只能从终端字符猜测，或状态存在不可消除竞态。

## 阶段 4：兼容性与体验评估

目标：决定是否值得继续投入。

范围：

- 默认 resources/skills 加载。
- 少量高频自有扩展探针；记录 headless UI 行为。
- 一次真实双客户端长任务演示。
- 与“终端手动运行 + 远程终端复连”比较收益与限制。

验收证据：

- 命令、退出码、结构化事件日志和实例快照。
- 支持项、失败项、限制与后续建议。
- 明确 GO / ADJUST / STOP 产品建议。

停止门禁：跨客户端结构化接入没有明显改善，或兼容成本已超出 V0 边界。
