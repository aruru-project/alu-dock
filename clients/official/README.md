<p align="center">
  <img src="./src/assets/aludock-icon.png" width="120" alt="AluDock">
</p>

<h1 align="center">Alu Dock Official Client</h1>

<p align="center">Alu Dock 的官方 Desktop 与 Android Client。</p>

本目录是根 [`Alu Dock`](../../README.md) 产品仓库的一部分。Desktop、Android、TUI 与自定义 Client 都通过同一个 Protocol V2 连接 Host；官方 Client 不直连 Worker，也不维护另一套业务协议。

## 主要功能

- 在多个 Alu Dock 和 Work 之间切换，继续已有对话并查看运行状态
- 发送文字、图片和附件，管理 Queue、Session、模型、Thinking 与 Tools
- Desktop 通过本机 Unix socket 或 Windows Named Pipe 直接连接同一 Host
- Android 与远程 Desktop 通过配对后的 mTLS 连接 Host

## 开发环境

需要 Node.js `>=22.19.0`、Corepack 管理的 pnpm 10、Rust 1.88，以及当前平台的 Tauri 2 构建依赖。从 monorepo 根目录可以运行：

```bash
npm run client:install
npm run client:test        # Vue/TypeScript tests
npm run client:build       # Vue typecheck 与前端产物
npm run client:dev         # 浏览器设计预览
```

进入本目录可以启动真实 Desktop 原生宿主或执行通用 no-bundle 构建：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
corepack pnpm tauri build --no-bundle --ci
```

`corepack pnpm dev` 只启动浏览器设计预览，不具备 Tauri native bridge，因此不能用来证明本机 socket、文件系统或其他原生能力。根 `client:test` / `client:build` 也只覆盖前端；Rust core 与 Tauri host 的完整 gates 见下文「验证入口」。

## Linux Desktop

安装 Rust/Tauri 编译与打包依赖：

```bash
sudo apt install build-essential cmake libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf zip
```

生成可交付的 x86_64 Linux ZIP：

```bash
npm run client:package:linux
```

产物位于 `clients/official/dist/AluDock-<version>-linux-x86_64.zip`。Desktop 默认连接 `${XDG_RUNTIME_DIR}/alu-dock/dock.sock`；没有 `XDG_RUNTIME_DIR` 时使用 `~/.alu-dock/run/dock.sock`。本机连接不需要设备配对。

## Windows Desktop

在原生 x86_64 Windows 开发机安装 Tauri 2 所需的 Microsoft C++ Build Tools 与 WebView2 后，使用与上文相同的入口：

```bash
corepack pnpm tauri dev
corepack pnpm tauri build --no-bundle --ci
```

当前产物是 `src-tauri/target/release/aludock-client-app.exe` 的 Client-only native build；仓库尚无 `package:windows`，它也不是统一的 Host+Client 安装包。交付前必须按 [`AGENTS.md`](AGENTS.md) 检查 DLL sidecars、目标架构，并在 Windows 上完成启动 smoke；Linux cross-build 只能作为编译证据。

## Android

准备 JDK 17、Android SDK 36 和 `.env.android.example` 所示版本的 Android NDK。机器路径使用该文件的格式，并保存在 `corepack pnpm android config-path` 显示的本机配置位置：

```bash
corepack pnpm android config-path
corepack pnpm android doctor
corepack pnpm android setup
rustup target add aarch64-linux-android
corepack pnpm android build --debug --apk --target aarch64 --ci
```

Debug APK 位于 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。

本机正式签名材料位于 ignored 的 `.release-secrets/android/`，并按 [`AGENTS.md`](AGENTS.md) 作为 opaque credentials 处理。只有主人明确授权本机签名构建后，才运行：

```bash
corepack pnpm android stg
```

该命令不发布 Release 或修改 tag，产物位于 `dist/AluDock-<version>-android-arm64-stg.apk`。

## 验证入口

```bash
corepack pnpm test
corepack pnpm build
cargo test --workspace --locked
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --all -- --check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

协议调试工具仍可从 Rust workspace 运行：

```bash
cargo run -p aludock-client-cli -- --help
```

## 目录结构

```text
crates/aludock-client-core/  配对、Protocol V2 与本地/远程 transport
crates/aludock-client-cli/   协议调试工具
src-tauri/                   Tauri Desktop/Android 原生宿主
src/                         Vue 3 界面
scripts/                     平台开发与本地打包入口
```

Client 专用代码采用 [`LICENSE-APACHE`](LICENSE-APACHE)。产品语义与跨仓库工程规则以根 [`STORY.md`](../../STORY.md) 和 [`AGENTS.md`](../../AGENTS.md) 为准。
