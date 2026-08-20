import { basename } from "node:path";

import type { SessionDto } from "./core/instance-dto.js";

export function sessionDisplayName(session: SessionDto): string {
  const name = clean(session.name);
  if (name) return name;
  const firstUserMessage = clean(session.firstUserMessage);
  if (firstUserMessage) return firstUserMessage;
  return clean(basename(session.cwd)) ?? "Saved Pi session";
}

function clean(value: string | undefined): string | undefined {
  const result = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return result || undefined;
}
