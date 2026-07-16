# V0.1 `command.handled` projection validation

Date: 2026-07-16

Cards: #162 under the #164 human-acceptance blocker gate

Status: source slice complete; consolidated immutable rollout remains deferred to #164

## Problem

A slash or extension command can be accepted and complete without starting a model run. Host and Protocol V2 correctly publish `command.handled` as the authoritative no-run completion fact. The TUI previously projected every such event into the permanent conversation as:

```text
Command handled without starting a model run.
```

Commands commonly already express their result through a selector, dialog, notification, status or command-specific result. Repeating an internal lifecycle explanation made the transcript look like validation/debug output.

## Frozen boundary

`command.handled` remains unchanged in:

- the closed `DockEvent` schema and fail-closed Protocol V2 parser;
- Host command admission, operation ledger and catalog boundaries;
- live event streaming and replay;
- `RunActivity`, where it clears `waiting` to `ready` or the truthful pending queue count;
- real-Pi no-model completion tests.

Only `DockConversation.apply()` changes: successful `command.handled` events no longer create a conversation entry, either live or during replay.

The following user-meaningful output remains visible:

- `command.rejected`;
- `instance.error`, runtime and settings failures;
- `extension.error`;
- extension notifications, including error-level notifications;
- interaction dialogs and command-specific local results.

## Automated evidence

```text
TypeScript: PASS
npm test: 234/234 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/settings boundaries: PASS
```

Deterministic projection coverage sends consecutive `extension_command` and `no_run` events through replay and verifies a zero-entry conversation. It then verifies that command rejection, an extension notification and extension failure still produce the expected visible entries.

Activity coverage verifies:

```text
submitting → command.accepted → waiting
waiting → command.handled → ready
command.handled + pending=2 → queued 2
```

The PTY integration uses a deterministic runtime whose public prompt preflight succeeds and whose Promise resolves without `run.started`. Two consecutive slash commands produce:

```text
command.handled: 2
run.started: 0
execution: idle
lastRun: never
```

Neither the live terminal stream nor a fresh replay attach contains the removed generic sentence.

## Real SSH evidence

A source client was run at 80×24 through loopback `ssh -tt` against a temporary source Host and deterministic no-run runtime. `/chain` and `/chain-prompts` were submitted, followed by detach and a second replay attach.

```json
{"liveStatus":0,"replayStatus":0,"liveNoise":false,"replayNoise":false,"liveMarker":true,"replayMarker":true}
{"execution":"idle","lastRun":"never","handled":2,"runStarted":0,"pending":{"steering":0,"followUp":0,"total":0}}
```

Both sessions reached the post-TUI shell marker. The temporary instance was explicitly stopped and the temporary Host/socket removed.

## Remaining gate

This slice does not publish a release independently. #164's consolidated release and Windows Terminal/PowerShell/SSH acceptance must verify real configured extension commands remain semantically understandable without the generic lifecycle sentence. Any command that lacks a meaningful result must add a command-specific result or notification rather than restoring the protocol explanation globally.
