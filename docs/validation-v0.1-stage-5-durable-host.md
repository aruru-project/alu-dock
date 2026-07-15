# V0.1 Stage 5 Durable Host 验证

日期：2026-07-15

卡片：#142

结论：**PASS（源码、真实 Pi reopen、真实 systemd/rollback、managed immutable rollout）**

## 范围

本阶段完成：

- schema-1 durable catalog、严格 closed parser、0700/0600 ownership/symlink/size门禁；
- same-directory temp write → file fsync → atomic rename → directory fsync；
- socket-first managed startup、catalog load/validate/reconcile-before-ready；
- prior-epoch live facts保守归一为`host_lost`，explicit stop intent归一为`stopped`；
- SIGTERM Host-shutdown intent/drain与SIGKILL no-replay语义；
- catalog-only list/get、explicit `instance.reopen`、Dock ID/createdAt保持、generation +1；
- 真实current-user non-symlink Pi session file、canonical cwd与project trust preflight；
- `catalog.v1`、`service.managed.v1`、`session.reopen` capability与closed client/parser；
- `service install/start/stop/restart/status/logs/uninstall`、MainPID/hello/epoch readiness、linger诊断；
- 普通open/new/attach移除detached Host fallback；managed/dev serve模式显式分离；
- TUI selector对`host_lost|runtime_error`只提供显式reopen，不自动构造runtime。

Stage 6 tree/fork/clone、V0.2 renderer和Web/image/artifact服务不在本阶段。

## 确定性门禁

最终源码门禁：

```text
npm run check -- --pretty false                         PASS
npm test                                                PASS (193/193)
npm audit --audit-level=high                            PASS (0 high vulnerabilities)
git diff --check                                        PASS
private Pi package subpath import guard                 PASS
package-root public export/load guard                   PASS
```

关键测试层：

- `durable-catalog-store.test.ts`：round-trip、closed schema/corrupt/future/symlink evidence、四个atomic write fault phase；
- `durable-registry.test.ts`：socket-first startup、catalog-only projection、single-candidate concurrent reopen、stale attach closure、candidate commit rollback、corrupt startup socket cleanup；
- `durable-host-process.test.ts`：SIGKILL/restart不replay queue、SIGTERM持久化host loss、admitted create/SIGTERM race；
- `managed-mode.test.ts`：managed marker/runtime/state、socket override、dev explicit socket fail-closed；
- `user-service.test.ts`：generated-unit ownership、完整lifecycle、MainPID/hello/new epoch、linger、uninstall保留catalog；
- 既有catalog transaction、replacement、extension UI、TUI、real Pi、PTY回归全部保持通过。

## 真实 Pi no-model reopen

`test/pi-reopen-real.test.ts`使用包根公开`SessionManager.open()`路径打开真实Pi JSONL fixture，并创建新的Host-owned runtime：

- Dock ID、creation operation、createdAt保持；
- runtime generation `1 → 2`；
- 首事件为`instance.reopened` sequence 1；
- session name/context可读取；
- lifecycle=`active`、execution=`idle`、lastRun=`never`；
- 无`run.started`；messages与tokens均为0。

因此该门禁不会调用模型，也不恢复旧prompt、queue、Promise或tool side effect。

## 真实 `systemd --user` 临时 unit

使用唯一unit `alu-dock-stage5-gate-2908569.service`，没有修改真实`alu-dock.service`。完整回执：`/tmp/alu-dock-stage5-systemd-receipt.json`；journal：`/tmp/alu-dock-stage5-systemd-journal.log`。

结果：

```json
{
  "result": "PASS",
  "epochs": [
    "79f20e38-be90-4dcb-8cac-f164b99c4aa3",
    "476aeb35-6b18-4756-8f6e-97a53433f210",
    "f99c119b-59e9-42ea-bdfb-d4d4f14843fd"
  ],
  "pids": [2908583, 2908677, 2908778],
  "generationAfterReopen": 2,
  "noModel": {"messages": 0, "tokens": 0},
  "permissions": {"state": "0700", "catalog": "0600"},
  "corruptEvidencePreserved": true,
  "socketRemovedOnCorruptStartup": true,
  "catalogPreservedAfterUnitRemoval": true
}
```

逐项验证：

1. start后V2 hello PID等于unit `MainPID`；
2. create一个no-model真实Pi instance并写入公开session-format fixture；
3. SIGTERM stop后socket消失、catalog保留且record变为reopenable `host_lost`；
4. restart得到新PID/hostEpoch，旧record generation 1、lastRun=`never`、pending=0；
5. explicit reopen得到generation 2，messages/tokens=0；
6. `systemctl restart`再次得到新PID/epoch，generation 2 record归一为`host_lost`，无执行replay；
7. corrupt catalog触发`Restart=on-failure`并由StartLimit停止，原`{not-json`字节不变、Host-owned socket被移除；
8. 删除临时unit后catalog仍存在，记录证据后才显式清理唯一临时state/runtime目录和fixture Pi session；
9. 真实`alu-dock.service`全过程保持active。

