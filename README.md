# Alu Dock

Alu Dock 是面向本机单用户、SSH/headless 研发工作流的受管 Pi 运行时工程底座。长期运行的 Host 持有 Pi runtime、任务实例与副作用；CLI 和终端客户端只负责观察与控制。关闭或 detach 客户端不会结束 Host 中的任务，之后可以再次接入。

它的目标不是再做一个自行持有 runtime 的 Pi TUI，而是让当前与未来客户端复用同一个结构化控制面。

## 当前成熟度

Alu Dock 的 V0.1 仍在开发中。当前候选已经具备：

- 私有 Unix socket 上的长期 Host 与 durable managed catalog；
- instance 的创建、列出、接入、停止、显式 reopen、adopt、forget 与 prune；
- 默认 Dock Hub：固定提供 New、Continue、History、Pi Sessions 与 Leave；进入时不创建或恢复 runtime；
- attached Session Work TUI，包括 conversation、history、tree、queue、settings/resources、extension 文本交互与运行状态；
- 同一 Dock instance 内的 Pi session new/resume/fork/clone/reload；
- 显式的 `systemd --user` service 管理。

当前裸 `alu-dock` 进入 Dock Hub；`pwd` 只作为 Continue、History、Pi Sessions 的排序上下文和 New 默认目录，进入或退出 Hub 本身不产生 runtime/catalog mutation。Continue 只展示 active/reopenable Dock 工作，History 管理 stopped/不可恢复记录，并可从 stopped 记录的 Pi session 继续；完整磁盘 Pi sessions 仍通过独立 Resume/Adopt inventory 进入。显式 `new` 与 `attach TARGET` 直达 Session Work；`-c`/`--continue` 复用改版前的 current-project smart-entry：进入最近的可继续实例，没有则 New。完整 ID、列表展示的唯一 prefix 与唯一精确 name 共用 fail-closed TARGET 解析。

V0.1 候选仍未通过全部真实 Pi、视觉、SSH 与用户签收门禁，不得视为已发布。显式 `alu-dock open` 当前仍保留旧的 project smart-entry，可能创建或 reopen runtime；默认安全入口是裸命令 Hub。

## 当前快速开始

要求 Node.js `>=22.19.0`，并且 `alu-dock` 命令可用。首次使用时，`alu-dock service install --now` 会安装并启动 managed Host。

```bash
alu-dock service install --now
alu-dock service status

alu-dock                       # 进入无 runtime 副作用的 Dock Hub
alu-dock -c                    # 继续当前目录最近的 Dock 工作；没有则 New
alu-dock new --cwd "$PWD" --name demo
alu-dock attach TARGET          # 完整 ID、唯一 prefix 或唯一精确 name
alu-dock list
```

在 Session Work 中按 `Ctrl+D` 会 detach，Host 中的 instance 继续运行。需要结束 runtime 时再显式执行：

```bash
alu-dock stop TARGET
```

Service 只由显式命令管理；普通 Hub、`-c`、`open`、`new`、`attach` 不会自动启动或重启它。

```bash
alu-dock service start
alu-dock service stop
alu-dock service restart
alu-dock service status
alu-dock service logs --lines 200
alu-dock service logs --follow
alu-dock service uninstall
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
- Managed service 与 dogfood 发布：[`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)
