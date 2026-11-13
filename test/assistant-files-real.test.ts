import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { DockEvent } from "../src/core/managed-instance.js";
import { startNativeTeam } from "./support/native-team.js";
import { waitFor, type HeldChatRequest } from "./support/plan-goal-provider.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const IMAGE_URL = `data:image/png;base64,${PNG.toString("base64")}`;

function toolText(request: HeldChatRequest, id: string): string {
  const messages = request.body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>;
  const message = messages.find((item) => item.role === "tool" && item.tool_call_id === id);
  assert.equal(typeof message?.content, "string", `The model did not receive the result of ${id}`);
  return message!.content as string;
}

function imageUrls(request: HeldChatRequest): string[] {
  return (request.body.messages ?? []).flatMap((message) => Array.isArray(message.content)
    ? message.content.flatMap((block) => block.type === "image_url" ? [block.image_url.url as string] : [])
    : []);
}

// #667, owner 2026-11-13: she may read and search files and attachments herself, but cannot modify
// files or run commands. The one scenario follows real uploads, her Worker, and the model's next
// request. Only the loopback provider's replies are fake; no external model or network is used.
test("the assistant reads and searches files and uploaded text and images herself, and clients can inspect her tools and read the resulting image", { timeout: 60_000 }, async (context) => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-files-", assistant: true, attachments: true });
  const { coordinator } = team.providers;
  const modelsFile = join(team.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  models.providers.coordinator.models[0].input = ["text", "image"];
  await writeFile(modelsFile, JSON.stringify(models));
  await writeFile(join(team.cwd, "schedule.txt"), "first line\nmeeting at 14:30\nlast line\n");
  const textFile = join(team.root, "attachment.txt"), imageFile = join(team.root, "photo.png");
  await writeFile(textFile, "The uploaded note says: bring a blue umbrella.");
  await writeFile(imageFile, PNG);
  const client = await team.startHost();
  const alu = await team.assistantWork();
  const textUpload = await client.uploadFile(textFile, "text/plain", "upload-text", alu.id);
  const imageUpload = await client.uploadFile(imageFile, "image/png", "upload-image", alu.id);
  const textId = textUpload.attachment.fileId, imageId = imageUpload.attachment.fileId;

  const catalog = await client.tools(alu.id);
  assert.equal(catalog.total, 24);
  for (const name of ["read", "ls", "find", "grep", "dock_attachment_list", "dock_attachment_resolve", "assistant_search", "dock_spawn"]) {
    const tool = catalog.tools.find((item) => item.name === name);
    assert.equal(tool?.active, true, `${name} should be listed as available`);
    assert.ok(tool?.description && tool.parameterSchema, `${name} should have its description and parameters`);
  }
  // Owner's explicit read-only scope, not a general file permission or workspace sandbox.
  assert.deepEqual(catalog.tools.filter((tool) => ["bash", "write", "edit", "powershell"].includes(tool.name)), []);
  // Owner confirmed that the list is for inspection; individual tool switches are not offered.
  await assert.rejects(client.setActiveTools(alu.id, ["read"], "alu-change-tools"));

  // The collaboration switch must not disable her own file or attachment access.
  await client.prompt(alu.id, "/dock-tools off", "auto", "alu-tools-off");
  await waitFor(async () => (await client.status(alu.id)).extensionStatus["Dock tools"] === undefined, "The collaboration switch did not turn off");
  const switched = await client.tools(alu.id);
  assert.equal(switched.tools.find((tool) => tool.name === "dock_spawn")?.active, false);
  assert.equal(switched.tools.find((tool) => tool.name === "read")?.active, true);
  assert.equal(switched.tools.find((tool) => tool.name === "dock_attachment_resolve")?.active, true);

  const events: DockEvent[] = [];
  const follower = await client.streamEvents(alu.id, { onEvent: (event) => events.push(event) });
  team.onCleanup = () => follower.close();
  await client.prompt(alu.id, "看看目录里的日程和这两个附件写了什么。", "auto", "alu-files", undefined, [textId, imageId]);
  const asked = await coordinator.request(0);
  assert.deepEqual([...asked.toolNames].sort(), catalog.tools.map((tool) => tool.name).sort(), "The tools clients inspect are the ones the model receives, even with collaboration off");
  assert.deepEqual(imageUrls(asked), [IMAGE_URL], "The uploaded chat image is already vision input before she calls a tool");
  asked.tools(
    { id: "list-files", name: "ls", arguments: { path: "." } },
    { id: "find-files", name: "find", arguments: { pattern: "*.txt", path: "." } },
    { id: "search-files", name: "grep", arguments: { pattern: "meeting", path: "." } },
    { id: "read-file", name: "read", arguments: { path: "schedule.txt", offset: 2, limit: 1 } },
    { id: "list-uploads", name: "dock_attachment_list", arguments: {} },
  );
  const found = await coordinator.request(1);
  assert.match(toolText(found, "list-files"), /schedule\.txt/u);
  assert.match(toolText(found, "find-files"), /schedule\.txt/u);
  assert.match(toolText(found, "search-files"), /schedule\.txt:2:.*meeting at 14:30/u);
  assert.ok(toolText(found, "read-file").startsWith("meeting at 14:30\n"));
  assert.ok(toolText(found, "list-uploads").includes(textId) && toolText(found, "list-uploads").includes(imageId));
  found.tools(
    { id: "resolve-text", name: "dock_attachment_resolve", arguments: { fileId: textId } },
    { id: "resolve-image", name: "dock_attachment_resolve", arguments: { fileId: imageId } },
  );
  const resolved = await coordinator.request(2);
  const textPath = / available at '(.+)'\. Copy/u.exec(toolText(resolved, "resolve-text"))?.[1];
  const imagePath = / available at '(.+)'\. Copy/u.exec(toolText(resolved, "resolve-image"))?.[1];
  assert.ok(textPath && imagePath, "Attachment resolution gives the Agent usable local paths");
  resolved.tools(
    { id: "read-upload", name: "read", arguments: { path: textPath } },
    { id: "read-image", name: "read", arguments: { path: imagePath } },
  );
  const read = await coordinator.request(3);
  assert.equal(toolText(read, "read-upload"), "The uploaded note says: bring a blue umbrella.");
  assert.deepEqual(imageUrls(read), [IMAGE_URL, IMAGE_URL], "Reading the image attachment adds a real image tool result to the model request");
  read.text("日程是 14:30 开会，附件提醒带蓝色雨伞，图片也看到了。");
  await waitFor(async () => (await client.status(alu.id)).execution === "idle", "The assistant did not finish reading");

  const liveImage = events.find((event) => event.type === "tool.completed" && event.data.toolCallId === "read-image");
  assert.ok(liveImage?.type === "tool.completed" && liveImage.data.content?.some((block) => block.type === "image"), "Live tool results carry the image to clients");
  const history = await client.history(alu.id);
  const record = history.entries.find((entry) => entry.source === "tool" && entry.toolCallId === "read-image");
  const image = record?.content.find((block) => block.type === "image");
  assert.ok(image?.type === "image" && image.contentRef, "The saved tool result has a readable image reference");
  const chunks: Buffer[] = [];
  const received = await client.readConversationImage(alu.id, image.contentRef, (chunk) => { chunks.push(Buffer.from(chunk)); });
  assert.equal(received.mimeType, "image/png");
  assert.deepEqual(Buffer.concat(chunks), PNG);
  // Existing public resolve results omit Host-private storage paths; sharing tools must preserve it.
  const publicResolve = history.entries.filter((entry) => entry.source === "tool" && entry.toolName === "dock_attachment_resolve");
  assert.equal(publicResolve.length, 2);
  assert.ok(publicResolve.every((entry) => !JSON.stringify(entry).includes(textPath) && !JSON.stringify(entry).includes(imagePath)));
  follower.close();
  await follower.done;
});
