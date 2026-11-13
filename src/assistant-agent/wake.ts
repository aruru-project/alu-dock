/** What can start a reply of hers. */
export type WakeSource = "owner" | "work" | "reminder";

/** Replies other Works may start in a row before she waits for her owner. */
export const MAX_WORK_WAKES = 12;

/**
 * Keeps her and other Works from waking each other without end: Works may start this many of her
 * replies in a row. Her owner's own message, or a reminder she set, starts the count again. What a
 * Work sends after that still reaches her conversation; it only starts no reply.
 */
export class WakeBudget {
  private inARow = 0;

  /** Whether this may start a reply now. */
  admit(source: WakeSource): boolean {
    if (source !== "work") { this.inARow = 0; return true; }
    if (this.inARow >= MAX_WORK_WAKES) return false;
    this.inARow += 1;
    return true;
  }

  /** True once Works have used every reply they may start. */
  get spent(): boolean { return this.inARow >= MAX_WORK_WAKES; }
}
