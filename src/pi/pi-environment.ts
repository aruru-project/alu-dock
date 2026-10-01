import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createAgentSessionServices,
  DefaultPackageManager,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { configurePiNetwork } from "./configure-pi-network.js";
import { projectPiModelList, type PiModelListBody } from "./pi-model-list.js";

export type PiLoginInteraction = Parameters<ModelRuntime["login"]>[2];
export type PiLoginType = Parameters<ModelRuntime["login"]>[1];

export interface PiEnvironmentProvider {
  id: string;
  name: string;
  modelCount: number;
  configured: boolean;
  accessLabel?: string;
  storedCredentialType?: "api_key" | "oauth";
  apiKey?: { name: string; canLogin: boolean };
  oauth?: { name: string; loginLabel?: string };
}

export interface PiEnvironmentModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface PiEnvironmentSnapshot {
  agentDir: string;
  defaultModel?: { provider: string; id: string };
  providers: PiEnvironmentProvider[];
  models: PiEnvironmentModel[];
  diagnostics: string[];
}

export interface PiEnvironmentOptions {
  agentDir?: string;
}

const PI_MODEL_UPDATE_TIMEOUT_MS = 15_000;

/** Refresh Pi's persisted upstream model catalogs without replacing the bundled Pi runtime. */
export async function updatePiModelCatalog(options: PiEnvironmentOptions = {}): Promise<{ agentDir: string }> {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PI_MODEL_UPDATE_TIMEOUT_MS);
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      signal: controller.signal,
    });
    const result = await runtime.refresh({
      allowNetwork: true,
      force: true,
      signal: controller.signal,
    });
    if (result.aborted) throw new Error("Model catalog update timed out");
    if (result.errors.size > 0) {
      const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
      throw new Error(`Pi could not update its model catalogs: ${details}`);
    }
    return { agentDir };
  } finally {
    clearTimeout(timeout);
  }
}

/** Read Pi's own global settings, packages, providers, models, and credential metadata. */
export async function inspectPiEnvironment(options: PiEnvironmentOptions = {}): Promise<PiEnvironmentSnapshot> {
  const environment = await openPiEnvironment(options);
  const { agentDir, settings, runtime, diagnostics } = environment;
  try {
    const credentials = new Map((await runtime.listCredentials()).map((item) => [item.providerId, item.type]));
    const models = runtime.getModels().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
    })).sort(compareModel);
    const modelCounts = new Map<string, number>();
    for (const model of models) modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
    const providers = runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const storedCredentialType = credentials.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        modelCount: modelCounts.get(provider.id) ?? 0,
        configured: status.configured,
        ...(status.label === undefined ? {} : { accessLabel: status.label }),
        ...(storedCredentialType === undefined ? {} : { storedCredentialType }),
        ...(provider.auth.apiKey === undefined ? {} : {
          apiKey: { name: provider.auth.apiKey.name, canLogin: provider.auth.apiKey.login !== undefined },
        }),
        ...(provider.auth.oauth === undefined ? {} : {
          oauth: {
            name: provider.auth.oauth.name,
            ...(provider.auth.oauth.loginLabel === undefined ? {} : { loginLabel: provider.auth.oauth.loginLabel }),
          },
        }),
      } satisfies PiEnvironmentProvider;
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    return {
      agentDir,
      ...(defaultProvider === undefined || defaultModelId === undefined ? {} : { defaultModel: { provider: defaultProvider, id: defaultModelId } }),
      providers,
      models,
      diagnostics: [...diagnostics, ...(runtime.getError() === undefined ? [] : [runtime.getError() as string])],
    };
  } finally {
    environment.close();
  }
}

/**
 * The models a new Work on this computer can select, in the same list shape a Work reports.
 * It applies Pi's process-wide network setup like a Worker, so call it only from its own process.
 */
export async function listAvailablePiModels(options: PiEnvironmentOptions = {}): Promise<PiModelListBody> {
  const environment = await openPiEnvironment(options);
  try {
    configurePiNetwork(environment.settings);
    return projectPiModelList(await environment.runtime.getAvailable());
  } finally {
    environment.close();
  }
}

/** Run the provider-owned Pi login flow and let Pi persist the resulting credential in auth.json. */
export async function loginPiProvider(
  providerId: string,
  type: PiLoginType,
  interaction: PiLoginInteraction,
  options: PiEnvironmentOptions = {},
): Promise<void> {
  const environment = await openPiEnvironment(options);
  const { runtime } = environment;
  try {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error("That Pi provider is no longer available");
    if (type === "api_key" && provider.auth.apiKey?.login === undefined) throw new Error("That Pi provider does not offer API-key setup");
    if (type === "oauth" && provider.auth.oauth === undefined) throw new Error("That Pi provider does not offer sign-in");
    await runtime.login(providerId, type, interaction);
  } finally {
    environment.close();
  }
}

/** Remove the provider credential through Pi's native credential operation. */
export async function logoutPiProvider(providerId: string, options: PiEnvironmentOptions = {}): Promise<void> {
  const environment = await openPiEnvironment(options);
  const { runtime } = environment;
  try {
    if (!runtime.getProvider(providerId)) throw new Error("That Pi provider is no longer available");
    await runtime.logout(providerId);
  } finally {
    environment.close();
  }
}

export interface PiPackageProgress {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
}

/** Install and persist a user-scoped Pi package with Pi's bundled package manager. */
export async function installPiPackage(
  source: string,
  options: PiEnvironmentOptions & { cwd?: string; onProgress?: (event: PiPackageProgress) => void } = {},
): Promise<{ source: string; agentDir: string }> {
  if (typeof source !== "string" || source.trim().length === 0 || source.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(source)) {
    throw new Error("Pi package source must be one non-empty line");
  }
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const cwd = resolve(options.cwd ?? process.cwd());
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  packages.setProgressCallback(options.onProgress);
  await packages.installAndPersist(source);
  await settings.flush();
  return { source, agentDir };
}

async function openPiEnvironment(options: PiEnvironmentOptions): Promise<{
  agentDir: string;
  settings: SettingsManager;
  runtime: ModelRuntime;
  diagnostics: string[];
  close(): void;
}> {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  // Deliberately choose a non-project cwd: Hub manages Pi's global environment,
  // while each Worker still loads its own trusted project resources normally.
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    settingsManager: settings,
    modelRuntime,
  });
  return {
    agentDir,
    settings,
    runtime: services.modelRuntime,
    diagnostics: services.diagnostics.map((item) => item.message),
    close: () => services.resourceLoader.getExtensions().runtime.invalidate("Pi environment management finished"),
  };
}

function compareModel(left: PiEnvironmentModel, right: PiEnvironmentModel): number {
  return left.provider.localeCompare(right.provider)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}
