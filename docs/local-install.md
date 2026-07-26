# Alu Dock 本地安装与服务

Alu Dock 只使用一个本机 npm 安装和一个 `systemd --user` Host。

## 安装位置

```text
~/.local/share/alu-dock/node_modules/alu-dock/
~/.local/share/alu-dock/node_modules/.bin/aludock
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 从安装包自己的 `node_modules` 加载 Pi SDK，不调用 `$PATH` 中的全局 `pi`。更新安装包不会删除 catalog 或 Pi session 文件。

## 安装或更新

从 clean committed checkout 执行：

```bash
npm run install:local
aludock service status
```

不要在 Alu Dock managed Host 内运行安装命令；先离开 Work，再从普通 shell 或 standalone Pi 执行。

安装器会构建并打包当前 checkout，更新 `~/.local/share/alu-dock`、launcher 和 user service，然后等待新 Host ready。它不运行测试，也不自动回滚；失败时保留原始错误供排查。

有未完成的 prompt、compaction、Queue、interaction 或 stopping instance 时，安装会拒绝继续。只有明确接受中断这些工作时才使用：

```bash
npm run install:local -- --replace-active
```

这个选项只允许替换 Host，不会迁移或重放未完成的 run、Queue、interaction、Promise 或工具副作用。idle instance 不阻塞安装，其 session metadata 会保留，之后可以显式 Continue/reopen。

## 服务命令

```bash
aludock service install [--now]
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs [--lines N] [--follow]
aludock service uninstall
```

普通 `aludock`、`-c`、`new` 和 `attach` 只连接现有 Host，不会自动安装、启动或重启服务。`uninstall` 只删除 Alu Dock 生成的 unit，不删除 catalog 或 Pi sessions。

需要跨 logout 常驻时，由用户自行启用 linger：

```bash
loginctl enable-linger "$USER"
```

## 排查

```bash
command -v aludock
readlink -f ~/.local/bin/aludock
aludock service status
aludock service logs --lines 200
aludock list --all
```

launcher 最终应指向 `~/.local/share/alu-dock/node_modules/alu-dock/dist/src/cli.js`，service status 应报告 `ready: true`。
