# Official Alu Dock Client development notes

本文件只约束 `clients/official/`。根 [`STORY.md`](../../STORY.md) 与 [`AGENTS.md`](../../AGENTS.md) 继续分别是整个产品和整个 monorepo 的最高权威。

## 工程入口

先按 [官方客户端图谱](../../docs/agent_maps/official-client.md) 定位要改的用户流程、事实 owner 与验证入口；[客户端设计理念](../../docs/client-design-principles.md) 只在该正式文本维护一份。[Conversation ownership](CONVERSATION_ARCHITECTURE.md) 记录会话/文件/编辑的具体接纳和回放边界。不要把连接变化、内容加载与本地编辑重新合成页面级恢复器。

## 产品语义与权威顺序

- 产品语义以主人明确表达为准，其次是根 `STORY.md`、Protocol V2 与对应 agent map。当前实现用于了解现状；`UI_UX_REFERENCE.md` 按头部声明的优先级作为历史参考使用。
- 产品语义存在分歧时，先提出具体问题，取得决定后再实施。

## 临时实现必须申报

按根 [`AGENTS.md`](../../AGENTS.md) 的申报与漏报处理约定执行。客户端的 Demo、MVP、mock 数据、写死尺寸、假状态、只在模拟器成立的布局和跳过的错误路径，都属于需要在代码 `TODO` 和交付报告"还没证明"中注明的临时实现。

## 工作方式

估算、范围和成本变化按根 [`AGENTS.md`](../../AGENTS.md) 的干活约定执行。

- **症状先行**：修 bug 从用户可见症状出发，先在真实入口复现（或说明为何无法复现），再定位机制。没有明确症状的机制调查，先和主人确认范围再开工。
- **最小交付**：修复任务点名的问题。顺路发现的问题记录上报，待主人点名后处理；独立审计、重构和机制加固按各自任务授权。
- **单一定义点**：同一常量、断点、界面区域的布局规则只有一个定义处。发现重复规则时，作为缺陷收敛到同一定义点。
- 借鉴既有代码前先对照本文件；引用规则或例外时，说明它对应的事故依据和适用条件。

## 用户可见文案

- 文案先说发生什么，再说用户能做什么；直接说明结果，例如“文件保留在原位置”。内部机制词、类名、状态枚举值和 ID 留在工程诊断中，不进入界面文案。
- 主人明确点名的文案可作为基准；其余按向不懂实现的人说明情况的方式写。拿不准的列出来询问。

## Project boundaries

- Official Client、Dock Host/Worker 与 TUI 属于同一仓库、同一产品。改动放在拥有该事实的模块；跨边界产品变更统一沿根目录定义的 Protocol V2 路径完成。
- Rails Web Console 等自定义 Client 仍在各自项目中维护，本目录不得跨项目修改它们。
- Keep protocol, persistence, and recovery behavior in the reusable Rust core. The Tauri host and Vue UI must not invent a second protocol implementation.
- Do not run or alter release automation, tags, signing material, or GitHub secrets unless the task explicitly asks for release work.

## Android environment

Machine-specific Android paths belong in an untracked environment file. `corepack pnpm android config-path` shows the machine-wide file shared by worktrees and the optional `.env.android.local` override for the current checkout. Both use the format in `.env.android.example`; never commit either local configuration.

Use the project entrypoint instead of invoking `tauri android` directly:

```bash
corepack pnpm android config-path
corepack pnpm android doctor
corepack pnpm android setup
corepack pnpm android build --debug --apk --target aarch64 --ci
```

The entrypoint loads the machine configuration and then the worktree override, supplies the Android environment to Tauri and Gradle, and keeps the ignored Android `local.properties` in sync. CI may provide the same variables directly.

Do not put SDK, NDK, or JDK installation paths in tracked files or documentation. Do not put signing keys or passwords in `.env.android.local`; release signing remains separate.

## Local signing materials

- `.release-secrets/android/` is ignored, owner-provisioned local storage. Its files and values are opaque credentials, not Agent context. The signing environment is fixed at `.release-secrets/android/signing.env`.
- Never inspect, print, parse, grep, hash, diff, copy, upload, or attach credential contents. Safe inspection is limited to filenames, existence, ownership/mode, and Git ignore/tracking status. Keep the files mode `0600`; do not move, replace, or delete them without explicit owner authorization.
- Explicit authorization to create a locally signed Android test package permits sourcing `signing.env` without output into the same short-lived subshell that runs `corepack pnpm android stg`. Do not source it into a long-lived interactive shell. The authorization does not permit exposing values, adding credential logging, substituting an ad-hoc signing command, changing tags, or publishing a release.

## Windows artifact delivery

Windows 使用标准安装器，工程边界见根 [`deployment.md`](../../docs/agent_maps/deployment.md#本地安装与-windows-发行)，验证范围见 [`qa.md`](../../docs/qa.md#deployment)。用户先从托盘正常退出再安装；X 仅隐藏窗口。项目验证覆盖客户端起停、纯客户端选择和真实状态。

A `--no-bundle` Windows build produces an executable that may still need sidecar DLLs. Before delivering any Windows package:

- Inspect the executable's imported DLLs and the target output directory to identify the required sidecars.
- Include every required non-system sidecar beside the executable in the archive. In particular, GNU Debug builds require the generated `WebView2Loader.dll` in the same directory as the `.exe`.
- Inspect the final archive listing and confirm that the executable and its sidecars have the intended Windows architecture.
- Describe a Linux cross-build as compilation evidence only. Call the package runnable only after a Windows launch smoke test.

## Verification

- Run checks that exercise the changed behavior, using the test scope and assertion criteria in [`qa.md`](../../docs/qa.md).
- 同一事实保留一份证据；全量构建/测试每任务至多一次。
- 界面改动注明验证层次：静态检查 / 模拟器 / 真机。尚未真机验证的 Android 界面结论写进"还没证明"。

## 交付报告（格式固定）

三段：**完成内容 / 测了什么 / 还没证明**。"还没证明"必须如实列出：未真机验证项、未联调项、临时实现、已知但未修的顺路问题。diff 规模应与任务规模匹配，超出部分在报告里逐项解释归属。
