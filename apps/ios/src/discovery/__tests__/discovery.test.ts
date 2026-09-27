/**
 * Discovery and pairing tests.
 *
 * Discovery matters because it is the difference between "tap your PC's name" and "type an IP
 * address", and because a flaky list is worse than a slow one. Pairing matters because it is the
 * only thing standing between an unpaired device and someone's photo library.
 */

import { PROTOCOL_VERSION } from '@localdrop/shared';
import {
  DiscoveryManager,
  isCompatible,
  toEndpoint,
  type DiscoveryState,
} from '../DiscoveryManager';
import {
  PairingManager,
  buildPairRequest,
  clientFromPairing,
  isUsablePairing,
} from '../../pairing/PairingManager';
import { NativeModules } from 'react-native';
import { discoveryEvents } from '../../native/NativeModules';

// NativeModules.ts wraps the native module in plain functions, so the spies live on the
// module itself rather than on the wrapper.
const nativeDiscovery = (NativeModules as Record<string, any>).LocalDropDiscovery;
const nativeStore = (NativeModules as Record<string, any>).LocalDropSecureStore;

/* ------------------------------------------------------------------ discovery */

const server = (overrides: Partial<Parameters<typeof toEndpoint>[0]> = {}) => ({
  name: 'DESKTOP-ABC',
  host: 'anna.local',
  port: 47821,
  serviceType: '_localdrop._tcp',
  domain: 'local.',
  protocolVersion: PROTOCOL_VERSION,
  appVersion: '1.0.0',
  fullName: 'LocalDrop',
  ...overrides,
});

describe('toEndpoint', () => {
  it('keeps the advertised port rather than assuming the default', () => {
    const endpoint = toEndpoint(server({ port: 5000 }));
    expect(endpoint.port).toBe(5000);
    expect(endpoint.discovered).toBe(true);
  });

  it('builds a stable id from name, host and port', () => {
    const a = toEndpoint(server());
    const b = toEndpoint(server());
    expect(a.serverId).toBe(b.serverId);
    expect(a.serverId).toContain('47821');
  });
});

describe('isCompatible', () => {
  it('accepts a server on the same protocol version', () => {
    expect(isCompatible(toEndpoint(server({ protocolVersion: PROTOCOL_VERSION })))).toBe(true);
  });

  it('rejects a server on a different version', () => {
    expect(isCompatible(toEndpoint(server({ protocolVersion: PROTOCOL_VERSION + 1 })))).toBe(false);
  });

  it('accepts a server that does not advertise a version, and probes it instead', () => {
    // A PC running an older build has no version key; rejecting it outright would make
    // discovery look broken rather than prompting a health check.
    expect(isCompatible(toEndpoint(server({ protocolVersion: 0 })))).toBe(true);
  });
});

