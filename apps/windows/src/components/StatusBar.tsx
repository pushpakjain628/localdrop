import type { CSSProperties } from 'react';
import { colors, shadows, spacing, type } from '../styles/theme';
import { Pill } from './ui';
import type { Tone } from '../lib/format';
import type { ConnectionState } from '../lib/useServer';
import type { HealthResponse } from '@localdrop/shared';
import { DEFAULT_PORT } from '@localdrop/shared';

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
        <div style={styles.identityText}>
          <div style={styles.title}>LocalDrop</div>
          <div style={styles.subtitle}>{health?.serverName ?? 'Windows PC'}</div>
        </div>
      </div>

      <div style={styles.statusGroup}>
        <StatusPill connection={connection} />

        {/* The manual-entry fallback. The phone's "enter address" sheet tells the user to read
            this from the top bar, so it has to be here - and it has to be selectable, because
            reading an address off a screen and retyping it is where transposed digits come from.
            It is the first fact on the right because it is the one the user needs when pairing
            is not working, and pairing not working is when they open this app. */}
        <MetaLabel
          label="On this network"
          value={
            health?.lanAddresses?.length
              ? health.lanAddresses.map((address) => `${address}:${DEFAULT_PORT}`).join('  ')
              : 'None found'
          }
          tone={health?.lanAddresses?.length ? 'neutral' : 'warning'}
          selectable
        />

        <MetaLabel
          label="Library"
          value={health?.backupDirectory ?? '—'}
          tone={storageWritable ? 'neutral' : 'danger'}
        />

        <MetaLabel
          label="Free space"
          value={freeSpaceBytes === null ? 'Unknown' : formatFree(freeSpaceBytes)}
          tone={freeSpaceBytes !== null && freeSpaceBytes < 5 * 1024 ** 3 ? 'warning' : 'neutral'}
        />

        <MetaLabel
          label="Waiting for"
          value={health?.paired ? 'a connected iPhone' : 'you to pair one'}
          tone={health?.paired ? 'success' : 'warning'}
        />
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
  selectable = false,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
  /** Lets the user copy the value. Worth it for an address they have to retype on a phone. */
  selectable?: boolean;
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
      <span
        style={{ ...styles.metaValue, color, userSelect: selectable ? 'text' : undefined }}
        title={value}
      >
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
    padding: `${spacing.lg}px ${spacing.xl}px`,
    background: colors.surface,
    boxShadow: `0 1px 0 ${colors.border}, ${shadows.card}`,
    // Wrapping is allowed, but each fact is sized to its own content and never wraps mid-value,
    // so a narrow window reflows into two clean rows instead of a ragged one.
    flexWrap: 'wrap',
    rowGap: spacing.lg,
  },
  identity: { display: 'flex', alignItems: 'center', gap: spacing.md, flexShrink: 0 },
  identityText: { minWidth: 0 },
  logo: { flexShrink: 0, borderRadius: 9 },
  title: { fontSize: 16, fontWeight: 700, letterSpacing: -0.2 },
  subtitle: { fontSize: 12.5, color: colors.textMuted },
  statusGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.xl,
    flexWrap: 'wrap',
    rowGap: spacing.md,
    // The facts are pushed to the right and are allowed to use the space they need; the
    // identity block keeps its place on the left.
    marginLeft: 'auto',
  },
  // A hairline between facts instead of a box around each. Four outlined boxes in a row read as
  // four separate widgets; a rule reads as one strip of related information.
  metaItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    paddingLeft: spacing.lg,
    borderLeft: `1px solid ${colors.border}`,
  },
  metaLabel: { ...type.label, color: colors.textFaint },
  metaValue: {
    fontSize: 13,
    fontWeight: 600,
    maxWidth: 280,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
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
