# V0.1 fixed activity-slot validation

Date: 2026-07-16

Cards: #163 under the #164 human-acceptance blocker gate

Status: source slice complete; consolidated immutable rollout remains deferred to #164

## Problem

Night Console's first footer row mixed high-frequency run phases (`waiting`, `thinking`, `responding`, tool, retry and compaction) with low-frequency execution state, model configuration, connection/controller and extension status. The changing live phase sat below the composer and far from the transcript it described, while the footer attracted unnecessary visual attention.

The configured thinking level (`think xhigh`) is model configuration; live `thinking` is a current stream phase. They must remain distinct.

## Frozen layout

The terminal's vertical order is now:

1. product header when height permits;
2. app-owned transcript/history viewport;
3. one always-present activity row;
4. optional terminal-selection hint;
5. optional pending queue tray;
6. multiline composer;
7. two-row low-frequency status dock.

The activity row is rendered next to the live transcript/composer and always consumes exactly one row. `ready`, submitting, waiting, thinking, responding, tool, retry, compaction, queue, interaction, abort, error and disconnected states replace one another in that row. Local operation feedback such as loading settings or restoring a queue uses the same single activity surface rather than creating another transient channel.

The footer no longer renders the activity label. Its first row retains lifecycle/execution, pending count, model, configured thinking, connection/controller and extension status. Its second row retains name, cwd, Dock/Pi identity, metrics and compaction configuration.

This is client-only projection. Host events, Protocol V2, the `RunActivity` reducer and terminal progress facts are unchanged.

## Stable-layout and safety boundaries

- The activity component has no timer or animation state; #165's event-driven, zero timer-only-output contract remains intact.
- A phase change does not change chrome row count. Locked history keeps the same entry/row anchor, viewport offset and visible-row count.
- Pending queue text remains below activity and above composer; #154 consumption/dequeue behavior is unchanged.
- The selection hint remains between activity and pending/editor; #160 tracking behavior is unchanged.
- The composer remains immediately above the two-row status dock and is never moved into terminal-native scrollback.
- Tool projection/cache, history pagination, overlays, resize and Host/runtime ownership are unchanged.

## Automated evidence

```text
TypeScript: PASS
npm test: 235/235 PASS
npm audit --audit-level=high: 0 vulnerabilities
diff/settings boundaries: PASS
```

Deterministic component/layout coverage verifies:

- activity is one terminal-safe bounded row at 43, 80 and 120 columns;
- a locked 43×18 history viewport keeps an identical entry/row anchor and viewport snapshot when `ready` changes to `responding`;
- the rendered order is history → activity → composer → footer;
- the two-row footer contains execution/configuration but not `waiting` or `streaming`.

Real PTY coverage verifies both an event-silent waiting runtime and 50 concurrent assistant deltas while typing. At 43/44×18, `waiting for model` and `responding` appear above the editor; the editor bottom border remains row 16 and the two footer rows remain 17–18. The footer contains `running`, not the live phase. The typed draft survives, and the stable waiting sample remains zero synchronized repaint batches/zero bytes.

## Real SSH evidence

A source client attached through loopback `ssh -tt` to a temporary source Host with a deterministic in-flight runtime. Forced full redraws produced:

```json
[
  {"size":"120x40","rows":40,"activityRow":35,"editorBottomRow":38,"footerOne":"running · no model · connected/acquired","valid":true},
  {"size":"80x24","rows":24,"activityRow":19,"editorBottomRow":22,"footerOne":"running · no model · connected/acquired","valid":true},
  {"size":"43x18","rows":18,"activityRow":13,"editorBottomRow":16,"footerOne":"running · no model · connected/acquired","valid":true}
]
```

All sizes retained exactly the requested row count, put `waiting for model` above the composer, omitted it from the footer and preserved the two-row footer. Detach exited 0, reached the post-TUI shell marker and left the runtime active/running; the temporary instance was then explicitly stopped and its Host/socket removed.

## Remaining human gate

#164's consolidated Windows Terminal/PowerShell/SSH acceptance must assess the actual visual hierarchy during a real provider run, including thinking, tool and retry transitions. It must also reconfirm #165 composer stability; moving the activity row is not considered evidence for the independent flicker fix.
