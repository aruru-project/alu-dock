/**
 * What a `show_image` result records in its details (the file it published, or why it could
 * not) and how that is read back when the result is shown outside the Worker.
 */
import { validatedPublishedFileDto, type PublishedFileDto } from "../core/published-file.js";
import type { TransientFileRegistry } from "./transient-file-registry.js";

export const SHOW_IMAGE_TOOL_NAME = "show_image";
export const PUBLISHED_FILE_DETAIL_KEY = "aluDockPublishedFile";
export const PUBLISHED_FILE_FAILURE_DETAIL_KEY = "aluDockPublishedFileFailure";
export const SHOW_IMAGE_UNAVAILABLE_MESSAGE = "This image came from an older session and is no longer available. Ask the Agent to publish it again.";

export function publishedFileFromDetails(details: unknown, registry: TransientFileRegistry): PublishedFileDto | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const published = validatedPublishedFileDto((details as Record<string, unknown>)[PUBLISHED_FILE_DETAIL_KEY]);
  return published !== undefined && registry.owns(published) ? published : undefined;
}

export function publishedFileFailureFromDetails(details: unknown, registry: TransientFileRegistry): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const candidate = (details as Record<string, unknown>)[PUBLISHED_FILE_FAILURE_DETAIL_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "failureRef") || typeof value.failureRef !== "string" || value.failureRef.length > 128) return undefined;
  return registry.failure(value.failureRef);
}

export function redactShowImageResult(toolName: string | undefined, text: string, publishedFile?: PublishedFileDto, failureMessage?: string): string {
  if (toolName !== SHOW_IMAGE_TOOL_NAME || publishedFile !== undefined) return text;
  return failureMessage ?? SHOW_IMAGE_UNAVAILABLE_MESSAGE;
}
