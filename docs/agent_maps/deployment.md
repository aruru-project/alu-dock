# Managed Host 与部署

## 这部分负责什么

Linux 继续使用 `systemd --user` 托管 Host。Windows 使用现成的每用户 Setup 安装流程，由客户端管理本机 Host：无配置时默认随客户端启动，可以在托盘关闭该选项而只使用客户端。X 隐藏到托盘并继续工作；手动「退出 Alu Dock」正常停止所管理的本机 Host/Worker 后退出。纯客户端退出不停止远端。Windows 登录启动只打开同一个客户端，不另设后台启动路线。

Host 仍拥有 Work、Worker 和会话权威。轻量 bootstrap 在读取配置和 catalog 前取得唯一的本机 lifecycle pipe；客户端使用现有起停能力及轻量状态观察，不经安装器编排生命周期。Windows 保留系统 Node，仅启动本机 Host 时需要它。原生短命启动入口只处理 Windows 子进程与输出句柄，不绕回另一层 CLI，不设安装共享锁或常驻 broker。

```text
systemd --user / hidden Windows user-session Host
      │
Dock Host Service
      ├── private local IPC (Unix socket / Windows Named Pipe)
      ├── optional mutual-TLS network port
      ├── durable catalog + private Host settings
      ├── permanent attachment store
      └── supervised Agent Workers
```

## Host startup

Managed Host 启动时：

1. 绑定并验证私有本地 IPC；
2. 加载 durable catalog；
3. 对上一次 Host 遗留状态做保守恢复；
4. 进入 ready；
5. 只有显式 create、continue、adopt 或 reopen 才启动 Worker。

Startup 不自动恢复或重放旧 prompt、Queue、interaction、Promise 或 tool effect。

Durable catalog 在 POSIX 保持既有 owner/mode 与 same-directory fsync/rename 规则。Windows Host 在首次准备 catalog 目录时建立只含当前用户与 SYSTEM 的可继承私有 DACL；启动读取时额外收紧可能来自旧版本的既有 catalog。后续 atomic replacement 从该目录创建同目录临时文件并继承相同 DACL，不在每次 catalog transition 重复启动 `icacls.exe`。

Linux Host unit 只定义 service 自己的固定 Node、CLI、HOME、最小 PATH 和 managed runtime 变量。Windows 的唯一 `aludock.cmd` launcher 从 `ALUDOCK_NODE_PATH`、官方 Node 默认目录和当前 PATH 中依次选择一份满足 `package.json#engines.node` 的系统 Node；Desktop、Host、Worker 和 Pi 子进程都沿用该进程选择，不保存第二套 Node 路径或版本。Host 把 stdout/stderr 追加到 `%LOCALAPPDATA%\Alu Dock\logs\host.log`。两边都不得把执行安装时的 RVM/NVM 选择、npm lifecycle 环境或 Extension 凭据复制成所有 Worker 的全局开发环境。

## 网络入口与配对窗口

私有本地 IPC 始终是本机入口：POSIX 使用 Unix socket 并验证路径所有权和 mode，Windows 使用 Named Pipe 和本地访问控制。可选的远程 listener 是另一种 Protocol V2 transport：默认关闭，由本机 Hub Devices 启用并配置端口；启用时绑定 `::` 且允许 dual-stack，不替代、转发或改变本地 IPC。修改端口时先关闭旧 listener 和它的远程连接，再绑定新端口；新端口绑定失败时保持网络入口关闭并在 Devices 自动显示错误，不能暗中继续暴露旧端口。

网络端口始终提供 Host TLS certificate。已配对客户端必须发送精确受信任证书，才会进入同一个 Protocol V2 handler。Devices 页面确认打开的五分钟窗口只在该端口上临时增加 unknown-certificate pairing bootstrap；它不会开启新的管理端口，也不会把 Devices/Settings、移除或配对窗口控制暴露给网络。窗口成功、失败、超时、关闭、Host restart 或 remote listener disable 时，所有 provisional pairing state 都被清理；已配对证书信任保留。

部署方负责防火墙、NAT 和端口映射。映射外部地址或端口不会改变 Host/client certificate identity，也不需要重新配对。未知连接仍会消耗一次 TCP/TLS handshake，因此公网部署应保留系统防火墙和常规连接速率保护；应用内部的 handshake deadline、连接上限、request/body 上限和 pairing transaction 上限是最后一道边界，不是 DDoS 清洗服务。

## 永久附件目录

