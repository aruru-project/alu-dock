import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";

import { ExtensionUiBroker } from "../core/extension-ui-broker.js";
import { ManagedInstance } from "../core/managed-instance.js";
import { ProjectTrustCoordinator } from "../control/project-trust.js";
import { createPiRuntimeHost } from "./pi-runtime-host.js";

export interface CreatePiInstanceOptions {
  id?: string;
  creationOperationId?: string;
  hostEpoch?: string;
  name?: string;
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  eventCapacity?: number;
  sessionFile?: string;
  initialRuntimeGeneration?: number;
  createdAt?: string;
  reopenedFrom?: "host_lost" | "runtime_error";
}

/** Create the single Host-owned Pi runtime facade after project trust has been resolved. */
export async function createPiInstance(options: CreatePiInstanceOptions): Promise<ManagedInstance> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const sessionPath = options.sessionFile ? resolve(options.sessionFile) : undefined;
  const reopened = sessionPath
    ? await openValidatedPiSession(sessionPath, options.sessionDir ? resolve(options.sessionDir) : undefined, cwd)
    : undefined;
  if (reopened && reopened.cwd !== cwd) throw new Error(`Pi session working directory changed before runtime construction: ${sessionPath}`);
  const extensionUiBroker = new ExtensionUiBroker();
  const runtime = await createPiRuntimeHost({
    cwd,
    agentDir,
    sessionDir: options.sessionDir ? resolve(options.sessionDir) : undefined,
    tools: options.tools,
    excludeTools: options.excludeTools,
    projectTrusted: options.projectTrusted,
    extensionUiBroker,
    sessionManager: reopened?.manager,
  });
  try {
    const modelState = runtime.getModelState();
    const persistedName = reopened ? runtime.currentSession().sessionManager.getSessionName() : undefined;
    const initialName = options.reopenedFrom ? persistedName : options.name ?? persistedName;
    const instance = new ManagedInstance({
      id: options.id,
      creationOperationId: options.creationOperationId,
      hostEpoch: options.hostEpoch,
      name: initialName,
      cwd,
      session: runtime,
      executor: {
        kind: "pi-sdk",
        version: VERSION,
        model: modelState.model,
        thinkingLevel: modelState.thinkingLevel,
      },
      eventCapacity: options.eventCapacity,
      initialRuntimeGeneration: options.initialRuntimeGeneration,
      createdAt: options.createdAt,
      reopenedFrom: options.reopenedFrom,
      extensionUiBroker,
    });
    runtime.activateInitial();
    instance.synchronizeModelState();
    for (const diagnostic of runtime.diagnostics) {
      const value = diagnostic as { message?: unknown };
      instance.recordExtensionError(typeof value.message === "string" ? value.message : diagnostic);
    }
    if (runtime.modelFallbackMessage) instance.recordExtensionError(runtime.modelFallbackMessage);
    if (options.name && !reopened) runtime.currentSession().setSessionName(options.name);
    return instance;
  } catch (error) {
    await runtime.dispose().catch(() => {});
    throw error;
  }
}

export async function resolvePiReopenTarget(sessionFile: string): Promise<{ cwd: string }> {
  const opened = await openValidatedPiSession(resolve(sessionFile));
  return { cwd: opened.cwd };
}

async function openValidatedPiSession(
  path: string,
  sessionDir?: string,
  cwdOverride?: string,
): Promise<{ cwd: string; manager: SessionManager }> {
  const canonicalPath = await realpath(path).catch(() => undefined);
  if (canonicalPath !== path) throw new Error(`Pi session file is not a real non-symlink path: ${path}`);
  const before = await lstat(path).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error(`Pi session file is not a regular file: ${path}`);
  const getuid = process.getuid;
  if (typeof getuid !== "function" || before.uid !== getuid()) throw new Error(`Pi session file is not owned by the current user: ${path}`);
  const manager = SessionManager.open(path, sessionDir, cwdOverride);
  const after = await lstat(path).catch(() => undefined);
  if (!after?.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid) {
    throw new Error(`Pi session file changed while opening: ${path}`);
  }
  const header = manager.getHeader();
  const cwd = header?.cwd;
  if (!cwd || !isAbsolute(cwd)) throw new Error(`Pi session header has no absolute working directory: ${path}`);
  const canonicalCwd = await realpath(resolve(cwd));
  return { cwd: canonicalCwd, manager };
}

/** Production trust coordinator. Importing this module remains confined to the long-lived server path. */
export function createPiProjectTrustCoordinator(agentDir = resolve(getAgentDir())): ProjectTrustCoordinator {
  const trustStore = new ProjectTrustStore(agentDir);
  return new ProjectTrustCoordinator({
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    savedDecision: (cwd) => trustStore.get(cwd),
    defaultDecision: (cwd) => SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust(),
    remember: (cwd, trusted) => trustStore.set(cwd, trusted),
  });
}
