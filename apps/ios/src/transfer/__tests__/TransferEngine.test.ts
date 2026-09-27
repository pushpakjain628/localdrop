/**
 * Transfer engine tests.
 *
 * These are the tests that matter most: a bug here means either a silently lost photo or a
 * file reported as backed up that is not on the PC. The native module is faked so the whole
 * state machine - prepare, begin, upload, verify, retry - can be driven deterministically
 * without a simulator.
 */

import { MAX_TRANSFER_ATTEMPTS } from '@localdrop/shared';
import {
  TransferEngine,
  describeError,
  isRetryable,
  transferIdFor,
  type TransferItem,
  type TransferRequest,
} from '../TransferEngine';
import { ServerError, type Connection, type ServerClient } from '../../server/ServerClient';
import { NativeModules } from 'react-native';

const nativeTransfer = (NativeModules as Record<string, any>).LocalDropTransfer;
const nativePhotos = (NativeModules as Record<string, any>).LocalDropPhotos;

/* ------------------------------------------------------------------ fixtures */

function endpoint() {
  return {
    serverId: 'srv-1',
    name: 'DESKTOP-TEST',
    host: '192.168.1.50',
    port: 47821,
    discovered: true,
    protocolVersion: 1,
  };
}

/** A ServerClient whose methods are jest mocks, so a test can assert on the calls. */
type MockClient = ServerClient & {
  beginTransfer: jest.Mock;
  completeTransfer: jest.Mock;
  abortTransfer: jest.Mock;
};

function client(overrides: Record<string, unknown> = {}): MockClient {
  const base = {
    host: '192.168.1.50',
    port: 47821,
    beginTransfer: jest.fn().mockResolvedValue({
      transferId: 't-1',
      action: 'upload',
      skipReason: null,
      relativePath: 'Photos/2026/09-September/IMG_1.heic',
      alreadyBackedUp: false,
    }),
    completeTransfer: jest.fn().mockResolvedValue({
      transferId: 't-1',
      status: 'completed',
      verifiedSha256: 'a'.repeat(64),
      verified: true,
      relativePath: 'Photos/2026/09-September/IMG_1.heic',
      absolutePath: 'D:/iPhone Backup/Photos/2026/09-September/IMG_1.heic',
      stored: true,
    }),
    abortTransfer: jest.fn().mockResolvedValue({ transferId: 't-1', aborted: true }),
  };
  return { ...base, ...overrides } as unknown as MockClient;
}

function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    assetId: 'asset-1',
    filename: 'IMG_1.HEIC',
    mediaType: 'photo',
    creationDate: '2026-09-26T12:00:00Z',
    isLivePhotoVideo: false,
    livePhotoId: null,
    ...overrides,
  };
}

function prepared(path = '/tmp/staging/IMG_1.HEIC', sha = 'a'.repeat(64)) {
  return {
    path,
    filename: 'IMG_1.HEIC',
    byteLength: 2048,
    sha256: sha,
    didTranscode: false,
  };
}

/** A sleep that records how long was requested without actually waiting. */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/* ------------------------------------------------------------------ setup */

beforeEach(() => {
  jest.clearAllMocks();
  nativeTransfer.prepareAsset.mockResolvedValue(prepared());
  nativeTransfer.uploadFile.mockResolvedValue({ statusCode: 200, body: '{}' });
  nativeTransfer.discardPreparedFile.mockResolvedValue(true);
  nativeTransfer.cancelAllUploads.mockResolvedValue(true);
});

/* ------------------------------------------------------------------ id derivation */

describe('transferIdFor', () => {
  it('uses the asset id for a plain asset', () => {
    expect(transferIdFor(request())).toBe('asset-1');
  });

  it('namespaces a Live Photo video half so it does not collide with its photo', () => {
    const id = transferIdFor(
      request({ isLivePhotoVideo: true, livePhotoId: 'asset-1', mediaType: 'video' }),
    );
    expect(id).toBe('livePhotoVideo:asset-1');
    expect(id).not.toBe(transferIdFor(request()));
  });
});

/* ------------------------------------------------------------------ happy path */

