# Alu Dock Engineering Guide

This file defines the project-local development contract for humans and coding agents. Read it together with `docs/v0.1-plan.md`, `docs/v0.1-capability-matrix.md`, and `docs/control-protocol-v2.md` before changing behavior.

## Product boundary

Alu Dock is a single-machine, single-Unix-user, SSH-headless Pi development terminal. It is not a public multi-user platform and does not attempt unlimited parity with the stock Pi TUI.

Until 1.0 this is greenfield software: replace the current contract directly. Do not add compatibility layers, migrations, dual protocol stacks, or legacy aliases unless the user explicitly requests them.

Do not modify Pi, `alu-daemon`, Rails WebConsole, Redis bridge, Alubot, or package caches from this repository.

## Architecture and dependency direction

Dependencies flow inward through closed ports and DTOs:

```text
cli / interactive composition
        ↓
control Host + request services       TUI client
        ↓                                ↓
ManagedInstance state machine ← closed instance DTOs/events
        ↓
RuntimeSession port
        ↓
Pi public-API adapters
```

### Module ownership

- `src/core/instance-dto.ts`: closed instance snapshots, events, cursors, history and receipts. No Pi runtime objects.
- `src/core/config-projection.ts`: the exhaustive settings/tools/resources metadata contract.
- `src/core/runtime-session.ts`: runtime port and typed runtime errors. It must not import concrete Pi internals.
- `src/core/session-tree.ts`: closed tree validation/projection, terminal/binary safety and generation-bound revision/pagination. It must not own runtime transitions.
- `src/core/managed-instance.ts`: lifecycle/admission/transaction facade and serialized state ownership. Keep protocol parsing and visual UI out.
- `src/pi/*`: the only production layer allowed to hold Pi SDK objects. Use only exports from the `@earendil-works/pi-coding-agent` package root.
- `src/control/protocol.ts`: wire schemas and fail-closed parsers. Capability-specific execution belongs in a service such as `session-command-service.ts`, not in the socket loop.
- `src/control/durable-catalog-store.ts` and `catalog-reconcile.ts`: strict schema-1 persistence, atomic file replacement and no-runtime startup normalization. They never construct Pi objects.
- `src/control/dock-host.ts`: socket-first connection lifecycle, hello, dispatch composition and streaming. Do not grow capability business logic inline.
- `src/control/dock-client.ts`: typed request transport and response validation; it never owns runtime state or retries mutations.
- `src/tui/*`: thin closed-DTO client. Pure projection and setting logic belongs in focused modules; tree pagination/filter/command parsing belongs in `session-tree.ts`, while `dock-tui.ts` only composes workflows rather than becoming a second runtime.
- `src/deployment/user-service.ts`: explicit generated-unit lifecycle/readiness. Ordinary open/new/attach paths must never import it to auto-start a Host.
- `src/cli.ts` and `src/interactive.ts`: process/command composition only.

A feature should have one clear owning module. Do not create one file per setting or per trivial command; group behavior by cohesive capability. Conversely, when an entry/composition file starts owning validation, state transitions, persistence and rendering at once, extract those responsibilities before adding another feature.

## Non-negotiable invariants

1. The Host is the only owner of `AgentSessionRuntime`, extensions, tools, admission, run Promises and side effects.
2. Dock `instanceId` is distinct from Pi `sessionId/sessionFile`.
3. Wire major is `2`; every advertised request/result/event is a bounded closed schema.
4. Advertise a capability only after its implementation and gate pass.
5. Event identity is `(hostEpoch, instanceId, runtimeGeneration, sequence)`. Replacement starts the next generation at `session.replaced`, sequence 1.
6. Mutations are never automatically retried. Ambiguous completion returns `effect_unknown` with the caller operation ID.
7. Same-Host dedup uses the operation ledger; do not claim cross-Host exactly-once behavior.
8. Catalog commit is an observable boundary. Do not publish success, state or events before the required commit.
9. Project trust must resolve before runtime/network/project resources, extension hooks, teardown or catalog mutation for the target.
10. Host loss never resumes or replays prompts, queues, Promises or tool effects. Explicit reopen is a fresh runtime transaction with generation +1.
11. Durable catalog stores identity/session metadata and conservative intents only—never prompt/tool payload, queue text, interaction content, event logs or Promises.
12. Managed startup binds and validates its private socket before loading/reconciling catalog; corrupt evidence is preserved and no prior runtime is constructed.
13. Do not send runtime objects, functions, handlers, component instances, binary data, image bytes, data URIs or raw base64 over the control protocol.
14. Terminal-facing values must be sanitized for C0/C1 control characters.
15. Tree navigation stays inside the current Dock instance and Pi session file. A derivation preserves its source and creates a sibling managed instance: current-leaf and before-user-message are modes of one product-level fork, not separate clone or in-place replacement commands. Generation rollover is not a substitute for a new instance when logical task identity changes. Branch-summary cancellation must use the public `abortBranchSummary()` path rather than assuming agent abort covers it.
16. A closed Host/protocol projection is not authorization to render a conversation message. Classify every human-facing fact by lifetime and actionability as durable conversation, transient status/activity, interaction, or explicit diagnostics. Expected internal bounds, replay/cursor state and operation bookkeeping stay quiet unless they cause concrete user impact; a user-facing warning must state that impact and an available action.
17. Human CLI output must form a closed workflow: every recommended command must accept an identifier visibly available in the same output, ambiguous names/prefixes fail closed through a chooser or actionable human error, and lifecycle-inapplicable actions are not advertised. Raw machine JSON errors belong only to an explicit machine surface.

