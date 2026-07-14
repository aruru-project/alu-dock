# Alu Dock V0.1 阶段 1A 验证记录

日期：2026-07-14

卡片：#142

状态：**PASS（阶段 1 partial landing；阶段 1 checklist 保持未完成）**

## 1. 本次范围

本次把 V0 控制面切换为 V2-only foundation，并只 advertised 已实现、已验证的 capability：

- `core.v2`
- `host.info`
- `instance.catalog`（当前 Host 的 live/in-memory registry，不等于 durable `catalog.v1`）
- `events.follow`
- `models.v1`
- `session.core`

已实现：

- 每连接 hello/hello_ack/hello_error，版本和 required capability 在业务副作用前失败；
- closed request/response/result/event DTO 与 wire bounds；
- Host epoch、runtime generation、完整 event cursor 与 resync；
- response-before-live-event、1,000-event/1 MiB 双重 replay bound；
- client operation ID、same-Host bounded ledger、duplicate Promise/result/error、conflicting reuse；
- mutation transport ambiguity `effect_unknown`，不自动 retry；
- model/thinking setter 后 `SettingsManager.flush()` / `drainErrors()`；
- pre-existing settings errors 在 side effect 前隔离，post-mutation write failure 保持内存状态诚实；
- `session.list` 的 cwd/all 与 default/custom session directory branches；
- binary/base64/data URI/Buffer/function/symbol bounded omission 与 tool `omittedFields`；
- TUI/CLI 对 V2 cursor 和 typed event 的兼容调整。

## 2. 明确未完成

本次不是阶段 1 完成声明，以下仍未实现或 advertised：

- `AgentSessionRuntime` replacement-safe owner/rebind；
- project trust challenge/preflight；
- tools/resources/general settings request surface；
- catalog transaction port 与 durable fsync store；
- session new/switch/reload 等 replacement commands；
- systemd、host-loss reconcile、explicit reopen、Extension UI lease。

普通入口仍沿用过渡期 detached Host 行为；`systemd --user` 唯一常驻 Host 在后续阶段交付。

## 3. 关键故障门禁

- rejected hello 与 pipelined mutation 同包到达时，连接先 terminalize，factory 调用计数保持 0；
- V1 Host 不 fallback，客户端返回 protocol incompatible；
- 裸 sequence 不再被盖上当前 epoch/generation；CLI 使用完整 `--cursor HOST_EPOCH:RUNTIME_GENERATION:SEQUENCE`；
- exact duplicate operation 不重复 create/prompt/model/thinking/stop；ID 与不同 params/type 冲突时拒绝；
- mutation request 发出后的 close/error/timeout 返回 `effect_unknown + operationId`；
- stopped snapshot 为 `execution=unavailable`、pending 0、无 owner/active command；
- raw base64 与 data URI 不进入 tool/message event，普通短文本保留；
- settings baseline error 不触发 model/thinking side effect；写后失败时 snapshot反映已改变的内存状态。

## 4. 自动验证

```bash
npm run check
timeout 120s npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript：PASS；
- deterministic suite：52/52 PASS；
- npm audit：0 vulnerabilities；
- diff check：PASS；
- package-root Pi imports检查：PASS；
- V0 历史 `docs/plan.md` / `docs/validation-stage-*.md`：无修改。

## 5. Reviewer 结论

第一轮 review 阻止了过早提交，并据此修复：

- failed hello 后仍可能处理同 chunk mutation；
- naked sequence 破坏四维 cursor；
- operation ID 缺少 dedup；
- open result/event DTO；
- incomplete binary omission；
- `session.core` / `models.v1` result与 durability boundary不完整；
- thinking delta混入普通答案。

第二轮关闭 completed-message raw base64、旧 SettingsManager error误归因及 Pi adapter branch测试缺口。最终定向复核：**no blockers / no important findings；当前 partial Stage 1 diff 可提交**。

## 6. 下一入口

阶段 1B：采用官方 `AgentSessionRuntime`，实现 replacement-safe rebind、project trust gate、tools/resources/general settings projections 和可注入 catalog transaction boundary。未通过该门禁前，#142 阶段 1 checklist 不标记完成。