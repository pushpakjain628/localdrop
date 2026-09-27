import type { CSSProperties } from 'react';
import { formatDuration } from '../lib/format';
import { formatBytes, formatRate } from '../lib/format';
import { colors, spacing } from '../styles/theme';
import { Card, Pill, ProgressBar } from './ui';
import type { ActiveTransfer } from '../lib/useServer';

/**
 * The live transfer panel.
 *
 * Speed and ETA are the numbers a user actually watches during a backup, so they get top
 * billing; the destination path is shown too, because "where did it go?" is the first question
 * after a successful run.
 */
export function CurrentTransfer({ active }: { active: ActiveTransfer | null }) {
  if (!active) {
    return (
      <Card title="Current transfer">
        <IdleState />
      </Card>
    );
  }

  const fraction = active.fileSize > 0 ? active.bytesReceived / active.fileSize : 0;
  const remainingBytes = Math.max(active.fileSize - active.bytesReceived, 0);
  const eta =
    active.bytesPerSecond > 0 ? Math.round(remainingBytes / active.bytesPerSecond) : null;

  return (
    <Card
      title="Current transfer"
      actions={<Pill tone="live">Receiving</Pill>}
    >
      <div style={styles.fileRow}>
        <div style={styles.fileIcon}>{active.mediaType === 'video' ? '▶' : '◉'}</div>
        <div style={styles.fileText}>
          <div style={styles.filename} title={active.filename}>
            {active.filename}
          </div>
          <div style={styles.fileMeta}>
            {formatBytes(active.bytesReceived)} of {formatBytes(active.fileSize)}
            {active.deviceName ? ` · from ${active.deviceName}` : ''}
          </div>
        </div>
        <div style={styles.percent}>{Math.round(fraction * 100)}%</div>
      </div>

      <div style={styles.progressWrap}>
        <ProgressBar fraction={fraction} tone="live" />
      </div>

      <div style={styles.metrics}>
        <Metric label="Speed" value={formatRate(active.bytesPerSecond)} />
        <Metric label="Remaining" value={eta === null ? '—' : formatDuration(eta)} />
        <Metric label="Left to send" value={formatBytes(remainingBytes)} />
      </div>
    </Card>
  );
}

function IdleState() {
  return (
    <div style={styles.idle}>
      <div style={styles.idleGlyph} aria-hidden="true">
        ↓
      </div>
      <div>
        <p style={styles.idleTitle}>No transfer in progress</p>
        <p style={styles.idleHint}>
          Open LocalDrop on your iPhone, pick this PC, and tap “Backup to PC”.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  fileRow: { display: 'flex', alignItems: 'center', gap: spacing.md },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    background: colors.surfaceMuted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    color: colors.textMuted,
    flexShrink: 0,
  },
  fileText: { flex: 1, minWidth: 0 },
  filename: {
    fontWeight: 620,
    fontSize: 14.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: { fontSize: 12.5, color: colors.textMuted },
  percent: {
    fontSize: 20,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: colors.success,
  },
  progressWrap: { marginTop: spacing.md },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  metric: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: `${spacing.sm}px ${spacing.md}px`,
    background: colors.surfaceMuted,
    borderRadius: 8,
  },
  metricLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: 650,
    fontVariantNumeric: 'tabular-nums',
  },
  idle: { display: 'flex', alignItems: 'center', gap: spacing.lg },
  idleGlyph: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: colors.surfaceMuted,
    color: colors.textFaint,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    flexShrink: 0,
  },
  idleTitle: { margin: 0, fontWeight: 620 },
  idleHint: { margin: '2px 0 0', fontSize: 13, color: colors.textMuted },
};
