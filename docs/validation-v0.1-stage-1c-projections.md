# Alu Dock V0.1 阶段 1C Projections 验证记录

日期：2026-07-14

卡片：#142

状态：**PASS（阶段 1 partial landing；阶段 1 checklist 保持未完成）**

## 1. 本次范围

本次完成 Host-owned tools/settings/resources closed projection，并在实现和测试完成后 advertised：

- `tools.v1`
- `settings.v1`
- `resources.v1`

控制面新增：

- `tool.list`、`tool.set_active`；
- `settings.get`、`settings.update`；
- `resource.get`、`command.catalog`。

实现要点：

- `RuntimeSession` 强制提供对应六个 runtime surface，Host 不会 advertised 一个可选但缺失的 backend 能力；
- tool 只投影 name/description/active/source/JSON parameter schema，不发送 execute、prompt guidelines、Buffer、function、data URI 或 raw base64；
- active tool mutation校验 exact visible set、unknown/duplicate，并沿用 same-Host operation ledger；
- 20-key general settings allowlist由一个 exhaustive、deep-frozen metadata table驱动协议与 adapter；
- setting mutation保持 baseline `drainErrors()` → Pi setter → `flush()` → `drainErrors()`；steering/follow-up使用 `AgentSession` setter，立即更新 live queue mode；
- write 后失败保留已改变的 live state，先投影 `settings.changed`，再发布 `settings.write_failed`；
- malformed global/project effective settings不生成非法 success DTO，稳定返回 sanitized `settings_invalid`；
- `defaultProjectTrust` source按 Pi 仅读取 global setting 的原生语义投影；
- command catalog包含 extension、prompt和启用的 `skill:*`，extension duplicate invocation name复现 Pi 0.80.6公开运行语义；
- resources、diagnostics、tools、commands均先 canonical sort再应用 2,000-item cap，输入排列不改变边界成员；
- extension/skill/prompt/context body、handler、stack与binary不进入 wire。

## 2. 关键门禁

Deterministic tests覆盖：

- closed request/result/event shape、unknown field、bounds、setting discriminated union与冻结 metadata；
- exact 20-key settings顺序、类型、enum、integer range和 closed warnings object；
- Pi public getters/setters与所有 20 个 update branch；
- malformed boolean/enum/integer/warnings及 trusted project override fail closed；
- global/project/effective source与 `defaultProjectTrust` 特例；
- baseline/write persistence attribution、live queue mode和 post-mutation failure事件诚实性；
- native SettingsManager modified-field merge、same-field LWW与 stale snapshot reload；
- tool unknown/duplicate/exact-active set、operation dedup与binary/function omission；
- extension duplicate command naming、prompt/skill inclusion、skill disable、body/handler omission；
- 2,001-item forward/reverse tools/resources/diagnostics/commands得到同一 canonical cap；
- client校验 active set、setting key、command prefix和 instance/Host binding；
- advertised capability negotiation与 malformed setting的 stable control error。

## 3. 真实 Pi 0.80.6 smoke

使用临时 cwd、agentDir 与 sessionDir，并只使用 `@earendil-works/pi-coding-agent` 包根 API：

1. 创建并 bind Host-owned `AgentSessionRuntime`；
2. 投影 7 个 built-in tools与 exact 20 settings；
3. exact-set重设 active tools；
4. 通过 live `AgentSession.setSteeringMode()` 更新并 flush setting；
5. 加载两个注册同名 command 的真实临时 extensions、一个 prompt和一个 skill；
6. command catalog得到 `duplicate:1`、`duplicate:2`、`prompt-a`、`skill:skill-a`；
7. resource body未进入 catalog；
8. dispose runtime。

结果：PASS；未调用模型或外部网络。

## 4. 自动验证

```bash
npm run check
timeout 180s npm test
npm audit --audit-level=high
git diff --check
rg 'from "@earendil-works/pi-(coding-agent|tui)/' src test scripts
```

结果：

- TypeScript：PASS；
- clean deterministic suite：82/82 PASS；
- npm audit：0 vulnerabilities；
- diff check：PASS；
- Pi SDK/TUI private-subpath import：0；
- `.pi/settings.json`：无修改；
- V0 历史 `docs/plan.md` / `docs/validation-stage-*.md`：无修改。

## 5. Reviewer

两名独立 reviewers首轮发现并已关闭：

- malformed Pi setting getter可能产生 client拒绝的 success DTO；
- capability advertised但 runtime method仍是 optional；
- steering/follow-up绕过 live `AgentSession` setter；
- `defaultProjectTrust`误报 project source；
- command catalog遗漏 prompt/skill且 duplicate raw name不可调用；
- cap在 canonical sort前执行，边界成员依赖 loader输入顺序。

修复后分别复核：

- protocol/control reviewer：**CLEAN**；
- Pi adapter reviewer：**CLEAN — no blocker or important findings**。

## 6. 明确未完成

阶段 1 尚未完成。下一 slice仍需：

- registry-owned catalog transaction/commit port；
- success response/event-after-commit；
- catalog mutation fault后的 `mutation_faulted` / read-only drain；
- deterministic commit/fault injection tests。

Durable fsync catalog、`catalog.v1`、systemd与 explicit reopen仍属于阶段 5；Stage 3 session command wire exposure也未提前实现。因此 #142 阶段 1 checklist本次不勾选。
