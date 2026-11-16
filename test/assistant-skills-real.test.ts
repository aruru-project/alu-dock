import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { startNativeTeam } from "./support/native-team.js";
import { waitFor } from "./support/plan-goal-provider.js";

// #671: real Host -> independent assistant Worker -> local provider -> actual read tool.
// Only the provider's replies and a local extension factory are fixtures; no private skills or keys.
test("the assistant discovers manuals, reads one on demand, and sees newly written skills on her next reply and Reload", { timeout: 60_000 }, async context => {
  const team = await startNativeTeam(context, ["coordinator"], { prefix: "alu-assistant-skills-", assistant: true, attachments: true });
  const file = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  const skill = (name: string, description: string, body: string, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
  const fresh = join(team.cwd, ".pi", "skills", "fresh-news", "SKILL.md");
  const manual = join(team.root, "extension", "manual", "SKILL.md");
  const configured = join(team.cwd, "configured", "SKILL.md");
  const standard = join(team.cwd, ".agents", "skills", "review", "SKILL.md");
  const common = join(team.root, "home", ".aludock", "skills", "shared", "SKILL.md");
  const standardUser = join(team.root, "home", ".agents", "skills", "portable", "SKILL.md");
  const hidden = join(team.cwd, ".pi", "skills", "manual-only", "SKILL.md");
  const broken = join(team.root, "extension", "broken", "SKILL.md");
  const collision = join(team.root, "extension", "duplicate", "SKILL.md");
  const missing = join(team.root, "extension", "missing");
  const module = join(team.root, "extension", "tools.mjs");
  const configPath = join(team.cwd, "extensions.json");
  const legacyModule = join(team.root, "legacy-extension", "tools.mjs");
  const legacySkill = join(dirname(legacyModule), "skills", "legacy-guide", "SKILL.md");
  const body = "MANUAL_BODY_671: Ask the owner which day, then call local_schedule. The test appointment is 14:30.";
  await Promise.all([
    file(fresh, skill("fresh-news", "Use for today's news", "WORKSPACE_BODY_671")),
    file(legacyModule, "export default async () => ({ tools: [] });"),
    file(legacySkill, skill("legacy-guide", "Read this existing extension's guide", "LEGACY_EXTENSION_BODY_671")),
    file(manual, skill("local-schedule", "Read before using local_schedule for appointments", body)),
    file(configured, skill("configured-manual", "Use for explicitly configured tasks", "CONFIGURED_BODY_671")),
    file(standard, skill("review", "Review a result", "STANDARD_BODY_671")),
    file(common, skill("shared", "Use for common Dock tasks", "COMMON_BODY_671")),
    file(standardUser, skill("portable", "Use for portable tasks", "PORTABLE_BODY_671")),
    file(hidden, skill("manual-only", "EXPLICIT_ONLY_DESCRIPTION_671", "EXPLICIT_BODY_671", "disable-model-invocation: true\n")),
    file(broken, "---\nname: broken\n---\nMissing required description.\n"),
    file(collision, skill("fresh-news", "Losing description", "LOSING_BODY_671")),
    // A skill under the old Pi user identity must not leak into the independent assistant.
    file(join(team.agentDir, "skills", "legacy", "SKILL.md"), skill("legacy", "OLD_IDENTITY_DESCRIPTION_671", "OLD_IDENTITY_BODY_671")),
    file(join(team.agentDir, "AGENTS.md"), "OLD_PERSONALITY_671"),
  ]);
  await symlink(dirname(manual), join(team.root, "extension", "manual-alias"), process.platform === "win32" ? "junction" : "dir");
  const factory = (description: string) => `export default async () => ({
    skills: ["./manual", "./manual-alias", "./broken", "./duplicate", "./missing"],
    tools: [{ name: "local_schedule", description: ${JSON.stringify(description)}, parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "Appointment: 14:30" }] }) }],
    commands: [{ name: "schedule-status", description: "Show schedule status", execute: () => "Ready" }]
  });`;
  await file(module, factory("Read the local schedule."));
  const settings = [
    { id: "schedule", module, enabled: true, config: {}, skills: ["./configured"] },
    { id: "legacy-extension", module: legacyModule, enabled: true, config: {} },
  ];
  await file(configPath, JSON.stringify(settings));
  const client = await team.startHost();
  const assistant = await team.assistantWork();
  const resources = await client.resources(assistant.id);
  for (const path of [fresh, manual, configured, standard, common, standardUser, hidden, legacySkill]) {
    const resource = resources.resources.find(item => item.path === path);
    assert.ok(resource?.contentRef, `The current manual must be readable from project resources: ${path}`);
    assert.equal(resource.kind, "skill");
  }
  assert.equal(resources.resources.filter(item => item.name === "local-schedule").length, 1, "A link to the same manual must not advertise it twice");
  assert.equal(resources.resources.find(item => item.path === manual)?.source?.package, "schedule");
  assert.equal(resources.resources.find(item => item.path === configured)?.source?.path, configPath);
  assert.equal(resources.resources.find(item => item.path === legacySkill)?.source?.path, legacyModule);
  for (const path of [broken, collision, missing]) assert.ok(resources.diagnostics.some(item => item.source === path));
  assert.ok(resources.diagnostics.some(item => item.message.includes(fresh)), "A duplicate-name diagnostic identifies the selected manual");
  assert.ok((await client.tools(assistant.id)).tools.some(item => item.name === "local_schedule"), "A broken manual leaves its tool available");
  assert.ok((await client.commands(assistant.id)).commands.some(item => item.name === "schedule-status"));
  const ref = resources.resources.find(item => item.path === manual)!.contentRef!;
  assert.ok((await client.resourceContentAll(assistant.id, ref)).text.includes(body));
  // Existing resource read authority: only registered files, never arbitrary client paths.
  await assert.rejects(client.resourceContent(assistant.id, configPath), { code: "resource_unavailable" });

  await client.prompt(assistant.id, "看看今天的日程。", "auto", "skill-read");
  const first = await team.providers.coordinator.request(0);
  const firstRequest = JSON.stringify(first.body);
  for (const text of ["local-schedule", "Read before using local_schedule for appointments", manual, "fresh-news", fresh, common, standardUser, legacySkill, "dock-attachments"]) assert.ok(firstRequest.includes(text), `Missing manual index: ${text}`);
  for (const text of [body, "WORKSPACE_BODY_671", "COMMON_BODY_671", "EXPLICIT_ONLY_DESCRIPTION_671", "EXPLICIT_BODY_671", "OLD_IDENTITY_DESCRIPTION_671", "OLD_PERSONALITY_671"]) assert.ok(!firstRequest.includes(text), `Not part of the automatic opening: ${text}`);
  first.tools({ id: "read-skill", name: "read", arguments: { path: manual } });
  const afterRead = await team.providers.coordinator.request(1);
  assert.ok(JSON.stringify(afterRead.body.messages).includes(body), "The real read tool brings the manual into the following request");
  afterRead.tools({ id: "schedule", name: "local_schedule", arguments: {} });
  const afterTool = await team.providers.coordinator.request(2);
  assert.ok(JSON.stringify(afterTool.body.messages).includes("Appointment: 14:30"));
  afterTool.text("今天的日程是 14:30。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish reading her manual");

  // She or a Work can write a new manual; a normal next reply, not a mandatory Reload, sees it.
  const newSkill = join(team.cwd, ".pi", "skills", "new-task", "SKILL.md");
  await file(newSkill, skill("new-task", "Use for the newly documented task", "NEW_BODY_671"));
  const newExtensionSkill = join(dirname(legacyModule), "skills", "new-guide", "SKILL.md");
  await file(newExtensionSkill, skill("new-guide", "Use for a newly documented extension task", "NEW_EXTENSION_BODY_671"));
  await client.prompt(assistant.id, "继续。", "auto", "new-skill");
  const next = await team.providers.coordinator.request(3);
  assert.ok(JSON.stringify(next.body).includes(newSkill));
  assert.ok(JSON.stringify(next.body).includes(newExtensionSkill));
  assert.ok(!JSON.stringify(next.body).includes("NEW_BODY_671"));
  next.text("新的操作手册也在了。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish her next reply");

  // Reload updates discovered directories, metadata, module declarations and explicit config paths.
  const reloadedSkill = join(team.cwd, ".agents", "skills", "after-reload", "SKILL.md");
  await file(reloadedSkill, skill("after-reload", "Use after the Reload test", "RELOAD_BODY_671"));
  await file(manual, skill("local-schedule", "Updated appointment manual description", "UPDATED_BODY_671"));
  await file(module, factory("Read the updated local schedule."));
  // A malformed configured skills list is diagnosed independently, too.
  await file(configPath, JSON.stringify([{ ...settings[0], skills: "not-an-array" }, { ...settings[1], skills: [] }]));
  await client.reloadSession(assistant.id);
  const reloaded = await client.resources(assistant.id);
  assert.ok(reloaded.resources.some(item => item.path === reloadedSkill));
  assert.ok(!reloaded.resources.some(item => item.path === configured));
  assert.ok(!reloaded.resources.some(item => item.path === legacySkill || item.path === newExtensionSkill), "An explicit empty list disables the conventional extension manuals");
  assert.ok(reloaded.diagnostics.some(item => item.source === configPath));
  assert.ok((await client.resourceContentAll(assistant.id, ref)).text.includes("UPDATED_BODY_671"));
  assert.equal((await client.tools(assistant.id)).tools.find(item => item.name === "local_schedule")?.description, "Read the updated local schedule.");
  await client.prompt(assistant.id, "再看看手册清单。", "auto", "reloaded-skill");
  const reloadedRequest = await team.providers.coordinator.request(4);
  assert.ok(JSON.stringify(reloadedRequest.body).includes("Updated appointment manual description"));
  assert.ok(JSON.stringify(reloadedRequest.body).includes(reloadedSkill));
  assert.ok(!JSON.stringify(reloadedRequest.body).includes("UPDATED_BODY_671"));
  reloadedRequest.text("手册清单已经更新。");
  await waitFor(async () => (await client.status(assistant.id)).execution === "idle", "The assistant did not finish after Reload");
  await file(configPath, "[]");
  await client.reloadSession(assistant.id);
  assert.ok(!(await client.resources(assistant.id)).resources.some(item => item.path === manual));
  await assert.rejects(client.resourceContent(assistant.id, ref), { code: "resource_unavailable" });
});
