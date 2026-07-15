# V0.1 Stage 4 Extension UI validation

Date: 2026-07-15

Scope: card #142 Stage 4; `extension_ui.v1`, current-extension compatibility, and `pi-rm-confirm` source adaptation.

## Result

**PASS for source and validation gates. Managed rollout remains separate and was not forced while the deployed Host still owns active instances.**

Stage 4 keeps Pi `AgentSession.prompt()` as the sole extension-command preflight dispatcher. Alu Dock adds no second slash-command executor and no client-owned runtime. The Host owns controller leases, dialog FIFO state, timeouts, cancellation, generation cleanup, extension status, and response completion; the TUI only renders closed DTOs and returns typed responses.

## Implemented contract

- Advertised `extension_ui.v1` in the V2 hello capability set.
- A `follow=true` attach may claim one unguessable controller lease per instance; observers remain read-only for interactions and can still use normal control commands.
- Added closed `interaction.respond` with method-specific response shapes, same-Host operation-ledger dedup, same-lease tombstones, and no automatic mutation retry.
- Added Host-owned FIFO dialogs for `select`, `confirm`, `input`, and `editor`: one active, 16 total, maximum five-minute lifetime.
- Cancellation is serialized across user cancel, timeout, signal, detach, generation replacement, and Host drain. Fail-closed defaults are `undefined` for select/input/editor and `false` for confirm.
- `notify` and `setStatus` are structured events/projection state. Component factories, custom UI, raw terminal input, custom footer/header/editor, title/editor injection, and extension-controlled tool expansion are explicit unsupported diagnostics rather than transported objects.
- Extension terminal values are bounded, C0/C1-sanitized, and reject/omit data URI or raw base64 payloads. No runtime object, handler, component, image, binary, or artifact crosses the socket.
- The SSH TUI reuses Dock-owned searchable overlay/focus/layout primitives. Confirm defaults to **No**; Esc/Ctrl+C cancels. Runtime replacement closes stale overlays, resets the lease, opens a new stream from the replacement cursor, and reacquires a new generation lease without treating the retired stream as Host loss.

## Deterministic and integration gates

Commands:

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
```

Final expected repository gate:

- TypeScript: PASS.
- Node test suite: 173/173 PASS.
- Audit: 0 high-or-greater vulnerabilities.

Coverage includes:

- closed request/response/event/controller schemas and `claim => follow` invariant;
- wrong lease, invalid method/value, duplicate response, late response, detach, signal, timeout, replacement, Host drain, queue overflow, and no-controller fail-closed behavior;
- official-client preflight rejection of binary/data-URI interaction responses;
- C0/C1 and binary/base64 omission for notifications, status, widgets, and dialogs;
- real control-socket controller/observer roundtrip and operation dedup;
- real PTY select/confirm/input/editor overlays, default-No confirmation, narrow resize, focus restoration, and detach;
- PTY runtime-generation replacement followed by controller reacquisition and a second successful confirmation;
- real Pi `0.80.6` extension command with `setStatus`, `notify`, `confirm`, `command.handled`, zero `run.started`, `lastRun=never`, and zero messages/tokens/cost.

A residual #147 viewport bug was found while running the Stage 4 PTY gate: layout-only tool expansion was incorrectly treated as unseen output and shifted the explicit reveal offset. It was fixed independently in commit `7f9074b` and covered by a deterministic reducer regression plus focused PTY.

## Current seven-extension smoke

A fresh real Pi instance loaded the configured current resources and exercised safe no-model command paths:

```text
alu-kanban       /alu-kanban status
pi-rm-confirm    /rm-confirm status
pi-web-access    /curator invalid-stage4-smoke
pi-visionizer    /visionizer-status
pi-subagents     /run                 # usage path only
pi-browser-cdp   /browser-cdp invalid-stage4-smoke
show-image       show_image catalog projection
```

Observed summary:

```json
{"result":"PASS","commandCount":40,"toolCount":18,"handled":6,"agentStarts":0,"lastRun":"never","messages":0,"tokens":0,"cost":0,"notificationCount":7,"statusKeys":["alu-kanban","browser"]}
```

The command smokes waited for each Host-owned preflight Promise/background transition before starting the next command. This is important: the immediate prompt receipt means accepted preflight, while `command.handled` is the no-model completion fact.

## `pi-rm-confirm` safety adaptation

The unsafe loose extension was replaced, not patched in place:

- source repo: `/home/luziyi/workshop/pi-rm-confirm`
- package: `pi-rm-confirm@0.1.0`
- source commit: `c2efd10805e2`
- install: `pi install /home/luziyi/workshop/pi-rm-confirm`
- loose `~/.pi/agent/extensions/rm-confirm.ts`: removed
- package tests: 2/2 PASS

Only exact **是** and **全部是** choices allow the destructive tool call. **否**, `undefined`, cancellation, timeout, detach, missing controller, and unknown responses all return a blocking result. No Pi npm/git cache was modified.

## Boundaries and rollout

- `.pi/settings.json` remains unchanged, including compaction reserve/keep values.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` remain pinned to public package roots at `0.80.6`.
- No Pi source, `alu-daemon`, Rails/Redis bridge, Alubot, package cache, image service, Stage 5 catalog/reopen, Stage 6 tree/fork/clone, or V0.2 renderer work was added.
- Optional persistent string-widget layout and title/editor injection are not claimed as complete. Component/custom UI remains explicitly unsupported.
- The managed service and `current` release symlink were not restarted or changed during this gate. Rollout must use the existing immutable-release process after active instances reach zero.
