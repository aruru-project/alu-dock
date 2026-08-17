import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ControlClientError, DockClient } from "./control/dock-client.js";
import { defaultCatalogPath } from "./control/durable-catalog-store.js";
import { ensureHost } from "./control/ensure-host.js";
import type { ProjectTrustChoice } from "./control/project-trust.js";
import { RemoteAccessState, remoteAccessStateRoot } from "./control/remote-access-state.js";
import { AttachmentStorageState, attachmentStorageStateRoot } from "./control/attachment-storage-state.js";
import type { InstanceSnapshot, SessionDto } from "./core/managed-instance.js";
import { requireHumanTarget } from "./human-target.js";
import { runDockHub, type DockHubAction } from "./tui/dock-hub.js";
import { runDockTui } from "./tui/dock-tui.js";
import { selectInstance } from "./tui/select-instance.js";

export interface OpenDockOptions {
  socketPath: string;
  cwd: string;
  mode: "hub" | "continue" | "open" | "new" | "attach";
  name?: string;
  target?: string;
  forceNew?: boolean;
}

/** Human entry point. Only an explicit Hub action or direct Work command may construct a runtime. */
export async function openDock(options: OpenDockOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("The Alu Dock interactive client requires a TTY; run `aludock --help` for non-interactive guidance");
  }

  const cwd = resolve(options.cwd);
  process.stdout.write("Connecting to Alu Dock…\n");
  await ensureHost(options.socketPath);
  const client = new DockClient({ socketPath: options.socketPath });

  let instance: InstanceSnapshot | undefined;
  if (options.mode === "hub") {
    const catalogPath = defaultCatalogPath();
    const remoteAccessState = new RemoteAccessState(remoteAccessStateRoot(catalogPath));
    const attachmentStorageState = new AttachmentStorageState(attachmentStorageStateRoot(catalogPath));
    const action = await runDockHub(client, cwd, remoteAccessState, attachmentStorageState);
    instance = await executeHubAction(client, action);
  } else {
    instance = await resolveWorkInstance(client, {
      mode: options.mode,
      cwd,
      name: options.name,
      target: options.target,
      forceNew: options.forceNew === true,
    });
  }
  if (!instance) {
    process.stdout.write(options.mode === "hub" ? "Left Alu Dock Hub.\n" : "No instance opened.\n");
    return;
  }

  const result = await runDockTui(client, instance);
  if (result.reason === "stopped") {
    const cleanup = result.cleanupErrors?.length
      ? ` Cleanup warnings: ${result.cleanupErrors.join("; ")}`
      : "";
    process.stdout.write(`Stopped ${displayName(result.instance)}.${cleanup}\n`);
  } else if (result.detachTruth === "host_owned") {
    process.stdout.write(
      `Detached from ${displayName(result.instance)}; the instance remains host-owned. Run aludock to return to the Hub.\n`,
    );
  } else if (result.detachTruth === "not_active") {
    process.stdout.write(
      `Detached from ${displayName(result.instance)}; authoritative instance state is ${result.instance.lifecycle}. Run aludock to return to the Hub.\n`,
    );
  } else {
    process.stdout.write(
      `Detached from ${displayName(result.instance)}; current Host ownership/status is unknown and no stop is claimed. Check aludock service status, then run aludock.\n`,
    );
  }
}

async function executeHubAction(
  client: DockClient,
  action: DockHubAction,
): Promise<InstanceSnapshot | undefined> {
  if (action.kind === "exit") return undefined;
  if (action.kind === "attach") return assertAttachable(action.instance);
  if (action.kind === "new") return createWithNotice(client, action.cwd);
  if (action.kind === "reopen") return reopenWithNotice(client, action.instance);
  return adoptWithNotice(client, action.session);
}

