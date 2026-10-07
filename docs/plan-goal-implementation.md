# Plan / Goal implementation plan

Status: implementation authorized; prepared before changing production code.

## Confirmed baseline

- Remote `aruru-project/alu-dock` master: `c53751cfbd90993d48d34d08c5a67341ad5b0dbf`
- It pins Pi release `0.99.2-dock.1`, tag/source `3d6f2ce11985e60e1b4fdddf410e72ccd5b05f5e`
- This matches the supplied research baseline. The complete source tree and original Git commit were verified before creating `feat/dock-plan-goal`; master stays unchanged.

## Product behavior

Plan and Goal are independent. Plan means investigate, ask useful questions, prepare and revise an actionable plan, then explicitly hand it to execution. Goal means continue within the chosen task and a visible finite budget, until delivered, blocked, paused, cancelled, or exhausted. A normal conversation must not silently rearm paused or blocked work.

Use the existing command catalog, editor/select/confirm interactions, status and text widgets, so Desktop, Android and TUI share the same behavior. Do not introduce a second Host workflow, a Goal database, or new client protocol just for this feature.

## Implementation sequence

1. Add an automatically loaded `alu-dock-plan-goal` inline extension beside the existing Dock extensions. Keep a small state module and command/tool handlers in `src/pi/`; add a worker-local control bridge only where the adapter's native abort needs to synchronously disarm the extension.
2. Persist versioned Plan and Goal snapshots as Pi custom entries, rebuilding from `getBranch()`. Plan revision changes invalidate pending apply actions. On session startup/reload/resume/fork/tree navigation, restore the readable state and consumed budget but leave automatic execution disarmed.
3. Expose `/plan` actions for entering, viewing/editing and applying a plan, and `/goal` actions for starting, inspecting, pausing, resuming and cancelling bounded work. Model tools may update plan content/progress and report evidence or blockers, but may not approve their own plan, increase their budget or replace their target.
4. Enforce Plan at `tool_call`, including nested `ctx.executeTool` calls. Use explicit read-only tools and the planning tools; unknown or effectful tools remain unavailable while planning. Do not claim an OS sandbox or use shell-regex filtering as one. Preserve normal execution permissions after handoff.
5. Own automatic continuation only in `agent_before_settle`, preserving earlier draft entries and adding a clearly sourced custom message. Do not use `agent_end` or `agent_settled` to restart. Record a proposed continuation separately from one that actually began. User pause and native abort disarm before cancelling the run. Do not await idle from inside the boundary itself.
6. Use finite automatic-round and elapsed-time budgets with clear displayed semantics; preserve consumption across restore. Normal Pi retry and compaction remain Pi-owned. Compaction failure, provider failure and a completed Goal leave an understandable stopped state. Do not add an extra evaluator-model request to every round.
7. Keep model-declared delivery, recorded check evidence and human acceptance distinct. A task with enough existing checks can finish without an extra acceptance ritual; subjective decisions stop and ask the user.

## Verification

Use the existing real `DockHost` / `DockRegistry(createPiInstance)` / `DockClient` test shape with an isolated temporary HOME/XDG/Pi environment and loopback deterministic provider. No real provider requests, personal credentials, installation or managed-service changes.

- Autoload and normal planning workflow: investigate with read tools, edit plan, reject stale approval, approve the current revision and execute
- Goal automatic progression and actual continuation accounting; retries/compaction must not produce a second loop
- Pause while a provider request runs and after a pre-settle continuation was proposed; the next request must not start
- Native abort/restore Queue; ordinary steering and follow-up are preserved without rearming paused or blocked work
- Budget exhaustion and provider/compaction failure visibly stop; explicit resume respects remaining budget
- Resume/reload/tree/fork restores only the current branch, keeps the consumed budget and requires explicit resume
- Completion reports retain evidence and correctly distinguish delivery from a human decision

Run focused tests and type checking first, then broader affected suites and the applicable existing real-Pi gates. Read and follow `docs/qa.md`; do not duplicate equivalent tests at every layer. Record any unrun platform or real-client checks rather than claiming universal verification.

## Delivery

Work on a fresh feature branch from the approved current master baseline, with no master changes. Review the final diff, verify the exact remote branch commit, then open a draft pull request with implementation scope, test results and remaining verification limits. Do not merge or deploy.
