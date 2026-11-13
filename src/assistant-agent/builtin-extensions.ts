import type { AssistantBuiltinExtensions } from "./tool-extensions.js";

/** Worker-only composition point. Register shipped factories here, never load them in Host. */
export const builtinAssistantExtensions: AssistantBuiltinExtensions = {};
