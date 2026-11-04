import { join } from "node:path";

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { configurePiNetwork } from "../pi/configure-pi-network.js";
import { encodeBounded, MAX_MODEL_EVENT_BYTES, type ModelServiceRequest } from "./protocol.js";
import { ModelServiceCore } from "./service.js";
import { MODEL_SERVICE_AGENT_DIR_ENV, type ServiceInbound, type ServiceOutbound } from "./service-messages.js";

/** The model service process. It holds Main's Pi model runtime and nothing else: no Work, tools or sessions. */
async function main(): Promise<void> {
  const agentDir = process.env[MODEL_SERVICE_AGENT_DIR_ENV];
  if (!agentDir || !process.send) throw new Error("The model service must be started by the Dock Host");
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  configurePiNetwork(settings);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const core = new ModelServiceCore(runtime);
  const active = new Map<string, AbortController>();

  const send = (message: ServiceOutbound): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error("The Dock Host disconnected")); return; }
    process.send!(message, undefined, undefined, (error) => (error ? reject(error) : resolve()));
  });

  const run = async (id: string, request: ModelServiceRequest): Promise<void> => {
    const controller = new AbortController();
    active.set(id, controller);
    try {
      let result: unknown = null;
      if (request.op === "catalog") result = await core.catalog();
      else if (request.op === "resolve") result = await core.resolve(request, controller.signal);
      else await core.stream(request, async (wire) => {
        encodeBounded(wire, MAX_MODEL_EVENT_BYTES, "Model event");
        await send({ type: "event", id, wire });
      }, controller.signal);
      await send({ type: "result", id, ok: true, result });
    } catch (error) {
      await send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    } finally {
      controller.abort();
      active.delete(id);
    }
  };

  process.on("message", (raw: ServiceInbound) => {
    if (raw?.type === "request" && typeof raw.id === "string" && !active.has(raw.id)) void run(raw.id, raw.request);
    else if (raw?.type === "cancel" && typeof raw.id === "string") active.get(raw.id)?.abort();
  });
  process.on("disconnect", () => process.exit(0));
  await send({ type: "ready" });
}

main().catch((error) => {
  process.stderr.write(`Alu Dock model service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
