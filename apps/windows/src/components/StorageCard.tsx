import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ServerSettingsResponse } from '@localdrop/shared';
import { colors, radii, spacing } from '../styles/theme';
import { formatBytes } from '../lib/format';
import { Button, Card, Pill } from './ui';

interface StorageCardProps {
  settings: ServerSettingsResponse | null;
  backupDirectory: string;
  freeSpaceBytes: number | null;
  onChoose: (directory: string) => Promise<void> | void;
  onPickFolder: () => Promise<string | null>;
}

/**
 * Storage location.
 *
 * `D:\iPhone Backup` is offered as the default when the drive exists; otherwise the PC's own
 * profile folder is used so first launch always lands somewhere writable. Both cases are shown
 * explicitly, because a backup the user cannot find is not a backup.
 */
export function StorageCard({
  settings,
  backupDirectory,
  freeSpaceBytes,
  onChoose,
  onPickFolder,
}: StorageCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (directory: string) => {
    setBusy(true);
    setError(null);
    try {
      await onChoose(directory);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await onPickFolder();
      if (picked) {
        await onChoose(picked);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const usingDefault =
    settings !== null &&
    backupDirectory.toLowerCase() === settings.defaultDirectory.toLowerCase();

  return (
    <Card
      title="Backup location"
      subtitle="Photos and videos are organised by type and the date they were taken."
      actions={
        <Button onClick={() => void handleBrowse()} disabled={busy}>
          Change folder…
        </Button>
      }
    >
      <div style={styles.pathBox}>
        <code style={styles.path} title={backupDirectory}>
          {backupDirectory}
        </code>
        {usingDefault ? (
          <Pill tone="success">Default</Pill>
        ) : (
          <Pill tone="accent">Custom</Pill>
        )}
      </div>

      <div style={styles.facts}>
        <Fact
          label="Free space"
          value={freeSpaceBytes === null ? 'Unknown' : formatBytes(freeSpaceBytes)}
        />
        <Fact
          label="Default location"
          value={settings ? shortPath(settings.defaultDirectory) : '—'}
          hint={
            settings?.defaultDirectoryAvailable === true
              ? 'available'
              : 'not available on this PC'
          }
        />
      </div>

      {settings && settings.suggestedDirectories.length > 0 && (
        <div style={styles.suggestions}>
          <span style={styles.suggestionsLabel}>Suggestions</span>
          <div style={styles.chips}>
            {settings.suggestedDirectories.slice(0, 5).map((directory) => (
              <button
                key={directory}
                type="button"
                disabled={busy || directory === backupDirectory}
                onClick={() => void apply(directory)}
                style={styles.chip}
                title={directory}
              >
                {shortPath(directory)}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p style={styles.error}>{error}</p>}

      <p style={styles.note}>
        LocalDrop never deletes anything from this folder or from your iPhone. It only adds
        verified copies.
      </p>
    </Card>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={styles.fact}>
      <span style={styles.factLabel}>{label}</span>
      <span style={styles.factValue} title={value}>
        {value}
      </span>
      {hint && <span style={styles.factHint}>{hint}</span>}
    </div>
  );
}

/** `D:\iPhone Backup` -> `D:\iPhone Backup`; a deep profile path -> `…\iPhone Backup`. */
function shortPath(directory: string): string {
  if (directory.length <= 28) {
    return directory;
  }
  const parts = directory.split(/[\\/]/);
  const tail = parts.slice(-2).join('\\');
  return `…\\${tail}`;
}

const styles: Record<string, CSSProperties> = {
  pathBox: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    padding: `${spacing.md}px ${spacing.lg}px`,
    background: colors.surfaceMuted,
    borderRadius: radii.md,
  },
  path: {
    flex: 1,
    minWidth: 0,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  fact: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  factLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  factValue: {
    fontSize: 13.5,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  factHint: { fontSize: 11.5, color: colors.textMuted },
  suggestions: { marginTop: spacing.lg },
  suggestionsLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    padding: '5px 10px',
    borderRadius: radii.pill,
    border: `1px solid ${colors.borderStrong}`,
    background: colors.surface,
    fontSize: 12,
    color: colors.text,
    maxWidth: 220,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  error: { margin: `${spacing.md}px 0 0`, color: colors.danger, fontSize: 13 },
  note: {
    margin: `${spacing.lg}px 0 0`,
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 1.5,
  },
};
