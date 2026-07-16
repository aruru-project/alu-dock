# V0.1 Long-history pagination and wheel validation

Date: 2026-07-16

Card: #155 (blocks #142)

Status: complete and deployed

## Scope

This slice makes the complete current Pi branch reachable from the fixed-composer TUI without turning terminal-native scrollback into conversation state and without loading an unbounded branch into the client.

Implemented surface:

- reverse lazy loading through the existing closed `session.history(beforeEntryId, limit)` read;
- one in-flight earlier-page request, generation-bound stale-response rejection, duplicate-ID filtering, cursor-progress termination, retryable errors, and latest-page recovery after a stale cursor;
- a client-only target window of 1,000 raw history entries / 16,000,000 projected text characters;
- newer-edge eviction while preserving the page just fetched, the current visual anchor, and the latest 200-entry tail;
- an explicit bounded-memory gap marker and `Ctrl+End` collapse back to the pinned latest page;
- stable history-entry/piece/row anchors across prepend, eviction, live output, width/height resize, and changing fixed chrome;
- PageUp/PageDown and SGR/X10 wheel input on the same `HistoryViewport` reducer;
- paired xterm mouse tracking (`1000` + `1006`) enabled only for the TUI lifetime and disabled before normal terminal exit.

No Host ownership, catalog, mutation, replacement, queue, or Protocol V2 schema changed. The Host remains the history owner; the client continues to consume bounded pages under the already-advertised `tui.projection.v1` capability.

## Paging and memory contract

1. Attach starts from the newest bounded 200-entry page and derives its first-entry reverse cursor only when `historyTruncated=true`.
2. Reaching the currently loaded top starts at most one read for the 200 entries immediately before that cursor. Accepted PageUp/wheel input while the read is pending cannot create duplicate reads.
3. A page must move the before-entry cursor. Empty/duplicate/revision races cannot create an infinite request loop; errors remain visible at the top and PageUp can retry. `Ctrl+End` can rebase from a stale cursor to a fresh latest page.
4. Prepend does not count as unseen model output. The first visible non-boundary entry and its row within that entry stay at the same screen row; if a resize makes that row impossible, it is clamped upward rather than lost.
5. Once the target bound is exceeded, eviction proceeds from the newer edge of the traversed historical window. The newly fetched page and its old-page anchor are protected for that turn, while the original latest 200 entries remain pinned. This makes every older page observable while preserving an immediate live tail.
6. The retained ranges are separated by an explicit gap marker. PageDown can continue to the pinned latest range; `Ctrl+End` discards the older range and restores the normal 200-entry latest baseline. PageUp from that baseline can fetch the intervening pages again.
7. Live event projection remains separately bounded to 200 entries. History rebuild never puts persisted tool calls into the active live-tool map.

The 16M text target can be exceeded only by the current maximum-size page plus its protected anchor/latest page. This is a bounded safety allowance: freshly fetched content is never silently discarded merely to satisfy a target counter.

## Automated evidence

Consolidated gate from commit `4a39989812bef49a67d3c2f146c9ee4491d417b5`:

```text
TypeScript check: PASS
npm test: 224/224 PASS
npm audit --audit-level=high: 0 vulnerabilities
git diff --check: PASS
package-root/private-import/TUI-runtime-import gates: PASS
.pi/settings.json unchanged: PASS
```

Deterministic coverage includes:

- an 8,500-entry branch traversed in 42 reverse pages; all 8,500 IDs became observable while retained state never exceeded 1,000 entries;
- the first entry, pinned latest entries 8,300–8,499, gap boundary, and `Ctrl+End` latest-page reset;
- in-flight deduplication, stale-generation completion, duplicate pages, non-advancing cursor errors, and retries;
- entry/row anchoring across prepend plus simultaneous live output, newer-edge eviction, width resize, height resize, and chrome-row changes;
- existing stream lock/unseen-output, tool-fold reveal, replacement/navigation reset, and terminal-safe rendering regressions;
- SGR wheel, modifier bits, legacy X10 wheel, and non-wheel rejection;
- a 450-entry real PTY at 80×24 then 43×18 reaching `historical line 0` beyond the attach-time recent 200 entries, with wheel/PageUp/PageDown on the internal viewport;
- PTY observation of paired `?1000h/?1006h` enable and `?1006l/?1000l` disable sequences.

