# V0.1 Stage 5 Durable Host 验证

日期：2026-07-15

卡片：#142

结论：**PASS（源码、真实 Pi reopen、真实临时 systemd user unit）**

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
- `durable-registry.test.ts`：socket-first startup、catalog-only projection、explicit reopen、candidate commit rollback、corrupt startup socket cleanup；
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

## 发布边界

源码PASS与managed rollout是两个事实。Stage 5实现必须先从clean committed HEAD创建immutable release，再核对真实`alu-dock.service` MainPID/hello/new epoch、真实本机resource smoke与rollback。发布结果追加到本文件和#142；发布器仍默认拒绝active instance，只有用户明确授权时才使用`--allow-active`。

## Remaining risks / deferrals

- Cross-Host mutation不承诺exactly-once；response loss后先query，不自动retry。
- Catalog无自动retention；16 MiB/10000-record上限达到时应单独排期，而不是静默删除identity。
- Pi session JSONL可能由Pi/用户改变；每次reopen重新验证real path、owner、header cwd与project trust。
- Linger只诊断，不自动修改登录policy。
- Stage 6 tree/fork/clone和最终真人长会话验收仍待完成。
