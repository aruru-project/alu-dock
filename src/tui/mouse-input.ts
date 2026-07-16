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

/** ProcessTerminal with opt-in mouse reporting and localized activity writes. */
export class DockProcessTerminal extends ProcessTerminal {
  private mouseTracking = false;
  private active = false;

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(onInput, onResize);
    this.active = true;
  }

  setMouseTracking(enabled: boolean): boolean {
    if (enabled === this.mouseTracking) return false;
    this.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING);
    this.mouseTracking = enabled;
    return true;
  }

  writeActivityRow(screenRow: number, line: string, requestedWidth: number, requestedRows: number): boolean {
    if (
      !this.active
      || !Number.isSafeInteger(screenRow)
      || screenRow < 0
      || screenRow >= this.rows
      || requestedWidth !== this.columns
      || requestedRows !== this.rows
    ) return false;
    const width = Math.max(1, Math.floor(requestedWidth));
    const fitted = truncateToWidth(line, width);
    // Erasing the complete row avoids terminal-width padding, whose final cell
    // can trigger autowrap and perturb the composer below the activity slot.
    this.write(`\u001b[?2026h\u001b[s\u001b[${screenRow + 1};1H\u001b[2K${fitted}\u001b[u\u001b[?2026l`);
    return true;
  }

  override stop(): void {
    this.active = false;
    this.setMouseTracking(false);
    super.stop();
  }
}

/** Client-local opt-in mode that gives wheel reporting to Dock history. */
export class DockMouseTrackingMode implements Component {
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
      `${paint.queue("  ↕ Dock mouse tracking")} ${paint.faint("· wheel scrolls history · Shift+drag selects · Esc/Alt+M returns")}`,
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
