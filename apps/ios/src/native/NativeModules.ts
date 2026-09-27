/**
 * Typed wrappers around the LocalDrop native modules.
 *
 * This is the only place in the app that touches `NativeModules` or `NativeEventEmitter`.
 * Everything else works with the typed interfaces below, so a change to the Swift/ObjC bridge
 * surfaces as a TypeScript error in one file rather than as `undefined is not a function` in a
 * screen.
 *
 * The module and method names here must match `ios/LocalDrop/Native/LocalDropNativeModules.m`
 * and the Swift implementations.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { MediaKind } from '@localdrop/shared';

/* ------------------------------------------------------------------ Photos */

export type PhotoAuthorizationStatus =
  | 'notDetermined'
  | 'restricted'
  | 'denied'
  | 'authorized'
  | 'limited';

/** The video half of a Live Photo, discovered from the asset's paired resource. */
export interface LivePhotoVideoResource {
  filename: string;
  uti: string;
}

/** One asset in the library, as reported by `PHAsset` + `PHAssetResource`. */
export interface PhotoAsset {
  /** `PHAsset.localIdentifier` - the PC's dedupe key. */
  localIdentifier: string;
  filename: string;
  uti: string;
  mediaType: MediaKind;
  pixelWidth: number;
  pixelHeight: number;
  creationDate: string;
  modificationDate: string;
  isLivePhoto: boolean;
  durationSeconds: number | null;
  /** False when the original still lives in iCloud and has not been downloaded. */
  hasCloudContent?: boolean;
  livePhotoVideo: LivePhotoVideoResource | null;
}

export interface FetchAssetsOptions {
  offset?: number;
  limit?: number;
  mediaType?: MediaKind | 'all';
  includeLivePhotos?: boolean;
}

export interface FetchAssetsResult {
  assets: PhotoAsset[];
  /** `null` when the end of the library was reached. */
  nextOffset: number | null;
  total: number;
  /** Assets examined, which exceeds `assets.length` when entries were filtered out. */
  scanned: number;
}

export interface LibraryCounts {
  photos: number;
  videos: number;
}

export interface ThumbnailResult {
  /** `file://` URL to a cached JPEG, or `null` when rendering failed. */
  uri: string | null;
  width?: number;
  height?: number;
  byteLength?: number;
  error?: string;
}

interface PhotosNativeModule {
  getAuthorizationStatus(): Promise<PhotoAuthorizationStatus>;
  requestAuthorization(): Promise<PhotoAuthorizationStatus>;
  fetchAssets(options: FetchAssetsOptions): Promise<FetchAssetsResult>;
  getLibraryCounts(): Promise<LibraryCounts>;
  getAsset(localIdentifier: string): Promise<PhotoAsset>;
  requestThumbnail(options: {
    localIdentifier: string;
    size?: number;
    scale?: number;
  }): Promise<ThumbnailResult>;
  clearThumbnailCache(): Promise<number>;
}

/* ------------------------------------------------------------------ Transfer */

/** A file staged on disk, ready to upload, with its hash already computed. */
export interface PreparedAsset {
  /** Absolute path to the staging copy. Never read into JS. */
  path: string;
  filename: string;
  byteLength: number;
  sha256: string;
  didTranscode: boolean;
}

export type PrepareKind = MediaKind | 'livePhotoVideo';

export interface UploadProgressEvent {
  transferId: string;
  bytesSent: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
  bytesPerSecond: number;
  estimatedSecondsRemaining: number | null;
}

export interface UploadResult {
  statusCode: number;
  body: string;
}

export interface StagingFootprint {
  fileCount: number;
  byteLength: number;
  freeSpaceBytes: number;
}

