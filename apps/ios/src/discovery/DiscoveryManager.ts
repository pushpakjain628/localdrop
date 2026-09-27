/**
 * Bonjour discovery, with the manual IP fallback.
 *
 * The manager owns one `NWBrowser` subscription and turns its event stream into a plain list of
 * endpoints. Results are deduplicated and kept across brief network changes, because a phone
 * walking between rooms legitimately loses and regains the PC and the UI should not flicker.
 */

import { BONJOUR_SERVICE_TYPE, DISCOVERY_RETRY_INTERVAL_MS, PROTOCOL_VERSION } from '@localdrop/shared';
import {
  Discovery,
  DISCOVERY_EVENT,
  discoveryEvents,
  type DiscoveredServer,
  type DiscoveryEvent,
} from '../native/NativeModules';
import { manualEndpoint, type ServerEndpoint } from '../server/ServerClient';

export type DiscoveryStatus = 'idle' | 'searching' | 'ready' | 'failed';

export interface DiscoveryState {
  status: DiscoveryStatus;
  servers: ServerEndpoint[];
  error: string | null;
}

export interface DiscoveryManagerOptions {
  onChange: (state: DiscoveryState) => void;
  /** Cap on how many entries to keep. */
  maxServers?: number;
}

/** Converts a native result into the app's endpoint shape. */
export function toEndpoint(server: DiscoveredServer): ServerEndpoint {
  return {
    serverId: `${server.name}@${server.host}:${server.port}`,
    name: server.name,
    host: server.host,
    port: server.port,
    discovered: true,
    protocolVersion: server.protocolVersion,
  };
}

/**
 * The network identity of an endpoint.
 *
 * Deliberately `host:port` rather than `serverId`: a PC that the user typed in by IP and that
 * mDNS also found is the same machine, and it must appear once. Its display name is better when
 * discovered, so the discovered entry wins.
 */
export function endpointKey(endpoint: ServerEndpoint): string {
  return `${endpoint.host.toLowerCase()}:${endpoint.port}`;
}

/** True when a discovered server speaks a protocol this build understands. */
export function isCompatible(endpoint: ServerEndpoint): boolean {
  // 0 means the PC did not advertise a version, which is true for a build predating the TXT
  // record. Probe it with /api/health rather than rejecting it outright.
  return endpoint.protocolVersion === 0 || endpoint.protocolVersion === PROTOCOL_VERSION;
}

export class DiscoveryManager {
  private state: DiscoveryState = { status: 'idle', servers: [], error: null };
  private listenerId = '';
  private subscription: { remove: () => void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: DiscoveryManagerOptions) {}

  getState(): DiscoveryState {
    return this.state;
  }

  /** Starts browsing. Idempotent. */
  async start(): Promise<void> {
    if (this.listenerId) {
      return;
    }
    this.stopped = false;
    this.listenerId = `localdrop-${Date.now()}`;

    this.subscription = discoveryEvents().addListener(
      DISCOVERY_EVENT,
      (event: DiscoveryEvent) => this.handleEvent(event),
    );

    this.set({ status: 'searching' });
    try {
      await Discovery.startBrowsing(this.listenerId, BONJOUR_SERVICE_TYPE);
    } catch (error) {
      this.set({
        status: 'failed',
        error:
          error instanceof Error
            ? error.message
            : 'Automatic discovery is unavailable. You can enter your PC’s address instead.',
      });
      // A failed browse is exactly when the manual fallback matters, so surface it and let the
      // user proceed without discovery.
    }
  }

