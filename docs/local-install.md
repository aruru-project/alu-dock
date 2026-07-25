# Alu Dock 本地安装与服务

Alu Dock 是本机单用户工具。生产形态只有一个普通 npm 本地安装和一个
`systemd --user` Host，没有 stage/apply、release channel、receipt 或自动回滚流程。

## 路径

```text
~/.local/share/alu-dock/
└── node_modules/
    ├── .bin/aludock
    └── alu-dock/
        ├── package.json
        ├── README.md
        └── dist/src/

~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Pi SDK 从安装包自己的 `node_modules` 加载，不调用 `$PATH` 中的全局 `pi`。Catalog、
RuntimeDirectory、StateDirectory 与 socket 继续使用既有 `alu-dock` 标识和路径，更新包
不会删除 catalog 或 Pi session 文件。

## 安装或更新

从 clean committed checkout、在 Alu Dock managed Host 之外执行：

```bash
npm run install:local
```

命令只做以下工作：

1. 确认 checkout clean；
2. 连接现有 Host；idle/已结算的 instance 不阻塞，running、compaction、Queue、interaction 与 stopping 状态默认拒绝；
3. build 并 `npm pack`；
4. 将 tarball 安装到 `~/.local/share/alu-dock`；
5. 更新 `~/.local/bin/aludock` 和 Alu Dock-owned user unit；
6. restart/start service，并等待 MainPID 与 Protocol V2 hello readiness。

若明确接受中断所有正在工作的 Host-owned runtime，可使用：

```bash
npm run install:local -- --replace-active
```

普通安装被 active work 阻塞时会原样列出实例并提示这条命令。`--replace-active` 只放宽
Host replacement admission；它不会迁移或重放 run、Queue、interaction、Promise 或 tool
side effect。idle instance 虽不阻塞安装，也不会在新 Host 中自动构造 runtime；其 Pi session
metadata 保留为可显式 Continue/reopen 的记录。

安装器不运行测试，也不自动回滚。失败信息直接保留给 operator 处理。若当前 unit 来自旧
Athena/dogfood 安装器，第一次本地安装只识别其 generated marker 以安全改写 unit 和
launcher；旧 `~/release/alu-dock` 目录不会自动删除，确认新安装正常后可手动清理。

从 managed Host 内调用会立即拒绝。先 Ctrl+D 离开 Work，再从外层 shell 或 standalone
Pi 执行安装。

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

普通 `aludock`、`-c`、`new`、`attach` 只连接现有 Host，不隐式安装、启动或重启服务。
`uninstall` 只删除带 Alu Dock generated marker 的 unit，不删除 catalog 或 Pi sessions。

`systemctl --user` active 不等于 ready。安装、start 与 restart 都会核对 systemd MainPID、
Protocol V2 hello、hostEpoch 与 managed capabilities。Alu Dock 不自动修改 user linger；需要
跨 logout 常驻时由用户自行执行：

```bash
loginctl enable-linger "$USER"
```

## 测试与安装分离

测试按改动需要显式运行：

```bash
npm run check -- --pretty false
npm test
```

`npm run install:local` 永远不调用这些命令。里程碑前可人工运行完整测试；普通本机更新
只负责打包、安装、重启和 readiness。

## 初次迁移后的核对

```bash
command -v aludock
readlink ~/.local/bin/aludock
readlink -f ~/.local/bin/aludock
aludock service status
aludock list --all
```

新的 launcher 目标应为 `~/.local/share/alu-dock/node_modules/.bin/aludock`，最终解析到
安装包的 `dist/src/cli.js`；service status 应报告 `ready: true`。旧 release 目录与旧
receipt 只是历史文件，不再参与运行时选择。
