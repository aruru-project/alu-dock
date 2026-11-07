import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { askHost, serveRequests } from "../control/service-supervisor.js";
import { parseAssistantRequest, parseAssistantSource, type AssistantSource } from "../core/assistant.js";
import { mainModelOwner } from "../model-service/owner.js";
import { configurePiNetwork } from "../pi/configure-pi-network.js";
import { ASSISTANT_DATABASE_FILE } from "./backup.js";
import { AssistantDocuments } from "./documents.js";
import { AssistantExtraction, DEFAULT_EXTRACTION_TIMING, type ExtractionTiming } from "./extraction.js";
import { AssistantMemories } from "./memories.js";
import { MainModelAccess } from "./model-access.js";
import { AssistantReaders } from "./readers.js";
import { AssistantCore } from "./service.js";
import { ASSISTANT_AGENT_DIR_ENV, ASSISTANT_DIR_ENV, ASSISTANT_TIMING_ENV, ASSISTANT_WORKSPACE_ENV } from "./service-process.js";
import { AssistantStore } from "./store.js";

/**
 * The assistant service process on Main: her persona, the owner's notes, her recorded conversations
 * and her memories, which it extracts and tidies in the background with the model the owner chose.
 */
async function main(): Promise<void> {
  const directory = process.env[ASSISTANT_DIR_ENV];
  const workspace = process.env[ASSISTANT_WORKSPACE_ENV];
  const agentDir = process.env[ASSISTANT_AGENT_DIR_ENV];
  if (!directory || !workspace || !agentDir || !process.send) throw new Error("The assistant service must be started by the Dock Host");
  // Its model calls use Pi's proxy and network settings, as Works do.
  configurePiNetwork(SettingsManager.create(agentDir, agentDir, { projectTrusted: false }));
  const documents = new AssistantDocuments(directory);
  await documents.initialize();
  const databasePath = join(directory, ASSISTANT_DATABASE_FILE);
  // The writing connection creates the database before any reader opens it.
  const store = new AssistantStore(databasePath);
  const readers = new AssistantReaders({ databasePath });
  const memories = new AssistantMemories(store.connection);
  // Main's model service answers for credentials through the Host, as it does for Works.
  const models = new MainModelAccess(mainModelOwner((args, signal) => askHost({ model: args }, signal)));
  const extraction = new AssistantExtraction(store.connection, memories, documents, models, timing(),
    (message) => process.stderr.write(`Alu Dock: ${message}\n`));
  // The Host stops the service with SIGTERM: close the database rather than leave it to recovery.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void extraction.stop().then(() => readers.close()).finally(() => {
      try { store.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  };
  process.once("SIGTERM", stop);
  const core = new AssistantCore(documents, store, readers, memories, extraction, workspace);
  await serveRequests(async (raw, signal) => {
    const message = raw as { request?: unknown; source?: AssistantSource };
    return core.answer(parseAssistantRequest(message.request), parseAssistantSource(message.source), signal);
  }, stop);
  extraction.start();
}

/** The default timing, or a test's shorter one. */
function timing(): ExtractionTiming {
  const raw = process.env[ASSISTANT_TIMING_ENV];
  if (!raw) return DEFAULT_EXTRACTION_TIMING;
  const given = JSON.parse(raw) as Partial<Record<keyof ExtractionTiming, unknown>>;
  const result = { ...DEFAULT_EXTRACTION_TIMING };
  for (const key of Object.keys(result) as Array<keyof ExtractionTiming>) {
    const value = given[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${ASSISTANT_TIMING_ENV}.${key} must be a number of at least 0`);
    result[key] = value;
  }
  return result;
}

main().catch((error) => {
  process.stderr.write(`Alu Dock assistant service could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