describe('DiscoveryManager', () => {
  let states: DiscoveryState[];
  let manager: DiscoveryManager;

  beforeEach(() => {
    states = [];
    jest.clearAllMocks();
    manager = new DiscoveryManager({ onChange: (state) => states.push(state) });
  });

  afterEach(() => {
    void manager.stop();
  });

  function emit(payload: unknown) {
    const emitter = discoveryEvents() as unknown as {
      emit: (event: string, payload: unknown) => void;
    };
    emitter.emit('LocalDropDiscoveryEvent', payload);
  }

  /**
   * The listener id is generated inside `start`, so a test has to read it back off the native
   * call rather than invent one - otherwise every emitted event is correctly ignored as stale.
   */
  function currentListenerId(): string {
    const calls = nativeDiscovery.startBrowsing.mock.calls;
    return (calls[calls.length - 1]?.[0] as { listenerId: string }).listenerId;
  }

  it('reports searching, then ready once the browser is up', async () => {
    await manager.start();
    expect(states[0]?.status).toBe('searching');
    expect(nativeDiscovery.startBrowsing).toHaveBeenCalledTimes(1);

    emit({ listenerId: currentListenerId(), type: 'ready', servers: [] });
    expect(states[states.length - 1]?.status).toBe('ready');
  });

  it('keeps every discovered server', async () => {
    await manager.start();
    emit({
      listenerId: currentListenerId(),
      type: 'results',
      servers: [
        server({ name: 'DESKTOP-A', host: 'a.local' }),
        server({ name: 'DESKTOP-B', host: 'b.local' }),
      ],
    });

    // `NWBrowser` hands results over as a `Set`, so the order within one batch carries no
    // meaning; what matters is that both are present and de-duplicated by id.
    const names = states[states.length - 1]?.servers.map((s) => s.name).sort();
    expect(names).toEqual(['DESKTOP-A', 'DESKTOP-B']);
  });

  it('puts a newly discovered PC ahead of one the user typed in', async () => {
    await manager.start();
    await manager.addManualServer('192.168.1.42', 47821);
    emit({
      listenerId: currentListenerId(),
      type: 'results',
      servers: [server({ name: 'DESKTOP-NEW', host: 'new.local' })],
    });

    const servers = states[states.length - 1]?.servers ?? [];
    // The discovered machine is the one the user most likely wants to tap, so it leads.
    expect(servers[0]?.name).toBe('DESKTOP-NEW');
    expect(servers).toHaveLength(2);
  });

  it('does not list the same machine twice when it is both typed and discovered', async () => {
    await manager.start();
    const added = await manager.addManualServer('192.168.1.42', 47821);
    if (!('endpoint' in added)) {
      throw new Error('expected the manual address to be accepted');
    }

    // Discovery finds the same host and port the user typed in.
    emit({
      listenerId: currentListenerId(),
      type: 'results',
      servers: [server({ name: 'DESKTOP-A', host: '192.168.1.42' })],
    });

    const servers = states[states.length - 1]?.servers ?? [];
    expect(servers.filter((s) => s.host === '192.168.1.42')).toHaveLength(1);
  });

  it('preserves a manually added server when discovery finds nothing', async () => {
    await manager.start();
    const added = await manager.addManualServer('192.168.1.42', 47821);
    expect('endpoint' in added).toBe(true);
    expect(states[states.length - 1]?.servers).toHaveLength(1);

    // A user who typed an address must still see it when mDNS returns nothing.
    emit({ listenerId: currentListenerId(), type: 'results', servers: [] });
    const last = states[states.length - 1];
    expect(last?.servers).toHaveLength(1);
    expect(last?.servers[0]?.host).toBe('192.168.1.42');
  });

  it('ignores results from a stale listener', async () => {
    await manager.start();
    const before = states.length;
    emit({
      listenerId: 'some-other-listener',
      type: 'results',
      servers: [server()],
    });
    expect(states).toHaveLength(before);
  });

  it('drops servers speaking a different protocol version', async () => {
    await manager.start();
    emit({
      listenerId: currentListenerId(),
      type: 'results',
      servers: [server({ name: 'FUTURE-PC', protocolVersion: PROTOCOL_VERSION + 5 })],
    });
    const last = states[states.length - 1];
    expect(last?.servers).toHaveLength(0);
    // No results is not an error; the user simply has nothing to tap yet.
    expect(last?.error).toBeNull();
  });

  it('surfaces a browse failure and offers the manual fallback', async () => {
    await manager.start();
    emit({
      listenerId: currentListenerId(),
      type: 'failed',
      error: 'mDNS is blocked on this network',
    });
    const last = states[states.length - 1];
    expect(last?.status).toBe('failed');
    expect(last?.error).toContain('mDNS is blocked');
  });

  it('rejects an empty manual address', async () => {
    const result = await manager.addManualServer('   ', 47821);
    expect('error' in result).toBe(true);
  });

  it('rejects a manual address that is not reachable', async () => {
    nativeDiscovery.resolveHost.mockResolvedValueOnce({
      reachable: false,
      host: '10.0.0.1',
      port: 47821,
    });
    const result = await manager.addManualServer('10.0.0.1', 47821);
    expect('error' in result).toBe(true);
  });

  it('forgets a server on request', async () => {
    await manager.start();
    const added = await manager.addManualServer('192.168.1.42', 47821);
    if ('endpoint' in added) {
      manager.forget(added.endpoint.serverId);
    }
    expect(states[states.length - 1]?.servers).toHaveLength(0);
  });

  it('clears the list when discovery stops', async () => {
    await manager.start();
    emit({
      listenerId: currentListenerId(),
      type: 'results',
      servers: [server()],
    });
    expect(states[states.length - 1]?.servers).toHaveLength(1);

    await manager.stop();
    expect(states[states.length - 1]?.servers).toHaveLength(0);
    expect(states[states.length - 1]?.status).toBe('idle');
  });
});

/* ------------------------------------------------------------------ pairing */

