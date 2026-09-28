import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import { DockClient } from "../../src/control/dock-client.js";
import { AttachmentService } from "../../src/control/attachment-service.js";
import { AttachmentStorageState } from "../../src/control/attachment-storage-state.js";
import { SystemService } from "../../src/control/system-service.js";
import { ManagedInstance } from "../../src/core/managed-instance.js";
import { TransientFileRegistry } from "../../src/pi/transient-file-registry.js";
import { DelayedAgentWorkerConnection } from "../support/delayed-agent-worker.js";

test("official Rust client uploads and continuously reads authorized files through the real Host", { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-rust-files-"));
  const cwd = join(root, "work"), source = join(cwd, "file.png");
  await mkdir(cwd);
  await writeFile(source, "a".repeat(900_000));
  const publishedRegistry = new TransientFileRegistry();
  const published = await publishedRegistry.publish(source);
  const worker = new DelayedAgentWorkerConnection("file-fixture");
  worker.publishedFileSource = (ref) => { const { dto: file, source } = publishedRegistry.resolve(ref); return { kind: "published", file, source }; };
  worker.resourceFileSource = (ref) => { assert.equal(ref, "resource-fixture"); return { kind: "resource", path: source }; };
  const attachments = new AttachmentService(new AttachmentStorageState(join(root, "state"), join(root, "attachments")));
  const systems = new SystemService(join(root, "home"), {
    nativeSources: () => [{ kind: "project-system", path: source }], initialTemplate: () => "{}", validate: () => {}, hasExplicitSelection: () => false, workerConfig: () => ({}),
  });
  const registry = new DockRegistry(async (input) => new ManagedInstance({ ...input, session: worker }), undefined, { attachmentHostPort: attachments, systemService: systems });
  const host = new DockHost({ socketPath: join(root, "dock.sock"), registry, attachmentService: attachments });
  const client = new DockClient({ socketPath: host.socketPath });
  try {
    await host.start();
    const instance = await client.create(cwd);
    const delivery = await registry.get(instance.id).registerDeliverable(source);
    const catalog = await client.systemCatalog(cwd);
    const system = catalog.candidates.find((item) => item.path === source)!;
    const descriptor = join(root, "descriptor.json");
    await writeFile(descriptor, JSON.stringify({ identity: join(root, "client"), instanceId: instance.id, source, output: join(root, "received"), published, deliveryRef: delivery.deliveryRef, cwd, systemId: system.id }));
    const binary = resolve(process.env.CARGO_TARGET_DIR ?? "clients/official/target", "debug/examples/protocol_files");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, reject) => {
      const child = spawn(binary, [host.socketPath, descriptor], { env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), PI_CODING_AGENT_DIR: join(root, "pi"), TMPDIR: root }, stdio: ["ignore", "pipe", "pipe"], signal: context.signal });
      let stdout = "", stderr = "";
      child.stdout.on("data", (bytes) => { stdout += String(bytes); }); child.stderr.on("data", (bytes) => { stderr += String(bytes); });
      child.once("error", reject); child.once("exit", (code) => resolveChild({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /five continuous reads verified 900000 bytes/);
    assert.equal((await readFile(join(root, "received"))).length, 900_000);
  } finally { client.closeActiveConnections(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
