import type { CSSProperties } from 'react';
import { colors, radii, spacing } from '../styles/theme';
import { Pill } from './ui';
import type { ActivityItem } from '../lib/useServer';

/** Live feed of what the server has been doing, newest first. */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h2 style={styles.title}>Activity</h2>
        <Pill tone="neutral">{items.length}</Pill>
      </div>

      {items.length === 0 ? (
        <p style={styles.empty}>Nothing has happened yet.</p>
      ) : (
        <ul style={styles.list}>
          {items.map((item) => (
            <li key={item.id} style={styles.item}>
              <span style={{ ...styles.dot, background: dotColor(item.kind) }} />
              <div style={styles.body}>
                <span style={styles.message}>{item.message}</span>
                {item.detail && (
                  <span style={styles.detail} title={item.detail}>
                    {item.detail}
                  </span>
                )}
              </div>
              <span style={styles.time}>{relativeTime(item.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function dotColor(kind: ActivityItem['kind']): string {
  switch (kind) {
    case 'completed':
      return colors.success;
    case 'failed':
      return colors.danger;
    case 'skipped':
      return colors.textFaint;
    case 'connected':
      return colors.accent;
    default:
      return colors.warning;
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) {
    return 'now';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h`;
}

/** A small summary of connected devices for the sidebar. */
export function DeviceList({
  devices,
  connected,
}: {
  devices: Array<{ deviceId: string; deviceName: string; lastSeenAt: string | null }>;
  connected: string[];
}) {
  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h2 style={styles.title}>Paired iPhones</h2>
        <Pill tone={connected.length > 0 ? 'live' : 'neutral'}>{connected.length} online</Pill>
      </div>

      {devices.length === 0 ? (
        <p style={styles.empty}>
          No iPhone has been paired yet. Enter the code on your iPhone to get started.
        </p>
      ) : (
        <ul style={styles.list}>
          {devices.map((device) => {
            const online = connected.includes(device.deviceId);
            return (
              <li key={device.deviceId} style={styles.item}>
                <span
                  style={{
                    ...styles.dot,
                    background: online ? colors.success : colors.textFaint,
                  }}
                />
                <div style={styles.body}>
                  <span style={styles.message}>{device.deviceName}</span>
                  <span style={styles.detail}>
                    {online ? 'Connected' : lastSeenLabel(device.lastSeenAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) {
    return 'Never connected';
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return 'Never connected';
  }
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60000);
  if (minutes < 1) {
    return 'Last seen just now';
  }
  if (minutes < 60) {
    return `Last seen ${minutes}m ago`;
  }
  if (minutes < 1440) {
    return `Last seen ${Math.floor(minutes / 60)}h ago`;
  }
  return `Last seen ${Math.floor(minutes / 1440)}d ago`;
}

const styles: Record<string, CSSProperties> = {
  panel: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${spacing.md}px ${spacing.lg}px`,
    borderBottom: `1px solid ${colors.border}`,
  },
  title: { margin: 0, fontSize: 14, fontWeight: 650 },
  list: { listStyle: 'none', margin: 0, padding: `${spacing.sm}px 0`, maxHeight: 260, overflowY: 'auto' },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: `${spacing.sm}px ${spacing.lg}px`,
  },
  dot: { width: 7, height: 7, borderRadius: '50%', marginTop: 7, flexShrink: 0 },
  body: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  message: {
    fontSize: 12.5,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detail: {
    fontSize: 11.5,
    color: colors.textMuted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: { fontSize: 11, color: colors.textFaint, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  empty: {
    margin: 0,
    padding: `${spacing.lg}px`,
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 1.5,
  },
};
