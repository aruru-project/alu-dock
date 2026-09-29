# Official Alu Dock Client development notes

本文件只约束 `clients/official/`。根 [`STORY.md`](../../STORY.md) 与 [`AGENTS.md`](../../AGENTS.md) 继续分别是整个产品和整个 monorepo 的最高权威。

## 工程入口

先按 [官方客户端图谱](../../docs/agent_maps/official-client.md) 定位要改的用户流程、事实 owner 与验证入口；[客户端设计理念](../../docs/client-design-principles.md) 只在该正式文本维护一份。[Conversation ownership](CONVERSATION_ARCHITECTURE.md) 记录会话/文件/编辑的具体接纳和回放边界。不要把连接变化、内容加载与本地编辑重新合成页面级恢复器。

## 产品语义与权威顺序

- 产品语义以用户明确表达为准，其次是根 `STORY.md`、Protocol V2 与对应 agent map。当前实现用于了解现状；`UI_UX_REFERENCE.md` 按头部声明的优先级作为历史参考使用。
- 产品语义存在分歧时，先提出具体问题，取得决定后再实施。

## 用户可见文案

- 文案先说发生什么，再说用户能做什么；直接说明结果，例如“文件保留在原位置”。内部机制词、类名、状态枚举值和 ID 留在工程诊断中，不进入界面文案。

## 前端结构

客户端只有一个窗口、同一时间看一个 Work，跨区域的状态天然是全局唯一的。结构按“顶层摆放、组件自取、共享状态进 store”组织：

- `App.vue` 只摆放页面区域，并在挂载时按顺序启动一次原生事件监听（先监听，再读取）。它不创建业务模块再往下传。
- 跨区域共享的状态放 Pinia store，按领域分开：连接与 Host、当前 Work 与实时观察、界面层（弹窗、预览、焦点归还、输入框展开）、输入与草稿、Work 操作、附件上传、操作结果、交付文件、平台生命周期。要避免的是一个装下所有东西的万能对象，不是全局 store。
- store 之间只朝一个方向依赖：基础层（`app`、平台、界面层）← 实时观察 ← 各类操作 ← 输入。下层有变化要让上层知道时，由上层 watch 下层状态，不反向调用上层。出现互相引用，说明有状态该放到更下层。
- 按 Work 区分的数据（草稿、附件、操作结果）在 store 内以 Work 为键保存，切换 Work 不串。
- 组件从 store 读状态、调用 store 的动作；父子之间用 props 和 emit，不调用别的组件暴露的方法。组件自己只处理和 DOM 有关的事：元素引用、滚动、焦点、键盘。
- 组件不接收整个模块对象作 props，也不手抄 `Pick<ReturnType<...>>` 接口列表。
- 现有 `lib/use*.ts` 模块按 #323 逐步迁到上述结构；迁移期间新代码按本节写，不再往 `App.vue` 里加连线。

## 样式

- 只有一个组件用到的样式写在该组件的 `<style scoped>` 里。几个组件共用的样式放在 `src/styles/`：`tokens.css`（颜色、尺寸变量）、`base.css`（页面默认样式、动画）、`controls.css`（共用按钮等控件）、`host-connection.css`（配对与连接卡片）、`dialog.css`（通用弹窗框架的尺寸、位置和窄屏适配）、`conversation.css`（对话正文共用样式和 `v-html` 渲染的 Markdown）。
- 同一元素的一种效果只写一处。不要靠加载顺序或更高优先级去盖掉另一个文件里的规则；窄屏不同就在同一处写明对应的媒体查询。
- 样式要在 Android 最旧支持的 WebView（Chromium 99）上生效：`vite.config.ts` 的 `cssTarget` 保持 `chrome99`，不使用 CSS 嵌套、`:has()`、容器查询和 `(width <= …)` 这类范围写法的媒体查询。

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
- 同一事实保留一份证据；全量构建/测试只在汇报完成前做。
- 改了 Rust 就在提交前运行 `corepack pnpm check:rust-format`，不符合时用 `cargo fmt --all` 和 `cargo fmt --manifest-path src-tauri/Cargo.toml --all` 修正。它与发布前的格式检查是同一条命令，`corepack pnpm test` 和每次推送的 CI 也会先跑它。
- 界面改动注明验证层次：静态检查 / 模拟器 / 真机。
- 浏览器验证使用 `corepack pnpm verify:preview`（用法见 README），需要 native fixture 时以 `--fixture` 叠加插件；不另写 `createServer({ configFile: false })` 临时预览。该入口复用项目配置并强制关闭文件监听，源码变化后重启预览。一次性模块测试若独立使用 Vite `createServer`，必须设置 `server.watch: null`。普通开发热更新仍用 `corepack pnpm dev`。

