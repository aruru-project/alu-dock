# AluDock Client development notes

## Project boundaries

- Make source changes only in this repository. The Dock and Rails repositories are reference implementations and remain read-only.
- Keep protocol, persistence, and recovery behavior in the reusable Rust core. The Tauri host and Vue UI must not invent a second protocol implementation.
- Do not run or alter release automation, tags, signing material, or GitHub secrets unless the task explicitly asks for release work.

## Android environment

Machine-specific Android paths belong in `.env.android.local`. Copy `.env.android.example`, fill in absolute paths, and never commit the local file.

Use the project entrypoint instead of invoking `tauri android` directly:

```bash
pnpm android doctor
pnpm android setup
pnpm android build --debug --apk --target aarch64 --ci
```

The entrypoint loads the local paths, supplies the Android environment to Tauri and Gradle, and keeps the ignored Android `local.properties` in sync. CI may provide the same variables directly.

Do not put SDK, NDK, or JDK installation paths in tracked files or documentation. Do not put signing keys or passwords in `.env.android.local`; release signing remains separate.

## Verification

Run the checks that exercise the changed behavior. Do not add tests that only assert implementation details, duplicate an existing proof, or freeze hypothetical restrictions.
