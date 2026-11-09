# 本地安装与服务

Linux checkout 使用 npm 本地安装入口及 `systemd --user` Host。Windows 使用现成的当前用户 Setup 安装流程；客户端默认托管本机 Host，可明确关闭自动启动而作为纯客户端使用。X 隐藏到托盘，手动退出才停止所管理的本机后台。

## 位置

```text
~/.local/share/alu-dock/dock/  # package.json、package-lock.json、node_modules 和编译产物
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

安装器先核对 checkout 里装的依赖：与 `package-lock.json` 不一致时（例如拉取了新的 Pi 发布）先运行 `npm ci`，一致时不做额外操作。随后构建当前 checkout，在临时目录复制完整根 `package.json` / `package-lock.json` 并运行 `npm ci --omit=dev --ignore-scripts`，再加入 Dock 编译产物和资源。Linux 与 Windows 共用这份物料准备逻辑；只装配已发布的 Pi 资产，不编译或重新打包 Pi。

Linux 将准备好的应用更新到私有安装根的 `dock/`，launcher 直接指向可执行的 `dock/dist/src/cli.js`；更新 user service 后等待 Host ready。旧的外层 npm 依赖目录和锁会移除，旁边的附件及用户资料不动。安装器不运行测试，也不自动回滚。

存在未完成 run、Queue、interaction 或 stopping instance 时，安装默认拒绝。只有明确接受中断这些工作时才使用：

```bash
npm run install:local -- --replace-active
```

替换 Alu Dock 会中断未完成的回答、等待消息和交互；请先完成或停止重要工作。

## Pi 配置与扩展

Alu Dock 自带 Pi。运行 `aludock` 后可在 **Settings → Pi** 查看可用模型，保存 API key 或完成 OAuth 登录。配置继续使用 Pi 原生 `~/.pi/agent/`（或 `PI_CODING_AGENT_DIR`），会话仍保存在其中的 `sessions/`。

模型和登录只在 Main 上配置：Main 的 `models.json`、`auth.json` 和登录，供所有机器上的 Work 使用。每个 Work 每次发请求前向 Main 取一次凭据，订阅账号的登录只在 Main 上刷新；请求本身从 Work 所在的机器发出，用那台机器自己的代理等网络设置。SubHost 上的 `models.json`、`auth.json` 不再被使用，它的 **Settings → Pi** 只管理这台机器的 Pi package。Main 或它的模型服务不可用时，新的请求会报错说明原因，不会改用 SubHost 本机的配置。

两类凭据仍在 Work 所在的机器上读取：只由某个扩展自己定义、Main 上没有的供应商，用扩展自己的密钥（扩展读环境变量的，按扩展的说明在那台机器上配置）；Bedrock 和 Vertex 的云账号（AWS key/profile、Google ADC）由 Pi 在那台机器上读取。所以要用这两家，Main 和 Work 所在的机器都要配好云账号：Main 决定它们能不能选，请求用的是 Work 所在机器的账号。Dock 读一台机器的环境变量时用的是它的登录 shell，所以密钥和代理要写在登录 shell 会读的配置里。

在 `models.json` 里自己加的 `openai-responses` 供应商（比如经 CLIProxyAPI 这类代理转发到 OpenAI 或 Codex），要在供应商一级写上 `"compat": { "supportsStrictMode": true }`：

```json
"openai-sub": {
  "baseUrl": "http://192.168.1.195:38317/v1",
  "api": "openai-responses",
  "compat": { "supportsStrictMode": true },
  "models": [ … ]
}
```

不写时，Pi 发出的工具定义不带 `strict`，OpenAI 会自行把每个工具的所有参数都改成必填，模型就只能给本该省略的参数编一个值，比如给 `dock_create` 编一个不存在的机器名。写上之后，Pi 会按每个工具的定义告诉 OpenAI 哪些参数可以省略。Pi 自带的 `openai-codex` 不用写。改完后，已经运行的 Work 用 `/reload` 生效。

安装 Pi package 使用：

```bash
aludock pi:install <npm、git 或本地 source>
```

命令使用随包 Pi 的 package manager 和 package conventions，写入 Pi global settings，不依赖 `$PATH` 中的 Pi。已经运行的 Work 使用 `/reload` 采用 extension/config 变化。

## 隐藏的模型

模型隐藏列表只有 Main 上一份。列在里面的模型不会出现在任何机器上任何 Work 的模型选择列表和搜索结果里，但模型本身仍可用：Work TUI 输入完整的 `/model provider/模型id` 照样能切换。通常在官方客户端的 **Host 设置** 里管理，在哪台机器的设置页里改都是同一份；也可以直接编辑 Main 的 Host 私有状态目录中的 `model-visibility.json`：

```text
Linux:   ~/.local/state/alu-dock/model-visibility.json（managed service 为 STATE_DIRECTORY 下同名文件）
Windows: %LOCALAPPDATA%\Alu Dock\model-visibility.json
```

```json
{
  "hiddenModels": [
    { "provider": "azure-openai-responses", "id": "gpt-5.6" }
  ]
}
```

`provider` 与 `id` 和 Pi 的写法完全一致（Work TUI 的 `/model` 列表里 `provider/id` 两段）。文件不存在等于什么都不隐藏。Host 每次返回模型列表时现读这个文件，改完不用重启，下次打开模型选择就生效。文件格式写错时，这台机器暂时不隐藏任何模型，Host 设置页会指出问题；在页面上保存一次会写回正确的内容。

## 给 Agent 看的模型

子 Work 默认和父 Work 用同一个模型、同一档 thinking。只有你在对话里点名，或者项目文件（如 `AGENTS.md`）里写明时，Agent 才给子 Work 换模型或 thinking；换了的模型没有这一档时，用它最接近的一档，开子 Work 的结果里会写明。

你说"这次用 deepseek 审查"时，Agent 用 `dock_models` 在一份名单里找到准确的那个模型，而不是在全部模型里猜。名单只有 Main 上一份，SubHost 上的 Work 也读它。通常在官方客户端的 **Host 设置 → 子 Work 模型** 里管理，或者在 Main 上运行 `aludock`，进 **Settings → Pi → Models for child Works**；也可以直接编辑 Main 的 Host 私有状态目录中的 `child-models.json`，和 `model-visibility.json` 在同一个目录：

```json
{
  "models": [
    { "provider": "openai-codex", "id": "gpt-6.1-sol" },
    { "provider": "deepseek", "id": "deepseek-v4-pro" }
  ]
}
```

`provider` 与 `id` 的写法和隐藏列表一样，名单最多 50 个模型，只写模型，不写用途：写给 Agent 的"什么时候用"会被它当成规则，固定的分工请写进项目文件。父 Work 自己的模型总排在第一位；名单里的每个模型会自动附上它支持的 thinking level、上下文长度和能不能看图，这台机器当前用不了的会单独列出。

名单不限制子 Work 能用哪个模型：你点名要的其他模型照样可以用。文件不存在时，父 Work 只会看到它自己的模型。Host 每次被问到时现读这个文件，改完不用重启；格式写错时，Agent 会看到错误原因并可以转告你，设置页也会指出问题，在页面上保存一次会写回正确的内容。

## 个人助手

Dock 自带一个个人助手，默认是阿露。新建 Work 时选「以助手身份打开」，这个 Work 就载入她的人设和你写给她的设定，对话也记进她的记忆；没选的 Work 和这些无关。在哪台机器上开都一样，资料只在 Main 上一份：

```text
Linux:   ~/.local/state/alu-dock/assistant/（managed service 为 STATE_DIRECTORY 下的 assistant/）
Windows: %LOCALAPPDATA%\Alu Dock\assistant\
```

- `persona.md`：她的人设。没有这个文件时 Dock 用自带的阿露人设新建一份，之后不再覆盖，升级 Dock 也不动。想换成自己的助手，改它就行。
- `notes.md`：你亲手写的事实和规矩（比如聊天尺度、密钥文件的规矩、本机信息），和别的说法冲突时以这里为准。
- `memory.sqlite`：她经历过的对话（她自己能按关键词和时间搜），从中整理出的记忆和时间线，以及助手设置。Pi 自己的会话文件不动。

她记下的东西分三层：**记忆**是关于你这个人和你们之间的事，少而精；**时间线**是流水账，一段对话一行，写那段时间你们在做什么、聊什么（比如“11月7日 14:00–18:30：在 alu_dock 做助手记忆的后台提炼”），工程上的事也照实写但不写细节；**原话**是全部对话原文。问她“你喜欢什么”用记忆，问“上周我们在干嘛”用时间线，问“当时原话怎么说的”用原话。

记忆和时间线由 Dock 在 Main 上自己整理：在助手设置里选一个 Main 上能用的模型后，一段对话停下 10 分钟左右，她就从里面记下关于你、关于你们之间值得记的事，每条都记着出自哪句话、是什么时候说的，同时给时间线写上这段在干嘛；没有新对话半小时以上时，再把最近记下的记忆对照原话检查、合并一遍。没选模型就不整理，也不花钱；选「不整理」就是暂停，期间说的话照样存着，重新选上模型时补着整理。整理只读你、她和别的 Work 说的话，每句读全，不读工具输出和压缩摘要；她不会一次拿着全部记忆去比对，而是像聊天时一样自己去查相关的旧记忆。模型读不懂的段会先跳过，设置里能看到有几段，换一个模型时会重读。觉得哪个模型整理得不好，在助手设置里换一个模型再点「用这个模型从头整理」：后台整理出的记忆挪进「已作废」（能逐条恢复），后台写的时间线清掉，所有对话从头读一遍；你写过、改过的和她按你吩咐记下的都留着。读完之前新开的会话里记忆不全，花费大致等于当初整理这些对话的总和。新记住的不用你批准就生效，对新开的助手会话生效：新会话带着常驻的记忆和最近一周的时间线开始。记错了在「助手」页改掉、作废或删掉（删掉就是让她忘掉：不再载入，原话也搜不到，那段对话的时间线也一起收起，需要时还能恢复），也可以直接跟她说。时间线的一行写错了或不想留，在「助手」页按日期搜到它直接改写或忘掉，或者跟她说（忘掉一行不影响原话）。你改过的记忆和时间线，后台不会再动。别的 Work 发给她的话（比如她派出去的子 Work 交回的结果），她记成那个 Work 说的，不会当成你说的。

通常在官方客户端的「助手」页里看和改，也可以直接编辑两个 Markdown 文件，或者让她自己改。改动对之后新开的助手会话生效；已经开着的会话在 reload、`/new` 或 Work 重新打开时换成最新的。备份用 `aludock assistant:backup 新目录`，在 Main 上运行，Host 不用停：它把人设、手写设定和对话记忆按运行这条命令那一刻的样子复制到新目录，复制期间新说的话留给下一次备份。不要在 Host 运行时直接复制 `memory.sqlite`，最近的对话可能还在旁边的 `-wal` 文件里。恢复时先停 Host，把备份里的三个文件放回 `assistant/` 目录，再启动。

她在 Main 上还有自己的工作区 `~/.aludock/assistant`，不在任何项目里时在这里聊天、干杂活。这个目录新建的 Work 默认以助手身份打开。

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
