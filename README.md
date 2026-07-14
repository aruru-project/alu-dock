# Alu Dock

Alu Dock 是 #136「受管运行时宿主」的独立、可废弃 V0 可行性实现，执行卡为 #137。

当前 V0 验证官方 Pi SDK session 能否由独立本机宿主持有，并通过结构化 Unix-socket 控制面跨客户端观察。旧 `alu-daemon`、Rails WebConsole、Redis bridge 与生产部署不在本仓库的修改范围内。

## 当前进度

- [x] 阶段 0：实施前可行性门禁（ADJUST → GO）
- [x] 阶段 1：SDK 单实例生命周期探针
- [x] 阶段 2：Unix socket 宿主与跨客户端观察
- [x] 阶段 3：第二客户端继续交互与显式停止
- [ ] 阶段 4：默认资源兼容与体验评估

详细文档：

- [`docs/feasibility.md`](docs/feasibility.md)
- [`docs/plan.md`](docs/plan.md)
- [`docs/validation-stage-1.md`](docs/validation-stage-1.md)
- [`docs/validation-stage-2.md`](docs/validation-stage-2.md)
- [`docs/validation-stage-3.md`](docs/validation-stage-3.md)

## 本地宿主与薄 CLI

宿主以前台常驻进程运行；客户端命令是一次性进程。默认 socket 为 `$XDG_RUNTIME_DIR/alu-dock/dock.sock`，未设置 XDG 时为 `~/.alu-dock/run/dock.sock`。socket 的直接父目录必须属于当前用户且不能授权 group/other，socket mode 固定为 `0600`。

终端 A：

```bash
npm run cli -- serve
```

终端 B（每条命令都可以是新的客户端进程）：

```bash
npm run cli -- create --cwd "$PWD" --name demo
npm run cli -- list
npm run cli -- status INSTANCE_ID
npm run cli -- events INSTANCE_ID --since 0
npm run cli -- events INSTANCE_ID --since SEQUENCE --follow
npm run cli -- prompt INSTANCE_ID "start a new run"
npm run cli -- prompt INSTANCE_ID --delivery steer "change direction"
npm run cli -- prompt INSTANCE_ID --delivery followUp "then summarize"
npm run cli -- stop INSTANCE_ID
```

也可用 `--socket PATH` 或 `ALU_DOCK_SOCKET` 指定 socket。所有输出均为一行一个 JSON 对象，不转发终端屏幕。`prompt` 的 receipt 只表示 preflight 已接受；`queued=true` 表示 steer/follow-up 已排队，不表示任务完成。`stop` 可重复调用，receipt 会区分首次停止与 `alreadyStopped`。

## 状态模型

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

- 宿主故障后继续、恢复或自动重放正在执行的任务
- 跨机器、广域网、账号体系
- 工作目录互斥与通用调度
- stock Pi TUI / PTY / screen 转发
- 完整 Extension UI broker
