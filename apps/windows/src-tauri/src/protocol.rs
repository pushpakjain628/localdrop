//! Wire protocol types.
//!
//! This is a hand-maintained mirror of `packages/shared/src/protocol.ts`. The two must stay
//! in lock-step; `protocol_version` is checked at runtime so a stale phone is rejected with a
//! clear error rather than a confusing deserialisation failure. Field names use `camelCase` via
//! serde's `rename_all` so the JSON on the wire matches the TypeScript definitions exactly.

use serde::{Deserialize, Serialize};

/// Kept in lock-step with `PROTOCOL_VERSION` in `packages/shared/src/constants.ts`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Kept in lock-step with `DEFAULT_PORT`.
pub const DEFAULT_PORT: u16 = 47821;

/// Kept in lock-step with `APP_VERSION`.
pub const APP_VERSION: &str = "1.0.0";

/// Kept in lock-step with `PRODUCT_NAME`.
pub const PRODUCT_NAME: &str = "LocalDrop";

/// All routes are nested under this prefix. Kept in lock-step with `API_PREFIX`.
pub const API_PREFIX: &str = "/api";

/// Kept in lock-step with `MAX_STATUS_QUERY_IDS`.
pub const MAX_STATUS_QUERY_IDS: usize = 500;

/// Kept in lock-step with `PAIRING_CODE_LENGTH`.
pub const PAIRING_CODE_LENGTH: usize = 6;

/// Kept in lock-step with `PAIRING_CODE_TTL_MS`.
pub const PAIRING_CODE_TTL_MS: i64 = 5 * 60 * 1000;

/// Header carrying the protocol version on every request.
pub const API_VERSION_HEADER: &str = "x-localdrop-protocol";

pub const HEADER_FILENAME: &str = "x-localdrop-filename";
pub const HEADER_SHA256: &str = "x-localdrop-sha256";
pub const HEADER_MEDIA_TYPE: &str = "x-localdrop-media-type";

/// `MediaKind` in the TypeScript contract. Serialised as `"photo"` / `"video"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Photo,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Photo => "photo",
            MediaKind::Video => "video",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "photo" => Some(MediaKind::Photo),
            "video" => Some(MediaKind::Video),
            _ => None,
        }
    }
}

/// `TransferStatus` in the TypeScript contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Pending,
    Uploading,
    Verifying,
    Completed,
    Skipped,
    Failed,
    Aborted,
}

impl TransferStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferStatus::Pending => "pending",
            TransferStatus::Uploading => "uploading",
            TransferStatus::Verifying => "verifying",
            TransferStatus::Completed => "completed",
            TransferStatus::Skipped => "skipped",
            TransferStatus::Failed => "failed",
            TransferStatus::Aborted => "aborted",
        }
    }
}

/// `TransferAction` in the TypeScript contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferAction {
    Upload,
    Skip,
    Unsupported,
}

/// Why `begin` decided the asset did not need uploading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    AlreadyBackedUp,
    DuplicateInFlight,
    UnsupportedFormat,
}

/* ---------------------------------------------------------------- health / pairing */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub product: String,
    pub version: String,
    pub protocol_version: u32,
    pub server_id: String,
    pub server_name: String,
    pub paired: bool,
    pub backup_directory: String,
    pub storage_writable: bool,
    pub free_space_bytes: Option<u64>,
    pub uptime_seconds: u64,
    /// This PC's LAN addresses, so the dashboard can show an address the user can type into
    /// their phone when mDNS discovery is blocked. Manual entry is the documented fallback, and
    /// it was unusable without this: the phone's help text points at the address in the top bar
    /// and there was nothing there.
    pub lan_addresses: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub protocol_version: u32,
    pub device_name: String,
    pub device_id: String,
    pub os_version: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub token: String,
    pub server_id: String,
    pub server_name: String,
    pub backup_directory: String,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotatePairingCodeResponse {
    pub code: String,
    pub expires_at: i64,
}

