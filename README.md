# Alu Dock

Alu Dock 是 #136「受管运行时宿主」的独立、可废弃 V0 可行性实现，执行卡为 #137。

当前阶段只验证官方 Pi SDK 能否被宿主对象持有，并投影为可解释的实例状态。旧 `alu-daemon`、Rails WebConsole、Redis bridge 与生产部署不在本仓库的修改范围内。

## 当前进度

- [x] 阶段 0：实施前可行性门禁（ADJUST → GO）
- [x] 阶段 1：SDK 单实例生命周期探针
- [ ] 阶段 2：Unix socket 宿主与跨客户端观察
- [ ] 阶段 3：第二客户端继续交互与显式停止
- [ ] 阶段 4：默认资源兼容与体验评估

详细文档：

- [`docs/feasibility.md`](docs/feasibility.md)
- [`docs/plan.md`](docs/plan.md)

## 阶段 1 状态模型

状态不是一个含糊枚举，而是三个维度：

- `lifecycle`: `active | stopping | stopped`
- `execution`: `idle | running | failed`
- `lastRun`: `never | succeeded | failed | aborted`

Alu Dock 的 `instanceId` 与 Pi 的 `piSessionId/sessionFile` 分离。`prompt()` 在 SDK preflight 接受后返回 receipt，完整 Promise 留在宿主后台；最终稳定以 `agent_settled` 为准，不使用 `agent_end` 猜测。

## 开发

要求 Node.js 22.19+。

```bash
npm install
npm run check
npm test
```

## 可选真实 SDK smoke

会使用当前 `~/.pi/agent` 的模型、认证、默认 resources 和 extensions，并产生真实模型调用：

```bash
npm run smoke:sdk -- --cwd "$PWD"
```

中途验证 abort：

```bash
npm run smoke:sdk -- \
  --cwd "$PWD" \
  --prompt "先用 bash 执行 sleep 30，再回复完成" \
  --abort-after-ms 3000
```

输出是结构化 JSONL（snapshot、receipt、事件、settled/final），不是终端屏幕转发。

## V0 非目标

- 宿主重启后恢复正在执行的任务
- 跨机器、广域网、账号体系
- 工作目录互斥与通用调度
- stock Pi TUI / PTY / screen 转发
- 完整 Extension UI broker
