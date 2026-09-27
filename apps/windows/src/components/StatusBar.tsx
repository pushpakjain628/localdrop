import type { CSSProperties } from 'react';
import { colors, spacing } from '../styles/theme';
import { Pill } from './ui';
import type { Tone } from '../lib/format';
import type { ConnectionState } from '../lib/useServer';
import type { HealthResponse } from '@localdrop/shared';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Starting up',
  live: 'Live',
  polling: 'Connected',
  offline: 'Server unreachable',
};

const CONNECTION_TONE: Record<ConnectionState, Tone> = {
  connecting: 'warning',
  live: 'live',
  polling: 'accent',
  offline: 'danger',
};

/**
 * Top bar: the three things a user needs before they trust anything else on screen - is the
 * server running, what is it called, and is the library where they expect it.
 */
export function StatusBar({
  health,
  connection,
  freeSpaceBytes,
  storageWritable,
}: {
  health: HealthResponse | null;
  connection: ConnectionState;
  freeSpaceBytes: number | null;
  storageWritable: boolean;
}) {
  return (
    <header style={styles.bar}>
      <div style={styles.identity}>
        <Logo />
        <div>
          <div style={styles.title}>LocalDrop</div>
          <div style={styles.subtitle}>{health?.serverName ?? 'Windows PC'}</div>
        </div>
      </div>

      <div style={styles.statusGroup}>
        <StatusPill connection={connection} />

        <div style={styles.meta}>
          <MetaLabel
            label="Library"
            value={health?.backupDirectory ?? '—'}
            tone={storageWritable ? 'neutral' : 'danger'}
          />
        </div>

        <div style={styles.meta}>
          <MetaLabel
            label="Free space"
            value={freeSpaceBytes === null ? 'Unknown' : formatFree(freeSpaceBytes)}
            tone={freeSpaceBytes !== null && freeSpaceBytes < 5 * 1024 ** 3 ? 'warning' : 'neutral'}
          />
        </div>

        <div style={styles.meta}>
          <MetaLabel
            label="Waiting for"
            value={health?.paired ? 'a connected iPhone' : 'you to pair an iPhone'}
            tone={health?.paired ? 'success' : 'warning'}
          />
        </div>
      </div>
    </header>
  );
}

function StatusPill({ connection }: { connection: ConnectionState }) {
  return (
    <Pill tone={CONNECTION_TONE[connection]}>
      {connection === 'live' && <Pulse />}
      {CONNECTION_LABEL[connection]}
    </Pill>
  );
}

function MetaLabel({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  const color = {
    neutral: colors.textMuted,
    warning: colors.warning,
    danger: colors.danger,
    success: colors.success,
  }[tone];
  return (
    <div style={styles.metaItem}>
      <span style={styles.metaLabel}>{label}</span>
      <span style={{ ...styles.metaValue, color }} title={value}>
        {value}
      </span>
    </div>
  );
}

/** Breathing dot that marks a live WebSocket connection. */
function Pulse() {
  return (
    <span style={styles.pulseWrap}>
      <style>{`
        @keyframes localdrop-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(0.82); }
        }
      `}</style>
      <span style={styles.pulse} />
    </span>
  );
}

function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true" style={styles.logo}>
      <rect width="48" height="48" rx="11" fill={colors.accent} />
      <rect x="23.2" y="12" width="4.8" height="15" rx="1.4" fill="#fff" />
      <path d="M16 25 L24 34 L32 25 Z" fill="#fff" />
      <rect x="15" y="37.8" width="21.2" height="3.4" rx="1.7" fill="#fff" opacity="0.85" />
    </svg>
  );
}

function formatFree(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const styles: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xl,
    padding: `${spacing.md}px ${spacing.xl}px`,
    background: colors.surface,
    borderBottom: `1px solid ${colors.border}`,
    flexWrap: 'wrap',
  },
  identity: { display: 'flex', alignItems: 'center', gap: spacing.md },
  logo: { flexShrink: 0, borderRadius: 9 },
  title: { fontSize: 16, fontWeight: 680, letterSpacing: -0.2 },
  subtitle: { fontSize: 12.5, color: colors.textMuted },
  statusGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.xl,
    flexWrap: 'wrap',
  },
  meta: { minWidth: 0 },
  metaItem: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  metaLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  metaValue: {
    fontSize: 13,
    fontWeight: 600,
    maxWidth: 260,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pulseWrap: { display: 'inline-flex', width: 8, height: 8 },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'currentColor',
    animation: 'localdrop-pulse 1.6s ease-in-out infinite',
  },
};
