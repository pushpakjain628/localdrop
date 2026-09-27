//! Route handlers.
//!
//! Handlers stay thin: they parse input, delegate to [`crate::transfers`] /
//! [`crate::db`] / [`crate::auth`], and shape the response. All the decision logic lives in
//! those modules so it can be unit-tested without an HTTP server.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, Request, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use futures::StreamExt;
use serde::Deserialize;

use crate::auth;
use crate::error::{ApiError, ApiResult};
use crate::events::now_iso;
use crate::protocol::*;
use crate::storage;
use crate::transfers::{self, AppState, SharedState, MAX_UPLOAD_BYTES};

use super::middleware::Caller;

/* ---------------------------------------------------------------- health */

/// `GET /api/health` - unauthenticated. Deliberately reveals only what a phone needs to decide
/// whether to keep talking to this server.
pub async fn health(State(state): State<SharedState>) -> Json<HealthResponse> {
    let backup_dir = state.backup_dir();
    let storage_writable = storage::is_writable(&backup_dir);
    let server_id = state
        .db
        .lock()
        .server_id()
        .unwrap_or_else(|_| "unknown".to_string());
    let paired = auth::has_active_device(&state.db.lock()).unwrap_or(false);

    Json(HealthResponse {
        product: PRODUCT_NAME.to_string(),
        version: APP_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION,
        server_id,
        server_name: state.server_name(),
        paired,
        backup_directory: backup_dir.display().to_string(),
        storage_writable,
        free_space_bytes: storage::free_space_bytes(&backup_dir),
        uptime_seconds: state.uptime_seconds(),
    })
}

/* ---------------------------------------------------------------- pairing */

#[derive(Debug, Deserialize)]
pub struct PairBody {
    #[serde(flatten)]
    pub request: PairRequest,
    pub code: String,
}

/// `POST /api/pair` - the only other unauthenticated route.
pub async fn pair(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<PairResponse>> {
    // The version guard runs as a layer, but a handler reached directly in a test should still
    // behave, so the check is repeated here as a cheap assertion.
    let protocol_header = request
        .headers()
        .get(API_VERSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok());
    if protocol_header != Some(PROTOCOL_VERSION) {
        return Err(ApiError::new(
            ApiErrorCode::ProtocolMismatch,
            format!("this PC speaks protocol v{PROTOCOL_VERSION}"),
        ));
    }

    let bytes = axum::body::to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|e| ApiError::invalid(format!("could not read request body: {e}")))?;
    let body: PairBody = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::invalid(format!("invalid JSON body: {e}")))?;

    if body.request.protocol_version != PROTOCOL_VERSION {
        return Err(ApiError::new(
            ApiErrorCode::ProtocolMismatch,
            format!(
                "this PC speaks protocol v{PROTOCOL_VERSION}, the app speaks v{}",
                body.request.protocol_version
            ),
        )
        .with_detail("expected", PROTOCOL_VERSION.to_string())
        .with_detail("received", body.request.protocol_version.to_string()));
    }
    if body.request.device_id.trim().is_empty() {
        return Err(ApiError::invalid("deviceId is required"));
    }
    if body.request.device_name.trim().is_empty() {
        return Err(ApiError::invalid("deviceName is required"));
    }

    let token = {
        let db = state.db.lock();
        auth::pair(&db, &body.request, &body.code)
            .map_err(|failure| ApiError::new(ApiErrorCode::PairingFailed, failure.message()))?
    };

    let server_id = state.db.lock().server_id()?;
    let server_name = state.server_name();
    let backup_directory = state.backup_dir().display().to_string();

    Ok(Json(PairResponse {
        token,
        server_id,
        server_name,
        backup_directory,
        expires_in_seconds: auth::TOKEN_TTL_DAYS * 24 * 60 * 60,
    }))
}

