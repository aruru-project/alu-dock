import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { ControlClientError, DockClient } from "../../src/control/dock-client.js";
import { DockHost } from "../../src/control/dock-host.js";
import { DockRegistry } from "../../src/control/dock-registry.js";
import { FileCatalogStore } from "../../src/control/durable-catalog-store.js";
import { ChildModelsStore } from "../../src/control/child-models.js";
import { ProjectTrustCoordinator } from "../../src/control/project-trust.js";
import { createPiInstance, resolvePiReopenTarget } from "../../src/pi/create-pi-instance.js";
import { ModelServiceProcess } from "../../src/model-service/service-process.js";
import { AssistantServiceProcess } from "../../src/assistant/service-process.js";
import type { ExtractionTiming } from "../../src/assistant/extraction.js";
import { isolatedProcessEnvironment } from "./isolated-process-environment.js";
import { PlanGoalProvider } from "./plan-goal-provider.js";

/**
 * A real Host, real Pi Workers and one scripted model provider per name. The first name is
 * the Pi default. Only provider HTTP replies are fake.
 */
export async function startNativeTeam<Name extends string>(context: TestContext, names: readonly [Name, ...Name[]], options: {
  prefix: string;
  thinkingLevel?: string;
  /** Run Main's model service, as the installed Host does; its Workers then hold no providers. */
  modelService?: boolean;
  /** Pi settings merged over the defaults below. */
  settings?: Record<string, unknown>;
  /** The providers' apiKey in models.json; `${NAME}` reads an environment variable. */
  apiKey?: string;
  /** Variables only the model service gets, such as a key no Worker may hold. */
  serviceEnvironment?: Record<string, string>;
  /** Overrides for every process, such as NO_PROXY. */
  environment?: Record<string, string>;
  /** Run Main's assistant service, so Works can be opened as the assistant (card #295). */
  assistant?: boolean;
  /** Shorter waits for her memory passes. */
  assistantTiming?: Partial<ExtractionTiming>;
}) {
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions"), home = join(root, "home");
  const providers = Object.fromEntries(names.map((name) => [name, new PlanGoalProvider()])) as Record<Name, PlanGoalProvider>;
  const workerPids: number[] = [];
  const environment = isolatedProcessEnvironment(home, {
    PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: root, TEMP: root, TMP: root,
    npm_config_cache: join(home, ".npm"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    ...options.environment,
  });
  const modelService = options.modelService ? new ModelServiceProcess({ agentDir, environment: { ...environment, ...options.serviceEnvironment } }) : undefined;
  const assistantService = options.assistant
    ? new AssistantServiceProcess({ directory: join(root, "assistant"), workspacePath: join(root, "assistant-workspace"), agentDir, environment,
      ...(modelService === undefined ? {} : { models: modelService }), ...(options.assistantTiming === undefined ? {} : { timing: options.assistantTiming }) })
    : undefined;
  const team = {
    root, cwd, agentDir, providers, workerPids, modelService, assistantService,
    registry: undefined as DockRegistry | undefined,
    host: undefined as DockHost | undefined,
    client: undefined as DockClient | undefined,
    /** Runs after a child Work's Worker process started, before Dock lists the child Work. */
    holdNextChild: undefined as (() => Promise<void>) | undefined,
    onCleanup: undefined as (() => void) | undefined,
    async startHost(): Promise<DockClient> {
      await modelService?.start();
      await assistantService?.start();
      const registry = new DockRegistry(async (input) => {
        const instance = await createPiInstance({
          ...input, agentDir, sessionDir,
          onWorkerSpawn: (pid) => workerPids.push(pid),
          workerEnvironment: environment,
          ...(modelService === undefined ? {} : { modelHostPort: modelService }),
          ...(assistantService === undefined ? {} : { assistantHostPort: { request: (request, source, signal) => assistantService.request(request, { ...source, machine: "Main" }, signal) } }),
        });
        const hold = input.child === undefined ? undefined : team.holdNextChild;
        team.holdNextChild = undefined;
        await hold?.();
        return instance;
      }, undefined, {
        catalogStore: new FileCatalogStore(join(root, "catalog.json")),
        reopenTargetResolver: { resolve: resolvePiReopenTarget },
        trustPreflight: new ProjectTrustCoordinator({ requiresTrust: () => true, savedDecision: () => null,
          defaultDecision: () => "ask", remember: () => assert.fail("trust_once must not persist project trust") }),
        assistantAvailable: assistantService !== undefined,
      });
      team.registry = registry;
      team.host = new DockHost({ socketPath: join(root, "dock.sock"), registry, initialize: () => registry.initializeCatalog(), childModels: new ChildModelsStore(root), ...(assistantService === undefined ? {} : { assistant: assistantService }) });
      await team.host.start();
      return team.client = new DockClient({ socketPath: join(root, "dock.sock"), timeoutMs: 5_000, longMutationTimeoutMs: 10_000 });
    },
  };
  context.after(async () => {
    team.onCleanup?.();
    team.client?.closeActiveConnections();
    // A failed test can leave a model request unanswered, and the Host's stop would wait for that turn.
    await Promise.all(Object.values<PlanGoalProvider>(providers).map((provider) => provider.stop()));
    await team.host?.stop().catch(() => {});
    await modelService?.stop();
    await assistantService?.stop();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agentDir, sessionDir, home].map((path) => mkdir(path)));
  const models: Record<string, unknown> = {};
  for (const name of names) models[name] = {
    baseUrl: await providers[name].start(), api: "openai-completions", apiKey: options.apiKey ?? "local-fixture-key",
    models: [{ id: "fixture", name, reasoning: name !== "implementer", input: ["text"], contextWindow: 32_000, maxTokens: 2_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: models }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: names[0], defaultModel: "fixture", defaultThinkingLevel: options.thinkingLevel ?? "high", compaction: { enabled: false }, retry: { enabled: false }, ...options.settings }));
  return team;
}

export async function trustOnce<T>(operation: (trust?: { challengeId: string; decision: "trust_once" }) => Promise<T>): Promise<T> {
  let challengeId: string | undefined;
  await assert.rejects(operation(), (error: unknown) => {
    assert.ok(error instanceof ControlClientError);
    assert.equal(error.code, "project_trust_required");
    assert.equal(typeof error.details?.challengeId, "string");
    challengeId = error.details!.challengeId as string;
    return true;
  });
  return operation({ challengeId: challengeId!, decision: "trust_once" });
}

export function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}
