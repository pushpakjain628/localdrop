/**
 * Server identity and the HTTP client for the paired PC.
 *
 * Only small JSON control-plane calls go through `fetch`. The file bytes go through the native
 * uploader, which streams from disk - routing a multi-gigabyte body through React Native's
 * `fetch` would materialise it in the JS heap.
 */

import {
  API_PREFIX,
  API_VERSION_HEADER,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  type AbortTransferResponse,
  type AssetStatusResponse,
  type BeginTransferRequest,
  type BeginTransferResponse,
  type CompleteTransferRequest,
  type CompleteTransferResponse,
  type HealthResponse,
  type HistoryResponse,
  type PairRequest,
  type PairResponse,
} from '@localdrop/shared';

/** A PC the app can talk to, whether discovered or entered by hand. */
export interface ServerEndpoint {
  /** Stable id from `/api/health`, or a synthesised one for an unverified address. */
  serverId: string;
  name: string;
  host: string;
  port: number;
  /** True when the address came from Bonjour rather than being typed in. */
  discovered: boolean;
  /** Advertised protocol version, 0 when unknown. */
  protocolVersion: number;
}

/** A server plus the credential needed to use it. */
export interface Connection {
  endpoint: ServerEndpoint;
  token: string;
}

/** A failure the UI can show verbatim. */
export class ServerError extends Error {
  readonly code: string;
  readonly status: number;
  /** True when re-pairing is the fix, which the UI should offer as a button. */
  readonly needsPairing: boolean;

  constructor(message: string, code: string, status: number, needsPairing = false) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.status = status;
    this.needsPairing = needsPairing;
  }
}

/** Base URL for a host/port pair. */
export function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** Builds a full API URL. */
export function apiUrl(host: string, port: number, path: string): string {
  return `${baseUrl(host, port)}${API_PREFIX}${path}`;
}

/** Endpoint for the upload body of a transfer. */
export function uploadUrl(host: string, port: number, transferId: string): string {
  return apiUrl(host, port, `/transfers/${encodeURIComponent(transferId)}/content`);
}

const PROTOCOL_HEADERS: Record<string, string> = {
  [API_VERSION_HEADER]: String(PROTOCOL_VERSION),
};

function withAuth(token: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...PROTOCOL_HEADERS,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * Reads the server's error envelope into a `ServerError`.
 *
 * Falling back to the status code keeps the message useful even if the body is not the
 * documented shape - which is exactly the case when a phone hits a non-LocalDrop server that
 * happens to be on the same port.
 */
async function toServerError(response: Response): Promise<ServerError> {
  let message = `The PC responded with ${response.status}.`;
  let code = 'http_error';
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body?.error?.message) {
      message = body.error.message;
    }
    if (body?.error?.code) {
      code = body.error.code;
    }
  } catch {
    // Body was not JSON; keep the status-derived message.
  }
  return new ServerError(message, code, response.status, response.status === 401);
}

/**
 * Performs a JSON request against a server.
 *
 * Every call is bounded by a timeout: a phone that has walked out of Wi-Fi range should show an
 * error, not spin forever.
 */
