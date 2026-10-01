import type { AgentModelInfo } from "../core/agent-worker.js";
import { MAX_MODEL_ID_CHARS, MAX_MODEL_PROVIDER_CHARS } from "../control/protocol.js";

/** Producer bound for one Pi model list, shared by a Work's picker list and the machine catalog. */
export const MAX_MODEL_LIST_BYTES = 600_000;
const MAX_MODEL_LIST_ITEMS = 2_000;
const MAX_MODEL_NAME_CHARS = 256;

export interface PiModelListBody {
  models: AgentModelInfo[];
  total: number;
  truncated: boolean;
}

interface PiModelLike {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

/** Pi's selectable models in picker order (provider, then display name). */
export function projectPiModelList(available: readonly PiModelLike[]): PiModelListBody {
  const models = available
    .filter((model) => validReference(model.provider, MAX_MODEL_PROVIDER_CHARS) && validReference(model.id, MAX_MODEL_ID_CHARS))
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: displayName(model.name, model.id),
      reasoning: model.reasoning === true,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const projected: AgentModelInfo[] = [];
  let bytes = 2;
  for (const model of models.slice(0, MAX_MODEL_LIST_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(model), "utf8") + (projected.length === 0 ? 0 : 1);
    if (bytes + itemBytes > MAX_MODEL_LIST_BYTES) break;
    projected.push(model);
    bytes += itemBytes;
  }
  return { models: projected, total: models.length, truncated: projected.length < models.length };
}

function validReference(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function displayName(value: unknown, fallback: string): string {
  const name = typeof value === "string" && value.length > 0 ? value : fallback;
  if (name.length <= MAX_MODEL_NAME_CHARS) return name;
  let kept = "";
  for (const character of name) {
    if (kept.length + character.length > MAX_MODEL_NAME_CHARS - 1) break;
    kept += character;
  }
  return `${kept}…`;
}
