import type { DockActivityLine } from "./conversation.js";

export interface ActivityPlacement {
  screenRow: number;
  width: number;
  screenRows: number;
}

export interface LocalizedActivityWriter {
  writeActivityRow(screenRow: number, line: string, width: number, screenRows: number): boolean;
}

export interface ActivityPulseOptions {
  intervalMs?: number;
  canWrite?: () => boolean;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}

/**
 * Advances only the fixed activity row. It never asks pi-tui to render, so the
 * editor, cursor marker, history viewport, and composer border remain untouched.
 */
export class ActivityPulseController {
  private placement: ActivityPlacement | undefined;
  private timer: NodeJS.Timeout | undefined;
  private enabled = false;
  private readonly intervalMs: number;
  private readonly canWrite: () => boolean;
  private readonly schedule: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  private readonly cancel: (timer: NodeJS.Timeout) => void;

  constructor(
    private readonly activity: DockActivityLine,
    private readonly writer: LocalizedActivityWriter,
    options: ActivityPulseOptions = {},
  ) {
    this.intervalMs = Math.max(200, Math.floor(options.intervalMs ?? 320));
    this.canWrite = options.canWrite ?? (() => true);
    this.schedule = options.setInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.cancel = options.clearInterval ?? clearInterval;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  setPlacement(placement: ActivityPlacement | undefined): void {
    this.placement = placement === undefined ? undefined : { ...placement };
  }

  sync(): void {
    const shouldRun = this.enabled && this.activity.isAnimated();
    if (shouldRun && !this.timer) {
      this.timer = this.schedule(() => { this.pulseNow(); }, this.intervalMs);
      this.timer.unref?.();
    } else if (!shouldRun && this.timer) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  pulseNow(): boolean {
    const placement = this.placement;
    if (!this.enabled || !placement || !this.activity.isAnimated() || !this.canWrite()) return false;
    if (!this.activity.advanceAnimationFrame()) return false;
    const line = this.activity.render(placement.width)[0] ?? "";
    return this.writer.writeActivityRow(placement.screenRow, line, placement.width, placement.screenRows);
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) this.cancel(this.timer);
    this.timer = undefined;
    this.placement = undefined;
  }
}
