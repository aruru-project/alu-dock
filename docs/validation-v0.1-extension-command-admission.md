# V0.1 registered extension command admission validation

Date: 2026-07-16  
Card: #177  
Status: source gate and immutable rollout passed

## Scope

This slice fixes the Queue/runtime divergence observed with `/rm-confirm off` while a parent run was active. Pi executed the registered extension command immediately, but Dock had already recorded its text as a steer item. The stale item could remain in the pending tray and later be restored by Alt+Up or Escape.

The fixed contract is:

- the current runtime generation's exact registered extension command is classified before prompt/steer/follow-up admission;
- execution is Host-authoritative for every Protocol V2 client, not a TUI string special case;
- its receipt is `delivery:"prompt", queued:false` even when the parent is running or the caller requested steer/follow-up;
- command text never enters Dock pending, Pi steering/follow-up, the model user transcript, or Queue restoration;
- a running parent's execution, operation ID, and activity remain authoritative;
- unknown slash input, skill commands, and prompt templates retain Pi's normal input/expansion/Queue behavior;
- reload/replacement uses the new generation's command runner and fences old handler completion.

## Implementation

- `RuntimeSession.classifyInput()` adds the minimal closed routing fact.
- `PiRuntimeHost` uses public `AgentSession.extensionRunner.getCommand()` for exact classification and `getRegisteredCommands()` for the projected command catalog. Classification and collision-resolved invocation names therefore share one current-generation authority.
- `ManagedInstance` gives registered extension commands a dedicated immediate admission path:
  1. commit conservative `admissionPending + admissionOperationId` before the Pi effect;
  2. clear admission attribution and flush any parent runtime events under their original operation;
  3. recheck the current runner and commit `command.accepted`/clear admission before invoking Pi without a Queue delivery option;
  4. leave a running parent's execution and `activeCommandId` untouched;
  5. assign an idle command's operation only if its handler starts a model run;
  6. publish `command.handled{kind:"extension_command"}` only for a no-run completion, preserve visible errors, and drop old-generation completions.
- TUI activity reduction preserves a running parent's current phase across the command's accepted/handled facts.
- Protocol, capability matrix, and README contracts now distinguish registered extension commands from unknown slash, skill, and prompt-template input.

## Evidence

### Focused and real-Pi gates

- Targeted build and 84-test managed/Pi/TUI suite: pass.
- Final focused `test/managed-instance.test.ts`: 37/37 pass.
- `test/pi-extension-ui-real.test.ts`: real Pi 0.80.6 command/UI handler, no model call, pass.
- Installed-resource smoke loaded the actual user-level `/rm-confirm` command in an isolated temporary Pi session directory:
  - receipt: `delivery:"prompt", queued:false`;
  - snapshot pending: `0/0/0`;
  - attach `pendingMessages`: `0`;
  - execution: `idle`; `lastRun:"never"`;
  - message metrics: all zero;
  - `command.handled.kind`: `extension_command`;
  - no `message.queued` or command-body `message.submitted` event.

Installed smoke log: `/tmp/alu-dock-177-installed-extension-smoke.log`.

### Consolidated gate

```text
npm run check -- --pretty false       PASS
npm test                              PASS (270/270)
npm audit --audit-level=high          PASS (0 vulnerabilities)
git diff --check                      PASS
private package-subpath guard         PASS
src/tui AgentSession import guard     PASS
package-root export smoke             PASS
repository .pi/settings.json absent   PASS
```

Logs:

- `/tmp/alu-dock-177-final-check.log`
- `/tmp/alu-dock-177-final-test.log`
- `/tmp/alu-dock-177-final-audit.log`

### Review

A fresh read-only architecture review initially found parent-operation, event-attribution, command-authority, activity, and generation-fencing risks in the in-progress draft. The implementation was reworked around a separate immediate-command admission path, the public current runner, explicit parent-event flushing, operation initiation, and generation fencing. Final review found no remaining source correctness defect; its only requested change was a stale capability-matrix sentence that still described ResourceLoader command reconstruction. That documentation conflict was corrected.

## Immutable rollout

- Source commit: `745f056c0fa396f9a0f287ae4abbceb63715df1f`.
- Release: `20260716T164215Z-745f056c0fa3` at `/home/luziyi/release/alu-dock/releases/20260716T164215Z-745f056c0fa3`.
- Previous/rollback release: `20260716T111829Z-d19aa7e4b9d6`.
- The deployer reran the complete 270-test gate, installed lockfile-pinned production dependencies, atomically switched `current`, and restarted the generated user unit.
- Initial deployed service evidence: PID `3237641`, host epoch `77a3134c-a2bb-41b1-bd49-10a2f03582d4`.
- Release smoke passed with 41 commands, 23 resources, 0 diagnostics, 18 tools, 24 settings, 3 tree nodes, and the installed `chain/chain-prompts` plus `run/run-chain` command pairs.
- Managed typed-DockClient `/rm-confirm off` smoke passed: `delivery:"prompt",queued:false`, snapshot/attach/dequeue all empty, metrics all zero, `lastRun:"never"`, `command.handled:"extension_command"`, and no queued/submitted command body. The temporary stopped record was explicitly forgotten; no Pi session file was deleted.
- Rollback-forward passed without an active runtime: rollback PID/epoch `3237835` / `722cec95-b4c7-4cf2-8ef7-0378fed50458`; final forward PID/epoch `3237932` / `56a14919-4d19-4eed-90e9-6a4b4888985f`.
- A second post-forward managed command smoke passed against PID `3237932`; `current` resolves to the new immutable release and the service is active/ready with no actionable instance.
- Journal shows the expected stop/start/ready boundaries and no new-release startup error.

Deployment evidence:

- `/tmp/alu-dock-177-deploy.log`
- `/home/luziyi/release/alu-dock/receipts/20260716T164215Z-745f056c0fa3.json`
- `/tmp/alu-dock-177-managed-extension-smoke.log`
- `/tmp/alu-dock-177-rollback-forward.log`
- `/tmp/alu-dock-177-post-forward-command-smoke.log`

## Deviations and residual risk

- No compatibility layer, private Pi import, plugin-private protocol, second Queue, or TUI-only routing rule was added.
- Handler execution remains asynchronous after the accepted receipt, matching prompt admission semantics. A second command is rejected while that handler still owns the instance admission slot.
- Pi catches registered command handler exceptions and emits the existing extension error event; an unexpected adapter-level Promise rejection is projected as `instance.error` without altering a running parent.
- This document does not validate #176 multi-runtime `pi-subagents` isolation. That work remains independently owned and must not be inferred from this gate.
- The managed smoke exercises the installed command in an idle no-model runtime. Running-parent, settlement-during-admission/handler, failure, Queue restoration, model-run initiation, activity preservation, and generation fencing are deterministic regression gates; no provider call was added merely to duplicate those invariants in production.
