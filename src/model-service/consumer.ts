import type { AnyModel, Api, AssistantMessage, AuthCheck, AuthResult, Context, Model } from "@earendil-works/pi-ai";
import { type AssistantMessageEventStream, createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ModelConsumer } from "@earendil-works/pi-coding-agent";

import {
  failedModelEvent,
  type ModelAuthOverrides,
  type ModelAuthRequest,
  type ModelAuthResult,
  type ModelCatalogSnapshot,
  type ModelRequestAuthResult,
  ModelEventOrder,
  modelRequestOptions,
  type ModelRouteRequest,
  type ModelRouteResult,
  type ModelStreamMode,
  type ModelStreamRequest,
  PartialDecoder,
  type WireModelEvent,
} from "./protocol.js";

/** How a Worker reaches the model service: through its own Host, never directly. */
export interface ModelServiceChannel {
  catalog(): Promise<ModelCatalogSnapshot>;
  resolve(request: ModelRouteRequest, signal?: AbortSignal): Promise<ModelRouteResult>;
  stream(request: ModelStreamRequest, onEvent: (wire: WireModelEvent) => void, signal: AbortSignal): Promise<void>;
  auth(request: ModelAuthRequest, signal?: AbortSignal): Promise<ModelAuthResult>;
  requestAuth(model: Model<Api>, signal?: AbortSignal): Promise<ModelRequestAuthResult>;
}

export interface RemoteModels extends ModelConsumer {
  /** Read the catalog and login state again, e.g. on reload or before listing models. */
  refresh(): Promise<void>;
}

const key = (provider: string, id: string) => `${provider}\u0000${id}`;

/**
 * Pi's model surface for a Work whose models live on Main. Catalog and login state come from a
 * snapshot of Main's runtime; every request streams through the Host. There is no local provider.
 */
export async function connectRemoteModels(channel: ModelServiceChannel): Promise<RemoteModels> {
  let snapshot: ModelCatalogSnapshot;
  let models = new Map<string, Model<Api>>();
  let virtual = new Set<string>();
  let providers = new Map<string, ModelCatalogSnapshot["providers"][number]>();
  const adopt = (next: ModelCatalogSnapshot) => {
    snapshot = next;
    models = new Map(next.models.map((model) => [key(model.provider, model.id), model]));
    virtual = new Set(next.virtual.map((model) => key(model.provider, model.id)));
    providers = new Map(next.providers.map((state) => [state.provider, state]));
  };
  adopt(await channel.catalog());

  const find = (provider: string, id: string) => models.get(key(provider, id));

  const request = (model: Model<Api>, context: Context, options: object | undefined, mode: ModelStreamMode): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const order = new ModelEventOrder();
    const decoder = new PartialDecoder();
    let partial: AssistantMessage | undefined;
    void (async () => {
      try {
        const data = modelRequestOptions(options);
        await channel.stream({ mode, model: { provider: model.provider, id: model.id }, context, options: data }, (wire) => {
          const event = decoder.decode(wire);
          order.accept(event);
          if ("partial" in event) partial = event.partial;
          stream.push(event);
        }, controller.signal);
        if (!order.terminal) throw new Error("the model service ended the reply without a final event");
      } catch (error) {
        if (order.terminal) return;
        const aborted = controller.signal.aborted;
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\.?$/u, ".");
        stream.push(failedModelEvent(model, aborted
          ? "Request cancelled"
          : `The model request through Main failed: ${reason} It may already have reached the provider, so it is not sent again.`, aborted, partial));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    })();
    return stream;
  };

  const consumer: RemoteModels = {
    refresh: async () => { adopt(await channel.catalog()); },
    getError: () => snapshot.error,
    getModel: find,
    getPhysicalModel: (provider, id) => (virtual.has(key(provider, id)) ? undefined : find(provider, id)),
    getModels: (provider?: string) => (provider === undefined ? snapshot.models : snapshot.models.filter((model) => model.provider === provider)),
    getAvailableSnapshot: () => snapshot.available,
    hasConfiguredAuth: (provider) => providers.get(provider)?.configured === true,
    checkAuth: async (provider): Promise<AuthCheck | undefined> => providers.get(provider)?.check,
    isUsingOAuth: (provider) => providers.get(provider)?.oauth === true,
    resolveModel: async (model, messages, options) => {
      const route = await channel.resolve({
        model: { provider: model.provider, id: model.id },
        messages: [...messages],
        reason: options.reason,
        thinkingLevel: options.thinkingLevel,
        ...(options.failed === undefined ? {} : { failed: options.failed }),
        ...(options.state === undefined ? {} : { state: options.state }),
      }, options.signal);
      const routed = find(route.model.provider, route.model.id);
      if (!routed) throw new Error(`Main routed ${model.provider}/${model.id} to ${route.model.provider}/${route.model.id}, which this Work does not know yet`);
      return { model: routed, thinkingLevel: route.thinkingLevel, ...(route.state === undefined ? {} : { state: route.state }) };
    },
    stream: (model, context, options) => request(model as Model<Api>, context, options, "raw"),
    streamSimple: (model, context, options) => request(model, context, options, "simple"),
    // An extension calling a model itself gets the credential from Main's runtime, which alone refreshes it.
    getAuth: async (providerOrModel: string | AnyModel, overrides?: ModelAuthOverrides & { signal?: AbortSignal }): Promise<AuthResult | undefined> => {
      const data: ModelAuthOverrides = {
        ...(overrides?.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
        ...(overrides?.env === undefined ? {} : { env: overrides.env }),
        ...(overrides?.minOAuthValidityMs === undefined ? {} : { minOAuthValidityMs: overrides.minOAuthValidityMs }),
      };
      const target = typeof providerOrModel === "string" ? providerOrModel : providerOrModel as Model<Api>;
      return await channel.auth({ target, ...(Object.keys(data).length === 0 ? {} : { overrides: data }) }, overrides?.signal) ?? undefined;
    },
    getRequestAuth: (model) => channel.requestAuth(model),
  };
  return consumer;
}