describe('buildPairRequest', () => {
  it('identifies this device and the protocol it speaks', () => {
    const request = buildPairRequest({ deviceId: 'abc-123', deviceName: "Anna's iPhone" });
    expect(request.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(request.deviceId).toBe('abc-123');
    expect(request.deviceName).toBe("Anna's iPhone");
    expect(request.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('isUsablePairing', () => {
  const valid = {
    token: 't'.repeat(64),
    serverId: 'srv-1',
    serverName: 'DESKTOP',
    host: '192.168.1.50',
    port: 47821,
    deviceId: 'abc',
    deviceName: "Anna's iPhone",
  };

  it('accepts a complete pairing', () => {
    expect(isUsablePairing(valid)).toBe(true);
  });

  it('rejects a missing pairing', () => {
    expect(isUsablePairing(null)).toBe(false);
  });

  it('rejects a pairing with no token', () => {
    expect(isUsablePairing({ ...valid, token: '' })).toBe(false);
  });

  it('rejects a pairing with no host, which would make the app unusable', () => {
    expect(isUsablePairing({ ...valid, host: '' })).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(isUsablePairing({ ...valid, port: 0 })).toBe(false);
    expect(isUsablePairing({ ...valid, port: 70000 })).toBe(false);
  });

  it('rejects a pairing that points at a different PC than the one selected', () => {
    const endpoint = {
      serverId: 'other-srv',
      name: 'OTHER',
      host: '192.168.1.51',
      port: 47821,
      discovered: true,
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(isUsablePairing(valid, endpoint)).toBe(false);
  });
});

describe('clientFromPairing', () => {
  it('carries the token and address through', () => {
    const client = clientFromPairing({
      token: 'tok',
      serverId: 'srv-1',
      serverName: 'DESKTOP',
      host: '192.168.1.50',
      port: 47821,
      deviceId: 'abc',
      deviceName: 'iPhone',
    });
    expect(client.token).toBe('tok');
    expect(client.host).toBe('192.168.1.50');
    expect(client.port).toBe(47821);
  });
});

describe('PairingManager', () => {
  const endpoint = {
    serverId: 'srv-1',
    name: 'DESKTOP',
    host: '192.168.1.50',
    port: 47821,
    discovered: true,
    protocolVersion: PROTOCOL_VERSION,
  };

  const originalFetch = (globalThis as { fetch: typeof fetch }).fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  });

  function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
    (globalThis as { fetch: typeof fetch }).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { status, body } = handler(String(input), init ?? {});
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it('returns null when nothing is stored', async () => {
    nativeStore.loadPairing.mockResolvedValue(null);
    const manager = new PairingManager();
    expect(await manager.load()).toBeNull();
  });

  it('stores a successful pairing so the next launch is silent', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        token: 'issued-token',
        serverId: 'srv-1',
        serverName: 'DESKTOP-ABC',
        backupDirectory: 'D:/iPhone Backup',
        expiresInSeconds: 31_536_000,
      },
    }));

    const manager = new PairingManager();
    const result = await manager.pair(endpoint, '123456');

    expect(result.ok).toBe(true);
    expect(nativeStore.savePairing).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'issued-token',
        serverId: 'srv-1',
        serverName: 'DESKTOP-ABC',
        host: '192.168.1.50',
        port: 47821,
      }),
    );
    expect(result.client?.token).toBe('issued-token');
  });

  it('sends the protocol version header and the code in the body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return { status: 200, body: { token: 't', serverId: 's', serverName: 'n', backupDirectory: 'd', expiresInSeconds: 1 } };
    });

    await new PairingManager().pair(endpoint, '123456');
    const call = seen[0];
    expect(call?.url).toBe('http://192.168.1.50:47821/api/pair');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-localdrop-protocol']).toBe(String(PROTOCOL_VERSION));
    expect(JSON.parse(String(call?.init.body)).code).toBe('123456');
  });

  it('does not store anything when the code is rejected', async () => {
    stubFetch(() => ({
      status: 403,
      body: { error: { code: 'pairing_failed', message: 'that code is not correct' } },
    }));

    const manager = new PairingManager();
    const result = await manager.pair(endpoint, '000000');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('that code is not correct');
    expect(nativeStore.savePairing).not.toHaveBeenCalled();
  });

  it('reports an unreachable PC rather than hanging', async () => {
    (globalThis as { fetch: typeof fetch }).fetch = jest.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;

    const manager = new PairingManager();
    const result = await manager.pair(endpoint, '123456');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach the pc/i);
  });

  it('forgets the PC but keeps this device identity on unpair', async () => {
    nativeStore.loadPairing.mockResolvedValue(null);
    const manager = new PairingManager();
    await manager.unpair();
    expect(nativeStore.clearPairing).toHaveBeenCalled();
    // `clearAll` would also drop the install id, causing the PC to register a duplicate device.
    expect(nativeStore.clearAll).not.toHaveBeenCalled();
  });

  it('reports an invalid token rather than throwing', async () => {
    stubFetch(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'invalid or expired bearer token' } },
    }));

    const manager = new PairingManager();
    const result = await manager.verify({
      token: 'stale',
      serverId: 'srv-1',
      serverName: 'DESKTOP',
      host: '127.0.0.1',
      port: 47821,
      deviceId: 'abc',
      deviceName: 'iPhone',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid or expired bearer token');
  });

  it('confirms a valid token', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true } }));
    const manager = new PairingManager();
    const result = await manager.verify({
      token: 'good',
      serverId: 'srv-1',
      serverName: 'DESKTOP',
      host: '127.0.0.1',
      port: 47821,
      deviceId: 'abc',
      deviceName: 'iPhone',
    });
    expect(result.valid).toBe(true);
  });
});
