import type { CSSProperties } from 'react';
import type { LibraryStats } from '@localdrop/shared';
import { colors, spacing } from '../styles/theme';
import { formatBytes, monthLabelFromStats } from '../lib/format';
import { Card, StatTile } from './ui';

/** Library totals: what the user cares about after a run finishes. */
export function LibraryStatsCard({ stats }: { stats: LibraryStats | null }) {
  if (!stats) {
    return (
      <Card title="Library">
        <p style={styles.muted}>Loading…</p>
      </Card>
    );
  }

  const topMonth = stats.months[0];

  return (
    <Card title="Library" subtitle="Verified copies stored on this PC.">
      <div style={styles.tiles}>
        <StatTile
          label="Total size"
          value={formatBytes(stats.totalFiles === 0 ? 0 : stats.totalBytes)}
          hint={`${stats.totalFiles.toLocaleString()} file${stats.totalFiles === 1 ? '' : 's'}`}
        />
        <StatTile
          label="Photos"
          value={stats.photos.toLocaleString()}
          hint={formatBytes(photoBytes(stats))}
        />
        <StatTile
          label="Videos"
          value={stats.videos.toLocaleString()}
          hint={formatBytes(Math.max(stats.totalBytes - photoBytes(stats), 0))}
        />
        <StatTile
          label="Last 30 days"
          value={stats.filesLast30Days.toLocaleString()}
          hint={formatBytes(stats.bytesLast30Days)}
          tone={stats.filesLast30Days > 0 ? 'success' : 'neutral'}
        />
      </div>

      {stats.failedTransfers > 0 && (
        <p style={styles.failed}>
          {stats.failedTransfers} failed transfer{stats.failedTransfers === 1 ? '' : 's'} — retry
          them from the iPhone.
        </p>
      )}

      {topMonth && (
        <p style={styles.recent}>
          Most recent month: <strong>{monthLabelFromStats(topMonth.label)}</strong> ·{' '}
          {topMonth.files.toLocaleString()} file{topMonth.files === 1 ? '' : 's'} ·{' '}
          {formatBytes(topMonth.bytes)}
        </p>
      )}
    </Card>
  );
}

/**
 * Split totals by media kind.
 *
 * `LibraryStats` reports bytes and counts separately, so the per-kind byte split is derived
 * from the month buckets, which are the only place both dimensions exist together.
 */
function photoBytes(stats: LibraryStats): number {
  const photoMonths = stats.months.filter((m) => m.label.startsWith('Photos/'));
  return photoMonths.reduce((sum, m) => sum + m.bytes, 0);
}

/** A compact bar of recent monthly volume, for a glance at backup cadence. */
export function MonthlyVolume({ stats }: { stats: LibraryStats | null }) {
  const months = stats?.months.slice(0, 6).reverse() ?? [];
  if (months.length === 0) {
    return null;
  }
  const peak = Math.max(...months.map((m) => m.bytes), 1);

  return (
    <Card title="Recent months" subtitle="How much has arrived over time.">
      <div style={styles.chart}>
        {months.map((month) => {
          const share = month.bytes / peak;
          return (
            <div key={month.label} style={styles.barColumn} title={`${formatBytes(month.bytes)} in ${monthLabelFromStats(month.label)}`}>
              <div style={styles.barTrack}>
                <div
                  style={{
                    ...styles.barFill,
                    height: `${Math.max(share * 100, 3)}%`,
                    background: colors.accent,
                  }}
                />
              </div>
              <span style={styles.barLabel}>{monthLabelFromStats(month.label).split(' ')[0]}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const styles: Record<string, CSSProperties> = {
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: spacing.md,
  },
  muted: { margin: 0, color: colors.textMuted, fontSize: 13 },
  failed: {
    margin: `${spacing.lg}px 0 0`,
    padding: `${spacing.sm}px ${spacing.md}px`,
    background: colors.warningSoft,
    color: colors.warning,
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 550,
  },
  recent: { margin: `${spacing.md}px 0 0`, fontSize: 12.5, color: colors.textMuted },
  chart: { display: 'flex', alignItems: 'flex-end', gap: spacing.md, height: 120 },
  barColumn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
  barTrack: {
    flex: 1,
    width: '100%',
    display: 'flex',
    alignItems: 'flex-end',
    background: colors.surfaceMuted,
    borderRadius: 6,
    overflow: 'hidden',
  },
  barFill: { width: '100%', borderRadius: 6, transition: 'height 240ms ease' },
  barLabel: { fontSize: 10.5, color: colors.textFaint, whiteSpace: 'nowrap' },
};
