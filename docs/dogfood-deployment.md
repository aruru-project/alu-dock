# Managed Dogfood 运维

## 原则

- 只发布clean committed HEAD。
- Release目录创建后不可原地修改；失败时整体回滚。
- `current`只通过原子symlink切换。
- 默认拒绝在active instance存在时restart。
- 未经用户明确授权，不deploy、不切换`current`、不restart service、不创建tag。
- 普通`open/new/attach`不调用systemd，也不fork detached Host。

## 布局

```text
$HOME/release/alu-dock/
├── releases/<release-id>/
├── current -> releases/<release-id>
├── receipts/
└── bin/alu-dock

$HOME/.local/bin/alu-dock
$HOME/.config/systemd/user/alu-dock.service
```

Managed Host使用：

- private runtime directory与`0600` Unix socket；
- private state directory与atomic durable catalog；
- user journal；
- `systemd --user` MainPID与Protocol V2 hello共同判定ready。

## 日常操作

```bash
alu-dock service status
alu-dock service logs --lines 200
alu-dock service logs --follow
alu-dock service start
alu-dock service stop
alu-dock service restart
```

安装或更新generated unit：

```bash
alu-dock service install --now
```

这些命令只管理带Alu Dock marker的generated unit。Uninstall不删除catalog或Pi session。

## 发布

```bash
npm run deploy:dogfood
```

发布器必须依次完成：

1. 验证clean committed HEAD；
2. 运行完整code gate；
3. 构建lockfile固定的immutable release；
4. 检查当前Host并默认拒绝active instance；
5. 原子切换`current`；
6. reload/start或restart user unit；
7. 验证MainPID、V2 hello和新hostEpoch；
8. 使用released DockClient读取commands/resources/tools/settings/tree；
9. 检查journal并写immutable receipt。

任一步失败都切回完整旧release并恢复generated files。不得混用不同release的`dist`和dependencies，也不得删除Pi session或catalog故障证据。

## Readiness与故障

- Unit active不等于应用ready。
- Ready要求hello PID等于unit MainPID并具备完整managed capability集合。
- Corrupt catalog保留原文件并阻止startup。
- Host shutdown保留可显式reopen的session metadata，但不恢复旧执行。
- SIGKILL后下一Host只做无runtime startup reconciliation。
- Mutation post-effect commit失败时Host进入read-only drain并非零退出。

开发checkout中的`npm run cli`、custom socket和direct runtime smoke都不能代替released-client验证。
