# Alu Dock V0.1 阶段 0 验证记录

日期：2026-07-14

卡片：#142

基线：`b17bdf8 docs: record Alu Dock V0 success`

结论：**GO — reviewer 最终复核无 blocker；实现代码尚未开始。**

## 1. 本阶段交付

- [`v0.1-capability-matrix.md`](v0.1-capability-matrix.md)：MUST/SHOULD/WON'T、Pi API、settings、TUI 与当前七扩展兼容矩阵；
- [`control-protocol-v2.md`](control-protocol-v2.md)：V2 hello/capability、closed DTO、state/admission、catalog commit、interaction lease、ambiguous effect 与 migration；
- [`v0.1-plan.md`](v0.1-plan.md)：systemd user Host、catalog/reopen、分阶段实现与测试门禁；
- README/V0 历史计划入口说明。

Comment #228 已作为最新覆盖：V0.1 必须使用 `systemd --user` 常驻唯一 Host。普通 TUI 入口最终不再 fork detached child。

## 2. 本机环境证据

```text
Node: v22.21.0
Node path: /home/luziyi/.nvm/versions/node/v22.21.0/bin/node
systemd: 255
XDG_RUNTIME_DIR: /run/user/1000
Linger: yes
user state: active
```

关键发现：

- systemd user manager PATH 不包含 NVM 目录，因此 unit 必须生成绝对 Node/CLI `ExecStart`；
- `/run/user/1000` 与 `~/.local/state` 都是当前用户、mode `0700`；
- user manager 当前为 `degraded`，来源是无关的 desktop portal/snap unit；不能把全局 manager health 当 Dock gate；
- `Linger=yes`，本机 enabled user service 可跨 SSH logout；installer/status 只检测并提示，不自动改变其他机器 policy；
- user manager 已有 HTTP(S) proxy environment；Pi auth/model files仍由 `~/.pi/agent` 管理。

## 3. Pi 0.80.6 API 证据

通过包根 exports、declaration 和必要实现核验：

- `AgentSessionRuntime` / `createAgentSessionRuntime`；
- `SessionManager.open/list/listAll`；
- `runtime.newSession/switchSession/fork`；
- `session.navigateTree/compact/reload/setSessionName`；
- model/thinking/tools/resources/stats public APIs；
- `SettingsManager.flush/drainErrors` 与字段级锁合并；
- `ProjectTrustStore` / `hasTrustRequiringProjectResources`；
- `ExtensionUIContext` 基础方法；
- `pi-tui` Editor/Markdown/SelectList/autocomplete；
- `preflightResult` 存在于公开类型但标记 internal RPC hook，必须封装并在 SDK 升级时复核。

特别核对：Pi 0.80.6 `AgentSession.setModel()` 内部调用 `setDefaultModelAndProvider()`；`setThinkingLevel()`按 Pi 原生条件更新 default thinking。Dock 只需在 session setter 后 `flush()` / `drainErrors()`，不重复建设第二套 defaults。

## 4. 当前扩展盘点

| 扩展 | 阶段 0 来源事实 |
|---|---|
| alu-kanban | loose local extension |
| rm-confirm | loose local extension；存在 undefined selection 放行缺陷 |
| show-image | loose local extension；tool text 返回 path，details 含 base64/custom renderer |
| pi-web-access | npm 0.13.0 |
| pi-visionizer | package 0.1.0，git `6af3e8b51c07` |
| pi-subagents | npm 0.34.0 |
| pi-browser-cdp | local 0.2.0，git `c143ba90def1` |

处置：基础 `select/confirm/input/editor/notify/status` broker 覆盖主要路径；component widget/custom 不跨 socket。`rm-confirm` 在阶段 4 建立 versioned local package并通过 `pi install` 替换 loose source；不 patch npm/cache。

## 5. Reviewer 轮次

第一轮三路 review 发现并已修正：

- reopen generation 在 commit 后增加、candidate 失败未 dispose；
- replacement recovery metadata/previous session policy不足；
- Host event 与 instance event envelope冲突；
- V2 request/event/state/limit/commit/retry/trust/UI race不够 closed；
- settings/model/thinking实现表述复核；
- extension source adaptation缺少可复现路径。

第二轮 API review：**无 blocker**。第二轮协议 review 的剩余项已修正：

- normalized host_lost 示例清除 active command/pending，只在 `lastKnown` 保留事实；
- 定义 Dialog、Tree、Setting、InstanceEvent/EventDataMap 的 closed types与 bounds；
- catalog commit failure优先进入 mutation_faulted，不伪称已写 runtime_error；
- trust challenge定义为 operation ID 的未完成 pre-side-effect state，与 receipt dedup分离。

最终 reviewer 继续发现并关闭三处直接矛盾：normalized host_lost 不再带 current owner、replacement commit failure gate明确 mutation_faulted优先、tree分页增加绑定结构快照的 `treeRevision`。最终定向复核结论：**No blockers remain**。

## 6. 自动验证

执行：

```bash
npm run check
npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript：PASS；
- deterministic regression：34/34 PASS；
- npm audit：0 vulnerabilities；
- diff check：PASS；
- Markdown local links/fence/whitespace检查：PASS。

`npm audit` 是网络相关 release/security gate，不属于离线 deterministic contract。

## 7. 阻塞判定

已确认的工程风险都有冻结处理：

- runtime replacement非事务性 → durable replacement intent、previous-session recovery、candidate disposal、runtime_error/mutation_faulted区分；
- Host loss → hostEpoch + conservative durable facts + explicit reopen，永不自动执行；
- process-global proxy → Host-global/restart-required；
- project trust → before-hook/teardown前 challenge gate；
- rm-confirm fail-open → versioned source fix；
- systemd NVM PATH → generated absolute ExecStart；
- arbitrary extension components → unsupported/declarative fallback。

最终 gate 只在以下情况 STOP/ADJUST：公开 Pi API不能显式打开 session/rebind、主要扩展路径必须依赖 `ctx.ui.custom()`、无法保证 managed single writer、方案需要自动重放 side effect、或必须修改 Pi/旧 daemon/Rails/Redis/Alubot。当前均未发生。