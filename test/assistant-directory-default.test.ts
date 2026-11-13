import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SystemService } from "../src/control/system-service.js";
import { createPiSystemTemplateProvider } from "../src/pi/system-template-provider.js";

// #670, owner decision 2026-11-13: Alu is one resident assistant, not a kind of Work a
// directory can create. Old defaults must neither clone her nor discard the saved Pi system.
test("an old assistant directory default opens ordinary Works and keeps its selected system", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alu-assistant-default-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(join(project, ".aludock"), { recursive: true });
  const systems = new SystemService(root, createPiSystemTemplateProvider(join(root, "agent")));
  const chosen = (await systems.catalog(project)).candidates.find((candidate) => !candidate.warning)!;
  const file = join(project, ".aludock", "system-default.json");
  await writeFile(file, JSON.stringify({ id: chosen.id, assistant: true }));
  assert.deepEqual(await systems.resolveCreation(project), { workerConfig: chosen.workerConfig, assistant: false });
  assert.equal((await systems.catalog(project)).defaultSelection?.id, chosen.id);
  assert.equal((await systems.catalog(project)).defaultAssistant, undefined);
  await systems.setDefault(project, chosen.id);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { id: chosen.id });

  await writeFile(file, JSON.stringify({ assistant: true }));
  assert.deepEqual(await systems.resolveCreation(project), { assistant: false });
  await assert.rejects(systems.setDefault(project, undefined, true), { code: "invalid_request" });
  await assert.rejects(systems.resolveCreation(project, undefined, true), { code: "invalid_request" });
});