describe('a successful transfer', () => {
  it('prepares, uploads, verifies and records the destination', async () => {
    const onChange = jest.fn();
    const engine = new TransferEngine(client(), { sleep: async () => undefined, onChange });

    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(nativeTransfer.prepareAsset).toHaveBeenCalledWith({
      localIdentifier: 'asset-1',
      kind: 'photo',
    });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);

    const [item] = engine.list();
    expect(item?.state).toBe('completed');
    expect(item?.verified).toBe(true);
    expect(item?.destinationPath).toBe('Photos/2026/09-September/IMG_1.heic');
    expect(item?.fileSize).toBe(2048);
    expect(onChange).toHaveBeenCalled();
  });

  it('sends the file path to the native uploader, never the bytes', async () => {
    const server = client();
    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();

    const call = nativeTransfer.uploadFile.mock.calls[0]?.[0];
    expect(call.path).toBe('/tmp/staging/IMG_1.HEIC');
    expect(call.url).toBe('http://192.168.1.50:47821/api/transfers/t-1/content');
    expect(call.method).toBe('PUT');
    expect(call.headers['x-localdrop-sha256']).toBe('a'.repeat(64));
    // The critical property: no payload field anywhere near the upload call.
    expect(JSON.stringify(call)).not.toContain('byteLength');
  });

  it('declares the measured size and hash to the PC before uploading', async () => {
    const server = client();
    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();

    const body = server.beginTransfer.mock.calls[0]?.[0];
    expect(body.fileSize).toBe(2048);
    expect(body.sha256).toBe('a'.repeat(64));
    expect(body.assetId).toBe('asset-1');
    expect(body.createdAt).toBe('2026-09-26T12:00:00Z');
  });

  it('deletes the staging file once the transfer is done', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();
    expect(nativeTransfer.discardPreparedFile).toHaveBeenCalledWith('/tmp/staging/IMG_1.HEIC');
  });
});

/* ------------------------------------------------------------------ verification */

describe('verification failure', () => {
  it('marks the file failed and does not claim it is backed up', async () => {
    const server = client({
      completeTransfer: jest.fn().mockResolvedValue({
        transferId: 't-1',
        status: 'failed',
        verifiedSha256: 'b'.repeat(64),
        verified: false,
        relativePath: '',
        absolutePath: '',
        stored: false,
      }),
    } as Record<string, unknown>);

    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(1);

    const [item] = engine.list();
    expect(item?.state).toBe('failed');
    expect(item?.verified).toBe(false);
    expect(item?.destinationPath).toBeNull();
    expect(item?.error).toMatch(/could not verify/i);
    // The message must reassure about the phone, since that is what a user fears.
    expect(item?.error).toMatch(/nothing was changed on your iPhone/i);
  });

  it('treats stored-but-unverified as a failure, not a success', async () => {
    const server = client({
      completeTransfer: jest.fn().mockResolvedValue({
        transferId: 't-1',
        status: 'completed',
        verifiedSha256: 'b'.repeat(64),
        verified: false,
        relativePath: 'Photos/2026/09-September/IMG_1.heic',
        absolutePath: 'D:/x/IMG_1.heic',
        // The PC stored it but the hash did not match; that is not a safe backup.
        stored: true,
      }),
    } as Record<string, unknown>);

    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();
    expect(engine.list()[0]?.state).toBe('failed');
  });

  it('aborts the transfer and discards the file when the upload is rejected', async () => {
    nativeTransfer.uploadFile.mockResolvedValue({ statusCode: 507, body: 'no space' });
    const server = client();
    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();

    expect(server.abortTransfer).toHaveBeenCalledWith('t-1');
    expect(nativeTransfer.discardPreparedFile).toHaveBeenCalled();
    expect(engine.list()[0]?.state).toBe('failed');
  });
});

/* ------------------------------------------------------------------ skipping */

