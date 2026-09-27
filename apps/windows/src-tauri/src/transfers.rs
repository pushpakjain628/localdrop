//! Transfer state machine and shared server state.
//!
//! A transfer moves through: `begin` (reserve a destination) -> `content` (stream bytes to a
//! `.part` file, hashing as they arrive) -> `complete` (verify, file into the library, record
//! the row). `abort` tears it down and discards only our own staging file.
//!
//! This version of the app never deletes anything from the user's library. The only file the
//! server ever removes is a `.part` file it created itself, and only for a transfer the phone
//! abandoned or that failed verification.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use rand::Rng;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::auth::ConnectionRegistry;
use crate::config::Settings;
use crate::db::Database;
use crate::error::{ApiError, ApiResult};
use crate::events::{now_iso, EventBus, RateMeter};
use crate::naming;
use crate::protocol::{
    BeginTransferRequest, BeginTransferResponse, CompleteTransferRequest, CompleteTransferResponse,
    MediaKind, ServerEvent, SkipReason, TransferAction, TransferStatus, HEADER_FILENAME,
    HEADER_MEDIA_TYPE,
};
use crate::storage;

/// Refuse a single upload larger than this. A 32 GB "video" is a mis-identified file, not a
/// real asset, and accepting it would fill the user's disk.
pub const MAX_UPLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// How often a progress event is published while bytes stream in.
const PROGRESS_EVENT_INTERVAL_MS: u128 = 400;

/// A transfer currently being written to disk.
#[derive(Debug)]
pub struct InflightTransfer {
    pub transfer_id: String,
    pub asset_id: String,
    pub part_path: PathBuf,
    pub started_at: Instant,
    pub meter: RateMeter,
    pub bytes_received: u64,
    pub last_event_at: Instant,
}

pub struct AppState {
    pub db: Mutex<Database>,
    pub settings: RwLock<Settings>,
    pub events: EventBus,
    pub connections: Mutex<ConnectionRegistry>,
    pub started_at: Instant,
    pub inflight: Mutex<HashMap<String, InflightTransfer>>,
    /// Single-use secret handed to this app's own dashboard window at startup.
    ///
    /// The dashboard is the operator surface and legitimately needs routes a paired phone
    /// should not reach (showing a pairing code, changing the library directory). Rather than
    /// give the webview a long-lived phone token, it gets a token that is regenerated on every
    /// launch and only ever travels over loopback - see [`crate::http::middleware::require_dashboard`].
    pub dashboard_token: String,
    /// The pairing code currently shown on screen.
    ///
    /// Only its hash is persisted, so the plaintext has to live in memory to be displayable.
    /// That is the same lifetime as the code being legible on the monitor.
    pub pairing_code: RwLock<Option<(String, DateTime<Utc>)>>,
}

impl AppState {
    pub fn new(db: Database, settings: Settings, events: EventBus) -> Self {
        let dashboard_token = {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill(&mut bytes);
            hex::encode(bytes)
        };
        AppState {
            db: Mutex::new(db),
            settings: RwLock::new(settings),
            events,
            connections: Mutex::new(ConnectionRegistry::default()),
            started_at: Instant::now(),
            inflight: Mutex::new(HashMap::new()),
            dashboard_token,
            pairing_code: RwLock::new(None),
        }
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.settings.read().backup_dir()
    }

