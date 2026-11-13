/**
 * How a Worker reaches the Host's attachment store, and what the conversation shows of a
 * resolved attachment in place of its Host-local path.
 */
import type { AttachmentAccessRequest, AttachmentAccessResult } from "../core/instance-attachments.js";

export const DOCK_ATTACHMENT_RESOLVE_TOOL = "dock_attachment_resolve";

export interface DockAttachmentCallPort {
  access(request: AttachmentAccessRequest): Promise<AttachmentAccessResult>;
}

export function redactDockAttachmentToolResult(toolName: string | undefined, text: string): string {
  if (toolName !== DOCK_ATTACHMENT_RESOLVE_TOOL) return text;
  return "Dock attachment resolved. The Host-local path was disclosed privately to the Agent and is omitted from external conversation projections.";
}