/// `GET /api/dashboard-token` - hands this window its per-launch token.
///
/// Reached by the webview on first load. It is the one dashboard route that cannot itself
/// require the token, which is safe because it is loopback-only and the value is worthless to
/// anything that is not this window: it is regenerated on every launch and grants access to
/// loopback-only routes.
pub async fn dashboard_token(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<serde_json::Value>> {
    ensure_loopback(&request)?;
    Ok(Json(serde_json::json!({ "token": state.dashboard_token })))
}

/// `GET /api/pairing/code` - the code currently shown on screen.
///
/// Does not regenerate: the user needs a code that stays valid while they walk to the phone.
pub async fn get_pairing_code(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<RotatePairingCodeResponse>> {
    ensure_dashboard(&request)?;
    let (code, expires_at) = state.displayed_pairing_code();
    if code.is_empty() {
        return Err(ApiError::internal("could not issue a pairing code"));
    }
    Ok(Json(RotatePairingCodeResponse {
        code,
        expires_at: expires_at.timestamp_millis(),
    }))
}

/// `POST /api/pairing/rotate` - invalidates the current code and issues a new one.
///
/// The plaintext exists only in this response; the server persists just its hash.
pub async fn rotate_pairing_code(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<RotatePairingCodeResponse>> {
    ensure_dashboard(&request)?;
    let (code, expires_at) = state.rotate_displayed_pairing_code();
    if code.is_empty() {
        return Err(ApiError::internal("could not rotate the pairing code"));
    }
    tracing::info!("pairing code rotated from the desktop app");
    Ok(Json(RotatePairingCodeResponse {
        code,
        expires_at: expires_at.timestamp_millis(),
    }))
}

/// `GET /api/paired-devices` - which iPhones hold a token, for the dashboard's status list.
pub async fn paired_devices(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<serde_json::Value>> {
    ensure_dashboard(&request)?;
    let devices = auth::list_devices(&state.db.lock())?;
    let connected = state.connections.lock().names();
    Ok(Json(serde_json::json!({
        "devices": devices,
        "connected": connected,
    })))
}

/// Confirms the caller passed the dashboard middleware. Reaching a handler without it would be
/// a routing bug, so it is reported as a 500 rather than silently serving the data.
fn ensure_dashboard(request: &Request) -> ApiResult<()> {
    if request
        .extensions()
        .get::<super::middleware::DashboardCaller>()
        .is_some()
    {
        Ok(())
    } else {
        Err(ApiError::internal(
            "dashboard authentication middleware did not run",
        ))
    }
}

/// Defence in depth for the token bootstrap route, which cannot require the token it hands out.
fn ensure_loopback(request: &Request) -> ApiResult<()> {
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0);
    match peer {
        Some(addr) if !addr.ip().is_loopback() => Err(ApiError::forbidden(
            "this endpoint is only reachable from this machine",
        )),
        // No connect info means the router was exercised without a real socket (tests). The
        // per-launch token is the actual gate everywhere else.
        _ => Ok(()),
    }
}

/// `POST /api/session/verify` - lets the phone confirm a stored token is still good without
/// attempting a real upload.
pub async fn verify_session(request: Request) -> ApiResult<Json<serde_json::Value>> {
    let caller = Caller::from_request(&request)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "deviceId": caller.device_id,
        "deviceName": caller.device_name,
    })))
}

/* ---------------------------------------------------------------- asset state */

/// `POST /api/assets/status` - which of these assets already have a verified copy.
pub async fn asset_status(
    State(state): State<SharedState>,
    Json(body): Json<AssetStatusRequest>,
) -> ApiResult<Json<AssetStatusResponse>> {
    if body.asset_ids.len() > MAX_STATUS_QUERY_IDS * 4 {
        return Err(ApiError::invalid("too many assetIds in one request"));
    }
    let backed_up = {
        let db = state.db.lock();
        db.find_verified_asset_ids(&body.asset_ids)?
    };
    Ok(Json(AssetStatusResponse {
        backed_up_asset_ids: backed_up,
    }))
}

/* ---------------------------------------------------------------- transfers */

