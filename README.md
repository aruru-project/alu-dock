# Alu Dock

Alu Dock 是 #136「受管运行时宿主」的独立实现；V0 执行卡为 #137，V0.1 工程入口为 #142。

V0 已验证官方 Pi SDK session 可由独立本机宿主持有，并通过结构化 Unix-socket 控制面跨客户端观察和继续交互。真人连续性验收结论为 **PASS**，不再向 V0 回填需求。V0.1 阶段 0 已冻结 SSH 默认 Pi 研发终端、`systemd --user` 常驻 Host、协议 V2、显式 session reopen、当前扩展兼容和故障边界，结论为 **GO**；阶段 1 Runtime/协议底座、阶段 2 SSH TUI/Footer、阶段 3 日常控制、阶段 4 Extension UI、阶段 5 durable Host lifecycle 与阶段 6 tree/fork/clone 均已完成源码、自动化门禁与managed rollout。当前Host提供V2 transaction/fault seam、private atomic catalog、startup reconcile、explicit reopen、revision-bound catalog listing/maintenance、持久branch/tree projection、稳定message/tool event、session metrics、可复用实例abort、`session.commands.v1`、`session.tree.v1`、`queue.control.v1`、`catalog.maintenance.v1`与`extension_ui.v1`；薄TUI提供Night Console single-column transcript、fixed composer与两行status dock、可反向分页、键盘canonical且按需启用Dock滚轮的有界history viewport、明确run activity、默认折叠工具、Markdown/thinking/diff、动态autocomplete、可检索selector、完整Footer、诚实pending queue tray与Alt+Up/Esc恢复、new/resume/name/compact/reload/tree/fork/clone workflow，以及attach-bound extension select/confirm/input/editor overlay。旧`alu-daemon`、Rails WebConsole、Redis bridge与Alubot不在本仓库的修改范围内。

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
- [x] #147 与阶段 4 managed rollout（随阶段 5 immutable release完成）
- [x] 阶段 4：Extension UI 源码、真实 Pi/PTY 与七扩展兼容门禁
- [x] 阶段 5：`systemd --user`、durable catalog 与 explicit reopen
- [x] 阶段 6：tree/fork/clone（源码、自动化门禁与managed rollout）
- [x] #157 tool render storm、#154 queue诚实时序/撤回与#155长历史/滚轮修正
- [x] #156 Night Console语义配色、single-column transcript与两行status dock
- [ ] #158最终真人默认入口验收（完成基线1/6后由#164暂停）
- [ ] #164人工验收阻塞闸门（旧#161–#167候选被真人发现的#160/#169/#170稳定化需求取代；等待新consolidated release与用户Windows Terminal/PowerShell验收）

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
- [`docs/validation-v0.1-stage-6-tree-fork-clone.md`](docs/validation-v0.1-stage-6-tree-fork-clone.md)
- [`docs/validation-v0.1-tool-render-performance.md`](docs/validation-v0.1-tool-render-performance.md)
- [`docs/validation-v0.1-queue-consumption.md`](docs/validation-v0.1-queue-consumption.md)
- [`docs/validation-v0.1-history-pagination.md`](docs/validation-v0.1-history-pagination.md)
- [`docs/v0.1-night-console-design.md`](docs/v0.1-night-console-design.md)
- [`docs/validation-v0.1-night-console.md`](docs/validation-v0.1-night-console.md)
- [`docs/validation-v0.1-tool-summaries.md`](docs/validation-v0.1-tool-summaries.md)
- [`docs/validation-v0.1-composer-stability.md`](docs/validation-v0.1-composer-stability.md)
- [`docs/validation-v0.1-terminal-selection.md`](docs/validation-v0.1-terminal-selection.md)
- [`docs/validation-v0.1-command-handled-projection.md`](docs/validation-v0.1-command-handled-projection.md)
- [`docs/validation-v0.1-activity-slot.md`](docs/validation-v0.1-activity-slot.md)
- [`docs/validation-v0.1-cli-help.md`](docs/validation-v0.1-cli-help.md)
- [`docs/validation-v0.1-human-list.md`](docs/validation-v0.1-human-list.md)
- [`docs/validation-v0.1-acceptance-blockers-rollout.md`](docs/validation-v0.1-acceptance-blockers-rollout.md)
- [`docs/validation-v0.1-dogfood-stabilization.md`](docs/validation-v0.1-dogfood-stabilization.md)
- [`docs/validation-v0.1-extension-command-admission.md`](docs/validation-v0.1-extension-command-admission.md)
- [`docs/v0.2-terminal-core-design.md`](docs/v0.2-terminal-core-design.md)

## V0.1 工程入口

