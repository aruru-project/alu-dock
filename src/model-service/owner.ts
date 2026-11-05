import type { ModelRuntimeOwner } from "@earendil-works/pi-coding-agent";

import type { ModelAuthOverrides, ModelAuthResult, ModelAuthState, ModelConfiguration } from "./protocol.js";

/** Asks the Work's Host, which relays to Main's model service. */
export type ModelServiceCall = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/**
 * Main as the owner of a Work's model configuration and credentials (card #303). The Work's Pi
 * composes, sends and handles its requests itself; it asks Main only what it may use and with what.
 */
export function mainModelOwner(call: ModelServiceCall): ModelRuntimeOwner {
  return {
    name: "Main",
    async readConfiguration(options) {
      options?.signal?.throwIfAborted();
      return await call({ op: "configuration" }, options?.signal) as ModelConfiguration;
    },
    async readAuthState(options) {
      options?.signal?.throwIfAborted();
      return await call({ op: "auth_state" }, options?.signal) as ModelAuthState;
    },
    async getAuth(target, { signal, apiKey, env, minOAuthValidityMs }) {
      signal?.throwIfAborted();
      const overrides: ModelAuthOverrides = {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(env === undefined ? {} : { env }),
        ...(minOAuthValidityMs === undefined ? {} : { minOAuthValidityMs }),
      };
      const request = { target, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) };
      const result = await call({ op: "auth", request }, signal) as ModelAuthResult;
      signal?.throwIfAborted();
      return result ?? undefined;
    },
  };
}
