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
15. Command scope determines identity semantics. In the attached Pi Session Work TUI, tree stays in the same file while session new/resume/fork/clone may replace the current instance's Pi session and roll generation, preserving the previous file. Dock Hub new/resume/attach/duplicate actions operate on managed instances and never silently replace an unrelated source instance. Branch-summary cancellation must use the public `abortBranchSummary()` path rather than assuming agent abort covers it.
16. A closed Host/protocol projection is not authorization to render a conversation message. Classify every human-facing fact by lifetime and actionability as durable conversation, transient status/activity, interaction, or explicit diagnostics. Expected internal bounds, replay/cursor state and operation bookkeeping stay quiet unless they cause concrete user impact; a user-facing warning must state that impact and an available action.
17. Human CLI output must form a closed workflow: every recommended command must accept an identifier visibly available in the same output, ambiguous names/prefixes fail closed through a chooser or actionable human error, and lifecycle-inapplicable actions are not advertised. Raw machine JSON errors belong only to an explicit machine surface.
18. Bare `alu-dock` enters a non-owning Dock Hub scoped by the current `pwd`; it does not auto-create or auto-attach a Pi runtime. Explicit outer `alu-dock new` and `alu-dock attach TARGET` bypass the Hub into work. The Hub's primary objects are Dock instances; persisted Pi sessions appear only through a distinct resume/adopt inventory.

## Pi and settings rules

- Runtime SDK baseline is `@earendil-works/pi-coding-agent@0.80.6`; V0.1 pins `@earendil-works/pi-tui@0.80.6` only as a temporary client rendering toolkit.
- Product UX state, viewport/search/activity/tool-fold reducers and key actions belong to Alu Dock. Do not expose `pi-tui` types through Host, protocol, DTO or domain ports.
- Private subpath imports are forbidden in production and tests. Any renderer replacement must be one deliberate switch rather than a dual-renderer transition; the frozen API, provenance and cutover contract is `docs/v0.2-terminal-core-design.md`.
- Settings use Pi's native snapshot, lock, field merge and last-writer-wins semantics.
- A successful setting mutation is: public setter → `await flush()` → `drainErrors()`.
- Do not edit Pi settings JSON directly to simulate a missing setter.
- `compaction.reserveTokens` and `compaction.keepRecentTokens` are read-only until Pi exposes public setters.
- This repository intentionally has no `.pi/settings.json`; the former repository compaction guard was retired in favor of the user-level `sol-mid-turn-guard` extension. Do not recreate project settings or copy the old reserve/keep values back into the repository.
- `pi install`, `pi config`, and `pi login` remain owned by the original Pi CLI.

## Development workflow

Work in cohesive slices rather than one test cycle per field:

1. Confirm the authorized task, frozen scope and capability boundary.
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

## Documentation discipline

- This file contains durable engineering contracts only. Do not copy workflow status, ownership, release IDs, transient rollout facts or current scheduling into it.
- Stable architecture belongs in docs and code, not only ephemeral discussion.
- Each completed capability slice gets a validation document containing scope, real evidence, deviations, remaining risks and explicit deferrals.
- Keep historical validation frozen; do not rewrite old evidence to make current work appear retroactive.
- Use focused commits with an honest message after the relevant gate passes.

## Dogfood release discipline

Follow `docs/dogfood-deployment.md` for managed releases. Stage completion and deployment are separate facts:

- commit and pass the complete gate before creating a release;
- publish only a clean committed HEAD to an immutable directory under `/home/luziyi/release/alu-dock/releases`;
- atomically switch `current`; never patch the live release;
- default to refusing a service restart while an active instance exists;
- verify systemd `MainPID`, V2 hello/hostEpoch, journal and a real installed-resource startup smoke after switching;
- rollback the complete release on failure and record both code-gate and deploy-gate evidence in the release validation document and immutable receipt.

`npm run cli` is a development entry. Once Stage 3.6 is installed, `alu-dock` is the only human dogfood entry and must never silently fall back to an untracked detached Host.

## Stable interaction and surface rules

- Registered extension commands are classified before Queue admission. Exact immediate commands never enter pending/restoration, preserve a running parent operation and activity, and fence old-generation completion. Unknown slash input, skills and prompt templates keep Pi-native semantics.
- Queued text is Same-Host memory only. Restoration prepends without overwriting a concurrent draft; in-flight, failed or ambiguous mutations never claim restoration or proceed to abort automatically.
- Ordinary drag belongs to the terminal. Only explicit Alt+M or `/mouse` enables Dock-owned 1000/1006 mouse tracking and history wheel; normal exit restores terminal modes.
- Forget and prune remove only Dock catalog records after atomic Host commits. They never delete Pi session files.
- Extension visual UI is limited to bounded closed text interactions. Component factories, `ctx.ui.custom()`, binary/image transport, data URIs and renderer objects are not control-protocol surfaces. A nonzero subagent child exit is normalized to a real tool error for model, history and TUI consumers.
- Work activity animation writes only its fixed surface and idle has no timer. The Dock Hub may use one client-local low-frequency mascot blink timer only while visible; the mascot never encodes or aggregates Host/instance state.
- Human CLI workflows, typed Protocol V2 machine control and Pi-registered model tools are separate surfaces. Alu Dock has no Agent self-loop through its own CLI. Test probes do not occupy public human help; scripts use DockClient, and any model-visible diagnostic is explicitly registered, closed and read-only.
- Renderer replacement, if undertaken, is a single cutover governed by `docs/v0.2-terminal-core-design.md`; do not maintain dual renderers.