/// `POST /api/transfers/begin`
pub async fn begin_transfer(
    State(state): State<SharedState>,
    request: Request,
) -> ApiResult<Json<BeginTransferResponse>> {
    let caller = Caller::from_request(&request)?;
    let bytes = axum::body::to_bytes(request.into_body(), 256 * 1024)
        .await
        .map_err(|e| ApiError::invalid(format!("could not read request body: {e}")))?;
    let body: BeginTransferRequest = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::invalid(format!("invalid JSON body: {e}")))?;

    let response = transfers::begin_transfer(
        &state,
        &body,
        Some(&caller.device_name),
        Some(&caller.device_id),
    )?;

    if response.action == TransferAction::Skip {
        if let Some(reason) = response.skip_reason {
            state.events.publish(ServerEvent::TransferSkipped {
                transfer_id: response.transfer_id.clone(),
                filename: body.filename.clone(),
                reason: format!("{reason:?}").to_lowercase(),
                at: now_iso(),
            });
        }
    }

    Ok(Json(response))
}

/// `PUT /api/transfers/:id/content` - the upload itself.
///
/// The request body is streamed straight to a `.part` file in fixed-size chunks. Nothing
/// accumulates in memory, so a 4 GB video costs the same resident memory as a 4 KB photo, and
/// the SHA-256 is computed over the bytes as they pass by rather than by re-reading the file
/// afterwards.
pub async fn upload_content(
    State(state): State<SharedState>,
    Path(transfer_id): Path<String>,
    request: Request,
) -> ApiResult<Response> {
    let caller = Caller::from_request(&request)?;

    // The declared size comes from the transfer record, not the request, so a client cannot
    // lie about how much space it needs.
    let record = {
        let db = state.db.lock();
        db.get_transfer(&transfer_id)?
    }
    .ok_or_else(|| ApiError::transfer_not_found("unknown transfer id"))?;

    let declared_size = record.file_size.max(0) as u64;
    let max_bytes = declared_size.clamp(1, MAX_UPLOAD_BYTES);

    let header_filename = request
        .headers()
        .get(HEADER_FILENAME)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let header_media = request
        .headers()
        .get(HEADER_MEDIA_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    tracing::info!(
        transfer = %transfer_id,
        asset = %record.asset_id,
        file = %transfers::describe_upload(header_filename.as_deref(), header_media.as_deref()),
        bytes = declared_size,
        device = %caller.device_name,
        "upload starting"
    );

    storage::check_space_available(&state.backup_dir(), declared_size)
        .map_err(|e| ApiError::new(ApiErrorCode::InsufficientSpace, e))?;

    let mut sink = transfers::open_upload(&state, &transfer_id).await?;
    let mut stream = request.into_body().into_data_stream();
    let mut announced = false;

    let outcome: ApiResult<()> = async {
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| ApiError::invalid(format!("upload stream error: {e}")))?;
            transfers::write_chunk(&mut sink, &chunk, max_bytes).await?;
            if !announced {
                announced = true;
                transfers::announce_transfer_start(
                    &state,
                    &transfer_id,
                    &record.asset_id,
                    &record.filename,
                    record.media_type,
                    record.file_size,
                    Some(&caller.device_name),
                );
            }
            transfers::record_progress(&state, &transfer_id, declared_size, sink.bytes_written);
        }
        transfers::finish_sink(&mut sink).await
    }
    .await;

    match outcome {
        Ok(()) => {
            state
                .db
                .lock()
                .set_transfer_bytes(&transfer_id, sink.bytes_written as i64)?;
            tracing::info!(
                transfer = %transfer_id,
                bytes = sink.bytes_written,
                sha256 = %transfers::sink_hash(&sink),
                "upload body received"
            );
            Ok((
                StatusCode::OK,
                Json(serde_json::json!({
                    "bytesReceived": sink.bytes_written,
                    "sha256": transfers::sink_hash(&sink),
                })),
            )
                .into_response())
        }
        Err(e) => {
            // The client sent something wrong. Drop our staging file so a retry starts clean.
            let _ = transfers::abort_transfer(&state, &transfer_id).await;
            Err(e)
        }
    }
}