## Pi and settings rules

- Runtime SDK baseline is `@earendil-works/pi-coding-agent@0.80.6`; V0.1 pins `@earendil-works/pi-tui@0.80.6` only as a temporary client rendering toolkit.
- Product UX state, viewport/search/activity/tool-fold reducers and key actions belong to Alu Dock. Do not expose `pi-tui` types through Host, protocol, DTO or domain ports.
- Private subpath imports are forbidden in production and tests. V0.2 card #148 removes Alu Dock's direct `pi-tui` dependency in one renderer switch rather than maintaining dual renderers; its frozen API, provenance and cutover contract is `docs/v0.2-terminal-core-design.md`.
- Settings use Pi's native snapshot, lock, field merge and last-writer-wins semantics.
- A successful setting mutation is: public setter → `await flush()` → `drainErrors()`.
- Do not edit Pi settings JSON directly to simulate a missing setter.
- `compaction.reserveTokens` and `compaction.keepRecentTokens` are read-only until Pi exposes public setters.
- This repository intentionally has no `.pi/settings.json`; the former repository compaction guard was retired in favor of the user-level `sol-mid-turn-guard` extension. Do not recreate project settings or copy the old reserve/keep values back into the repository.
- `pi install`, `pi config`, and `pi login` remain owned by the original Pi CLI.

## Development workflow

Work in cohesive slices rather than one test cycle per field:

1. Confirm the card, frozen stage scope and capability boundary.
2. Define or update the closed DTO/port first.
3. Implement the complete capability slice in its owning modules.
4. During implementation use cheap TypeScript or narrow tests only when they materially shorten feedback.
5. Once the slice is complete, run one consolidated build/test/real-Pi/PTY gate.
6. Enter SSH dogfooding early. Add regression tests for observed failures instead of indefinitely expanding speculative simulation.

Automated tests protect deterministic invariants; they do not replace long-session, real-provider/network, multi-hour terminal and human workflow testing.

Before asking the user to judge a human-facing CLI/TUI surface, the implementation owner must inspect the actual output at representative 80×24 and 120×40 sizes. Self-review information hierarchy, scanability, syntax-preserving wrapping and emphasis: group related actions, keep low-frequency modes subordinate, and do not hand obviously crowded or mechanically wrapped output to the user as a clarification question.

Keep one writer for a working tree. Reviewers and analysis agents should be read-only unless an isolated worktree was intentionally created.

## Testing layers

- Pure DTO/parser/reducer changes: focused unit tests.
- Host mutation changes: operation ledger, trust, catalog boundary and ambiguity integration tests.
- Pi adapter changes: public-API fixture plus a no-model-call real Pi smoke where possible.
- TUI changes: deterministic projection tests plus real PTY for command/focus/resize/detach behavior.
- Replacement changes: generation rollover, history replacement and extension lifecycle/rebind assertions.
- Startup/resource changes: synthetic fixtures plus a full DockClient command/resources/tools/settings read against the actual installed global/project resource set. A direct runtime call is not sufficient evidence for client startup.
- Durable lifecycle changes: subprocess SIGKILL/SIGTERM/create-race, atomic write-phase faults, corrupt evidence retention, real Pi no-model reopen and a uniquely named temporary `systemd --user` unit.

Consolidated gate:

```bash
npm run check -- --pretty false
npm test
npm audit --audit-level=high
git diff --check
```

Also verify:

- no `@earendil-works/pi-coding-agent/*` private imports;
- no `AgentSession`/`createAgentSession` imports in `src/tui`;
- package-root exports remain available;
- the intentionally removed repository `.pi/settings.json` has not been recreated;

`npm run build` must remain a clean build that removes `dist` first.

## Task and documentation discipline