Host 创建一个 `AttachmentService`，同时注入 Protocol V2 ingress 和 Registry 的 Worker reverse capability。POSIX 默认目录是 `${XDG_DATA_HOME:-~/.local/share}/alu-dock/attachments`，Windows 默认目录是 `%LOCALAPPDATA%\Alu Dock\attachments`；实际绝对路径保存在 Host private state 的 `attachment-storage.json`，只能从本机 Hub Settings 修改。本地 IPC 和 mTLS 不各自拥有 store，远程 endpoint 或证书变化也不迁移文件。

Store 的公开内容在 `files/`，文件名经过最小安全清洗并保持可读；`.alu-dock/manifests/` 保存 digest/fileId metadata，`.alu-dock/tmp/` 只保存未完成上传。目录和文件分别固定为 user-private mode，managed 子目录不能是 symlink。Startup 删除 tmp 和没有 manifest 引用的 provisional content，但不删除 successful attachment。没有 TTL、自动 GC 或 quota。

已经有 manifest 时 Settings 拒绝直接改变目录。管理员若要迁移，必须在 Host 停止后整体移动目录（包括 hidden `.alu-dock/` 与 `files/`），确认 owner/mode 与完整内容；重新启动后先在 Hub Settings 指向新 canonical path，再允许任何客户端上传，不能只复制可见文件。普通安装、升级、restart、remote listener change 或 client revocation 都不移动或删除附件。

## Main/SubHost startup composition

Dock 只有 Main 与 SubHost 两种角色。没有角色设置时始终启动为 Main；不存在独立 Standalone 角色。Main 的 SubHost connections 默认关闭，因此普通安装不会新增网络 listener。主人在 Main Hub Machines 实时打开或关闭连接并选择端口；Host 观察保存的 revision，关闭时断开 machine links 但保留 trust/routes，打开或换端口时写回 listening/error 结果，不重启 Registry、Worker 或客户端 authority。

主人也可以从 TUI 选择下次启动为 SubHost。首次设置在 TUI 中导入 Main 创建的一次性 join file，同时保存 enrollment、Main 地址、端口和默认取自系统机器名的本机名称；确认页会显示剩余有效时间；停止当前 Main 后在有效期内直接使用普通 Host 入口启动，不再把 join file 交给启动进程。未及时完成时，同一个 Main 的新 join file 会更新 pending token 而不更换 SubHost identity。SubHost TUI 只显示自身角色、Main 连接状态、连接设置和切回 Main 的入口；它没有客户端 local endpoint、Remote Access、完整 Hub 或 children。切回 Main 会清除 SubHost role override，但保留 enrollment 与连接设置，下次切回同一 SubHost 连接只需一次确认。

Main 的 Machines 页面可以在 Host 运行时创建 join file；TUI 会把用户保存的 Main 可达地址与当前 Machine port 一并放入文件，另一台电脑不再重复输入这些连接事实。文件中的 secret 仍只有十分钟有效、成功一次后失效的 token 与 Main certificate；地址和端口不是凭据。CLI 仍提供不附带 endpoint 的底层运维入口：

```bash
aludock machine join-file --out /private/subhost.join
```

保存的 Machine Settings 是唯一启动角色 authority；`serve` 不接受进程级 Main/SubHost 覆盖。普通开发启动读取保存角色；人类 TUI 已在切换角色时导入一次性 join file，因此后续启动不带 enrollment 参数。底层 `serve --join-file` 只保留给没有 TUI 的自动化组合。Main 的显式 `--machine-port` 仍写回并启用同一份 listener settings，且端口绑定成功后才完成启动：

```bash
aludock --socket /run/user/$UID/alu-main.sock serve --dev \
  --state /private/main/catalog.json --machine-port 43127

aludock serve --dev --state /private/sub/catalog.json
```

机器端口独立于客户端 Remote Access。Main/SubHost 的一条长期 TLS 连接 multiplex 多条逻辑 Protocol V2 stream，各 stream 独立排队和 reset；单条 stream 的 backpressure 或处理失败不关闭 machine link。SubHost 保存自己的长期 certificate 和精确 Main certificate pin，以后启动不再需要 join file；它可以早于 Main 启动，上游不可达时本机 Worker 与 Queue 继续运行并在后台重连。

## Worker lifecycle

Host 为每个 active instance 创建独立 Worker，并负责：

- Worker identity 与 runtime generation；
- POSIX process group 或 Windows process tree、termination deadline 与 direct-child reap；
- replacement 和旧 Worker fencing；
- Worker loss后的保守 instance 状态；
- 无法确认 owner release 时的 quarantine。

