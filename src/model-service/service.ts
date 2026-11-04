import type { Api, Message, ModelsApiStreamOptions, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  type ModelCatalogSnapshot,
  ModelEventOrder,
  type ModelRouteRequest,
  type ModelRouteResult,
  type ModelStreamRequest,
  PartialEncoder,
  SERVICE_OWNED_OPTIONS,
  type WireModelEvent,
} from "./protocol.js";

/**
 * Main's one model runtime, shared by every Work in the cluster. Pi's ModelRuntime owns providers,
 * credentials, login refresh and catalogs; this class only answers requests and keeps their lifetimes.
 */
export class ModelServiceCore {
  private refreshing: Promise<unknown> | undefined;

  constructor(private readonly runtime: ModelRuntime) {}

  async catalog(): Promise<ModelCatalogSnapshot> {
    // Adopt models.json and login changes made since the last read; Workers ask on start, reload and model lists.
    this.refreshing ??= this.runtime.refresh({ allowNetwork: false }).finally(() => { this.refreshing = undefined; });
    await this.refreshing;
    const models = [...this.runtime.getModels()];
    const providers = [...new Set(models.map((model) => model.provider))];
    return {
      models,
      available: [...await this.runtime.getAvailable()],
      virtual: models.filter((model) => !this.runtime.getPhysicalModel(model.provider, model.id)).map((model) => ({ provider: model.provider, id: model.id })),
      providers: await Promise.all(providers.map(async (provider) => {
        const check = await this.runtime.checkAuth(provider).catch(() => undefined);
        return { provider, configured: this.runtime.hasConfiguredAuth(provider), oauth: this.runtime.isUsingOAuth(provider), ...(check ? { check } : {}) };
      })),
      ...(this.runtime.getError() === undefined ? {} : { error: this.runtime.getError() }),
    };
  }

  async resolve(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteResult> {
    const model = this.requireModel(request.model);
    const route = await this.runtime.resolveModel(model, request.messages as readonly Message[], {
      reason: request.reason,
      thinkingLevel: request.thinkingLevel,
      signal,
      ...(request.failed === undefined ? {} : { failed: request.failed }),
      ...(request.state === undefined ? {} : { state: request.state }),
    });
    return { model: { provider: route.model.provider, id: route.model.id }, thinkingLevel: route.thinkingLevel, ...(route.state === undefined ? {} : { state: route.state }) };
  }

  /** Emits every event of one provider stream; the caller learns of an early end by the returned promise. */
  async stream(request: ModelStreamRequest, emit: (wire: WireModelEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    const model = this.requireModel(request.model);
    for (const key of SERVICE_OWNED_OPTIONS) if (key in request.options) throw new Error(`${key} belongs to the model service on Main`);
    const options = { ...request.options, signal };
    const events = request.mode === "raw"
      ? this.runtime.stream(model, request.context, options as ModelsApiStreamOptions<Api>)
      : this.runtime.streamSimple(model, request.context, options as ModelsSimpleStreamOptions);
    const order = new ModelEventOrder();
    const encoder = new PartialEncoder();
    for await (const event of events) {
      order.accept(event);
      await emit(encoder.encode(event));
      if (order.terminal) return;
    }
    if (!signal.aborted) throw new Error("The provider stream ended without a final event");
  }

  private requireModel(ref: { provider: string; id: string }) {
    const model = this.runtime.getModel(ref.provider, ref.id);
    if (!model) throw new Error(`Model ${ref.provider}/${ref.id} is not configured on Main`);
    return model;
  }
}
