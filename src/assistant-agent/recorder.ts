import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ASSISTANT_TOOL_NAMES,
  MAX_ASSISTANT_NAME_CHARS,
  MAX_ASSISTANT_RECORD_BATCH_BYTES,
  MAX_ASSISTANT_TOOL_ARGUMENT_CHARS,
  MAX_ASSISTANT_TOOL_CALLS,
  assistantEntryTextLimit,
  type AssistantEntry,
  type AssistantRequest,
  type AssistantResultFor,
} from "../core/assistant.js";
import { isDockMessageText } from "../core/dock-tools.js";
import { extractDockAttachmentContext } from "../pi/dock-attachment-context.js";
import { WATCH_NOTICE_TYPE, WORK_MESSAGE_TYPE, WORK_WAKE_TYPE } from "../worker/dock-tools-client.js";
import { DOCK_NOTE_TYPE, STATUS_NOTE_TYPE } from "./status.js";

/** How her Worker asks the assistant service on Main; the Host names the Work that asks. */
export interface AssistantCallPort {
  call<R extends AssistantRequest>(request: R): Promise<AssistantResultFor<R>>;
}

type Notify = (message: string) => void;
type RecordedSession = Pick<SessionManager, "getSessionId" | "getEntries" | "getSessionFile" | "getSessionName" | "getCwd">;

const OWN_TOOLS = new Set<string>(ASSISTANT_TOOL_NAMES);
/** Tool arguments kept of an entry that would not fit one batch otherwise. */
const SQUEEZED_ARGUMENT_CHARS = 200;

/** Sends one session's new entries to Main, in order, from where Main last recorded it. */
export class SessionRecorder {
  private through: string | undefined;
  private known = false;
  private running: Promise<void> | undefined;
  private again = false;
  private told = false;

