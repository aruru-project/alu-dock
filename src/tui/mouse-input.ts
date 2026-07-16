import { ProcessTerminal, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { paint } from "./theme.js";

const ENABLE_MOUSE_TRACKING = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_TRACKING = "\u001b[?1006l\u001b[?1000l";

export type MouseWheelDirection = "up" | "down";

/** Parse xterm SGR or legacy X10 wheel presses forwarded by pi-tui's StdinBuffer. */
export function parseMouseWheel(data: string): MouseWheelDirection | undefined {
  const sgr = /^\u001b\[<(\d+);\d+;\d+M$/.exec(data);
  if (sgr) return wheelDirection(Number(sgr[1]));
  if (data.length === 6 && data.startsWith("\u001b[M")) {
    return wheelDirection(data.charCodeAt(3) - 32);
  }
  return undefined;
}

/** ProcessTerminal with explicitly paired mouse-mode lifecycle for the fixed viewport. */
export class DockProcessTerminal extends ProcessTerminal {
  private mouseTracking = false;

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(onInput, onResize);
    this.setMouseTracking(true);
  }

  setMouseTracking(enabled: boolean): boolean {
    if (enabled === this.mouseTracking) return false;
    this.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING);
    this.mouseTracking = enabled;
    return true;
  }

  override stop(): void {
    this.setMouseTracking(false);
    super.stop();
  }
}

/** Client-local mode that gives ordinary drag gestures back to the terminal. */
export class TerminalSelectionMode implements Component {
  private activeValue = false;

  get active(): boolean { return this.activeValue; }

  setActive(active: boolean): boolean {
    if (active === this.activeValue) return false;
    this.activeValue = active;
    return true;
  }

  render(width: number): string[] {
    if (!this.activeValue) return [];
    return [truncateToWidth(
      `${paint.queue("  ↖ terminal selection")} ${paint.faint("· drag select · Ctrl+Shift+C copy · Esc/Alt+M return")}`,
      Math.max(1, width),
    )];
  }

  invalidate(): void {}
}

export function mouseTrackingSequences(): { enable: string; disable: string } {
  return { enable: ENABLE_MOUSE_TRACKING, disable: DISABLE_MOUSE_TRACKING };
}

function wheelDirection(button: number): MouseWheelDirection | undefined {
  if (!Number.isSafeInteger(button) || (button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction === 0) return "up";
  if (direction === 1) return "down";
  return undefined;
}