interface TransferNativeModule {
  activeUploadCount(): Promise<number>;
  prepareAsset(options: { localIdentifier: string; kind: PrepareKind }): Promise<PreparedAsset>;
  uploadFile(options: {
    transferId: string;
    path: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<UploadResult>;
  cancelUpload(transferId: string): Promise<boolean>;
  cancelAllUploads(): Promise<boolean>;
  discardPreparedFile(path: string): Promise<boolean>;
  sweepStaging(): Promise<boolean>;
  stagingFootprint(): Promise<StagingFootprint>;
}

/* ------------------------------------------------------------------ Discovery */

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  serviceType: string;
  domain: string;
  /** 0 when the PC did not advertise it, which means "assume compatible". */
  protocolVersion: number;
  appVersion: string;
  fullName: string;
}

export type DiscoveryEventType = 'ready' | 'results' | 'failed' | 'stopped';

export interface DiscoveryEvent {
  listenerId: string;
  type: DiscoveryEventType;
  servers: DiscoveredServer[];
  error?: string;
}

export interface HostReachability {
  reachable: boolean;
  host: string;
  port: number;
}

interface DiscoveryNativeModule {
  startBrowsing(options: {
    serviceType: string;
    domain: string;
    listenerId: string;
  }): Promise<{ started: boolean; listenerId: string }>;
  stopBrowsing(listenerId: string): Promise<boolean>;
  resolveHost(host: string, port: number): Promise<HostReachability>;
}

/* ------------------------------------------------------------------ Secure store */

export interface StoredPairing {
  token: string;
  serverId: string;
  serverName: string;
  host: string;
  port: number;
  deviceId: string;
  deviceName: string;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

interface SecureStoreNativeModule {
  setValue(value: string, key: string): Promise<boolean>;
  getValue(key: string): Promise<string | null | { __error: string; status: number }>;
  removeValue(key: string): Promise<boolean>;
  clearAll(): Promise<boolean>;
  loadPairing(): Promise<StoredPairing | null>;
  savePairing(pairing: StoredPairing): Promise<boolean>;
  clearPairing(): Promise<boolean>;
  deviceIdentity(): Promise<DeviceIdentity>;
}

/* ------------------------------------------------------------------ Module access */

/** Thrown when a native module is missing, which means the Xcode project is out of date. */
export class NativeModuleUnavailableError extends Error {
  constructor(name: string) {
    super(
      `The native module "${name}" is not available. Rebuild the iOS app ` +
        `(cd ios && pod install, then run from Xcode) - a JS-only reload is not enough ` +
        `after adding a native module.`,
    );
    this.name = 'NativeModuleUnavailableError';
  }
}

function require_<T>(name: string): T {
  const module = (NativeModules as Record<string, unknown>)[name] as T | undefined;
  if (!module) {
    throw new NativeModuleUnavailableError(name);
  }
  return module;
}

function native(): PhotosNativeModule {
  return require_('LocalDropPhotos');
}

function transfer(): TransferNativeModule {
  return require_('LocalDropTransfer');
}

function discovery(): DiscoveryNativeModule {
  return require_('LocalDropDiscovery');
}

function secureStore(): SecureStoreNativeModule {
  return require_('LocalDropSecureStore');
}

/* ------------------------------------------------------------------ Public API */

export const Photos = {
  getAuthorizationStatus: (): Promise<PhotoAuthorizationStatus> =>
    native().getAuthorizationStatus(),

  requestAuthorization: (): Promise<PhotoAuthorizationStatus> =>
    native().requestAuthorization(),

  fetchAssets: (options: FetchAssetsOptions = {}): Promise<FetchAssetsResult> =>
    native().fetchAssets({
      offset: options.offset ?? 0,
      limit: options.limit ?? 120,
      mediaType: options.mediaType ?? 'all',
      includeLivePhotos: options.includeLivePhotos ?? true,
    }),

  getLibraryCounts: (): Promise<LibraryCounts> => native().getLibraryCounts(),

  getAsset: (localIdentifier: string): Promise<PhotoAsset> => native().getAsset(localIdentifier),

  requestThumbnail: (localIdentifier: string, size = 320): Promise<ThumbnailResult> =>
    native().requestThumbnail({ localIdentifier, size }),

  clearThumbnailCache: (): Promise<number> => native().clearThumbnailCache(),
};

/** Event name for upload progress. Must match `LocalDropTransfer.progressEvent`. */
export const TRANSFER_PROGRESS_EVENT = 'LocalDropTransferProgress';
/** Event name for discovery results. Must match `LocalDropDiscovery.eventName`. */
export const DISCOVERY_EVENT = 'LocalDropDiscoveryEvent';

let transferEmitter: NativeEventEmitter | null = null;
let discoveryEmitter: NativeEventEmitter | null = null;

/**
 * Emitter for `LocalDropTransfer`'s events.
 *
 * `NativeEventEmitter` requires the module instance on non-iOS platforms; iOS is the only
 * target, but passing it keeps the call explicit and avoids a warning.
 */
export function transferEvents(): NativeEventEmitter {
  if (!transferEmitter) {
    transferEmitter = new NativeEventEmitter(
      (NativeModules as Record<string, unknown>).LocalDropTransfer as never,
    );
  }
  return transferEmitter;
}

export function discoveryEvents(): NativeEventEmitter {
  if (!discoveryEmitter) {
    discoveryEmitter = new NativeEventEmitter(
      (NativeModules as Record<string, unknown>).LocalDropDiscovery as never,
    );
  }
  return discoveryEmitter;
}

export const Transfer = {
  activeUploadCount: (): Promise<number> => transfer().activeUploadCount(),

  /**
   * Streams the asset's original bytes to a staging file and hashes them natively.
   *
   * This is the call that keeps large media off the JS heap: a 4 GB video is copied in 1 MiB
   * blocks and uploaded from the file, never loaded into a JS string.
   */
  prepareAsset: (localIdentifier: string, kind: PrepareKind = 'photo'): Promise<PreparedAsset> =>
    transfer().prepareAsset({ localIdentifier, kind }),

  /** Uploads a prepared file. Progress arrives on `TRANSFER_PROGRESS_EVENT`. */
  uploadFile: (options: {
    transferId: string;
    path: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<UploadResult> => transfer().uploadFile(options),

  cancelUpload: (transferId: string): Promise<boolean> => transfer().cancelUpload(transferId),

  cancelAllUploads: (): Promise<boolean> => transfer().cancelAllUploads(),

  /** Deletes a staging file. Only ever called on files this app created. */
  discardPreparedFile: (path: string): Promise<boolean> => transfer().discardPreparedFile(path),

  /** Removes staging files abandoned by a previous run. */
  sweepStaging: (): Promise<boolean> => transfer().sweepStaging(),

  stagingFootprint: (): Promise<StagingFootprint> => transfer().stagingFootprint(),
};

export const Discovery = {
  startBrowsing: (listenerId: string, serviceType: string, domain = 'local.') =>
    discovery().startBrowsing({ serviceType, domain, listenerId }),

  stopBrowsing: (listenerId: string): Promise<boolean> => discovery().stopBrowsing(listenerId),

  /** TCP reachability probe, used by the manual IP-address fallback. */
  resolveHost: (host: string, port: number): Promise<HostReachability> =>
    discovery().resolveHost(host, port),
};

export const SecureStore = {
  loadPairing: (): Promise<StoredPairing | null> => secureStore().loadPairing(),
  savePairing: (pairing: StoredPairing): Promise<boolean> => secureStore().savePairing(pairing),
  clearPairing: (): Promise<boolean> => secureStore().clearPairing(),
  deviceIdentity: (): Promise<DeviceIdentity> => secureStore().deviceIdentity(),
  removeValue: (key: string): Promise<boolean> => secureStore().removeValue(key),
};

/** True when running on a platform with the native modules available. */
export const hasNativeModules =
  Platform.OS === 'ios' && Boolean((NativeModules as Record<string, unknown>).LocalDropPhotos);
