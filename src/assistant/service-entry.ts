import { join } from "node:path";

import { serveRequests } from "../control/service-supervisor.js";
import { parseAssistantRequest, parseAssistantSource, type AssistantSource } from "../core/assistant.js";
import { AssistantDocuments } from "./documents.js";
import { AssistantReaders } from "./readers.js";
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
  const databasePath = join(directory, "memory.sqlite");
  // The writing connection creates the database before any reader opens it.
  const store = new AssistantStore(databasePath);
  const readers = new AssistantReaders({ databasePath });
  process.once("exit", () => { try { store.close(); } catch { /* the process is ending */ } });
  const core = new AssistantCore(documents, store, readers, workspace);
  await serveRequests(async (raw) => {
    const message = raw as { request?: unknown; source?: AssistantSource };
    return core.answer(parseAssistantRequest(message.request), parseAssistantSource(message.source));
  });
}

main().catch((error) => {
  process.stderr.write(`Alu Dock assistant service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
