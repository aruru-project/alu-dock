import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseWorkMessage } from "../core/dock-tools-codec.js";
import type { WorkMessage } from "../core/dock-tools.js";
import { WORK_MESSAGE_TYPE, workMessageEntry } from "../worker/dock-tools-client.js";

const RECEIVED = "dock-work-received";
const IN_WAIT = "dock-work-in-wait";

/** Pi may defer a custom message until a step ends. Keep what the Worker acknowledges in its own
 * session first. The eventual message (or dock_wait's actual tool result) identifies its receipt. */
export class WorkMessageReceipts {
  private readonly ids = new WeakMap<WorkMessage, string>();

  constructor(private readonly workId: string, private readonly session: () => SessionManager) {}

  receive(message: WorkMessage): void {
    this.ids.set(message, this.session().appendCustomEntry(RECEIVED, { workId: this.workId, message }));
  }

  id(message: WorkMessage): string | undefined { return this.ids.get(message); }

  /** A wait can be a nested tool. Its outer call's result is the one Pi writes to the conversation. */
  inWait(messages: readonly WorkMessage[], toolCallId: string): void {
    const ids = messages.map((message) => this.ids.get(message)).filter((id) => id !== undefined);
    if (ids.length > 0) this.session().appendCustomEntry(IN_WAIT, { toolCallId, ids });
  }

  /** Before the Worker builds its context: only the opened branch of this Work, never the history of
   * a parent copied into a newly spawned child. Append to the conversation; do not schedule a turn. */
  restore(heard: (message: WorkMessage) => boolean): number {
    const session = this.session();
    const pending = new Map<string, WorkMessage>();
    const waits = new Map<string, string[]>();
    let parentRead = 0;
    for (const entry of session.getBranch()) {
      if (entry.type === "custom" && entry.customType === RECEIVED) {
        const data = entry.data as { workId?: unknown; message?: unknown } | undefined;
        if (data?.workId !== this.workId) continue;
        const message = parseWorkMessage(data.message);
        pending.set(entry.id, message);
        if (message.from.relation === "parent" && message.type === "message") parentRead = Math.max(parentRead, message.number ?? 0);
      } else if (entry.type === "custom_message" && entry.customType === WORK_MESSAGE_TYPE) {
        const id = (entry.details as { receiptId?: string } | undefined)?.receiptId;
        if (id !== undefined) pending.delete(id);
      } else if (entry.type === "custom" && entry.customType === IN_WAIT) {
        const data = entry.data as { toolCallId?: string; ids?: string[] } | undefined;
        if (typeof data?.toolCallId === "string" && Array.isArray(data.ids)) waits.set(data.toolCallId, [...(waits.get(data.toolCallId) ?? []), ...data.ids]);
      } else if (entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError) {
        const call = entry.message.toolCallId;
        for (const id of waits.get(call) ?? []) pending.delete(id);
        waits.delete(call);
      }
    }
    for (const [id, message] of pending) {
      const entry = workMessageEntry(message, heard(message), id);
      session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    }
    return parentRead;
  }
}
