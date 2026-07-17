# V0.1 extension receipt 与 manual compaction 控制修复验证

日期：2026-07-17  
Cards：#178、#180  
状态：代码与 consolidated gate 已通过；managed rollout 等待与 user-level `sol-mid-turn-guard` 更新同步

## Scope

本切片修复两项真人 dogfood 故障：

1. running parent 下已成功执行的 exact registered extension command，被 typed client 的旧 cross-field invariant 误判为 `effect_unknown`；
2. manual compaction 超过普通 client timeout 后，abort/stop 被同一 configuration boundary 阻塞，且 compaction event 缺少 caller operation evidence。

不改变 Queue、parent run、catalog commit、generation、session-file 保留或 mutation no-retry 合同。

## Implemented contract

### Closed command receipt

- `CommandReceipt.kind` 是必填 closed discriminator：`"prompt" | "extension_command"`。
- 普通 Pi input 只发 `kind:"prompt"`，仍要求非 queued receipt operation 与 snapshot 中的 active operation 一致。
- Exact registered extension command 只发 `kind:"extension_command", delivery:"prompt", queued:false`。
- 只有该 extension receipt 可以在 running parent 下保留不同的 parent `activeCommandId`；其他 cross-field mismatch 继续 fail closed。
- Host 不替换 parent operation/activity，不写 pending Queue，不自动重试 mutation。

### Manual compaction control

- `compaction.started/completed` 可携带 caller `operationId`；manual compaction 的 start/end 均归属原 compact operation。
- Manual compaction admission 建立独立 start/configuration boundary。即使 stop/abort 到达时 Pi 尚未发布 `compaction_start`，也不会落回普通 configuration 等待路径。
- Abort 等待 compaction start-or-end boundary，再使用 RuntimeSession 的公开 abort 路径；Pi adapter 在 compacting 时调用公开 `abortCompaction()`。
- Stop 先完成 durable stopping-intent commit，再等待 start boundary、取消 runtime、等待 compaction configuration boundary，最后 dispose并提交 stopped；旧 generation/session-file 不被替换或删除。
- Typed client 普通请求默认仍为30秒；abort、compact、reload、stop使用独立10分钟 long-mutation timeout。显式 override 仅用于测试/机器调用，不引入 mutation retry。

## Evidence

### Deterministic regressions

- Protocol parser接受合法 running-parent extension receipt，并继续拒绝：
  - ordinary prompt operation mismatch；
  - extension receipt 的非 prompt delivery、queued=true或未知 kind。
- Typed `DockClient` 经真实 `DockHost` 接受 running-parent extension command；receipt、parent operation、pending与 handled event一致。
- Slow compact在25ms普通 timeout、250ms long timeout配置下等待75ms后成功，证明long-mutation timeout实际生效。
- Pre-start race fixture把 Pi `compaction_start` 延后：stop intent仍先进入catalog boundary；start发布后 compaction被取消，stop随后dispose。
- Abort bypass保持实例active/reusable，不伪造model run outcome。
- Stop regression验证 runtime generation 与 Pi session file保持不变，abort/dispose各一次，`stop_requested`先于`compaction.completed`。
- Real Pi Stage 3 no-model fixture完成manual compact，start/end event均携带`real-compact` operation ID，随后reload/new/resume与extension lifecycle继续通过。

### Consolidated gate

执行：

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

结果：

- TypeScript：PASS
- Tests：275/275 PASS
- Audit：0 vulnerabilities
- Diff check：PASS
- Production/test private Pi subpath imports：0
- `src/tui` AgentSession/createAgentSession imports：0
- repository `.pi/settings.json`：absent

日志：

- `/tmp/alu-dock-178-180-check.log`
- `/tmp/alu-dock-178-180-test.log`
- `/tmp/alu-dock-178-180-audit.log`
- `/tmp/alu-dock-178-180-build.log`

### Independent review

- #178 reviewer：PASS，无 finding。
- #180 初审发现 compact admission 与 `compaction_start` 投影之间的 preemption race。
- 增加 compaction start boundary与确定性 pre-start fixture后复审：PASS，无 blocker/high finding。

## Deviations and remaining risks

- 未增加通用 configuration job DTO或 durable progress system。对本次已观察的 manual compaction，closed query由 instance snapshot加带 operation ID 的 compaction events组成。
- `reload` 使用long-mutation timeout，但 Pi 0.80.6没有公开的 reload cancellation hook；本切片不在 reload 中途 dispose runtime，也不引入 Worker/子进程。真人事故中的 active long operation是 reload之后启动的manual compact，已覆盖其恢复路径。
- 进程级 hard hang仍只能由 managed service lifecycle处理；mutation completion未知时仍只查询，不重发。
- Managed rollout与安装态smoke尚未计入本文件；将与用户级 `sol-mid-turn-guard` 更新同步执行并在发布后补充 immutable release、rollback-forward、MainPID/hello/resources/journal evidence。

## Deferrals

- 通用 per-runtime Worker/子进程隔离继续留在V0.1之后的架构roadmap。
- 广义可取消 reload/job control需要Pi公开hook或未来process boundary，不在本次最小事故修复中伪装实现。
