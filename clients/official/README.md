# AluDock Client

跨平台就绪的 AluDock 图形客户端。应用使用 Tauri 2 + Vue 3，共享 WebView 表现层；配对、mTLS、Protocol V2 和状态投影位于独立 Rust core，可供 Windows、Linux 与后续 Android 客户端共用。

## 当前能力

- AluDock remote pairing：SRP-6a HomeKit 3072/SHA-512
- 配对 identity：HKDF-SHA-512、ChaCha20-Poly1305、RSA-PSS/SHA-256
- provisional Host leaf DER 固定、配对后的 exact pin 与双向 TLS
- 配对最终响应丢失后的 mTLS 恢复
- version 1 多 Host 本地 registry：revision CAS、崩溃恢复 intent、每 Host 独立 identity / pin / 连接档案，以及旧单 Host identity 的无损自动迁移
- Protocol V2 `hello`、Work / workspace、command catalog、Model / Thinking、Tools、Settings 与 resource projection
- `instance.read` conversation bootstrap、`conversation.history` / `conversation.content` 完整早期记录分页、完整 cursor 校验与 `instance.follow` 实时事件流；协议图片与已发布图片通过受限二进制 IPC 安全显示
- 文本 `command.submit`、安全门控的 `command.abort`，以及独立确认的 `instance.stop`（停止共享 Work、当前运行与全部已获准 Queue 项目；mutation 结果未知时只协调、不自动重放）
- 图形化多 Host 配对：首次引导与“连接新的 AluDock”共用地址 / 端口、客户端四位码、进度、取消和最终 pinned Protocol V2 确认；只有验证完成的 Host 才会加入并激活
- Sunshine + Moonlight 式单 Host 多地址档案：局域网 / VPN / 广域网 / 手动地址按语义分层回退，同类地址保持用户排序；只有启用且 exact-pin 验证成功的地址会参与自动连接
- Host catalog 与明确切换：每台 Host 显示安全的名称 / 地址摘要，离线 Host 保持选中且不会自动跨 Host 回退；切换时清理实时流、controller 和 Session opaque token
- Host 与连接设置：可重命名当前 Host，保存不自动尝试的待验证草稿，手动验证 / 重试、查看脱敏结果与时间，排序、停用 / 重新启用及安全删除地址；固定路线仅接受启用且已验证地址，目标停用或删除后回到自动模式
- version 1 的 Host-scoped 本地界面状态：按 Host 保存所选 Work、按 Work 隔离消息草稿和详细模式，并 fail-soft 迁移旧全局键；状态 schema 不包含 Host 路径、凭据或证书材料字段
- 使用真实 Dock Work catalog 和 conversation projection 的 Tauri bridge；Host / 选择 / Work / runtime generation 关联的实时 reducer 会先更新 Work、运行与 Queue 权威状态，再渲染对话
- 真实 Command Center：按来源分组搜索、明确运行按钮与参数输入
- 顶栏 Model / Thinking 选择器，以及可搜索 Tools toggles 和类型化 Settings controls
- Control Center 项目状态：只读资源投影按来源分组、搜索、诊断、总计、截断提示与显式刷新
- 自动增高并可展开的 Composer，支持桌面原生多选、剪贴板图片粘贴、直接流式上传、进度/取消/重试、附件草稿，以及可点击的安全图片预览
- 图形 Session 管理：New / Resume / Rename / Compact / Reload，resume 使用 Host epoch 与 Work scoped opaque token，WebView 不接触 sessionFile
- 完整快照驱动的触控 Session Tree：本地展开、搜索、筛选与窗口渲染，支持 Navigate / Summary / Fork / Clone，并保留返回的 Composer 文本
- 完整 Extension UI：状态、通知/错误、上下 Composer keyed widgets、select / confirm / input / editor 交互、title / editor directives，以及字符格 viewport 回报
- Extension UI 使用独立长连接和用户明确的“处理交互 / 释放控制权”操作；仅查看 Work 不会抢走另一客户端的 controller
- controller leaseToken/controllerId 只保存在 Rust/Tauri；WebView 仅接触代次绑定的 opaque handle，并在未知 mutation 结果时锁定并要求权威重协调
- `toolsExpanded` 使用 snapshot/event/mutation 权威状态，同值事件也会重置每个工具的本地展开覆写；它与“详细/简洁”显示模式相互独立
- 深空蓝 / 樱花粉 / 冰蓝的响应式应用壳、Work 抽屉与目录浏览器
- Tauri 桌面快捷键：`Ctrl/Cmd+K` 命令中心、`Alt+↑` 取回 Queue、`Ctrl+J` Composer 换行；浏览器设计预览不截获系统快捷键
- 320px–桌面宽度的同一套触控友好界面

Rust core、开发 CLI 与 Tauri/Vue 图形界面均已支持多 Host 的添加、列出、明确切换和本地删除。授权被 Dock 撤销后，连接失败页可直接对同一张 Host 证书重新配对并替换旧客户端凭据，无需操作身份目录。图形界面的所有 Dock 请求都携带捕获的 Host ID 与选择代次；不同 Host 即使复用相同 Work ID，本地草稿、选择和异步结果也保持隔离。Android 工程仍在继续接入。界面不会把浏览器设计 fixture 冒充真实 Dock 数据，预览模式下也不能提交 mutation。Extension 文本始终按不可信纯文本渲染，不作为 HTML 注入。

