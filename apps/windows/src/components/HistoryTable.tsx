import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { HistoryEntry } from '@localdrop/shared';
import { colors, radii, spacing } from '../styles/theme';
import { formatBytes, formatTimestamp, statusLabel, toneColors, truncateMiddle, type Tone } from '../lib/format';
import { Button, Card, EmptyState } from './ui';

export interface HistoryTableProps {
  entries: HistoryEntry[];
  total: number;
  loading: boolean;
  statusFilter: string;
  search: string;
  onStatusFilterChange: (status: string) => void;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
  onPage: (offset: number) => void;
  offset: number;
  limit: number;
}

const STATUS_TONE: Record<string, Tone> = {
  completed: 'success',
  failed: 'danger',
  aborted: 'neutral',
  skipped: 'neutral',
  uploading: 'accent',
  verifying: 'accent',
  pending: 'neutral',
};

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Backed up' },
  { value: 'failed', label: 'Failed' },
];

/**
 * Backup history.
 *
 * This is the audit view: every attempt, with its hash, its destination and its outcome, so a
 * user can confirm a specific photo really is on the PC rather than trusting a progress bar.
 */
export function HistoryTable({
  entries,
  total,
  loading,
  statusFilter,
  search,
  onStatusFilterChange,
  onSearchChange,
  onRefresh,
  onPage,
  offset,
  limit,
}: HistoryTableProps) {
  // Debounce the search so typing does not fire a request per keystroke.
  const [draft, setDraft] = useState(search);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draft !== search) {
        onSearchChange(draft);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, search, onSearchChange]);

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(Math.ceil(total / limit), 1);

  return (
    <Card
      title="Backup history"
      subtitle={`${total.toLocaleString()} transfer${total === 1 ? '' : 's'}`}
      padded={false}
      actions={<Button onClick={onRefresh}>Refresh</Button>}
    >
      <div style={styles.toolbar}>
        <div style={styles.filters}>
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => onStatusFilterChange(filter.value)}
              style={{
                ...styles.filter,
                ...(statusFilter === filter.value ? styles.filterActive : {}),
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search by filename…"
          style={styles.search}
          aria-label="Search backup history"
        />
      </div>

      {entries.length === 0 ? (
        <div style={styles.emptyWrap}>
          {loading ? (
            <p style={styles.muted}>Loading…</p>
          ) : (
            <EmptyState
              title="Nothing here yet"
              hint={
                search || statusFilter !== 'all'
                  ? 'Try a different filter or search term.'
                  : 'Transfers from your iPhone will appear here.'
              }
            />
          )}
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={th}>File</th>
                <th style={th}>Type</th>
                <th style={th}>Size</th>
                <th style={th}>Status</th>
                <th style={th}>Destination</th>
                <th style={th}>SHA-256</th>
                <th style={th}>When</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <HistoryRow key={entry.transferId} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > limit && (
        <div style={styles.pager}>
          <Button disabled={offset === 0} onClick={() => onPage(Math.max(offset - limit, 0))}>
            Previous
          </Button>
          <span style={styles.pagerLabel}>
            Page {page} of {pages}
          </span>
          <Button
            disabled={offset + limit >= total}
            onClick={() => onPage(offset + limit)}
          >
            Next
          </Button>
        </div>
      )}
    </Card>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const tone = STATUS_TONE[entry.status] ?? 'neutral';
  const { fg, bg } = toneColors(tone);
  return (
    <tr style={tr}>
      <td style={td}>
        <div style={styles.fileCell} title={entry.filename}>
          {entry.isLivePhotoVideo && (
            <span style={styles.liveBadge} title="Video half of a Live Photo">
              LIVE
            </span>
          )}
          <span style={styles.fileName}>{entry.filename}</span>
        </div>
        {entry.deviceName && <div style={styles.device}>{entry.deviceName}</div>}
      </td>
      <td style={td}>{entry.mediaType === 'video' ? 'Video' : 'Photo'}</td>
      <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{formatBytes(entry.fileSize)}</td>
      <td style={td}>
        <span style={{ ...styles.statusPill, color: fg, background: bg }}>
          {statusLabel(entry.status)}
        </span>
        {entry.errorMessage && (
          <div style={styles.errorText} title={entry.errorMessage}>
            {truncateMiddle(entry.errorMessage, 44)}
          </div>
        )}
      </td>
      <td style={td}>
        <code style={styles.mono} title={entry.absolutePath || entry.relativePath}>
          {truncateMiddle(entry.relativePath || '—', 40)}
        </code>
      </td>
      <td style={td}>
        <code style={styles.mono} title={entry.sha256}>
          {truncateMiddle(entry.sha256, 12)}
        </code>
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatTimestamp(entry.backedUpAt)}</td>
    </tr>
  );
}

const th: CSSProperties = {
  textAlign: 'left',
  padding: `${spacing.sm}px ${spacing.md}px`,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: colors.textFaint,
  background: colors.surfaceMuted,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
};

const td: CSSProperties = {
  padding: `${spacing.sm}px ${spacing.md}px`,
  fontSize: 12.5,
  borderBottom: `1px solid ${colors.border}`,
  verticalAlign: 'top',
};

// Row hover lives in the `table tbody tr:hover` rule in global.css: a pseudo-selector cannot be
// expressed through a React style object.
const tr: CSSProperties = {};

const styles: Record<string, CSSProperties> = {
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: `${spacing.md}px ${spacing.lg}px`,
    borderBottom: `1px solid ${colors.border}`,
    flexWrap: 'wrap',
  },
  filters: {
    display: 'flex',
    gap: 2,
    padding: 2,
    background: colors.surfaceMuted,
    borderRadius: radii.sm,
  },
  filter: {
    padding: '5px 12px',
    borderRadius: 5,
    border: 'none',
    background: 'transparent',
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: 600,
  },
  filterActive: { background: colors.surface, color: colors.text, boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
  search: {
    flex: 1,
    minWidth: 180,
    padding: '6px 12px',
    borderRadius: radii.sm,
    border: `1px solid ${colors.borderStrong}`,
    background: colors.surface,
    fontSize: 13,
    outline: 'none',
  },
  emptyWrap: { padding: spacing.xl },
  muted: { margin: 0, color: colors.textMuted, fontSize: 13 },
  tableWrap: { overflowX: 'auto', maxHeight: 460, overflowY: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' },
  fileCell: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  fileName: {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 220,
  },
  liveBadge: {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: 0.5,
    padding: '1px 4px',
    borderRadius: 3,
    background: colors.accentSoft,
    color: colors.accent,
    flexShrink: 0,
  },
  device: { fontSize: 11, color: colors.textFaint },
  statusPill: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: radii.pill,
    fontSize: 11.5,
    fontWeight: 650,
  },
  errorText: { fontSize: 11, color: colors.danger, marginTop: 3 },
  mono: {
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 11.5,
    color: colors.textMuted,
  },
  pager: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderTop: `1px solid ${colors.border}`,
  },
  pagerLabel: { fontSize: 12.5, color: colors.textMuted },
};
