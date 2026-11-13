import { Key, matchesKey, ProcessTerminal, TuiMainScreen, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type Terminal } from "@earendil-works/pi-tui";
import { ControlClientError, type DockClient } from "../control/dock-client.js";
import type { SystemCandidate, SystemCatalogResult } from "../control/protocol.js";
import { DocumentReader, safeDocumentText } from "./document-reader.js";
import { parseTerminalMouseEvent } from "./mouse-input.js";
import { paint } from "./theme.js";

export interface SystemChoice { cwd: string; selection?: SystemCandidate; defaultSaved: boolean }
interface SystemPickerOptions { forceSelection?: boolean; notice?: string; selectedId?: string }
type SystemClient = Pick<DockClient, "systemCatalog" | "systemContentAll" | "setSystemDefault">;
const systemKindLabels: Record<SystemCandidate["kind"], string> = {
  "project-system": "Project SYSTEM",
  "global-system": "User SYSTEM",
  "dock-template": "Dock template",
};

/** The Host owns default validity. This surface never promotes a project SYSTEM or first row to a default. */
export class SystemPicker implements Component, Focusable {
  focused = false;
  onFinish?: (choice?: SystemChoice) => void;
  private active = true;
  private busy = true;
  private saving = false;
  private unknown = false;
  private status = "Loading systems… Esc to cancel";
  private catalog?: SystemCatalogResult;
  private selected = 0;
  private reader?: DocumentReader;
  private pageSize = 1;
  constructor(private readonly client: SystemClient, private readonly cwd: string, private readonly rows: () => number, private readonly redraw: () => void, private readonly options: SystemPickerOptions = {}) {}
  async load(useDefault = false): Promise<void> {
    try {
      const selectedId = this.catalog?.candidates[this.selected]?.id ?? this.options.selectedId;
      const first = await this.client.systemCatalog(this.cwd);
      if (!this.active) return;
      if (useDefault && !this.options.forceSelection && first.defaultSelection) { this.finish({ cwd: first.cwd, defaultSaved: false }); return; }
      const candidates = [...first.candidates];
      let page = first;
      while (page.nextCursor) {
        page = await this.client.systemCatalog(first.cwd, undefined, page.nextCursor);
        if (!this.active) return;
        if (page.revision !== first.revision) throw new Error("changed");
        candidates.push(...page.candidates);
      }
      this.catalog = { ...first, candidates };
      this.selected = Math.max(0, candidates.findIndex((item) => item.id === selectedId));
      this.status = [this.options.notice, ...first.warnings, candidates.length ? "Choose a system explicitly for this Work." : "No systems are available. Add a template, then press R to reload."].filter(Boolean).join("\n");
    } catch { this.status = "Couldn't load systems. Press R to retry, or Esc to go back."; }
    finally { this.busy = false; if (this.active) this.redraw(); }
  }
  dispose(): void { this.active = false; this.reader?.dispose(); }
  private finish(choice?: SystemChoice): void { this.dispose(); this.onFinish?.(choice); }
  handleInput(data: string): void {
    if (this.reader) { this.reader.handleInput(data); return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { if (!this.saving) this.finish(); return; }
    if (this.busy || this.unknown) return;
    const candidates = this.catalog?.candidates ?? [];
    if (matchesKey(data, Key.down)) this.selected = Math.min(candidates.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(candidates.length - 1, this.selected + this.pageSize);
    else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.pageSize);
    else if (data === "r" || data === "R") { this.busy = true; this.status = "Loading systems… Esc to cancel"; void this.load(); }
    else {
      const item = candidates[this.selected];
      if (item && (data === "v" || data === "V")) {
        const reader = new DocumentReader(item.name, item.kind === "dock-template", this.rows, this.redraw);
        this.reader = reader;
        reader.onClose = () => { this.reader = undefined; this.redraw(); };
        void reader.load((signal) => this.client.systemContentAll(this.catalog!.cwd, item.id, undefined, signal));
      } else if (item && (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s")))) {
        if (item.warning) this.status = item.warning;
        else if (matchesKey(data, Key.ctrl("s"))) void this.save(item);
        else this.finish({ cwd: this.catalog!.cwd, selection: item, defaultSaved: false });
      }
    }
    this.redraw();
  }
  private async save(item: SystemCandidate): Promise<void> {
    this.busy = this.saving = true;
    this.status = "Saving this directory's default…";
    this.redraw();
    try {
      const result = await this.client.setSystemDefault(this.catalog!.cwd, item.id);
      if (this.active) this.finish({ cwd: this.catalog!.cwd, selection: result.selection, defaultSaved: true });
    } catch (error) {
      this.unknown = error instanceof ControlClientError && error.code === "effect_unknown";
      this.status = this.unknown ? "Saving may have succeeded. Go back and reload this directory to check before trying again. No Work was created." : "Couldn't save the default. Enter uses this system only this time; Ctrl+S retries saving. No Work was created.";
    } finally { this.busy = this.saving = false; if (this.active) this.redraw(); }
  }
  invalidate(): void { this.reader?.invalidate(); }
  render(width: number): string[] {
    if (this.reader) return this.reader.render(width);
    const w = Math.max(1, width);
    const footer = wrapTextWithAnsi("Enter: this time only · Ctrl+S: set directory default and confirm · V: read · R: reload · Esc: back", w);
    const status = wrapTextWithAnsi(safeDocumentText(this.status), w);
    const header = [paint.accent("Choose a system"), truncateToWidth(safeDocumentText(this.catalog?.cwd ?? this.cwd), w), ...status, ""];
    this.pageSize = Math.max(1, this.rows() - header.length - footer.length - 1);
    const candidates = this.catalog?.candidates ?? [];
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.pageSize / 2), candidates.length - this.pageSize));
    return [...header, ...candidates.slice(start, start + this.pageSize).map((item, index) => truncateToWidth(`${index + start === this.selected ? "›" : " "} ${safeDocumentText(item.name)} · ${systemKindLabels[item.kind]}${item.warning ? " · unavailable" : ""}`, w)), ...footer];
  }
}

/** Hub lends its terminal; direct commands own one alternate screen and restore it before Work. */
export async function chooseSystem(client: SystemClient, cwd: string, terminal?: Terminal, options: SystemPickerOptions = {}): Promise<SystemChoice | undefined> {
  const own = terminal === undefined;
  terminal ??= new ProcessTerminal();
  const term = terminal;
  const tui = new TuiMainScreen(term);
  const surface = new SystemPicker(client, cwd, () => term.rows, () => tui.requestRender(), options);
  let finish!: (choice?: SystemChoice) => void;
  const choice = new Promise<SystemChoice | undefined>((resolve) => { finish = resolve; });
  surface.onFinish = finish;
  const signal = () => { surface.dispose(); finish(); };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  const removeMouse = tui.addInputListener((data) => {
    const mouse = parseTerminalMouseEvent(data);
    if (!mouse) return undefined;
    if (mouse.kind === "wheel") surface.handleInput(mouse.direction === "up" ? "\x1b[A" : "\x1b[B");
    return { consume: true };
  });
  try {
    if (own) term.write("\x1b[?1049h");
    term.clearScreen(); tui.addChild(surface); tui.setFocus(surface); tui.start();
    void surface.load(true);
    return await choice;
  } finally {
    surface.dispose(); removeMouse(); tui.stop();
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
    if (own) term.write("\x1b[?1049l");
  }
}
