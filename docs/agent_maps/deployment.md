# Managed Host 与本地安装图谱

## 适用范围

`systemd --user`、managed Host startup/readiness、durable catalog process lifecycle，以及
普通 npm 本地安装。Alu Dock 没有 stage/apply、release channel、receipt 或自动回滚系统。

## 两条调用链

```text
Explicit service lifecycle
src/cli.ts service ...
  └── UserServiceManager
        ├── generated alu-dock.service
        ├── systemctl --user
        └── Protocol V2 hello + MainPID readiness
              └── installed cli.js serve --managed

Local install
npm run install:local
  ├── clean checkout + active-work admission
  ├── npm pack
  ├── npm install --prefix ~/.local/share/alu-dock
  ├── ~/.local/bin/aludock
  ├── generated unit install/restart
  └── hello/MainPID readiness
```

普通 `open`、`new`、`attach` 只连接既有 Host；不得导入 `UserServiceManager` 自动启动或
重启 service。

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

Corrupt catalog evidence 保留；失败时不得先构造 prior runtime。Startup normalization 把旧
live records 转为保守 unavailable 状态，不恢复 queue、Promise 或 effects。

## 文件 owner

| 文件 | 唯一职责 | 主要测试 |
|---|---|---|
| `src/deployment/local-install.ts` | 固定安装布局、generated unit、active-work admission | `local-install` |
| `scripts/install-local.ts` | npm pack/install、launcher、显式 service restart/readiness | `local-install` |
| `src/deployment/user-service.ts` | generated-unit lifecycle、readiness、logs | `user-service` |
| `src/cli.ts:serve()` | managed/dev mode composition 与 signal shutdown | `managed-mode`, process tests |
| `src/control/dock-host.ts` | bind-first startup、drain、socket ownership、fatal completion | `durable-host-process`, `dock-control` |
| `src/control/durable-catalog-store.ts` | strict schema-1 load、atomic replace、directory sync | `durable-catalog-store` |
| `src/control/catalog-reconcile.ts` | Host-loss normalization；无 Pi runtime 构造 | `durable-registry` |
| `src/control/catalog-transactions.ts` | serialized commit 与 mutation fault | `catalog-transactions` |
| `src/control/socket-path.ts` | XDG runtime/state 路径 | `ensure-host`, `user-service` |

## 生命周期边界

- SIGTERM：停止接收新 request，等待已 admit 工作，commit shutdown intent，dispose runtime，
  保留 reopen metadata。
- SIGKILL/Host loss：没有 cleanup 保证；下一 Host 只根据 durable catalog 与 Pi session metadata
  做保守 reconcile。
- Mutation-fault：Host 切 read-only、drain admitted work、退出非零；不继续接受 mutation。
- Socket path：private directory、socket mode `0600`、bind identity 校验；不得删除不属于当前
  Host 的 socket。
- Readiness：unit active 不等于 ready；必须同时满足 MainPID、Protocol V2 hello 与 managed
  capability set。确定性 protocol 错误立即失败；短暂连接错误与启动中的 `host_starting`
  会在 15 秒内重试。

## 本地安装规则

- 只有用户明确授权后才允许 `npm run install:local` 或 restart service。
- 安装必须从 managed Host 之外执行，并要求 clean committed checkout。
- active 但 idle/已结算的 instance 不阻塞；running、compaction、Queue、interaction 与 stopping 默认拒绝，并提示 `npm run install:local -- --replace-active`。该显式选项允许整体替换 Host，但不迁移或重放任何未决工作。
- Host replacement 后不自动重建旧 runtime；保留的 Pi session metadata 只允许用户显式 Continue/reopen。
- 安装包只包含 `dist/src`、README 与 npm 必需元数据；test、fixture、开发脚本不进入 tarball。
- 固定 prefix 为 `~/.local/share/alu-dock`；unit 指向其中安装的 CLI，不使用 timestamp release
  或 `current` symlink。
- 安装器不运行测试。测试由开发者按 `docs/qa.md` 显式执行。
- 安装器只替换 Alu Dock-owned launcher/unit；同名用户文件必须拒绝覆盖。
- service install/restart 后必须核对 MainPID 与 hello readiness。
- 旧 `~/release/alu-dock` 目录不自动迁移或删除，确认新安装后由用户手动清理。

## 测试层次

1. Pure unit：layout/unit render、catalog parser/reconcile。
2. Integration：atomic write fault、transaction boundary、readiness probes。
3. Subprocess：SIGTERM、SIGKILL、create race、corrupt evidence retention。
4. Real managed：必要时使用唯一临时 `systemd --user` unit。
5. Authorized local install：从外层 shell 安装并检查 service status。

## 默认不读

- TUI 实现；deployment 只验证 client-visible readiness。
- Pi internals；startup reconciliation 不得构造 Pi 对象。
- 旧 release/receipt 历史，除非用户明确要求清理或审计。
