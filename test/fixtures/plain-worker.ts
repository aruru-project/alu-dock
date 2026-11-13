import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentEvent, AgentHistoryEntry, AgentWorkerState } from "../../src/core/agent-worker.js";
import type { ConversationFrame } from "../../src/core/instance-dto.js";
import { runAgentWorker, type WorkerAgent } from "../../src/worker/worker-shell.js";

/**
 * Protocol peer: the smallest Agent that is not Pi. It answers each message by repeating it and keeps
 * its conversation in one file, so a reopened Work has it back. Everything Pi-specific is empty.
 */
interface PlainInit { cwd: string; sessionDir: string; sessionFile?: string }

async function createPlainAgent(init: PlainInit): Promise<WorkerAgent> {
  const sessionFile = init.sessionFile ?? join(init.sessionDir, `${randomUUID()}.jsonl`);
  const history: AgentHistoryEntry[] = existsSync(sessionFile)
    ? readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentHistoryEntry)
    : [];
  const listeners = new Set<(event: AgentEvent) => void>();
  let running = false;
  const publish = (event: AgentEvent): void => { for (const listener of listeners) listener(event); };
  const frame = (value: ConversationFrame): void => publish({ type: "dock_conversation_frame", frame: value });
  const record = (source: "user" | "assistant", text: string): AgentHistoryEntry => {
    const id = randomUUID();
    const entry: AgentHistoryEntry = {
      recordId: id, entryId: id, ...(history.length === 0 ? {} : { parentId: history.at(-1)!.entryId }),
      kind: "message", source, visibility: "conversation", timestamp: new Date().toISOString(),
      content: [{ type: "text", text }], ...(source === "assistant" ? { stopReason: "stop" } : {}),
    };
    history.push(entry);
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
    return entry;
  };
  const state = (): AgentWorkerState => ({
    sessionId: "plain-session", sessionFile, durableSessionFile: sessionFile,
    isStreaming: running, isCompacting: false,
    modelState: { model: { provider: "plain", id: "repeat" }, thinkingLevel: "off", availableThinkingLevels: ["off"] },
    metrics: {
      messages: { user: 0, assistant: 0, toolCalls: 0, toolResults: 0, total: history.length },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    extensionCommands: [],
  });
  const empty = { total: 0, truncated: false };

  return {
    diagnostics: [],
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    state,
    dispose: async () => ({ cleanupErrors: [] }),
    control: async (control) => {
      if (control.type === "dispose") return { cleanupErrors: [] };
      if (control.type === "activate" || control.type === "wait_for_idle") return null;
      throw new Error(`The plain Worker has no ${control.type}`);
    },
    dispatch: async (request, _context, preflight) => {
      switch (request.type) {
        case "command.submit": {
          const { operationId, message } = request.params;
          preflight({ success: true, inputKind: "prompt", delivery: "prompt", custody: "runtime" });
          running = true;
          publish({ type: "agent_start", operationId });
          const user = record("user", message);
          frame({ type: "message.submitted", data: { operationId, messageId: user.entryId, role: "user", text: message, delivery: "prompt" } });
          const reply = record("assistant", `You said: ${message}`);
          frame({ type: "message.delta", data: { messageId: reply.entryId, block: "text", delta: `You said: ${message}` } });
          frame({ type: "message.completed", data: { messageId: reply.entryId, role: "assistant", content: reply.content, stopReason: "stop" } });
          running = false;
          publish({ type: "conversation_checkpoint", history });
          publish({ type: "agent_settled", stopReason: "stop", operationId });
          return null;
        }
        case "command.abort": return null;
        case "session.history": return history;
        case "conversation.history": return {
          revision: "plain",
          entries: history.map((entry) => ({ entry, contentRef: entry.entryId, contentComplete: true, totalBlocks: entry.content.length })),
          hasEarlier: false,
        };
        case "model.list": return { models: [], availableThinkingLevels: ["off"], ...empty };
        case "tool.list": return { tools: [], ...empty };
        case "settings.get": return [];
        case "resource.get": return { resources: [], diagnostics: [], resourceTotal: 0, resourcesTruncated: false, diagnosticTotal: 0, diagnosticsTruncated: false };
        case "command.catalog": return { commands: [], ...empty };
        case "session.list": return { sessions: [], ...empty };
        case "session.tree": return { nodes: [] };
        default: throw new Error(`The plain Worker has no ${request.type}`);
      }
    },
  };
}

function parseInit(raw: unknown): PlainInit {
  const value = raw as Partial<PlainInit> | null;
  if (!value || typeof value.cwd !== "string" || typeof value.sessionDir !== "string") throw new Error("Plain Worker init is invalid");
  return { cwd: value.cwd, sessionDir: value.sessionDir, ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}) };
}

if (process.env.ALU_DOCK_WORKER_IDENTITY !== undefined && typeof process.send === "function") {
  void runAgentWorker({ parseInit, create: createPlainAgent }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