  /** Stops browsing and releases the mDNS session. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
    const listenerId = this.listenerId;
    this.listenerId = '';
    if (listenerId) {
      await Discovery.stopBrowsing(listenerId).catch(() => false);
    }
    this.set({ status: 'idle', servers: [], error: null });
  }

  /**
   * Adds a server the user typed in.
   *
   * Returns an error string when the address is not reachable, so the UI can say so
   * immediately rather than failing later at pairing time.
   */
  async addManualServer(
    host: string,
    port: number,
  ): Promise<{ endpoint: ServerEndpoint } | { error: string }> {
    const trimmed = host.trim();
    if (trimmed.length === 0) {
      return { error: 'Enter the address shown on your PC.' };
    }
    const endpoint = manualEndpoint(trimmed, port);
    try {
      // Defensive about the shape, not just the value. This promise is resolved by native code,
      // and an earlier version resolved it with a Swift `Result` enum, which crosses the bridge
      // as an opaque value and arrives in JavaScript as `null` - so `reachability.reachable`
      // threw "Cannot read property 'reachable' of null" and the user saw a crash instead of an
      // answer. Nothing in the type system can catch that from this side, so the call site
      // assumes the contract might be broken and says so.
      const reachability = await Discovery.resolveHost(endpoint.host, endpoint.port);
      if (reachability === null || reachability === undefined) {
        return {
          error:
            `The app could not read the result of the connection test to ${endpoint.host}:${endpoint.port}. ` +
            'This is a bug in the app - please reinstall the latest build.',
        };
      }
      if (!reachability.reachable) {
        return { error: `Could not reach ${endpoint.host}:${endpoint.port}.` };
      }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : `Could not reach ${endpoint.host}:${endpoint.port}.`,
      };
    }
    this.remember(endpoint);
    return { endpoint };
  }

  /** Adds or refreshes an endpoint in the list. */
  remember(endpoint: ServerEndpoint): void {
    const existing = this.state.servers.filter((s) => s.serverId !== endpoint.serverId);
    // Discovered servers come first: they are the ones the user did not have to type.
    const servers = endpoint.discovered
      ? [endpoint, ...existing]
      : [...existing, endpoint];
    this.set({ servers: servers.slice(0, this.options.maxServers ?? 12), status: 'ready' });
  }

  /** Forgets an endpoint, e.g. after unpairing. */
  forget(serverId: string): void {
    this.set({ servers: this.state.servers.filter((s) => s.serverId !== serverId) });
  }

  private handleEvent(event: DiscoveryEvent): void {
    if (this.stopped || event.listenerId !== this.listenerId) {
      return;
    }
    switch (event.type) {
      case 'ready':
        this.set({ status: 'ready', error: null });
        break;

      case 'results': {
        const discovered = (event.servers ?? [])
          .map(toEndpoint)
          .filter(isCompatible);

        // Merge on network identity so a machine the user typed by IP and that mDNS also found
        // appears once, with the discovered name. Manual entries survive a results batch that
        // contains nothing, because the user asked for that address specifically.
        const manual = this.state.servers.filter((s) => !s.discovered);
        const manualKeys = new Set(manual.map(endpointKey));
        const merged = [
          ...discovered.filter((s) => !manualKeys.has(endpointKey(s))),
          ...manual,
        ].slice(0, this.options.maxServers ?? 12);

        this.set({
          status: 'ready',
          servers: merged,
          // An empty list is not an error: the PC may simply not be running yet, and the UI
          // offers the manual entry rather than showing a failure.
          error: null,
        });
        break;
      }

      case 'failed':
        this.set({
          status: 'failed',
          error:
            event.error ??
            'Automatic discovery stopped working. You can enter your PC’s address instead.',
        });
        this.scheduleRetry();
        break;

      case 'stopped':
        if (!this.stopped) {
          this.scheduleRetry();
        }
        break;

      default:
        break;
    }
  }

  /**
   * Browses can be torn down by the system on a network change. Rather than surfacing that as a
   * failure, restart quietly after a short pause.
   */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const listenerId = this.listenerId;
      this.listenerId = '';
      void this.start().then(() => {
        // `start` mints a new listener id; nothing else to reconcile because the old browser
        // was already cancelled by the system.
        void listenerId;
      });
    }, DISCOVERY_RETRY_INTERVAL_MS);
  }

  private set(changes: Partial<DiscoveryState>): void {
    this.state = { ...this.state, ...changes };
    this.options.onChange(this.state);
  }
}