- Card #142 is the V0.1 engineering state entry until it closes.
- Update the card when a stage starts/completes, a blocker appears, or a gate deviates from plan. Record discovered separate work as a separately scheduled card; assignment is not authorization to start it.
- Stable architecture belongs in docs/code, not only comments on the board.
- Each completed stage gets a validation document containing scope, real evidence, deviations, remaining risks and explicit deferrals.
- Keep V0 history frozen; do not rewrite old validation to make current work appear retroactive.
- Use focused commits with an honest message after the relevant gate passes.

## Dogfood release discipline

Follow `docs/dogfood-deployment.md` for managed releases. Stage completion and deployment are separate facts:

- commit and pass the complete gate before creating a release;
- publish only a clean committed HEAD to an immutable directory under `/home/luziyi/release/alu-dock/releases`;
- atomically switch `current`; never patch the live release;
- default to refusing a service restart while an active instance exists;
- verify systemd `MainPID`, V2 hello/hostEpoch, journal and a real installed-resource startup smoke after switching;
- rollback the complete release on failure and record both code-gate and deploy-gate evidence on #142.

`npm run cli` is a development entry. Once Stage 3.6 is installed, `alu-dock` is the only human dogfood entry and must never silently fall back to an untracked detached Host.

## Current staged boundary

Stage 6 remains the functional managed baseline: `session.tree.v1` plus Stage 5 `catalog.v1`, `service.managed.v1`, `session.reopen`, socket-first reconcile, no-replay Host loss, explicit reopen and generated-unit service CLI. The currently deployed release is `20260717T021624Z-b235be25a932`: it preserves the user-accepted #164 and #177 baselines, adds #178 closed `CommandReceipt.kind` semantics for running-parent extension commands, and adds #180 operation-attributed/preemptible manual compaction control with long-mutation client waits. Its 275-test consolidated gate, immutable rollout, real Pi compact/reload fixture, rollback-forward, MainPID/hello/resource checks, managed A/B + B-reload + running-parent `/rm-confirm` smoke, managed real-Pi compaction-abort smoke and journal gate passed. The rollout was synchronized after the user-level `sol-mid-turn-guard` v2 runtime-keyed controller update and session reload; four managed A/B `/sol-guard-status` commands remained active across B reload. Exact registered commands use the public `AgentSession.extensionRunner` authority, return `kind=extension_command,delivery=prompt,queued=false`, never enter pending/restoration, preserve a running parent operation/activity, and fence old-generation completion. Client viewport/search/tool-fold/tree/queue-tray/history-window/theme state remains independent from Host interaction state; both use only public package-root APIs.

Card #164 was completed by the user on 2026-07-16. Card #158 has resumed the final human gate, and only the user may decide when it or #142 closes. #176 independently owns the installed `pi-subagents` multi-runtime completion-isolation fork and does not enter Dock source; #174 owns the outer `list`/`attach` human workflow and bash-multiline findings, while #185 and #186 own the rejected tree projection and Pi-style in-place derivation semantics. Preserve these final contracts: ordinary drag belongs to the terminal by default; Alt+M or `/mouse` alone enables 1000/1006 and app-owned wheel; queued text is prepended without overwriting a concurrent draft and `inFlight`/failure/`effect_unknown` never claims restoration or proceeds to abort; registered extension commands are classified before Queue while unknown slash/skill/template input keeps Pi-native semantics; forget/prune remove only Dock records after atomic Host commits and never Pi session files; unsupported extension visual UI is bounded/de-duplicated while the public `tool_result` hook promotes nonzero subagent child exits to a real `isError` for model/history/TUI; active animation writes only the fixed activity row and idle has no timer. The #178/#180 restart was explicitly authorized after `alu-dock list` proved no active instance existed; do not generalize that authorization to a future release. Preserve Stage 6 closed tree/public-Pi/lifecycle safety evidence, but do not treat its generic tree picker or in-place fork/clone product semantics as accepted: #185/#186 supersede those human contracts without weakening Stage 5 catalog/reopen/service, Stage 4 interaction/generation/lease, #154 `message_start`/no-durable-queue, #155 entry/row-anchor/paired-mouse-mode or #156 no-full-screen-background/local-surface invariants.

Alu Dock has no Agent self-loop through its own CLI. Human `alu-dock` workflow, typed DockClient/Protocol V2 machine control, and Pi-registered model tools are separate surfaces. V0 test probes must not occupy the public human help merely because release tests need them; scripts prefer DockClient, and any future model-facing Dock diagnostic must be an explicitly registered closed/read-only tool guided by skill/docs. Extension component factories, `ctx.ui.custom()`, binary/image transport and renderer replacement remain out of scope; renderer work stays on the independent #148 P2 line and is not part of this V0.1 closeout or #182.
