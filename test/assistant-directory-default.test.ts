import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SystemService } from "../src/control/system-service.js";
import { createDockSystem } from "../src/control/system-tools.js";
import { createPiSystemTemplateProvider } from "../src/pi/system-template-provider.js";

// Card #295: the creation page remembers "open as the assistant" with the directory's system, the
// Host applies it when the creator does not say, and her own workspace opens Works as her.
test("a directory remembers opening new Works as the assistant, and her workspace does so from the start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-default-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), workspace = join(root, "assistant-workspace");
  await mkdir(project);
  const systems = new SystemService(root, createPiSystemTemplateProvider(join(root, "agent")));

  const first = await systems.catalog(project);
  assert.equal(first.defaultAssistant, undefined);
  assert.equal((await systems.resolveCreation(project)).assistant, false);

  const chosen = first.candidates.find((candidate) => !candidate.warning)!;
  await systems.setDefault(project, chosen.id, true);
  const saved = await systems.catalog(project);
  assert.equal(saved.defaultAssistant, true);
  assert.equal(saved.defaultSelection?.id, chosen.id);
  // Left to the Host, the directory's choice applies; said either way, the creator's word wins.
  assert.equal((await systems.resolveCreation(project)).assistant, true);
  assert.equal((await systems.resolveCreation(project, undefined, false)).assistant, false);
  assert.equal((await systems.resolveCreation(project, chosen.workerConfig)).assistant, true);
  // Saved from a place without the switch (the Hub, an older client), the directory keeps it;
  // switched off, it forgets it.
  await systems.setDefault(project, chosen.id);
  assert.equal((await systems.catalog(project)).defaultAssistant, true);
  await systems.setDefault(project, chosen.id, false);
  assert.equal((await systems.catalog(project)).defaultAssistant, undefined);

  await systems.prepareAssistantWorkspace(workspace);
  const hers = await systems.catalog(workspace);
  assert.equal(hers.defaultAssistant, true);
  assert.equal(hers.defaultSelection, undefined);
  assert.equal((await systems.resolveCreation(workspace)).assistant, true);
  // A default the owner saved there later is kept when the Host starts again.
  await writeFile(join(workspace, ".aludock", "system-default.json"), JSON.stringify({ id: chosen.id }));
  await systems.prepareAssistantWorkspace(workspace);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, ".aludock", "system-default.json"), "utf8")), { id: chosen.id });
});

// Card #295 (decided 2026-11-07): a Work the assistant opens with dock_create is her only when she
// asks for it, whatever the directory's default; the children she spawns never are.
test("Works the assistant opens are her only when she asks, and her children never", async () => {
  const opened: Array<boolean | undefined> = [];
  const port = {
    create: async (...args: unknown[]) => { opened.push(args[7] as boolean | undefined); return { id: "w", cwd: "/work", lifecycle: "active", execution: "idle", executor: {} } as never; },
    systemCatalog: async () => assert.fail("no system is chosen here"),
    systemContent: async () => assert.fail("no system is read here"),
    setSystemDefault: async () => assert.fail("no default is saved here"),
  };
  await createDockSystem(port as never, { type: "create", operationId: "a", cwd: "/work" });
  await createDockSystem(port as never, { type: "create", operationId: "b", cwd: "/work", assistant: true });
  await createDockSystem(port as never, { type: "create", operationId: "c", cwd: "/work", child: { parentId: "parent" } });
  // false overrides the directory's default; a child is left to the Host, which never makes it her.
  assert.deepEqual(opened, [false, true, undefined]);
});
