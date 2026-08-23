/** Truncate a UTF-16 string without splitting a surrogate pair, reserving one character for an ellipsis. */
export function truncateWithEllipsis(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  if (limit < 1) return "";
  const requestedEnd = limit - 1;
  const end = requestedEnd > 0
    && /[\uD800-\uDBFF]/u.test(value[requestedEnd - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(value[requestedEnd] ?? "")
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, end)}…`;
}