“停止整个 Work”已作为低频、明确确认的 Work 生命周期操作开放，并会如实说明它清空所有客户端已获准 Queue 项目的语义；本地草稿不受影响。Queue 列表与取回已开放：只把 Dock receipt 中的 `restored` 文字、附件和后端保管的图片引用带回 Composer，`inFlight` 仅显示风险提示且不会重提。边界记录在 [`DOCK_REQUIREMENTS.md`](./DOCK_REQUIREMENTS.md)。

## 结构

```text
crates/
├── aludock-client-core/  # 与 Tauri 无关的配对、TLS、Protocol V2 与状态类型
└── aludock-client-cli/   # 人工配对及协议互操作验证入口
src-tauri/                # Tauri 2 宿主和窄 IPC bridge
src/                      # Vue 3 / TypeScript 共享表现层
```

`src-tauri` 有意保持为独立 Cargo package：缺少 GTK/WebKit 的环境仍可运行 core/CLI 全套检查，Android 构建机也不被 Linux 桌面依赖阻塞。

## 构建与检查

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p aludock-client-cli

pnpm install
pnpm build

# standalone Tauri host（需要对应平台系统库）
(cd src-tauri && cargo check && cargo test && cargo clippy --all-targets -- -D warnings)
```

Windows CI 使用 [`.github/workflows/windows-build.yml`](./.github/workflows/windows-build.yml) 在真实 `windows-latest` runner 上执行 Rust（包括原生 ACL 测试）、Tauri 与前端测试，并生成未签名的 MSI / NSIS 测试安装包。工作流不注入或打包任何配对身份；未签名安装包仅供测试，正式分发仍需代码签名与 Windows 实机验收。

Linux 桌面运行 Tauri 前还需要 Ubuntu 开发包：

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

然后使用已配对的开发客户端数据根目录启动（环境变量名称为兼容性保持不变）：

```bash
ALUDOCK_CLIENT_IDENTITY_DIR="$HOME/.local/share/aludock-client/dev-identity" pnpm tauri dev
```

纯浏览器视觉开发使用 `pnpm dev`。页面会明确显示“浏览器设计预览”，且不会提交任何 Dock mutation。

## 开发配对

`--identity-dir`（以及兼容环境变量 `ALUDOCK_CLIENT_IDENTITY_DIR`）现在表示多 Host **客户端数据根目录**。首次打开旧的单 Host identity 目录时，会原地迁移且保留原 client identity、client ID、Host pin 和连接档案；各 Host 的凭据随后隔离在该根目录下。

先在 AluDock 本机 Hub 中启用 Remote Access 并打开五分钟 Pairing Window，然后运行：

```bash
target/debug/aludock-client \
  --identity-dir ~/.local/share/aludock-client/dev-identity \
  pair HOST:PORT \
  --device-name "AluDock Client Dev"
```

客户端显示四位 PIN 并提交设备请求。在 Host Hub 中选择对应设备并输入该 PIN。成功后 CLI 会保存配对身份，并立即执行 `hello + host.info`。

`pair` 只会在最终 exact-pin mTLS 与 `hello + host.info` 验证完成后加入并激活 Host。后续验证无需再次配对；未传 `--host-id` 时使用 registry 中的 active Host：

```bash
target/debug/aludock-client \
  --identity-dir ~/.local/share/aludock-client/dev-identity \
  host-info

target/debug/aludock-client \
  --identity-dir ~/.local/share/aludock-client/dev-identity \
  list-works --all
```

Host 地址变化但证书不变时，可以通过 `host-info --endpoint NEW_HOST:PORT` 覆盖地址。多 Host 本地管理命令为：

```bash
target/debug/aludock-client --identity-dir ROOT hosts
target/debug/aludock-client --identity-dir ROOT use-host HOST_ID
target/debug/aludock-client --identity-dir ROOT --host-id HOST_ID host-info
target/debug/aludock-client --identity-dir ROOT remove-host-local HOST_ID --confirm-local-removal
```

`remove-host-local` 只删除此设备保存的凭据与地址，不会在 Host 上撤销此设备的访问权限。

## 凭据要求

客户端数据根目录包含 registry、每 Host 的客户端私钥/证书、Host leaf 证书 pin 及元数据。不得将它复制到 WebView、日志、APK 资源或 Git 仓库。Unix 下目录使用 `0700`、文件使用 `0600`；Windows 使用受保护且不继承的 DACL，只授予当前用户与 `SYSTEM` 完全控制，拒绝 reparse point，并在读取旧状态时收紧 ACL；Android 正式版使用应用私有沙箱。

开发身份只用于当前开发客户端。正式发布时，每台设备应生成并配对独立身份。

## 只读参考边界

客户端会参考 AluDock 协议与 Alubot Admin WebConsole 的成熟交互，但不会在开发本项目时修改这些仓库，也不会在运行时依赖它们的源码路径。需要 Dock 或其他项目变化的事项单独提出需求。

## License

本项目按使用者选择，以 [Apache License 2.0](./LICENSE-APACHE) 或 [MIT License](./LICENSE-MIT) 授权。