/// `POST /api/transfers/:id/complete` - verify and file into the library.
pub async fn complete_transfer(
    State(state): State<SharedState>,
    Path(transfer_id): Path<String>,
    request: Request,
) -> ApiResult<Json<CompleteTransferResponse>> {
    let caller = Caller::from_request(&request)?;
    let bytes = axum::body::to_bytes(request.into_body(), 256 * 1024)
        .await
        .map_err(|e| ApiError::invalid(format!("could not read request body: {e}")))?;
    let body: CompleteTransferRequest = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::invalid(format!("invalid JSON body: {e}")))?;

    let record = {
        let db = state.db.lock();
        db.get_transfer(&transfer_id)?
    }
    .ok_or_else(|| ApiError::transfer_not_found("unknown transfer id"))?;

    let response = transfers::complete_transfer(
        &state,
        &transfer_id,
        &body,
        Some(&caller.device_name),
        Some(&caller.device_id),
        record.sha256,
    )
    .await?;

    tracing::info!(
        transfer = %transfer_id,
        file = %record.filename,
        verified = response.verified,
        path = %response.relative_path,
        "transfer complete"
    );
    Ok(Json(response))
}

/// `POST /api/transfers/:id/abort` - discard an upload the phone is giving up on.
pub async fn abort_transfer(
    State(state): State<SharedState>,
    Path(transfer_id): Path<String>,
) -> ApiResult<Json<AbortTransferResponse>> {
    let aborted = transfers::abort_transfer(&state, &transfer_id).await?;
    Ok(Json(AbortTransferResponse {
        transfer_id,
        aborted,
    }))
}

/* ---------------------------------------------------------------- history & stats */

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
}

/// `GET /api/history`
pub async fn history(
    State(state): State<SharedState>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Json<HistoryResponse>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let offset = query.offset.unwrap_or(0).max(0);

    let (records, total) = {
        let db = state.db.lock();
        db.history(
            limit,
            offset,
            query.status.as_deref(),
            query.search.as_deref(),
        )?
    };

    Ok(Json(HistoryResponse {
        entries: records.iter().map(|r| r.to_wire()).collect(),
        total,
        limit,
        offset,
    }))
}

/// `GET /api/stats`
pub async fn stats(State(state): State<SharedState>) -> ApiResult<Json<LibraryStats>> {
    let stats = state.db.lock().stats()?;
    Ok(Json(stats))
}

/* ---------------------------------------------------------------- settings */

/// `GET /api/settings`
pub async fn get_settings(State(state): State<SharedState>) -> Json<ServerSettingsResponse> {
    let settings = state.settings.read().clone();
    let backup_dir = settings.backup_dir();
    Json(ServerSettingsResponse {
        backup_directory: settings.backup_directory.clone(),
        storage_writable: storage::is_writable(&backup_dir),
        free_space_bytes: storage::free_space_bytes(&backup_dir),
        default_directory: settings.default_directory().display().to_string(),
        default_directory_available: settings.default_directory_available(),
        suggested_directories: settings.suggested_directories(),
    })
}

/// `POST /api/settings/backup-directory`
pub async fn set_backup_directory(
    State(state): State<SharedState>,
    Json(body): Json<SetBackupDirectoryRequest>,
) -> ApiResult<Json<SetBackupDirectoryResponse>> {
    let requested = body.directory.trim();
    if requested.is_empty() {
        return Err(ApiError::invalid("directory must not be empty"));
    }
    // A UNC path or a bare drive letter is legitimate; a relative path is not, because it would
    // resolve against whatever directory the app happens to be running in.
    let candidate = std::path::Path::new(requested);
    if !candidate.is_absolute() {
        return Err(ApiError::invalid("directory must be an absolute path")
            .with_detail("directory", requested.to_string()));
    }

    storage::ensure_library_dirs(candidate)
        .map_err(|e| ApiError::new(ApiErrorCode::StorageUnwritable, e))?;
    if !storage::is_writable(candidate) {
        return Err(ApiError::new(
            ApiErrorCode::StorageUnwritable,
            format!("{} is not writable", candidate.display()),
        ));
    }

    {
        let mut settings = state.settings.write();
        settings.backup_directory = candidate.display().to_string();
        settings.directory_confirmed = true;
        let updated = settings.clone();
        crate::config::save_settings(&updated)?;
    }

    tracing::info!(directory = %candidate.display(), "backup directory changed");

    Ok(Json(SetBackupDirectoryResponse {
        backup_directory: candidate.display().to_string(),
        storage_writable: true,
        free_space_bytes: storage::free_space_bytes(candidate),
    }))
}

