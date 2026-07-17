# Alu Dock

Alu Dock 是面向本机单用户、SSH/headless 研发工作流的受管 Pi 运行时工程底座。长期运行的 Host 持有 Pi runtime、任务实例与副作用；CLI 和终端客户端只负责观察与控制。关闭或 detach 客户端不会结束 Host 中的任务，之后可以再次接入。

它的目标不是再做一个自行持有 runtime 的 Pi TUI，而是让当前与未来客户端复用同一个结构化控制面。

## 当前成熟度

Alu Dock 的 V0.1 仍在开发中。当前候选已经具备：

- 私有 Unix socket 上的长期 Host 与 durable managed catalog；
- instance 的创建、列出、接入、停止、显式 reopen、forget 与 prune；
- attached Session Work TUI，包括 conversation、history、tree、queue、settings/resources、extension 文本交互与运行状态；
- 同一 Dock instance 内的 Pi session new/resume/fork/clone/reload；
- 显式的 `systemd --user` service 管理。

**当前还没有独立 Dock Hub。** 裸 `alu-dock` 会按当前目录 smart-open：复用、选择、reopen 或创建 instance，然后直接进入 Session Work。

V0.1 的冻结目标是将入口分层：裸命令进入按当前目录提供上下文、且不产生 runtime 副作用的 Dock Hub；显式 `new` 和 `attach` 直达 Session Work；磁盘上的 Pi sessions 从独立 Resume/Adopt inventory 进入。上述 Hub 行为尚未实现。

## 当前快速开始

要求 Node.js `>=22.19.0`，并且 `alu-dock` 命令可用。首次使用时，`alu-dock service install --now` 会安装并启动 managed Host。

```bash
alu-dock service install --now
alu-dock service status

alu-dock                       # 当前：按 cwd smart-open 后进入 Session Work
alu-dock new --cwd "$PWD" --name demo
alu-dock attach INSTANCE_ID
alu-dock list
```

在 Session Work 中按 `Ctrl+D` 会 detach，Host 中的 instance 继续运行。需要结束 runtime 时再显式执行：

```bash
alu-dock stop INSTANCE_ID
```

Service 只由显式命令管理；普通 `open`、`new`、`attach` 不会自动启动或重启它。

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
CLI / Session Work TUI
          │
      DockClient
          │ private control socket
          ▼
       DockHost ── instances + durable catalog
          │
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