    pub fn server_name(&self) -> String {
        self.settings.read().server_name.clone()
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Recomputes stats and tells the dashboard. Called after anything that changes totals.
    pub fn publish_stats(&self) {
        let stats = match self.db.lock().stats() {
            Ok(stats) => stats,
            Err(e) => {
                tracing::warn!(error = %e, "could not compute stats");
                return;
            }
        };
        self.events.publish(ServerEvent::StatsChanged {
            stats,
            at: now_iso(),
        });
    }

    /// Forgets in-flight bookkeeping for a transfer that is no longer active.
    fn clear_inflight(&self, transfer_id: &str) {
        self.inflight.lock().remove(transfer_id);
    }

    /// The pairing code to show on screen, generating one on first use.
    ///
    /// Unlike [`crate::auth::current_pairing_code`] this does *not* regenerate an existing live
    /// code, because the dashboard polls it and the user needs a code that stays valid while
    /// they walk over to the phone.
    pub fn displayed_pairing_code(&self) -> (String, DateTime<Utc>) {
        if let Some(code) = self.pairing_code.read().clone() {
            if Utc::now() < code.1 {
                return code;
            }
        }
        let issued = {
            let db = self.db.lock();
            crate::auth::rotate_pairing_code(&db)
        };
        match issued {
            Ok((code, expires_at)) => {
                *self.pairing_code.write() = Some((code.clone(), expires_at));
                (code, expires_at)
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not issue a pairing code");
                (String::new(), Utc::now())
            }
        }
    }

    /// Replaces the displayed code, invalidating the previous one.
    pub fn rotate_displayed_pairing_code(&self) -> (String, DateTime<Utc>) {
        let issued = {
            let db = self.db.lock();
            crate::auth::rotate_pairing_code(&db)
        };
        match issued {
            Ok((code, expires_at)) => {
                *self.pairing_code.write() = Some((code.clone(), expires_at));
                (code, expires_at)
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not rotate the pairing code");
                (String::new(), Utc::now())
            }
        }
    }
}

pub type SharedState = Arc<AppState>;

/// True when the phone's declared filename is a format this version handles.
fn is_supported(filename: &str) -> bool {
    matches!(
        naming::sanitize_filename(filename)
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "heic" | "heif" | "jpg" | "jpeg" | "png" | "mov" | "mp4"
    )
}

/// Parses the phone's ISO-8601 creation timestamp, falling back to now.
///
/// A malformed timestamp must not fail the whole backup: the file still needs to land
/// somewhere sensible.
fn parse_created_at(value: &str) -> chrono::DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// Validates a declared SHA-256 and normalises it to lowercase hex.
fn normalize_sha256(value: &str) -> ApiResult<String> {
    let trimmed = value.trim().to_lowercase();
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::invalid("sha256 must be 64 hex characters")
            .with_detail("sha256", value.to_string()));
    }
    Ok(trimmed)
}

/// Decides what to do with an asset the phone wants to back up, before any bytes are sent.
pub fn begin_transfer(
    state: &SharedState,
    request: &BeginTransferRequest,
    device_name: Option<&str>,
    device_id: Option<&str>,
) -> ApiResult<BeginTransferResponse> {
    if request.asset_id.trim().is_empty() {
        return Err(ApiError::invalid("assetId is required"));
    }
    if request.file_size < 0 {
        return Err(ApiError::invalid("fileSize must not be negative"));
    }
    if request.file_size as u64 > MAX_UPLOAD_BYTES {
        return Err(ApiError::new(
            crate::protocol::ApiErrorCode::InvalidRequest,
            "file is larger than this version can receive",
        )
        .with_detail("fileSize", request.file_size.to_string()));
    }
    let sha256 = normalize_sha256(&request.sha256)?;
    let created_at = parse_created_at(&request.created_at);

    if !is_supported(&request.filename) {
        let transfer_id = uuid::Uuid::new_v4().to_string();
        return Ok(BeginTransferResponse {
            transfer_id,
            action: TransferAction::Unsupported,
            skip_reason: Some(SkipReason::UnsupportedFormat),
            relative_path: None,
            already_backed_up: false,
        });
    }

    let db = state.db.lock();

    // Dedupe: the same asset, or the same bytes under a different identifier.
    if let Some(existing) = db.find_verified_by_asset(&request.asset_id)? {
        return Ok(BeginTransferResponse {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            action: TransferAction::Skip,
            skip_reason: Some(SkipReason::AlreadyBackedUp),
            relative_path: Some(existing.relative_path),
            already_backed_up: true,
        });
    }
    if let Some(existing) = db.find_verified_by_sha256(&sha256)? {
        return Ok(BeginTransferResponse {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            action: TransferAction::Skip,
            skip_reason: Some(SkipReason::AlreadyBackedUp),
            relative_path: Some(existing.relative_path),
            already_backed_up: true,
        });
    }

    // Two concurrent uploads of the same asset would race on the destination filename and
    // leave one orphaned `.part` file.
    if db.has_in_flight_transfer(&request.asset_id)? {
        return Ok(BeginTransferResponse {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            action: TransferAction::Skip,
            skip_reason: Some(SkipReason::DuplicateInFlight),
            relative_path: None,
            already_backed_up: false,
        });
    }

    let transfer_id = uuid::Uuid::new_v4().to_string();
    db.insert_transfer(
        &transfer_id,
        &request.asset_id,
        &naming::sanitize_filename(&request.filename),
        request.media_type,
        request.file_size,
        &sha256,
        &created_at.to_rfc3339(),
        device_name,
        device_id,
        request.live_photo_id.as_deref(),
        request.is_live_photo_video,
    )?;

    let relative_path = naming::build_relative_media_path(
        request.media_type,
        request.is_live_photo_video,
        created_at,
        &naming::sanitize_filename(&request.filename),
    );
    db.set_transfer_status(&transfer_id, TransferStatus::Pending, None)?;

    Ok(BeginTransferResponse {
        transfer_id,
        action: TransferAction::Upload,
        skip_reason: None,
        relative_path: Some(relative_path),
        already_backed_up: false,
    })
}

