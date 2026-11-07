import { join } from "node:path";

import { serveRequests } from "../control/service-supervisor.js";
import { parseAssistantRequest, type AssistantSource } from "../core/assistant.js";
import { AssistantDocuments } from "./documents.js";
import { AssistantCore } from "./service.js";
import { ASSISTANT_DIR_ENV, ASSISTANT_WORKSPACE_ENV } from "./service-process.js";
import { AssistantStore } from "./store.js";

/** The assistant service process on Main: her persona, the owner's notes and her recorded conversations. */
async function main(): Promise<void> {
  const directory = process.env[ASSISTANT_DIR_ENV];
  const workspace = process.env[ASSISTANT_WORKSPACE_ENV];
  if (!directory || !workspace || !process.send) throw new Error("The assistant service must be started by the Dock Host");
  const documents = new AssistantDocuments(directory);
  await documents.initialize();
  const store = new AssistantStore(join(directory, "memory.sqlite"));
  process.once("exit", () => { try { store.close(); } catch { /* the process is ending */ } });
  const core = new AssistantCore(documents, store, workspace);
  await serveRequests(async (raw) => {
    const message = raw as { request?: unknown; source?: AssistantSource };
    return core.answer(parseAssistantRequest(message.request), sourceOf(message.source));
  });
}

function sourceOf(raw: unknown): AssistantSource {
  if (raw === null || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  return {
    ...(typeof value.workId === "string" && value.workId.length > 0 && value.workId.length <= 128 ? { workId: value.workId } : {}),
    ...(typeof value.machine === "string" && value.machine.length > 0 && value.machine.length <= 1_024 ? { machine: value.machine } : {}),
  };
}

main().catch((error) => {
  process.stderr.write(`Alu Dock assistant service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
