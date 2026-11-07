import { parentPort, workerData } from "node:worker_threads";

import type { ReaderAnswer, ReaderMessage } from "./readers.js";
import { AssistantStore } from "./store.js";

/** One reading thread of the assistant service: its own read connection, one read at a time. */
const port = parentPort;
if (!port) throw new Error("The assistant reader must run as a thread of the assistant service");
const store = new AssistantStore((workerData as { databasePath: string }).databasePath, { reader: true });
port.on("message", (message: ReaderMessage) => {
  let answer: ReaderAnswer;
  try {
    const result = message.task.op === "search" ? store.search(message.task.request) : store.context(message.task.request);
    answer = { id: message.id, ok: true, result };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    answer = { id: message.id, ok: false, message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) };
  }
  port.postMessage(answer);
});
