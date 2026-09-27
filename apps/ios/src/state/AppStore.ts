/**
 * The single source of truth for the running app.
 *
 * A hand-rolled observable store rather than a state library: the app has one owner for the
 * connection, one for the transfer queue and one for the library, and adding a dependency to
 * manage three of them would be more code than the store itself. React binds to it with
 * `useStore` in `src/state/useStore.ts`.
 *
 * Screens never talk to native modules, the network or the Keychain directly; they read this
 * store and call the intents on it. That is what keeps the transfer logic testable without a
 * simulator.
 */

import {
  formatBytes,
  isSupportedExtension,
  type HistoryEntry,
  type MediaKind,
} from '@localdrop/shared';
import { DiscoveryManager, type DiscoveryState } from '../discovery/DiscoveryManager';
import { PairingManager, type PairingState } from '../pairing/PairingManager';
import { ServerClient, ServerError, type ServerEndpoint } from '../server/ServerClient';
import {
  TransferEngine,
  transferIdFor,
  type QueueSummary,
  type TransferItem,
  type TransferRequest,
} from '../transfer/TransferEngine';
import {
  Photos,
  SecureStore,
  Transfer,
  hasNativeModules,
  type DeviceIdentity,
  type LibraryCounts,
  type PhotoAsset,
  type PhotoAuthorizationStatus,
  type StoredPairing,
} from '../native/NativeModules';

/* ------------------------------------------------------------------ state */

export type ScreenName = 'home' | 'photos' | 'transfer' | 'history' | 'settings';

export type PhotosFilter = MediaKind | 'all';

export interface AppState {
  /** False until the native modules are reachable; gates the whole UI. */
  nativeReady: boolean;

  authorization: PhotoAuthorizationStatus;
  /** True while the permission prompt is up. */
  requestingAuthorization: boolean;

  library: LibraryCounts;
  libraryLoading: boolean;

  discovery: DiscoveryState;
  selectedServerId: string | null;
  /** Non-null while the manual-entry sheet is open. */
  manualEntry: { host: string; port: number; error: string | null; checking: boolean } | null;

  pairing: PairingState;
  pairingError: string | null;
  pairingCode: string;

  connection: ServerClient | null;
  /** Set when a stored token was rejected, so the UI can offer "Pair again". */
  connectionError: string | null;
  serverFreeSpaceBytes: number | null;
  serverBackupDirectory: string;

  assets: PhotoAsset[];
  assetsLoading: boolean;
  assetsLoadingMore: boolean;
  assetsExhausted: boolean;
  /** Offset the next page will be fetched from; `null` once the library is exhausted. */
  nextOffset: number | null;
  filter: PhotosFilter;
  selectedAssetIds: Set<string>;
  /** Assets the PC already has, used for the checkmark and to filter the queue. */
  backedUpAssetIds: Set<string>;

  queue: TransferItem[];
  summary: QueueSummary;
  queueRunning: boolean;

  history: HistoryEntry[];
  historyLoading: boolean;

  error: string | null;
}

const emptySummary: QueueSummary = {
  total: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  inFlight: 'idle',
  bytesTotal: 0,
  bytesDone: 0,
  fraction: null,
  bytesPerSecond: 0,
  estimatedSecondsRemaining: null,
};

/* ------------------------------------------------------------------ store */

type Listener = () => void;

export class AppStore {
  private state: AppState;
  private listeners = new Set<Listener>();

  private readonly pairingManager = new PairingManager();
  private discoveryManager: DiscoveryManager | null = null;
  private engine: TransferEngine | null = null;

  /** Guards against a second `bootstrap` racing the first. */
  private bootPromise: Promise<void> | null = null;

  constructor() {
    this.state = {
      nativeReady: hasNativeModules,
      authorization: 'notDetermined',
      requestingAuthorization: false,
      library: { photos: 0, videos: 0 },
      libraryLoading: false,
      discovery: { status: 'idle', servers: [], error: null },
      selectedServerId: null,
      manualEntry: null,
      pairing: 'unpaired',
      pairingError: null,
      pairingCode: '',
      connection: null,
      connectionError: null,
      serverFreeSpaceBytes: null,
      serverBackupDirectory: '',
      assets: [],
      assetsLoading: false,
      assetsLoadingMore: false,
      assetsExhausted: false,
      nextOffset: null,
      filter: 'all',
      selectedAssetIds: new Set(),
      backedUpAssetIds: new Set(),
      queue: [],
      summary: emptySummary,
      queueRunning: false,
      history: [],
      historyLoading: false,
      error: null,
    };
  }

