import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { ExtensionUiBroker } from "../core/extension-ui-broker.js";

/** Adapt Pi's complete UI interface to Dock's deliberately bounded broker. */
export function createPiExtensionUiContext(broker: ExtensionUiBroker): ExtensionUIContext {
  const context: ExtensionUIContext = {
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
      if (content === undefined || Array.isArray(content)) {
        broker.setWidget(key, content, options?.placement);
      } else {
        broker.unsupported("component widgets");
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
