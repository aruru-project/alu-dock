# Alu Dock V0.1 阶段 1B Runtime/Trust 验证记录

日期：2026-07-14

卡片：#142

状态：**PASS（阶段 1 partial landing；阶段 1 checklist 保持未完成）**

## 1. 本次范围

本次完成阶段 1B 的 Runtime ownership 与 create project-trust slice：

- 删除固定 `createAgentSession()` / `PiRuntimeSession` 路径；
- 只通过包根公开 API 使用 `createAgentSessionRuntime()`、`createAgentSessionServices()` 与 `createAgentSessionFromServices()`；
- 新增 Host-owned `PiRuntimeHost`，唯一持有可替换 `AgentSessionRuntime`；
- initial/replacement listener 在 extension bind 前连接，candidate event 在 target commit 前缓冲；
- SDK `beforeSessionInvalidate` 同步撤销旧 binding，旧 callback 不能进入新 generation；
- new/switch/reload internal seam、mutable runtime generation、cross-cwd projection 与 replacement failure-closed；
- async runtime dispose 由 Host owner 执行且 exactly-once；dispose rejection 仍在 `finally` 撤销 binding；
- create trust gate 在 instance ID、runtime、network、extension bind 与 registry publish 前完成；
- canonical `realpath`、Host epoch coordinator、operation type/ID/target/name/TTL binding；
- `trust_once`、`trust_and_remember`、`deny_once`、`deny_and_remember`；deny 继续创建 untrusted runtime；
- consumed/expired challenge 转为 Host-epoch lifetime tombstone，不再返回 authorization 或改绑；有界容量耗尽时 fail closed；
- machine CLI 输出 structured challenge/operation ID 并支持显式 retry flags；human open/new 提供四项明确选择；
- build 先清理 `dist`，避免删除测试后继续执行 stale JavaScript。

## 2. 故障门禁

Deterministic tests 覆盖：

- trust challenge/duplicate 在 factory 和 registry side effect 前返回；
- challenge target/name/type 变化、过期、consume replay 与容量压力均 fail closed；
- exact successful retry 由 operation ledger 返回同一 receipt，factory 只调用一次；
- initial subscribe → extension bind，startup events 在 ManagedInstance attach 后发布；
- cancellation和 pre-invalidation hook failure不 teardown旧 runtime、不增加 generation；
- successful new/switch/reload只增加一次 generation，`session.replaced` 是新 generation sequence 1；
- old-generation cursor replay 当前 generation，而不是用旧 sequence 过滤；
- factory failure不重复 dispose旧 session；bind/target-commit/reload failure dispose visible candidate exactly once；
- rejecting runtime disposal仍撤销 listener；
- switch 后 cwd、Pi session ID/file 与 model/thinking projection来自新 binding；
- model/thinking仍保持 baseline drain → setter → flush → drain；
- default/custom session directory listing branches保持正确。

## 3. 实机公开 SDK smoke

使用临时 cwd、agentDir 与 sessionDir，通过真实 Pi 0.80.6 包根 API：

1. 创建 untrusted `AgentSessionRuntime`；
2. bind extensions；
3. 得到 active generation-1 Dock snapshot 与真实 Pi session ID/file；
4. explicit stop；
5. 等待 runtime shutdown/dispose，得到 stopped/unavailable snapshot。

结果：PASS；未调用模型或外部网络。

## 4. 自动验证

```bash
npm run check
timeout 120s npm test
npm audit --audit-level=high
git diff --check
rg 'from "@earendil-works/pi-coding-agent/' src test scripts
```

结果：

- TypeScript：PASS；
- deterministic suite：71/71 PASS；
- npm audit：0 vulnerabilities；
- diff check：PASS；
- Pi SDK private-subpath import：0；
- fixed `createAgentSession()` source call：0；
- V0 历史 `docs/plan.md` / `docs/validation-stage-*.md`：无修改。

## 5. Reviewer

独立 runtime 与 trust reviewers 首轮发现并已关闭：

- stale generation cursor 会按旧 sequence 丢失 replacement events；
- async dispose rejection 跳过 binding cleanup；
- pre-invalidation hook failure被错误归一为 runtime loss；
- candidate/failed runtime可能 double-dispose；
- consumed challenge仍返回 authorization；
- expired/pruned challenge允许 operation ID 改绑；
- operation type未进入 trust binding；
- tombstone eviction会在容量压力后恢复改绑能力；
- pending challenge在目标变为 no-trust path时可能绕过 operation binding。

最终修复采用 bounded/non-evicting Host-epoch trust bindings，容量耗尽拒绝新 challenge，并在任何 no-trust early return前检查 pending binding；Runtime failure path均有 deterministic regression。

## 6. 明确未完成

阶段 1 尚未完成，以下继续留在下一 slice：

- `tools.v1`、`settings.v1`、`resources.v1` closed projections；
- registry-owned catalog transaction/commit port；
- response/event-after-commit 与 mutation-faulted/read-only drain；
- Stage 3 session command wire exposure；
- Stage 5 durable catalog、systemd 与 explicit reopen。

因此本次不新增 tools/settings/resources/session-command capability，#142 阶段 1 checklist不勾选。