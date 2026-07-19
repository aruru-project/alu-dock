# Managed Athena 运维

## 原则

- 只发布clean committed HEAD。
- Agent可在现有Host运行时stage新版；stage只构建release与pending receipt，不切换、不重启。
- Apply必须由当前turn结束并Ctrl+D后，从外层shell显式执行；不得从Host-owned tool中自杀式调用。
- Release目录创建后不可原地修改；失败时整体回滚。
- `current`只通过原子symlink切换。
- 默认拒绝在active instance存在时restart；若active unit、MainPID或socket证据仍在但Host inspection不可用，同样fail-closed。
- 未经用户明确授权，不deploy、不切换`current`、不restart service、不创建tag。
- 普通`open/new/attach`不调用systemd，也不fork detached Host。

## 布局

```text
$HOME/release/alu-dock/
├── releases/<release-id>/
├── current -> releases/<release-id>
├── receipts/
└── bin/aludock

$HOME/.local/bin/aludock
$HOME/.config/systemd/user/alu-dock.service
```

Athena是当前发布通道名，operator CLI固定为`aludock`。为无损升级既有catalog、socket与user unit，内部release root、systemd unit、RuntimeDirectory和StateDirectory继续沿用`alu-dock`标识；它们不是可执行命令名。

Managed Host使用：

- private runtime directory与`0600` Unix socket；
- private state directory与atomic durable catalog；
- user journal；
- `systemd --user` MainPID与Protocol V2 hello共同判定ready。

## 日常操作

```bash
aludock service status
aludock service logs --lines 200
aludock service logs --follow
aludock service start
aludock service stop
aludock service restart
```

安装或更新generated unit：

```bash
aludock service install --now
```

这些命令只管理带Alu Dock marker的generated unit。Uninstall不删除catalog或Pi session。

## 发布

常规一次性发布：

```bash
npm run deploy:athena
```

Athena自更新使用两阶段流程：

```bash
# 可由Alu Dock中的agent执行；不会影响当前Host
npm run stage:athena

# 当前turn结束后Ctrl+D，在外层shell执行stage输出的固定applyCommand
aludock service update apply [RELEASE_ID] [--allow-active]
```

Apply默认拒绝任何active instance；应先显式stop。只有确认中断所有Host-owned runtime且接受queue、interaction、Promise和tool effect不迁移时，才可加`--allow-active`。

从旧`alu-dock` launcher迁移到首个Athena release时，`aludock`尚未安装；该次必须原样运行stage receipt中的绝对Node `applyCommand`。Apply成功会安装`$HOME/.local/bin/aludock`，并仅在确认generated ownership后移除旧launcher与symlink；同名用户自有文件绝不删除。失败rollback会恢复旧launcher。之后的Athena更新才使用上面的`aludock service update apply`。

Stage完成完整code gate与immutable release build，只更新`pending.json`和stage receipt。Apply是显式Host replacement授权：停止旧Host、原子切换`current`、启动新版并执行readiness/smoke；active runtime、queue、interaction、Promise或tool effect不会迁移或重放。Apply检测到自身运行在managed Host的子进程中时必须拒绝，避免tool call杀死其owner。

一次性发布器必须依次完成：

1. 验证clean committed HEAD；
2. 运行完整code gate；
3. 构建lockfile固定的immutable release；
4. 检查当前Host并默认拒绝active instance；
5. 在改写generated files或`current`前停止并验证旧unit已inactive；
6. 原子切换`current`；
7. reload/start user unit；
8. 验证MainPID、V2 hello和新hostEpoch；
9. 使用released DockClient读取commands/resources/tools/settings/tree；
10. 检查journal并写immutable receipt。

任一步失败都切回完整旧release，并恢复generated files、launcher、service active/inactive与enabled/disabled状态。不得混用不同release的`dist`和dependencies，也不得删除Pi session或catalog故障证据。

## Readiness与故障

- Unit active不等于应用ready。
- Ready要求hello PID等于unit MainPID并具备完整managed capability集合。
- Corrupt catalog保留原文件并阻止startup。
- Host shutdown保留可显式reopen的session metadata，但不恢复旧执行。
- SIGKILL后下一Host只做无runtime startup reconciliation。
- Mutation post-effect commit失败时Host进入read-only drain并非零退出。

开发checkout中的`npm run cli`、custom socket和direct runtime smoke都不能代替released-client验证。
