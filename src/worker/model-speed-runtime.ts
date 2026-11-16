import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

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

  constructor(private readonly readConfiguration?: () => Promise<unknown>) {}

  configure(support: ModelSpeedSupport | undefined): void {
    if (support !== undefined) this.support = support;
  }

  /** Re-read Main's support facts at the speed controls, not before ordinary model requests.
   * The owner callback adopts the snapshot without refreshing/replacing the Agent's model runtime.
   * If Main is unavailable, keep the last successful facts and still return other settings. */
  async refresh(): Promise<void> {
    if (!this.readConfiguration) return;
    this.refreshing ??= this.readConfiguration()
      .then(() => {}, () => {})
      .finally(() => { this.refreshing = undefined; });
    await this.refreshing;
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
