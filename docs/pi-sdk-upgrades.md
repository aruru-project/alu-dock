# Pi engine maintenance and upgrade gate

Dock maintains its Pi engine in [aruru-project/pi](https://github.com/aruru-project/pi). The current implementation baseline is the upstream **v0.85.1** release, commit `d981de1229ef899957bbe968bc8dcda02a21f477`; the new Dock release requires **Node.js 24**.

## Keep upstream, our changes and artifacts separate

- The fork's `main` mirrors upstream without Dock changes. Preserve upstream release tags.
- Create the Dock implementation branch from the selected release. Build and package from that branch, not from the upstream mirror.
- Keep the default-system body interface and necessary upgrade-compatibility fixes independently reviewable and replayable.
- For a future upgrade, first synchronize upstream, compare the candidate release with our branch, then replay the required changes and verify them. Synchronizing upstream does not itself upgrade Dock or overwrite our branch.

All Pi runtime packages used by Dock come from **the same controlled fork release**. This includes the `pi-tui` imported directly by Dock's Hub/Work TUI and extension UI adapter, not just `pi-coding-agent`. Preserve their canonical package names for SDK/extension compatibility, but pin their actual artifact sources to our release. An equal version number on a community npm package is not an equivalent source. Ordinary non-Pi third-party dependencies are fixed by the actual Dock root lock; their first resolution need not reproduce the producer’s upstream build lock. Both platform assemblers consume that Dock lock with `npm ci --omit=dev --ignore-scripts`; unused Pi monorepo packages need not be distributed.

The current controlled cohort is **`0.85.1-dock.3`**, release `dock-v0.85.1-dock.3` at `f552c4faeedd24208fb4eb95cae829cb219a17b1`. It adds the public readonly `getCompactionPromptTemplates()` getter while retaining the `.2` system body and extension-setting compatibility. Native compaction assembly, in-flight calls and extension hooks are unchanged; Dock reads the public templates rather than copying their bodies or intercepting provider requests.

## Build Pi only when Pi changes

Pi's independent producer is `scripts/build-dock-package.mjs` in the fork; its `DOCK.md` documents inputs, source provenance, candidate artifacts and release checks. A published release records the source revision, package cohort, artifact URLs and integrity hashes. Uncommitted development candidates are not release artifacts.

**Normal Dock `build`, `prepack` and installation do not compile or repack Pi.** They compile Dock and install/assemble the already fixed engine artifacts. A Dock-only change reuses the existing Pi release. Do not introduce a postinstall patch, rolling branch dependency or an automatic Pi-source build into this path.

## Adopt a verified engine release in Dock

1. Update every directly used Pi package in `package.json` to the immutable fork release assets, including `pi-coding-agent` and `pi-tui`. Generate the complete Dock root `package-lock.json` with normal npm resolution (no candidate overrides or hand-composed consumer lock), and align `PI_SDK_VERSION` in `src/version.ts` with the installed derivative version.
2. Inspect the entire installed Pi dependency tree and lockfile. Its Pi packages must resolve to that fork release, not community Pi tarballs, a source workspace link or a global Pi. The SDK, Worker, shell launchers and extension-created Pi processes must use the same installed package authority. Resolve the CLI through the package manifest's `bin`, not a remembered `dist/cli.js` path.
3. Run `npm run test:sdk-upgrade` on Node 24, plus focused checks for the changed behavior. Preserve model/Thinking defaults, real settings-write failure feedback and the `settingsWrite.persisted` protocol guarantee; do not weaken the contract to accommodate upstream changes.
4. Verify current plugins and the actual TUI entry where their dependencies changed. Verify Linux and Windows package assembly consumes the same fixed artifacts without invoking the Pi build. Source compilation alone is not installation or native-platform evidence.
5. Before merging and before declaring the card complete, remind the user to confirm the target Node 24 environment. Environment changes, production installation, managed-service operations and real provider smoke tests require their respective authorization.

Do not combine this upgrade with unrelated upstream features, plugin upgrades, credential ownership changes or session migration. Rollback restores the prior fixed engine artifacts and Dock lockfile, not a rewritten `.pi` directory.

## What the SDK gate proves

The isolated gate drives Protocol V2 through `DockClient`, `DockHost`, `DockRegistry`, a default independent Pi Worker process, and the public Pi SDK adapter. A loopback OpenAI-compatible SSE fixture proves model discovery and selection, adapter-owned Pi creation options, Alu Dock identity in Pi's system prompt, opening frozen Pi 0.81.1 session records, streamed output, a real `read` tool call and continuation, canonical persisted history, Pi steer/follow-up queues returned by a one-step abort, provider-error recovery, name/reload continuity, unexpected Worker-loss recovery, persisted-session reopen, and clean process shutdown.

The test uses temporary agent/session/home directories, a literal dummy key, a minimal environment allowlist with no real provider credentials, and `PI_OFFLINE`; its provider listens only on loopback. It never calls a real provider, operates the managed service, or installs a production version. Its `.compat.ts` suffix keeps it out of ordinary `npm test`.

## Failure triage and limits

Triage the failed user capability, then inspect the relevant SDK source or changelog:

- startup/model: provider configuration, model/auth resolution and session construction;
- stream/tool/history: provider events, tool schemas/results and session projection;
- queue/abort: public steer, follow-up, queue-clear and abort semantics (queued input returns instead of starting after the abort);
- reload/reopen/stop: session lifecycle and Worker process ownership;
- settings: effective model/Thinking state, actual disk writes and the existing error path;
- TUI/extension: the resolved `pi-tui`/SDK package sources and public component/extension APIs.

The SDK gate is not a full regression suite, managed-service/install test, performance SLA, native Windows/Android acceptance or proof that a hosted model accepts real traffic. Use the existing focused gates for those affected capabilities; external model access remains separately authorized.
