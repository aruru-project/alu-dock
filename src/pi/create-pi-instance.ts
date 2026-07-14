import { join, resolve } from "node:path";

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { ManagedInstance } from "../core/managed-instance.js";
import { configurePiNetwork } from "./configure-pi-network.js";
import { PiRuntimeSession } from "./pi-runtime-session.js";

export interface CreatePiInstanceOptions {
  id?: string;
  name?: string;
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  eventCapacity?: number;
}

/**
 * Create one fixed Pi AgentSession owned by one Alu Dock instance.
 *
 * The instance identity is intentionally separate from Pi's session ID. V0
 * binds extensions in print/headless mode so session lifecycle hooks run while
 * interactive UI calls fail closed instead of waiting for a client.
 */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const cwd = resolve(options.cwd);
  const agentDir = options.agentDir ? resolve(options.agentDir) : undefined;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  configurePiNetwork(settingsManager);
  const sessionManager = options.sessionDir
    ? SessionManager.create(cwd, resolve(options.sessionDir))
    : SessionManager.create(cwd);

  const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
  const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
  const sdkOptions: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    tools: options.tools,
    excludeTools: options.excludeTools,
  };
  const result = await createAgentSession(sdkOptions);
  const runtime = new PiRuntimeSession(result.session, modelRegistry);
  const model = result.session.model
    ? { provider: result.session.model.provider, id: result.session.model.id }
    : undefined;
  const instance = new ManagedInstance({
    id: options.id,
    name: options.name,
    cwd,
    session: runtime,
    executor: {
      kind: "pi-sdk",
      version: VERSION,
      model,
      thinkingLevel: result.session.thinkingLevel,
    },
    eventCapacity: options.eventCapacity,
  });

  try {
    await result.session.bindExtensions({
      mode: "print",
      onError: (error) => instance.recordExtensionError(error),
    });
  } catch (error) {
    instance.recordExtensionError(error);
    await instance.stop();
    throw error;
  }

  // session_start extensions may select a model or thinking level.
  instance.synchronizeModelState();

  for (const extensionError of result.extensionsResult.errors) {
    instance.recordExtensionError(extensionError);
  }
  if (result.modelFallbackMessage) {
    instance.recordExtensionError(result.modelFallbackMessage);
  }
  if (options.name) result.session.setSessionName(options.name);

  return instance;
}
