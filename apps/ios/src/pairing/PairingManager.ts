/**
 * Pairing: exchanging a verification code for a bearer token, and keeping it.
 *
 * The token is written to the Keychain by `LocalDropSecureStore`, never to AsyncStorage, and it
 * is only cleared when the PC rejects it or the user unpairs.
 */

import { APP_VERSION, PROTOCOL_VERSION, type PairRequest } from '@localdrop/shared';
import { SecureStore, type DeviceIdentity, type StoredPairing } from '../native/NativeModules';
import {
  AnonymousClient,
  ServerClient,
  type ServerEndpoint,
} from '../server/ServerClient';

export type PairingState =
  | 'unpaired'
  | 'pairing'
  | 'paired'
  | 'error';

export interface PairingResult {
  ok: boolean;
  client?: ServerClient;
  pairing?: StoredPairing;
  error?: string;
}

/** Builds the request body the PC's `/api/pair` expects. */
export function buildPairRequest(identity: DeviceIdentity): PairRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceName: identity.deviceName,
    deviceId: identity.deviceId,
    osVersion: 'iOS',
    appVersion: APP_VERSION,
  };
}

/** Stored pairing turned into a usable client. */
export function clientFromPairing(pairing: StoredPairing): ServerClient {
  return new ServerClient({
    token: pairing.token,
    endpoint: {
      serverId: pairing.serverId,
      name: pairing.serverName,
      host: pairing.host,
      port: pairing.port,
      discovered: false,
      protocolVersion: 0,
    },
  });
}

/** True when a stored pairing still points at something usable. */
export function isUsablePairing(
  pairing: StoredPairing | null,
  endpoint?: ServerEndpoint,
): pairing is StoredPairing {
  if (!pairing || pairing.token.length === 0 || pairing.host.length === 0) {
    return false;
  }
  if (pairing.port <= 0 || pairing.port > 65535) {
    return false;
  }
  if (endpoint && endpoint.serverId !== pairing.serverId) {
    return false;
  }
  return true;
}

export class PairingManager {
  private cached: StoredPairing | null = null;
  private loaded = false;

  /** The saved pairing, or null. Read from the Keychain once and then kept in memory. */
  async load(): Promise<StoredPairing | null> {
    if (this.loaded) {
      return this.cached;
    }
    this.cached = await SecureStore.loadPairing();
    this.loaded = true;
    return this.cached;
  }

  /** Exchanges a code for a token and stores the pairing. */
  async pair(endpoint: ServerEndpoint, code: string): Promise<PairingResult> {
    const identity = await SecureStore.deviceIdentity();
    const client = new AnonymousClient(endpoint);

    try {
      const response = await client.pair(buildPairRequest(identity), code);

      const pairing: StoredPairing = {
        token: response.token,
        serverId: response.serverId,
        serverName: response.serverName,
        host: endpoint.host,
        port: endpoint.port,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
      };
      await SecureStore.savePairing(pairing);

      this.cached = pairing;
      this.loaded = true;
      return { ok: true, pairing, client: clientFromPairing(pairing) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Pairing failed. Please try again.',
      };
    }
  }

  /**
   * Confirms a stored token is still accepted by the PC.
   *
   * The PC can forget a phone (the user unpaired it, or the database was reset), so a token that
   * was valid yesterday can 401 today. Catching that here means the UI can offer "Pair again"
   * instead of failing on the first upload with a confusing error.
   */
  async verify(pairing: StoredPairing): Promise<{ valid: boolean; error?: string }> {
    try {
      await clientFromPairing(pairing).verifySession();
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'This PC is no longer paired with this iPhone.',
      };
    }
  }

  /** Builds a client for an already-paired PC. */
  clientFor(pairing: StoredPairing): ServerClient {
    return clientFromPairing(pairing);
  }

  /** Forgets the PC's credentials but keeps this install's identity. */
  async unpair(): Promise<void> {
    await SecureStore.clearPairing();
    this.cached = null;
    this.loaded = true;
  }
}
