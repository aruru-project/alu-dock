import { randomUUID } from "node:crypto";

/** Something she asked to be woken for. */
export interface Reminder {
  id: string;
  /** When it is due, as an ISO time. */
  at: string;
  text: string;
  createdAt: string;
}

export const MAX_REMINDERS = 64;
export const MAX_REMINDER_CHARS = 2_000;
/** Node's longest timer; a later reminder is looked at again when this passes. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Her reminders: kept with her conversation, so they survive a restart, and handed to `due` once
 * each when their time comes. One that came due while she was not running is handed over as soon
 * as she starts, with how late it is.
 */
export class Reminders {
  private items: Reminder[] = [];
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(
    private readonly save: (reminders: readonly Reminder[]) => void,
    private readonly due: (reminder: Reminder, lateMs: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What was saved with the conversation; nothing fires before `start`. */
  restore(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    this.items = saved.flatMap((item): Reminder[] => {
      if (!item || typeof item !== "object") return [];
      const { id, at, text, createdAt } = item as Record<string, unknown>;
      if (typeof id !== "string" || typeof at !== "string" || typeof text !== "string" || typeof createdAt !== "string" || !Number.isFinite(Date.parse(at))) return [];
      return [{ id, at, text, createdAt }];
    }).slice(0, MAX_REMINDERS);
    this.sort();
  }

  start(): void {
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  list(): readonly Reminder[] { return this.items; }

  set(at: Date, text: string): Reminder {
    if (!Number.isFinite(at.getTime())) throw new Error("The reminder's time could not be read. Give it as YYYY-MM-DD HH:mm (local time), an ISO time, or inMinutes.");
    if (at.getTime() <= this.now()) throw new Error("That time has already passed. Give a later time.");
    if (text.trim().length === 0 || text.length > MAX_REMINDER_CHARS) throw new Error(`A reminder needs a text of at most ${MAX_REMINDER_CHARS} characters.`);
    if (this.items.length >= MAX_REMINDERS) throw new Error(`You already have ${MAX_REMINDERS} reminders waiting. Cancel one first.`);
    const reminder: Reminder = { id: `r${randomUUID().slice(0, 8)}`, at: at.toISOString(), text: text.trim(), createdAt: new Date(this.now()).toISOString() };
    this.items.push(reminder);
    this.sort();
    this.save(this.items);
    this.arm();
    return reminder;
  }

  cancel(id: string): Reminder | undefined {
    const index = this.items.findIndex((item) => item.id === id.replace(/^#/u, ""));
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    this.save(this.items);
    this.arm();
    return removed;
  }

  private sort(): void { this.items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)); }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started) return;
    const next = this.items[0];
    if (!next) return;
    const wait = Date.parse(next.at) - this.now();
    this.timer = setTimeout(() => this.fire(), Math.max(0, Math.min(wait, MAX_TIMER_MS)));
    this.timer.unref();
  }

  private fire(): void {
    this.timer = undefined;
    const now = this.now();
    const ready = this.items.filter((item) => Date.parse(item.at) <= now);
    if (ready.length > 0) {
      this.items = this.items.filter((item) => !ready.includes(item));
      this.save(this.items);
      for (const reminder of ready) this.due(reminder, now - Date.parse(reminder.at));
    }
    this.arm();
  }
}

/** Reads the time a reminder is set for: minutes from now, or a local or ISO time. */
export function reminderTime(input: { at?: string; inMinutes?: number }, now: number): Date {
  if (typeof input.inMinutes === "number") return new Date(now + input.inMinutes * 60_000);
  if (typeof input.at !== "string") return new Date(Number.NaN);
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/u.exec(input.at.trim());
  if (local) return new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]));
  return new Date(input.at);
}