async function request<T>(
  host: string,
  port: number,
  path: string,
  init: RequestInit & { token?: string | null; timeoutMs?: number } = {},
): Promise<T> {
  const { token = null, timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl(host, port, path), {
      ...rest,
      signal: controller.signal,
      headers: withAuth(token, rest.headers as Record<string, string> | undefined),
    });
    if (!response.ok) {
      throw await toServerError(response);
    }
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof ServerError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServerError(
        'The PC did not respond in time. Check that both devices are on the same Wi-Fi network.',
        'timeout',
        0,
      );
    }
    throw new ServerError(
      'Could not reach the PC. Check that LocalDrop is running and both devices are on the same Wi-Fi.',
      'network_error',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The client used by the rest of the app.
 *
 * A class rather than free functions so the token cannot be accidentally omitted: forgetting it
 * is the difference between a working backup and a 401 that is hard to diagnose.
 */
export class ServerClient {
  constructor(private readonly connection: Connection) {}

  get endpoint(): ServerEndpoint {
    return this.connection.endpoint;
  }

  get token(): string {
    return this.connection.token;
  }

  get host(): string {
    return this.connection.endpoint.host;
  }

  get port(): number {
    return this.connection.endpoint.port;
  }

  /** Unauthenticated liveness and capability probe. */
  async health(): Promise<HealthResponse> {
    return request<HealthResponse>(this.host, this.port, '/health', {
      method: 'GET',
      timeoutMs: 6000,
    });
  }

  /** Confirms a stored token is still accepted before the user tries a backup. */
  async verifySession(): Promise<boolean> {
    await request(this.host, this.port, '/session/verify', {
      method: 'POST',
      token: this.token,
      body: '{}',
      timeoutMs: 6000,
    });
    return true;
  }

  /** Exchanges a verification code for a long-lived token. */
  async pair(pairRequest: PairRequest, code: string): Promise<PairResponse> {
    return request<PairResponse>(this.host, this.port, '/pair', {
      method: 'POST',
      // The protocol header goes on every pairing attempt; the layer rejects a mismatch before
      // the body is even read.
      headers: PROTOCOL_HEADERS,
      body: JSON.stringify({ ...pairRequest, code }),
      timeoutMs: 10_000,
    });
  }

  /** Which of these assets already have a verified copy on the PC. */
  async assetStatus(assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    const response = await request<AssetStatusResponse>(
      this.host,
      this.port,
      '/assets/status',
      {
        method: 'POST',
        token: this.token,
        body: JSON.stringify({ assetIds }),
        // A large library is a long request; the UI shows a spinner for the whole batch.
        timeoutMs: 30_000,
      },
    );
    return new Set(response.backedUpAssetIds);
  }

  async beginTransfer(body: BeginTransferRequest): Promise<BeginTransferResponse> {
    return request<BeginTransferResponse>(this.host, this.port, '/transfers/begin', {
      method: 'POST',
      token: this.token,
      body: JSON.stringify(body),
    });
  }

  async completeTransfer(
    transferId: string,
    body: CompleteTransferRequest,
  ): Promise<CompleteTransferResponse> {
    return request<CompleteTransferResponse>(
      this.host,
      this.port,
      `/transfers/${encodeURIComponent(transferId)}/complete`,
      { method: 'POST', token: this.token, body: JSON.stringify(body) },
    );
  }

  async abortTransfer(transferId: string): Promise<AbortTransferResponse> {
    return request<AbortTransferResponse>(
      this.host,
      this.port,
      `/transfers/${encodeURIComponent(transferId)}/abort`,
      { method: 'POST', token: this.token, body: '{}' },
    );
  }

  async history(limit = 50, offset = 0): Promise<HistoryResponse> {
    return request<HistoryResponse>(this.host, this.port, `/history?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      token: this.token,
    });
  }

  /** Builds a client for an address that has not been paired yet. */
  static unpaired(endpoint: ServerEndpoint): AnonymousClient {
    return new AnonymousClient(endpoint);
  }
}

/** Talks to a server before a token exists: health and pairing only. */
export class AnonymousClient {
  constructor(readonly endpoint: ServerEndpoint) {}

  async health(): Promise<HealthResponse> {
    return request<HealthResponse>(this.endpoint.host, this.endpoint.port, '/health', {
      method: 'GET',
      timeoutMs: 6000,
    });
  }

  async pair(body: PairRequest, code: string): Promise<PairResponse> {
    return request<PairResponse>(this.endpoint.host, this.endpoint.port, '/pair', {
      method: 'POST',
      headers: PROTOCOL_HEADERS,
      body: JSON.stringify({ ...body, code }),
      timeoutMs: 10_000,
    });
  }
}

/** Endpoint for a manually entered address. */
export function manualEndpoint(host: string, port: number = DEFAULT_PORT): ServerEndpoint {
  return {
    serverId: `manual:${host}:${port}`,
    name: host,
    host,
    port,
    discovered: false,
    protocolVersion: 0,
  };
}
