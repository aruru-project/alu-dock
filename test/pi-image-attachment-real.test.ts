import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AttachmentService } from "../src/control/attachment-service.js";
import { AttachmentStorageState } from "../src/control/attachment-storage-state.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import type { DockEvent } from "../src/core/managed-instance.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("an uploaded image attached to chat reaches Pi as vision input and remains an attachment", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-image-attachment-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const workspace = join(root, "workspace");
  const socketPath = join(root, "dock.sock");
  const imagePath = join(root, "photo.png");
  await Promise.all([
    mkdir(join(agentDir, "extensions"), { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    writeFile(imagePath, ONE_PIXEL_PNG),
  ]);
  await chmod(root, 0o700);
  await writeFile(join(agentDir, "extensions", "capture-image-input.ts"), `
export default function (pi) {
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("look at the upload")) return { action: "continue" };
    const images = event.images ?? [];
    const attachmentPresent = event.text.includes("alu_dock_attachments_v1") && event.text.includes("photo.png");
    ctx.ui.notify("vision=" + images.length + ";mime=" + (images[0]?.mimeType ?? "none") + ";attachment=" + attachmentPresent, "info");
    return { action: "handled" };
  });
}
`, "utf8");

  const attachmentState = new AttachmentStorageState(join(root, "state"), join(root, "attachments"));
  const attachmentService = new AttachmentService(attachmentState);
  const registry = new DockRegistry(async (input) => createPiInstance({
    id: input.id,
    creationOperationId: input.creationOperationId,
    hostEpoch: input.hostEpoch,
    cwd: input.cwd,
    name: input.name,
    projectTrusted: true,
    agentDir,
    sessionDir,
    dockToolsHostPort: input.dockToolsHostPort,
    attachmentHostPort: input.attachmentHostPort,
    dockToolsEnabled: input.dockToolsEnabled,
  }), () => "image-attachment-instance", { attachmentHostPort: attachmentService });
  const host = new DockHost({ socketPath, registry, attachmentService });
  context.after(async () => {
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await host.start();

  const client = new DockClient({ socketPath });
  const instance = await client.create(workspace, "Image attachment", "create-image-work");
  const uploaded = await client.uploadFile(instance.id, imagePath, "image/png", "upload-image");
  const events: DockEvent[] = [];
  const follower = await client.streamEvents(instance.id, { onEvent: (event) => events.push(event) });
  try {
    await client.prompt(instance.id, "look at the upload", "auto", "send-image", undefined, [uploaded.attachment.fileId]);
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.type === "extension.notification"); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const notification = events.find((event): event is Extract<DockEvent, { type: "extension.notification" }> => event.type === "extension.notification");
    assert.equal(notification?.data.message, "vision=1;mime=image/png;attachment=true");
  } finally {
    follower.close();
    await follower.done;
  }
});