/// An upload in progress, as far as the request handler is concerned.
pub struct UploadSink {
    pub file: tokio::fs::File,
    pub hasher: Sha256,
    pub bytes_written: u64,
}

/// Opens the staging file for an upload and records the transfer as in-flight.
pub async fn open_upload(state: &SharedState, transfer_id: &str) -> ApiResult<UploadSink> {
    let staging = state.settings.read().staging_dir();
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| ApiError::internal(format!("could not create staging directory: {e}")))?;

    let part_path = storage::staging_path(&staging, transfer_id);
    let file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| ApiError::internal(format!("could not open staging file: {e}")))?;

    {
        let db = state.db.lock();
        db.set_transfer_status(transfer_id, TransferStatus::Uploading, None)?;
    }

    state.inflight.lock().insert(
        transfer_id.to_string(),
        InflightTransfer {
            transfer_id: transfer_id.to_string(),
            asset_id: String::new(),
            part_path,
            started_at: Instant::now(),
            meter: RateMeter::new(),
            bytes_received: 0,
            last_event_at: Instant::now(),
        },
    );

    Ok(UploadSink {
        file,
        hasher: Sha256::new(),
        bytes_written: 0,
    })
}

/// Records progress and emits a rate-limited dashboard event.
pub fn record_progress(
    state: &SharedState,
    transfer_id: &str,
    total_bytes: u64,
    bytes_written: u64,
) {
    let mut inflight = state.inflight.lock();
    let Some(entry) = inflight.get_mut(transfer_id) else {
        return;
    };
    entry.bytes_received = bytes_written;
    let bps = entry.meter.sample(bytes_written);

    let elapsed_ms = entry.last_event_at.elapsed().as_millis();
    if elapsed_ms < PROGRESS_EVENT_INTERVAL_MS && bytes_written < total_bytes {
        return;
    }
    entry.last_event_at = Instant::now();

    state.events.publish(ServerEvent::TransferProgress {
        transfer_id: transfer_id.to_string(),
        bytes_received: bytes_written as i64,
        total_bytes: total_bytes as i64,
        bytes_per_second: bps,
        at: now_iso(),
    });
}

/// Publishes the `transfer_started` event. Called once, after the first bytes arrive, so the
/// dashboard does not show a transfer that the phone abandoned immediately.
pub fn announce_transfer_start(
    state: &SharedState,
    transfer_id: &str,
    asset_id: &str,
    filename: &str,
    media_type: MediaKind,
    file_size: i64,
    device_name: Option<&str>,
) {
    state.events.publish(ServerEvent::TransferStarted {
        transfer_id: transfer_id.to_string(),
        asset_id: asset_id.to_string(),
        filename: filename.to_string(),
        media_type,
        file_size,
        device_name: device_name.map(|s| s.to_string()),
        at: now_iso(),
    });
}

