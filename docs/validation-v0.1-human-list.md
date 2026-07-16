# V0.1 human `alu-dock list` validation

Date: 2026-07-16

Cards: #167 under the #164 human-acceptance blocker gate

Status: source slice complete; consolidated immutable rollout and real Windows Terminal/PowerShell acceptance remain pending

## Problem

The default `alu-dock list` previously wrote one JSON line containing every complete closed instance snapshot. With many historical records it exposed operation IDs, Pi session paths, event cursors, metrics and extension state in an unscannable terminal line. The underlying closed projection was valid; the default human presentation was not.

## Frozen human projection

`alu-dock list` remains a read-only Protocol V2 catalog request, then renders bounded plain text. Each visible instance uses exactly two lines:

```text
◆ b0a92168 active/running g1 V0.1 Final Acceptance · pending 2
  openai-codex/gpt-5.6-sol · /home/luziyi/workshop/alu_dock
```

The first line contains:

- lifecycle symbol;
- six-character ID below 40 columns, otherwise eight characters;
- `lifecycle/execution`;
- runtime generation;
- terminal-safe bounded name;
- `pending N` and `reopenable` only when decision-relevant and width permits.

The second line contains bounded `provider/model` and cwd. Active running instances sort first, followed by other active instances, stopping instances, recoverable Host-loss/runtime-error records, other failed/lost records and stopped history; each group is most-recently-updated first.

The output never includes Pi session file/ID, creation operation, event cursor, full metrics, extension status or raw closed DTO JSON. It contains no ANSI. C0/C1 and bidi override/isolate controls are replaced before projection.

The renderer uses terminal columns when stdout is a TTY and 80 columns when piped. It supports grapheme-aware truncation and conservative wide-character/emoji width. Width is bounded to 20–160 columns. A catalog is capped at 100 visible records and explicitly reports omitted count; no public `--json` compatibility mode was added.

Empty state:

```text
No Alu Dock instances.
Start one: alu-dock new
```

## Machine-consumer migration

The only repository test that parsed CLI `list` JSON now calls typed `DockClient.list()` for machine assertions. It separately validates the public text output as text. Dogfood smoke, deployment probes and durable lifecycle tests already used DockClient/V2 directly.

No hidden process-level JSON list command was necessary. Existing internal commands remain for other cross-process boundaries, but new automation must not parse this human output.

## Automated evidence

```text
TypeScript: PASS
npm test: 245/245 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/settings boundaries: PASS
```

Coverage includes:

- actionable empty output;
- active/recoverable/stopped ordering;
- required identity/state/generation/model/cwd fields;
- conditional pending/reopen tags;
- explicit absence of operation/session/cursor/metrics/extension secrets;
- C0/C1, bidi, CJK, combining-mark and emoji behavior;
- 32, 43, 80 and 120-column bounds;
- a 150-record catalog capped at 100 records and 207 total lines;
- an independent Host subprocess where machine catalog assertions use DockClient and fresh CLI processes render empty and populated human lists.

## Real PTY and SSH evidence

The source CLI read the current managed catalog of 17 stopped development records at 80 and 43 columns, both locally in a PTY and through loopback `ssh -tt`:

```json
[
  {"transport":"pty","columns":80,"status":0,"instances":17,"maxWidth":64,"ansi":false,"machineFields":false,"invalidLines":0},
  {"transport":"pty","columns":43,"status":0,"instances":17,"maxWidth":43,"ansi":false,"machineFields":false,"invalidLines":0},
  {"transport":"ssh","columns":80,"status":0,"instances":17,"maxWidth":64,"ansi":false,"machineFields":false,"invalidLines":0},
  {"transport":"ssh","columns":43,"status":0,"instances":17,"maxWidth":43,"ansi":false,"machineFields":false,"invalidLines":0}
]
```

A SHA-256 of the complete typed catalog before and after all four invocations was identical:

```text
576a7b4282b979679cb15308fa36d793246cbe43bc6008eccaa5cba5338430a3
active=0 · pending=0
```

This proves the list path did not mutate catalog/runtime state. No temporary managed instance or service restart was needed.

## Remaining human gate

#164's final installed release must be checked in real Windows Terminal → PowerShell → SSH for:

- visual scanning at 80 columns;
- ordinary copy behavior under #160's terminal-selection contract;
- meaningful ordering when active and recoverable instances exist;
- empty state on a clean temporary Host fixture;
- consistency between list IDs and `open/attach/status/stop` help.

The Agent may complete this source card, but only the user may accept and close #164.