#142是V0.1工程状态入口。阶段0–6、dogfood UX与Extension UI主体能力已完成，Stage 6 invariants保持冻结。#160/#169/#170的264-test consolidated gate、immutable rollout、managed/loopback回归已部署于`20260716T111829Z-d19aa7e4b9d6`；它仍只是#164验收候选，等待用户亲自在Windows Terminal → PowerShell → SSH签收。#158暂停于基线1/6；只有用户完成#164后才能决定是否恢复验收。V0.2 renderer仍由#148独立排期。

**绿地规则：** Alu Dock 是全新项目。到 1.0 落地前，除非用户特意说明，不考虑任何旧协议、旧 Host、旧数据、旧 CLI 行为的兼容或迁移；原型合同直接替换。版本号仅标识当前合同，不表示存在历史包袱。

阶段0文档描述的是V0.1**目标合同**。阶段1已将当前控制面切为V2-only，并完成Runtime replacement、project trust、closed projections及registry transaction/fault seam；阶段2 advertised `tui.projection.v1`与独立的`run.abort.v1`；阶段3 advertised `session.commands.v1`并完成日常settings/session workflows；阶段3.5完成轻度拆分；阶段3.6建立不可变release、稳定launcher、真实资源smoke和baseline user service。#147已完成fixed composer、viewport、活动状态、工具折叠和可检索selector；阶段4 advertised `extension_ui.v1`，加入单controller lease、Host-owned dialog queue、结构化notify/status和当前扩展兼容。阶段5 advertised `catalog.v1`、`service.managed.v1`与`session.reopen`，实现socket-first startup、0700/0600 atomic catalog、prior-epoch reconcile、no-replay Host loss、explicit reopen和完整service CLI；普通入口不再启动detached Host。阶段6 advertised `session.tree.v1`，通过公开`navigateTree()`与`AgentSessionRuntime.fork()`实现revision-bound tree、fork-before、clone-at-leaf、selected editor text、extension hook/abort与deferred session-file recovery。#154随后advertised `queue.control.v1`，将queued正文保持为Same-Host ephemeral projection，并以公开user `message_start`作为正式conversation边界。#155在不增加capability的前提下复用`session.history`反向页，加入有界历史窗口、entry/row锚点、统一PageUp/PageDown/滚轮和成对terminal mouse mode。#156落地Night Console：无常驻role标签、user局部surface、thinking rail、tool生命周期语义色、composer后两行width-aware status dock；不设置全屏背景且不改变queue/runtime语义。V0.2 #148的direct `pi-tui` dependency inventory、Terminal Core API、provenance政策、OpenClaw固定commit审计和一次性切换计划已冻结在[`docs/v0.2-terminal-core-design.md`](docs/v0.2-terminal-core-design.md)；renderer实施不属于V0.1。

## 当前默认真人入口

直接运行：

```bash
alu-dock
```

外部人类CLI可从本地只读help逐层探索；help不连接daemon、不调用systemd且不生成operation：

```bash
alu-dock --help
alu-dock help open
alu-dock service logs --help
```

顶层展示`open/new/attach/list/status/stop/forget/prune/service/help`。默认`alu-dock list`只请求revision-bound的actionable页并隐藏stopped历史；`list --all`查看有界历史页。两者都按终端宽度最多输出100个两行摘要（短ID、name、state、generation、model、cwd及条件pending/reopen），并报告完整计数；机器消费者通过typed DockClient/V2逐页读取完整closed catalog。`forget ID`只移除stopped/host-lost/runtime-error Dock record，`prune --stopped`只批量移除stopped record；两者都不删除Pi session文件。内部测试/诊断入口不会与人类workflow等权出现；明确请求其help时只会引导到人类命令和typed DockClient/Protocol V2。

该入口连接已启用的 `alu-dock.service`，不会调用 systemctl或静默 fork detached Host；service不可用时返回 `service_unavailable` 与明确诊断。它按当前 cwd 查找实例：没有则创建，一个 active则直接重连，存在 `host_lost/runtime_error` 时由选择器要求用户显式 reopen。Reopen保持 Dock ID与creation metadata、generation +1，并恢复Pi session context，但不恢复或重放旧 prompt、queue、Promise或tool effect。

常用操作：

