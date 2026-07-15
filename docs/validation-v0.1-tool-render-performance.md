# V0.1 Tool output render performance validation

Date: 2026-07-16  
Card: #157  
Baseline: Stage 6 `e6f5558` / managed release `20260715T153911Z-4fefab9e2ba4`

## Scope

真人 dogfood observed that ordinary thinking/text streaming did not show the same CPU spike, while rendering even one tool's state/output could briefly drive the Dock CLI near one logical core. This slice removes the algorithmic repeated work behind that spike. It does not promise an arbitrarily low CPU percentage and does not treat legitimate Markdown, diff, streaming or tool work as a defect.

No Host lifecycle, Protocol V2, catalog, runtime, queue, session tree or deployment contract changed.

## Root cause

`DockConversation` held one whole-conversation render cache. Every `tool.started`, `tool.args_updated`, `tool.output_updated` or `tool.completed` update incremented the global revision. The next frame then rebuilt every loaded entry, including constructing and rendering Markdown for up to 200 unchanged assistant/thinking entries, before the fixed viewport selected visible rows.

Tool events arrive more densely than typical provider text deltas, so this `tool update × complete loaded history` pattern could repeatedly consume nearly the full 16 ms minimum `pi-tui` frame interval. Formatting the tool payload itself was not the dominant cost.

## Change

- Cache rendered lines per conversation entry by content width, entry revision and tool expansion state.
- Invalidate only the changed entry while still rebuilding the bounded aggregate line index.
- Render a collapsed tool title from structured `toolName/toolState` instead of splitting the complete args/output text.
- Treat identical projected tool args/output as no-ops so they do not increment conversation revisions.
- Keep `invalidate()` authoritative by clearing both aggregate and per-entry caches.
- Add `npm run bench:tui`, a deterministic long-history text/tool render benchmark.

No timer-based visual coalescing was added. The structural fix already removed the N+1-like work, so adding delayed paint semantics would be unjustified without further real evidence.

## Deterministic evidence

Fixture: 200-entry bounded conversation, 220 columns, 120 consecutive updates. CPU milliseconds per `apply + render` frame:

| Workload | Before | After | Reduction |
|---|---:|---:|---:|
| text delta | 16.411 ms | 1.177 ms | 92.8% |
| tool args | 14.775 ms | 0.906 ms | 93.9% |
| tool output | 14.860 ms | 0.808 ms | 94.6% |

The pre-change apply-only tool cost was approximately 0.3–0.4 ms/update, confirming that repeated history rendering—not payload projection—dominated.

Focused validation:

```text
TypeScript check: PASS
TUI conversation/UX tests: 20/20 PASS
Duplicate tool args/output revision regression: PASS
Benchmark after clean build: PASS
```

Complete repository validation:

```text
npm test: 209/209 PASS
npm audit --audit-level=high: 0 vulnerabilities
git diff --check: PASS
.pi/settings.json unchanged: PASS
package-root coding-agent import gate: PASS
TUI runtime/InteractiveMode import gate: PASS
```

The full suite includes real PTY fixed-screen resize, scroll lock and collapsed/expanded tool behavior. No model/provider call was needed for this performance slice.

## Remaining real-world gate

A managed candidate release must still be exercised through SSH with single- and multi-tool output while observing the CLI process. The acceptance criterion is the absence of the previous repeated-history render storm, not a fixed CPU ceiling. Normal sustained CPU use under heavy Pi work remains acceptable.

## Risks and deferrals

- The aggregate conversation still walks cached entries to compose lines; visible-window virtualization remains #155/#148 work. Expensive Markdown parsing is no longer repeated for unchanged entries.
- Each of at most 200 entries retains one width-specific line cache. Resize replaces that cache on the next render; memory remains bounded by the existing conversation cap.
- Host-side time coalescing, renderer replacement and a custom frame scheduler are explicitly deferred unless managed SSH evidence shows a residual problem.
