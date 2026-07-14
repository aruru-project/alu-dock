import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ControlClientError, DockClient } from "./control/dock-client.js";
import { ensureHost } from "./control/ensure-host.js";
import type { InstanceSnapshot } from "./core/managed-instance.js";
import { runDockTui } from "./tui/dock-tui.js";
import { selectInstance } from "./tui/select-instance.js";
import type { ProjectTrustChoice } from "./control/project-trust.js";

export interface OpenDockOptions {
  socketPath: string;
  cwd: string;
  name?: string;
  instanceId?: string;
  forceNew?: boolean;
}

/** Human entry point: ensure a host, choose/create an instance, then attach a thin TUI. */
export async function openDock(options: OpenDockOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("The Alu Dock interactive client requires a TTY; use --help for JSON commands");
  }

  const cwd = resolve(options.cwd);
  process.stdout.write("Connecting to Alu Dock…\n");
  const ensured = await ensureHost(options.socketPath);
  if (ensured.started) {
    process.stdout.write(`Host started in the background (pid ${ensured.ping.pid}, log ${ensured.logPath}).\n`);
  }

  const client = new DockClient({ socketPath: options.socketPath });
  const instance = await resolveInstance(client, {
    cwd,
    name: options.name,
    instanceId: options.instanceId,
    forceNew: options.forceNew === true,
  });
  if (!instance) {
    process.stdout.write("No instance opened.\n");
    return;
  }

  const result = await runDockTui(client, instance);
  if (result.reason === "stopped") {
    const cleanup = result.cleanupErrors?.length
      ? ` Cleanup warnings: ${result.cleanupErrors.join("; ")}`
      : "";
    process.stdout.write(`Stopped ${displayName(result.instance)}.${cleanup}\n`);
  } else {
    process.stdout.write(
      `Detached from ${displayName(result.instance)}; the instance remains host-owned. Run alu-dock again to reconnect.\n`,
    );
  }
}

async function resolveInstance(
  client: DockClient,
  options: {
    cwd: string;
    name?: string;
    instanceId?: string;
    forceNew: boolean;
  },
): Promise<InstanceSnapshot | undefined> {
  if (options.instanceId) {
    const instance = await client.status(options.instanceId);
    if (instance.lifecycle !== "active") {
      throw new Error(`Instance ${options.instanceId} is ${instance.lifecycle}`);
    }
    return instance;
  }

  if (options.forceNew) return createWithNotice(client, options.cwd, options.name);

  const active = (await client.list())
    .filter((instance) => instance.lifecycle === "active" && resolve(instance.cwd) === options.cwd)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (active.length === 0) return createWithNotice(client, options.cwd, options.name);
  if (active.length === 1) return active[0];

  const selection = await selectInstance(active);
  if (selection === "new") return createWithNotice(client, options.cwd, options.name);
  return selection;
}

async function createWithNotice(
  client: DockClient,
  cwd: string,
  name?: string,
): Promise<InstanceSnapshot> {
  process.stdout.write(`Creating a Pi session for ${cwd}…\n`);
  const operationId = randomUUID();
  try {
    return await client.create(cwd, name, operationId);
  } catch (error) {
    const challenge = projectTrustChallenge(error, operationId);
    if (!challenge) throw error;
    const decision = await askProjectTrust(challenge.cwd);
    return client.create(cwd, name, operationId, {
      challengeId: challenge.challengeId,
      decision,
    });
  }
}

function projectTrustChallenge(
  error: unknown,
  operationId: string,
): { challengeId: string; cwd: string } | undefined {
  if (!(error instanceof ControlClientError) || error.code !== "project_trust_required") return undefined;
  const details = error.details;
  const challengeId = details?.challengeId;
  const challengeOperationId = details?.operationId;
  const cwd = details?.cwd;
  if (
    typeof challengeId !== "string"
    || challengeOperationId !== operationId
    || typeof cwd !== "string"
  ) {
    throw new Error("Host returned an invalid project trust challenge");
  }
  return { challengeId, cwd };
}

async function askProjectTrust(cwd: string): Promise<ProjectTrustChoice> {
  process.stdout.write(
    `Project-local Pi resources were found in ${cwd}.\n`
      + "  1) Trust once\n"
      + "  2) Trust and remember\n"
      + "  3) Do not trust once (continue without project resources)\n"
      + "  4) Do not trust and remember\n",
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question("Project trust choice [1-4]: ")).trim();
      if (answer === "1") return "trust_once";
      if (answer === "2") return "trust_and_remember";
      if (answer === "3") return "deny_once";
      if (answer === "4") return "deny_and_remember";
      process.stdout.write("Enter 1, 2, 3, or 4.\n");
    }
  } finally {
    prompt.close();
  }
}

function displayName(instance: InstanceSnapshot): string {
  return instance.name ? `${instance.name} (${instance.id.slice(0, 8)})` : instance.id.slice(0, 8);
}