  /**
   * `startAfter`: when Main has not recorded this session, it starts after this entry instead of from
   * its first. It is fixed when the session came in, so entries written while Main was away are kept.
   */
  constructor(
    private readonly port: AssistantCallPort,
    private readonly session: RecordedSession,
    private readonly attachmentContextKey: Uint8Array,
    private readonly startAfter: string | undefined,
    private readonly notify: Notify,
  ) {}

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.once(); } while (this.again);
      this.told = false;
    })().catch((error: unknown) => {
      // The next run or the next start of this Work catches up; the owner hears once until it does.
      if (this.told) return;
      this.told = true;
      this.notify(`刚才的对话还没记进助手的记忆（${error instanceof Error ? error.message : String(error)}）。连上 Main 后会自动补记，不用重发。`);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async once(): Promise<void> {
    const sessionId = this.session.getSessionId();
    const entries = this.session.getEntries();
    if (!this.known) {
      this.through = (await this.port.call({ op: "recorded", sessionId })).lastEntryId;
      if (this.through === undefined && this.startAfter !== undefined) {
        await this.port.call({ op: "record", session: this.sessionInfo(sessionId), entries: [], throughEntryId: this.startAfter });
        this.through = this.startAfter;
      }
      this.known = true;
    }
    const recordedAt = this.through === undefined ? -1 : entries.findIndex((entry) => entry.id === this.through);
    const pending = entries.slice(recordedAt + 1);
    if (pending.length === 0) return;
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    const kept = new Map<string, boolean>();
    const keeps = (entry: SessionEntry): boolean => {
      let value = kept.get(entry.id);
      if (value === undefined) { value = assistantEntryOf(entry, this.attachmentContextKey) !== undefined; kept.set(entry.id, value); }
      return value;
    };
    // The nearest earlier entry of the branch that Main keeps too, so reading back follows the branch.
    const parentOf = (entry: SessionEntry): string | undefined => {
      let parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
      while (parent && !keeps(parent)) parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
      return parent?.id;
    };
    const session = this.sessionInfo(sessionId);
    // The batch is a JSON array: its brackets, and a comma before every entry but the first.
    let batch: AssistantEntry[] = [];
    let bytes = 2;
    const send = async (throughEntryId: string) => {
      await this.port.call({ op: "record", session, entries: batch, throughEntryId });
      this.through = throughEntryId;
      batch = [];
      bytes = 2;
    };
    for (const [index, entry] of pending.entries()) {
      const mapped = keeps(entry) ? assistantEntryOf(entry, this.attachmentContextKey) : undefined;
      if (!mapped) continue;
      const parentId = parentOf(entry);
      const item = fitBatch(parentId === undefined ? mapped : { ...mapped, parentId });
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (batch.length > 0 ? 1 : 0);
      if (batch.length > 0 && bytes + size > MAX_ASSISTANT_RECORD_BATCH_BYTES) await send(pending[index - 1]!.id);
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + (batch.length > 0 ? 1 : 0);
      batch.push(item);
    }
    await send(pending.at(-1)!.id);
  }

  private sessionInfo(sessionId: string) {
    const sessionFile = this.session.getSessionFile();
    const name = this.session.getSessionName();
    return { sessionId, ...(sessionFile === undefined ? {} : { sessionFile }), cwd: this.session.getCwd(), ...(name === undefined ? {} : { name: cut(name, MAX_ASSISTANT_NAME_CHARS).text }) };
  }
}

/**
 * An entry with many long tool calls keeps a shorter part of each, so it fits one batch alone; text
 * so full of characters JSON must escape that it still does not fit keeps what does.
 */
function fitBatch(entry: AssistantEntry): AssistantEntry {
  const fits = (item: AssistantEntry) => Buffer.byteLength(JSON.stringify(item), "utf8") + 2 <= MAX_ASSISTANT_RECORD_BATCH_BYTES;
  if (fits(entry)) return entry;
  let fitted: AssistantEntry = entry.toolCalls === undefined ? entry
    : { ...entry, toolCalls: entry.toolCalls.map((call) => ({ name: cut(call.name, SQUEEZED_ARGUMENT_CHARS).text, arguments: cut(call.arguments, SQUEEZED_ARGUMENT_CHARS).text })), truncated: true };
  while (!fits(fitted) && fitted.text.length > 0) fitted = { ...fitted, text: cut(fitted.text, Math.floor(fitted.text.length * 0.9)).text, truncated: true };
  return fitted;
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown; thinking?: string };

/** Extension messages in which another Work speaks to this one (card #666). */
const WORK_SPEAKS = new Set<string>([WORK_MESSAGE_TYPE, WATCH_NOTICE_TYPE]);

/** What Dock itself puts into her conversation for the model alone: not part of what was said. */
const DOCK_ONLY = new Set<string>([WORK_WAKE_TYPE, STATUS_NOTE_TYPE, DOCK_NOTE_TYPE]);

/** A message that is neither the owner's nor hers: another Work's words, or another notice; undefined for Dock's own notes to the model. */
function extensionEntry(base: { entryId: string; at: string }, customType: unknown, content: string | readonly Block[] | undefined): Omit<AssistantEntry, "parentId"> | undefined {
  if (typeof customType === "string" && DOCK_ONLY.has(customType)) return undefined;
  return withText({ ...base, kind: typeof customType === "string" && WORK_SPEAKS.has(customType) ? "work" : "notice" }, contentText(content));
}

/**
 * What Main keeps of one session entry; undefined for what is not part of the conversation. Her own
 * memory tools keep only what she did (the action), not the words they carried or returned: those
 * live in her memories and conversations already, where forgetting reaches them. What another Work
 * says to her is kept as its words, never as the owner's.
 */
export function assistantEntryOf(entry: SessionEntry, attachmentContextKey: Uint8Array): Omit<AssistantEntry, "parentId"> | undefined {
  const base = { entryId: entry.id, at: entry.timestamp };
  if (entry.type === "compaction" || entry.type === "branch_summary") return withText({ ...base, kind: "summary" }, entry.summary);
  if (entry.type === "custom_message") return extensionEntry(base, entry.customType, entry.content as string | Block[]);
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown as { role: string } & Record<string, unknown>;
  switch (message.role) {
    case "user": {
      const raw = contentText(message.content as string | Block[]);
      const { text, attachments } = extractDockAttachmentContext(raw, attachmentContextKey);
      const files = attachments?.length ? `\n[attachments: ${attachments.map((attachment) => attachment.name).join(", ")}]` : "";
      // Another Work's message delivered into her input, as dock_send between top-level Works does.
      return withText({ ...base, kind: isDockMessageText(text) ? "work" : "user" }, `${text}${files}`);
    }
    case "assistant": {
      const blocks = Array.isArray(message.content) ? message.content as Block[] : [];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
      const toolCalls = blocks.filter((block) => block.type === "toolCall" && typeof block.name === "string").slice(0, MAX_ASSISTANT_TOOL_CALLS)
        .map((block) => ({ name: block.name as string, arguments: cut(JSON.stringify(OWN_TOOLS.has(block.name as string) ? ownToolAction(block.arguments) : block.arguments ?? {}), MAX_ASSISTANT_TOOL_ARGUMENT_CHARS).text }));
      if (text.length === 0 && toolCalls.length === 0) return undefined;
      return withText({ ...base, kind: "assistant", ...(toolCalls.length === 0 ? {} : { toolCalls }) }, text);
    }
    case "toolResult":
      if (typeof message.toolName === "string" && OWN_TOOLS.has(message.toolName)) return undefined;
      return withText({ ...base, kind: "tool_result", ...(typeof message.toolName === "string" && message.toolName.length > 0 ? { toolName: message.toolName } : {}) }, contentText(message.content as string | Block[]));
    case "bashExecution":
      return withText({ ...base, kind: "bash" }, `$ ${String(message.command ?? "")}\n${String(message.output ?? "")}`);
    case "custom":
      return extensionEntry(base, message.customType, message.content as string | Block[]);
    case "branchSummary":
    case "compactionSummary":
      return withText({ ...base, kind: "summary" }, String(message.summary ?? ""));
    default:
      return undefined;
  }
}

/** Whether this session entry is the owner speaking: his own message, not one another Work sent into her input. */
export function ownerSpoke(entry: SessionEntry, attachmentContextKey: Uint8Array): boolean {
  return assistantEntryOf(entry, attachmentContextKey)?.kind === "user";
}

function ownToolAction(input: unknown): Record<string, unknown> {
  const args = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(["action", "document"].filter((key) => typeof args[key] === "string").map((key) => [key, args[key]]));
}

function withText<T extends { kind: AssistantEntry["kind"] }>(entry: T & { entryId: string; at: string }, text: string): Omit<AssistantEntry, "parentId"> {
  const kept = cut(text, assistantEntryTextLimit(entry.kind));
  return { ...entry, text: kept.text, ...(kept.cut ? { truncated: true as const } : {}) } as Omit<AssistantEntry, "parentId">;
}

function contentText(content: string | readonly Block[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.type === "text" ? block.text ?? "" : block.type === "image" ? "[image]" : "").filter((part) => part.length > 0).join("\n");
}

/** Cuts at a character boundary so no half of a surrogate pair is left. */
export function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}
