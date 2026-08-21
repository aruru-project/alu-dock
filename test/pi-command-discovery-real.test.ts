import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandReferenceDto } from "../src/core/config-projection.js";
import { DockClient } from "../src/control/dock-client.js";
import { DockHost } from "../src/control/dock-host.js";
import { DockRegistry } from "../src/control/dock-registry.js";
import { createPiInstance } from "../src/pi/create-pi-instance.js";

const EXTENSION_SOURCE = `
export default function commandDiscoveryFixture(pi) {
  pi.registerCommand("choose-deployment", {
    description: "Choose a deployment target",
    getArgumentCompletions: (prefix) => [
      { value: "staging", label: "staging", description: "Shared test environment" },
      { value: "production", label: "production", description: "Live environment" },
    ].filter((item) => item.value.startsWith(prefix)),
    handler: async () => {},
  });
}
`;

function reference(command: { name: string; source: CommandReferenceDto["source"] }): CommandReferenceDto {
  return { name: command.name, source: command.source };
}

test("a client can understand and inspect unfamiliar commands before using them", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "alu-dock-command-discovery-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const promptsDir = join(agentDir, "prompts");
  const extensionsDir = join(agentDir, "extensions");
  const stateHome = join(root, "state");
  const dataHome = join(root, "data");
  const socketPath = join(root, "dock.sock");
  await Promise.all([
    mkdir(cwd),
    mkdir(sessionDir),
    mkdir(stateHome),
    mkdir(dataHome),
    mkdir(promptsDir, { recursive: true }),
    mkdir(extensionsDir, { recursive: true }),
  ]);
  await chmod(root, 0o700);
  await Promise.all([
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-no-model-call" } })),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o-mini" })),
    writeFile(join(extensionsDir, "command-discovery-fixture.ts"), EXTENSION_SOURCE),
  ]);
  const promptBody = `Explain the deployment idea before changing anything.\n${"Keep the owner informed.\n".repeat(3_000)}`.trim();
  await writeFile(join(promptsDir, "review-deployment.md"), `---\ndescription: Review a deployment idea\nargument-hint: "<idea>"\n---\n${promptBody}\n`);

  const previousPiOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const registry = new DockRegistry(
    (input) => createPiInstance({
      ...input,
      agentDir,
      sessionDir,
      workerEnvironment: {
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
      },
      workerTimeouts: { mutationMs: 5_000, termMs: 300 },
    }),
    () => "command-discovery-instance",
  );
  const host = new DockHost({ socketPath, registry });
  const client = new DockClient({ socketPath, timeoutMs: 5_000 });

  try {
    await host.start();
    const created = await client.create(cwd, "command discovery", "command-discovery-create");
    const catalog = await client.commands(created.id);

    const prompt = catalog.commands.find((command) => command.name === "review-deployment");
    assert.ok(prompt);
    assert.equal(prompt.description, "Review a deployment idea");
    assert.equal(prompt.argumentHint, "<idea>");
    assert.equal(prompt.contentAvailable, true);

    let cursor: string | undefined;
    let inspected = "";
    let revision: string | undefined;
    do {
      const page = await client.commandContent(created.id, reference(prompt), cursor);
      assert.equal(page.available, true);
      assert.equal(page.format, "markdown");
      revision ??= page.revision;
      assert.equal(page.revision, revision);
      inspected += page.text;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.equal(inspected, promptBody);

    const extension = catalog.commands.find((command) => command.name === "choose-deployment");
    assert.ok(extension);
    assert.equal(extension.argumentCompletions, true);
    const completions = await client.commandCompletions(created.id, reference(extension), "st");
    assert.deepEqual(completions.items, [
      { value: "staging", label: "staging", description: "Shared test environment" },
    ]);
    assert.equal(completions.truncated, false);

    const dockTools = catalog.commands.find((command) => command.name === "dock-tools");
    assert.ok(dockTools);
    assert.equal(dockTools.argumentCompletions, true);
    const dockToolsCompletions = await client.commandCompletions(created.id, reference(dockTools), "o");
    assert.deepEqual(dockToolsCompletions.items, [
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
  } finally {
    if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousPiOffline;
    client.closeActiveConnections();
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
