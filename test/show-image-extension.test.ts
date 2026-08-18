import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TransientFileRegistry } from "../src/pi/transient-file-registry.js";
import { PiConversationProjector, projectAgentSessionEvents } from "../src/pi/pi-agent-adapter.js";
import { ownCanonicalShowImage, PUBLISHED_FILE_DETAIL_KEY, SHOW_IMAGE_EXTENSION_PATH, showImageExtension } from "../src/pi/show-image-extension.js";

test("show_image publishes path-free metadata while the source file remains the only bytes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alu-dock-show-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "private display.png");
  await writeFile(path, Buffer.from("image bytes"));
  const registry = new TransientFileRegistry();
  let tool: { execute: (id: string, params: { path: string }) => Promise<{ content: unknown; details: Record<string, unknown> }> } | undefined;
  let resultHook: ((event: { toolName: string; details: unknown }) => { isError: true } | undefined) | undefined;
  showImageExtension(registry)({
    registerTool: (registered: unknown) => { tool = registered as typeof tool; },
    on: (event: string, handler: unknown) => { if (event === "tool_result") resultHook = handler as typeof resultHook; },
  } as never);

  const result = await tool!.execute("call-1", { path });
  const metadata = result.details[PUBLISHED_FILE_DETAIL_KEY] as { presentation: "image"; fileRef: string; name: string; sizeBytes: number; mediaType?: string };
  assert.deepEqual(metadata, { presentation: "image", fileRef: metadata.fileRef, name: "private display.png", sizeBytes: 11, mediaType: "image/png" });
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.equal(JSON.stringify(result).includes(Buffer.from("image bytes").toString("base64")), false);
  assert.equal(Buffer.from((await registry.read(metadata.fileRef)).data, "base64").toString(), "image bytes");
  const projected = projectAgentSessionEvents({ type: "tool_execution_end", toolCallId: "call-1", toolName: "show_image", result, isError: false } as never, registry)
    .flatMap((event) => new PiConversationProjector(Buffer.alloc(32, 1)).project(event));
  assert.equal(JSON.stringify(projected).includes(PUBLISHED_FILE_DETAIL_KEY), false);
  assert.equal(JSON.stringify(projected).includes(directory), false);
  assert.match(JSON.stringify(projected), /"presentation":"image"/u);
  await writeFile(path, Buffer.from("other bytes"));
  await assert.rejects(registry.read(metadata.fileRef), /changed and is no longer available/u);

  const invalidPath = await tool!.execute("call-2", { path: "relative.png" });
  assert.deepEqual(resultHook!({ toolName: "show_image", details: invalidPath.details }), { isError: true });
  const failedProjection = projectAgentSessionEvents({ type: "tool_execution_end", toolCallId: "call-2", toolName: "show_image", result: invalidPath, isError: true } as never, registry)
    .flatMap((event) => new PiConversationProjector(Buffer.alloc(32, 1)).project(event));
  assert.match(JSON.stringify(failedProjection), /path must be absolute/u);
  assert.doesNotMatch(JSON.stringify(failedProjection), /older session|relative\.png/u);

  const bmp = join(directory, "unsupported.bmp");
  await writeFile(bmp, Buffer.from("bitmap"));
  const unsupported = await tool!.execute("call-3", { path: bmp });
  assert.match(JSON.stringify(unsupported.content), /format cannot be published/u);
  assert.deepEqual(resultHook!({ toolName: "show_image", details: unsupported.details }), { isError: true });
});

test("Dock resource ownership removes only competing show_image registrations", () => {
  const canonical = { path: SHOW_IMAGE_EXTENSION_PATH, tools: new Map([["show_image", { owner: "dock" }], ["dock_other", {}]]) };
  const user = { path: "/home/user/show-image.ts", tools: new Map([["show_image", { owner: "user" }], ["user_other", {}]]) };
  const result = ownCanonicalShowImage({ extensions: [user, canonical], errors: [] } as never);
  assert.deepEqual([...result.extensions[0]!.tools.keys()], ["user_other"]);
  assert.deepEqual([...result.extensions[1]!.tools.keys()], ["show_image", "dock_other"]);
});
