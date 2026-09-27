/**
 * Thin client for the local backup server.
 *
 * The dashboard runs inside the Tauri webview on the same machine as the server, so it talks
 * to `http://127.0.0.1:<port>` over loopback. It authenticates with a per-launch token that
 * the server hands it from `GET /api/dashboard-token` - a value that is regenerated on every
 * start of the desktop app and only unlocks loopback-only routes. It is deliberately *not* a
 * phone's bearer token: the dashboard must never be able to act as a paired iPhone.
 */

import type {
  HealthResponse,
  HistoryResponse,
  LibraryStats,
  RotatePairingCodeResponse,
  ServerSettingsResponse,
} from '@localdrop/shared';
import { API_PREFIX, DEFAULT_PORT, PROTOCOL_VERSION } from '@localdrop/shared';

/** Must match `DASHBOARD_TOKEN_HEADER` in `src-tauri/src/http/middleware.rs`. */
const DASHBOARD_TOKEN_HEADER = 'x-localdrop-dashboard';

const API_VERSION_HEADERS: Record<string, string> = {
  'x-localdrop-protocol': String(PROTOCOL_VERSION),
};

export class ServerRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServerRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  osVersion: string;
  appVersion: string;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
}

export interface PairedDevicesResponse {
  devices: PairedDevice[];
  connected: string[];
}

export class LocalDropApi {
  private token: string | null = null;

  constructor(private readonly baseUrl: string = '') {}

  /** Fetches and caches this launch's dashboard token. Safe to call repeatedly. */
  async authenticate(): Promise<void> {
    if (this.token !== null) {
      return;
    }
    const body = await this.rawRequest<{ token: string }>('/dashboard-token', {});
    this.token = body.token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...API_VERSION_HEADERS,
      ...(this.token ? { [DASHBOARD_TOKEN_HEADER]: this.token } : {}),
      ...extra,
    };
  }

  private async rawRequest<T>(path: string, init: RequestInit, timeoutMs = 10_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
        ...init,
        signal: controller.signal,
        headers: this.headers(init.headers as Record<string, string> | undefined),
      });

      const text = await response.text();
      const body: unknown = text.length > 0 ? safeParse(text) : null;

      if (!response.ok) {
        const detail = extractError(body);
        throw new ServerRequestError(response.status, detail.code, detail.message);
      }
      return body as T;
    } catch (error) {
      if (error instanceof ServerRequestError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServerRequestError(0, 'timeout', 'The server did not respond in time.');
      }
      throw new ServerRequestError(
        0,
        'network_error',
        'Could not reach the LocalDrop server. Is the app still running?',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.rawRequest<T>(path, { method: 'GET' });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.rawRequest<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  /** Liveness probe. Unauthenticated, so it also tells us whether the token is still valid. */
  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  stats(): Promise<LibraryStats> {
    return this.get<LibraryStats>('/stats');
  }

  history(
    options: { limit?: number; offset?: number; status?: string; search?: string } = {},
  ): Promise<HistoryResponse> {
    return this.get<HistoryResponse>(
      `/history${query({
        limit: options.limit ?? 50,
        offset: options.offset ?? 0,
        status: options.status,
        search: options.search,
      })}`,
    );
  }

  settings(): Promise<ServerSettingsResponse> {
    return this.get<ServerSettingsResponse>('/settings');
  }

  setBackupDirectory(directory: string) {
    return this.post<{
      backupDirectory: string;
      storageWritable: boolean;
      freeSpaceBytes: number | null;
    }>('/settings/backup-directory', { directory });
  }

  pairingCode(): Promise<RotatePairingCodeResponse> {
    return this.get<RotatePairingCodeResponse>('/pairing/code');
  }

  rotatePairingCode(): Promise<RotatePairingCodeResponse> {
    return this.post<RotatePairingCodeResponse>('/pairing/rotate', {});
  }

  pairedDevices(): Promise<PairedDevicesResponse> {
    return this.get<PairedDevicesResponse>('/paired-devices');
  }

  /** URL of the live event stream. The token travels as a query parameter because a browser
   *  `WebSocket` cannot set request headers. */
  eventStreamUrl(): string {
    const wsBase = this.baseUrl
      ? this.baseUrl.replace(/^http/, 'ws')
      : `ws://127.0.0.1:${DEFAULT_PORT}`;
    return `${wsBase}${API_PREFIX}/events${query({ token: this.token })}`;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'invalid_response', message: text } };
  }
}

function extractError(body: unknown): { code: string; message: string } {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: { code?: unknown; message?: unknown } }).error !== null
  ) {
    const error = (body as { error: { code?: unknown; message?: unknown } }).error;
    return {
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : 'Request failed.',
    };
  }
  return { code: 'unknown', message: 'Request failed.' };
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

/** Shared instance used by the dashboard. */
export const api = new LocalDropApi();