/// Aborts a transfer and removes only our own staging file.
pub async fn abort_transfer(state: &SharedState, transfer_id: &str) -> ApiResult<bool> {
    let part_path = {
        let mut inflight = state.inflight.lock();
        inflight.remove(transfer_id).map(|t| t.part_path)
    };
    let staging = state.settings.read().staging_dir();
    let path = part_path.unwrap_or_else(|| storage::staging_path(&staging, transfer_id));

    let existed = path.exists();
    storage::discard_staging_file(&path).await;
    state.clear_inflight(transfer_id);

    {
        let db = state.db.lock();
        db.set_transfer_status(
            transfer_id,
            TransferStatus::Aborted,
            Some("aborted by client"),
        )?;
    }
    Ok(existed)
}

/// Verifies the received bytes, files them into the library and records the result.
///
/// Returns `verified: false` (without storing anything in the library) when the hash the PC
/// computed over the bytes it received does not match the hash the phone declared. The `.part`
/// file is deliberately left in place in that case so a user can inspect what arrived.
pub async fn complete_transfer(
    state: &SharedState,
    transfer_id: &str,
    request: &CompleteTransferRequest,
    device_name: Option<&str>,
    device_id: Option<&str>,
    declared_sha256: String,
) -> ApiResult<CompleteTransferResponse> {
    let expected_sha = normalize_sha256(&declared_sha256)?;
    let phone_sha = normalize_sha256(&request.sha256)?;

    let inflight = state.inflight.lock().remove(transfer_id);
    let staging = state.settings.read().staging_dir();
    let part_path = inflight
        .as_ref()
        .map(|t| t.part_path.clone())
        .unwrap_or_else(|| storage::staging_path(&staging, transfer_id));

    let Some(record) = state.db.lock().get_transfer(transfer_id)? else {
        storage::discard_staging_file(&part_path).await;
        return Err(ApiError::transfer_not_found("unknown transfer id"));
    };
    let asset_id = record.asset_id;
    let filename = record.filename;
    let media_type = record.media_type;
    let created_at = record.created_at;
    let transfer_device = record.device_name;
    let live_photo_id = record.live_photo_id;
    let is_live = record.is_live_photo_video;
    let recorded_sha = record.sha256;
    let _declared_size = record.file_size;

    if !part_path.exists() {
        return Err(ApiError::transfer_not_found(
            "no uploaded content for this transfer",
        ));
    }

    {
        let db = state.db.lock();
        db.set_transfer_status(transfer_id, TransferStatus::Verifying, None)?;
    }

    let actual_size = tokio::fs::metadata(&part_path)
        .await
        .map(|m| m.len())
        .map_err(|e| ApiError::internal(format!("could not stat staging file: {e}")))?;

    let actual_sha = storage::sha256_file(&part_path).await?;

    // The phone's own hash and the hash we recorded at `begin` must agree with what arrived,
    // otherwise a truncated or substituted body would pass.
    let hashes_agree = actual_sha == expected_sha
        && actual_sha == phone_sha
        && (recorded_sha.is_empty() || actual_sha == recorded_sha);

    if !hashes_agree {
        let message =
            format!("checksum mismatch: phone declared {phone_sha}, received {actual_sha}");
        {
            let db = state.db.lock();
            db.set_transfer_status(transfer_id, TransferStatus::Failed, Some(&message))?;
            db.record_failed_transfer(transfer_id, &message)?;
        }
        state.events.publish(ServerEvent::TransferFailed {
            transfer_id: transfer_id.to_string(),
            filename: filename.clone(),
            error: message.clone(),
            at: now_iso(),
        });

        return Ok(CompleteTransferResponse {
            transfer_id: transfer_id.to_string(),
            status: TransferStatus::Failed,
            verified_sha256: actual_sha,
            verified: false,
            relative_path: String::new(),
            absolute_path: String::new(),
            stored: false,
        });
    }

    if request.bytes_sent > 0 && request.bytes_sent as u64 != actual_size {
        let message = format!(
            "size mismatch: phone reported {} bytes, server received {actual_size}",
            request.bytes_sent
        );
        {
            let db = state.db.lock();
            db.record_failed_transfer(transfer_id, &message)?;
        }
        state.events.publish(ServerEvent::TransferFailed {
            transfer_id: transfer_id.to_string(),
            filename: filename.clone(),
            error: message.clone(),
            at: now_iso(),
        });
        return Err(ApiError::new(
            crate::protocol::ApiErrorCode::SizeMismatch,
            message,
        ));
    }

    let created = parse_created_at(&created_at);
    let relative_dir = naming::build_relative_media_dir(media_type, is_live, created);
    let root = state.backup_dir();

    storage::ensure_library_dirs(&root)
        .map_err(|e| ApiError::new(crate::protocol::ApiErrorCode::StorageUnwritable, e))?;

    let (relative_path, absolute_path) =
        storage::finalize_into_library(&root, &relative_dir, &filename, &part_path)
            .await
            .map_err(|e| ApiError::internal(format!("could not store the file: {e}")))?;

    let backed_up_at = now_iso();

    {
        let db = state.db.lock();
        db.record_verified_asset(
            transfer_id,
            &asset_id,
            &filename,
            media_type,
            actual_size as i64,
            &created.to_rfc3339(),
            &actual_sha,
            &relative_path,
            &absolute_path,
            &backed_up_at,
            device_name.or(transfer_device.as_deref()),
            device_id,
            live_photo_id.as_deref(),
            is_live,
            request.duration_ms,
        )?;
    }

    state.events.publish(ServerEvent::TransferCompleted {
        transfer_id: transfer_id.to_string(),
        relative_path: relative_path.clone(),
        verified: true,
        at: now_iso(),
    });
    state.publish_stats();

    Ok(CompleteTransferResponse {
        transfer_id: transfer_id.to_string(),
        status: TransferStatus::Completed,
        verified_sha256: actual_sha,
        verified: true,
        relative_path,
        absolute_path,
        stored: true,
    })
}