describe('the PC already has the file', () => {
  it('skips without uploading when begin says so', async () => {
    const server = client({
      beginTransfer: jest.fn().mockResolvedValue({
        transferId: 't-x',
        action: 'skip',
        skipReason: 'already_backed_up',
        relativePath: 'Photos/2026/09-September/IMG_1.heic',
        alreadyBackedUp: true,
      }),
    } as Record<string, unknown>);

    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(nativeTransfer.uploadFile).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    // The staging file was still exported, so it must be cleaned up.
    expect(nativeTransfer.discardPreparedFile).toHaveBeenCalled();
  });

  it('filters out assets the caller already knows are backed up', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    const queued = await engine.enqueue([request(), request({ assetId: 'asset-2' })], {
      knownBackedUp: new Set(['asset-2']),
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.assetId).toBe('asset-1');
  });

  it('skips an unsupported format without failing the run', async () => {
    const server = client({
      beginTransfer: jest.fn().mockResolvedValue({
        transferId: 't-y',
        action: 'unsupported',
        skipReason: 'unsupported_format',
        relativePath: null,
        alreadyBackedUp: false,
      }),
    } as Record<string, unknown>);

    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(nativeTransfer.uploadFile).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ retries */

describe('retrying', () => {
  it('retries a network error with exponential backoff', async () => {
    const { sleep, delays } = fakeSleep();
    nativeTransfer.uploadFile
      .mockRejectedValueOnce(new ServerError('offline', 'network_error', 0))
      .mockResolvedValueOnce({ statusCode: 200, body: '{}' });

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(summary.completed).toBe(1);
    expect(nativeTransfer.uploadFile).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
  });

  it('gives up after the attempt limit and says how many times it tried', async () => {
    const { sleep, delays } = fakeSleep();
    nativeTransfer.uploadFile.mockRejectedValue(
      new ServerError('offline', 'network_error', 0),
    );

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    expect(nativeTransfer.uploadFile).toHaveBeenCalledTimes(MAX_TRANSFER_ATTEMPTS);
    expect(summary.failed).toBe(1);
    expect(engine.list()[0]?.attempts).toBe(MAX_TRANSFER_ATTEMPTS);
    expect(engine.list()[0]?.error).toContain(`after ${MAX_TRANSFER_ATTEMPTS} attempts`);
    // 1s then 2s: the backoff grows.
    expect(delays).toEqual([1000, 2000]);
  });

  it('does not retry a rejected credential', async () => {
    const { sleep, delays } = fakeSleep();
    nativeTransfer.uploadFile.mockRejectedValue(
      new ServerError('token rejected', 'unauthorized', 401, true),
    );

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    await engine.run();

    expect(nativeTransfer.uploadFile).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(engine.list()[0]?.error).toMatch(/token rejected/);
  });

  it('re-queues failed items but refuses ones that are out of attempts', async () => {
    const { sleep } = fakeSleep();
    nativeTransfer.uploadFile.mockRejectedValue(
      new ServerError('offline', 'network_error', 0),
    );
    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    await engine.run();

    expect(engine.failedItems()).toHaveLength(1);
    // The item is already out of attempts, so there is nothing safe to retry.
    expect(engine.retryFailed()).toBe(0);
  });

  it('re-queues a failed item that still has attempts left', async () => {
    const { sleep } = fakeSleep();
    // A non-retryable failure (the PC is out of disk) fails on the first attempt but leaves
    // budget, which is exactly the case where the user should be able to press "Retry" after
    // making room on the PC.
    nativeTransfer.uploadFile.mockRejectedValue(
      new ServerError('not enough free space', 'insufficient_space', 507),
    );

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    await engine.run();

    const failed = engine.failedItems();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.attempts).toBe(1);
    expect(failed[0]?.attempts).toBeLessThan(MAX_TRANSFER_ATTEMPTS);

    const count = engine.retryFailed();
    expect(count).toBe(1);
    expect(engine.list()[0]?.state).toBe('queued');
    expect(engine.list()[0]?.error).toBeNull();
  });

  it('retries a transient failure inside the same run without user action', async () => {
    const { sleep, delays } = fakeSleep();
    nativeTransfer.uploadFile
      .mockRejectedValueOnce(new ServerError('offline', 'network_error', 0))
      .mockResolvedValue({ statusCode: 200, body: '{}' });

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request()]);
    const summary = await engine.run();

    // A user whose Wi-Fi blipped should not have to notice and press anything.
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(delays).toEqual([1000]);
  });
});

/* ------------------------------------------------------------------ cancellation */

describe('cancelling', () => {
  it('cancels native uploads and marks in-flight items cancelled', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request()]);
    // Start the run but do not await it: cancel while it is in flight.
    const running = engine.run();
    await engine.cancel();
    await running;

    expect(nativeTransfer.cancelAllUploads).toHaveBeenCalled();
    const states = engine.list().map((item) => item.state);
    expect(states.every((state) => state === 'cancelled' || state === 'completed')).toBe(true);
  });

  it('does not start the next file after cancelling', async () => {
    // Hold the first upload open so the cancel definitely lands mid-transfer rather than
    // racing the queue's first iteration.
    let releaseUpload: (() => void) | undefined;
    nativeTransfer.uploadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve({ statusCode: 200, body: '{}' });
        }),
    );

    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request(), request({ assetId: 'asset-2' })]);

    const running = engine.run();
    // Wait for the first upload to actually be in flight.
    while (nativeTransfer.uploadFile.mock.calls.length === 0) {
      await Promise.resolve();
    }
    await engine.cancel();
    releaseUpload?.();
    await running;

    expect(nativeTransfer.uploadFile).toHaveBeenCalledTimes(1);
    expect(engine.list().every((item) => item.state !== 'queued')).toBe(true);
  });
});

