/**
 * The transfer queue.
 *
 * Responsibilities, in order of importance:
 *
 * 1. Never load a whole file into JS memory. Preparation, hashing and upload all happen in
 *    native code against a file on disk; this module only ever handles metadata.
 * 2. Never leave a half-finished file looking successful. A transfer is `completed` only when
 *    the PC has confirmed it recomputed the same SHA-256 over the bytes it received.
 * 3. Survive a flaky network. Retries are per-file, exponential, and bounded, and a failure
 *    never stops the rest of the queue.
 *
 * This version never deletes anything from the iPhone. `markBackedUp` records state on the
 * phone; the library on the PC is the record of truth.
 */

import {
  MAX_TRANSFER_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  type BeginTransferResponse,
  type MediaKind,
} from '@localdrop/shared';
import { ServerError, uploadUrl, type ServerClient } from '../server/ServerClient';
import {
  Transfer,
  TRANSFER_PROGRESS_EVENT,
  transferEvents,
  type PreparedAsset,
  type UploadProgressEvent,
} from '../native/NativeModules';

/** Where a single asset is in its lifecycle. */
export type TransferState =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled';

/** One row in the queue, and the input the Transfer screen renders. */
export interface TransferItem {
  /** `PHAsset.localIdentifier` for the photo, `livePhotoVideo:<id>` for the video half. */
  id: string;
  assetId: string;
  filename: string;
  mediaType: MediaKind;
  isLivePhotoVideo: boolean;
  livePhotoId: string | null;
  creationDate: string;
  /** Expected byte length; 0 until preparation has measured the real file. */
  fileSize: number;
  state: TransferState;
  bytesSent: number;
  bytesPerSecond: number;
  estimatedSecondsRemaining: number | null;
  attempts: number;
  /** Set when `state === 'failed'`; safe to show to the user verbatim. */
  error: string | null;
  /** Path on the PC, once verified. */
  destinationPath: string | null;
  /** True once the PC has confirmed a matching SHA-256. */
  verified: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

/** What the app asks the engine to back up. */
export interface TransferRequest {
  assetId: string;
  filename: string;
  mediaType: MediaKind;
  creationDate: string;
  isLivePhotoVideo: boolean;
  livePhotoId: string | null;
  /** Present when this is the video half of a Live Photo. */
  livePhotoVideoFilename?: string;
}

/** Aggregate progress, for the header on the Transfer screen. */
export interface QueueSummary {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  /** idle when nothing is running. */
  inFlight: 'idle' | 'uploading';
  bytesTotal: number;
  bytesDone: number;
  /** 0..1, or null when nothing has been measured yet. */
  fraction: number | null;
  bytesPerSecond: number;
  estimatedSecondsRemaining: number | null;
}

export interface TransferEngineOptions {
  /** Uploads one at a time by default; a phone on Wi-Fi is faster and steadier serialised. */
  concurrency?: number;
  /** Called on every state change so the UI can re-render. */
  onChange?: (items: TransferItem[]) => void;
  /** Called once per file when it reaches a terminal state. */
  onItemSettled?: (item: TransferItem) => void;
  /** Injected in tests; defaults to the real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress events are throttled to this interval. */
  progressIntervalMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A Live Photo's video half is tracked under its own id but shares the photo's asset id. */
export function transferIdFor(request: TransferRequest): string {
  return request.isLivePhotoVideo ? `livePhotoVideo:${request.assetId}` : request.assetId;
}

export class TransferEngine {
  private items = new Map<string, TransferItem>();
  private order: string[] = [];
  private running = false;
  private cancelled = false;
  private activeProgressUnsubscribe: (() => void) | null = null;

  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly progressIntervalMs: number;
  private readonly onChange?: (items: TransferItem[]) => void;
  private readonly onItemSettled?: (item: TransferItem) => void;

  constructor(
    private readonly client: ServerClient,
    options: TransferEngineOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.sleep = options.sleep ?? realSleep;
    this.progressIntervalMs = options.progressIntervalMs ?? 150;
    this.onChange = options.onChange;
    this.onItemSettled = options.onItemSettled;
  }

  /* ---------------------------------------------------------------- inspection */

  /** Queue contents, newest first. */
  list(): TransferItem[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((item): item is TransferItem => item !== undefined);
  }

  get size(): number {
    return this.items.size;
  }