The retained-history version of `npm run bench:tui` remains well below one frame for the 200-entry live baseline (120 updates): text 1.675 CPU ms/update, tool args 1.290 ms/update, tool output 1.097 ms/update. Per-entry rendering caches from #157 remain authoritative; pagination rebuild work occurs only when a page changes.

## Real Pi and SSH evidence

A copy of the live long Pi JSONL was used so Dock never opened the same file being written by stock Pi.

No-model public-Pi projection smoke:

- copied source branch: 9,787 projected entries;
- reverse pages: 48;
- all 9,787 entry IDs reached;
- final retained entries: 1,000 with an explicit newer gap;
- runtime remained `active/idle`, `lastRun=never`;
- the copied runtime was disposed and the copy removed.

Installed-release SSH smoke used a second temporary copy through the managed Host:

- managed instance `80f4abb1-3212-47ae-8503-7b4c20f24a91`, generation 2;
- real Pi metrics: 9,771 messages, including 5,185 tool calls and 5,183 tool results;
- loopback `ssh -tt` ran the published `alu-dock attach` client with a large 120×1000 PTY solely to make exhaustive traversal practical;
- four real SGR wheel-up events were sent before the paged traversal; the run observed scroll lock, then 227 PageUp actions crossed every reverse page and reached the oldest user marker `查看一下card #137`;
- wheel down, PageDown, Ctrl+End, and Ctrl+D completed normally;
- process exit status 0, mouse enable/disable sequences both observed, and the remote shell printed `SSH_SHELL_AFTER_HISTORY` after detach;
- the temporary instance was explicitly stopped, its copied session removed, no active instance remained, and the managed service stayed ready.

The smaller deterministic PTY is the ordinary-terminal geometry check; the tall SSH PTY is an exhaustive real-session acceleration, not a claimed normal screen size.

## Managed rollout evidence

Immutable release:

- release: `20260716T014143Z-4a39989812be`;
- previous rollback point: `20260715T185801Z-3c9ca5e2c487`;
- systemd `MainPID=2974876`, `ActiveState=active`, `SubState=running`;
- host epoch: `ffe9cd0a-3a7b-401a-9c51-78ad494f2e66` (changed from `9e6c66be-a53d-48c7-af31-9125b0440043`);
- full managed capability hello remained intact, including `queue.control.v1`, `session.tree.v1`, and `tui.projection.v1`;
- published-resource smoke: PASS — 40 commands, 21 resources, 0 diagnostics, 18 tools, 24 settings, 3 tree nodes, plus canonical `chain/chain-prompts` and `run/run-chain` ordering;
- journal records clean SIGTERM of the prior Host and one `host.ready` for PID 2974876; no rollback was required.

## Deviations and remaining risks

- The control protocol remains reverse-only. After bounded newer-edge eviction, PageDown crosses an explicit gap to the pinned live tail rather than pretending evicted middle pages are still resident. `Ctrl+End` resets to the latest page; PageUp can fetch the middle again.
- Pi/ManagedInstance already materialize the current branch as runtime state. This slice bounds client wire pages and retained TUI projection; it does not redesign Pi's SessionManager.
- V0.1 still composes rendered rows for the retained window. Full row virtualization and renderer replacement remain the one-time V0.2 #148 Terminal Core cutover.
- Mouse handling intentionally covers wheel input, not coordinate click/drag UI. Terminals that support SGR use `1006`; older xterm-compatible terminals can fall back to X10.
- SIGKILL cannot emit terminal reset bytes; normal detach, signal handling, and controlled exit do. A terminal emulator also resets private modes when its PTY closes.
- This slice does not perform #158's final settings/slash-command human matrix or #156's visual-language decision.