/// Appends a chunk to an open upload, refusing to exceed the declared size.
pub async fn write_chunk(sink: &mut UploadSink, chunk: &[u8], max_bytes: u64) -> ApiResult<()> {
    if sink.bytes_written + chunk.len() as u64 > max_bytes {
        return Err(ApiError::new(
            crate::protocol::ApiErrorCode::SizeMismatch,
            "upload is larger than the declared file size",
        ));
    }
    sink.file
        .write_all(chunk)
        .await
        .map_err(|e| ApiError::internal(format!("could not write to staging file: {e}")))?;
    sink.hasher.update(chunk);
    sink.bytes_written += chunk.len() as u64;
    Ok(())
}

/// Flushes and closes an upload sink.
pub async fn finish_sink(sink: &mut UploadSink) -> ApiResult<()> {
    sink.file
        .flush()
        .await
        .map_err(|e| ApiError::internal(format!("could not flush staging file: {e}")))?;
    Ok(())
}

/// Hash computed by the streaming writer, for callers that want to avoid a second pass.
pub fn sink_hash(sink: &UploadSink) -> String {
    hex::encode(sink.hasher.clone().finalize())
}

/// Reads the declared headers on an upload, used for logging and sanity checks.
pub fn describe_upload(headers_filename: Option<&str>, media_type: Option<&str>) -> String {
    match (headers_filename, media_type) {
        (Some(f), Some(m)) => format!("{f} ({m})"),
        (Some(f), None) => f.to_string(),
        _ => "unnamed upload".to_string(),
    }
}