  summary(): QueueSummary {
    const items = this.list();
    const completed = items.filter((i) => i.state === 'completed').length;
    const skipped = items.filter((i) => i.state === 'skipped').length;
    const failed = items.filter((i) => i.state === 'failed').length;
    const inFlight = items.some((i) =>
      ['preparing', 'uploading', 'verifying'].includes(i.state),
    )
      ? 'uploading'
      : this.running
        ? 'uploading'
        : 'idle';

    // Only count files whose size is actually known: a `preparing` item has 0 bytes and would
    // otherwise drag the average down and make the bar jump backwards.
    const measured = items.filter((i) => i.fileSize > 0);
    const bytesTotal = measured.reduce((sum, i) => sum + i.fileSize, 0);
    const bytesDone = measured.reduce(
      (sum, i) => sum + (i.state === 'completed' || i.state === 'skipped' ? i.fileSize : i.bytesSent),
      0,
    );

    // Weight the rate by the files actually in flight; a finished file contributes nothing.
    const activeRates = items
      .filter((i) => i.state === 'uploading' && i.bytesPerSecond > 0)
      .map((i) => i.bytesPerSecond);
    const bytesPerSecond = activeRates.reduce((sum, r) => sum + r, 0);
    const remainingBytes = Math.max(bytesTotal - bytesDone, 0);
    const estimatedSecondsRemaining =
      bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;

    return {
      total: items.length,
      completed,
      skipped,
      failed,
      inFlight,
      bytesTotal,
      bytesDone,
      fraction: bytesTotal > 0 ? Math.min(bytesDone / bytesTotal, 1) : null,
      bytesPerSecond,
      estimatedSecondsRemaining,
    };
  }

  /* ---------------------------------------------------------------- queueing */

