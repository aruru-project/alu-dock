import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  assertUnchangedSource,
  inspectSourceFile,
  openUnchangedSource,
  MAX_SOURCE_FILE_PATH_CHARS,
  SourceFileError,
  type SourceFileIdentity,
} from "./source-file.js";

/** Business bounds owned by the temporary-delivery producer. */
export const MAX_TEMPORARY_DELIVERABLE_BYTES = 104_857_600;
export const MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE = 1_024;
export const MAX_DELIVERABLE_NAME_CHARS = 512;
export const MAX_DELIVERY_REF_CHARS = 128;
export const MAX_DELIVERABLE_CHUNK_BYTES = 512 * 1_024;

export interface DeliverableDto {
  deliveryRef: string;
  name: string;
  sizeBytes: number;
}

interface DeliverableEntry {
  dto: DeliverableDto;
  source: SourceFileIdentity;
}

export class DeliverableUnavailableError extends Error {
  readonly code = "file_unavailable";
  constructor(message = "This file is no longer available. Ask the Agent to deliver it again.") {
    super(message);
    this.name = "DeliverableUnavailableError";
  }
}

export class DeliverableRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliverableRegistrationError";
  }
}

export class InstanceDeliverables {
  private readonly entries = new Map<string, DeliverableEntry>();

  async register(path: string): Promise<DeliverableDto> {
    if (this.entries.size >= MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE) {
      throw new DeliverableRegistrationError("This work has too many temporary deliveries. Stop this work and start a new one before delivering another file.");
    }
    let source: SourceFileIdentity;
    try {
      source = await inspectSourceFile(path, { maxPathChars: MAX_SOURCE_FILE_PATH_CHARS, maxBytes: MAX_TEMPORARY_DELIVERABLE_BYTES });
    } catch (error) {
      if (error instanceof SourceFileError && error.reason === "too_large") {
        throw new DeliverableRegistrationError("This file exceeds Dock's temporary delivery limit. Remind the user that it could not be delivered because it is too large.");
      }
      if (error instanceof SourceFileError && error.reason === "invalid_path") {
        throw new DeliverableRegistrationError("The file path must be absolute. Use an absolute path and try delivery again.");
      }
      throw new DeliverableRegistrationError("This file cannot be delivered because it is not a readable regular file. Check the file and try again.");
    }
    const dto: DeliverableDto = {
      deliveryRef: `delivery-${randomUUID()}`,
      name: safeName(basename(source.path)),
      sizeBytes: source.size,
    };
    this.entries.set(dto.deliveryRef, { dto, source });
    return structuredClone(dto);
  }

  list(): DeliverableDto[] { return [...this.entries.values()].map(({ dto }) => structuredClone(dto)); }

  async open(deliveryRef: string): Promise<{ dto: DeliverableDto; handle: Awaited<ReturnType<typeof openUnchangedSource>>; verify(): Promise<void> }> {
    const entry = this.entries.get(deliveryRef);
    if (!entry) throw new DeliverableUnavailableError();
    try {
      const handle = await openUnchangedSource(entry.source);
      return {
        dto: structuredClone(entry.dto),
        handle,
        verify: async () => { assertUnchangedSource(entry.source, await handle.stat()); },
      };
    } catch {
      throw new DeliverableUnavailableError();
    }
  }

  clear(): void { this.entries.clear(); }
}

export function parseDeliverableDto(
  input: unknown,
  label = "deliverable",
  options: { allowUnknownFields?: boolean } = {},
): DeliverableDto {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if ((!options.allowUnknownFields && keys.some((key) => !["deliveryRef", "name", "sizeBytes"].includes(key)))
    || !["deliveryRef", "name", "sizeBytes"].every((key) => keys.includes(key))) throw new Error(`${label} has unexpected fields`);
  if (typeof value.deliveryRef !== "string" || value.deliveryRef.length < 1 || value.deliveryRef.length > MAX_DELIVERY_REF_CHARS) throw new Error(`${label}.deliveryRef is invalid`);
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > MAX_DELIVERABLE_NAME_CHARS || /[\u0000-\u001f\u007f-\u009f/\\]/u.test(value.name)) throw new Error(`${label}.name is invalid`);
  if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0 || (value.sizeBytes as number) > MAX_TEMPORARY_DELIVERABLE_BYTES) throw new Error(`${label}.sizeBytes is invalid`);
  return { deliveryRef: value.deliveryRef, name: value.name, sizeBytes: value.sizeBytes as number };
}

function safeName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f/\\]/gu, " ").trim();
  return (cleaned || "delivered-file").slice(0, MAX_DELIVERABLE_NAME_CHARS);
}