Worker 与 Host IPC 断开后必须自行终止，不能成为孤儿 runtime。Host 不能在旧 owner 尚未确认释放时为同一 Agent session 创建新 owner。

## Host shutdown 与 loss

正常 shutdown 停止接收新 mutation，处理已接收工作的关闭边界，提交必要 catalog 状态，并终止所有 Worker。

Host 被强制终止时没有 cleanup 保证。下一次启动只使用 durable catalog 和 Agent session metadata 判断可执行动作，不猜测内存中的工作结果。

## Service 管理

普通 Hub、Work、`new`、`attach` 和 Web 请求只连接已有 Host，不安装、启动或重启 service。

Linux 的 service 管理以及需要维护本机 Host 的命令入口如下。Windows 日常使用客户端托盘起停：

```bash
aludock service install [--now]
aludock service start
aludock service stop
aludock service restart
aludock service status
aludock service logs [--lines N] [--follow]
aludock service uninstall
```

## 本地安装与 Windows 发行

Linux 本地安装更新 `~/.local/share/alu-dock` 中的包、launcher 和 user service。Windows x64 的正式安装入口为 `AluDock-<version>-windows-x86_64-Setup.exe`；`-components.zip` 仅供后续构建复用 Desktop/DLL，不是另一条安装流程。包组装保留 bundled Pi、系统 Node 版本门槛、native prebuild pruning 和 PE/DLL 检查。

Windows 沿用 Tauri/NSIS 的标准安装、更新、卸载及运行程序提示，只配置包资源、图标和必要入口。不提供自制安装模板、PowerShell 安装事务、旧入口保护、进程检测/关闭 hook 或安装器专项测试。用户从托盘正常退出，再运行 Setup；未退出时按现成安装器的默认提示处理，不额外改造这些行为。

程序使用标准安装目录（默认 `%LOCALAPPDATA%\AluDock`），资料继续保存在既有 `%LOCALAPPDATA%\Alu Dock`、Pi 和客户端资料目录，不迁移或重建身份。包内 `aludock.cmd` 供安装目录调用以及托盘的终端入口使用，不再维护旧安装方式的全局 PATH/launcher 迁移脚本。

托盘明确显示本机 Dock 的未启动、启动中、运行中、停止中、失败或状态未确认，并只提供当前适用的一个起停操作。状态来自 Host 和进程事实，不来自按钮点击；观察超时不等于已停止。SubHost 的 Main 连接状态单独显示。客户端通过轻量 pipe 观察而非高频运行 CLI；默认启动本机服务的选择保存在既有客户端偏好存储，缺省为开启，不能用远程 Main 选择推断是否需要本机 SubHost。

Windows 系统拒绝启动时应保留可操作的客户端并说明原因，不改变系统限制。必要的项目验证聚焦客户端起停、真实状态和 Work 连续性；标准安装器不另设专项测试工程。编译证据不等于用户对客户端的验收。

存在未完成 run、Queue、interaction 或 stopping instance 时，本机正常停止仍受现有保护。Windows 的「停止本机 Dock」保留客户端；「退出 Alu Dock」必须先停止其管理的本机后台，未能停止时说明原因并保留界面。X 只是隐藏，不是退出，也不停止工作。远端服务不受这些本机操作影响。

未经用户明确授权，不执行安装、service restart 或真实模型调用。

## 代码范围

- `src/deployment/`：安装布局和 user service 管理。
- `scripts/install-local.ts`：Linux checkout 本地包更新入口；Windows checkout 构建官方 Setup.exe 并进入同一流程。
- `clients/official/scripts/package-windows.mjs`：Windows 包资源、组件复用、架构/DLL 检查以及调用标准 Setup 组装。
- `src/deployment/windows-host-lifecycle.ts`、`windows-user-host.ts`：Windows 用户 session 隐藏 Host、持久日志与私有生命周期；不承载 Dock 客户端协议。
- `clients/official/src-tauri/src/desktop_shell.rs`：Windows Desktop bootstrap、tray、single-instance 与 login startup；不复制 Host/Worker/Catalog 语义。
- `src/control/dock-host.ts`：Host socket 与 shutdown。
- `src/control/durable-catalog-store.ts`：durable catalog。
- `src/control/attachment-storage-state.ts`、`attachment-service.ts`：Host-private directory setting 与 permanent attachment store。
- `src/control/catalog-reconcile.ts`：Host startup recovery。
- `src/pi/worker-process.ts`：Worker process supervision。
- `src/pi/pi-worker-entry.ts`：当前 Pi Worker 入口和 Host-loss shutdown。

部署代码只管理进程、文件和 service，不实现 Agent session 能力。