  /**
   * Adds assets to the queue.
   *
   * Assets the PC already has are filtered out first: asking the server about hundreds of
   * identifiers in one call is much cheaper than beginning a transfer for each and being told
   * "skip", and it lets the UI mark them before the user even taps Backup.
   */
  async enqueue(
    requests: TransferRequest[],
    options: { knownBackedUp?: Set<string> } = {},
  ): Promise<TransferItem[]> {
    const known = options.knownBackedUp ?? new Set<string>();
    const fresh = requests.filter((r) => !known.has(r.assetId));

    // Dedupe within this batch: two taps on "Backup" must not queue the same file twice.
    const seen = new Set<string>();
    const unique = fresh.filter((r) => {
      const id = transferIdFor(r);
      if (seen.has(id) || this.items.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });

    for (const request of unique) {
      const id = transferIdFor(request);
      const item: TransferItem = {
        id,
        assetId: request.assetId,
        filename: request.isLivePhotoVideo
          ? (request.livePhotoVideoFilename ?? request.filename)
          : request.filename,
        mediaType: request.mediaType,
        isLivePhotoVideo: request.isLivePhotoVideo,
        livePhotoId: request.livePhotoId,
        creationDate: request.creationDate,
        fileSize: 0,
        state: 'queued',
        bytesSent: 0,
        bytesPerSecond: 0,
        estimatedSecondsRemaining: null,
        attempts: 0,
        error: null,
        destinationPath: null,
        verified: false,
        startedAt: null,
        finishedAt: null,
      };
      this.items.set(id, item);
      this.order.unshift(id);
    }

    this.emit();
    return unique.map((r) => this.items.get(transferIdFor(r))).filter(
      (item): item is TransferItem => item !== undefined,
    );
  }

  /** Items the user asked to retry: everything currently failed. */
  failedItems(): TransferItem[] {
    return this.list().filter((item) => item.state === 'failed');
  }

  /** Re-queues failed items, preserving their attempt count so a persistent failure still stops. */
  retryFailed(): number {
    let count = 0;
    for (const item of this.failedItems()) {
      if (item.attempts >= MAX_TRANSFER_ATTEMPTS) {
        continue;
      }
      this.patch(item.id, {
        state: 'queued',
        error: null,
        bytesSent: 0,
        bytesPerSecond: 0,
        estimatedSecondsRemaining: null,
        destinationPath: null,
        verified: false,
        finishedAt: null,
      });
      count += 1;
    }
    if (count > 0) {
      this.emit();
    }
    return count;
  }

  /** Clears terminal items so the screen is not cluttered by a finished run. */
  clearFinished(): void {
    for (const item of this.list()) {
      if (['completed', 'skipped', 'cancelled'].includes(item.state)) {
        this.items.delete(item.id);
      }
    }
    this.order = this.order.filter((id) => this.items.has(id));
    this.emit();
  }

  /* ---------------------------------------------------------------- running */

  /** Processes the queue. Safe to call again after a failure; already-done items are skipped. */
  async run(): Promise<QueueSummary> {
    if (this.running) {
      return this.summary();
    }
    this.running = true;
    this.cancelled = false;
    this.subscribeToProgress();
    this.emit();

    try {
      const lanes = Array.from({ length: this.concurrency }, () => this.runLane());
      await Promise.all(lanes);
    } finally {
      this.running = false;
      this.unsubscribeFromProgress();
      this.emit();
    }
    return this.summary();
  }

  /** Stops after the current file. In-flight native uploads are cancelled too. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await Transfer.cancelAllUploads().catch(() => false);
    for (const item of this.list()) {
      if (['queued', 'preparing', 'uploading', 'verifying'].includes(item.state)) {
        this.patch(item.id, {
          state: 'cancelled',
          error: 'Cancelled.',
          finishedAt: Date.now(),
        });
      }
    }
    this.emit();
  }

  /* ---------------------------------------------------------------- internals */

  private async runLane(): Promise<void> {
    for (;;) {
      if (this.cancelled) {
        return;
      }
      const next = this.list().find((item) => item.state === 'queued');
      if (!next) {
        return;
      }
      await this.processItem(next.id);
    }
  }

  private async processItem(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item || item.state !== 'queued') {
      return;
    }

    const attempt = item.attempts + 1;
    this.patch(id, {
      state: 'preparing',
      attempts: attempt,
      error: null,
      startedAt: item.startedAt ?? Date.now(),
      finishedAt: null,
    });

    let prepared: PreparedAsset | null = null;
    try {
      // 1. Export and hash natively. This is the only step that touches the real bytes, and it
      //    does so in 1 MiB blocks on a background queue.
      prepared = await Transfer.prepareAsset(
        item.assetId,
        item.isLivePhotoVideo ? 'livePhotoVideo' : item.mediaType,
      );
      this.patch(id, { fileSize: prepared.byteLength });

      if (this.cancelled) {
        await this.discard(prepared);
        return;
      }

      // 2. Ask the PC what it wants. A skip here means it already has a verified copy.
      const begin = await this.client.beginTransfer({
        assetId: item.assetId,
        filename: prepared.filename,
        mediaType: item.mediaType,
        fileSize: prepared.byteLength,
        createdAt: item.creationDate,
        sha256: prepared.sha256,
        livePhotoId: item.livePhotoId,
        isLivePhotoVideo: item.isLivePhotoVideo,
      });

      if (begin.action === 'skip') {
        await this.discard(prepared);
        this.settle(id, {
          state: 'skipped',
          destinationPath: begin.relativePath ?? null,
          verified: true,
          error: null,
        });
        return;
      }
      if (begin.action === 'unsupported') {
        await this.discard(prepared);
        this.settle(id, {
          state: 'skipped',
          error: 'This file format is not supported yet.',
          finishedAt: Date.now(),
        });
        return;
      }

      // 3. Stream the file to the PC. Progress arrives as native events.
      this.patch(id, { state: 'uploading', bytesSent: 0 });
      const startedAt = Date.now();
      const upload = await Transfer.uploadFile({
        transferId: begin.transferId,
        path: prepared.path,
        url: uploadUrl(this.client.host, this.client.port, begin.transferId),
        method: 'PUT',
        headers: {
          'x-localdrop-filename': prepared.filename,
          'x-localdrop-sha256': prepared.sha256,
          'x-localdrop-media-type': item.mediaType,
        },
      });
      const durationMs = Date.now() - startedAt;

      if (upload.statusCode >= 400) {
        // The body is streamed straight to disk, so a rejection here has to be turned into a
        // retryable error. The staging file is cleaned up so a retry starts from a clean slate.
        await this.discard(prepared);
        await this.client.abortTransfer(begin.transferId).catch(() => undefined);
        throw new ServerError(
          `The PC rejected the upload (HTTP ${upload.statusCode}).`,
          'upload_rejected',
          upload.statusCode,
        );
      }

      if (this.cancelled) {
        await this.discard(prepared);
        await this.client.abortTransfer(begin.transferId).catch(() => undefined);
        return;
      }

      // 4. Verify. The PC recomputes SHA-256 over what it received; only a match is a backup.
      this.patch(id, { state: 'verifying' });
      const complete = await this.client.completeTransfer(begin.transferId, {
        sha256: prepared.sha256,
        bytesSent: prepared.byteLength,
        durationMs,
      });
      await this.discard(prepared);

      if (!complete.verified || !complete.stored) {
        this.settle(id, {
          state: 'failed',
          error:
            'The PC could not verify this file, so it was not saved. Nothing was changed on your iPhone.',
          finishedAt: Date.now(),
        });
        return;
      }

      this.settle(id, {
        state: 'completed',
        bytesSent: prepared.byteLength,
        verified: true,
        destinationPath: complete.relativePath,
        error: null,
        finishedAt: Date.now(),
      });
    } catch (error) {
      if (prepared) {
        await this.discard(prepared);
      }
      if (this.cancelled) {
        return;
      }
      const message = describeError(error);
      const canRetry = attempt < MAX_TRANSFER_ATTEMPTS && isRetryable(error);

      if (canRetry) {
        // Exponential backoff: a phone that lost Wi-Fi for ten seconds should not hammer the
        // network the moment it comes back, and a server that is restarting should be given
        // time to come up.
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.patch(id, { state: 'queued', error: `${message} Retrying…` });
        this.emit();
        await this.sleep(delay);
        return;
      }

      this.settle(id, {
        state: 'failed',
        error:
          attempt >= MAX_TRANSFER_ATTEMPTS
            ? `${message} Gave up after ${attempt} attempts.`
            : message,
        finishedAt: Date.now(),
      });
    }
  }

