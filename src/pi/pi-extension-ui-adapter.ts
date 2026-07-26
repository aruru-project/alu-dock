import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { ExtensionDialogOptions, ExtensionWidgetRenderer, ExtensionWidgetViewport } from "../core/extension-ui-broker.js";

/** Child-local surface needed by Pi's ExtensionUIContext adapter. */
export interface PiExtensionUiPort {
  select(title: string, options: string[], opts?: ExtensionDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: ExtensionDialogOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined, placement?: "aboveEditor" | "belowEditor"): void;
  reportWidgetError(key: string, error: unknown): void;
  unsupported(feature: string): void;
  bindWidgetRenderer(renderer: ExtensionWidgetRenderer): void;
}

type WidgetComponent = Component & { dispose?(): void };
type WidgetEntry =
  | { kind: "lines"; lines: string[]; placement: "aboveEditor" | "belowEditor" }
  | { kind: "component"; component: WidgetComponent; placement: "aboveEditor" | "belowEditor" };

type RenderAwareExtensionUiContext = ExtensionUIContext & { requestRender?: () => void };

/** Adapt Pi's complete UI interface to Dock's deliberately bounded broker. */
export function createPiExtensionUiContext(broker: PiExtensionUiPort): ExtensionUIContext {
  const widgets = new Map<string, WidgetEntry>();
  let viewport: ExtensionWidgetViewport | undefined;
  let renderQueued = false;

  const renderEntry = (key: string, entry: WidgetEntry): void => {
    if (entry.kind === "lines") {
      broker.setWidget(key, entry.lines, entry.placement);
      return;
    }
    if (!viewport) return;
    try {
      broker.setWidget(key, entry.component.render(viewport.width), entry.placement);
    } catch (error) {
      broker.reportWidgetError(key, error);
    }
  };

  const renderWidgets = (): void => {
    if (!viewport) return;
    for (const [key, entry] of widgets) renderEntry(key, entry);
  };

  const scheduleRender = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderWidgets();
    });
  };

  const widgetTui = { requestRender: scheduleRender } as unknown as TUI;

  broker.bindWidgetRenderer({
    render(nextViewport) {
      viewport = { ...nextViewport };
      renderWidgets();
    },
    reset() {
      viewport = undefined;
      for (const entry of widgets.values()) {
        if (entry.kind === "component") entry.component.dispose?.();
      }
      widgets.clear();
    },
  });

  const context: RenderAwareExtensionUiContext = {
    select: (title, options, opts) => broker.select(title, options, opts),
    confirm: (title, message, opts) => broker.confirm(title, message, opts),
    input: (title, placeholder, opts) => broker.input(title, placeholder, opts),
    editor: (title, prefill) => broker.editor(title, prefill),
    notify: (message, level) => broker.notify(message, level),
    onTerminalInput: () => {
      broker.unsupported("raw terminal input");
      return () => {};
    },
    setStatus: (key, text) => broker.setStatus(key, text),
    setWorkingMessage: () => broker.unsupported("working messages"),
    setWorkingVisible: () => broker.unsupported("working visibility"),
    setWorkingIndicator: () => broker.unsupported("working indicators"),
    setHiddenThinkingLabel: () => broker.unsupported("hidden-thinking labels"),
    setWidget(key, content, options) {
      const existing = widgets.get(key);
      if (existing?.kind === "component") existing.component.dispose?.();
      widgets.delete(key);
      if (content === undefined) {
        broker.setWidget(key, undefined);
        return;
      }
      const placement = options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
      if (Array.isArray(content)) {
        const entry: WidgetEntry = { kind: "lines", lines: [...content], placement };
        widgets.set(key, entry);
        renderEntry(key, entry);
        return;
      }
      try {
        const entry: WidgetEntry = {
          kind: "component",
          component: content(widgetTui, HEADLESS_THEME),
          placement,
        };
        widgets.set(key, entry);
        renderEntry(key, entry);
      } catch (error) {
        broker.reportWidgetError(key, error);
      }
    },
    setFooter: (factory) => { if (factory) broker.unsupported("custom footers"); },
    setHeader: (factory) => { if (factory) broker.unsupported("custom headers"); },
    setTitle: () => broker.unsupported("terminal titles"),
    custom: async <T>() => {
      broker.unsupported("custom components");
      return undefined as T;
    },
    pasteToEditor: () => broker.unsupported("editor paste injection"),
    setEditorText: () => broker.unsupported("editor text injection"),
    getEditorText: () => {
      broker.unsupported("editor text reads");
      return "";
    },
    addAutocompleteProvider: () => broker.unsupported("custom autocomplete providers"),
    setEditorComponent: (factory) => { if (factory) broker.unsupported("custom editors"); },
    getEditorComponent: () => undefined,
    theme: HEADLESS_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is unsupported by Alu Dock" }),
    getToolsExpanded: () => broker.getToolsExpanded(),
    setToolsExpanded: (expanded) => broker.setToolsExpanded(expanded),
    requestRender: scheduleRender,
  };
  return context;
}

const identity = (text: string): string => text;

/** Extensions may style status strings; a headless theme keeps those strings ANSI-free. */
const HEADLESS_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor" as const,
  getThinkingBorderColor: () => identity,
  getBashModeBorderColor: () => identity,
} as unknown as ExtensionUIContext["theme"];
