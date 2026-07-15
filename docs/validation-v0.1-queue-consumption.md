# V0.1 Queue consumption and withdrawal validation

Date: 2026-07-16

Card: #154 (blocks #142)

Status: source and automated gate complete; immutable managed rollout pending

## Scope

This slice corrects the distinction between queue acceptance and Pi consumption without changing Stage 4–6 runtime ownership, replacement, catalog, or Host-loss contracts.

Implemented surface:

- advertised `queue.control.v1` and closed `queue.dequeue` mutation;
- bounded Same-Host `PendingMessageDto` projection on attach;
- `command.accepted -> message.queued -> queue.changed` acceptance sequence;
- formal user `message.submitted` only at Pi's public user `message_start` boundary;
- original-text restoration with expanded runtime-text SHA-256 correlation, duplicate FIFO identity, and steering-first/follow-up-later order;
- composer-adjacent pending tray; queue count events no longer write transcript entries;
- Alt+Up restores all messages still withdrawable without aborting; Esc, empty-editor Ctrl+C, and `/abort` restore first and abort only after a complete dequeue;
- explicit queue removal on dequeue, stop, and runtime-driven replacement; detach retains Same-Host projection while Host loss/reopen retains no body or replay.

## Contract evidence

The frozen wire and state contract is recorded in `docs/control-protocol-v2.md` and `docs/v0.1-capability-matrix.md`.

Key boundaries:

1. `accepted/queued` is not `consumed`.
2. Pending bodies are bounded to 64 items / 256,000 aggregate characters and never enter durable catalog records.
3. `queue_update` is the Pi count projection, not the transcript boundary.
4. Pi removes a queued text before emitting user `message_start`; Dock keeps the queue item visible until that public event and then publishes the stable operation/item identity at the exact transcript position.
5. Pi can await asynchronous extension hooks between internal removal and public `message_start`. `queue.dequeue` therefore returns such an item in `inFlight` rather than copying text that Pi can no longer withdraw. Esc refuses to abort in that narrow state; the subsequent `message_start` consumes the item normally.
6. Mutations are never automatically retried. Ambiguous dequeue completion retains the caller operation ID and follows `effect_unknown`.

Pinned Pi 0.80.6 source audit confirmed:

- streaming `prompt()` expands input, queues through `_queueSteer()` / `_queueFollowUp()`, and invokes `preflightResult(true)` only after the queue side effect;
- `_handleAgentEvent()` removes matching steering first, then follow-up, emits `queue_update`, awaits extension event delivery, and only then emits public `message_start`;
- `clearQueue()` returns steering/follow-up text arrays, clears Agent queues, and emits `queue_update`;
- no private package subpath or internal queue mutation API is used by Alu Dock.

## Automated evidence

The consolidated gate is run from a clean build and records:

- TypeScript check: PASS;
- full Node suite: PASS, 218/218;
- npm audit at `high`: PASS;
- `git diff --check`: PASS;
- package-root/private-import and `.pi/settings.json` preservation gates: PASS.

Deterministic regression coverage includes:

- queued text absent from formal conversation before user `message_start`;
- template/skill-expanded runtime text correlated back to original pending item;
- identical expanded messages consumed in accepted FIFO identity order;
- queue update occurring before preflight callback, matching Pi 0.80.6 ordering;
- old run settling during asynchronous preflight cannot clear the next prompt's operation ID;
- attach/reconnect pending projection and two-client observation;
- steering-first dequeue, Same-Host operation-ledger dedup, queue capacity rejection before a Pi call, and catalog post-effect ambiguity;
- the async extension-hook in-flight window does not duplicate text into the editor;
- runtime-driven replacement emits explicit queue removal in the new generation;
- real PTY at 80x24 then 43x18 validates pending tray order, Alt+Up restore without abort, and Escape restore-then-abort;
- existing real-Pi no-model extension/reopen/tree/fork/clone gates remain green.

## Managed rollout evidence

Pending. After a clean committed HEAD is published, this section will record the immutable release, MainPID, hostEpoch, V2 capability hello, resource smoke, and real SSH queue dogfood result.

## Deviations and remaining risks

- The normal product contract remains “user `message_start` is consumption.” The explicit `inFlight` receipt is a safety refinement for Pi's internal-removal/async-extension-hook gap; it avoids both silent loss and duplicate editor restoration.
- Pending bodies intentionally disappear on Host loss and are not reconstructed by reopen.
- This slice does not implement long-history pagination/wheel semantics (#155), visual-language freeze (#156), final settings/command human matrix (#158), or the V0.2 Terminal Core switch (#148).