/* ---------------------------------------------------------------- asset state */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatusRequest {
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatusResponse {
    pub backed_up_asset_ids: Vec<String>,
}

/* ---------------------------------------------------------------- transfers */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginTransferRequest {
    pub asset_id: String,
    pub filename: String,
    pub media_type: MediaKind,
    pub file_size: i64,
    pub created_at: String,
    pub sha256: String,
    #[serde(default)]
    pub live_photo_id: Option<String>,
    #[serde(default)]
    pub is_live_photo_video: bool,
    #[serde(default)]
    pub pixel_width: Option<i64>,
    #[serde(default)]
    pub pixel_height: Option<i64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginTransferResponse {
    pub transfer_id: String,
    pub action: TransferAction,
    pub skip_reason: Option<SkipReason>,
    pub relative_path: Option<String>,
    pub already_backed_up: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteTransferRequest {
    pub sha256: String,
    pub bytes_sent: i64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteTransferResponse {
    pub transfer_id: String,
    pub status: TransferStatus,
    pub verified_sha256: String,
    pub verified: bool,
    pub relative_path: String,
    pub absolute_path: String,
    pub stored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortTransferResponse {
    pub transfer_id: String,
    pub aborted: bool,
}

/* ---------------------------------------------------------------- history & stats */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub transfer_id: String,
    pub asset_id: String,
    pub filename: String,
    pub media_type: MediaKind,
    pub file_size: i64,
    pub created_at: String,
    pub sha256: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub backed_up_at: String,
    pub status: TransferStatus,
    pub device_name: Option<String>,
    pub live_photo_id: Option<String>,
    pub is_live_photo_video: bool,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResponse {
    pub entries: Vec<HistoryEntry>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total_bytes: i64,
    pub total_files: i64,
    pub photos: i64,
    pub videos: i64,
    pub bytes_last_30_days: i64,
    pub files_last_30_days: i64,
    pub failed_transfers: i64,
    pub months: Vec<MonthStat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthStat {
    pub label: String,
    pub files: i64,
    pub bytes: i64,
}

/* ---------------------------------------------------------------- settings */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBackupDirectoryRequest {
    pub directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBackupDirectoryResponse {
    pub backup_directory: String,
    pub storage_writable: bool,
    pub free_space_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettingsResponse {
    pub backup_directory: String,
    pub storage_writable: bool,
    pub free_space_bytes: Option<u64>,
    pub default_directory: String,
    pub default_directory_available: bool,
    pub suggested_directories: Vec<String>,
}

/* ---------------------------------------------------------------- live events */

/// Mirrors `ServerEvent` in the TypeScript contract. Serialised as an internally tagged enum
/// so the JSON is `{"type":"transfer_progress", ...}`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    ServerStarted {
        server_name: String,
        backup_directory: String,
        at: String,
    },
    ClientConnected {
        device_name: String,
        device_id: String,
        at: String,
    },
    ClientDisconnected {
        device_name: String,
        device_id: String,
        at: String,
    },
    TransferStarted {
        transfer_id: String,
        asset_id: String,
        filename: String,
        media_type: MediaKind,
        file_size: i64,
        device_name: Option<String>,
        at: String,
    },
    TransferProgress {
        transfer_id: String,
        bytes_received: i64,
        total_bytes: i64,
        bytes_per_second: f64,
        at: String,
    },
    TransferCompleted {
        transfer_id: String,
        relative_path: String,
        verified: bool,
        at: String,
    },
    TransferFailed {
        transfer_id: String,
        filename: String,
        error: String,
        at: String,
    },
    TransferSkipped {
        transfer_id: String,
        filename: String,
        reason: String,
        at: String,
    },
    StatsChanged {
        stats: LibraryStats,
        at: String,
    },
}

/* ---------------------------------------------------------------- errors */

/// Mirrors `ApiErrorCode` in the TypeScript contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    ProtocolMismatch,
    InvalidRequest,
    PairingFailed,
    TransferNotFound,
    TransferConflict,
    ChecksumMismatch,
    SizeMismatch,
    StorageUnwritable,
    InsufficientSpace,
    InternalError,
}

impl ApiErrorCode {
    /// HTTP status for each error code. The mapping is centralised so a handler can never
    /// accidentally return 200 with an error body.
    pub fn http_status(self) -> u16 {
        match self {
            ApiErrorCode::Unauthorized => 401,
            ApiErrorCode::Forbidden => 403,
            ApiErrorCode::NotFound => 404,
            ApiErrorCode::ProtocolMismatch | ApiErrorCode::InvalidRequest => 400,
            ApiErrorCode::PairingFailed => 403,
            ApiErrorCode::TransferNotFound => 404,
            ApiErrorCode::TransferConflict => 409,
            ApiErrorCode::ChecksumMismatch | ApiErrorCode::SizeMismatch => 422,
            ApiErrorCode::StorageUnwritable => 507,
            ApiErrorCode::InsufficientSpace => 507,
            ApiErrorCode::InternalError => 500,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorDetail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDetail {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}
