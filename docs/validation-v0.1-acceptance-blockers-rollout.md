# V0.1 #164 acceptance-blocker rollout

Date: 2026-07-16

Cards: #164 coordinating #160–#167; #158 remains paused

Status: code gate, immutable rollout, installed-resource smoke, local PTY and loopback SSH PASS; real Windows Terminal/PowerShell actions and user acceptance remain pending

## Scope

This rollout batches the seven practical blockers found after #158's first human baseline:

- #161: folded read/bash/edit/write operation summaries;
- #165: removal of the 140 ms activity repaint timer;
- #160: discoverable terminal selection and explicit mouse-mode toggle;
- #162: silent successful `command.handled` conversation projection;
- #163: one-row composer-adjacent live activity slot;
- #166: local hierarchical human CLI help;
- #167: bounded human `alu-dock list`.

The deployed commit is:

```text
d979cd4aa1182ca2849ab947f9606bea5bf012be
```

## Consolidated source gate

A clean committed tree passed:

```text
TypeScript: PASS
npm test: 245/245 PASS
npm audit --audit-level=high: 0 vulnerabilities
git diff/import/TUI-runtime/package-root/settings gates: PASS
compaction.reserveTokens: 165536
compaction.keepRecentTokens: 20000
```

The full suite includes real Pi no-model extension, reopen, Stage 3, tree/fork/clone and network bootstrap tests; operation ledger, trust, catalog faults, SIGKILL/SIGTERM, queue, 8500-entry history, PTY, replacement and service lifecycle tests also passed.

Final renderer benchmark:

```text
text delta:  0.947 CPU ms/update
tool args:   0.599 CPU ms/update
tool output: 0.531 CPU ms/update
```

The event-silent running PTY retained #165's stronger result: 650 ms produced zero synchronized render batches and zero bytes while a draft remained visible.

## Immutable deployment

Deployment receipt:

```text
release:       20260716T065650Z-d979cd4aa118
path:          /home/luziyi/release/alu-dock/releases/20260716T065650Z-d979cd4aa118
previous:      20260716T024459Z-389eaf02697e
MainPID:       3086136
hostEpoch:     5453bf3b-3ffc-4298-862a-f675c8082ada
previousEpoch: 460e60d9-6300-4e1d-bad9-282f575eb18f
```

The release directory was created from clean HEAD with lockfile production dependencies, `current` switched atomically, and the generated unit retained the absolute Node 22.21.0 path. The service is `active/running`, enabled and ready; hello PID equals `MainPID`, the epoch changed, `ExecMainStatus=0`, and the post-switch journal contains only the expected old-Host SIGTERM and new `host.ready` lifecycle.

Rollback point remains the complete immutable release:

```text
/home/luziyi/release/alu-dock/releases/20260716T024459Z-389eaf02697e
```

## Installed-resource smoke

The deployment's released DockClient created and stopped a real no-model Pi instance against the installed global/project resource set:

```text
commands: 40
resources: 21
diagnostics: 0
tools: 18
settings: 24
tree nodes: 3
canonical pairs: chain/chain-prompts, run/run-chain
```

Hello advertised the complete managed capability set including `queue.control.v1` and `session.tree.v1`. Tree revision matched generation 1. Closed projections contained no handler/function/component body, binary or data URI.

## Installed CLI evidence

The installed launcher, not checkout code, produced the human-only overview and nested pages. Through loopback SSH with a deliberately nonexistent socket, all of these exited 0 without daemon or systemd access:

```text
alu-dock --help
alu-dock help open
alu-dock service logs --help
alu-dock status --help
alu-dock create --help
```

The overview omitted internal commands; explicit internal help redirected to human workflow and DockClient/V2.

Installed `list` was verified over SSH at 80 and 43 columns with an active acceptance fixture first:

```json
[
  {"columns":80,"status":0,"activeFirst":true,"maxWidth":64,"ansi":false,"machineFields":false},
  {"columns":43,"status":0,"activeFirst":true,"maxWidth":43,"ansi":false,"machineFields":false}
]
```

## Installed TUI/SSH evidence

A temporary trusted project loaded two no-model extension commands and switched to a 466-entry persisted Pi fixture containing read/bash/edit/write calls. Reloads exercised generation rollover before attach. The installed launcher then ran through loopback `ssh -tt`.

Observed result:

```json
{
  "status":0,
  "postShellMarker":true,
  "toolSummaries":4,
  "activityRow80x24":7,
  "editorBottomRow80x24":22,
  "footerOne":"idle · openai-codex/gpt-5.6-sol · think xhigh · connected/acquired",
  "draftVisible":true,
  "stableRenderBatches":0,
  "stableOutputBytes":0,
  "slowNotice":true,
  "noRunResults":2,
  "genericHandledNoise":false,
  "oldestHistory":true,
  "mouseSequencePairs":3
}
```

Specific evidence:

- all four folded operation summaries appeared; edit payload details stayed folded;
- `Alt+O` expanded and re-folded the latest tool;
- wheel plus PageUp lazily reached `installed history 000`, and Ctrl+End returned to the live tail;
- activity remained above the composer while the two-row footer contained low-frequency state only;
- a retained draft produced zero timer-only output over 650 ms in the installed artifact;
- one confirm command and two notification commands completed with three `command.handled`, zero `run.started`, zero rejection and `lastRun=never`;
- the generic no-run lifecycle sentence never appeared;
- Alt+M/Esc and `/mouse`/Alt+M produced ordered 1000/1006 enable-disable pairs; final detach disabled tracking;
- detach exited 0 and reached the post-TUI shell marker.

The temporary instance was explicitly stopped, the fixture directory removed, and final managed state is:

```text
active=0
pending=0
MainPID=3086136
hostEpoch=5453bf3b-3ffc-4298-862a-f675c8082ada
```

No model call or tool side effect was executed.

## Deviations and remaining human gate

Loopback SSH and source PTY can validate escape sequences, synchronized frames, widths, event facts and cleanup, but they cannot prove Windows Terminal's pointer selection or Windows clipboard behavior. The installed no-model extension path also cannot create a true Pi streaming run with an editable composer; the full PTY suite provides the deterministic event-silent **running** proof, while the installed artifact independently produced zero idle timer output. A real provider run remains part of #158 after #164 if the user chooses to resume it.

Before #164 checklist item 8 can be completed, the user must run the installed candidate from Windows Terminal → PowerShell → SSH and verify:

1. Shift+drag selects immediately and `Ctrl+Shift+C` copies;
2. Alt+M makes ordinary drag select; Esc/Alt+M restores Dock wheel behavior;
3. typing during a real Agent run does not flash or lose characters;
4. live waiting/thinking/responding/tool activity stays above the composer;
5. folded tool rows are identifiable and Alt+O remains usable;
6. no generic `command.handled` sentence appears after safe no-model commands;
7. `alu-dock --help`, nested help and `alu-dock list` are understandable without repository docs;
8. Ctrl+D restores the shell and terminal mouse behavior.

Only the user may complete #164's final checklist item, move #164 to Done, and decide whether #158 resumes.
