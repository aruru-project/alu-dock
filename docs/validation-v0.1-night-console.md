# V0.1 Night Console validation

Date: 2026-07-16

Card: #156 (precedes #158 and #142 final acceptance)

Status: complete and deployed

## Scope

This slice applies the selected Night Console direction to the existing V0.1 `pi-tui` adapter without starting the V0.2 renderer migration.

Implemented behavior:

- a semantic dark-terminal palette with truecolor, 256-color and existing no-color safety paths;
- no application-owned full-screen background; only the user transcript and expanded tool details receive bounded local surfaces;
- single-column transcript with no persistent `You`, `Assistant`, or `Thinking` labels;
- user `▎` rail/local navy surface, native-background assistant Markdown, and violet italic thinking rail;
- tool lifecycle summaries: indigo `◆` running, teal `✓` done, rose `×` failed; expanded args/results use a low-contrast local surface while diffs retain local add/delete contrast;
- amber `↳` pending queue and `↑` history-lock projection, preserving their non-transcript meaning;
- a fixed vertical composition of transcript → pending tray/composer → two-row status dock;
- width-aware footer fields rather than four-to-five independently truncated rows;
- one compact header with `/help`; the permanent full shortcut strip was removed;
- redundant per-row re-truncation was removed after every entry renderer became width-bounded, preserving #157 caching and reducing benchmark cost.

The product contract and exact tokens are frozen in [`v0.1-night-console-design.md`](v0.1-night-console-design.md). Static fixtures are exactly 80×24 and 120×40:

- [`mockups/night-console-80x24.txt`](mockups/night-console-80x24.txt)
- [`mockups/night-console-120x40.txt`](mockups/night-console-120x40.txt)

`docs/v0.2-terminal-core-design.md` now records the current ten source/two test `pi-tui` imports and carries #154 queue, #155 pagination, #157 render-cache and #156 visual behavior into #148's atomic cutover gate.

## Preserved boundaries

This release changes only client projection and layout. It does not change:

- Host ownership, runtime sessions, extension UI promises or controller leases;
- Protocol V2, capabilities, DTOs, event identity, operation deduplication or mutation ambiguity;
- #154's `message_start` consumption boundary, authoritative dequeue, Alt+Up or Esc behavior;
- #155's reverse paging, bounded window, gap, entry/row anchor or wheel semantics;
- #157's per-entry cache and duplicate projection no-op;
- Stage 4–6 replacement, catalog, service, tree/fork/clone or Host-loss contracts.

Pending queue remains a composer-adjacent ephemeral projection. The full regression suite again exercised both Alt+Up restore-without-abort and Esc restore-then-abort paths.

## Automated evidence

Gate from commit `389eaf02697e512dfde427ef4da041c50b594fa7`:

```text
TypeScript check: PASS
npm test: 225/225 PASS
npm audit --audit-level=high: 0 vulnerabilities
git diff --check: PASS
package-root/private-import/TUI-runtime-import gates: PASS
.pi/settings.json unchanged: PASS
80×24 and 120×40 mockup dimensions: PASS
```

Deterministic additions assert:

- truecolor semantic codes and foreground-only 16-color local-surface degradation;
- no ANSI output under `NO_COLOR`/non-TTY;
- user/thinking rails and absence of permanent role labels;
- distinct running/success/failure tool states;
- pending tray ordering and unchanged `message_start` boundary;
- exactly two footer rows at wide and narrow widths;
- composer immediately above the status dock;
- 43-column footer degradation and terminal-safe line bounds.

The existing real PTY matrix passed extension dialogs, replacement reacquire, queue restore/abort, history paging/wheel, scroll lock/unseen, tool fold, settings/session commands, tree/fork/clone, abort, transport loss, resize and detach. At 43×18 the editor bottom border is now deliberately row 16, immediately above status rows 17–18.

Render benchmark, 200 persisted entries and 120 updates at width 220:

```text
text delta: 0.990 CPU ms/update
tool args:  0.590 CPU ms/update
tool output: 0.463 CPU ms/update
```

The first local-surface implementation exposed a redundant full-history `truncateToWidth` pass and measured approximately 16 ms/update. That implementation was not accepted. Entry renderers now guarantee their own width and the outer conversation cache directly reuses their rows; final measurements are below the pre-slice #155 values rather than hiding the regression behind throttling.

## Real Pi and terminal evidence

A no-model persisted Pi fixture was switched into a temporary managed instance before commit. A real 80×24 truecolor PTY observed:

- Night Console header and accent sequence;
- full-width local user surface on the terminal's existing background;
- teal tool success and no persistent role labels;
- paired xterm 1000/1006 mouse enable/disable;
- exit status 0 and a shell marker after detach.

The temporary instance was stopped and its fixture removed.

After immutable rollout, a fresh persisted Pi fixture was switched into managed instance `60523e40-52a2-42a5-805b-4ccdac2d4ce9` and attached through real loopback `ssh -tt` using the installed launcher. The synchronized 80×24 frame contained exactly:

- rows 1–19: header and single-column transcript;
- rows 20–22: three-row editor with its bottom border at row 22;
- rows 23–24: activity/runtime and identity/metrics status dock.

The SSH capture verified truecolor accent, local user background `#111C30`, teal success, role-label absence, paired mouse cleanup, process status 0 and `NIGHT_SSH_SHELL_AFTER` after detach. No model call was made. The instance was explicitly stopped, the fixture removed, and final managed state was zero active instances and zero pending queue items.

## Managed rollout

Immutable release:

- release: `20260716T024459Z-389eaf02697e`;
- previous rollback point: `20260716T014143Z-4a39989812be`;
- systemd `MainPID=2981635`, `ActiveState=active`, `SubState=running`;
- host epoch: `460e60d9-6300-4e1d-bad9-282f575eb18f` (changed from `ffe9cd0a-3a7b-401a-9c51-78ad494f2e66`);
- complete Protocol V2 capability hello unchanged;
- installed-resource smoke: 40 commands, 21 resources, 0 diagnostics, 18 tools, 24 settings and 3 tree nodes; canonical command/resource pairs passed;
- prior Host performed clean SIGTERM and the journal records one new `host.ready`; no rollback was required.

## Explicit deferrals

- V0.1 assumes the current self-hosted dark terminal. Light themes, background detection, theme selection and a complete compatibility matrix are not acceptance requirements.
- Dock does not set the terminal's full-screen background.
- The direct `pi-tui@0.80.6` dependency remains intentionally pinned for V0.1. #148 owns the test-only Core construction and one-time renderer cutover.
- #158 still owns human settings/model/tools/command/session/replacement acceptance on this candidate release. Night Console completion is not #142 final sign-off.
