import { EventEmitter } from "node:events";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as undici from "undici";

const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let installedConfiguration: string | undefined;
let installedDispatcher: undici.Dispatcher | undefined;

interface ProxyEnvironmentSlot {
  initialized: boolean;
  managed: boolean;
  lastApplied?: string;
}

const proxyEnvironment: Record<"HTTP_PROXY" | "HTTPS_PROXY", ProxyEnvironmentSlot> = {
  HTTP_PROXY: { initialized: false, managed: false },
  HTTPS_PROXY: { initialized: false, managed: false },
};

/**
 * Apply the same process-wide proxy and Undici bootstrap as the Pi CLI.
 *
 * SDK runtime factories intentionally do not initialize network globals; Pi's
 * CLI does that in main() before creating a runtime. Dock is the SDK process,
 * so it must own the equivalent bootstrap before any managed session starts.
 */
export function configurePiNetwork(settingsManager: SettingsManager): void {
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  const timeoutMs = settingsManager.getHttpIdleTimeoutMs();
  const configuration = JSON.stringify({
    timeoutMs,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
  });
  if (configuration === installedConfiguration) return;
  configureHttpDispatcher(timeoutMs);
  installedConfiguration = configuration;
}

function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim() || undefined;
  applyProxyEnvironment("HTTP_PROXY", proxy);
  applyProxyEnvironment("HTTPS_PROXY", proxy);
}

function applyProxyEnvironment(key: "HTTP_PROXY" | "HTTPS_PROXY", proxy: string | undefined): void {
  const slot = proxyEnvironment[key];
  if (!slot.initialized) {
    slot.initialized = true;
    slot.managed = process.env[key] === undefined;
  }
  if (!slot.managed) return;

  // Do not overwrite a value installed by another Host subsystem after Dock's
  // first network bootstrap. Environment inherited at process start is never
  // considered Dock-owned.
  if (process.env[key] !== slot.lastApplied) {
    slot.managed = false;
    return;
  }

  if (proxy === undefined) delete process.env[key];
  else process.env[key] = proxy;
  slot.lastApplied = proxy;
}

function configureHttpDispatcher(timeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: normalizedTimeoutMs,
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  const previousDispatcher = installedDispatcher;
  undici.setGlobalDispatcher(dispatcher);
  installedDispatcher = dispatcher;
  // This setting is intentionally process-wide for future requests from every
  // managed runtime. Graceful close lets requests already using the previous
  // dispatcher finish instead of turning a settings reload into cancellation.
  if (previousDispatcher) void previousDispatcher.close().catch(ignoreUndiciDispatcherError);

  // Keep fetch/WebSocket and the dispatcher on the same Undici implementation,
  // matching Pi's CLI bootstrap. Preserve deliberate third-party replacements.
  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install();
    installedGlobalFetch = globalThis.fetch;
  }
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: URL, options: object): undici.Client {
  return withUndiciErrorListener(new undici.Client(
    origin,
    options as undici.Client.Options,
  ));
}

function createUndiciOriginDispatcher(origin: URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...dispatcherOptions,
    factory: createUndiciClient,
  }));
}
