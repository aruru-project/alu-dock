import type { AttachmentAccessRequest, AttachmentAccessResult, AttachmentDto } from "../core/instance-attachments.js";

export const DOCK_ATTACHMENT_TOOL_NAMES = ["dock_attachment_list", "dock_attachment_resolve"] as const;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const RESOLVE_SCHEMA = {
  type: "object",
  properties: { fileId: { type: "string", minLength: 1, maxLength: 128 } },
  required: ["fileId"],
  additionalProperties: false,
};
const COPY_GUIDANCE = "Copy the resolved file into the workspace or a temporary directory before modifying or extracting it; preserve the stored original.";

/** The same attachment tools for every Agent, using only the access granted by its Host. */
export function dockAttachmentTools(access: (request: AttachmentAccessRequest) => Promise<AttachmentAccessResult>) {
  return [
    {
      name: DOCK_ATTACHMENT_TOOL_NAMES[0],
      label: "List Dock attachments",
      description: "List the permanent files uploaded to this single-user Dock. Results contain opaque file IDs and display metadata, never storage paths.",
      parameters: EMPTY_SCHEMA,
      execute: async () => {
        const result = await access({ type: "list" });
        if (result.type !== "list") throw new Error("Dock returned the wrong attachment result");
        return {
          content: [{ type: "text" as const, text: renderList(result.attachments, result.total, result.truncated) }],
          details: result,
        };
      },
    },
    {
      name: DOCK_ATTACHMENT_TOOL_NAMES[1],
      label: "Resolve Dock attachment",
      description: `Resolve one opaque fileId to a Host-local path for Agent use. ${COPY_GUIDANCE}`,
      parameters: RESOLVE_SCHEMA,
      execute: async (_toolCallId: string, params: { fileId: string }) => {
        const result = await access({ type: "resolve", fileId: params.fileId });
        if (result.type !== "resolve") throw new Error("Dock returned the wrong attachment result");
        return {
          content: [{ type: "text" as const, text: `Attachment ${result.attachment.name} is available at ${quotePath(result.path)}. ${COPY_GUIDANCE}` }],
          // Keep the private Host path out of tool details and external DTOs.
          details: { type: "resolve", attachment: result.attachment },
        };
      },
    },
  ];
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