async function resolveWorkInstance(
  client: DockClient,
  options: {
    mode: "continue" | "open" | "new" | "attach";
    cwd: string;
    name?: string;
    target?: string;
    forceNew: boolean;
  },
): Promise<InstanceSnapshot | undefined> {
  if (options.mode === "new" || options.forceNew) return createWithNotice(client, options.cwd, options.name);

  if (options.mode === "continue") {
    const candidate = (await client.list("all"))
      .filter((instance) => resolve(instance.cwd) === options.cwd && isContinuable(instance))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    if (!candidate) return createWithNotice(client, options.cwd, options.name);
    if (candidate.lifecycle === "active") return candidate;
    return reopenWithNotice(client, candidate);
  }

  if (options.target !== undefined) {
    const instance = requireHumanTarget(await client.list("all"), options.target);
    if (options.mode === "attach") return assertAttachable(instance);
    if (instance.lifecycle === "active") return instance;
    if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
      return reopenWithNotice(client, instance);
    }
    throw new Error(lifecycleActionError(instance, "open"));
  }

  if (options.mode === "attach") throw new Error("attach requires TARGET; use a full ID, displayed unique prefix, or unique exact name");

  // Explicit `aludock open` keeps the legacy project smart-entry. Bare
  // `aludock` never reaches this path and therefore cannot create/reopen.
  const matching = (await client.list("all"))
    .filter((instance) => instance.lifecycle !== "stopped" && resolve(instance.cwd) === options.cwd)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const active = matching.filter((instance) => instance.lifecycle === "active");
  if (active.length === 1) return active[0];
  if (active.length === 0 && matching.length === 0) return createWithNotice(client, options.cwd, options.name);

  const selection = await selectInstance(active.length > 0 ? active : matching);
  if (selection === "new") return createWithNotice(client, options.cwd, options.name);
  if (selection && selection.lifecycle !== "active") return reopenWithNotice(client, selection);
  return selection;
}

function isContinuable(instance: InstanceSnapshot): boolean {
  return instance.lifecycle === "active"
    || ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable);
}

function assertAttachable(instance: InstanceSnapshot): InstanceSnapshot {
  if (instance.lifecycle === "active") return instance;
  throw new Error(lifecycleActionError(instance, "attach"));
}

function lifecycleActionError(
  instance: InstanceSnapshot,
  action: "attach" | "open",
): string {
  const identity = displayName(instance);
  if ((instance.lifecycle === "host_lost" || instance.lifecycle === "runtime_error") && instance.reopenable) {
    return `${identity} is ${instance.lifecycle} and cannot be attached without a runtime. Use \`aludock open ${instance.id}\` to reopen it, or choose Resume in the Hub.`;
  }
  if (instance.lifecycle === "stopping") return `${identity} is stopping; wait for a terminal state before choosing another action.`;
  if (instance.lifecycle === "stopped") return `${identity} is stopped history and cannot be ${action === "attach" ? "attached" : "opened"}. Adopt its Pi session from the Hub or create a new instance.`;
  return `${identity} is ${instance.lifecycle} and has no reopenable runtime context.`;
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

async function adoptWithNotice(
  client: DockClient,
  session: SessionDto,
): Promise<InstanceSnapshot> {
  process.stdout.write(`Adopting persisted Pi session ${session.sessionFile}…\n`);
  const operationId = randomUUID();
  try {
    return (await client.adopt(session.sessionFile, session.name, operationId)).instance;
  } catch (error) {
    const challenge = projectTrustChallenge(error, operationId);
    if (!challenge) throw error;
    const decision = await askProjectTrust(challenge.cwd);
    return (await client.adopt(session.sessionFile, session.name, operationId, {
      challengeId: challenge.challengeId,
      decision,
    })).instance;
  }
}

async function reopenWithNotice(
  client: DockClient,
  record: InstanceSnapshot,
): Promise<InstanceSnapshot> {
  if (!record.reopenable) throw new Error(`Instance ${record.id} is ${record.lifecycle} and has no session context to reopen`);
  process.stdout.write(`Reopening ${displayName(record)} from its persisted Pi session context…\n`);
  const operationId = randomUUID();
  try {
    return (await client.reopen(record.id, operationId)).instance;
  } catch (error) {
    const challenge = projectTrustChallenge(error, operationId);
    if (!challenge) throw error;
    const decision = await askProjectTrust(challenge.cwd);
    return (await client.reopen(record.id, operationId, undefined, {
      challengeId: challenge.challengeId,
      decision,
    })).instance;
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
  return instance.displayName;
}

function terminalSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim() || "—";
}
