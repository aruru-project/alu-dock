import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseWorkMessage } from "../core/dock-tools-codec.js";
import type { RecoveredChildReceipt, WorkRecovery } from "../core/work-progress.js";
import type { ChildMessages } from "../worker/child-messages.js";
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
  restore(recovery: WorkRecovery, children: ChildMessages, notes?: {
    /** The assistant already saved her notes for every receipt up to this entry. */
    checkpoint?: string; note(message: WorkMessage): void;
  }): { parentRead: number; corrections: RecoveredChildReceipt[] } {
    let afterCheckpoint = notes?.checkpoint === undefined;
    const atHost = new Map(recovery.children.map((child) => [child.id, child]));
    const corrections = new Map<string, RecoveredChildReceipt>();
    const session = this.session();
    const pending = new Map<string, WorkMessage>();
    const waits = new Map<string, string[]>();
    let parentRead = 0;
    for (const entry of session.getBranch()) {
      if (entry.id === notes?.checkpoint) afterCheckpoint = true;
      if (entry.type === "custom" && entry.customType === RECEIVED) {
        const data = entry.data as { workId?: unknown; message?: unknown } | undefined;
        if (data?.workId !== this.workId) continue;
        const message = parseWorkMessage(data.message);
        pending.set(entry.id, message);
        if (message.from.relation === "child") {
          const id = message.from.id, child = atHost.get(id);
          // The assistant also knows remote children by the receipts she saved on Main.
          const lastIssued = child ? child.next - 1 : children.progress(id)?.handed;
          if (lastIssued !== undefined) {
            if (afterCheckpoint) notes?.note(message);
            const through = message.settlesThrough;
            if (through !== undefined && through <= lastIssued) {
              children.settleKnown(id, through);
              if (child) noteHostCorrection(corrections, child, message, through);
            }
          }
        }
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
      const entry = workMessageEntry(message, children.owes(message.from.id), id);
      session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
    }
    return { parentRead, corrections: [...corrections.values()] };
  }
}

/** An ordinary end of turn also ends dock_wait, but only a final result or actual departure
 * ends the Host's duty to tell the parent if the child later leaves without its result. */
function noteHostCorrection(updates: Map<string, RecoveredChildReceipt>, child: WorkRecovery["children"][number], message: WorkMessage, through: number): void {
  let field: "answered" | "closed";
  if (message.type === "message" && message.done) field = "answered";
  else if (message.type === "child_stopped" && (message.reason === "stopped" || message.reason === "crashed")) field = "closed";
  else return;
  if (through <= child[field]) return;
  const update = updates.get(child.id) ?? { id: child.id };
  update[field] = Math.max(update[field] ?? -1, through);
  updates.set(child.id, update);
}
