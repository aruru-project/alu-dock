# Alu Dock

Alu Dock 是面向本机单用户、SSH/headless 研发工作流的受管 Pi 运行时工程底座。长期运行的 Host 持有 Alu Dock 管理的 Pi runtime、任务实例与副作用；CLI 和终端客户端只负责观察与控制。关闭或 detach 客户端不会结束 Host 中的任务，之后可以再次接入。

它的目标不是再做一个自行持有 runtime 的 Pi TUI，而是让当前与未来客户端复用同一个结构化控制面。

## 当前成熟度

Alu Dock 的 V0.1 仍是待签收候选。当前候选已经具备：

- 私有 Unix socket 上的长期 Host 与 durable managed catalog；
- instance 的创建、列出、接入、停止、显式 reopen、adopt、forget 与 prune；
- 默认 Dock Hub：固定提供 New、Continue、History、Pi Sessions 与 Leave；进入时不创建或恢复 runtime，并以响应式全屏阿露品牌帧呈现；Hub 独占一个 alternate-screen 生命周期，并只在菜单可见时启用点击/滚轮；
- attached Session Work TUI，包括使用canonical Alu palette的分层 conversation/activity、保留顺序与换行的 thinking/tool/compaction surface、可辨认分支的 tree、queue、settings/resources 与 extension 文本交互；footer通过Host-authoritative watcher实时显示`cwd (Git branch)`；Work 使用可流动的 main buffer 与 terminal-native mouse，不启用 Hub tracking，也没有 Alt+M 或 `/mouse` 模式；`Ctrl+O` 更新 Host-authoritative 的 generation-scoped tool 展开状态，`Alt+O` 只切换当前客户端的最近详情；
- 同一 Dock instance 内的 Pi session new/resume/fork/clone/reload；
- 显式的 `systemd --user` service 管理。

当前裸 `aludock` 进入 Dock Hub；`pwd` 只作为 Continue、History、Pi Sessions 的排序上下文和 New 默认目录，进入或退出 Hub 本身不产生 runtime/catalog mutation。Continue 只展示 active/reopenable Dock 工作，History 管理 stopped/不可恢复记录，并可从 stopped 记录的 Pi session 继续；完整磁盘 Pi sessions 仍通过独立 Resume/Adopt inventory 进入。显式 `new` 与 `attach TARGET` 直达 Session Work；`-c`/`--continue` 复用改版前的 current-project smart-entry：进入最近的可继续实例，没有则 New。完整 ID、列表展示的唯一 prefix 与唯一精确 name 共用 fail-closed TARGET 解析。

Athena 当前运行一版已通过完整源码/发布门禁与响应式 Hub/Work 人类视觉复验的候选 release，仍待普通开发任务 soak、最终统一回归和明确签收；在此之前不得视为 V0.1 已发布或已打 tag。显式 `aludock open` 当前仍保留旧的 project smart-entry，可能创建或 reopen runtime；默认安全入口是裸命令 Hub。

## 当前快速开始

要求 Node.js `>=22.19.0`，并且 `aludock` 命令可用。首次使用时，`aludock service install --now` 会安装并启动 managed Host。

```bash
aludock service install --now
aludock service status

aludock                       # 进入无 runtime 副作用的 Dock Hub
aludock -c                    # 继续当前目录最近的 Dock 工作；没有则 New
aludock new --cwd "$PWD" --name demo
aludock attach TARGET          # 完整 ID、唯一 prefix 或唯一精确 name
aludock list
```

Dock Hub 离开、报错或转入 Session Work 前会先关闭 Hub mouse tracking 并恢复原 shell screen。Session Work 保持在 main buffer，终端原生选择与滚动行为不需要模式切换；按 `Ctrl+D` 会 detach，Host 中的 instance 继续运行。需要结束 runtime 时再显式执行：

```bash
aludock stop TARGET
```

Service 只由显式命令管理；普通 Hub、`-c`、`open`、`new`、`attach` 不会自动启动或重启它。

```bash
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs --lines 200
aludock service logs --follow
aludock service uninstall
```

`forget` 与 `prune` 只移除 Dock catalog 记录，不删除 Pi session 文件。

## 心智模型

```text
CLI / Dock Hub / Session Work TUI
                │
            DockClient
                │ private control socket
                ▼
       DockHost ── instances + durable catalog
          │       └─ read-only Pi session inventory
          ▼
   Host-owned Pi runtimes
```

Dock instance 与 Pi session 是不同身份；一个 instance 可以在 session replacement 后继续存在。Host 退出或丢失时，不会自动恢复或重放进行中的 prompt、queue 或工具副作用。

生产 Host 使用 immutable release 中精确固定的 Pi SDK，不调用 `$PATH` 中的全局 `pi`。Standalone/global Pi 可以独立共存，也可共享当前 `~/.pi/agent` 资源目录，但同一个 Pi session file 不得同时由两个 runtime 进程持有。

## 从源码运行

先安装依赖：

```bash
npm install
```

开发 Host 与 CLI 必须显式共享同一个 socket。分别在两个终端运行：

```bash
# 终端 1
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run serve
```

```bash
# 终端 2
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run cli
```

`npm run smoke:sdk` 会使用本机 Pi 认证并产生真实模型调用，只在明确需要时运行。

## 文档入口

- 贡献者与 agent 工程地图：[`AGENTS.md`](AGENTS.md)
- 测试路由：[`docs/qa.md`](docs/qa.md)
- Managed service 与 Athena 发布：[`docs/athena-deployment.md`](docs/athena-deployment.md)