  /** Removes a staging file. Only ever touches a file this app created. */
  private async discard(prepared: PreparedAsset | null): Promise<void> {
    if (!prepared) {
      return;
    }
    await Transfer.discardPreparedFile(prepared.path).catch(() => false);
  }

  private settle(id: string, changes: Partial<TransferItem>): void {
    this.patch(id, changes);
    this.emit();
    const item = this.items.get(id);
    if (item && ['completed', 'skipped', 'failed', 'cancelled'].includes(item.state)) {
      this.onItemSettled?.({ ...item });
    }
  }

  private patch(id: string, changes: Partial<TransferItem>): void {
    const existing = this.items.get(id);
    if (!existing) {
      return;
    }
    this.items.set(id, { ...existing, ...changes });
  }

  private emit(): void {
    this.onChange?.(this.list());
  }

  /**
   * Fans native progress events out to the right queue rows.
   *
   * Updates are throttled per file: a fast upload produces events far more often than a screen
   * can usefully redraw, and each one is a bridge crossing.
   */
  private subscribeToProgress(): void {
    if (this.activeProgressUnsubscribe) {
      return;
    }
    const lastEmit = new Map<string, number>();

    const subscription = transferEvents().addListener(
      TRANSFER_PROGRESS_EVENT,
      (event: UploadProgressEvent) => {
        const now = Date.now();
        const last = lastEmit.get(event.transferId) ?? 0;
        if (now - last < this.progressIntervalMs) {
          return;
        }
        lastEmit.set(event.transferId, now);

        for (const item of this.items.values()) {
          // Native reports the server's transfer id, not our asset id, so match on the row that
          // is currently uploading; there is at most one per lane.
          if (item.state !== 'uploading') {
            continue;
          }
          if (item.fileSize > 0 && event.totalBytes > 0 && event.totalBytes !== item.fileSize) {
            continue;
          }
          this.patch(item.id, {
            bytesSent: event.bytesSent,
            bytesPerSecond: event.bytesPerSecond,
            estimatedSecondsRemaining: event.estimatedSecondsRemaining,
          });
          this.emit();
          break;
        }
      },
    );
    this.activeProgressUnsubscribe = () => subscription.remove();
  }

  private unsubscribeFromProgress(): void {
    this.activeProgressUnsubscribe?.();
    this.activeProgressUnsubscribe = null;
  }
}

/** A failure worth retrying: network blips, timeouts and transient server errors. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ServerError) {
    if (error.code === 'network_error' || error.code === 'timeout') {
      return true;
    }
    // Running out of space on the PC is a 5xx, but retrying is pointless: the user has to free
    // room first, and three attempts over three seconds would just delay the message that
    // tells them so. The Transfer screen offers a manual retry once they have.
    if (error.code === 'insufficient_space' || error.status === 507) {
      return false;
    }
    // 401 means the token is wrong, which retrying cannot fix; 4xx generally means the request
    // itself is wrong. 5xx and 429 are the server's problem and may clear.
    return error.status >= 500 || error.status === 429;
  }
  // A native rejection for a disk or Photos error will not fix itself.
  return false;
}

/** A message safe to show a user. */
export function describeError(error: unknown): string {
  if (error instanceof ServerError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Something went wrong.';
}

/** A `BeginTransferResponse` narrowed to the fields the engine uses. */
export type BeginOutcome = Pick<BeginTransferResponse, 'action' | 'transferId'>;
