import type { AgentWorkerState } from "../../src/core/agent-worker.js";
import {
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerIdentity,
  type WorkerEnvelope,
} from "../../src/pi/worker-protocol.js";

async function run(): Promise<void> {
  const identity = parseWorkerIdentity(JSON.parse(process.env.ALU_DOCK_WORKER_IDENTITY ?? "null"));
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, undefined, undefined, callback));
  const receiver = new WorkerFrameReceiver((candidate) => candidate.hostEpoch === identity.hostEpoch
    && candidate.instanceId === identity.instanceId
    && candidate.runtimeGeneration === identity.runtimeGeneration
    && candidate.workerIncarnation === identity.workerIncarnation);
  let state = ACTIVE_STATE;
  let resolveIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => { resolveIdentity = resolve; });

  const respond = (callId: string, result: unknown, responseState = state): Promise<void> => sender.sendEnvelope({
    kind: "response",
    callId,
    ok: true,
    result,
    state: responseState,
  });

  process.on("message", (raw) => {
    const envelope = receiver.accept(raw);
    if (!envelope) return;
    if (envelope.kind === "response" && envelope.callId === "fixture-identity" && envelope.ok) {
      resolveIdentity();
      return;
    }
    if (envelope.kind === "agent_request") {
      if (envelope.request.type === "session.history") {
        void respond(envelope.callId, []);
        return;
      }
      if (envelope.request.type === "command.abort") {
        void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId }).then(() => {
          setTimeout(() => {
            state = IDLE_STATE;
            void respond(envelope.callId, null);
          }, 150);
        });
        return;
      }
      if (envelope.request.type === "settings.get") {
        void respond(envelope.callId, []);
        return;
      }
      void respond(envelope.callId, null);
      return;
    }
    if (envelope.kind === "agent_control") {
      const disposed = envelope.control.type === "dispose";
      const accepted = disposed
        ? sender.sendEnvelope({ kind: "accepted", callId: envelope.callId })
        : Promise.resolve();
      void accepted
        .then(() => respond(envelope.callId, null))
        .then(() => { if (disposed) setTimeout(() => process.exit(0), 0); });
    }
  });

  await sender.sendEnvelope({ kind: "call", callId: "fixture-identity", capability: "dock.identity", args: {} });
  await identityReady;
  const ready: WorkerEnvelope = { kind: "ready", state, diagnostics: [], pid: process.pid };
  await sender.sendEnvelope(ready);
}

const BASE_STATE: Omit<AgentWorkerState, "isStreaming"> = {
  sessionId: "slow-abort-worker-session",
  sessionFile: "/tmp/slow-abort-worker-session.jsonl",
  durableSessionFile: "/tmp/slow-abort-worker-session.jsonl",
  isCompacting: false,
  modelState: { model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", availableThinkingLevels: ["off"] },
  metrics: {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  },
  extensionCommands: [],
};

const ACTIVE_STATE: AgentWorkerState = { ...BASE_STATE, isStreaming: true };
const IDLE_STATE: AgentWorkerState = { ...BASE_STATE, isStreaming: false };

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  void run().catch(() => process.exit(1));
}
