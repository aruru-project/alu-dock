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
pnpm android stg
```

The entrypoint loads the machine configuration and then the worktree override, supplies the Android environment to Tauri and Gradle, and keeps the ignored Android `local.properties` in sync. CI may provide the same variables directly.

Do not put SDK, NDK, or JDK installation paths in tracked files or documentation. Do not put signing keys or passwords in `.env.android.local`; release signing remains separate.

`pnpm android stg` is the local staging delivery path. It loads the ignored `.release-secrets/android/signing.env`, removes stale native-library links, builds an ARM64 Release APK with the configured Release identity, and copies it to `dist/AluDock-<version>-android-arm64-stg.apk`. The signing file must provide `ALUDOCK_ANDROID_KEYSTORE_PATH`, `ALUDOCK_ANDROID_KEYSTORE_PASSWORD`, `ALUDOCK_ANDROID_KEY_ALIAS`, and `ALUDOCK_ANDROID_KEY_PASSWORD`. This command only creates a local APK; it never publishes a Release or changes a tag.

## Verification

Run the checks that exercise the changed behavior. Do not add tests that only assert implementation details, duplicate an existing proof, or freeze hypothetical restrictions.
