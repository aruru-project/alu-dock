import {
  OrderedWorkerSender,
  WorkerFrameReceiver,
  parseWorkerIdentity,
  type WorkerCache,
} from "../../src/pi/worker-protocol.js";

if (process.env.ALU_DOCK_PI_WORKER === "1" && typeof process.send === "function") {
  void run().catch(() => process.exit(1));
}

async function run(): Promise<void> {
  const identity = parseWorkerIdentity(JSON.parse(process.env.ALU_DOCK_WORKER_IDENTITY ?? "null"));
  const sender = new OrderedWorkerSender(identity, (message, callback) => process.send!(message, callback));
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
    if (envelope.kind !== "call") return;
    if (envelope.capability === "runtime.setActiveTools") {
      void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId });
      return;
    }
    if (envelope.capability === "runtime.updateSetting") {
      void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId })
        .then(() => sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: { key: "autoCompaction" } }));
      return;
    }
    if (envelope.capability === "runtime.dispose") {
      void sender.sendEnvelope({ kind: "accepted", callId: envelope.callId })
        .then(() => sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: null }))
        .then(() => process.exit(0));
      return;
    }
    void sender.sendEnvelope({ kind: "response", callId: envelope.callId, ok: true, result: emptyResult(envelope.capability) });
  });

  await sender.sendEnvelope({ kind: "call", callId: "fixture-identity", capability: "dock.identity", args: {} });
  await identityReady;
  await sender.sendEnvelope({ kind: "ready", cache: CACHE, diagnostics: [], pid: process.pid });
}

const CACHE: WorkerCache = {
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
  history: [],
  tree: { nodes: [] },
  extensionCommands: [],
};

function emptyResult(capability: string): unknown {
  if (capability === "runtime.activate" || capability === "runtime.abort" || capability === "runtime.waitForIdle") return null;
  return [];
}
