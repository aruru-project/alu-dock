# AluDock Client development notes

## Project boundaries

- Make source changes only in this repository. The Dock and Rails repositories are reference implementations and remain read-only.
- Keep protocol, persistence, and recovery behavior in the reusable Rust core. The Tauri host and Vue UI must not invent a second protocol implementation.
- Do not run or alter release automation, tags, signing material, or GitHub secrets unless the task explicitly asks for release work.

## Android environment

Machine-specific Android paths belong in an untracked environment file. `pnpm android config-path` shows the machine-wide file shared by worktrees and the optional `.env.android.local` override for the current checkout. Both use the format in `.env.android.example`; never commit either local configuration.

Use the project entrypoint instead of invoking `tauri android` directly:

```bash
pnpm android config-path
pnpm android doctor
pnpm android setup
pnpm android build --debug --apk --target aarch64 --ci
```

The entrypoint loads the machine configuration and then the worktree override, supplies the Android environment to Tauri and Gradle, and keeps the ignored Android `local.properties` in sync. CI may provide the same variables directly.

Do not put SDK, NDK, or JDK installation paths in tracked files or documentation. Do not put signing keys or passwords in `.env.android.local`; release signing remains separate.

## Windows artifact delivery

A successful `--no-bundle` Windows build does not prove that the executable is a standalone artifact. Before delivering any Windows package:

- Inspect the executable's imported DLLs and the target output directory instead of copying only the `.exe`.
- Include every required non-system sidecar beside the executable in the archive. In particular, GNU Debug builds require the generated `WebView2Loader.dll` in the same directory as the `.exe`.
- Inspect the final archive listing and confirm that the executable and its sidecars have the intended Windows architecture.
- Describe a Linux cross-build as compilation evidence only. Call the package runnable only after a Windows launch smoke test.

## Verification

Run the checks that exercise the changed behavior. Do not add tests that only assert implementation details, duplicate an existing proof, or freeze hypothetical restrictions.