/* ------------------------------------------------------------------ queue behaviour */

describe('queue behaviour', () => {
  it('deduplicates within a batch', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    const queued = await engine.enqueue([request(), request(), request({ assetId: 'asset-2' })]);
    expect(queued).toHaveLength(2);
  });

  it('does not re-add an asset that is already queued', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request()]);
    const second = await engine.enqueue([request()]);
    expect(second).toHaveLength(0);
    expect(engine.size).toBe(1);
  });

  it('clears only terminal items', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request()]);
    await engine.run();
    expect(engine.size).toBe(1);
    engine.clearFinished();
    expect(engine.size).toBe(0);
  });

  it('reports a summary that matches the items', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request(), request({ assetId: 'asset-2' })]);
    const summary = await engine.run();

    expect(summary.total).toBe(2);
    expect(summary.completed + summary.skipped + summary.failed).toBe(2);
    expect(summary.bytesTotal).toBe(2 * 2048);
    expect(summary.bytesDone).toBe(2 * 2048);
    expect(summary.fraction).toBe(1);
  });

  it('keeps going after one file fails', async () => {
    const { sleep } = fakeSleep();
    nativeTransfer.prepareAsset
      .mockRejectedValueOnce(new Error('This item is no longer in your photo library.'))
      .mockResolvedValue(prepared());

    const engine = new TransferEngine(client(), { sleep });
    await engine.enqueue([request(), request({ assetId: 'asset-2' })]);
    const summary = await engine.run();

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('handles a Live Photo as two files', async () => {
    const server = client();
    const engine = new TransferEngine(server, { sleep: async () => undefined });
    await engine.enqueue([
      request({ isLivePhotoVideo: true, mediaType: 'video', livePhotoId: 'asset-1' }),
    ]);
    await engine.run();

    expect(nativeTransfer.prepareAsset).toHaveBeenCalledWith({
      localIdentifier: 'asset-1',
      kind: 'livePhotoVideo',
    });
    const body = server.beginTransfer.mock.calls[0]?.[0];
    expect(body.isLivePhotoVideo).toBe(true);
    expect(body.livePhotoId).toBe('asset-1');
    // The media type stays `video`; only the folder placement changes, on the PC.
    expect(body.mediaType).toBe('video');
  });

  it('is a no-op when asked to run twice concurrently', async () => {
    const engine = new TransferEngine(client(), { sleep: async () => undefined });
    await engine.enqueue([request()]);
    const [first, second] = await Promise.all([engine.run(), engine.run()]);

    // The second call sees the queue already running and returns the live summary rather than
    // starting a second pass; the invariant that matters is that the file is sent exactly once.
    expect(first.completed).toBe(1);
    expect(second.total).toBe(1);
    expect(nativeTransfer.uploadFile).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ helpers */

describe('isRetryable', () => {
  it('retries network errors and timeouts', () => {
    expect(isRetryable(new ServerError('x', 'network_error', 0))).toBe(true);
    expect(isRetryable(new ServerError('x', 'timeout', 0))).toBe(true);
  });

  it('retries server-side failures and rate limits', () => {
    expect(isRetryable(new ServerError('x', 'internal_error', 500))).toBe(true);
    expect(isRetryable(new ServerError('x', 'internal_error', 503))).toBe(true);
    expect(isRetryable(new ServerError('x', 'busy', 429))).toBe(true);
  });

  it('does not retry a bad request or a bad credential', () => {
    expect(isRetryable(new ServerError('x', 'unauthorized', 401))).toBe(false);
    expect(isRetryable(new ServerError('x', 'invalid_request', 400))).toBe(false);
    expect(isRetryable(new ServerError('x', 'checksum_mismatch', 422))).toBe(false);
  });

  it('does not retry a full disk, even though it is a 5xx', () => {
    // Freeing space takes longer than any backoff window, so retrying would only delay the
    // message telling the user what to do.
    expect(isRetryable(new ServerError('x', 'insufficient_space', 507))).toBe(false);
  });

  it('does not retry a native failure, which will not fix itself', () => {
    expect(isRetryable(new Error('disk full'))).toBe(false);
  });
});

describe('describeError', () => {
  it('uses the server message when there is one', () => {
    expect(describeError(new ServerError('PC is asleep', 'network_error', 0))).toBe('PC is asleep');
  });

  it('falls back to the Error message, then to something generic', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('a string')).toBe('Something went wrong.');
    expect(describeError(undefined)).toBe('Something went wrong.');
  });
});
