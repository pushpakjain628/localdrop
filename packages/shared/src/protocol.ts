/**
 * The LocalDrop HTTP wire protocol.
 *
 * Transport: HTTP/1.1 on the local network, no TLS. That is acceptable *because* every
 * route that touches user data requires a bearer token issued over a short-lived,
 * human-verified pairing code, and the server binds to the LAN only. See
 * `SECURITY.md` for the threat model and the reason TLS termination is left to the router
 * or a VPN if the user needs it.
 *
 * Every response body is JSON except `PUT /api/transfers/:id/content`, whose request body
 * is a raw `application/octet-stream` file. Streaming the raw bytes (rather than
 * base64-in-JSON or multipart) is what keeps large videos off the JS heap on the phone and
 * lets the PC hash the bytes as they arrive.
 *
 * MUST stay in lock-step with `apps/windows/src-tauri/src/protocol.rs`.
 */

import type { MediaKind } from './media';

export const API_VERSION_HEADER = 'x-localdrop-protocol';

/* ------------------------------------------------------------------ health / pairing */

/** `GET /api/health` — unauthenticated liveness + capability probe. */
export interface HealthResponse {
  /** Product name, always `LocalDrop`. */
  product: string;
  /** Server version string. */
  version: string;
  /** Wire protocol version; the phone refuses to proceed on a mismatch. */
  protocolVersion: number;
  /** Stable identifier for this PC, shown in the phone's device list. */
  serverId: string;
  /** Display name of the PC, e.g. `DESKTOP-ABC123`. */
  serverName: string;
  /** True when at least one iPhone is paired and holds a valid token. */
  paired: boolean;
  /** Directory the library is currently written to. */
  backupDirectory: string;
  /** True when the library root exists and is writable. */
  storageWritable: boolean;
  /** Free bytes on the volume holding the library root, or `null` if unknown. */
  freeSpaceBytes: number | null;
  /** Uptime in seconds, used by the phone to detect a restarted server. */
  uptimeSeconds: number;
  /**
   * This PC's LAN addresses, for the manual-entry fallback.
   *
   * Discovery can be blocked by a guest or corporate network, and then the only way in is to
   * type the address. The dashboard shows these so there is something to type; the phone's
   * help text points at exactly this.
   */
  lanAddresses: string[];
}

/** `POST /api/pair` — exchange a verification code for a long-lived bearer token. */
export interface PairRequest {
  protocolVersion: number;
  /** `UIDevice.current.name` on the phone. */
  deviceName: string;
  /** Stable per-install identifier, so the PC can show "iPhone (2)". */
  deviceId: string;
  /** iOS version string, informational. */
  osVersion: string;
  /** App version string, informational. */
  appVersion: string;
}

export interface PairResponse {
  /** Bearer token for all subsequent requests. */
  token: string;
  serverId: string;
  serverName: string;
  backupDirectory: string;
  /** Token lifetime in seconds; the phone re-pairs when it lapses. */
  expiresInSeconds: number;
}

/** `POST /api/pairing/rotate` — invalidates the current code and issues a new one. */
export interface RotatePairingCodeResponse {
  /** The new code, e.g. `123456`. Shown on the PC only. */
  code: string;
  expiresAt: number;
}

/* ------------------------------------------------------------------ asset state */

/** `POST /api/assets/status` — which of these assets are already safely backed up. */
export interface AssetStatusRequest {
  assetIds: string[];
}

export interface AssetStatusResponse {
  /** Subset of `assetIds` that already have a verified `completed` row. */
  backedUpAssetIds: string[];
}

/* ------------------------------------------------------------------ transfers */

/** Lifecycle of a single asset transfer. */
export type TransferStatus =
  | 'pending'
  | 'uploading'
  | 'verifying'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'aborted';

/** What the phone should do next for an asset it wants to back up. */
export type TransferAction = 'upload' | 'skip' | 'unsupported';

/** `POST /api/transfers/begin` — reserve a destination before any bytes are sent. */
export interface BeginTransferRequest {
  /** `PHAsset.localIdentifier`; the PC's dedupe key. */
  assetId: string;
  /** `PHAssetResource.originalFilename`, e.g. `IMG_1234.HEIC`. */
  filename: string;
  mediaType: MediaKind;
  /** Exact byte length the phone will send; the PC rejects a mismatch. */
  fileSize: number;
  /** ISO-8601 asset creation timestamp. Drives the folder layout. */
  createdAt: string;
  /**
   * SHA-256 of the file, computed on the phone *before* upload. The PC recomputes the hash
   * while writing and compares, so a corrupted transfer is caught even though both sides
   * "agree" on the length.
   */
  sha256: string;
  /** For a Live Photo video component: the `assetId` of its paired still image. */
  livePhotoId?: string | null;
  /** True when this asset is the video half of a Live Photo. */
  isLivePhotoVideo?: boolean;
  /** Pixel width, informational (shown in the PC's history table). */
  pixelWidth?: number | null;
  /** Pixel height, informational. */
  pixelHeight?: number | null;
  /** Duration in seconds for videos, informational. */
  durationSeconds?: number | null;
}

