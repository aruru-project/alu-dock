import type { ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

import { PublishedFileUnavailableError } from "../core/published-file.js";
import { PUBLISHED_FILE_DETAIL_KEY, PUBLISHED_FILE_FAILURE_DETAIL_KEY, publishedFileFailureFromDetails, SHOW_IMAGE_TOOL_NAME } from "./show-image-result.js";
import { TransientFileRegistry } from "./transient-file-registry.js";

export const SHOW_IMAGE_EXTENSION_PATH = "<inline:alu-dock-show-image>";

const PARAMETERS = {
  type: "object",
  properties: { path: { type: "string", minLength: 1, maxLength: 16_384 } },
  required: ["path"],
  additionalProperties: false,
};

/** Canonical Dock-owned display tool. The source file remains the only copy of its bytes. */
export function showImageExtension(registry: TransientFileRegistry): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: SHOW_IMAGE_TOOL_NAME,
      label: "Show image",
      description: "Publish a local image file for the connected user interface to display. Use read when you need to inspect an image yourself.",
      parameters: PARAMETERS,
      execute: async (_toolCallId: string, params: { path: string }) => {
        try {
          const published = await registry.publish(params.path);
          return {
            content: [{ type: "text", text: `Published ${published.name} for display.` }],
            details: { [PUBLISHED_FILE_DETAIL_KEY]: published },
          };
        } catch (error) {
          if (!(error instanceof PublishedFileUnavailableError)) throw error;
          return {
            content: [{ type: "text", text: error.message }],
            details: { [PUBLISHED_FILE_FAILURE_DETAIL_KEY]: { failureRef: registry.registerFailure(error.message) } },
          };
        }
      },
    } as never);
    pi.on("tool_result", (event) => {
      if (event.toolName !== SHOW_IMAGE_TOOL_NAME || publishedFileFailureFromDetails(event.details, registry) === undefined) return undefined;
      return { isError: true };
    });
  };
}

/** Pi's public resource override gives Dock explicit ownership without depending on user extension files. */
export function ownCanonicalShowImage(base: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...base,
    extensions: base.extensions.map((extension) => {
      if (extension.path === SHOW_IMAGE_EXTENSION_PATH || !extension.tools.has(SHOW_IMAGE_TOOL_NAME)) return extension;
      const tools = new Map(extension.tools);
      tools.delete(SHOW_IMAGE_TOOL_NAME);
      return { ...extension, tools };
    }),
  };
}
