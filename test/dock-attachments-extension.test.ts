import assert from "node:assert/strict";
import test from "node:test";

import type { AttachmentAccessRequest, AttachmentAccessResult } from "../src/core/instance-attachments.js";
import { dockAttachmentsExtension } from "../src/pi/dock-attachments-extension.js";

interface Tool { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }

function fakeApi() {
  const tools: Tool[] = [];
  const starts: Array<() => void> = [];
  const active: string[] = [];
  return {
    tools,
    starts,
    api: {
      registerTool: (tool: Tool) => { tools.push(tool); active.push(tool.name); },
      getAllTools: () => tools.map((tool) => ({ name: tool.name, sourceInfo: { kind: "extension", path: "<inline:alu-dock-attachments>" } })),
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active.splice(0, active.length, ...names); },
      on: (event: string, handler: () => void) => { if (event === "session_start") starts.push(handler); },
    },
  };
}

test("Dock attachment extension lists metadata and resolves one private path with copy-first guidance", async () => {
  const attachment = {
    fileId: "123e4567-e89b-42d3-a456-426614174000",
    name: "archive final.zip",
    sizeBytes: 99,
    sha256: "c".repeat(64),
    storedAt: "2026-08-16T00:00:00.000Z",
  };
  const calls: AttachmentAccessRequest[] = [];
  const port = {
    access: async (request: AttachmentAccessRequest): Promise<AttachmentAccessResult> => {
      calls.push(request);
      return request.type === "list"
        ? { type: "list", attachments: [attachment], total: 1, truncated: false }
        : { type: "resolve", attachment, path: "/private/permanent/archive final.zip" };
    },
  };
  const fixture = fakeApi();
  dockAttachmentsExtension(port)(fixture.api as never);
  assert.deepEqual(fixture.tools.map((tool) => tool.name), ["dock_attachment_list", "dock_attachment_resolve"]);

  const listed = await fixture.tools[0]!.execute("call-list", {} as never) as { content: Array<{ text: string }>; details: unknown };
  assert.match(listed.content[0]!.text, /archive final\.zip/u);
  assert.doesNotMatch(JSON.stringify(listed), /private\/permanent/u);

  const resolved = await fixture.tools[1]!.execute("call-resolve", { fileId: attachment.fileId }) as { content: Array<{ text: string }>; details: unknown };
  assert.match(resolved.content[0]!.text, /private\/permanent/u);
  assert.match(resolved.content[0]!.text, /Copy .* before modifying or extracting/u);
  assert.doesNotMatch(JSON.stringify(resolved.details), /private\/permanent/u);
  assert.deepEqual(calls, [{ type: "list" }, { type: "resolve", fileId: attachment.fileId }]);
  assert.match(fixture.tools[1]!.description, /copy .* before modifying or extracting/i);
});
