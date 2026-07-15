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
15. Tree navigation keeps the Pi session file; fork/clone are replacement transactions. Branch-summary cancellation must use the public `abortBranchSummary()` path rather than assuming agent abort covers it.

## Pi and settings rules

- Runtime SDK baseline is `@earendil-works/pi-coding-agent@0.80.6`; V0.1 pins `@earendil-works/pi-tui@0.80.6` only as a temporary client rendering toolkit.
- Product UX state, viewport/search/activity/tool-fold reducers and key actions belong to Alu Dock. Do not expose `pi-tui` types through Host, protocol, DTO or domain ports.
- Private subpath imports are forbidden in production and tests. V0.2 card #148 removes Alu Dock's direct `pi-tui` dependency in one renderer switch rather than maintaining dual renderers; its frozen API, provenance and cutover contract is `docs/v0.2-terminal-core-design.md`.
- Settings use Pi's native snapshot, lock, field merge and last-writer-wins semantics.
- A successful setting mutation is: public setter → `await flush()` → `drainErrors()`.
- Do not edit Pi settings JSON directly to simulate a missing setter.
- `compaction.reserveTokens` and `compaction.keepRecentTokens` are read-only until Pi exposes public setters.
- Preserve this project's `.pi/settings.json` values `reserveTokens=165536` and `keepRecentTokens=20000`.
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
- `.pi/settings.json` is unchanged unless the task explicitly changes it.

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

Stage 6 is the deployed managed baseline at release `20260715T153911Z-4fefab9e2ba4`: `session.tree.v1` plus Stage 5 `catalog.v1`, `service.managed.v1`, `session.reopen`, socket-first reconcile, no-replay Host loss, explicit reopen and generated-unit service CLI. Client viewport/search/tool-fold/tree state remains independent from Host interaction state; both use only public package-root APIs.

Card #142 now waits only for final human default-entry validation. Preserve Stage 6 tree/fork/clone, Stage 5 catalog/reopen/service and Stage 4 interaction/generation/lease invariants. Extension component factories, `ctx.ui.custom()`, binary/image transport and renderer replacement remain out of scope; renderer work stays on V0.2 card #148.
