import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { dockAttachmentTools, DOCK_ATTACHMENT_TOOL_NAMES } from "../worker/dock-attachment-tools.js";
import type { DockAttachmentCallPort } from "./dock-attachment-access.js";

const EXTENSION_PATH = "<inline:alu-dock-attachments>";
const TOOL_NAMES = new Set<string>(DOCK_ATTACHMENT_TOOL_NAMES);

export function dockAttachmentsExtension(port: DockAttachmentCallPort): ExtensionFactory {
  return (pi) => {
    for (const tool of dockAttachmentTools((request) => port.access(request))) pi.registerTool(tool as never);

    pi.on("session_start", (_event, ctx) => {
      const collision = pi.getAllTools().find((tool) => TOOL_NAMES.has(tool.name)
        && tool.sourceInfo.path !== EXTENSION_PATH);
      if (!collision) return;
      pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name)));
      ctx.ui.notify(`Dock attachment tools are unavailable because ${collision.name} is already registered.`, "error");
    });
  };
}
