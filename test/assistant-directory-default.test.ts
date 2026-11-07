import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SystemService } from "../src/control/system-service.js";
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
  // Saving the system without the switch forgets the assistant default.
  await systems.setDefault(project, chosen.id);
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
