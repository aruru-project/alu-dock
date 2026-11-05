import { readFile } from "node:fs/promises";

import type { AnyModel, AuthCheck, ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { FileModelsStore, ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelAuthRequest, ModelAuthResult, ModelAuthState, ModelConfiguration } from "./protocol.js";

/**
 * Main's model configuration and credentials, kept by Pi's own ModelRuntime over Main's files. It
 * answers what Works need to send requests themselves and alone refreshes subscriptions.
 */
export class ModelServiceCore {
  private refreshing: Promise<unknown> | undefined;

  /** `reloadSettings` re-reads the Pi settings Main's own requests use, such as the proxy for login refreshes. */
  constructor(
    private readonly runtime: ModelRuntime,
    private readonly files: { modelsPath: string; store: FileModelsStore },
    private readonly reloadSettings: () => Promise<void> = async () => {},
  ) {}

  async configuration(): Promise<ModelConfiguration> {
    await this.refresh();
    const modelsJson = await readFile(this.files.modelsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const stored = await Promise.all(this.runtime.getProviders().map(async (provider) => [provider.id, await this.files.store.read(provider.id)] as const));
    return {
      ...(modelsJson === undefined ? {} : { modelsJson }),
      modelsStore: Object.fromEntries(stored.filter((entry): entry is readonly [string, ModelsStoreEntry] => entry[1] !== undefined)),
    };
  }

  async authState(): Promise<ModelAuthState> {
    await this.refresh();
    const providers = this.runtime.getProviders().map((provider) => provider.id);
    const checks = await Promise.all(providers.map(async (id) => [id, await this.runtime.checkAuth(id)] as const));
    return {
      providers,
      checks: Object.fromEntries(checks.filter((entry): entry is readonly [string, AuthCheck] => entry[1] !== undefined)),
      models: this.runtime.getAllModels().map((model) => ({ provider: model.provider, id: model.id })),
      available: (await this.runtime.getAllAvailable()).map((model) => ({ provider: model.provider, id: model.id })),
      stored: (await this.runtime.listCredentials()).map((credential) => credential.providerId),
    };
  }

  async auth(request: ModelAuthRequest, signal: AbortSignal): Promise<ModelAuthResult> {
    const overrides = { ...request.overrides, signal };
    const result = typeof request.target === "string"
      ? await this.runtime.getAuth(request.target, overrides)
      : await this.runtime.getAuth(request.target as AnyModel, overrides);
    return result ?? null;
  }

  /** Adopt settings, models.json and login changes made since the last read; Works ask on start and reload. */
  private async refresh(): Promise<void> {
    this.refreshing ??= this.reloadSettings()
      .then(() => this.runtime.refresh({ allowNetwork: false }))
      .finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }
}
