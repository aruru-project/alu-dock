import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { DockEvent, PendingMessageDto } from "../core/managed-instance.js";
import { paint } from "./theme.js";

const MAX_VISIBLE_ITEMS = 4;

/** Ephemeral composer-adjacent projection of messages not yet consumed by Pi. */
export class PendingQueueTray implements Component {
  private items: PendingMessageDto[] = [];

  get count(): number { return this.items.length; }

  reset(items: readonly PendingMessageDto[]): void {
    this.items = ordered(items.map((item) => ({ ...item })));
  }

  clear(): void { this.items = []; }

  remove(queueItemIds: readonly string[]): void {
    const removed = new Set(queueItemIds);
    this.items = this.items.filter((item) => !removed.has(item.queueItemId));
  }

  invalidate(): void {}

  apply(event: DockEvent): void {
    if (event.type === "message.queued") {
      if (!this.items.some((item) => item.queueItemId === event.data.queueItemId)) {
        this.items = ordered([...this.items, { ...event.data }]);
      }
      return;
    }
    if (event.type === "message.submitted" && event.data.queueItemId !== undefined) {
      this.items = this.items.filter((item) => item.queueItemId !== event.data.queueItemId);
      return;
    }
    if (event.type === "queue.cleared") {
      if (event.data.queueItemIds.length > 0) this.remove(event.data.queueItemIds);
      else if (event.data.reason !== "dequeued") this.clear();
      return;
    }
    if (event.type === "session.replaced" || event.type === "instance.stopped") this.clear();
  }

  render(width: number): string[] {
    if (this.items.length === 0 || width < 1) return [];
    const visible = this.items.slice(0, MAX_VISIBLE_ITEMS);
    const lines = visible.map((item, index) => {
      const mode = item.delivery === "steer" ? "steer next" : "follow-up";
      const prefix = paint.queue(`  ↳ ${index + 1}. ${mode} · `);
      const text = item.text
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      const attachments = item.attachments ?? [];
      const attachmentSummary = attachments.length === 0
        ? ""
        : attachments.length === 1
          ? `attachment: ${attachments[0]!.name} (${formatBytes(attachments[0]!.sizeBytes)})`
          : `${attachments.length} attachments · ${attachments[0]!.name}`;
      const summary = [text, attachmentSummary].filter((part) => part.length > 0).join(" · ") || "(empty)";
      return truncateToWidth(`${prefix}${paint.primary(summary)}`, width);
    });
    const hidden = this.items.length - visible.length;
    if (hidden > 0) lines.push(truncateToWidth(paint.queue(`  ↳ +${hidden} more pending`), width));
    return lines;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10 * 1_024 ? 1 : 0)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MiB`;
}

function ordered(items: PendingMessageDto[]): PendingMessageDto[] {
  return [
    ...items.filter((item) => item.delivery === "steer"),
    ...items.filter((item) => item.delivery === "followUp"),
  ];
}