export interface BeginTransferResponse {
  transferId: string;
  action: TransferAction;
  /**
   * Set when `action === 'skip'`: why the asset was not needed. Lets the phone show
   * "Already backed up" instead of a silent no-op.
   */
  skipReason?: 'already_backed_up' | 'duplicate_in_flight' | 'unsupported_format' | null;
  /** Relative path the PC intends to write, for display before the upload starts. */
  relativePath?: string | null;
  /** True when the PC's dedupe check found an existing verified copy. */
  alreadyBackedUp?: boolean;
}

/** Header names used by `PUT /api/transfers/:id/content`. */
export const CONTENT_FILENAME_HEADER = 'x-localdrop-filename';
export const CONTENT_SHA256_HEADER = 'x-localdrop-sha256';
export const CONTENT_LENGTH_HEADER = 'content-length';
export const CONTENT_MEDIA_TYPE_HEADER = 'x-localdrop-media-type';

/** `POST /api/transfers/:id/complete` — verify, file into place and record the row. */
export interface CompleteTransferRequest {
  /** Hash the phone computed over the bytes it sent. */
  sha256: string;
  /** Number of bytes the phone actually sent. */
  bytesSent: number;
  /** How long the upload took, for the history row. */
  durationMs?: number;
}

export interface CompleteTransferResponse {
  transferId: string;
  status: Extract<TransferStatus, 'completed' | 'skipped'>;
  /** Hash recomputed by the PC over the bytes it received. */
  verifiedSha256: string;
  /** True when the PC's hash matched the phone's. */
  verified: boolean;
  /** Final on-disk location, relative to the library root, with `/` separators. */
  relativePath: string;
  /** Absolute path on the PC, shown in the history UI. */
  absolutePath: string;
  /** False when the hash mismatched: the partial file is kept for inspection. */
  stored: boolean;
}

/** `POST /api/transfers/:id/abort` — discard an in-flight upload. */
export interface AbortTransferResponse {
  transferId: string;
  aborted: boolean;
}

/* ------------------------------------------------------------------ history & stats */

export interface HistoryEntry {
  transferId: string;
  assetId: string;
  filename: string;
  mediaType: MediaKind;
  fileSize: number;
  createdAt: string;
  sha256: string;
  /** Path relative to the library root, `/` separated. */
  relativePath: string;
  absolutePath: string;
  /** When the transfer completed (ISO-8601). */
  backedUpAt: string;
  status: TransferStatus;
  deviceName: string | null;
  livePhotoId: string | null;
  isLivePhotoVideo: boolean;
  /** Populated for failures. */
  errorMessage: string | null;
  durationMs: number | null;
}

export interface HistoryResponse {
  entries: HistoryEntry[];
  /** Total rows matching the filter, for pagination. */
  total: number;
  limit: number;
  offset: number;
}

export interface LibraryStats {
  /** Total verified bytes stored. */
  totalBytes: number;
  totalFiles: number;
  photos: number;
  videos: number;
  /** Bytes stored in the last 30 days. */
  bytesLast30Days: number;
  filesLast30Days: number;
  failedTransfers: number;
  /** Distinct `YYYY/MM` groups present in the library, newest first. */
  months: Array<{ label: string; files: number; bytes: number }>;
}

/* ------------------------------------------------------------------ settings */

/** `POST /api/settings/backup-directory` — move the library root. */
export interface SetBackupDirectoryRequest {
  /** Absolute Windows path chosen by the user. */
  directory: string;
}

export interface SetBackupDirectoryResponse {
  backupDirectory: string;
  storageWritable: boolean;
  freeSpaceBytes: number | null;
}

export interface ServerSettingsResponse {
  backupDirectory: string;
  storageWritable: boolean;
  freeSpaceBytes: number | null;
  /** `D:\iPhone Backup` when it exists, otherwise the fallback in use. */
  defaultDirectory: string;
  defaultDirectoryAvailable: boolean;
  /** Directories the user may pick from. */
  suggestedDirectories: string[];
}

/* ------------------------------------------------------------------ live events */

/**
 * Server-sent events pushed over the WebSocket at `GET /api/events`, used by the Windows
 * dashboard. The phone does not use these; it gets per-file progress directly from the
 * native upload task.
 */
export type ServerEvent =
  | { type: 'server_started'; serverName: string; backupDirectory: string; at: string }
  | { type: 'client_connected'; deviceName: string; deviceId: string; at: string }
  | { type: 'client_disconnected'; deviceName: string; deviceId: string; at: string }
  | {
      type: 'transfer_started';
      transferId: string;
      assetId: string;
      filename: string;
      mediaType: MediaKind;
      fileSize: number;
      deviceName: string | null;
      at: string;
    }
  | {
      type: 'transfer_progress';
      transferId: string;
      bytesReceived: number;
      totalBytes: number;
      bytesPerSecond: number;
      at: string;
    }
  | { type: 'transfer_completed'; transferId: string; relativePath: string; verified: boolean; at: string }
  | { type: 'transfer_failed'; transferId: string; filename: string; error: string; at: string }
  | { type: 'transfer_skipped'; transferId: string; filename: string; reason: string; at: string }
  | { type: 'stats_changed'; stats: LibraryStats; at: string };

/* ------------------------------------------------------------------ errors */

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present for validation failures. */
    details?: Record<string, string>;
  };
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'protocol_mismatch'
  | 'invalid_request'
  | 'pairing_failed'
  | 'transfer_not_found'
  | 'transfer_conflict'
  | 'checksum_mismatch'
  | 'size_mismatch'
  | 'storage_unwritable'
  | 'insufficient_space'
  | 'internal_error';
