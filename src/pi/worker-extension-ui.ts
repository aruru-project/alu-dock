import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ExtensionDialogOptions,
  ExtensionWidgetRenderer,
} from "../core/extension-ui-broker.js";
import type { PiExtensionUiLifecyclePort } from "./pi-agent-adapter.js";
import type { PiExtensionUiPort } from "./pi-extension-ui-adapter.js";
import type { UiCapability } from "./worker-protocol.js";

export type WorkerUiCall = (capability: UiCapability, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export class WorkerUiLifecycleCancelledError extends Error {
  readonly reason = "replacement";

  constructor() {
    super("Extension UI interaction cancelled by runtime generation replacement");
    this.name = "WorkerUiLifecycleCancelledError";
  }
}

/** Pi-facing endpoint that retains component objects and rendering inside the child. */
export class WorkerExtensionUiEndpoint implements PiExtensionUiLifecyclePort {
  private renderer: ExtensionWidgetRenderer | undefined;
  private rendererGeneration = 0;
  private generation = 0;
  private toolsExpanded = false;
  private generationChangePending = false;
  private readonly pendingUiCalls: Array<{ capability: UiCapability; args: Record<string, unknown> }> = [];
  private readonly notificationOrigin = new AsyncLocalStorage<{ operationId: string; active: boolean }>();

  constructor(private readonly call: WorkerUiCall) {}

  async withCommandNotificationOrigin<T>(operationId: string, execute: () => Promise<T>): Promise<T> {
    const origin = { operationId, active: true };
    return this.notificationOrigin.run(origin, async () => {
      try { return await execute(); }
      finally { origin.active = false; }
    });
  }

  bindWidgetRenderer(renderer: ExtensionWidgetRenderer): void {
    this.renderer?.reset();
    this.renderer = renderer;
    this.rendererGeneration = this.generation;
  }

  /** A stale extension keeps this wrapper, so every late UI call is fenced. */
  createGenerationPort(): PiExtensionUiPort {
    const generation = this.generation;
    const active = (): boolean => generation === this.generation;
    const cancelled = <T>(): Promise<T> => Promise.reject(new WorkerUiLifecycleCancelledError());
    return {
      select: (title, options, opts) => active() ? this.select(title, options, opts) : cancelled(),
      confirm: (title, message, opts) => active() ? this.confirm(title, message, opts) : cancelled(),
      input: (title, placeholder, opts) => active() ? this.input(title, placeholder, opts) : cancelled(),
      editor: (title, prefill) => active() ? this.editor(title, prefill) : cancelled(),
      notify: (message, level) => { if (active()) this.notify(message, level); },
      setTitle: (title) => { if (active()) this.setTitle(title); },
      setEditorText: (text) => { if (active()) this.setEditorText(text); },
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
    const origin = this.notificationOrigin.getStore();
    this.fire("ui.notify", {
      message,
      level,
      ...(origin?.active === true ? { operationId: origin.operationId } : {}),
    });
  }

  setTitle(title: string): void { this.fire("ui.setTitle", { title }); }

  setEditorText(text: string): void { this.fire("ui.setEditorText", { text: text.replace(/\r\n?/gu, "\n") }); }

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

  beginGenerationChange(kind: "binding" | "reload" = "binding"): Promise<void> {
    // Pi reload reuses the originally bound ExtensionUIContext object. Keep its
    // port live for the new runner; replacement paths bind a fresh generation
    // port and must fence the old one. New one-way UI state is held until the
    // replacement event has made the Host retire the old generation.
    this.generationChangePending = true;
    let hostReset = Promise.resolve();
    if (kind === "binding") {
      this.generation += 1;
      this.renderer?.reset();
      this.renderer = undefined;
    } else {
      hostReset = this.call("ui.runtimeReload", {}).then(() => undefined);
      // AgentSession.reload reuses this context and its renderer binding. Reset
      // old component instances but retain the renderer for the new runner.
      this.renderer?.reset();
      this.rendererGeneration = this.generation;
    }
    this.toolsExpanded = false;
    return hostReset;
  }

  async completeGenerationChange(): Promise<void> {
    while (this.pendingUiCalls.length > 0) {
      const pending = this.pendingUiCalls.shift()!;
      await this.call(pending.capability, pending.args).catch(() => {});
    }
    this.generationChangePending = false;
  }

  resetFromHost(): void { this.renderer?.reset(); }
  failGenerationChange(): Promise<void> {
    this.generation += 1;
    this.generationChangePending = false;
    this.pendingUiCalls.length = 0;
    this.toolsExpanded = false;
    this.renderer?.reset();
    this.renderer = undefined;
    return Promise.resolve();
  }

  private fire(capability: UiCapability, args: Record<string, unknown>): void {
    if (this.generationChangePending) {
      this.pendingUiCalls.push({ capability, args });
      return;
    }
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
