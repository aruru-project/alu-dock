import type { DockActivityLine } from "./conversation.js";

export interface ActivityRenderScheduler {
  requestRender(): void;
}

export interface ActivityPulseOptions {
  intervalMs?: number;
  canWrite?: () => boolean;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}

/** Advances the activity frame through pi-tui's single frame renderer. */
export class ActivityPulseController {
  private timer: NodeJS.Timeout | undefined;
  private enabled = false;
  private readonly intervalMs: number;
  private readonly canWrite: () => boolean;
  private readonly schedule: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  private readonly cancel: (timer: NodeJS.Timeout) => void;

  constructor(
    private readonly activity: DockActivityLine,
    private readonly scheduler: ActivityRenderScheduler,
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
    if (!this.enabled || !this.activity.isAnimated() || !this.canWrite()) return false;
    if (!this.activity.advanceAnimationFrame()) return false;
    this.scheduler.requestRender();
    return true;
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) this.cancel(this.timer);
    this.timer = undefined;
  }
}
