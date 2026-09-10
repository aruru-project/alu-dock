# Official Alu Dock Client development notes

本文件只约束 `clients/official/`。根 [`STORY.md`](../../STORY.md) 与 [`AGENTS.md`](../../AGENTS.md) 继续分别是整个产品和整个 monorepo 的最高权威。

## 产品语义与权威顺序

- 产品语义以主人明确表达为准，其次是根 `STORY.md`、Protocol V2 与对应 agent map。当前实现只是现状证据，不定义产品语义；`UI_UX_REFERENCE.md` 是历史参考，按它自己头部声明的优先级使用。
- 对产品语义有异议先提出再动手；不拿实现现状反向解释产品目标。

## 临时实现必须申报

- Demo、MVP、占位实现（mock 数据、写死尺寸、假状态、只在模拟器成立的布局、跳过的错误路径）必须同时做到两处可见：代码处 `TODO` 注明降级内容，交付报告"还没证明"一节显式列出。
- 未申报的降级按缺陷处理并召回整份交付重审。"能跑"不等于交付；主人在真机上自己发现占位实现，比降级本身严重一个量级。

## 工作方式

- **症状先行**：修 bug 从用户可见症状出发，先在真实入口复现（或说明为何无法复现），再定位机制。没有症状锚的机制勘探，先和主人确认范围再开工。
- **预算申报**：动手前说预期规模（改哪些文件、预计多久）。实际超过预期约两倍时停下汇报，不静默加倍努力。
- **最小交付**：只修任务点名的问题。顺路发现的问题记录上报，不顺手修；审计、重构、机制加固都不是 bug 修复的一部分。
- **单一定义点**：同一常量、断点、界面区域的布局规则只有一个定义处。两套并行规则（如曾经的 `webconsole.css` 与 `styles.css` 重叠断点）是缺陷，收敛而不是叠第三层。
- 借鉴仓库内既有代码前先对照本文件；引用规则或模仿例外前，先回答"它防的是什么事故"。

## 用户可见文案

- 说用户世界的状态（"文件保留在原位置"），不写程序状态自白或机制否定句（"不会删除文件"）。
- 不出现内部机制词、类名、状态枚举值、ID。错误提示说清发生了什么、用户现在能做什么。
- 新文案不猜存量里哪些是主人调过的——没点名就是没有基准。按"对着一个不懂实现的人念出口"的标准写；拿不准的列出来问，不自由发挥。

## Project boundaries

- Official Client、Dock Host/Worker 与 TUI 现在属于同一仓库、同一产品。改动仍应留在拥有该事实的模块；跨边界产品变更必须沿根目录定义的 Protocol V2 路径完成，不能因同仓而增加私有接口。
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

Windows 安装直接沿用现成安装器的默认流程，只做必要打包配置。不自制安装编排、进程关闭 hook、兼容迁移或安装器专项测试。用户先从托盘正常退出再安装；X 只是隐藏，不退出 Dock。客户端的起停、纯客户端选择和真实状态属于本项目功能，应按实际行为核对；这不授权扩展标准安装器的测试工程。Linux 的 systemctl 托管及 STORY.md 的多入口目标不变。

A successful `--no-bundle` Windows build does not prove that the executable is a standalone artifact. Before delivering any Windows package:

- Inspect the executable's imported DLLs and the target output directory instead of copying only the `.exe`.
- Include every required non-system sidecar beside the executable in the archive. In particular, GNU Debug builds require the generated `WebView2Loader.dll` in the same directory as the `.exe`.
- Inspect the final archive listing and confirm that the executable and its sidecars have the intended Windows architecture.
- Describe a Linux cross-build as compilation evidence only. Call the package runnable only after a Windows launch smoke test.

## Verification

- Run the checks that exercise the changed behavior. Do not add tests that only assert implementation details, duplicate an existing proof, or freeze hypothetical restrictions.
- 同一事实一份证据，不换命令重证已确认的事实；全量构建/测试每任务至多一次。
- 界面改动注明验证层次：静态检查 / 模拟器 / 真机。没上过真机的 Android 界面结论一律写进"还没证明"，不写"通过"。

## 交付报告（格式固定）

三段：**完成内容 / 测了什么 / 还没证明**。"还没证明"必须如实列出：未真机验证项、未联调项、临时实现、已知但未修的顺路问题。diff 规模应与任务规模匹配，超出部分在报告里逐项解释归属。
