# V0.1 coordinated dogfood stabilization validation

Date: 2026-07-16

Cards: #160, #169, #170; aggregate gate #164

Status: source implementation and focused deterministic validation complete; consolidated gate, immutable rollout, managed live-subagent smoke and user Windows Terminal acceptance remain pending

## Scope

This slice replaces the historical `20260716T065650Z-d979cd4aa118` #164 candidate without adding a compatibility mode. It preserves Stage 4–6 ownership, replacement, tree, history and no-replay invariants while fixing the dogfood trust failures found after that release.

### Queue restoration

- `queue.dequeue` remains Host-authoritative: only `receipt.restored` returns to the editor; Pi-drained items remain explicit `inFlight`.
- Multiple restored messages retain steering-first order, are joined by one blank line, and are prepended as one block to the exact current editor draft. A draft typed while the request is in flight is not replaced or interleaved.
- Alt+Up never aborts. In normal conversation Esc restores first and aborts only when no `inFlight` item or dequeue failure remains.
- `inFlight`, catalog/runtime failure and `effect_unknown` leave the draft intact and cannot display a successful restoration claim.
- Queue text remains Same-Host ephemeral data and is never written to the durable catalog.

### Managed subagent and extension lifecycle

- The generated user unit keeps an absolute pinned Node `ExecStart` and now supplies a deterministic subprocess `PATH`: the deployed Node executable directory first, then `~/.local/bin` and standard system directories. It does not inherit an arbitrary login-shell PATH.
- On this installation the pinned Node directory is also the installed stock `pi` binary directory used by `pi-subagents`; Runtime never spawns or parses `alu-dock` itself.
- Closed `tool.completed.isError` remains authoritative for the human tool row. A failed subagent is rendered with the failed icon/state rather than `done`.
- Unsupported component/custom/tool-expansion visual requests do not create an extension error storm. One bounded warning explains that the visual request was ignored; actual tool failure remains a separate lifecycle fact. Arbitrary `ctx.ui.custom()` and extension-owned renderers remain unsupported.

### Localized activity pulse

- Waiting/thinking/responding/tool/retry/compaction/abort phases animate at 320 ms only while active; idle schedules no timer.
- The timer never calls `TUI.requestRender()`. It updates only the fixed physical activity row with synchronized output plus cursor save/restore.
- The write clears the row and emits no terminal-width padding, avoiding final-cell autowrap. Render placement includes width and terminal row count; a resize invalidates stale writes until the next canonical render supplies a matching placement.
- Overlay periods suppress localized writes. Canonical event renders still reconcile pi-tui's frame cache.

### Terminal selection

- Fresh startup emits no xterm 1000/1006 mode. Ordinary drag therefore belongs to the local terminal by default.
- Alt+M or `/mouse` explicitly enables Dock tracking and app-owned wheel. Overlays and editor autocomplete get first refusal on Esc; otherwise Esc or the same shortcut disables tracking before generic abort handling. Exit always disables it.
- PageUp/PageDown/Ctrl+End continue to operate the canonical Dock history in either mode. Ordinary wheel in default terminal-selection mode is deliberately not claimed as canonical history input.
- This does not add app-owned selection, clipboard transport or OSC 52.

### Actionable list and catalog cleanup

- `instance.list` is now a closed, revision-bound, newest-first page bounded by both 100 snapshots and a 786432-byte result cap, with `actionable|all` selector, total/hidden-stopped counts and a selector-bound continuation cursor. Catalog mutation makes old cursors fail retryably as `cursor_stale`.
- Typed `DockClient.list()` traverses all bounded pages. Human `list` requests only the newest actionable page; `list --all` requests only the newest all-record page and reports omitted older totals, so stopped history and long valid paths cannot create an unbounded wire response.
- New capability `catalog.maintenance.v1` owns `instance.forget` and `catalog.prune`. Forget admits only `stopped`, `host_lost` or `runtime_error`; prune accepts only selector `stopped` and removes at most 1,000 records per operation.
- Both mutations use the same-Host operation ledger and serialized catalog coordinator. Success is published only after the atomic catalog commit. Attach streams for removed identities are closed after commit.
- A commit error is conservatively `effect_unknown` with the caller operation ID because rename may already be visible before directory-sync acknowledgement. The Host faults read-only instead of inviting a destructive retry.
- Receipts fix `piSessionFilesDeleted` to literal `0`; implementation has no Pi-session deletion path. Removing creation-operation evidence does not create cross-Host exactly-once: callers must not retry an ambiguous mutation.

## Focused evidence

Development feedback completed against the built artifact:

```text
npm run build
node --test \
  dist/test/control-protocol.test.js \
  dist/test/catalog-transactions.test.js \
  dist/test/durable-registry.test.js \
  dist/test/cli-list.test.js \
  dist/test/cli-cross-client.test.js \
  dist/test/dock-control.test.js \
  dist/test/tui-ux-state.test.js \
  dist/test/pi-extension-ui-adapter.test.js \
  dist/test/dogfood-release.test.js \
  dist/test/user-service.test.js \
  dist/test/queue-restoration.test.js \
  dist/test/managed-instance.test.js

159 tests, 159 pass, 0 fail
```

The focused set includes:

- multi-message restored/in-flight partition and exact draft prepend;
- PTY Alt+Up and restore-before-abort;
- active localized pulse with zero draft rewrite, concurrent typing and resize;
- startup-zero, overlay/autocomplete priority, and paired opt-in/detach-cleanup mouse sequences;
- closed maintenance DTOs, same-Host dedup, post-rename ambiguity, 10,000-record count pagination, long-path byte pagination, 1,000-record prune and stale cursor rejection;
- Pi-session evidence surviving forget;
- honest failed tool projection and one unsupported-visual warning;
- deterministic generated unit PATH.

Two rounds of independent read-only review found and the implementation corrected: missing advertised/readiness capability assertions, count- and byte-unbounded catalog listing, oldest-first human pages, a hostile non-progressing list cursor, stale activity placement across resize, backwards `/mouse` description, startup mouse-count masking, autocomplete/mouse Esc priority, missing active-mode detach cleanup coverage and stale attach streams after catalog removal.

## Consolidated gate

PASS on the coordinated source tree:

```text
npm run check -- --pretty false  PASS
npm test                         PASS (261/261)
npm audit --audit-level=high     PASS (0 vulnerabilities)
git diff --check                PASS
```

The deterministic Night Console benchmark remained bounded at 1.002 / 0.597 / 0.502 CPU ms per update for text delta / tool args / tool output. Package-root export probes passed; no private Pi subpath imports or Pi session objects exist in `src/tui`; the intentionally retired repository `.pi/settings.json` remains absent.

## Managed and terminal evidence

Pending immutable rollout evidence:

- release ID/commit and rollback target;
- generated service PATH and `MainPID`/hello/hostEpoch match;
- installed-resource startup projection;
- real managed `pi-subagents` child spawn and successful transcript;
- deliberate child failure rendered as failed rather than done;
- source/local PTY and loopback SSH queue, activity, mouse, list/cleanup and detach checks;
- service journal and zero unintended active/pending instances.

## Remaining manual gate

Only the user can complete #164. Windows Terminal → PowerShell → SSH must still verify ordinary drag/copy at startup, Alt+M wheel opt-in and cleanup, queue restoration into a concurrently edited draft, visible but non-flickering live activity, real subagent use, default/list-all/forget/prune UX, multiline paste and detach. Completion of this document or the automated rollout does not close #164 and does not authorize resuming #158.
