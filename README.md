# Alu Dock

Alu Dock 是 #136「受管运行时宿主」的独立实现；V0 执行卡为 #137，V0.1 工程入口为 #142。

V0 已验证官方 Pi SDK session 可由独立本机宿主持有，并通过结构化 Unix-socket 控制面跨客户端观察和继续交互。真人连续性验收结论为 **PASS**，不再向 V0 回填需求。V0.1 阶段 0 已冻结 SSH 默认 Pi 研发终端、`systemd --user` 常驻 Host、协议 V2、显式 session reopen、当前扩展兼容和故障边界，结论为 **GO**；阶段 1 Runtime/协议底座、阶段 2 SSH TUI/Footer、阶段 3 日常控制、阶段 4 Extension UI 和阶段 5 durable Host lifecycle 均已完成源码与门禁。当前 Host 提供 V2 transaction/fault seam、private atomic catalog、startup reconcile、explicit reopen、持久 branch history projection、稳定 message/tool event、session metrics、可复用实例 abort、`session.commands.v1` 与 `extension_ui.v1`；薄 TUI 提供 fixed composer/history viewport、明确 run activity、默认折叠工具、Markdown/thinking/diff、动态 autocomplete、可检索 selector、完整 Footer、new/resume/name/compact/reload workflow，以及 attach-bound extension select/confirm/input/editor overlay。旧 `alu-daemon`、Rails WebConsole、Redis bridge 与 Alubot 不在本仓库的修改范围内。

## V0 冻结进度

- [x] 阶段 0：实施前可行性门禁（ADJUST → GO）
- [x] 阶段 1：SDK 单实例生命周期探针
- [x] 阶段 2：Unix socket 宿主与跨客户端观察
- [x] 阶段 3：第二客户端继续交互与显式停止
- [x] 阶段 3.5：自动宿主启动与真人可用薄 TUI
- [x] 阶段 4：默认资源兼容与体验评估；V0 PASS

## V0.1 进度

