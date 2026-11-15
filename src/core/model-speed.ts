/** Work-scoped request speed; provider/model support is data owned by Main. */
export const MODEL_SPEED_TIERS = ["standard", "fast", "ultrafast"] as const;
export type ModelSpeedTier = typeof MODEL_SPEED_TIERS[number];
export interface ModelSpeedSelection { tier: ModelSpeedTier; scope: "work" | "all" }

/** Provider aliases let a private relay reuse an upstream's support list without hard-coding its name. */
export interface ModelSpeedSupport {
  providers: Record<string, { fast?: string[]; ultrafast?: string[] }>;
  aliases?: Record<string, string>;
}

/** Initial support data, overridable in Main's model-speed-support.json without updating Dock. */
export const DEFAULT_MODEL_SPEED_SUPPORT: ModelSpeedSupport = {
  providers: {
    "openai-codex": { fast: ["gpt-6-astra", "gpt-6.1-sol"], ultrafast: ["gpt-6-astra", "gpt-6.1-sol"] },
    openai: { fast: ["gpt-6-astra", "gpt-6.1-sol"], ultrafast: ["gpt-6-astra", "gpt-6.1-sol"] },
  },
};

export function parseModelSpeedSelection(value: unknown): ModelSpeedSelection | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请选择模型速度和作用范围。");
  const item = value as Record<string, unknown>;
  if (!MODEL_SPEED_TIERS.includes(item.tier as ModelSpeedTier) || (item.scope !== "work" && item.scope !== "all")) throw new Error("请选择标准、Fast 或 Ultrafast，以及当前 Work 或包含子 Work。");
  return { tier: item.tier as ModelSpeedTier, scope: item.scope };
}

export function inheritedModelSpeed(parent: ModelSpeedSelection | undefined): ModelSpeedTier {
  return parent?.scope === "all" ? parent.tier : "standard";
}

export function supportedModelSpeeds(support: ModelSpeedSupport, model: { provider: string; id: string; api?: string } | undefined): ModelSpeedTier[] {
  if (!model || !["openai-codex-responses", "openai-responses", "openai-completions"].includes(model.api ?? "")) return ["standard"];
  const provider = support.aliases?.[model.provider] ?? model.provider;
  const rules = support.providers[provider];
  const matches = (patterns: string[] | undefined): boolean => patterns?.some(pattern => {
    const expression = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`, "u").test(model.id);
  }) === true;
  return ["standard", ...(matches(rules?.fast) ? ["fast" as const] : []), ...(matches(rules?.ultrafast) ? ["ultrafast" as const] : [])];
}
