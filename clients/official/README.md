<p align="center">
  <img src="./src/assets/aludock-icon.png" width="120" alt="AluDock 图标">
</p>

<h1 align="center">AluDock Client</h1>

<p align="center">把你的 AluDock 带在身边。</p>

与自己的 AluDock 配对后，你可以在 Windows 或 Android 设备上打开 Work、继续对话，并随时查看阿露的进度和结果。

## 主要功能

- 在多台 AluDock 和不同 Work 之间切换
- 发送文字、图片与附件，接收并保存阿露提供的文件
- 查看 Queue，管理 Session，并通过 Session Tree 回到之前的对话
- 选择模型、Thinking 与 Tools，调整常用设置
- 网络恢复或重新打开应用后，继续当前对话

## 快速开始

1. 在电脑端 AluDock 中打开 **Remote Access / 配对**，选择“开始配对”。
2. 打开客户端，填写电脑地址和端口，并为当前设备命名。
3. 按界面提示，在电脑端确认四位配对码。
4. 选择一个 Work，开始对话。

不再使用某台设备时，请在电脑端 AluDock 中撤销它的访问权限。

---

## 本地开发

### 准备环境

- Node.js 22
- pnpm 10
- Rust
- 对应平台的 Tauri 2 构建依赖

### 启动桌面客户端

```bash
pnpm install
pnpm tauri dev
```

仅调整界面时可以运行 `pnpm dev`；连接 Dock 或调试原生功能时，请启动桌面或 Android 客户端。

Linux 还需要以下系统依赖：

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

### 测试

```bash
pnpm test
pnpm build

cargo test --workspace
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --all -- --check
```

## 平台构建

### Windows

```bash
pnpm tauri build --no-bundle --ci
```

该命令直接生成可运行的 `.exe`，不创建安装程序。

### Android

准备 JDK 17、Android SDK 36、Android NDK，以及目标架构的 Rust 标准库。首次生成 Android 工程：

```bash
rustup target add aarch64-linux-android
pnpm tauri android init --ci --skip-targets-install
```

构建 ARM64 Debug APK：

```bash
pnpm tauri android build --debug --apk --target aarch64 --ci
```

连接真机后，可以使用 `adb install` 安装 APK，使用 `adb logcat` 查看日志。构建 x86_64 模拟器版本时，请安装 `x86_64-linux-android` Rust target，并将构建目标改为 `x86_64`。

## 发布

普通提交不会触发打包。只有推送与项目版本一致的 `v` 标签时，[Release workflow](./.github/workflows/release.yml) 才会运行测试、构建三个平台，并创建 GitHub Release：

- Windows x86_64：可直接运行的 `.exe`
- Linux x86_64：包含可执行文件的 `.zip`
- Android ARM64：签名后的 `.apk`
- 三个平台文件的 `SHA256SUMS.txt`

发布前需要让 `package.json`、工作区 `Cargo.toml`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 使用同一版本。Android 签名还需要在 GitHub 仓库中配置以下 Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

`ANDROID_KEYSTORE_BASE64` 保存签名 keystore 文件的 Base64 内容；keystore 本身不放入仓库。确认版本和提交后推送标签：

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "AluDock $VERSION"
git push origin "v$VERSION"
```

## 协议调试工具

需要检查配对或协议交互时，可以使用仓库中的命令行工具：

```bash
cargo build -p aludock-client-cli

target/debug/aludock-client \
  --identity-dir ~/.local/share/aludock-client/dev-identity \
  pair HOST:PORT \
  --device-name "AluDock Client Dev"
```

查看已配对的 Dock 与可用 Work：

```bash
target/debug/aludock-client --identity-dir ROOT hosts
target/debug/aludock-client --identity-dir ROOT list-works --all
```

## 项目结构

```text
crates/aludock-client-core/  配对与协议客户端
crates/aludock-client-cli/   协议调试工具
src-tauri/                   Tauri 原生宿主
src/                         Vue 3 界面
```

## 安全注意事项

配对信息保存在当前设备的受保护存储中。分享日志或调试材料前，请确认其中不含配对凭据、私钥或证书信息。

协议和安全要求见 [`DOCK_REQUIREMENTS.md`](./DOCK_REQUIREMENTS.md)。

## 许可证

本项目按使用者选择，以 [Apache License 2.0](./LICENSE-APACHE) 或 [MIT License](./LICENSE-MIT) 授权。
