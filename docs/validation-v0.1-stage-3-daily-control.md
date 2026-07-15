# V0.1 阶段 3：日常控制与核心 Session 验证

日期：2026-07-14

## 结论

阶段 3 已完成日常控制闭环并 advertised `session.commands.v1`。Host 继续是 Pi runtime、settings、tools、session replacement、extensions、operation ledger 与 mutation side effect 的唯一 owner；TUI 只消费 closed DTO/event。

本阶段按用户确认采用“完整切片一次实现、统一初步门禁、尽快 dogfood”的节奏。自动化用于守住协议、事务、信任、代际和 session 完整性；超长会话、真实模型/网络及长期 SSH UX 留给日常使用持续发现。

## 实现面

### Settings、model、thinking 与 tools

- `/settings` selector 和 `/settings KEY VALUE` 覆盖 24 项 closed setting projection。
- 22 项有 Pi 0.80.6 包根公开 setter 的设置可写；`compactionReserveTokens`、`compactionKeepRecentTokens` 因无公开 setter，以 `writable:false` 只读展示。
- 新增 `collapseChangelog`、`enableInstallTelemetry`；图片/theme/package path 等冻结非目标没有混入。
- 保存成功严格经过 Pi setter → `flush()` → `drainErrors()`；baseline/write failure保持 typed error和 mutation-applied事实。
- 当前项目 `.pi/settings.json` 的 `reserveTokens=165536`、`keepRecentTokens=20000` 未修改。
- `/model`、`/thinking`、`/tools` 均有 selector 和直接命令；可即时应用的 TUI setting同步更新当前客户端。

### 核心 Session

- V2 closed requests/results：`session.switch/new/name/compact/reload`。
- 所有 mutation进入 same-host operation ledger；重复 operation共享原 Promise/result，冲突复用拒绝，transport/timeout/无效 success response统一保留 operation-scoped `effect_unknown`。
- `/resume` 在读取目标 session cwd 后、任何 replacement effect前完成 project trust challenge；它仍是当前 Host 内切换，不是阶段 5 host-loss reopen。
- new/resume/reload复用 Pi `AgentSessionRuntime` replacement和 extension shutdown/start/rebind seam；成功后 generation增加且 `session.replaced` 为新 generation sequence 1。
- replacement重置旧 run/queue/name projection，重新读取 committed history/settings/command catalog，并用同 generation attach baseline去除 persisted history和live event重叠。
- `/name` 使用公开 `AgentSession.setSessionName()`；`/compact` 使用公开 `AgentSession.compact()`，运行中的手动压缩保留原 run operation ID并刷新 compaction history。
- `/reload` 返回 bounded resource metadata/diagnostics并发布 `resources.reloaded`；resource projection按 canonical sort后执行 JSON byte budget cap。
- `/resources` 提供只读 resource/diagnostic selector；`/install`、`/config`、`/login` 明确指向原 Pi CLI。

## 真实 Pi 0.80.6 门禁

`test/pi-stage3-real.test.ts` 使用临时 agent/session/project目录和包根公开 API，不发起模型网络调用：

1. 创建真实 persisted target session；
2. 通过 extension `session_before_compact` 返回确定性 summary；
3. 完成 `switch → name → compact → reload → new → name → switch`；
4. 验证 generation、sessionFile、name、history compaction summary和最终 idle状态；
5. 验证 extension lifecycle顺序精确为 startup/resume/reload/new/resume/quit，各 rebind一次；
6. 验证 settings flush后 `retry.enabled=false` 已落盘，既有 compaction字段未被覆盖；
7. 验证新 session遵循 Pi 原生惰性持久化：先预留 sessionFile，直到出现 assistant message才创建 JSONL。

真实门禁发现并修复了一个产品缺口：`compaction_end` 后 Managed history原先未立即刷新；现在 operation response前已完成 history refresh。

## PTY 与控制面门禁

真实 PTY Stage 3流程顺序执行：

- `/settings autoRetry false`
- `/tools read write`
- `/name PTY Stage 3`
- `/compact`
- `/reload`
- `/new`
- `/resume /tmp/pty-resume.jsonl`
- `Ctrl+D` detach

验证每项只触发一次 Host-owned mutation，generation按 reload/new/resume递增，最终 session name/cwd正确，runtime未被 TUI dispose。

控制面 regression同时覆盖：

- closed request/result和 capability gate；
- target cwd trust preflight零 replacement side effect；
- name/compact/new/switch/reload去重；
- runtime ambiguity不泄漏 cause且 Host保持可查询；
- manual compaction abort旧 run但不盗用其 operation ID；
- replacement清除旧 `lastRun`/extension projection；
- reload hook、commit和事件发布顺序。

## 门禁过程与最终结果

首次统一门禁为 **144/146 PASS**。两项失败均为测试假设偏差：

- reload fixture的假 `ResourceLoader` 缺少公开 projection方法；
- 测试误以为 Pi new session会立刻创建 JSONL，而 Pi实际在首个 assistant message前只预留路径。

按 Pi 0.80.6真实行为修正 fixture和断言后，最终结果：

```bash
npm test
npm audit --audit-level=high
git diff --check
```

- clean TypeScript build + tests：**146/146 PASS**。
- Stage 3真实 PTY：PASS。
- 真实 Pi temporary-session/settings/extension lifecycle smoke：PASS。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `git diff --check`：PASS。
- package-root Pi/TUI exports：PASS；Pi private subpath imports：0。
- SSH TUI `AgentSession/createAgentSession` imports：0。
- `.pi/settings.json` 冻结 compaction配置：保持不变。

## 下一阶段

阶段 4 前先执行阶段 3.5轻度结构重构：按职责拆分当前 TUI/core/control/Pi热点，并新增项目根 `AGENTS.md`，冻结模块依赖、任务拆分和分层测试规范；不改变本阶段协议语义，也不提前实现 extension UI、systemd/catalog/reopen或 tree/fork/clone。

进入日常 SSH 使用后的长会话 compaction、真实 provider/network、跨小时 terminal行为和 UX摩擦，应记录为 dogfooding证据并增加针对性 regression，而不是继续用大量模拟测试推迟可用入口。
