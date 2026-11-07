/** Main's local time with its offset, such as "2026-11-07 15:04（UTC+08:00）". */
export function localTime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${localMinute(date)}（UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}）`;
}

/** Main's local date and minute, such as "2026-11-07 15:04". */
export function localMinute(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }
