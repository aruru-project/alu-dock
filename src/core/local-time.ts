/** Main's local time with its offset, such as "2026-11-07 15:04（UTC+08:00）". */
export function localTime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${localMinute(date)}（UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}）`;
}

/** Main's local date and minute, such as "2026-11-07 15:04". */
export function localMinute(date: Date): string {
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Main's local date, such as "2026-11-07". */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A stretch of local time: "2026-11-07 14:00–16:30" within one day, "2026-11-07 23:10–2026-11-08 01:20" across days. */
export function localSpan(from: Date, to: Date): string {
  const end = localDay(from) === localDay(to) ? `${pad(to.getHours())}:${pad(to.getMinutes())}` : localMinute(to);
  return `${localMinute(from)}–${end}`;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }
