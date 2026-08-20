<p align="center">
  <img src="./src/assets/aludock-icon.png" width="120" alt="AluDock">
</p>

<h1 align="center">AluDock Client</h1>

<p align="center">把你的 AluDock 带在身边。</p>

和电脑上的 AluDock 配对后，你可以从另一台电脑或手机打开已有 Work，继续对话、查看执行进度，并保存生成的图片和文件。

## 主要功能

- 在多个 AluDock 和 Work 之间切换，随时接上之前的对话
- 发送文字、图片和附件，查看实时输出与运行状态
- 管理 Queue 和 Session，通过 Session Tree 回到之前的对话分支
- 为不同 Work 选择模型、Thinking、Tools 和常用设置

## 开始使用

1. 在电脑上的 AluDock 中打开 **Remote Access / 配对**，开始一次新的配对。
2. 在客户端中填写电脑地址和端口，并为当前设备取一个名字。
3. 核对四位配对码，然后回到电脑端确认。
4. 选择一个 Work，继续对话。

## 下载

发布版本可在 [GitHub Releases](https://github.com/aruru-project/aludock-client/releases) 中获取：

- Windows x86_64：`.exe`
- Linux x86_64：`.zip`
- Android ARM64：`.apk`

## 开发

需要 Node.js 22、pnpm 10、Rust 1.88，以及当前平台的 Tauri 2 构建依赖。

安装依赖并启动桌面客户端：

```bash
pnpm install
pnpm tauri dev
```

只调整界面时，可以运行：

```bash
pnpm dev
```

Linux 需要以下系统依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

### 测试

```bash
pnpm test
pnpm build

cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --all -- --check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

### 桌面构建

```bash
pnpm tauri build --no-bundle --ci
```

构建产物位于 `src-tauri/target/release/`。

### Android 构建

准备 JDK 17、Android SDK 36 和 Android NDK，并安装目标架构的 Rust 标准库：

```bash
rustup target add aarch64-linux-android
pnpm tauri android build --debug --apk --target aarch64 --ci
```

构建 x86_64 模拟器版本时，将 Rust target 和构建目标改为 `x86_64-linux-android` 与 `x86_64`。

协议调试工具可以直接从工作区运行：

```bash
cargo run -p aludock-client-cli -- --help
```

## 仓库结构

```text
crates/aludock-client-core/  配对与协议客户端
crates/aludock-client-cli/   协议调试工具
src-tauri/                   Tauri 原生宿主
src/                         Vue 3 界面
```

## 许可证

本项目采用 [Apache-2.0](./LICENSE-APACHE) 许可证。
