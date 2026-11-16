import { createHash } from "node:crypto";
import type { AgentResourceProjectionBody } from "../core/agent-worker.js";
import { compareDiagnosticDtos, compareResourceDtos, type DiagnosticDto, type ResourceDto, type SourceDto } from "../core/config-projection.js";
import { ResourceContentError } from "../core/resource-content.js";
import { MAX_SOURCE_FILE_PATH_CHARS } from "../core/source-file.js";

/** Existing Worker catalog limits, shared by the resource producers. */
export const MAX_PROJECTION_ITEMS = 2_000;

/** A file already selected by the Agent, not permission for a client to supply arbitrary paths. */
export function documentResource(kind: ResourceDto["kind"], name: string, filePath: string | undefined, source?: SourceDto): ResourceDto {
  const path = filePath && filePath.length <= MAX_SOURCE_FILE_PATH_CHARS && !filePath.includes("\0") ? filePath : undefined;
  return {
    kind, name: name.length > 256 ? `${name.slice(0, 255)}…` : name || kind,
    ...(source === undefined ? {} : { source }),
    ...(path === undefined ? {} : { path, contentRef: createHash("sha256").update(`${kind}\u0000${path}`).digest("hex") }),
  };
}

/** Resolve against the same current list used by resource.get; the Host reads the file. */
export function resolveResourceFile(resources: readonly ResourceDto[], ref: string): { kind: "resource"; path: string } {
  const resource = resources.find(item => item.contentRef === ref);
  if (!resource?.path) throw new ResourceContentError("这份资源已不在当前列表中。请返回项目状态重新选择。");
  return { kind: "resource", path: resource.path };
}

export function projectResources(resources: ResourceDto[], diagnostics: DiagnosticDto[]): AgentResourceProjectionBody {
  const sortedResources = resources.sort(compareResourceDtos);
  const sortedDiagnostics = diagnostics.sort(compareDiagnosticDtos);
  const projectedResources = capJsonItems(sortedResources, 350_000);
  const projectedDiagnostics = capJsonItems(sortedDiagnostics, 250_000);
  return {
    resources: projectedResources, diagnostics: projectedDiagnostics,
    resourceTotal: sortedResources.length, resourcesTruncated: projectedResources.length < sortedResources.length,
    diagnosticTotal: sortedDiagnostics.length, diagnosticsTruncated: projectedDiagnostics.length < sortedDiagnostics.length,
  };
}

export function capJsonItems<T>(items: T[], maxBytes: number): T[] {
  const result: T[] = [];
  let bytes = 2;
  for (const item of items.slice(0, MAX_PROJECTION_ITEMS)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (result.length === 0 ? 0 : 1);
    if (bytes + itemBytes > maxBytes) break;
    result.push(item);
    bytes += itemBytes;
  }
  return result;
}
