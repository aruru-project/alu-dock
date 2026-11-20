# Pi engine maintenance and upgrade gate

Dock maintains its Pi engine in [aruru-project/pi](https://github.com/aruru-project/pi). The current implementation baseline is the upstream **v1.5.2** release, commit `b4afdddf44e059c67ccf5097e5317d913521b470`; Dock requires **Node.js 24.22.1** or later: the 2026-10-21 Node.js security release fixed a Brotli decoder flaw reachable through `fetch` and stopped trusting the compromised eMudhra CAs. `package.json#engines.node` declares it once; the Linux install and the Windows launcher refuse older Node.js.

## Keep upstream, our changes and artifacts separate

- The fork's `main` mirrors upstream without Dock changes. Preserve upstream release tags.
- Create the Dock implementation branch from the selected release. Build and package from that branch, not from the upstream mirror.
- Keep the default-system body interface and necessary upgrade-compatibility fixes independently reviewable and replayable.
- For a future upgrade, first synchronize upstream, compare the candidate release with our branch, then replay the required changes and verify them. Synchronizing upstream does not itself upgrade Dock or overwrite our branch.

All Pi runtime packages used by Dock come from **the same controlled fork release**. This includes the `pi-tui` imported directly by Dock's Hub/Work TUI and extension UI adapter, the `pi-ai` model facts used by `dock_models` and the `pi-agent-core` loop the personal assistant's own Agent runs (`src/assistant-agent/`, which also uses `pi-coding-agent`'s `SessionManager` and `ModelRuntime`), not just `pi-coding-agent`. Preserve their canonical package names for SDK/extension compatibility, but pin their actual artifact sources to our release. An equal version number on a community npm package is not an equivalent source. Ordinary non-Pi third-party dependencies are fixed by the actual Dock root lock; their first resolution need not reproduce the producer’s upstream build lock. Both platform assemblers consume that Dock lock with `npm ci --omit=dev --ignore-scripts`; unused Pi monorepo packages need not be distributed.

The current controlled cohort is **`1.5.2-dock.2`**, release `dock-v1.5.2-dock.2` at `1e36ca1c98e0d5d930d62644eefab7b0ce0e8d3e`, eight packages. Google models that declare XHIGH receive that native thinking level. Codex network-compression recovery is session-local: a compressed HTTP 400 with `detail: "Bad Request"` retries the same JSON uncompressed once, and remembers that choice only after a completed successful response. Adopting a new context summary or releasing the session resets it. Dock's assistant clears the same SDK session resources when it adopts a summary; Dock does not wrap provider fetches. The preceding cohort, `dock-v1.5.2-dock.1`, is the rollback target.

Pi uses a saved pi.dev catalog when it is newer than the built-in model list. The built-in list uses the upstream release date; a “not modified” response updates the saved catalog's date. `ModelRuntime.create({ owner })` lets Main own model configuration and credentials for Workers on every machine (see [runtime](agent_maps/runtime.md#模型配置与凭据)). The fork supplies a selectable default prompt body, preserves thinking preferences on explicit model selection, supports Dock's extension model preferences and exposes the native templates through `getCompactionPromptTemplates()`. Paid cache warming is off by default.

Dock and its Pi coding-agent dependency both pin `undici` at 8.12.4. The Dock root lock resolves one copy without an npm override.

## Build Pi only when Pi changes

Pi's independent producer is `scripts/build-dock-package.mjs` in the fork; its `DOCK.md` documents inputs, source provenance, candidate artifacts and release checks. A published release records the source revision, package cohort, artifact URLs and integrity hashes. Uncommitted development candidates are not release artifacts.

Source, dependency locks and the committed model-catalog pin are one set of build inputs. A patch release keeps that set; an upstream upgrade takes the selected tag and its locks together. Since `1.3.0-dock.4`, the producer verifies and hydrates only the pinned model snapshot, supports a hash-verified local copy through `--model-catalog`, and saves the snapshot with the output. It neither discovers the latest catalog nor trusts generated data left in the checkout. Do not regenerate a live model list to prepare a fixed fork's checks: restoring its pinned snapshot resolves source/data mismatches without changing model-dependent tests. Runtime model refresh through Main remains separate from SDK construction.

**Dock builds and installations do not compile or repack Pi.** The root build compiles Dock and embeds its [release version](agent_maps/deployment.md#本地安装与-windows-发行); installation assembles the pinned engine artifacts from the root lockfile. A Dock-only change reuses the existing Pi release. Do not introduce a postinstall patch, rolling branch dependency or an automatic Pi-source build into this path.

## Adopt a verified engine release in Dock

1. Update every directly used Pi package in `package.json` to the immutable fork release assets, including `pi-coding-agent`, `pi-tui`, `pi-ai` and `pi-agent-core`. Generate the complete Dock root `package-lock.json` with normal npm resolution (no candidate overrides or hand-composed consumer lock), and align `PI_SDK_VERSION` in `src/version.ts` with the installed derivative version.
2. Inspect the entire installed Pi dependency tree and lockfile. Its Pi packages must resolve to that fork release, not community Pi tarballs, a source workspace link or a global Pi. The SDK, Worker, shell launchers and extension-created Pi processes must use the same installed package authority. Resolve the CLI through the package manifest's `bin`, not a remembered `dist/cli.js` path.
3. Run `npm run test:sdk-upgrade` on Node 24, plus focused checks for the changed behavior. Preserve model/Thinking defaults, real settings-write failure feedback and the `settingsWrite.persisted` protocol guarantee; do not weaken the contract to accommodate upstream changes.
4. Verify current plugins and the actual TUI entry where their dependencies changed. Verify Linux and Windows package assembly consumes the same fixed artifacts without invoking the Pi build. Source compilation alone is not installation or native-platform evidence.
5. Before merging and before declaring the card complete, remind the user to confirm the target Node 24 environment. Environment changes, production installation, managed-service operations and real provider smoke tests require their respective authorization.

Do not combine this upgrade with unrelated upstream features, plugin upgrades, credential ownership changes or session migration. Rollback restores the prior fixed engine artifacts and Dock lockfile, not a rewritten `.pi` directory.

## What the SDK gate proves

The isolated gate drives Protocol V2 through `DockClient`, `DockHost`, `DockRegistry`, a default independent Pi Worker process, and the public Pi SDK adapter. A loopback OpenAI-compatible SSE fixture proves model discovery and selection, an extension that fails to load reported without stopping the Worker, adapter-owned Pi creation options, Alu Dock identity in Pi's system prompt, opening frozen Pi 0.81.1 session records, streamed output, a real `read` tool call and continuation, canonical persisted history, Pi steer/follow-up queues returned by a one-step abort, input taken over by an extension input hook (idle, during a run, or handed over after overflow compaction) leaving no Queue item and not claiming a later run, input sent while a reply an extension started is still being prepared (`before_agent_start`) joining that reply as queued, input sent while an extension still handles `agent_settled` (including while an attached image is still being read, and input Dock held during automatic compaction) kept in the Dock Queue where Escape returns it at once or delivered exactly once afterwards, input an input hook takes over as the reply finishes still getting a receipt, abort during automatic compaction (also overflow recovery) ending the run as aborted with no further model request, system-prompt records kept out of the conversation, provider-error recovery, name/reload continuity, unexpected Worker-loss recovery, persisted-session reopen, and clean process shutdown.

The test uses temporary agent/session/home directories, a literal dummy key, a minimal environment allowlist with no real provider credentials, and `PI_OFFLINE`; its provider listens only on loopback. It never calls a real provider, operates the managed service, or installs a production version. Its `.compat.ts` suffix keeps it out of ordinary `npm test`.

## Failure triage and limits

Triage the failed user capability, then inspect the relevant SDK source or changelog:

- startup/model: provider configuration, model/auth resolution and session construction;
- stream/tool/history: provider events, tool schemas/results and session projection;
- queue/abort: public steer, follow-up, queue-clear and abort semantics (queued input returns instead of starting after the abort);
- reload/reopen/stop: session lifecycle and Worker process ownership;
- settings: effective model/Thinking state, actual disk writes and the existing error path;
- TUI/extension: the resolved `pi-tui`/SDK package sources and public component/extension APIs.
- assistant: her own Agent (`src/assistant-agent/`) uses `pi-agent-core`'s loop and `pi-coding-agent`'s `SessionManager` and `ModelRuntime` directly. The gate does not start it; `test/assistant-*-real.test.ts` in the ordinary suite do, against the same loopback provider, so run `npm test` with an upgrade.

The SDK gate is not a full regression suite, managed-service/install test, performance SLA, native Windows/Android acceptance or proof that a hosted model accepts real traffic. Use the existing focused gates for those affected capabilities; external model access remains separately authorized.
