import type {
  ExtensionDialogOptions,
  ExtensionWidgetRenderer,
} from "../core/extension-ui-broker.js";
import type { PiExtensionUiLifecyclePort } from "./pi-runtime-host.js";
import type { PiExtensionUiPort } from "./pi-extension-ui-adapter.js";
import type { UiCapability } from "./worker-protocol.js";

export type WorkerUiCall = (capability: UiCapability, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Pi-facing endpoint that retains component objects and rendering inside the child. */
export class WorkerExtensionUiEndpoint implements PiExtensionUiLifecyclePort {
  private renderer: ExtensionWidgetRenderer | undefined;
  private rendererGeneration = 0;
  private generation = 0;
  private toolsExpanded = false;

  constructor(private readonly call: WorkerUiCall) {}

  bindWidgetRenderer(renderer: ExtensionWidgetRenderer): void {
    this.renderer?.reset();
    this.renderer = renderer;
    this.rendererGeneration = this.generation;
  }

  /** A stale extension keeps this wrapper, so every late UI call is fenced. */
  createGenerationPort(): PiExtensionUiPort {
    const generation = this.generation;
    const active = (): boolean => generation === this.generation;
    return {
      select: (title, options, opts) => active() ? this.select(title, options, opts) : Promise.resolve(undefined),
      confirm: (title, message, opts) => active() ? this.confirm(title, message, opts) : Promise.resolve(false),
      input: (title, placeholder, opts) => active() ? this.input(title, placeholder, opts) : Promise.resolve(undefined),
      editor: (title, prefill) => active() ? this.editor(title, prefill) : Promise.resolve(undefined),
      notify: (message, level) => { if (active()) this.notify(message, level); },
      getToolsExpanded: () => active() ? this.getToolsExpanded() : false,
      setToolsExpanded: (expanded) => { if (active()) this.setToolsExpanded(expanded); },
      setStatus: (key, text) => { if (active()) this.setStatus(key, text); },
      setWidget: (key, lines, placement) => { if (active()) this.setWidget(key, lines, placement); },
      reportWidgetError: (key, error) => { if (active()) this.reportWidgetError(key, error); },
      unsupported: (feature) => { if (active()) this.unsupported(feature); },
      bindWidgetRenderer: (renderer) => { if (active()) this.bindWidgetRenderer(renderer); else renderer.reset(); },
    };
  }

  select(title: string, options: string[], opts?: ExtensionDialogOptions): Promise<string | undefined> {
    return this.call("ui.select", { title, options, optionsMeta: dialogOptions(opts) }, opts?.signal).then(optionalStringResult);
  }

  confirm(title: string, message: string, opts?: ExtensionDialogOptions): Promise<boolean> {
    return this.call("ui.confirm", { title, message, optionsMeta: dialogOptions(opts) }, opts?.signal).then((value) => value === true);
  }

  input(title: string, placeholder?: string, opts?: ExtensionDialogOptions): Promise<string | undefined> {
    return this.call("ui.input", { title, ...(placeholder === undefined ? {} : { placeholder }), optionsMeta: dialogOptions(opts) }, opts?.signal).then(optionalStringResult);
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.call("ui.editor", { title, ...(prefill === undefined ? {} : { prefill }) }).then(optionalStringResult);
  }

  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    this.fire("ui.notify", { message, level });
  }

  getToolsExpanded(): boolean { return this.toolsExpanded; }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    this.fire("ui.setToolsExpanded", { expanded });
  }

  /** Host-originated state update; deliberately does not echo. */
  applyHostToolsExpanded(expanded: boolean): void { this.toolsExpanded = expanded; }

  setStatus(key: string, text: string | undefined): void {
    this.fire("ui.setStatus", { key, ...(text === undefined ? {} : { text }) });
  }

  setWidget(key: string, lines: string[] | undefined, placement: "aboveEditor" | "belowEditor" = "aboveEditor"): void {
    this.fire("ui.setWidget", { key, ...(lines === undefined ? {} : { lines }), placement });
  }

  reportWidgetError(key: string, error: unknown): void {
    this.fire("ui.widgetError", { key, error: boundedError(error) });
  }

  unsupported(feature: string): void { this.fire("ui.unsupported", { feature }); }

  setViewport(width: number, height: number): void { if (this.rendererGeneration === this.generation) this.renderer?.render({ width, height }); }

  beginGenerationChange(kind: "binding" | "reload" = "binding"): void {
    this.fire("ui.generationBegin", {});
    // Pi reload reuses the originally bound ExtensionUIContext object. Keep its
    // port live for the new runner; replacement paths bind a fresh generation
    // port and must fence the old one.
    if (kind === "binding") {
      this.generation += 1;
      this.renderer?.reset();
      this.renderer = undefined;
    } else {
      // AgentSession.reload reuses this context and its renderer binding. Reset
      // old component instances but retain the renderer for the new runner.
      this.renderer?.reset();
      this.rendererGeneration = this.generation;
    }
    this.toolsExpanded = false;
  }
  resetFromHost(): void { this.renderer?.reset(); }
  completeGenerationChange(): Promise<void> { return Promise.resolve(); }
  failGenerationChange(): Promise<void> { this.generation += 1; this.toolsExpanded = false; this.renderer?.reset(); this.renderer = undefined; return Promise.resolve(); }

  private fire(capability: UiCapability, args: Record<string, unknown>): void {
    void this.call(capability, args).catch(() => {});
  }
}

function dialogOptions(opts?: ExtensionDialogOptions): Record<string, unknown> | undefined {
  if (!opts) return undefined;
  return {
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    ...(opts.signal === undefined ? {} : { signalAborted: opts.signal.aborted }),
  };
}
function optionalStringResult(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function boundedError(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.length <= 2_048 ? text : text.slice(0, 2_048); }
