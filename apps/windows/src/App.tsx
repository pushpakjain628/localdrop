import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { HistoryEntry, RotatePairingCodeResponse } from '@localdrop/shared';
import { api } from './lib/api';
import { useServer } from './lib/useServer';
import { colors, spacing } from './styles/theme';
import { ActivityFeed, DeviceList } from './components/ActivityFeed';
import { CurrentTransfer } from './components/CurrentTransfer';
import { HistoryTable } from './components/HistoryTable';
import { LibraryStatsCard, MonthlyVolume } from './components/LibraryStatsCard';
import { PairingCard } from './components/PairingCard';
import { StatusBar } from './components/StatusBar';
import { StorageCard } from './components/StorageCard';
import { ErrorBanner } from './components/ui';

const HISTORY_PAGE_SIZE = 25;

export function App() {
  const server = useServer(api);
  const [pairing, setPairing] = useState<RotatePairingCodeResponse | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  // Poll for a code until one exists. A phone cannot pair until the PC is showing one, so this
  // is part of the first-run experience rather than an optional extra.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const code = await api.pairingCode();
        if (!cancelled) {
          setPairing(code);
          setPairingError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPairingError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [server.revision]);

  const rotateCode = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      setPairing(await api.rotatePairingCode());
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : String(error));
    } finally {
      setPairingBusy(false);
    }
  }, []);

  // History is fetched on demand and refetched whenever the server reports a change, rather
  // than continuously: it is an audit view, not a live meter.
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    api
      .history({
        limit: HISTORY_PAGE_SIZE,
        offset,
        status: statusFilter === 'all' ? undefined : statusFilter,
        search: search.trim() === '' ? undefined : search.trim(),
      })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setHistory(response.entries);
        setHistoryTotal(response.total);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDismissedError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [offset, statusFilter, search, server.revision]);

  // Changing a filter or a search term must return to the first page, otherwise the user lands
  // on an empty page 4 of results that only has 1.
  const handleFilterChange = useCallback((status: string) => {
    setStatusFilter(status);
    setOffset(0);
  }, []);
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setOffset(0);
  }, []);

  const pickFolder = useCallback(async (): Promise<string | null> => {
    // The dialog plugin is only available inside the Tauri shell. In a plain browser (used for
    // UI work) fall back to a typed path so the flow is still exercisable.
    try {
      const dialog = await import('@tauri-apps/plugin-dialog');
      const selected = await dialog.open({
        directory: true,
        multiple: false,
        title: 'Choose where LocalDrop should store your backups',
        defaultPath: server.settings?.defaultDirectory ?? undefined,
      });
      return typeof selected === 'string' ? selected : null;
    } catch {
      const answer = window.prompt('Enter the full path to your backup folder:');
      return answer && answer.trim().length > 0 ? answer.trim() : null;
    }
  }, [server.settings]);

  const error = useMemo(
    () => (server.lastError && server.lastError !== dismissedError ? server.lastError : null),
    [server.lastError, dismissedError],
  );

  return (
    <div style={styles.app}>
      <StatusBar
        health={server.health}
        connection={server.connection}
        freeSpaceBytes={server.health?.freeSpaceBytes ?? null}
        storageWritable={server.health?.storageWritable ?? false}
      />

      {error && <ErrorBanner message={error} onDismiss={() => setDismissedError(error)} />}

      <main style={styles.main}>
        <div style={styles.primary}>
          <CurrentTransfer active={server.active} />

          <PairingCard
            code={pairing?.code ?? null}
            expiresAt={pairing?.expiresAt ?? null}
            onRotate={rotateCode}
            busy={pairingBusy}
            error={pairingError}
          />

          <StorageCard
            settings={server.settings}
            backupDirectory={server.health?.backupDirectory ?? '—'}
            freeSpaceBytes={server.health?.freeSpaceBytes ?? null}
            onChoose={server.setBackupDirectory}
            onPickFolder={pickFolder}
          />
        </div>

        <aside style={styles.sidebar}>
          <LibraryStatsCard stats={server.stats} />
          <DeviceList devices={server.devices} connected={server.connectedDevices} />
          <ActivityFeed items={server.activity} />
        </aside>

        <div style={styles.fullWidth}>
          <MonthlyVolume stats={server.stats} />
        </div>

        <div style={styles.fullWidth}>
          <HistoryTable
            entries={history}
            total={historyTotal}
            loading={historyLoading}
            statusFilter={statusFilter}
            search={search}
            onStatusFilterChange={handleFilterChange}
            onSearchChange={handleSearchChange}
            onRefresh={() => setOffset((o) => o)}
            onPage={setOffset}
            offset={offset}
            limit={HISTORY_PAGE_SIZE}
          />
        </div>
      </main>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', minHeight: '100%' },
  main: {
    flex: 1,
    display: 'grid',
    // The primary column is wider, but the sidebar has a floor so a long library path or a long
    // PC name cannot squeeze the stats into unreadable slivers.
    gridTemplateColumns: 'minmax(0, 1.55fr) minmax(320px, 1fr)',
    gridAutoRows: 'min-content',
    gap: spacing.xl,
    // A measure cap: past roughly 1500px the two columns drift so far apart that the eye stops
    // treating them as one dashboard, and the cards get so wide that a short line of text in one
    // has nothing to line up against in the other.
    maxWidth: 1520,
    width: '100%',
    margin: '0 auto',
    padding: spacing.xl,
    alignItems: 'start',
  },
  primary: { display: 'flex', flexDirection: 'column', gap: spacing.xl, minWidth: 0 },
  sidebar: { display: 'flex', flexDirection: 'column', gap: spacing.xl, minWidth: 0 },
  fullWidth: { gridColumn: '1 / -1' },
  // Kept on the scroll container rather than the body so the app chrome does not flash white
  // while scrolling.
  body: { background: colors.bg },
};