- [x] 阶段 0：合同冻结（GO）
- [x] 阶段 1：Runtime 与 Protocol V2 底座
- [x] 阶段 2：SSH TUI 核心与 Footer
- [x] 阶段 3：日常控制与核心 Session
- [x] 阶段 3.5：轻度结构重构与项目 `AGENTS.md`
- [x] 阶段 3.6：Dogfood release 与 `systemd --user` managed service基线
- [x] Dogfood TUI UX 源码与验证门禁（#147）
- [ ] #147 与阶段 4 managed rollout（随阶段 5 immutable release 一并验证）
- [x] 阶段 4：Extension UI 源码、真实 Pi/PTY 与七扩展兼容门禁
- [x] 阶段 5：`systemd --user`、durable catalog 与 explicit reopen
- [ ] 阶段 6：tree/fork/clone
- [ ] 最终真人默认入口验收

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
- [`docs/validation-v0.1-stage-2-ssh-tui.md`](docs/validation-v0.1-stage-2-ssh-tui.md)
- [`docs/validation-v0.1-stage-3-daily-control.md`](docs/validation-v0.1-stage-3-daily-control.md)
- [`docs/validation-v0.1-stage-3.5-structure.md`](docs/validation-v0.1-stage-3.5-structure.md)
- [`docs/validation-v0.1-command-catalog-startup-hotfix.md`](docs/validation-v0.1-command-catalog-startup-hotfix.md)
- [`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)
- [`docs/validation-v0.1-stage-3.6-dogfood-release.md`](docs/validation-v0.1-stage-3.6-dogfood-release.md)
- [`docs/validation-v0.1-dogfood-tui-ux.md`](docs/validation-v0.1-dogfood-tui-ux.md)
- [`docs/validation-v0.1-stage-4-extension-ui.md`](docs/validation-v0.1-stage-4-extension-ui.md)
- [`docs/validation-v0.1-stage-5-durable-host.md`](docs/validation-v0.1-stage-5-durable-host.md)
- [`docs/v0.2-terminal-core-design.md`](docs/v0.2-terminal-core-design.md)

## V0.1 工程入口

#142 是 V0.1 唯一工程状态入口。阶段 0–5、dogfood UX 与 Extension UI 源码/门禁均已完成；当前下一入口为阶段 6 tree/fork/clone，随后进行最终真人默认入口验收。

**绿地规则：** Alu Dock 是全新项目。到 1.0 落地前，除非用户特意说明，不考虑任何旧协议、旧 Host、旧数据、旧 CLI 行为的兼容或迁移；原型合同直接替换。版本号仅标识当前合同，不表示存在历史包袱。

阶段 0 文档描述的是 V0.1 **目标合同**。阶段 1 已将当前控制面切为 V2-only，并完成 Runtime replacement、project trust、closed projections及 registry transaction/fault seam；阶段 2 advertised `tui.projection.v1` 与独立的 `run.abort.v1`；阶段 3 advertised `session.commands.v1` 并完成日常 settings/session workflows；阶段 3.5 完成轻度拆分；阶段 3.6 建立不可变 release、稳定 launcher、真实资源 smoke 和 baseline user service。#147 已完成 fixed composer、viewport、活动状态、工具折叠和可检索 selector；阶段 4 advertised `extension_ui.v1`，加入单 controller lease、Host-owned dialog queue、结构化 notify/status 和当前扩展兼容。阶段 5 advertised `catalog.v1`、`service.managed.v1` 与 `session.reopen`，实现 socket-first startup、0700/0600 atomic catalog、prior-epoch reconcile、no-replay Host loss、explicit reopen和完整 service CLI；普通入口不再启动 detached Host。V0.2 #148 的 direct `pi-tui` dependency inventory、Terminal Core API、provenance政策、OpenClaw固定commit审计和一次性切换计划已冻结在 [`docs/v0.2-terminal-core-design.md`](docs/v0.2-terminal-core-design.md)；renderer实施不属于V0.1。

## 当前默认真人入口

直接运行：

```bash
alu-dock
```

该入口连接已启用的 `alu-dock.service`，不会调用 systemctl或静默 fork detached Host；service不可用时返回 `service_unavailable` 与明确诊断。它按当前 cwd 查找实例：没有则创建，一个 active则直接重连，存在 `host_lost/runtime_error` 时由选择器要求用户显式 reopen。Reopen保持 Dock ID与creation metadata、generation +1，并恢复Pi session context，但不恢复或重放旧 prompt、queue、Promise或tool effect。

常用操作：

- `Enter`：发送；运行中默认作为 steer；Editor 支持 multiline paste 与 history
- `Alt+Enter` 或 `/follow MESSAGE`：排队为 follow-up
- `Esc`、空编辑器 `Ctrl+C` 或 `/abort`：取消当前 run/retry/compaction，实例保持可复用
- `PageUp` / `PageDown`：回看独立 history viewport；回看时暂停追尾并提示新输出，`Ctrl+End` 回到底部
- `Ctrl+O`：展开/折叠全部 generic tool output；`Alt+O` 只切换最近一项详情；工具默认折叠
- `/settings`：查看全部 24 项投影并选择修改；也可用 `/settings KEY VALUE`。其中 compaction reserve/keep tokens 因 Pi 无公开 setter而只读
- `/model`：打开可输入检索的 Pi 模型选择器（name/provider/id）；`/model PROVIDER/MODEL` 直接切换
- `/thinking`：打开 thinking selector；`/thinking LEVEL` 直接设置
- `/tools`：逐项切换 active tools；`/tools NAME…` 设置完整 active set，`/tools none` 清空
- `/new [PARENT_SESSION]`、`/resume [SESSION_FILE]`：新建或在当前 Host 内切换 Pi session
- `/name NAME`（`/name -` 清除）、`/compact [INSTRUCTIONS]`、`/reload`
- `/resources`：查看 resource metadata 与 diagnostics
- `/install`、`/config`、`/login`：提示在独立 shell 使用原 Pi CLI
- `/status`：刷新状态
- extension `select/confirm/input/editor` 使用居中结构化 overlay；Esc/Ctrl+C 取消，confirm 默认停在 No；lease 状态显示为 `connected/acquired|unavailable`
- `/detach` 或空编辑器时 `Ctrl+D`：只离开 TUI，实例继续由 Host 持有
- `/stop`：显式停止实例

也可以明确新建或接入：

```bash
alu-dock service install --now
alu-dock service status
alu-dock new --cwd "$PWD" --name demo
alu-dock attach INSTANCE_ID
```

再次执行 `alu-dock` 会先投影 Pi SessionManager 当前 branch 的持久 history baseline，再重放 Host 近期 events 并继续观察 live events。Composer 固定在终端底部并向上增长，history 在上方独立滚动；活动行明确区分 waiting/thinking/responding/tool/retry/compaction/queue/host-loss。TUI Footer 展示 cwd、Dock/Pi ID、model/thinking、state/queue、tokens/context/cache/cost、extension status 和 connection/lease；extension/skill/prompt commands 与路径进入 autocomplete。模型/thinking 切换沿用 Pi 的 session 与 settings 语义，只允许实例 idle 时执行；当前运行不会被中途换模。Host 在创建 Pi SDK session 前安装与 Pi CLI 相同的 Undici `EnvHttpProxyAgent`：优先保留进程已有 `HTTP_PROXY` / `HTTPS_PROXY`，缺失时采用 Pi 全局 `httpProxy` 设置。默认 socket 为 `$XDG_RUNTIME_DIR/alu-dock/dock.sock`；managed 日志使用 `journalctl --user -u alu-dock.service`。

## 机器与诊断接口

以下命令保留结构化 JSONL 输出，供测试、脚本和排障使用：

```bash
alu-dock ping
alu-dock create --cwd "$PWD" --name demo
alu-dock list
alu-dock reopen INSTANCE_ID
alu-dock status INSTANCE_ID
alu-dock events INSTANCE_ID --follow
# resume only with the complete cursor returned by the prior response:
alu-dock events INSTANCE_ID --cursor HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE --follow
alu-dock prompt INSTANCE_ID "start a new run"
alu-dock prompt INSTANCE_ID --delivery followUp "then summarize"
alu-dock stop INSTANCE_ID
```

也可用 `--socket PATH` 或 `ALU_DOCK_SOCKET` 指定 socket。`prompt` receipt 只表示 preflight 已接受；`queued=true` 不表示任务完成。socket 父目录必须为当前用户私有目录，socket mode 固定为 `0600`。

## 状态模型

状态不是一个含糊枚举，而是三个维度：

- `lifecycle`: `active | stopping | stopped | host_lost | runtime_error`
- `execution`: `idle | running | failed | unavailable`
- `lastRun`: `never | succeeded | failed | aborted | interrupted`

Alu Dock 的 `instanceId` 与 Pi 的 `piSessionId/sessionFile` 分离。`prompt()` 在 SDK preflight 接受后返回 receipt，完整 Promise 留在宿主后台；最终稳定以 `agent_settled` 为准，不使用 `agent_end` 猜测。

## 开发

要求 Node.js 22.19+。

```bash
npm install
npm run check
npm test
# checkout client against the managed service; not release evidence:
npm run cli
# explicit custom-socket in-memory development Host:
npm run serve
# after a clean committed stage gate:
npm run deploy:dogfood
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
