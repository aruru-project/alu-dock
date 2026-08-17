import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type {
  AttachmentAccessRequest,
  AttachmentAccessResult,
  AttachmentDto,
} from "../core/instance-attachments.js";

export const DOCK_ATTACHMENT_TOOL_NAMES = ["dock_attachment_list", "dock_attachment_resolve"] as const;
export const DOCK_ATTACHMENT_RESOLVE_TOOL = "dock_attachment_resolve";
const EXTENSION_PATH = "<inline:alu-dock-attachments>";
const TOOL_NAMES = new Set<string>(DOCK_ATTACHMENT_TOOL_NAMES);
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const RESOLVE_SCHEMA = {
  type: "object",
  properties: { fileId: { type: "string", minLength: 1, maxLength: 128 } },
  required: ["fileId"],
  additionalProperties: false,
};
const COPY_GUIDANCE = "Copy the resolved file into the workspace or a temporary directory before modifying or extracting it; preserve the stored original.";

export interface DockAttachmentCallPort {
  access(request: AttachmentAccessRequest): Promise<AttachmentAccessResult>;
}

export function dockAttachmentsExtension(port: DockAttachmentCallPort): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "dock_attachment_list",
      label: "List Dock attachments",
      description: "List the permanent files uploaded to this single-user Dock. Results contain opaque file IDs and display metadata, never storage paths.",
      parameters: EMPTY_SCHEMA,
      execute: async () => {
        const result = await port.access({ type: "list" });
        if (result.type !== "list") throw new Error("Dock returned the wrong attachment result");
        return {
          content: [{ type: "text", text: renderList(result.attachments, result.total, result.truncated) }],
          details: result,
        };
      },
    } as never);
    pi.registerTool({
      name: DOCK_ATTACHMENT_RESOLVE_TOOL,
      label: "Resolve Dock attachment",
      description: `Resolve one opaque fileId to a Host-local path for Agent use. ${COPY_GUIDANCE}`,
      parameters: RESOLVE_SCHEMA,
      execute: async (_toolCallId: string, params: { fileId: string }) => {
        const result = await port.access({ type: "resolve", fileId: params.fileId });
        if (result.type !== "resolve") throw new Error("Dock returned the wrong attachment result");
        return {
          content: [{ type: "text", text: `Attachment ${result.attachment.name} is available at ${quotePath(result.path)}. ${COPY_GUIDANCE}` }],
          // Keep the private Host path out of extension details and external DTOs.
          details: { type: "resolve", attachment: result.attachment },
        };
      },
    } as never);

    pi.on("session_start", (_event, ctx) => {
      const collision = pi.getAllTools().find((tool) => TOOL_NAMES.has(tool.name)
        && tool.sourceInfo.path !== EXTENSION_PATH);
      if (!collision) return;
      pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name)));
      ctx.ui.notify(`Dock attachment tools are unavailable because ${collision.name} is already registered.`, "error");
    });
  };
}

export function redactDockAttachmentToolResult(toolName: string | undefined, text: string): string {
  if (toolName !== DOCK_ATTACHMENT_RESOLVE_TOOL) return text;
  return "Dock attachment resolved. The Host-local path was disclosed privately to the Agent and is omitted from external conversation projections.";
}

function renderList(attachments: readonly AttachmentDto[], total: number, truncated: boolean): string {
  if (attachments.length === 0) return "No Dock attachments are stored.";
  const lines = attachments.map((attachment) => {
    const media = attachment.mediaType ? ` · ${attachment.mediaType}` : "";
    return `- ${attachment.fileId} · ${attachment.name} · ${attachment.sizeBytes} bytes${media} · SHA-256 ${attachment.sha256}`;
  });
  if (truncated) lines.push(`… ${total - attachments.length} more attachment(s) are not shown.`);
  return [`Stored Dock attachments (${attachments.length}/${total}):`, ...lines].join("\n");
}

function quotePath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
