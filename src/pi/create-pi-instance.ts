import { resolve } from "node:path";

import {
  createAgentSession,
  SessionManager,
  VERSION,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { ManagedInstance } from "../core/managed-instance.js";
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
  const sessionManager = options.sessionDir
    ? SessionManager.create(cwd, resolve(options.sessionDir))
    : SessionManager.create(cwd);

  const sdkOptions: CreateAgentSessionOptions = {
    cwd,
    agentDir: options.agentDir,
    sessionManager,
    tools: options.tools,
    excludeTools: options.excludeTools,
  };
  const result = await createAgentSession(sdkOptions);
  const runtime = new PiRuntimeSession(result.session);
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

  for (const extensionError of result.extensionsResult.errors) {
    instance.recordExtensionError(extensionError);
  }
  if (result.modelFallbackMessage) {
    instance.recordExtensionError(result.modelFallbackMessage);
  }
  if (options.name) result.session.setSessionName(options.name);

  return instance;
}
