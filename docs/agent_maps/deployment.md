# Managed Host 与 Athena Deployment 图谱

## 适用范围

`systemd --user`、managed Host startup/readiness、durable catalog process lifecycle、immutable Athena release、rollback与receipt。

## 两条调用链

```text
Explicit service lifecycle
src/cli.ts service ...
  └── UserServiceManager
        ├── generated alu-dock.service
        ├── systemctl --user
        └── Protocol V2 hello + MainPID readiness
              └── released cli.js serve --managed

Release lifecycle
scripts/deploy-athena.ts
  ├── stage: clean committed HEAD + complete gate + immutable pending release
  ├── apply: explicit outer-shell Host replacement using the pending release
  ├── one-step deploy: retained operator path
  ├── install generated launcher/unit
  ├── atomic current symlink switch
  ├── systemd restart/start
  ├── hello/MainPID + released-client smoke
  ├── immutable receipt
  └── complete rollback on failure
```

普通`open`、`new`、`attach`只连接既有Host；不得导入`UserServiceManager`自动启动或重启service。

## Managed Host startup

```text
cli serve --managed
  → validate ALU_DOCK_MANAGED + systemd directories
  → create FileCatalogStore + DockRegistry
  → DockHost.start()
      1. create and bind private socket
      2. verify socket ownership/mode/identity
      3. load strict catalog
      4. no-runtime startup reconcile
      5. atomic normalized catalog commit
      6. enter running and advertise hello
```

Corrupt catalog evidence保留；失败时不得先构造prior runtime。Startup normalization把旧live records转为保守unavailable状态，不恢复queue、Promise或effects。

## 文件owner

| 文件 | 唯一职责 | 主要测试 |
|---|---|---|
| `src/deployment/user-service.ts` | explicit generated-unit lifecycle、readiness、logs | `user-service` |
| `src/deployment/athena-release.ts` | release layout、unit/launcher rendering、release ID | `athena-release` |
| `scripts/deploy-athena.ts` | stage/apply与一次性immutable publish/switch/smoke/rollback transaction | `athena-release` + real deploy gate |
| `scripts/athena-smoke.ts` | released DockClient commands/resources/tools/settings/tree smoke；Stop 后 Forget 自身 record，不污染 History | release gate |
| `src/cli.ts:serve()` | managed/dev mode composition与signal shutdown | `managed-mode`, process tests |
| `src/control/dock-host.ts` | bind-first startup、drain、socket ownership、fatal completion | `durable-host-process`, `dock-control` |
| `src/control/durable-catalog-store.ts` | strict schema-1 load、atomic replace、directory sync | `durable-catalog-store` |
| `src/control/catalog-reconcile.ts` | Host-loss normalization；无Pi runtime构造 | `durable-registry` |
| `src/control/catalog-transactions.ts` | serialized commit与mutation fault | `catalog-transactions` |
| `src/control/socket-path.ts` | XDG runtime/state路径 | `ensure-host`, `user-service` |
| `test/fixtures/durable-host.ts` | SIGTERM/SIGKILL/create-race subprocess fixture | `durable-host-process` |

## 生命周期边界

- SIGTERM：停止接收新request，等待已admit工作，commit shutdown intent，dispose runtime，保留reopen metadata。
- SIGKILL/Host loss：没有cleanup保证；下一Host只根据durable catalog与Pi session metadata做保守reconcile。
- Mutation-fault：Host切read-only、drain admitted work、退出非零；不继续接受mutation。
- Socket path：private directory、socket mode `0600`、bind identity校验；不得删除不属于当前Host的socket。
- Readiness：unit active不等于ready；必须同时满足MainPID、Protocol V2 hello、managed capability set。仅`connection_error`、`connection_closed`与`timeout`属于startup瞬时probe失败并可重试；malformed response、protocol mismatch等确定性错误立即原样失败，不能等待15秒后误报为hello unavailable。

## 常见修改路由

| 需求 | 从这里开始 | 随后检查 |
|---|---|---|
| service install/start/restart/status | `user-service.ts` | generated unit、MainPID/epoch readiness、CLI service routing |
| managed startup顺序 | `cli.ts:serve`, `dock-host.ts` | catalog initialize、socket fault tests |
| catalog file schema/atomicity | `core/catalog.ts`, `durable-catalog-store.ts` | reconcile、transaction、fault injection |
| SIGTERM/SIGKILL行为 | `dock-host.ts`, `dock-registry.ts`, `managed-instance.ts` | durable subprocess fixture |
| release layout/unit | `athena-release.ts` | deploy script、unit test、generated marker safety |
| publish/rollback | `scripts/deploy-athena.ts` | released smoke、receipt、current symlink、service state |
| installed resource startup | `scripts/athena-smoke.ts` | actual released DockClient commands/resources/tools/settings/tree path |

## Release规则

- 只有用户明确授权后才允许apply/deploy、切换`current`、restart service或创建tag；stage不触碰运行Host。
- `npm run stage:athena`允许Host-owned agent准备pending release；apply必须在turn结束、Ctrl+D后由外层shell显式运行，并拒绝managed Host后代进程。Apply默认拒绝active instance；`--allow-active`是明确的破坏性Host replacement opt-in。
- 只发布clean committed HEAD；先完成code gate，再创建immutable release。
- Release位于`athenaReleaseLayout()`定义的immutable目录；禁止直接patch live release。
- 默认拒绝在active instance存在时restart；若unit/MainPID/socket仍有ownership证据但Host inspection失败，也必须fail-closed。
- 所有publish路径都必须先停止并验证旧unit inactive，再改写generated files或切换`current`；切换后验证systemd MainPID、V2 hello/hostEpoch、journal和released-client installed-resource smoke。
- 任一步失败都回滚完整release、generated files、launcher及service active/enabled状态；receipt记录code gate与deploy gate。
- `npm run cli`只用于开发；managed Athena的人类入口是installed `aludock`。

## 测试层次

1. Pure unit：layout/unit render、catalog parser/reconcile。
2. Integration：atomic write fault、transaction boundary、readiness probes。
3. Subprocess：SIGTERM、SIGKILL、create race、corrupt evidence retention。
4. Real managed：唯一临时`systemd --user` unit。
5. Authorized release：immutable publish、rollback-forward、journal与released-client smoke。

## 默认不读

- TUI实现；deployment只验证client-visible readiness与smoke。
- Pi internals；startup reconciliation不得构造Pi对象。
- Git历史与旧release receipts，除非用户明确要求审计既有发布。
