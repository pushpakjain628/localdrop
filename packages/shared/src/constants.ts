/**
 * Protocol-level constants shared by the iOS app and the Windows companion.
 *
 * Anything in this file MUST stay in lock-step with `apps/windows/src-tauri/src/protocol.rs`.
 * Both sides are versioned independently, so a mismatch is detected at runtime via
 * {@link PROTOCOL_VERSION} rather than by the compiler.
 */

/** Bonjour service type advertised by the Windows companion. */
export const BONJOUR_SERVICE_TYPE = '_localdrop._tcp';

/** TCP port the Windows companion's HTTP server listens on by default. */
export const DEFAULT_PORT = 47821;

/**
 * Bumped whenever the request/response shapes change in a non-backwards-compatible way.
 * The phone refuses to talk to a server whose major version differs.
 */
export const PROTOCOL_VERSION = 1;

/** Human readable app version, reported in `/api/health`. */
export const APP_VERSION = '1.0.0';

/** Product name used in discovery, the Windows UI and the Bonjour TXT record. */
export const PRODUCT_NAME = 'LocalDrop';

/** All HTTP routes live under this prefix. */
export const API_PREFIX = '/api';

/**
 * Size of the chunks the phone reads from a `PHAssetResource` when materialising a
 * file on disk before upload. Chosen to stay well inside the iOS memory budget while
 * keeping syscall overhead low: 1 MiB.
 */
export const STREAM_CHUNK_SIZE = 1024 * 1024;

/**
 * Upper bound on the number of asset identifiers sent in a single
 * `POST /api/assets/status` request. Keeps request bodies small and predictable.
 */
export const MAX_STATUS_QUERY_IDS = 500;

/** Number of transfer retries before a file is marked permanently failed. */
export const MAX_TRANSFER_ATTEMPTS = 3;

/** Base delay for exponential backoff between transfer retries, in milliseconds. */
export const RETRY_BASE_DELAY_MS = 1000;

/** Duration of a generated pairing verification code, in milliseconds. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Number of digits in a pairing verification code. */
export const PAIRING_CODE_LENGTH = 6;

/**
 * How often the phone re-announces itself / re-probes a known PC that has dropped off.
 */
export const DISCOVERY_RETRY_INTERVAL_MS = 5000;
