# V0.1 composer stability validation

Date: 2026-07-16

Cards: #165 under the #164 human-acceptance blocker gate

Status: source slice complete; consolidated #164 immutable rollout remains deferred

## Observed failure

During #158 Windows Terminal → PowerShell → SSH dogfood, typing the next message while an Agent was waiting/thinking/responding produced a visible periodic flash in the composer/cursor area.

The V0.1 client had a cosmetic activity animation independent of Host events:

```text
setInterval(140 ms) → status.tickActivity() → TUI.requestRender()
```

The activity frame cycled through `· • ● •` while the underlying phase and label were unchanged.

## Root-cause evidence

A real PTY attached to a deliberately running but event-silent `DelayedRuntimeSession`. After typing `draft while agent runs`, the driver drained the input-triggered render and sampled the next 650 ms.

Before the fix:

```text
Host/runtime events during sample: 0
synchronized output batches:       5
terminal bytes:                    479
```

The measured rate matches the 140 ms timer. This reproduced the periodic repaint with `showHardwareCursor=false`, so hardware-cursor mode was not the root cause. Each batch existed only because the footer animation changed; the editor state itself had not changed.

The renderer was differential rather than full-screen, but it still had to move the terminal cursor to the changing status row, clear/repaint that row and restore the editor cursor position. Windows Terminal made that unnecessary periodic output perceptible around the composer.

## Fix

The cosmetic frame animation and timer were removed.

- `RunActivityState` now owns only the semantic `phase` and `label`.
- `DockStatusLine` selects one stable, non-color-dependent phase symbol.
- waiting/thinking/responding/tool/retry/compaction/queue/interaction transitions remain event-driven and render immediately when their typed Host event arrives.
- transcript streaming is not hidden, delayed or throttled.
- editor input still requests its own render.
- terminal progress remains a separately configured OSC signal; it is not used to repaint the TUI.

This also aligns the implementation with the frozen Night Console decision that a component animation system is outside V0.1.

## Automated evidence

```text
TypeScript: PASS
npm test: 229/229 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/import/settings boundaries: PASS
```

The regression PTY now records for the same 650 ms event-silent running state:

```text
synchronized output batches: 0
terminal bytes:              0
```

A second deterministic PTY interleaves 50 assistant text deltas at 10 ms with character-by-character composer input. A forced final resize/full frame confirms the exact draft `draft survives concurrent streaming` remains present; the `responding` phase is visible and the process detaches cleanly. This proves the fix did not obtain stability by suppressing streaming output or input.

The complete PTY matrix again passed dialogs, queue restore/abort, history/wheel, settings/session commands, tree/fork/clone, transport loss, resize and detach.

## Real SSH evidence

A temporary development Host used the same delayed running runtime with terminal progress disabled to isolate screen output. The current source client was attached through loopback `ssh -tt` at 80×24, typed `draft remains stable over ssh`, drained the input render and sampled 650 ms.

```text
status:                    0
stable synchronized batch: 0
stable terminal bytes:     0
draft visible:             yes
mouse 1000/1006 cleanup:   yes
post-TUI shell marker:     yes
```

The temporary Host stopped cleanly and was removed. The managed dogfood Host was not changed; its final state remained zero active instances and zero pending queue items.

## Preserved boundaries and deferrals

- No Host, Protocol V2, event, DTO, runtime, catalog or queue change.
- #163 still independently owns the final vertical location of live activity; moving a row is not used as evidence for this fix.
- Hardware-cursor and IME behavior continues to follow the existing setting. Removing timer-only renders benefits both modes without changing cursor semantics.
- Real Windows Terminal/PowerShell confirmation and installed immutable release evidence belong to #164's consolidated final gate.