  /* ---------------------------------------------------------------- store plumbing */

  getState = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(changes: Partial<AppState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) {
      listener();
    }
  }

  /* ---------------------------------------------------------------- bootstrap */

  /**
   * Prepares the app: cleans up abandoned staging files, restores any saved pairing, and starts
   * discovery.
   *
   * Idempotent, because a React StrictMode double-invoke in development must not pair twice or
   * start two mDNS browsers.
   */
  async bootstrap(): Promise<void> {
    if (this.bootPromise) {
      return this.bootPromise;
    }
    this.bootPromise = this.runBootstrap();
    return this.bootPromise;
  }

  private async runBootstrap(): Promise<void> {
    // Files staged by a run that was killed mid-upload would otherwise sit in the Documents
    // directory forever.
    await Transfer.sweepStaging().catch(() => false);

    await this.loadAuthorization();
    await this.loadCounts();
    await this.restorePairing();
    await this.startDiscovery();
  }

  private async loadAuthorization(): Promise<void> {
    try {
      const status = await Photos.getAuthorizationStatus();
      this.set({ authorization: status });
    } catch (error) {
      this.set({ error: describe(error) });
    }
  }

  /** Prompts for Photos access, then loads the counts that depend on it. */
  async requestAuthorization(): Promise<void> {
    if (this.state.requestingAuthorization) {
      return;
    }
    this.set({ requestingAuthorization: true, error: null });
    try {
      const status = await Photos.requestAuthorization();
      this.set({ authorization: status });
      if (status === 'authorized' || status === 'limited') {
        await this.loadCounts();
      }
    } catch (error) {
      this.set({ error: describe(error) });
    } finally {
      this.set({ requestingAuthorization: false });
    }
  }

  private async loadCounts(): Promise<void> {
    const { authorization } = this.state;
    if (authorization !== 'authorized' && authorization !== 'limited') {
      this.set({ library: { photos: 0, videos: 0 } });
      return;
    }
    this.set({ libraryLoading: true });
    try {
      this.set({ library: await Photos.getLibraryCounts() });
    } catch (error) {
      this.set({ error: describe(error) });
    } finally {
      this.set({ libraryLoading: false });
    }
  }

  /* ---------------------------------------------------------------- discovery */

  private async startDiscovery(): Promise<void> {
    this.discoveryManager?.stop().catch(() => undefined);
    this.discoveryManager = new DiscoveryManager({
      onChange: (discovery) => this.set({ discovery }),
    });
    await this.discoveryManager.start();
  }

  /** Stops discovery. Called when the app goes to the background. */
  async stopDiscovery(): Promise<void> {
    await this.discoveryManager?.stop();
  }

  async startDiscoveryAgain(): Promise<void> {
    await this.startDiscovery();
  }

  selectServer(serverId: string | null): void {
    this.set({ selectedServerId: serverId, pairingError: null });
  }

  /* ---------------------------------------------------------------- manual entry */

  openManualEntry(): void {
    this.set({ manualEntry: { host: '', port: 47821, error: null, checking: false } });
  }

  closeManualEntry(): void {
    this.set({ manualEntry: null });
  }

  setManualHost(host: string): void {
    const current = this.state.manualEntry;
    if (!current) {
      return;
    }
    this.set({ manualEntry: { ...current, host, error: null } });
  }

  setManualPort(port: number): void {
    const current = this.state.manualEntry;
    if (!current) {
      return;
    }
    this.set({ manualEntry: { ...current, port, error: null } });
  }

  /**
   * Probes a typed address and, if reachable, adds it to the list.
   *
   * Probing before pairing means the user finds out they mistyped the address here, with a
   * clear message, rather than after typing a six-digit code.
   */
  async submitManualEntry(): Promise<ServerEndpoint | null> {
    const current = this.state.manualEntry;
    if (!current || this.discoveryManager === null) {
      return null;
    }
    this.set({ manualEntry: { ...current, checking: true, error: null } });
    const result = await this.discoveryManager.addManualServer(current.host, current.port);
    if ('error' in result) {
      this.set({
        manualEntry: { ...current, checking: false, error: result.error },
      });
      return null;
    }
    this.set({ manualEntry: null });
    this.selectServer(result.endpoint.serverId);
    return result.endpoint;
  }

  /* ---------------------------------------------------------------- pairing */

  private async restorePairing(): Promise<void> {
    const pairing = await this.pairingManager.load();
    if (!pairing) {
      return;
    }
    const client = this.pairingManager.clientFor(pairing);
    this.set({
      pairing: 'paired',
      connection: client,
      serverBackupDirectory: '',
    });

    // Confirm the token is still good. A PC that has forgotten this phone is common enough
    // (unpaired, database reset) that assuming success would produce a confusing failure on
    // the first upload instead.
    const result = await this.pairingManager.verify(pairing);
    if (!result.valid) {
      this.set({
        pairing: 'error',
        connectionError:
          result.error ?? 'This PC is no longer paired with this iPhone. Enter the code again.',
      });
      return;
    }
    await this.refreshServerInfo();
  }

  /** Fetches `/api/health` for the free-space and library-folder readouts. */
  async refreshServerInfo(): Promise<void> {
    const client = this.state.connection;
    if (!client) {
      return;
    }
    try {
      const health = await client.health();
      this.set({
        pairing: 'paired',
        connectionError: null,
        serverFreeSpaceBytes: health.freeSpaceBytes,
        serverBackupDirectory: health.backupDirectory,
      });
    } catch (error) {
      if (error instanceof ServerError && error.needsPairing) {
        this.set({
          pairing: 'error',
          connection: null,
          connectionError: 'This PC is no longer paired with this iPhone. Enter the code again.',
        });
        return;
      }
      this.set({ connectionError: describe(error) });
    }
  }

  setPairingCode(code: string): void {
    this.set({ pairingCode: code });
  }

  /** Exchanges the entered code for a token. */
  async completePairing(): Promise<boolean> {
    const serverId = this.state.selectedServerId;
    const endpoint = this.state.discovery.servers.find((s) => s.serverId === serverId);
    if (!endpoint) {
      this.set({ pairingError: 'Choose your PC first.' });
      return false;
    }
    if (this.state.pairingCode.trim().length === 0) {
      this.set({ pairingError: 'Enter the code shown on your PC.' });
      return false;
    }

    this.set({ pairing: 'pairing', pairingError: null });
    const result = await this.pairingManager.pair(endpoint, this.state.pairingCode.trim());

    if (!result.ok || !result.client) {
      this.set({ pairing: 'error', pairingError: result.error ?? 'Pairing failed.' });
      return false;
    }

    this.set({
      pairing: 'paired',
      pairingError: null,
      pairingCode: '',
      connection: result.client,
    });
    await this.refreshServerInfo();
    await this.refreshBackedUpStatus();
    return true;
  }

  /** Forgets the PC's credentials. Nothing is deleted from the library. */
  async unpair(): Promise<void> {
    const client = this.state.connection;
    if (client) {
      // Best effort: tells the PC to drop the device row. Failure is not important enough to
      // block the local clear, because the token is being discarded either way.
      await client.verifySession().catch(() => undefined);
    }
    await this.pairingManager.unpair();
    this.engine = null;
    this.set({
      pairing: 'unpaired',
      connection: null,
      connectionError: null,
      backedUpAssetIds: new Set(),
      queue: [],
      summary: emptySummary,
      queueRunning: false,
    });
  }

  /* ---------------------------------------------------------------- library browsing */

  setFilter(filter: PhotosFilter): void {
    if (this.state.filter === filter) {
      return;
    }
    // Selection is per-view: keeping ids from a "photos" filter selected in "videos" would
    // silently change what "Backup selected" does.
    this.set({ filter, selectedAssetIds: new Set() });
  }

  /** Loads the first page for the current filter. */
  async loadAssets(options: { refresh?: boolean } = {}): Promise<void> {
    const { authorization, filter } = this.state;
    if (authorization !== 'authorized' && authorization !== 'limited') {
      this.set({ assets: [], assetsExhausted: true });
      return;
    }
    if (options.refresh) {
      this.set({ assetsLoading: true, assets: [], assetsExhausted: false });
    } else if (this.state.assetsLoading) {
      return;
    } else {
      this.set({ assetsLoading: true });
    }

    try {
      const result = await Photos.fetchAssets({
        offset: 0,
        limit: 120,
        mediaType: filter,
      });
      this.set({
        assets: result.assets,
        assetsExhausted: result.nextOffset === null,
        nextOffset: result.nextOffset,
        assetsLoading: false,
      });
      await this.refreshBackedUpStatus();
    } catch (error) {
      this.set({ assetsLoading: false, error: describe(error) });
    }
  }

  /** Appends the next page. */
  async loadMoreAssets(): Promise<void> {
    if (this.state.assetsLoadingMore || this.state.assetsExhausted) {
      return;
    }
    const nextOffset = this.state.nextOffset;
    if (nextOffset === null || nextOffset === undefined) {
      return;
    }
    this.set({ assetsLoadingMore: true });
    try {
      const result = await Photos.fetchAssets({
        offset: nextOffset,
        limit: 120,
        mediaType: this.state.filter,
      });
      this.set({
        assets: [...this.state.assets, ...result.assets],
        assetsExhausted: result.nextOffset === null,
        nextOffset: result.nextOffset,
        assetsLoadingMore: false,
      });
      await this.refreshBackedUpStatus();
    } catch (error) {
      this.set({ assetsLoadingMore: false, error: describe(error) });
    }
  }

  /**
   * Asks the PC which of the loaded assets it already has.
   *
   * The PC's database is the authority. Caching "backed up" on the phone would go stale the
   * moment the user deletes a file on the PC or restores from elsewhere.
   */
  async refreshBackedUpStatus(): Promise<void> {
    const client = this.state.connection;
    if (!client || this.state.assets.length === 0) {
      return;
    }
    try {
      const ids = this.state.assets.map((asset) => asset.localIdentifier);
      const backedUp = await client.assetStatus(ids);
      this.set({ backedUpAssetIds: backedUp });
    } catch (error) {
      // Not fatal: the checkmark is a convenience, and the queue filters again before sending.
      if (!(error instanceof ServerError)) {
        this.set({ error: describe(error) });
      }
    }
  }

  /* ---------------------------------------------------------------- selection */

  toggleSelection(assetId: string): void {
    const next = new Set(this.state.selectedAssetIds);
    if (next.has(assetId)) {
      next.delete(assetId);
    } else {
      next.add(assetId);
    }
    this.set({ selectedAssetIds: next });
  }

  selectAll(): void {
    const selectable = this.state.assets.filter((asset) => !this.isBackedUp(asset));
    this.set({ selectedAssetIds: new Set(selectable.map((a) => a.localIdentifier)) });
  }

  clearSelection(): void {
    this.set({ selectedAssetIds: new Set() });
  }

  isSelected(assetId: string): boolean {
    return this.state.selectedAssetIds.has(assetId);
  }

  isBackedUp(asset: PhotoAsset): boolean {
    return this.state.backedUpAssetIds.has(asset.localIdentifier);
  }

  /** Loads a thumbnail URL for a tile, returning null on failure. */
  async thumbnailFor(assetId: string, size = 220): Promise<string | null> {
    try {
      const result = await Photos.requestThumbnail(assetId, size);
      return result.uri;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- transfers */

  private ensureEngine(): TransferEngine | null {
    const client = this.state.connection;
    if (!client) {
      return null;
    }
    if (this.engine) {
      return this.engine;
    }
    this.engine = new TransferEngine(client, {
      concurrency: 1,
      onChange: (items) => this.set({ queue: items, summary: this.engine?.summary() ?? emptySummary }),
      onItemSettled: (item) => {
        if (item.state === 'completed') {
          // Keep the checkmark in step with what actually landed.
          const backedUp = new Set(this.state.backedUpAssetIds);
          backedUp.add(item.assetId);
          this.set({ backedUpAssetIds: backedUp });
        }
      },
    });
    return this.engine;
  }

  /**
   * Expands a photo asset into the things that must actually be transferred.
   *
   * A Live Photo becomes two transfers - the still image and its paired video - because the PC
   * needs both files to keep the pair intact, and it files them side by side.
   */
  buildRequests(assets: PhotoAsset[]): TransferRequest[] {
    const requests: TransferRequest[] = [];
    for (const asset of assets) {
      if (!isSupportedExtension(asset.filename)) {
        continue;
      }
      requests.push({
        assetId: asset.localIdentifier,
        filename: asset.filename,
        mediaType: asset.mediaType,
        creationDate: asset.creationDate,
        isLivePhotoVideo: false,
        livePhotoId: null,
      });

      if (asset.isLivePhoto && asset.livePhotoVideo) {
        const videoFilename = asset.livePhotoVideo.filename;
        if (isSupportedExtension(videoFilename)) {
          requests.push({
            assetId: asset.localIdentifier,
            filename: videoFilename,
            mediaType: 'video',
            creationDate: asset.creationDate,
            isLivePhotoVideo: true,
            livePhotoId: asset.localIdentifier,
            livePhotoVideoFilename: videoFilename,
          });
        }
      }
    }
    return requests;
  }

  /**
   * Queues assets and starts the transfer.
   *
   * `assets` defaults to the current selection; passing an empty array queues everything in the
   * current filter that the PC does not already have.
   */
  async startBackup(assets?: PhotoAsset[]): Promise<number> {
    const engine = this.ensureEngine();
    if (!engine) {
      this.set({ error: 'Pair with your PC before starting a backup.' });
      return 0;
    }

    const source =
      assets ??
      this.state.assets.filter(
        (asset) => this.isSelected(asset.localIdentifier) || !this.isBackedUp(asset),
      );

    if (source.length === 0) {
      this.set({ error: 'There is nothing new to back up.' });
      return 0;
    }

    const requests = this.buildRequests(source);
    const queued = await engine.enqueue(requests, {
      knownBackedUp: this.state.backedUpAssetIds,
    });

    this.set({ summary: engine.summary() });
    if (queued.length === 0) {
      this.set({ error: 'Everything selected is already backed up.' });
      return 0;
    }

    void this.drainQueue();
    return queued.length;
  }

  /**
   * Runs the queue to completion, keeping `queueRunning` accurate.
   *
   * Failures are recorded per file and do not stop the rest: one unreadable iCloud placeholder
   * must not abandon a thousand good backups.
   */
  private async drainQueue(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.state.queueRunning) {
      return;
    }
    this.set({ queueRunning: true });
    try {
      await engine.run();
      await this.loadHistory();
    } catch (error) {
      this.set({ error: describe(error) });
    } finally {
      this.set({ queueRunning: false, summary: engine.summary() });
    }
  }

  async cancelTransfers(): Promise<void> {
    await this.engine?.cancel();
    this.set({ queueRunning: false });
  }

  /** Re-queues everything that failed. */
  async retryFailed(): Promise<number> {
    const engine = this.engine;
    if (!engine) {
      return 0;
    }
    const count = engine.retryFailed();
    if (count > 0) {
      void this.drainQueue();
    }
    return count;
  }

  clearFinished(): void {
    this.engine?.clearFinished();
    this.set({ summary: this.engine?.summary() ?? emptySummary });
  }

  /* ---------------------------------------------------------------- history */

  async loadHistory(): Promise<void> {
    const client = this.state.connection;
    if (!client) {
      this.set({ history: [] });
      return;
    }
    this.set({ historyLoading: true });
    try {
      const response = await client.history(100, 0);
      this.set({ history: response.entries, historyLoading: false });
    } catch (error) {
      this.set({ historyLoading: false });
      if (!(error instanceof ServerError)) {
        this.set({ error: describe(error) });
      }
    }
  }

  /* ---------------------------------------------------------------- misc */

  dismissError(): void {
    this.set({ error: null });
  }

  setError(message: string | null): void {
    this.set({ error: message });
  }

  /** Frees cached thumbnails. Called when the Photos screen unmounts. */
  async clearThumbnailCache(): Promise<void> {
    await Photos.clearThumbnailCache().catch(() => 0);
  }

  /** Bytes still sitting in staging, for the Settings screen's storage readout. */
  async stagingFootprint(): Promise<{ fileCount: number; byteLength: number; freeSpaceBytes: number }> {
    return Transfer.stagingFootprint().catch(() => ({
      fileCount: 0,
      byteLength: 0,
      freeSpaceBytes: 0,
    }));
  }

  /** Device identity, for the "about" section and for pairing. */
  async deviceIdentity(): Promise<DeviceIdentity> {
    return SecureStore.deviceIdentity();
  }
}

/* ------------------------------------------------------------------ helpers */

function describe(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Something went wrong.';
}

/** Formats a byte count for the Home screen's "N GB to back up" line. */
export function describeBytes(bytes: number): string {
  return formatBytes(bytes);
}

export { transferIdFor };
