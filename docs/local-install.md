# 本地安装与服务

Linux checkout 使用 npm 本地安装入口及 `systemd --user` Host。Windows 使用现成的当前用户 Setup 安装流程；客户端默认托管本机 Host，可明确关闭自动启动而作为纯客户端使用。X 隐藏到托盘，手动退出才停止所管理的本机后台。

## 位置

```text
~/.local/share/alu-dock/
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 使用安装包自带的 Pi。Linux 服务保存固定的 Host 启动环境；每个 Worker 从用户登录 shell 和自己的 workspace 取得开发环境，内部的 `pi` 与 `aludock` 命令也使用同一安装包。Pi 配置目录在 Host 启动时从用户登录 shell 读取，供会话列表和 Worker 共用。环境构造细节见 [Worker 环境](agent_maps/runtime.md#worker-环境) 与 [Host startup](agent_maps/deployment.md#host-startup)。更新后，Dock History、Pi 会话和已配对设备信息保留在原位置。

默认持久状态位于 `~/.local/state/alu-dock/`；managed service 使用 systemd 提供的同一用户私有 `STATE_DIRECTORY`。`remote-access/identity.json` 是长期 Host TLS identity，`remote-access/trusted/` 是已配对客户端证书。迁移或备份 Host 时必须把这两者作为一个私有状态单元处理；删除或丢失 Host identity 会使客户端已有的 Host pin 失效并需要重新配对。关闭网络监听、更新程序或正常重启服务后，原证书和已配对设备信任继续有效。

附件目录设置保存在同一私有状态目录下的 `attachment-storage.json`。默认文件位置是 `~/.local/share/alu-dock/attachments/`（或 `$XDG_DATA_HOME/alu-dock/attachments/`），也可以在本机 Hub Settings 中设置其他绝对路径。备份或迁移时，必须一起保存 `files/` 和隐藏的 `.alu-dock/` 索引目录，才能恢复已有附件引用；迁移步骤见[永久附件目录](agent_maps/deployment.md#永久附件目录)。上传成功的文件长期保存在附件目录中，程序和服务维护、清理 Dock History 或更改设备连接设置后，文件仍保留在原位置。

## Linux 安装或更新

从要安装的工作区执行：

```bash
npm run install:local
aludock service status
```

安装器构建当前 checkout，更新本地包、launcher 和 user service，然后等待 Host ready。它不运行测试，也不自动回滚。

存在未完成 run、Queue、interaction 或 stopping instance 时，安装默认拒绝。只有明确接受中断这些工作时才使用：

```bash
npm run install:local -- --replace-active
```

替换 Alu Dock 会中断未完成的回答、等待消息和交互；请先完成或停止重要工作。

## Pi 配置与扩展

Alu Dock 自带 Pi。运行 `aludock` 后可在 **Settings → Pi** 查看可用模型，保存 API key 或完成 OAuth 登录。配置继续使用 Pi 原生 `~/.pi/agent/`（或 `PI_CODING_AGENT_DIR`），会话仍保存在其中的 `sessions/`。

安装 Pi package 使用：

```bash
aludock pi:install <npm、git 或本地 source>
```

命令使用随包 Pi 的 package manager 和 package conventions，写入 Pi global settings，不依赖 `$PATH` 中的 Pi。已经运行的 Work 使用 `/reload` 采用 extension/config 变化。

## Service 命令

```bash
aludock service install [--now]
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs [--lines N] [--follow]
aludock service uninstall
```

Linux 使用 `aludock`、`-c`、`new` 或 `attach` 前，请先用 `aludock service start` 启动后台服务；Windows 日常从客户端托盘管理本机服务。卸载后，Dock History、已保存的 Pi 会话、附件设置和附件文件仍保留在原位置。

需要跨 logout 常驻时，由用户显式启用 linger：

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

未经明确授权，不执行安装、替换 active Host 或 service restart。

## Windows 官方发行

在原生 x86_64 Windows 的 Visual Studio Developer terminal 中组装验收包：

```powershell
npm run package:windows
```

完整包构建使用开发机 Node/npm，构建 MSVC Tauri Desktop，安装 Dock production dependencies（其中包含 bundled Pi），检查所有随包 PE 文件的 x64 架构和非系统 DLL 依赖，再生成唯一的 Windows 产物：

```text
clients/official/dist/AluDock-<version>-windows-x86_64-Setup.exe
```

正式构建根据实际改动选择产物。Host/Worker/Pi-only 改动可复用已校验的 `-components.zip` 中的 Desktop/DLL，最终仍交付完整 Setup.exe。

从托盘正常退出 Alu Dock 后运行 Setup，按标准安装器提示完成安装或更新，再从开始菜单打开。构建与安装器的工程边界见[部署文档](agent_maps/deployment.md#本地安装与-windows-发行)。

默认程序目录如下；用户资料仍在原来的带空格目录 `%LOCALAPPDATA%\Alu Dock`，与程序分开。仅启用本机 Dock 时需要满足根 `package.json#engines.node` 的系统 Node.js；纯客户端不需要本机 Node。

