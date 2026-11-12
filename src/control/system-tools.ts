import { createHash } from "node:crypto";
import type { DockCreateInput, DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { JsonObject } from "../core/json-value.js";
import type { DockClient } from "./dock-client.js";
import { observationStatus } from "./instance-observation-service.js";

type SystemPort = Pick<DockClient, "systemCatalog" | "systemContent" | "setSystemDefault" | "create">;
export type SystemToolRequest = Extract<DockToolsRequest, { type: "system" }>;

export async function readDockSystem(port: SystemPort, input: SystemToolRequest, hostId?: string): Promise<DockToolsResult> {
  return input.id === undefined
    ? { type: "system_catalog", result: await port.systemCatalog(input.cwd, hostId, input.cursor) }
    : { type: "system_content", result: await port.systemContent(input.cwd, input.id, hostId, input.offset, input.revision) };
}

/** Both local and Main tools use the canonical catalog/default and create application boundaries. */
export async function createDockSystem(port: SystemPort, input: DockCreateInput, hostId?: string): Promise<DockToolsResult> {
  if (input.saveDefault && input.systemId === undefined) throw new Error("Saving requires an explicit systemId.");
  // The assistant is a Work's system: her persona and memory replace its opening (2026-11-12, card #295).
  if (input.assistant === true && input.systemId !== undefined) throw new Error("A Work opened as the assistant takes no system: her persona and memory replace its opening. Leave out systemId to open her, or leave out assistant to use that system; no Work was created.");
  // The starting model and thinking level ride in the same Worker configuration as the system; the target Host still applies its directory default.
  const starting: JsonObject = {
    ...(input.model === undefined ? {} : { model: { provider: input.model.provider, id: input.model.id } }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
  };
  const modelConfig = Object.keys(starting).length === 0 ? undefined : starting;
  // An Agent's top-level Work is the assistant only when it asked; the directory's default does not
  // apply, so collaboration members never carry her memory (card #295). A child never is.
  const assistant = input.child === undefined ? input.assistant === true : undefined;
  if (input.systemId === undefined) {
    const instance = await port.create(input.cwd, input.name, input.operationId, undefined, hostId, modelConfig, input.child, assistant);
    return { type: "create", instance: observationStatus(instance) };
  }
  let page = await port.systemCatalog(input.cwd, hostId);
  const first = page;
  let selection = page.candidates.find((item) => item.id === input.systemId);
  while (!selection && page.nextCursor) {
    page = await port.systemCatalog(first.cwd, hostId, page.nextCursor);
    selection = page.candidates.find((item) => item.id === input.systemId);
  }
  if (!selection || selection.warning) throw new Error("The selected system is unavailable. Use dock_system to inspect current candidates and choose again; no Work was created.");
  let saved = false;
  if (input.saveDefault) {
    selection = (await port.setSystemDefault(first.cwd, selection.id, hostId, systemToolOperation(input.operationId, "save"))).selection ?? selection;
    saved = true;
  }
  try {
    const instance = await port.create(first.cwd, input.name, input.operationId, undefined, hostId, { ...selection.workerConfig, ...modelConfig }, input.child, assistant);
    return { type: "create", instance: observationStatus(instance), ...(saved ? { defaultSaved: true } : {}) };
  } catch (error) {
    if (saved && error instanceof Error) error.message = `Directory default saved. Work creation did not return success; check Dock before trying again. ${error.message}`;
    throw error;
  }
}

export function systemToolOperation(id: string, step: string): string {
  return createHash("sha256").update(JSON.stringify(["dock-system", id, step])).digest("hex");
}