- `Enter`：发送；运行中默认作为 steer；Editor 支持 multiline paste 与 history
- `Alt+Enter` 或 `/follow MESSAGE`：排队为 follow-up；未消费文本只显示在composer上方的pending tray，不提前写入正式transcript
- `Alt+Up`：按steering-first、follow-up-later顺序撤回全部仍可撤回的未消费queue到editor，不中止当前run；已离开Pi内部queue、正等待公开`message_start`的极窄in-flight窗口不会被复制
- `Esc`、空编辑器 `Ctrl+C` 或 `/abort`：正常对话中Esc先尝试恢复queue，只有全部可撤回正文成功回到editor后才取消当前run/retry/compaction；存在`inFlight`、失败或`effect_unknown`时不伪称恢复、不中止run。tree branch summary进行中时调用公开`abortBranchSummary()`路径，实例保持可复用
- `PageUp` / `PageDown`：始终操作同一独立history viewport；到达顶部按200项反向加载，prepend保持entry/row视觉锚点，回看时暂停追尾并提示新输出；`Ctrl+End`回到保留的最新页/底部
- 普通拖动：默认由终端原生框选，Windows Terminal复制使用`Ctrl+Shift+C`。`Alt+M`或`/mouse`显式启用Dock 1000/1006 mouse tracking后，滚轮操作app-owned history、`Shift+拖动`仍可绕过；Esc或同快捷键恢复默认terminal selection。默认模式的普通wheel不承诺Dock内部history语义
- `Ctrl+O`：展开/折叠全部 generic tool output；`Alt+O` 只切换最近一项详情；工具默认折叠
- `/settings`：查看全部 24 项投影并选择修改；也可用 `/settings KEY VALUE`。其中 compaction reserve/keep tokens 因 Pi 无公开 setter而只读
- `/model`：打开可输入检索的 Pi 模型选择器（name/provider/id）；`/model PROVIDER/MODEL` 直接切换
- `/thinking`：打开 thinking selector；`/thinking LEVEL` 直接设置
- `/tools`：逐项切换 active tools；`/tools NAME…` 设置完整 active set，`/tools none` 清空
- `/tree`：打开 searchable tree selector并选择普通 navigate或 branch summary；也可用 `/tree ENTRY_ID [--summary [INSTRUCTIONS] | --replace INSTRUCTIONS]`
- `/fork [USER_ENTRY_ID]`：固定在 user message前 fork，并把 Pi 返回的 `selectedText` 放回当前客户端 editor
- `/clone`：使用当前 leaf执行公开 fork-at组合；fork/clone均创建新 Pi session generation
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

再次执行 `alu-dock` 会先投影 Pi SessionManager 当前 branch 的最新200项持久 history baseline，到达viewport顶部后按需反向取页；客户端最多保留目标1000项/1600万字符，超界时明确标记gap并固定最新200项，再重放 Host 近期 events并从同一Host的ephemeral `pendingMessages`恢复queue tray，然后继续观察live events。只有Pi公开user `message_start`到达时，queued消息才进入正式transcript；accepted/queued receipt不冒充consumed。Host loss/reopen仍不恢复queue。当前generation runner的exact registered extension command在Queue admission前立即执行，固定`queued:false`且不进入pending/恢复路径；unknown slash、skill和prompt template仍保留Pi原生语义。成功的no-model `command.handled`继续驱动activity和Protocol V2完成边界，但不作为通用system正文重复写入conversation；rejection、extension error/notification和命令专用结果仍可见。Composer固定在两行status dock上方并向上增长，history在其上方独立滚动；固定单行activity槽位位于history与pending/composer之间，以Host事件驱动的phase明确区分waiting/thinking/responding/tool/retry/compaction/queue/host-loss；仅活跃phase运行320ms轻量pulse，并用cursor save/restore与synchronized output局部重写该物理行，不触发pi-tui全屏render、不重写composer/边框/光标，idle不运行timer，也不改变viewport行数。低频TUI Footer 展示 cwd、Dock/Pi ID、model/configured thinking、state/queue、tokens/context/cache/cost、extension status 和 connection/lease；extension/skill/prompt commands 与路径进入 autocomplete。模型/thinking切换沿用Pi的session与settings语义，只允许实例idle时执行；当前运行不会被中途换模。Host在创建Pi SDK session前安装与Pi CLI相同的Undici `EnvHttpProxyAgent`：优先保留进程已有`HTTP_PROXY`/`HTTPS_PROXY`，缺失时采用Pi全局`httpProxy`设置。默认socket为`$XDG_RUNTIME_DIR/alu-dock/dock.sock`；managed日志使用`journalctl --user -u alu-dock.service`。

## 内部机器与诊断接口

Alu Dock没有Agent通过自身CLI自循环控制Host的设计。下列结构化JSONL命令来自V0/V0.1跨进程测试、release smoke和排障，不是模型tool surface，已从顶层human help移除。新测试优先直接使用typed `DockClient`/Protocol V2；默认`list`已不再提供机器JSON，仓库机器消费者已迁移。

当前开发候选仍提供：

```bash
alu-dock ping
alu-dock create --cwd "$PWD" --name demo
alu-dock reopen INSTANCE_ID
alu-dock events INSTANCE_ID --follow
# resume only with the complete cursor returned by the prior response:
alu-dock events INSTANCE_ID --cursor HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE --follow
alu-dock prompt INSTANCE_ID "start a new run"
alu-dock prompt INSTANCE_ID --delivery followUp "then summarize"
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
