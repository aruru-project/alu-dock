# Alu Dock V0.1 阶段 1D Catalog Transactions 验证记录

日期：2026-07-14

卡片：#142

状态：**PASS（阶段 1 Runtime/协议底座完成）**

## 1. 本次范围

本次完成阶段 1 最后一段 registry-owned catalog transaction/fault seam：

- 新增 closed `CatalogInstanceRecord`、共享 lifecycle/execution invariant 和 injected `CatalogCommitPort`；
- `CatalogTransactionCoordinator` 以单一全局队列提交完整、冻结、revisioned projection；
- 默认 port 只代表当前 Host 的 live in-memory registry；阶段 5 才实现 fsync/rename 的 durable `catalog.v1` store；
- `ManagedInstance` 分离 working state 与 last committed snapshot，catalog commit成功前不发布对应 state/event/response；
- create candidate 仅在 commit 后进入 registry；commit失败时 candidate runtime exactly-once dispose且不发布；
- prompt/steer/follow-up先提交 admission intent再调用 Pi；accepted、queue、started、settled与 no-run结果均在对应 commit 后投影；
- model/thinking/tools/settings mutation在 Pi side effect和原生 settings persistence之后提交 catalog，成功 response/event在 commit 后返回；
- replacement先提交 previous-session intent；成功 generation、cancel、runtime_error/recovery session均经 transaction；
- explicit stop先提交 stop intent，随后 clear queue/abort/dispose，最终 stopped commit后才返回；普通 Host shutdown只做 non-catalog runtime drain，不伪造 instance stop；
- 第一个 post-effect commit失败单调进入 `mutation_faulted`，新 mutation fail closed，read-only查询仅在有界 drain窗口开放；
- fault前已经 admitted 的 mutation先在同一 deadline内收敛到自己的 commit boundary，并以各自 operation ID返回 `effect_unknown`；随后 exactly-once best-effort cleanup；
- deadline后 Host不会再次无界等待同一批 hung dispatch；fatal completion为非零，CLI覆盖 fault-first与 signal/fault race；
- pre-effect/rollback-contained失败返回 generic `catalog_write_failed`，commit-port cause只保留在内存 error cause，不进入 wire。

## 2. Transaction 与故障门禁

Deterministic tests覆盖：

- 全局 commit serialization、完整 immutable candidate、revision只有成功 commit才增加；
- pre-effect failure保持 writable；post-effect port或 invariant failure单调 fault且不发布 invalid candidate；
- 多个已完成 side effect的排队 mutation保留各自 `effect_unknown.operationId`；
- create commit gate、unpublished candidate disposal、token/base64 commit error不泄漏；
- prompt admission在 Pi调用前；accepted/started事件顺序与 receipt barrier；
- preflight failure调用 Pi零次且 Host继续 writable；
- queue与settled commit failure保留上一个 conservative running/pending snapshot；
- model、thinking、tools、settings success/read/event均等待 commit；read-first与mutation-first竞态由单一 projection/configuration reservation线性化；
- settings `mutationApplied=true` 后 catalog failure不错误发布 `settings.changed/settings.write_failed`；
- replacement target commit失败保留旧 committed generation；runtime teardown failure提交 `runtime_error + recoverySessionFile`；该 error-state commit失败保留 replacement intent；
- stop intent前不cleanup，stopped commit前不响应；pre/post failure分别为 rollback与 ambiguity；clear/abort/dispose在 stop/fault竞态下各执行一次；
- fault drain允许另一个已进入 Pi的 mutation完成到 operation-scoped ambiguity后才dispose；
- hung create与 hung disposal计入非零 deadline，`drainTimedOut=true`，Host stop不再次等待并完成 inode-safe socket removal；
- fault窗口 `host.info.state=mutation_faulted|draining`、reads可用、新 mutation返回 `mutation_faulted`；
- normal Host shutdown不写 explicit stopped catalog事实。

## 3. 协议与安全

- `host.info` parser只接受 `ready|mutation_faulted|draining`；
- wire errors新增稳定 `catalog_write_failed` / `mutation_faulted`，post-effect failure沿用 closed `effect_unknown {operationId,queryHint}`；
- commit-port arbitrary message、token、data URI/base64不进入 client错误；
- committed snapshot继续使用四维 event cursor，失败 commit不推进可观察 state/event；
- same-Host operation ledger仍是唯一 request dedup层，不声称跨 Host exactly-once；
- 所有 catalog/transaction类型从 package root导出，未引入 Pi private subpath。

## 4. 自动验证

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
rg 'from "@earendil-works/pi-(coding-agent|tui)/' src test scripts
node --input-type=module -e 'import("./dist/src/index.js")'
```

结果：

- TypeScript：PASS；
- clean deterministic suite：105/105 PASS；
- npm audit：0 vulnerabilities；
- diff check：PASS；
- Pi SDK/TUI private-subpath import：0；
- package-root import：PASS；
- `.pi/settings.json`：无修改；
- V0历史 `docs/plan.md` / `docs/validation-stage-*.md`：无修改。

真实 Pi 0.80.6 smoke使用临时 cwd/agentDir/sessionDir和 package-root API创建 registry-owned runtime：投影 tools=7（active=4）与 settings=20，执行 active-tool exact-set、原生 `enableSkillCommands=false` persistence和 explicit stop transaction；最终 catalog revision=6、lifecycle=stopped。结果 PASS，未调用模型或外部网络。

## 5. Reviewer

两名独立 reviewers首轮发现：

- fatal drain没有纳入已 admitted/hung dispatch，且 Host stop可能在 timeout后再次无界等待；
- 并发已进入 Pi的 mutation可能被过早dispose并丢失自己的 ambiguity operation ID；
- pre-effect catalog error可能泄漏 commit-port secret，并错误描述 rollback-contained create；
- tool/thinking/settings、mutation-applied settings failure及 runtime-error commit failure测试不足；
- read与configuration分别读取两个 Promise会让 read-first竞态观察到未 commit runtime state。

实现已按上述问题调整，改为单一 projection/configuration reservation，并补齐 deterministic tests。最终复核：**CLEAN（无 blocker/important finding）**。

## 6. 阶段边界

阶段 1 至此完成。仍未提前实现：

- 阶段 2 SSH TUI；
- 阶段 3 session command wire与日常控制；
- 阶段 4 Extension UI broker；
- 阶段 5 durable atomic catalog、systemd lifecycle、startup reconcile与 explicit reopen；
- 阶段 6 tree/fork/clone。

因此 `instance.catalog` 仍只表示当前 Host live registry；本次 transaction seam固定未来 durable port必须遵守的 commit/response/fault合同，但不宣称已有磁盘 durability。
