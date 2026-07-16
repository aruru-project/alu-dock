# V0.1 terminal selection validation

Date: 2026-07-16

Cards: #160 under the #164 human-acceptance blocker gate

Status: source slice complete; real Windows Terminal selection and consolidated immutable rollout remain deferred to #164

## Problem

#155 enabled xterm `1000 + 1006` mouse tracking so SGR/X10 wheel input could drive Dock's bounded history viewport. In Windows Terminal → PowerShell → SSH, that also sends ordinary mouse gestures to the application. Alu Dock consumes wheel events but does not implement pointer selection, so ordinary drag no longer creates a terminal selection.

Windows Terminal already provides `Shift+drag` as a mouse-reporting override and `Ctrl+Shift+C` for copy, but this path was hidden. A hidden workaround is not an adequate terminal interaction contract.

## Frozen contract

Default mode continues to enable paired xterm 1000/1006 reporting. This preserves #155's app-owned PageUp/PageDown/wheel history semantics.

Two explicit native-selection paths are now available:

1. `Shift+drag` selects immediately in the terminal while normal Dock wheel mode remains active.
2. `Alt+M` or `/mouse` enters **terminal selection mode**. Dock immediately disables 1006/1000 tracking, ordinary drag belongs to the terminal, and a composer-adjacent fixed hint shows:

```text
↖ terminal selection · drag select · Ctrl+Shift+C copy · Esc/Alt+M return
```

`Esc` or `Alt+M` returns to Dock wheel mode and re-enables 1000/1006. Esc exits selection mode before it can abort a running Agent. `/help` explains both Shift override and explicit mode.

While selection mode is active, PageUp/PageDown and other keyboard input still reach Dock. The terminal may apply its native wheel behavior because mouse reporting is deliberately off; returning to normal mode restores Dock's canonical app-owned wheel.

## Explicit non-goals

- No application-owned text-selection model.
- No clipboard read/write transport.
- No OSC 52 default behavior.
- No pointer coordinates on Protocol V2.
- No renderer fork or #148 Terminal Core implementation.

A future app-owned selection/OSC 52 action requires its own terminal/security compatibility matrix.

## Automated evidence

```text
TypeScript: PASS
npm test: 231/231 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/import/settings boundaries: PASS
```

Deterministic coverage verifies:

- selection mode is inactive and occupies zero rows by default;
- its hint is terminal-safe and bounded at 43 columns;
- `/mouse` appears in autocomplete;
- SGR/X10 wheel parsing is unchanged;
- default startup still enables 1000 then 1006;
- Alt+M disables 1006 then 1000;
- Esc re-enables 1000 then 1006 without aborting the run;
- `/mouse` enters the same mode and Alt+M returns;
- final detach disables tracking again.

The real PTY sequence is therefore:

```text
enable → disable → enable → disable → enable → disable
startup   Alt+M     Esc      /mouse    Alt+M     detach
```

The delayed runtime remained `active/running` and received zero abort calls.

## Real SSH evidence

A fresh no-model managed instance was attached through loopback `ssh -tt` using the source client at 80×24. Alt+M, Esc, `/mouse`, Alt+M and detach produced the same ordered mouse-mode sequence, rendered the fixed selection hint, exited with status 0 and reached the post-TUI shell marker. The temporary instance was explicitly stopped; final managed state was zero active instances and zero pending queue items.

## Remaining human gate

Programmatically writing escape sequences into a PTY cannot prove that a local terminal actually performs native pointer selection or copies to the Windows clipboard. #164's final Windows Terminal/PowerShell/SSH acceptance must manually verify:

- ordinary drag in normal mode is captured by Dock as expected;
- Shift+drag selects and `Ctrl+Shift+C` copies;
- Alt+M makes ordinary drag select;
- Esc/Alt+M restores Dock wheel behavior;
- multiline keyboard paste remains unchanged;
- detach and abnormal exit leave mouse reporting disabled.