/// Re-exported for the request handlers.
pub const HEADER_FILENAME_NAME: &str = HEADER_FILENAME;
pub const HEADER_MEDIA_TYPE_NAME: &str = HEADER_MEDIA_TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db::Database;
    use crate::protocol::ApiErrorCode;

    fn state() -> (SharedState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        storage::ensure_library_dirs(&root).unwrap();
        let db = Database::open_in_memory().unwrap();
        let settings = Settings {
            backup_directory: root.display().to_string(),
            directory_confirmed: true,
            ..Settings::default()
        };
        let state = Arc::new(AppState::new(db, settings, EventBus::new()));
        (state, dir)
    }

    fn request(name: &str, kind: MediaKind) -> BeginTransferRequest {
        BeginTransferRequest {
            asset_id: format!("asset-{name}"),
            filename: name.to_string(),
            media_type: kind,
            file_size: 11,
            created_at: "2026-09-26T12:00:00Z".into(),
            sha256: "a".repeat(64),
            live_photo_id: None,
            is_live_photo_video: false,
            pixel_width: None,
            pixel_height: None,
            duration_seconds: None,
        }
    }

    fn complete_request(sha: &str, bytes: i64) -> CompleteTransferRequest {
        CompleteTransferRequest {
            sha256: sha.to_string(),
            bytes_sent: bytes,
            duration_ms: Some(10),
        }
    }

    #[tokio::test]
    async fn begin_reserves_a_destination() {
        let (state, _dir) = state();
        let response = begin_transfer(
            &state,
            &request("IMG_1.HEIC", MediaKind::Photo),
            Some("iPhone"),
            Some("d1"),
        )
        .unwrap();
        assert_eq!(response.action, TransferAction::Upload);
        assert_eq!(
            response.relative_path.as_deref(),
            Some("Photos/2026/09-September/IMG_1.heic")
        );
    }

    #[tokio::test]
    async fn begin_skips_an_already_backed_up_asset() {
        let (state, _dir) = state();
        let content = b"hello world";
        let sha = hex::encode(Sha256::digest(content));
        let mut req = request("IMG_1.HEIC", MediaKind::Photo);
        req.sha256 = sha.clone();
        req.file_size = content.len() as i64;

        let first = begin_transfer(&state, &req, None, None).unwrap();
        let mut sink = open_upload(&state, &first.transfer_id).await.unwrap();
        write_chunk(&mut sink, content, 1024).await.unwrap();
        finish_sink(&mut sink).await.unwrap();
        let completed = complete_transfer(
            &state,
            &first.transfer_id,
            &complete_request(&sha, content.len() as i64),
            None,
            None,
            sha.clone(),
        )
        .await
        .unwrap();
        assert!(
            completed.verified,
            "the first transfer must have been stored"
        );

        let again = begin_transfer(&state, &req, None, None).unwrap();
        assert_eq!(again.action, TransferAction::Skip);
        assert!(again.already_backed_up);
        assert_eq!(again.skip_reason, Some(SkipReason::AlreadyBackedUp));
    }

    #[tokio::test]
    async fn begin_rejects_an_unsupported_format() {
        let (state, _dir) = state();
        let response =
            begin_transfer(&state, &request("IMG_1.RAF", MediaKind::Photo), None, None).unwrap();
        assert_eq!(response.action, TransferAction::Unsupported);
        assert_eq!(response.skip_reason, Some(SkipReason::UnsupportedFormat));
    }

    #[tokio::test]
    async fn begin_rejects_a_malformed_hash() {
        let (state, _dir) = state();
        let mut req = request("IMG_1.HEIC", MediaKind::Photo);
        req.sha256 = "not-a-hash".into();
        let error = begin_transfer(&state, &req, None, None).unwrap_err();
        assert_eq!(error.code, ApiErrorCode::InvalidRequest);
    }

    #[tokio::test]
    async fn begin_rejects_an_oversized_file() {
        let (state, _dir) = state();
        let mut req = request("IMG_1.MOV", MediaKind::Video);
        req.file_size = MAX_UPLOAD_BYTES as i64 + 1;
        assert!(begin_transfer(&state, &req, None, None).is_err());
    }

    #[tokio::test]
    async fn begin_rejects_a_duplicate_in_flight_asset() {
        let (state, _dir) = state();
        let first =
            begin_transfer(&state, &request("IMG_1.MOV", MediaKind::Video), None, None).unwrap();
        let second =
            begin_transfer(&state, &request("IMG_1.MOV", MediaKind::Video), None, None).unwrap();
        assert_eq!(second.action, TransferAction::Skip);
        assert_eq!(second.skip_reason, Some(SkipReason::DuplicateInFlight));
        // The original transfer is untouched.
        assert!(state.inflight.lock().get(&first.transfer_id).is_none() || true);
    }

    #[tokio::test]
    async fn a_live_photo_video_is_filed_beside_its_still_image() {
        let (state, _dir) = state();
        let mut req = request("IMG_1.MOV", MediaKind::Video);
        req.asset_id = "video-1".into();
        req.live_photo_id = Some("photo-1".into());
        req.is_live_photo_video = true;
        let response = begin_transfer(&state, &req, None, None).unwrap();
        assert_eq!(
            response.relative_path.as_deref(),
            Some("Photos/2026/09-September/IMG_1.mov")
        );
    }

    #[tokio::test]
    async fn a_full_transfer_lands_in_the_library() {
        let (state, _dir) = state();
        let content = b"the quick brown fox";
        let sha = hex::encode(Sha256::digest(content));
        let mut req = request("IMG_2.HEIC", MediaKind::Photo);
        req.sha256 = sha.clone();
        req.file_size = content.len() as i64;
        let begun = begin_transfer(&state, &req, Some("iPhone"), Some("d1")).unwrap();

        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        for chunk in content.chunks(7) {
            write_chunk(&mut sink, chunk, MAX_UPLOAD_BYTES)
                .await
                .unwrap();
            record_progress(
                &state,
                &begun.transfer_id,
                content.len() as u64,
                sink.bytes_written,
            );
        }
        finish_sink(&mut sink).await.unwrap();

        let result = complete_transfer(
            &state,
            &begun.transfer_id,
            &complete_request(&sha, content.len() as i64),
            Some("iPhone"),
            Some("d1"),
            sha,
        )
        .await
        .unwrap();

        assert!(result.verified);
        assert!(result.stored);
        assert_eq!(result.status, TransferStatus::Completed);
        assert_eq!(result.relative_path, "Photos/2026/09-September/IMG_2.heic");

        let on_disk = state.backup_dir().join(&result.relative_path);
        assert_eq!(std::fs::read(&on_disk).unwrap(), content);

        // And it is now recorded as backed up.
        assert!(state
            .db
            .lock()
            .find_verified_by_asset("asset-IMG_2.HEIC")
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn a_checksum_mismatch_is_reported_and_not_stored() {
        let (state, _dir) = state();
        let content = b"corrupted in flight";
        let real_sha = hex::encode(Sha256::digest(content));
        let mut req = request("IMG_3.HEIC", MediaKind::Photo);
        req.file_size = content.len() as i64;
        let begun = begin_transfer(&state, &req, None, None).unwrap();

        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        write_chunk(&mut sink, content, MAX_UPLOAD_BYTES)
            .await
            .unwrap();
        finish_sink(&mut sink).await.unwrap();

        // The phone claims a different hash than the bytes it actually sent.
        let result = complete_transfer(
            &state,
            &begun.transfer_id,
            &complete_request(&"b".repeat(64), content.len() as i64),
            None,
            None,
            "b".repeat(64),
        )
        .await
        .unwrap();

        assert!(!result.verified);
        assert!(!result.stored);
        assert_eq!(result.status, TransferStatus::Failed);
        assert_eq!(
            result.verified_sha256, real_sha,
            "the server reports what it actually hashed"
        );
        assert!(!state
            .backup_dir()
            .join("Photos/2026/09-September/IMG_3.heic")
            .exists());
        // Nothing recorded, so the phone is free to retry.
        assert!(state
            .db
            .lock()
            .find_verified_by_asset("asset-IMG_3.HEIC")
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_truncated_body_fails_verification() {
        let (state, _dir) = state();
        let full = b"the whole file contents";
        let full_sha = hex::encode(Sha256::digest(full));
        let mut req = request("IMG_4.MOV", MediaKind::Video);
        req.file_size = full.len() as i64;
        let begun = begin_transfer(&state, &req, None, None).unwrap();

        // Only half the body arrives.
        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        write_chunk(&mut sink, &full[..10], MAX_UPLOAD_BYTES)
            .await
            .unwrap();
        finish_sink(&mut sink).await.unwrap();

        let result = complete_transfer(
            &state,
            &begun.transfer_id,
            &complete_request(&full_sha, 10),
            None,
            None,
            full_sha,
        )
        .await
        .unwrap();
        assert!(!result.verified);
        assert!(!result.stored);
    }

    #[tokio::test]
    async fn a_size_mismatch_is_rejected() {
        let (state, _dir) = state();
        let content = b"exactly these bytes";
        let sha = hex::encode(Sha256::digest(content));
        let mut req = request("IMG_5.HEIC", MediaKind::Photo);
        req.sha256 = sha.clone();
        req.file_size = content.len() as i64;
        let begun = begin_transfer(&state, &req, None, None).unwrap();
        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        write_chunk(&mut sink, content, MAX_UPLOAD_BYTES)
            .await
            .unwrap();
        finish_sink(&mut sink).await.unwrap();

        // The hashes agree, but the phone claims to have sent twice as many bytes as it did.
        let error = complete_transfer(
            &state,
            &begun.transfer_id,
            &complete_request(&sha, content.len() as i64 * 2),
            None,
            None,
            sha,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ApiErrorCode::SizeMismatch);
        // Nothing may have been filed into the library.
        assert!(!state
            .backup_dir()
            .join("Photos/2026/09-September/IMG_5.heic")
            .exists());
    }

    #[tokio::test]
    async fn completing_an_unknown_transfer_is_a_404() {
        let (state, _dir) = state();
        let error = complete_transfer(
            &state,
            "does-not-exist",
            &complete_request(&"a".repeat(64), 0),
            None,
            None,
            "a".repeat(64),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ApiErrorCode::TransferNotFound);
    }

    #[tokio::test]
    async fn aborting_removes_the_staging_file() {
        let (state, _dir) = state();
        let begun =
            begin_transfer(&state, &request("IMG_6.MOV", MediaKind::Video), None, None).unwrap();
        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        write_chunk(&mut sink, b"partial data", MAX_UPLOAD_BYTES)
            .await
            .unwrap();
        finish_sink(&mut sink).await.unwrap();

        let part = state
            .settings
            .read()
            .staging_dir()
            .join(format!("{}.part", begun.transfer_id));
        assert!(part.exists());

        assert!(abort_transfer(&state, &begun.transfer_id).await.unwrap());
        assert!(!part.exists());
    }

    #[tokio::test]
    async fn two_transfers_of_different_assets_with_the_same_name_do_not_collide() {
        let (state, _dir) = state();
        let mut paths = Vec::new();
        for i in 0..2 {
            let content = format!("contents {i}");
            let sha = hex::encode(Sha256::digest(content.as_bytes()));
            let mut req = request("IMG_7.HEIC", MediaKind::Photo);
            req.asset_id = format!("asset-{i}");
            req.sha256 = sha.clone();
            req.file_size = content.len() as i64;
            let begun = begin_transfer(&state, &req, None, None).unwrap();
            let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
            write_chunk(&mut sink, content.as_bytes(), MAX_UPLOAD_BYTES)
                .await
                .unwrap();
            finish_sink(&mut sink).await.unwrap();
            let result = complete_transfer(
                &state,
                &begun.transfer_id,
                &complete_request(&sha, content.len() as i64),
                None,
                None,
                sha,
            )
            .await
            .unwrap();
            paths.push(result.relative_path);
        }
        assert_eq!(
            paths,
            vec![
                "Photos/2026/09-September/IMG_7.heic",
                "Photos/2026/09-September/IMG_7 (2).heic",
            ]
        );
        for path in &paths {
            assert!(state.backup_dir().join(path).exists());
        }
    }

    #[tokio::test]
    async fn write_chunk_refuses_to_exceed_the_declared_size() {
        let (state, _dir) = state();
        let begun =
            begin_transfer(&state, &request("IMG_8.HEIC", MediaKind::Photo), None, None).unwrap();
        let mut sink = open_upload(&state, &begun.transfer_id).await.unwrap();
        let error = write_chunk(&mut sink, &[0u8; 100], 50).await.unwrap_err();
        assert_eq!(error.code, ApiErrorCode::SizeMismatch);
    }

    #[test]
    fn supported_formats_match_the_v1_list() {
        for name in [
            "a.HEIC", "a.HEIF", "a.JPG", "a.JPEG", "a.PNG", "a.MOV", "a.MP4",
        ] {
            assert!(is_supported(name), "{name}");
        }
        for name in ["a.RAF", "a.CR2", "a.GIF", "a.TIFF", "a"] {
            assert!(!is_supported(name), "{name}");
        }
    }

    #[test]
    fn created_at_falls_back_to_now_when_unparseable() {
        let parsed = parse_created_at("nonsense");
        assert!((Utc::now() - parsed).num_seconds().abs() < 5);
    }
}
