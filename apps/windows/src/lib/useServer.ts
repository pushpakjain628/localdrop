/**
 * Live server state for the dashboard.
 *
 * The server pushes `ServerEvent`s over a WebSocket; this hook owns the connection, keeps the
 * derived state the UI renders, and degrades gracefully: if the socket drops, stats are
 * re-polled so the dashboard is still accurate, just less immediate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HealthResponse,
  LibraryStats,
  ServerEvent,
  ServerSettingsResponse,
} from '@localdrop/shared';
import { api, LocalDropApi, type PairedDevice } from './api';

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'offline';

export interface ActiveTransfer {
  transferId: string;
  filename: string;
  mediaType: 'photo' | 'video';
  fileSize: number;
  bytesReceived: number;
  bytesPerSecond: number;
  deviceName: string | null;
}

export interface ServerState {
  connection: ConnectionState;
  health: HealthResponse | null;
  stats: LibraryStats | null;
  settings: ServerSettingsResponse | null;
  devices: PairedDevice[];
  connectedDevices: string[];
  active: ActiveTransfer | null;
  lastError: string | null;
  /** Bumped whenever stats change, so history can refetch. */
  revision: number;
  refresh: () => Promise<void>;
  setBackupDirectory: (directory: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 4000;

/** Recent activity shown as a ticker, newest first. */
export interface ActivityItem {
  id: string;
  at: number;
  kind: 'completed' | 'failed' | 'skipped' | 'started' | 'connected';
  message: string;
  detail?: string;
}

const MAX_ACTIVITY = 40;

export function useServer(
  apiClient: LocalDropApi = api,
): ServerState & { activity: ActivityItem[] } {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [settings, setSettings] = useState<ServerState['settings']>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [connectedDevices, setConnectedDevices] = useState<string[]>([]);
  const [active, setActive] = useState<ActiveTransfer | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  const pushActivity = useCallback((item: Omit<ActivityItem, 'id' | 'at'>) => {
    setActivity((previous: ActivityItem[]) =>
      [
        {
          ...item,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: Date.now(),
        },
        ...previous,
      ].slice(0, MAX_ACTIVITY),
    );
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [nextHealth, nextStats, nextSettings, nextDevices] = await Promise.all([
        apiClient.health(),
        apiClient.stats(),
        apiClient.settings(),
        apiClient.pairedDevices(),
      ]);
      if (!mountedRef.current) {
        return;
      }
      setHealth(nextHealth);
      setStats(nextStats);
      setSettings(nextSettings);
      setDevices(nextDevices.devices);
      setConnectedDevices(nextDevices.connected);
      setLastError(null);
    } catch (error) {
      if (mountedRef.current) {
        setLastError(error instanceof Error ? error.message : String(error));
        setConnection('offline');
      }
    }
  }, [apiClient]);

  useEffect(() => {
    mountedRef.current = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const applyEvent = (event: ServerEvent): void => {
      switch (event.type) {
        case 'stats_changed':
          setStats(event.stats);
          setRevision((r) => r + 1);
          break;
        case 'server_started':
          setHealth((previous) =>
            previous
              ? { ...previous, backupDirectory: event.backupDirectory, serverName: event.serverName }
              : previous,
          );
          setRevision((r) => r + 1);
          break;
        case 'client_connected':
          pushActivity({
            kind: 'connected',
            message: `${event.deviceName} connected`,
            detail: event.deviceId,
          });
          void loadAll();
          break;
        case 'client_disconnected':
          pushActivity({ kind: 'connected', message: `${event.deviceName} disconnected` });
          void loadAll();
          break;
        case 'transfer_started':
          setActive({
            transferId: event.transferId,
            filename: event.filename,
            mediaType: event.mediaType,
            fileSize: event.fileSize,
            bytesReceived: 0,
            bytesPerSecond: 0,
            deviceName: event.deviceName,
          });
          pushActivity({ kind: 'started', message: `Receiving ${event.filename}` });
          break;
        case 'transfer_progress':
          setActive((previous) =>
            previous && previous.transferId === event.transferId
              ? {
                  ...previous,
                  bytesReceived: event.bytesReceived,
                  bytesPerSecond: event.bytesPerSecond,
                }
              : previous,
          );
          break;
        case 'transfer_completed':
          setActive((previous) => (previous?.transferId === event.transferId ? null : previous));
          pushActivity({
            kind: 'completed',
            message: `Backed up ${basename(event.relativePath)}`,
            detail: event.verified ? 'SHA-256 verified' : 'verification failed',
          });
          setRevision((r) => r + 1);
          break;
        case 'transfer_failed':
          setActive((previous) => (previous?.transferId === event.transferId ? null : previous));
          pushActivity({ kind: 'failed', message: event.filename, detail: event.error });
          setRevision((r) => r + 1);
          break;
        case 'transfer_skipped':
          pushActivity({ kind: 'skipped', message: event.filename, detail: event.reason });
          break;
        default:
          break;
      }
    };

    const connect = async (): Promise<void> => {
      try {
        await apiClient.authenticate();
      } catch (error) {
        if (!disposed) {
          setLastError(error instanceof Error ? error.message : String(error));
          setConnection('offline');
        }
        return;
      }
      if (disposed) {
        return;
      }
      try {
        socket = new WebSocket(apiClient.eventStreamUrl());
        socketRef.current = socket;

        socket.onopen = () => {
          if (!disposed) {
            setConnection('live');
            setLastError(null);
          }
        };
        socket.onmessage = (message) => {
          if (disposed || typeof message.data !== 'string') {
            return;
          }
          try {
            applyEvent(JSON.parse(message.data) as ServerEvent);
          } catch {
            // A malformed frame is not worth tearing the socket down for.
          }
        };
        socket.onerror = () => {
          if (!disposed) {
            setConnection('polling');
          }
        };
        socket.onclose = () => {
          if (disposed) {
            return;
          }
          setConnection('polling');
          // Reconnect with a fixed short delay. The server is on this machine, so a dropped
          // socket means the app is restarting rather than a flaky network.
          reconnectTimer = window.setTimeout(() => void connect(), 2000);
        };
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error));
        setConnection('polling');
      }
    };

    void loadAll();
    void connect();

    // Polling is the floor: it keeps the dashboard correct even with no socket, and it is what
    // picks up changes the event stream does not cover (settings edited by hand, for example).
    const pollTimer = window.setInterval(() => {
      void loadAll();
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      mountedRef.current = false;
      window.clearInterval(pollTimer);
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
      socketRef.current = null;
    };
  }, [apiClient, loadAll, pushActivity]);

  const setBackupDirectory = useCallback(
    async (directory: string) => {
      await apiClient.setBackupDirectory(directory);
      await loadAll();
    },
    [apiClient, loadAll],
  );

  return useMemo(
    () => ({
      connection,
      health,
      stats,
      settings,
      devices,
      connectedDevices,
      active,
      activity,
      lastError,
      revision,
      refresh: loadAll,
      setBackupDirectory,
    }),
    [
      connection,
      health,
      stats,
      settings,
      devices,
      connectedDevices,
      active,
      activity,
      lastError,
      revision,
      loadAll,
      setBackupDirectory,
    ],
  );
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}
