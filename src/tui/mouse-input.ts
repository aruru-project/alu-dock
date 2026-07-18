const ENABLE_MOUSE_TRACKING = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_TRACKING = "\u001b[?1006l\u001b[?1000l";
const MAX_MOUSE_SEQUENCE_LENGTH = 64;
const MAX_MOUSE_COORDINATE = 32_767;
const MAX_MOUSE_BUTTON = 255;

export type MouseWheelDirection = "up" | "down";
export type TerminalMouseEvent =
  | { kind: "left-press"; x: number; y: number }
  | { kind: "wheel"; direction: MouseWheelDirection; x: number; y: number };

/** Decode one bounded xterm SGR or legacy X10 mouse report. */
export function parseTerminalMouseEvent(data: string): TerminalMouseEvent | undefined {
  if (data.length > MAX_MOUSE_SEQUENCE_LENGTH) return undefined;

  const sgr = /^\u001b\[<(\d+);(\d+);(\d+)M$/.exec(data);
  if (sgr) {
    const button = boundedInteger(sgr[1]!, 0, MAX_MOUSE_BUTTON);
    const x = boundedInteger(sgr[2]!, 1, MAX_MOUSE_COORDINATE);
    const y = boundedInteger(sgr[3]!, 1, MAX_MOUSE_COORDINATE);
    if (button === undefined || x === undefined || y === undefined) return undefined;
    return mouseEvent(button, x, y);
  }

  if (data.length === 6 && data.startsWith("\u001b[M")) {
    const button = data.charCodeAt(3) - 32;
    const x = data.charCodeAt(4) - 32;
    const y = data.charCodeAt(5) - 32;
    if (button < 0 || button > MAX_MOUSE_BUTTON || x < 1 || x > MAX_MOUSE_COORDINATE || y < 1 || y > MAX_MOUSE_COORDINATE) return undefined;
    return mouseEvent(button, x, y);
  }
  return undefined;
}

/** Compatibility projection used by callers interested only in wheel direction. */
export function parseMouseWheel(data: string): MouseWheelDirection | undefined {
  const event = parseTerminalMouseEvent(data);
  return event?.kind === "wheel" ? event.direction : undefined;
}

export function mouseTrackingSequences(): { enable: string; disable: string } {
  return { enable: ENABLE_MOUSE_TRACKING, disable: DISABLE_MOUSE_TRACKING };
}

function mouseEvent(button: number, x: number, y: number): TerminalMouseEvent | undefined {
  if ((button & 128) !== 0 || (button & 32) !== 0) return undefined; // Extended buttons and motion are not Hub input.
  if ((button & 64) !== 0) {
    const direction = button & 3;
    if (direction === 0) return { kind: "wheel", direction: "up", x, y };
    if (direction === 1) return { kind: "wheel", direction: "down", x, y };
    return undefined;
  }
  return (button & 3) === 0 ? { kind: "left-press", x, y } : undefined;
}

function boundedInteger(value: string, minimum: number, maximum: number): number | undefined {
  if (value.length === 0 || value.length > 5) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}
