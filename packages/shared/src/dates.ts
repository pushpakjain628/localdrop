/**
 * Locale-independent date helpers.
 *
 * The folder layout on the PC (`Photos/2026/09-September/`) is produced on the iPhone
 * and re-derived on Windows. Using `toLocaleString` would make the output depend on the
 * device locale, so the same asset could land in two different folders depending on which
 * machine created it. These helpers are therefore pure and locale-free by construction.
 */

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type MonthName = (typeof MONTH_NAMES)[number];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `2026-09-26` — sortable, unambiguous, filesystem safe. */
export function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** `2026-09-26T17:57:03.000Z` */
export function toIsoTimestamp(date: Date): string {
  return `${toIsoDate(date)}T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )}.${String(date.getUTCMilliseconds()).padStart(3, '0')}Z`;
}

/** Parses an ISO-8601 timestamp, returning `null` for anything unparseable. */
export function parseIsoTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Full year, e.g. `2026`. */
export function yearFolder(date: Date): string {
  return String(date.getUTCFullYear());
}

/** Zero-padded month number, e.g. `09`. */
export function monthNumberFolder(date: Date): string {
  return pad2(date.getUTCMonth() + 1);
}

/** Full English month name, e.g. `September`. */
export function monthNameFolder(date: Date): MonthName {
  // `getUTCMonth` is 0-11 and MONTH_NAMES has 12 entries; the fallback is unreachable
  // but keeps the return type honest for exotic Date polyfills.
  return MONTH_NAMES[date.getUTCMonth()] ?? MONTH_NAMES[0];
}

/** `09-September` */
export function monthFolder(date: Date): string {
  return `${monthNumberFolder(date)}-${monthNameFolder(date)}`;
}

/** Formats a byte count for display, e.g. `1.4 MB`. Uses binary units. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

/** Formats a duration in seconds as `m:ss` or `h:mm:ss`. Returns `—` for invalid input. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${m}:${pad2(s)}`;
}

/** Formats a media duration in seconds as `0:07` / `1:02:03`. */
export function formatMediaDuration(seconds: number): string {
  return formatDuration(seconds);
}
