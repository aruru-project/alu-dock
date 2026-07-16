# V0.1 collapsed tool summary validation

Date: 2026-07-16

Cards: #161 under the #164 human-acceptance blocker gate

Status: source slice complete; consolidated #164 immutable rollout remains deferred

## Scope

This slice makes folded tool rows useful for real task decisions without reverting Night Console to default-expanded tool payloads.

The client now derives one bounded, terminal-safe identity summary from the closed tool arguments it already received:

- `read`: path plus line range when `offset`/`limit` are available;
- `bash`: first non-empty command line plus the count of additional lines;
- `edit`: target path plus edit count;
- `write`: target path plus content line count;
- generic/extension tools: only an allowlisted path/URL/command/action/card/query/target/agent identity fallback or bounded collection count.

Long absolute paths retain their useful tail, for example `…/src/tui/conversation.ts`, so consecutive calls remain distinguishable before the common home/project prefix consumes a narrow row. Arbitrary `content`, `text`, `message`, prompt or task payloads are never promoted into the folded header. Full already-bounded arguments and results remain behind `Alt+O`.

Running, done and failed lifecycle symbols/colors remain unchanged. The summary appears for both live events and persisted session history and updates with `tool.args_updated` without changing the Host or Protocol V2.

## Preserved boundaries

- No Host, runtime, event, DTO, capability, catalog or wire change.
- No runtime object, handler, binary, base64 or unbounded payload reaches the renderer.
- Default tool-fold behavior and `Alt+O`/`Ctrl+O` behavior are unchanged.
- #157 per-entry render caching remains authoritative. Duplicate args/output still reuse cached rows; a changed summary invalidates only its tool entry.
- Changes beyond the 4,000-character expanded-detail preview still refresh the header when an identity field changes.
- #154 queue, #155 history/anchor/wheel and #156 Night Console layout are unchanged.

## Automated evidence

```text
TypeScript: PASS
npm test: 227/227 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/import/settings boundaries: PASS
```

Deterministic tests cover:

- live and persisted-history read summaries;
- read ranges and useful absolute-path tails;
- multiline bash preview;
- edit/write counts;
- generic `alu_kanban` action/card fallback without promoting arbitrary content;
- terminal-control sanitization;
- running/done/failed lifecycle retention;
- 20/43/80-column bounds;
- args updates whose detail JSON shares the same truncated prefix;
- expanded failure details remaining folded until requested.

Final component benchmark over 200 persisted entries and 120 updates at width 220:

```text
text delta: 0.991 CPU ms/update
tool args:  0.638 CPU ms/update
tool output: 0.493 CPU ms/update
```

These remain in the same sub-millisecond range as the #156 baseline (`0.990 / 0.590 / 0.463`). The bounded summary adds approximately `0.048 ms` to a changing tool-args update in this run and does not reintroduce the #157 full-history render storm.

## Real terminal evidence

A no-model persisted Pi fixture containing read, multiline bash, two-edit and three-line write calls was switched into a disposable managed instance.

A real 120×40 local PTY verified all four folded summaries, kept `oldText`/`newText` details hidden, preserved paired xterm 1000/1006 mouse cleanup and exited with status 0.

The same source build was then attached through loopback `ssh -tt` at 120×40. The synchronized frame showed:

```text
✓ read done · src/tui/conversation.ts · lines 10–14 · Alt+O detail
✓ bash done · npm run check ↵ +1 line · Alt+O detail
✓ edit done · src/tui/theme.ts · 2 edits · Alt+O detail
✓ write done · docs/example.md · 3 lines · Alt+O detail
```

SSH detach returned status 0, restored mouse mode and reached the post-TUI shell marker. Both temporary instances were explicitly stopped, fixtures removed, and final managed state was zero active instances and zero pending queue items.

## Deferred release evidence

#164 deliberately batches #161–#167 before one consolidated gate, immutable release and real Windows Terminal/PowerShell/SSH acceptance. Therefore this source slice does not publish or claim a new dogfood release. Installed-launcher evidence and user acceptance belong to #164's final gate.
