import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";

import type { SettingsChangedData } from "../core/instance-dto.js";
import { SETTING_DEFINITIONS, type SettingDto } from "../core/config-projection.js";
import { DEFAULT_MODEL_SPEED_SUPPORT, parseModelSpeedSelection, supportedModelSpeeds, type ModelSpeedSupport, type ModelSpeedTier } from "../core/model-speed.js";

type SpeedModel = { provider: string; id: string; api?: string };
type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;
const SERVICE_TIERS = { standard: "default", fast: "priority", ultrafast: "ultrafast" } as const;

/** The Host's effective Work speed, applied by both Workers without another saved preference. */
export class ModelSpeedRuntime {
  private tier: ModelSpeedTier = "standard";
  private support: ModelSpeedSupport = DEFAULT_MODEL_SPEED_SUPPORT;
  private refreshing: Promise<void> | undefined;
  private readonly supportListeners = new Set<(data: SettingsChangedData) => void>();

  constructor(private readonly readConfiguration?: () => Promise<unknown>) {}

  configure(support: ModelSpeedSupport | undefined): void {
    if (support === undefined || isDeepStrictEqual(support, this.support)) return;
    this.support = support;
    const { reloadRequired, hostRestartRequired } = SETTING_DEFINITIONS.modelSpeed;
    for (const listener of this.supportListeners) listener({
      key: "modelSpeed", value: { tier: this.tier, scope: "work" }, reloadRequired, hostRestartRequired,
    });
  }

  onSupportChanged(listener: (data: SettingsChangedData) => void): () => void {
    this.supportListeners.add(listener);
    return () => { this.supportListeners.delete(listener); };
  }

  /** Optional support reads must not hold a Worker query open while Main recovers (PR review P1).
   * Return the last good facts now; changed facts notify open clients through settings.changed.
   * Re-reading identical support does not notify again. Ordinary model requests do not refresh. */
  refresh(): void {
    if (!this.readConfiguration) return;
    this.refreshing ??= this.readConfiguration()
      .then(() => {}, () => {})
      .finally(() => { this.refreshing = undefined; });
  }

  update(value: unknown): void {
    const selection = parseModelSpeedSelection(value);
    if (!selection || selection.scope !== "work") throw new Error("Worker 需要 Host 提供当前 Work 的实际模型速度。");
    this.tier = selection.tier;
  }

  supported(model: SpeedModel | undefined): ModelSpeedTier[] { return supportedModelSpeeds(this.support, model); }

  setting(model: SpeedModel | undefined): SettingDto {
    const { sourcePath: _sourcePath, ...definition } = SETTING_DEFINITIONS.modelSpeed;
    return {
      ...definition, key: "modelSpeed", value: { tier: this.tier, scope: "work" }, source: "effective",
      allowedValues: this.supported(model),
    };
  }

  /** Preserve Pi/provider hooks first; unsupported models keep their original request unchanged. */
  wrap(onPayload?: PayloadHook, speed?: ModelSpeedTier): PayloadHook {
    return async (payload, model) => {
      const tier = speed ?? this.tier;
      const supported = this.supported(model);
      const result = await onPayload?.(payload, model);
      const body = result === undefined ? payload : result;
      if (supported.length === 1 || !supported.includes(tier) || !body || typeof body !== "object" || Array.isArray(body)) return result;
      return { ...body, service_tier: SERVICE_TIERS[tier] };
    };
  }
}
