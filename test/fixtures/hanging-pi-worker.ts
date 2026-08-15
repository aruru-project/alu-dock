import type { AgentWorkerState } from "../../src/core/agent-worker.js";
import {
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerIdentity,
} from "../../src/pi/worker-protocol.js";

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  void run().catch(() => process.exit(1));
}

async function run(): Promise<void> {
  const identity = parseWorkerIdentity(JSON.parse(process.env.ALU_DOCK_WORKER_IDENTITY ?? "null"));
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, undefined, undefined, callback));
  const receiver = new WorkerFrameReceiver((candidate) => candidate.hostEpoch === identity.hostEpoch
    && candidate.instanceId === identity.instanceId
    && candidate.runtimeGeneration === identity.runtimeGeneration
    && candidate.workerIncarnation === identity.workerIncarnation);
  let resolveIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => { resolveIdentity = resolve; });

  process.on("message", (raw) => {
    const envelope = receiver.accept(raw);
    if (!envelope) return;
    if (envelope.kind === "response" && envelope.callId === "fixture-identity" && envelope.ok) {
      resolveIdentity();
      return;
    }
    if (envelope.kind === "agent_request") {
      if (envelope.request.type === "tool.set_active") {
        void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId });
        return;
      }
      if (envelope.request.type === "settings.update") {
        void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId })
          .then(() => sender.sendEnvelope({
            kind: "response",
            callId: envelope.callId,
            ok: true,
            result: { key: "autoCompaction" },
            state: { ...STATE, injected: true } as AgentWorkerState,
          }));
        return;
      }
      void sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: [] });
      return;
    }
    if (envelope.kind === "agent_control") {
      void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId })
        .then(() => sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: null, state: STATE }));
    }
  });

  await sender.sendEnvelope({ kind: "call", callId: "fixture-identity", capability: "dock.identity", args: {} });
  await identityReady;
  await sender.sendEnvelope({ kind: "ready", state: STATE, diagnostics: [], pid: process.pid });
}

const STATE: AgentWorkerState = {
  sessionId: "hanging-worker-session",
  sessionFile: "/tmp/hanging-worker-session.jsonl",
  durableSessionFile: "/tmp/hanging-worker-session.jsonl",
  isStreaming: false,
  isCompacting: false,
  modelState: { model: { provider: "fixture", id: "fixture" }, thinkingLevel: "off", availableThinkingLevels: ["off"] },
  metrics: {
    messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  },
  extensionCommands: [],
};