/* ---------------------------------------------------------------- live events */

/// `GET /api/events` - WebSocket feeding the dashboard.
///
/// The caller is the dashboard, not a phone, so there is no `Caller` in the extensions here;
/// [`super::middleware::require_dashboard`] has already validated the launch token.
pub async fn events(
    State(state): State<SharedState>,
    ws: WebSocketUpgrade,
    request: Request,
) -> ApiResult<Response> {
    // Defence in depth: the launch token was already checked by `require_dashboard`, but an
    // unauthenticated socket must never reach the broadcast stream even by mistake.
    ensure_dashboard(&request)?;
    tracing::debug!("dashboard connected to the event stream");

    let state = Arc::clone(&state);
    let mut receiver = state.events.subscribe();

    let response = ws.on_upgrade(move |mut socket| async move {
        // Prime the new subscriber with the current state so the dashboard does not have to
        // wait for the next transfer to render anything.
        let snapshot = build_snapshot(&state);
        if send_json(&mut socket, &snapshot).await.is_err() {
            return;
        }

        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if send_json(&mut socket, &event).await.is_err() {
                        break;
                    }
                }
                // A slow dashboard missed events; the next snapshot resynchronises it.
                Err(broadcast_error) => match broadcast_error {
                    tokio::sync::broadcast::error::RecvError::Lagged(missed) => {
                        tracing::warn!(missed, "dashboard fell behind the event stream");
                        let snapshot = build_snapshot(&state);
                        if send_json(&mut socket, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    tokio::sync::broadcast::error::RecvError::Closed => break,
                },
            }
        }
    });

    Ok(response)
}

/// The full picture the dashboard needs in one message, also used as the lag resync payload.
fn build_snapshot(state: &AppState) -> ServerEvent {
    let stats = state.db.lock().stats().unwrap_or_default();
    ServerEvent::ServerStarted {
        server_name: state.server_name(),
        backup_directory: state.backup_dir().display().to_string(),
        at: now_iso(),
    }
    .tap_stats(stats)
}

impl ServerEvent {
    /// Attaches stats to a `ServerStarted`, producing the `StatsChanged` the dashboard
    /// actually renders. Keeps the wire format to a single variant.
    fn tap_stats(self, stats: LibraryStats) -> ServerEvent {
        ServerEvent::StatsChanged {
            stats,
            at: Utc::now().to_rfc3339(),
        }
    }
}

async fn send_json(
    socket: &mut axum::extract::ws::WebSocket,
    event: &ServerEvent,
) -> Result<(), ()> {
    use axum::extract::ws::Message;
    let text = serde_json::to_string(event).map_err(|_| ())?;
    socket.send(Message::Text(text)).await.map_err(|_| ())
}

/* ---------------------------------------------------------------- diagnostic */

/* ---------------------------------------------------------------- helpers */

/// Convenience for tests: build a router for a state without starting a listener.
pub fn router(state: SharedState) -> axum::Router {
    crate::http::server::build_router(state)
}

/// Maps a set of asset ids to those already backed up. Exposed for tests.
pub fn filter_backed_up(all: &[String], backed_up: &[String]) -> Vec<String> {
    let set: HashMap<&String, ()> = backed_up.iter().map(|s| (s, ())).collect();
    all.iter()
        .filter(|id| set.contains_key(*id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_backed_up_ids() {
        let all = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let backed = vec!["a".to_string(), "c".to_string()];
        assert_eq!(
            filter_backed_up(&all, &backed),
            vec!["a".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn filters_nothing_when_none_backed_up() {
        let all = vec!["a".to_string()];
        assert!(filter_backed_up(&all, &[]).is_empty());
    }
}
