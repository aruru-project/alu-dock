import { createHash } from "node:crypto";
import type { DockToolsRequest, DockToolsResult } from "../core/dock-tools.js";
import type { JsonObject } from "../core/json-value.js";
import type { DockClient } from "./dock-client.js";
import { observationStatus } from "./instance-observation-service.js";

type SystemPort = Pick<DockClient, "systemCatalog" | "systemContent" | "setSystemDefault" | "create">;
export type SystemToolRequest = Extract<DockToolsRequest, { type: "system" }>;
export type SystemCreateRequest = Extract<DockToolsRequest, { type: "create" }>;

export async function readDockSystem(port: SystemPort, input: SystemToolRequest, hostId?: string): Promise<DockToolsResult> {
  return input.id === undefined
    ? { type: "system_catalog", result: await port.systemCatalog(input.cwd, hostId, input.cursor) }
    : { type: "system_content", result: await port.systemContent(input.cwd, input.id, hostId, input.offset, input.revision) };
}

/** Both local and Main tools use the canonical catalog/default and create application boundaries. */
export async function createDockSystem(port: SystemPort, input: SystemCreateRequest, hostId?: string): Promise<DockToolsResult> {
  if (input.saveDefault && input.systemId === undefined) throw new Error("Saving requires an explicit systemId.");
  // The starting model rides in the same Worker configuration as the system; the target Host still applies its directory default.
  const modelConfig: JsonObject | undefined = input.model === undefined ? undefined : { model: { provider: input.model.provider, id: input.model.id } };
  if (input.systemId === undefined) {
    const instance = await port.create(input.cwd, input.name, input.operationId, undefined, hostId, modelConfig);
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
    selection = (await port.setSystemDefault(first.cwd, selection.id, hostId, systemToolOperation(input.operationId, "save"))).selection;
    saved = true;
  }
  try {
    const instance = await port.create(first.cwd, input.name, input.operationId, undefined, hostId, { ...selection.workerConfig, ...modelConfig });
    return { type: "create", instance: observationStatus(instance), ...(saved ? { defaultSaved: true } : {}) };
  } catch (error) {
    if (saved && error instanceof Error) error.message = `Directory default saved. Work creation did not return success; check Dock before trying again. ${error.message}`;
    throw error;
  }
}

export function systemToolOperation(id: string, step: string): string {
  return createHash("sha256").update(JSON.stringify(["dock-system", id, step])).digest("hex");
}
