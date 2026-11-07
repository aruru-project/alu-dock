import { join } from "node:path";

import { FileModelsStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { serveRequests } from "../control/service-supervisor.js";
import { configurePiNetwork } from "../pi/configure-pi-network.js";
import type { ModelServiceRequest } from "./protocol.js";
import { ModelServiceCore } from "./service.js";
import { MODEL_SERVICE_AGENT_DIR_ENV } from "./service-messages.js";

/** The model service process. It holds Main's model configuration and credentials and nothing else: no Work, tools or sessions. */
async function main(): Promise<void> {
  const agentDir = process.env[MODEL_SERVICE_AGENT_DIR_ENV];
  if (!agentDir || !process.send) throw new Error("The model service must be started by the Dock Host");
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  configurePiNetwork(settings);
  const modelsPath = join(agentDir, "models.json");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, allowModelNetwork: false });
  const core = new ModelServiceCore(runtime, { modelsPath, store: new FileModelsStore(join(agentDir, "models-store.json")) }, async () => {
    await settings.reload();
    configurePiNetwork(settings);
  });
  await serveRequests(async (raw, signal) => {
    const request = raw as ModelServiceRequest;
    return request.op === "configuration" ? await core.configuration()
      : request.op === "auth_state" ? await core.authState()
      : await core.auth(request, signal);
  });
}

main().catch((error) => {
  process.stderr.write(`Alu Dock model service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
