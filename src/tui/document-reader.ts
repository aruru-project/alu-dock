import { Key, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { ResourceContentResult } from "../control/protocol.js";
import { markdownTheme, paint } from "./theme.js";

/** One read-only surface for pre-create systems and current Work resources. */
export class DocumentReader implements Component, Focusable {
  focused = false;
  onClose?: () => void;
  private active = true;
  private readonly cancellation = new AbortController();
  private text = "";
  private loading = true;
  private error = false;
  private top = 0;
  private pageSize = 1;
  private cached?: { width: number; raw: boolean; lines: string[] };
  constructor(private readonly title: string, private raw: boolean, private readonly rows: () => number, private readonly redraw: () => void) {}
  async load(fetch: (signal: AbortSignal) => Promise<ResourceContentResult>): Promise<void> {
    if (!this.active) return;
    try {
      const content = await fetch(this.cancellation.signal);
      if (this.active) this.text = content.text;
    } catch { if (this.active) this.error = true; }
    finally { if (this.active) { this.loading = false; this.redraw(); } }
  }
  dispose(): void { this.active = false; this.cancellation.abort(); }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d")) || data === "q") { this.dispose(); this.onClose?.(); }
    else if (matchesKey(data, Key.down)) this.top++;
    else if (matchesKey(data, Key.up)) this.top = Math.max(0, this.top - 1);
    else if (matchesKey(data, Key.pageDown) || data === " ") this.top += this.pageSize;
    else if (matchesKey(data, Key.pageUp)) this.top = Math.max(0, this.top - this.pageSize);
    else if (matchesKey(data, Key.home)) this.top = 0;
    else if (matchesKey(data, Key.end)) this.top = Number.MAX_SAFE_INTEGER;
    else if (data === "r") { this.raw = !this.raw; this.top = 0; }
    this.redraw();
  }
  invalidate(): void { this.cached = undefined; }
  render(width: number): string[] {
    const w = Math.max(1, width);
    const header = truncateToWidth(paint.accent(safeDocumentText(this.title)), w);
    const footer = wrapTextWithAnsi("↑↓ scroll · PgUp/PgDn page · r raw/Markdown · Esc back", w);
    this.pageSize = Math.max(1, this.rows() - footer.length - 3);
    if (this.loading) return [header, "", truncateToWidth("Reading document… Esc to cancel", w), ...footer];
    if (this.error) return [header, "", ...wrapTextWithAnsi("Couldn't read this file. Go back and reopen it, or choose another source.", w), ...footer];
    if (!this.cached || this.cached.width !== w || this.cached.raw !== this.raw) {
      const text = safeDocumentText(this.text);
      const lines = this.raw ? text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", w)) : new Markdown(text, 0, 0, markdownTheme).render(w);
      this.cached = { width: w, raw: this.raw, lines };
    }
    const lines = this.cached.lines;
    this.top = Math.max(0, Math.min(this.top, lines.length - this.pageSize));
    return [header, truncateToWidth(`${this.raw ? "Original text" : "Markdown"} · source file, not the assembled prompt · ${this.top + 1}/${Math.max(1, lines.length)}`, w), "", ...lines.slice(this.top, this.top + this.pageSize), ...footer];
  }
}

// File bytes remain untouched in Protocol; terminal control characters are never executed.
export function safeDocumentText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�").replace(/[\u202a-\u202e\u2066-\u2069]/gu, "�");
}
