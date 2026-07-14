# Alu Dock

Alu Dock 是 #136「受管运行时宿主」的独立实现；V0 执行卡为 #137，V0.1 工程入口为 #142。

V0 已验证官方 Pi SDK session 可由独立本机宿主持有，并通过结构化 Unix-socket 控制面跨客户端观察和继续交互。真人连续性验收结论为 **PASS**，不再向 V0 回填需求。V0.1 阶段 0 已冻结 SSH 默认 Pi 研发终端、`systemd --user` 常驻 Host、协议 V2、显式 session reopen、当前扩展兼容和故障边界，结论为 **GO**；阶段 1 Runtime/协议底座已完成 V2 foundation、Host-owned `AgentSessionRuntime`、project trust、tools/settings/resources closed projection，以及 catalog transaction/mutation-faulted seam。旧 `alu-daemon`、Rails WebConsole、Redis bridge 与 Alubot 不在本仓库的修改范围内。

## 当前进度

- [x] 阶段 0：实施前可行性门禁（ADJUST → GO）
- [x] 阶段 1：SDK 单实例生命周期探针
- [x] 阶段 2：Unix socket 宿主与跨客户端观察
- [x] 阶段 3：第二客户端继续交互与显式停止
- [x] 阶段 3.5：自动宿主启动与真人可用薄 TUI
- [x] 阶段 4：默认资源兼容与体验评估；V0 PASS

详细文档：

- [`docs/feasibility.md`](docs/feasibility.md)
- [`docs/plan.md`](docs/plan.md)
- [`docs/validation-stage-1.md`](docs/validation-stage-1.md)
- [`docs/validation-stage-2.md`](docs/validation-stage-2.md)
- [`docs/validation-stage-3.md`](docs/validation-stage-3.md)
- [`docs/validation-stage-3-5.md`](docs/validation-stage-3-5.md)
- [`docs/v0-evaluation.md`](docs/v0-evaluation.md)
- [`docs/v0.1-capability-matrix.md`](docs/v0.1-capability-matrix.md)
- [`docs/control-protocol-v2.md`](docs/control-protocol-v2.md)
- [`docs/v0.1-plan.md`](docs/v0.1-plan.md)
- [`docs/validation-v0.1-stage-0.md`](docs/validation-v0.1-stage-0.md)
- [`docs/validation-v0.1-stage-1a.md`](docs/validation-v0.1-stage-1a.md)
- [`docs/validation-v0.1-stage-1b-runtime-trust.md`](docs/validation-v0.1-stage-1b-runtime-trust.md)
- [`docs/validation-v0.1-stage-1c-projections.md`](docs/validation-v0.1-stage-1c-projections.md)
- [`docs/validation-v0.1-stage-1d-transactions.md`](docs/validation-v0.1-stage-1d-transactions.md)

## V0.1 工程入口

#142 是 V0.1 唯一工程状态入口。阶段 0 已确认没有新增产品阻塞；实现按 Runtime/协议、SSH TUI、日常控制、Extension UI、systemd/catalog/reopen、tree/fork/clone 和最终真人验收推进。

**绿地规则：** Alu Dock 是全新项目。到 1.0 落地前，除非用户特意说明，不考虑任何旧协议、旧 Host、旧数据、旧 CLI 行为的兼容或迁移；原型合同直接替换。版本号仅标识当前合同，不表示存在历史包袱。

阶段 0 文档描述的是 V0.1 **目标合同**。阶段 1 已将当前控制面切为 V2-only，并完成 Runtime replacement、project trust、closed projections及 registry transaction/fault seam。Durable atomic catalog、startup reconcile、explicit reopen与 `systemd --user` 唯一常驻 Host仍属于阶段 5；当前入口仍会按需 detached 启动 Host。

## 当前过渡期真人入口

直接运行：

```bash
npm run cli
```

该入口会自动检查并按需在后台启动 Host，无需先开一个终端执行 `serve`。它按当前 cwd 查找活动实例：没有则创建，一个则直接重连，多个则显示选择器。进入 TUI 后可直接输入消息并查看流式回复和近期活动。

常用操作：

- `Enter`：发送；运行中默认作为 steer
- `/follow MESSAGE`：排队为 follow-up
- `/model`：打开 Pi 可用模型选择器（包含已配置认证的本地自定义模型）
- `/model PROVIDER/MODEL`：直接切换模型
- `/thinking LEVEL`：设置 Pi thinking level；`/thinking` 查看当前可选值
- `/status`：刷新状态
- `/detach` 或空编辑器时 `Ctrl+D`：只离开 TUI，实例继续由 Host 持有
- `/stop`：显式停止实例

也可以明确新建或接入：

```bash
npm run cli -- new --cwd "$PWD" --name demo
npm run cli -- attach INSTANCE_ID
```

再次执行 `npm run cli` 会重放 Host 的近期消息并继续观察 live events。模型/thinking 切换沿用 Pi 的 session 与 settings 语义，只允许实例 idle 时执行；当前运行不会被中途换模。Host 在创建 Pi SDK session 前安装与 Pi CLI 相同的 Undici `EnvHttpProxyAgent`：优先保留进程已有 `HTTP_PROXY` / `HTTPS_PROXY`，缺失时采用 Pi 全局 `httpProxy` 设置。默认 socket 为 `$XDG_RUNTIME_DIR/alu-dock/dock.sock`，未设置 XDG 时为 `~/.alu-dock/run/dock.sock`；后台日志位于 socket 同目录的 `host.log`。

## 机器与诊断接口

以下命令保留结构化 JSONL 输出，供测试、脚本和排障使用：

```bash
npm run cli -- serve
npm run cli -- create --cwd "$PWD" --name demo
npm run cli -- list
npm run cli -- status INSTANCE_ID
npm run cli -- events INSTANCE_ID --follow
# resume only with the complete cursor returned by the prior response:
npm run cli -- events INSTANCE_ID --cursor HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE --follow
npm run cli -- prompt INSTANCE_ID "start a new run"
npm run cli -- prompt INSTANCE_ID --delivery followUp "then summarize"
npm run cli -- stop INSTANCE_ID
```

也可用 `--socket PATH` 或 `ALU_DOCK_SOCKET` 指定 socket。`prompt` receipt 只表示 preflight 已接受；`queued=true` 不表示任务完成。socket 父目录必须为当前用户私有目录，socket mode 固定为 `0600`。

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

## V0 历史非目标

以下是已经 PASS 并冻结的 V0 边界；其中 Host lifecycle、systemd 和显式 session reopen 已由 V0.1 #142 正式纳入，不能继续把本节当作 V0.1 非目标：

- 面向用户的 Host status/stop/restart 生命周期管理
- Host 重启后发现或重开旧 Pi session
- 宿主故障后继续、恢复或自动重放正在执行的任务
- 跨机器、广域网、账号体系
- 工作目录互斥与通用调度
- 完整复刻 stock Pi TUI、PTY 或 screen 转发
- 完整 Extension UI broker
