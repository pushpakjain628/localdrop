/** Presentation helpers shared by the dashboard components. */

import { formatBytes, formatDuration } from '@localdrop/shared';
import { colors } from '../styles/theme';

export { formatBytes, formatDuration };

/** Transfer rate, e.g. `12.4 MB/s`. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '—';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Percentage, clamped and rounded for display. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return '0%';
  }
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

/** Human label for a transfer status, matching the phone's wording. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Backed up';
    case 'uploading':
      return 'Receiving';
    case 'verifying':
      return 'Verifying';
    case 'pending':
      return 'Queued';
    case 'skipped':
      return 'Already backed up';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Cancelled';
    default:
      return status;
  }
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'live';

export function toneColors(tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'accent':
      return { fg: colors.accent, bg: colors.accentSoft };
    case 'success':
    case 'live':
      return { fg: colors.success, bg: colors.successSoft };
    case 'warning':
      return { fg: colors.warning, bg: colors.warningSoft };
    case 'danger':
      return { fg: colors.danger, bg: colors.dangerSoft };
    default:
      return { fg: colors.textMuted, bg: colors.surfaceMuted };
  }
}

/** Shortens a long absolute path for a single-line table cell, keeping the tail readable. */
export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

/** `09-September` from a stats month label like `Photos/2026/09-September`. */
export function monthLabelFromStats(label: string): string {
  const parts = label.split('/');
  const month = parts[parts.length - 1] ?? label;
  const year = parts[parts.length - 2] ?? '';
  return year ? `${month} ${year}` : month;
}

/** Formats an ISO timestamp as a local date-time, or an em dash when absent/invalid. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Countdown text for a pairing code, or `null` once it has expired. */
export function formatCountdown(expiresAtMs: number, nowMs: number): string | null {
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) {
    return null;
  }
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