```text
%LOCALAPPDATA%\AluDock\AluDock.exe
%LOCALAPPDATA%\AluDock\aludock.cmd
%LOCALAPPDATA%\AluDock\uninstall.exe
%LOCALAPPDATA%\AluDock\dock\
%LOCALAPPDATA%\Alu Dock\logs\host.log
```

Setup 使用每用户模式，维护开始菜单、Windows Apps 与卸载入口。系统 Node.js 由用户安装和维护，Pi 随 Alu Dock 提供。遇到应用未退出或文件被占用的提示时，按安装器指引处理。旧安装方式的用户也使用当前 Setup 流程，命令从程序安装目录调用。

完成 Setup 后，`AluDock.exe` 是日常入口。没有配置时默认随客户端启动本机 Dock；在托盘取消该选择后可只连接远程。本机 Dock 的起停选择独立于当前连接的 Main，因此连接远程 Main 时本机 SubHost 可以继续运行。窗口和托盘先打开，再显示后台的实际起停状态；已有本机或远程连接选择保持不变。

- X 隐藏 Desktop 到托盘，后台工作继续运行。
- **退出 Alu Dock** 正常停止其管理的本机 Host/Worker 后退出界面；有未完成工作时说明原因并保留界面。
- **停止本机 Dock** 只停止本机后台，客户端保留；纯客户端退出不停止远程服务。
- 托盘显示本机真实状态，并只提供该状态下适用的起停操作。
- **更新模型** 调用与 `aludock update model` 相同的 bundled Pi 模型目录刷新能力。
- **随 Windows 登录启动** 保留既有选择；开启后打开同一个客户端，并遵循「随客户端启动本机 Dock」的选择。
- **打开终端设置** 启动随包 `aludock.cmd`；Main/SubHost 角色及连接继续由同一个 TUI Settings 和 Host private state 管理。
- 托盘启动、停止和更新模型会先显示进行中通知，再显示完成或可执行的失败提示；Host 日志仍可从托盘和界面打开。

托盘的「打开终端设置」使用随包命令。也可在程序安装目录使用 PowerShell 调用：

```powershell
.\aludock.cmd
.\aludock.cmd service status
.\aludock.cmd service logs --lines 200
```

Windows 注销或重启会结束当前用户 Host；启用登录启动后，下一次登录由 Desktop 恢复。更新后，`%LOCALAPPDATA%\Alu Dock\` 中的工作记录、机器连接设置、加入 Main 的身份、附件、配对信息和日志均保留，Pi 原生配置和会话仍在原位置。

退出 Alu Dock 后，从 Windows Apps 或安装目录的 `uninstall.exe` 使用标准卸载流程。程序与 Dock/Pi 资料分开存放，卸载后资料保留在原位置。

源码调试可运行 `node dist/src/cli.js host` 与 Tauri dev；日常使用遵循上述客户端和托盘流程。Windows checkout 中的 `npm run install:local` 会构建并运行当前官方 Setup.exe，与最终用户安装使用同一布局和生命周期。Windows Remote Access 使用 TLS 设备配对，本机 Named Pipe 连接无需配对。
