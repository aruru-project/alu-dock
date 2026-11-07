import { join } from "node:path";

import { serveRequests } from "../control/service-supervisor.js";
import { parseAssistantRequest, parseAssistantSource, type AssistantSource } from "../core/assistant.js";
import { ASSISTANT_DATABASE_FILE } from "./backup.js";
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
  const databasePath = join(directory, ASSISTANT_DATABASE_FILE);
  // The writing connection creates the database before any reader opens it.
  const store = new AssistantStore(databasePath);
  const readers = new AssistantReaders({ databasePath });
  // The Host stops the service with SIGTERM: close the database rather than leave it to recovery.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void readers.close().finally(() => {
      try { store.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  };
  process.once("SIGTERM", stop);
  const core = new AssistantCore(documents, store, readers, workspace);
  await serveRequests(async (raw, signal) => {
    const message = raw as { request?: unknown; source?: AssistantSource };
    return core.answer(parseAssistantRequest(message.request), parseAssistantSource(message.source), signal);
  }, stop);
}

main().catch((error) => {
  process.stderr.write(`Alu Dock assistant service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
