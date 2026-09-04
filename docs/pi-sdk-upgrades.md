# Pi SDK upgrade gate

Pi releases frequently. The normal upgrade workflow is deliberately short:

1. Bump the Pi version cohort together: every direct `@earendil-works/pi-*` runtime dependency in `package.json` and `package-lock.json`, plus `PI_SDK_VERSION` in `src/version.ts`.

Pi 0.85.0 compatibility note: its published coding-agent root entry statically loads `experimental/server.js` but omits `@earendil-works/pi-server` from the package manifest. Alu Dock therefore pins the matching server package directly. Remove that temporary pin only after an upstream release declares the dependency and the SDK gate passes from a clean install.
2. Run `npm run test:sdk-upgrade`.
3. If it is green, continue the normal release workflow. Read the relevant changelog entry or SDK source only when the gate reports a capability failure; do not pre-read every intermediate release note.

## What the gate proves

The isolated gate drives Protocol V2 through `DockClient`, `DockHost`, `DockRegistry`, a default independent Pi Worker process, and the public Pi SDK adapter. A loopback OpenAI-compatible SSE fixture proves model discovery and selection, adapter-owned Pi creation options, Alu Dock identity in Pi’s system prompt, opening frozen Pi 0.81.1 session records, streamed output, a real `read` tool call and continuation, canonical persisted history, Pi steer/follow-up queues with safe dequeue/abort, provider-error recovery, name/reload continuity, unexpected Worker-loss recovery, persisted-session reopen, and clean process shutdown.

The test uses temporary agent/session/home directories, a literal dummy key, a minimal environment allowlist with no real provider credentials, and `PI_OFFLINE`; its configured provider endpoint listens only on loopback. It never calls a real provider, operates the managed service, or installs anything. Its `.compat.ts` suffix keeps it out of ordinary `npm test`.

## Failure triage

Triage by the failed capability rather than by SDK internals:

- startup/model failure: inspect custom-provider configuration, model runtime/auth resolution, and SDK session construction;
- stream/tool/history failure: inspect provider event shapes, agent events, tool schemas/results, and session persistence projection;
- queue/abort failure: inspect Pi's documented steer, follow-up, dequeue, and abort semantics;
- reload/reopen/stop failure: inspect public session lifecycle APIs and Worker process ownership.

Use the reported boundary to narrow changelog/source review. Keep the gate minimal and deterministic; broader Dock behavior remains covered by the ordinary test suite.

## What it does not prove

This is not a full regression suite, performance SLA, managed-service/install test, or proof that a current hosted model accepts real traffic. A smoke test against the newest real model is separate, consumes external service access, and requires explicit authorization before credentials or model calls are used.
