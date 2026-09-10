# 本地安装与服务

Linux checkout 使用 npm 本地安装入口及 `systemd --user` Host。Windows 使用现成的当前用户 Setup 安装流程；客户端默认托管本机 Host，可明确关闭自动启动而作为纯客户端使用。X 隐藏到托盘，手动退出才停止所管理的本机后台。

## 位置

```text
~/.local/share/alu-dock/
~/.local/bin/aludock
~/.config/systemd/user/alu-dock.service
```

Host 和 Worker 从安装包自己的依赖加载 Agent runtime，不调用 `$PATH` 中的全局 Pi。生成的 user unit 只保存 Host 启动所需的固定 Node、CLI、HOME 和最小可执行 PATH，不固化安装命令当时的语言版本、npm PATH、`PI_CODING_AGENT_DIR` 或开发环境，也不替 Extension source 凭据文件。Managed Host 启动时从用户 login shell 解析 Pi 原生 agent directory，并让 inventory 和 Worker 共用该结果；Dock 不持久化另一份路径设置。每个 Worker 仍从用户登录 shell 和自己的 workspace 独立取得开发环境；Worker 内的 `pi` 与 `aludock` launcher 固定回到这个安装包。更新 Alu Dock 不删除 catalog、Pi 原生 session 或 remote-access identity/trust 文件。

默认持久状态位于 `~/.local/state/alu-dock/`；managed service 使用 systemd 提供的同一用户私有 `STATE_DIRECTORY`。`remote-access/identity.json` 是长期 Host TLS identity，`remote-access/trusted/` 是已配对客户端证书。迁移或备份 Host 时必须把这两者作为一个私有状态单元处理；删除或丢失 Host identity 会使客户端已有的 Host pin 失效并需要重新配对。Settings 中关闭网络监听、更新程序或普通 service restart 都不会轮换证书或删除 trust。

Attachment directory 设置保存在同一 private state 下的 `attachment-storage.json`。默认 bytes 位于 `~/.local/share/alu-dock/attachments/`（或 `$XDG_DATA_HOME/alu-dock/attachments/`），也可以在本机 Hub Settings 改为其他绝对永久路径。备份或迁移必须整体保存 `files/` 和 hidden `.alu-dock/` manifests；只备份其中一边会使 opaque `fileId` 无法恢复。Successful attachments 不随 update、service uninstall/restart、catalog forget/prune、remote disable 或 device revocation 删除。

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

Alu Dock 不要求系统另外安装 Pi。运行 `aludock` 后可在 **Settings → Pi** 查看随包 Pi 当前识别的 models，并让 Pi 自己保存 API key 或完成 OAuth 登录。配置位置仍是 Pi 原生 `~/.pi/agent/`（或 `PI_CODING_AGENT_DIR`），Session 仍在 Pi 原生 `sessions/`；Alu Dock 不创建另一份凭据或会话目录。

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

正式构建根据实际改动选择产物。Host/Worker/Pi-only 改动可复用已校验的 `-components.zip` 中的 Desktop/DLL，仍生成完整 Setup.exe；components 不是另一条安装流程。

从托盘正常退出 Alu Dock 后运行 Setup，按标准安装器提示完成安装或更新，再从开始菜单打开。资源、图标和快捷方式使用现成安装能力，不另写运行进程检测/关闭逻辑、迁移脚本或安装器专项测试。

默认程序目录如下；用户资料仍在原来的带空格目录 `%LOCALAPPDATA%\Alu Dock`，与程序分开。仅启用本机 Dock 时需要满足根 `package.json#engines.node` 的系统 Node.js；纯客户端不需要本机 Node。

```text
%LOCALAPPDATA%\AluDock\AluDock.exe
%LOCALAPPDATA%\AluDock\aludock.cmd
%LOCALAPPDATA%\AluDock\uninstall.exe
%LOCALAPPDATA%\AluDock\dock\
%LOCALAPPDATA%\Alu Dock\logs\host.log
```

Setup 使用每用户模式，并由标准安装器维护开始菜单、Windows Apps 与卸载入口。Alu Dock 不安装、更新或卸载系统 Node，也不要求安装系统 Pi。未退出或文件被占用时，沿用安装器自身的提示处理，不另加 hook 改造这些行为。旧安装方式的自动兼容及全局 PATH/launcher 迁移脚本不再保留。

完成 Setup 后，`AluDock.exe` 是日常入口。没有配置时默认随客户端启动本机 Dock；在托盘取消该选择后可只连接远程，不能因为选中了远程 Main 就自动关闭本机 SubHost。窗口/托盘先显示，并显示实际起停状态；已有本机或远程连接选择保持不变。

- X 隐藏 Desktop 到托盘；Host、Worker 和 Work 不停止。
- **退出 Alu Dock** 正常停止其管理的本机 Host/Worker 后退出界面；有未完成工作时说明原因并保留界面。
- **停止本机 Dock** 只停止本机后台，客户端保留；纯客户端退出不停止远程服务。
- 托盘显示本机真实状态，并只提供该状态下适用的起停操作。
- **更新模型** 调用与 `aludock update model` 相同的 bundled Pi 模型目录刷新能力。
- **随 Windows 登录启动** 保留既有选择；开启后打开同一个客户端，并遵循「随客户端启动本机 Dock」的选择，不另走独立后台路线。
- **打开终端设置** 启动随包 `aludock.cmd`；Main/SubHost 角色及连接继续由同一个 TUI Settings 和 Host private state 管理。
- 托盘启动、停止和更新模型会先显示进行中通知，再显示完成或可执行的失败提示；Host 日志仍可从托盘和界面打开。

托盘的「打开终端设置」使用随包命令。也可在程序安装目录使用 PowerShell 调用：

```powershell
.\aludock.cmd
.\aludock.cmd service status
.\aludock.cmd service logs --lines 200
```

Windows logoff 或重启会结束当前用户 Host；启用登录启动后，下一次登录由 Desktop 恢复。更新不删除 `%LOCALAPPDATA%\Alu Dock\` 中的 catalog、Machine 设置、enrollment、attachments、Host identity/trust 或日志，也不改变 Pi 原生配置和 Session 位置。

退出 Alu Dock 后，从 Windows Apps 或安装目录的 `uninstall.exe` 使用标准卸载流程。Dock 与 Pi 资料不放在程序目录中；普通卸载不需要清除这些资料，也不通过自制脚本停止后台。

源码调试仍可显式运行 `node dist/src/cli.js host` 与 Tauri dev，但它们不定义正式 Windows 生命周期。Windows checkout 中的 `npm run install:local` 会构建并运行当前官方 Setup.exe，因此与最终用户安装保持同一布局和生命周期。Windows Remote Access 继续使用普通 TLS 设备配对；它与免配对本机 Named Pipe 是两个入口。
