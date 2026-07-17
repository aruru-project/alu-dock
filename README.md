# Alu Dock

Alu Dock 是面向 SSH headless 开发的本机 Pi 终端。一个长期运行的 Host 持有 Pi runtime，CLI/TUI 通过私有 Unix socket连接它；客户端退出不会自动结束Host中的session。

## 使用

```bash
alu-dock --help
alu-dock
alu-dock new --cwd "$PWD" --name demo
alu-dock attach TARGET
alu-dock list
```

Managed service由显式命令管理：

```bash
alu-dock service status
alu-dock service logs --lines 200
alu-dock service install --now
```

普通交互入口不会静默启动、重启或替换service。`forget`和`prune`只删除Dock catalog记录，不删除Pi session文件。

## 架构

```text
CLI / Dock Hub / Session Work TUI
                 │
             DockClient
                 │ Protocol V2 / private Unix socket
                 ▼
              DockHost
                 │
      DockRegistry + durable catalog
                 │
          ManagedInstance
                 │ RuntimeSession port
                 ▼
          Pi public SDK adapter
```

- Host是runtime、extensions、tools、admission和副作用的唯一owner。
- Dock instance ID与Pi session ID/file分离。
- Host loss不自动恢复或重放prompt、queue、Promise或tool effect。
- TUI只消费closed DTO/event，不持有Pi runtime对象。
- Mutation不自动retry；结果不确定时先查询状态。

## 开发

要求Node.js 22.19+。

```bash
npm install
npm run check -- --pretty false
npm test
npm audit --audit-level=high
```

开发入口：

```bash
npm run cli
npm run serve
```

`npm run smoke:sdk`会使用本机Pi认证并产生真实模型调用，只在明确需要时运行。

## 文档

- Agent工程入口：[`AGENTS.md`](AGENTS.md)
- 测试路由：[`docs/qa.md`](docs/qa.md)
- Managed发布：[`docs/dogfood-deployment.md`](docs/dogfood-deployment.md)

历史计划与验证证据通过Git历史、Kanban和immutable release receipts追溯，不保留在当前工作树。
