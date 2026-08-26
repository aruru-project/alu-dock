# Alu Dock

Alu Dock 是本机单用户的 Agent 运行与控制主体。长期 Host Service 持有 Work 与 Worker 生命周期；官方 Desktop/Android Client、Hub/Work TUI 和自定义 Client 都通过 Protocol V2 进入同一份工作。客户端离开后，Agent 继续运行，之后可以从任一入口重新接入。

当前唯一 Agent 实现是 Pi。Pi runtime 在每个 active Work 自己的 OS Worker 中运行；未来可以通过新的 Worker adapter 接入其他 Agent。

```text
Official Desktop/Android / Hub TUI / Work TUI / custom clients
                              │
                         Protocol V2
                              │
                       Dock Host Service
                              │
                    private Worker transport
                              │
                         Agent Worker
                              │
                     Pi / future Agent runtime
```

## 当前能力

- 长期 Host 与 durable Work catalog；
- 多个相互隔离的 Agent Worker；
- Work 创建、继续、停止、reopen、adopt、forget 与项目目录浏览；
- conversation、Queue、model、thinking、tools、settings、Session Tree、compaction 和 Extension UI；
- Protocol V2 的权威读取、实时跟随、断线恢复和 mutation identity；
- POSIX Unix socket、Windows Named Pipe 与可选的配对后 mTLS 入口；
- Main/SubHost 的多机器 Work 管理；
- 永久附件、对话图片、临时交付文件和 workspace 浏览；
- bundled Pi 的 models、登录、packages、extensions 与原生 Session；
- Linux `systemd --user` 与 Windows 用户 session Host 生命周期；
- 官方 Vue/Rust/Tauri Desktop 与 Android Client。

## 仓库结构

```text
src/                       Host、Worker、TUI 与 Protocol V2
test/                      Dock 测试与 Pi SDK upgrade gate
clients/official/          官方 Vue/Rust/Tauri Desktop/Android Client
docs/                      产品接入、架构、QA 与部署文档
scripts/                    Dock 构建、安装和开发入口
```

根目录继续是 Dock 的 Node package。官方 Client 保留自己的 pnpm、Cargo workspace 和 lockfile；同仓不要求把 Node、Rust、Vue 或 Tauri 合并成一个进程或依赖管理器。

## Linux 快速开始

从源码安装要求 Node.js `>=22.19.0`。Windows 日常安装使用下文的官方发行包，不运行 `install:local`。

```bash
npm install
npm run install:local
aludock service status

aludock                       # Dock Hub
aludock -c                    # 继续当前项目
aludock new --cwd "$PWD" --name demo
aludock attach TARGET
aludock list
```

离开界面不会停止 Work。需要结束 Agent runtime 时显式执行：

```bash
aludock stop TARGET
```

安装后的 Host 使用同一组 service 命令管理：

```bash
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs --lines 200
```

`forget` 和 `prune` 只删除 Dock catalog record，不删除 Agent Session 文件。

## 官方 Desktop/Android Client

安装 Client 依赖并运行前端快速检查：

```bash
npm run client:install
npm run client:test        # Vue/TypeScript tests
npm run client:build       # Vue typecheck 与前端产物
```

这两项检查不编译 Rust core 或 Tauri host；完整 Client gates、真实 Desktop 开发入口与各平台构建方式见 [`clients/official/README.md`](clients/official/README.md)。

浏览器设计预览：

```bash
npm run client:dev
```

浏览器预览不具备 Tauri native bridge，不能证明本机 socket 或原生文件能力。Desktop 的真实本机入口使用 Unix socket 或 Windows Named Pipe，连接同一 Host 且不要求设备配对。

生成可交付 Desktop ZIP：

```bash
npm run client:package:linux   # x86_64 Linux
npm run package:windows        # 在原生 x86_64 Windows Developer terminal
```

产物位于 `clients/official/dist/AluDock-<version>-<platform>-x86_64.zip`。Windows 包固定携带 Node/npm、Dock 与 bundled Pi；完整解压后运行一次 `Setup.cmd`，之后日常入口是 `%LOCALAPPDATA%\Alu Dock\app\AluDock.exe`。Android 环境、Windows 安装/验收和本机签名入口见 [`clients/official/README.md`](clients/official/README.md)。

## Pi 配置、登录与扩展

Hub 的 **Settings → Pi** 直接显示 bundled Pi 当前识别的 Providers/models，并调用 Pi 自己的 API-key 与 OAuth 登录流程。Pi 仍唯一拥有 `~/.pi/agent/settings.json`、`models.json`、`auth.json`、packages 和 `sessions/`；Alu Dock 不复制凭据、不创建另一份 Session 历史。

安装 Pi package 不需要系统 Pi：

```bash
aludock pi:install <source>
```

现有 Work 使用 `/reload` 采用配置或 extension 变化。

## 本机与远程连接

Linux Main 的默认本机 Protocol V2 endpoint 是 `${XDG_RUNTIME_DIR}/alu-dock/dock.sock`；没有 `XDG_RUNTIME_DIR` 时使用 `~/.alu-dock/run/dock.sock`。Windows 使用 `\\.\pipe\alu-dock`。本机入口不使用 TLS 或配对。

远程访问默认关闭。在本机 Hub 的 **Devices** 中打开 Remote Access 和一次五分钟连接窗口，再由远程 Client 发起配对。用户核对四位 PIN 后，双方长期使用精确证书身份连接同一套 Protocol V2。网络地址只负责找到 Host，不代替设备身份。

## 文件与 Agent-facing Dock tools

Hub **Settings → Attachment directory** 配置 Host 的永久附件目录。本机和已配对 Client 都通过 `attachments.v1` 上传；Client 只收到 opaque `fileId` 和 path-free metadata。图片附件同时保留永久附件身份并成为 Agent 原生图片输入。

每个 Pi Work 可用 `/dock-tools on|off|status` 单独控制跨 Work 工具，默认关闭。开启后可以列出、检查、等待、创建和发送给同一 Dock 中的其他 Work，也可以登记临时交付文件。目标 Work 中读到的内容始终是不可信数据，不是用户指令。

## 从源码运行 Dock

开发 Host 和 CLI 使用同一个 dev socket：

```bash
# terminal 1
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run serve
```

```bash
# terminal 2
export ALU_DOCK_SOCKET="${XDG_RUNTIME_DIR:-$HOME/.alu-dock/run}/alu-dock-dev.sock"
npm run cli
```

真实模型 smoke 只在明确授权后运行。

## 文档

- 产品目标：[`STORY.md`](STORY.md)
- 工程入口：[`AGENTS.md`](AGENTS.md)
- Client 接入：[`docs/client-integration.md`](docs/client-integration.md)
- Host 与 Protocol V2：[`docs/agent_maps/control.md`](docs/agent_maps/control.md)
- Agent Worker 与 runtime：[`docs/agent_maps/runtime.md`](docs/agent_maps/runtime.md)
- Hub 与 Work TUI：[`docs/agent_maps/tui.md`](docs/agent_maps/tui.md)
- 官方 Client：[`clients/official/README.md`](clients/official/README.md)
- 测试与验证：[`docs/qa.md`](docs/qa.md)
- 本地安装：[`docs/local-install.md`](docs/local-install.md)
