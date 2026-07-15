# V0.1 dogfood TUI UX validation (#147)

Date: 2026-07-15

## Scope

This slice closes the client-side dogfood gaps found after the Stage 3.6 managed release:

- one fixed terminal screen with a bottom-anchored, upward-growing composer;
- an independent history viewport with auto-follow, scroll lock, unseen-output feedback and resize-safe anchoring;
- explicit submitting/waiting/thinking/responding/tool/retry/compaction/queued/host-loss activity state;
- collapsed generic tool output with all-tools and latest-tool actions;
- typed model search across display name, provider and model id.

It changes no Host capability, wire field, DTO, session lifecycle or runtime owner. `pi-tui@0.80.6` remains a V0.1 rendering/input adapter; the reducers and product behavior are Alu Dock-owned and contain no `pi-tui` types.

## Implementation boundary

- `src/tui/screen-layout.ts`: renderer-independent screen sizing and history viewport state.
- `src/tui/run-activity.ts`: typed Dock-event activity reducer.
- `src/tui/search-filter.ts`: deterministic scored search.
- `src/tui/pi-tui-screen.ts` and `src/tui/searchable-picker.ts`: thin V0.1 `pi-tui` adapters.
- `src/tui/conversation.ts`: revisioned render cache and per-tool expansion policy.
- `src/tui/dock-tui.ts`: event/action wiring only.

No stock Pi `InteractiveMode`, private subpath, runtime object or second slash-command executor was introduced. The public `pi-tui` surface was sufficient, so #148 was not pulled forward.

## Deterministic and PTY validation

The executable specifications cover:

- exact bottom composer rows and bounded resize layout, including an 18-row PTY frame whose editor border occupies the final row;
- viewport follow/lock/unseen/return-to-bottom transitions, including live output arriving while the PTY is locked;
- model search ranking and fuzzy subsequences;
- picker keyboard input, selection and IME focus propagation;
- every frozen activity phase and settlement clearing;
- tool default collapse, running/failure summaries, `Ctrl+O` all-tools toggle and `Alt+O` latest-tool toggle; an explicit expansion reveals the selected tool even when later output follows it;
- picker specs cover empty-result/cancel behavior; real PTY covers model typing, PageUp scroll lock, new-output indication, PageDown return, resize and detach.

The focused gate passed:

```text
npm run check -- --pretty false
node --test dist/test/tui-ux-state.test.js dist/test/tui-conversation.test.js
# 18/18 PASS
node --test --test-name-pattern='SSH TUI model picker' dist/test/dock-control.test.js
# 1/1 PASS
```

The full repository gate passed before final documentation:

```text
npm test
# 160/160 PASS
npm audit --audit-level=high
# 0 vulnerabilities
git diff --check
# PASS
package versions and package-root import guards
# PASS
fresh `npm ci --omit=dev` release-candidate install + CLI help + public-root imports
# PASS
```

## Real Pi runtime validation

A fresh public-SDK instance using `openai-codex/gpt-5.6-sol` at `xhigh` was instructed to read `package.json` once and return an exact marker. It returned `ALU_DOCK_TUI_ACTIVITY_OK` and settled successfully.

Observed closed Dock events included:

```text
command.accepted -> run.started -> tool.started -> tool.args_updated
-> tool.completed -> message.delta(text) -> run.settled(succeeded)
```

Feeding that real event stream through the activity reducer produced the visible sequence:

```text
waiting for model -> tool read -> waiting for model -> responding -> ready
```

The settled projection reported one user message, two assistant messages, one tool call and one tool result.

Two additional fresh public-SDK instances validated terminal outcomes rather than synthetic wire frames:

- abort: `run.started -> run.settled(aborted)` left the instance active/idle and reusable with `lastRun=aborted`;
- failure/retry: both upper- and lower-case proxy variables were intentionally pointed at an unreachable local endpoint in that child process. Pi emitted retries 1/3, 2/3 and 3/3 with 2s/4s/8s backoff, then `run.retry_completed(success=false)` and `run.settled(failed)`; the final projection was active/failed with `lastRun=failed`.

The successful provider run emitted no `thinking` content block despite the configured `xhigh` level. The thinking transition is therefore covered by deterministic typed-event specs rather than falsely inferred from configuration. Compaction, queued, interaction, aborting and Host-loss phases are likewise covered by the reducer gate; existing PTY abort and transport-loss tests verify their client cleanup paths.

## Operational result

The committed source is ready for immutable rollout. The deploy admission path was invoked without `--allow-active`; it correctly refused because the managed Host currently owns two active instances. The service stayed active and `current` remained `20260715T054328Z-90dd434d7981`.

This slice intentionally does not force a restart: Stage 5 durable catalog/reopen is not implemented, and an unnecessary restart would drop in-memory Dock instances. Managed rollout remains pending until the Host has no active instance.

The resulting overlay/focus/search/layout primitives are available to Stage 4, but extension interaction ownership, Promise correlation, lease handling and Host-loss resolution remain Stage 4 concerns.