## 故障与语义结论

- Catalog commit仍是唯一可观察publication boundary；post-effect write failure单调进入`mutation_faulted`并返回operation-scoped `effect_unknown`。
- Durable catalog不是work queue或event log，不包含prompt/tool/dialog payload、token delta或Promise。
- Graceful Host shutdown不是`instance.stop`；前者保留可reopen context，后者提交`stopped/non-reopenable`。
- Restart只恢复catalog事实。只有用户显式reopen才构造runtime；reopen本身不submit文本。
- 普通client不会调用systemctl；service不可用返回`service_unavailable`与明确status/start/journal指引。
- Unit manager只覆写/删除带Alu Dock marker的regular user unit；uninstall不删catalog/session。

## Immutable rollout 与真实 service CLI

发布源码commit：`70b524dd0548b50234fa256bccb966901ba4faa2`。

发布前旧managed Host为PID `2852075`、epoch `c53e7690-7923-47f8-880c-c021a96f0a9b`，含2个idle/non-dogfood active records。用户明确说明当前研发使用独立Pi实例并授权本次一次性`--allow-active`切换；未触碰当前Pi会话。后续发布仍恢复默认active-instance拒绝策略。

### 故障回滚门禁

先使用不存在的smoke cwd故意让post-switch gate失败：

- failed release：`20260715T132308Z-70b524dd0548`；
- failed receipt：`/home/luziyi/release/alu-dock/receipts/20260715T132308Z-70b524dd0548.failed.json`；
- failure只来自预期的`Working directory does not exist`；该release此前check/tests 193/193/audit/npm-ci/hello均已通过；
- `current`精确回到`20260715T054328Z-90dd434d7981`；
- 旧unit SHA-256恢复为`3ee62e888471e513dc77fb42077a41eeecd083a3dd16a577bb4b17a47c20f7ae`；
- 旧launcher SHA-256恢复为`505020da5af7ef42257da4c57e7dc996bf1642c48e852338d21745907a0f15c7`；
- rollback Host PID `2914222`等于unit MainPID，epoch `eb899805-4287-4e5c-b941-2d5002a6c744`。

这验证了Stage 5 `serve --managed` unit合同改变后，rollback不仅切`current`，也原子恢复上一版generated unit/launcher；旧CLI不会被错误地以新flag启动。

### 成功发布

- release：`20260715T132357Z-70b524dd0548`；
- path：`/home/luziyi/release/alu-dock/releases/20260715T132357Z-70b524dd0548`；
- receipt：`/home/luziyi/release/alu-dock/receipts/20260715T132357Z-70b524dd0548.json`；
- deploy Host PID `2914969`、epoch `efdf636b-b9cb-4239-a91d-09f6409fc232`，均不同于rollback Host；
- published resource smoke：commands 40、resources 21、tools 18、settings 24、diagnostics 0；`chain/chain-prompts`和`run/run-chain`排序通过；
- no model/tool/extension command side effect；smoke instance最终`stopped/non-reopenable`。

随后使用**已发布launcher**验证service commands：

- `service status`：active/running、enabled、ready、linger=yes、PID/hello一致；
- `service install`：只重写同marker unit，不重启active Host；
- `service restart`：PID `2914969 → 2915068`，epoch变化；
- `service logs --lines 5`：journal path正常；
- `service stop`：inactive/dead、MainPID 0，同时catalog保留；
- `service start`：PID `2915133`、新epoch `e10b7b53-d856-4e71-915c-54949d0ca646`、ready；
- 回执：`/tmp/alu-dock-stage5-service-cli-receipt.json`。

最终Host `host.info`为ready、schema 1、revision 7、durable state path；unit ExecStart含`serve --managed`；state/catalog/socket mode分别为`0700/0600/0600`。最终无active instance，真实`alu-dock.service`保持active。#147与Stage 4 managed rollout随本release一并完成。

## Remaining risks / deferrals

- Cross-Host mutation不承诺exactly-once；response loss后先query，不自动retry。
- Catalog无自动retention；16 MiB/10000-record上限达到时应单独排期，而不是静默删除identity。
- Pi session JSONL可能由Pi/用户改变；每次reopen重新验证real path、owner、header cwd与project trust。
- Linger只诊断，不自动修改登录policy。
- Stage 6 tree/fork/clone和最终真人长会话验收仍待完成。
