import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";
import { isolatedProcessEnvironment } from "./support/isolated-process-environment.js";

test("project resources open their full current files, including global resources and system files, without Reload", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-resource-read-"));
  const cwd = join(root, "project");
  const otherCwd = join(root, "other-project");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([cwd, otherCwd, sessionDir, join(root, "state"), join(root, "data"), join(cwd, ".pi"), join(agentDir, "prompts"), join(agentDir, "skills", "reading")].map((path) => mkdir(path, { recursive: true })));
  await chmod(root, 0o700);
  const skill = join(agentDir, "skills", "reading", "SKILL.md");
  const prompt = join(agentDir, "prompts", "reading.md");
  const context = join(cwd, "AGENTS.md");
  const system = join(cwd, ".pi", "SYSTEM.md");
  const append = join(agentDir, "APPEND_SYSTEM.md");
  const files = new Map([
    [skill, "---\nname: reading\ndescription: Read project documents\n---\n# Reading skill\nOriginal skill.\n"],
    [prompt, "---\ndescription: Reading prompt\n---\n# Reading prompt\nOriginal prompt.\n"],
    [context, "# Project instructions\nOriginal context.\n"],
    [system, "# Project system\nOriginal system.\n"],
    [append, "# Global appended system\nOriginal append.\n"],
  ]);
  await Promise.all([
    ...[...files].map(([path, text]) => writeFile(path, text)),
    writeFile(join(otherCwd, "AGENTS.md"), "# Other project\nDifferent instructions.\n"),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" })),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-model-call" } })),
  ]);
  const registry = new DockRegistry((input) => createPiInstance({
    ...input, agentDir, sessionDir,
    workerEnvironment: isolatedProcessEnvironment(root, { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") }),
    workerTimeouts: { mutationMs: 5_000, termMs: 300 },
  }));
  const socketPath = join(root, "dock.sock");
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 5_000 });
  const readAll = async (instanceId: string, contentRef: string) => (await client.resourceContentAll(instanceId, contentRef)).text;
  try {
    await host.start();
    const work = await client.create(cwd);
    const catalog = await client.resources(work.id);
    const reference = (path: string) => {
      const resource = catalog.resources.find((item) => item.path === path);
      assert.ok(resource?.contentRef, `Listed resource must open: ${path}`);
      return resource.contentRef;
    };
    for (const [path, original] of files) {
      assert.equal(await readAll(work.id, reference(path)), original);
      const current = `${original}\nExternally edited, not reloaded.\n`;
      await writeFile(path, current);
      assert.equal(await readAll(work.id, reference(path)), current);
    }
    // Raw frontmatter, BOM and multibyte text must survive pages, not just the preview.
    const longBody = `\ufeff---\ndescription: Current disk prompt\n---\n${"中文 😀 café\n".repeat(9_000)}`;
    await writeFile(prompt, longBody);
    assert.equal(await readAll(work.id, reference(prompt)), longBody);
    const firstPage = await client.resourceContent(work.id, reference(prompt));
    assert.ok(firstPage.nextOffset);
    await appendFile(prompt, "Changed during reading.\n");
    await assert.rejects(client.resourceContent(work.id, reference(prompt), firstPage.nextOffset, firstPage.revision), { code: "resource_unavailable" });
    await writeFile(context, "");
    assert.equal(await readAll(work.id, reference(context)), "");
    await rm(skill);
    await assert.rejects(client.resourceContent(work.id, reference(skill)), { code: "resource_unavailable" });
    // Registered resources are the read authority, not arbitrary file references.
    await assert.rejects(client.resourceContent(work.id, join(agentDir, "auth.json")), { code: "resource_unavailable" });
    const other = await client.create(otherCwd);
    await assert.rejects(client.resourceContent(other.id, reference(context)), { code: "resource_unavailable" });
    const otherResources = await client.resources(other.id);
    const otherContext = otherResources.resources.find((item) => item.path === join(otherCwd, "AGENTS.md"));
    assert.ok(otherContext?.contentRef);
    assert.equal(await readAll(other.id, otherContext.contentRef), "# Other project\nDifferent instructions.\n");
  } finally {
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
