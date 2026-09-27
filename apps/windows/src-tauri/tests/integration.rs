//! End-to-end tests of the HTTP surface.
//!
//! These drive the real router with real requests and real files: an in-memory SQLite index and
//! a temporary library directory. Nothing is stubbed, so a passing run means the phone can
//! actually pair, upload, verify and read history against this server.
//!
//! The security-critical cases live here deliberately: an unauthenticated upload must be
//! rejected *and* must leave nothing on disk.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use localdrop_server_lib::http::middleware::DASHBOARD_TOKEN_HEADER;
use localdrop_server_lib::http::server::build_router;
use localdrop_server_lib::protocol::*;
use localdrop_server_lib::transfers::SharedState;
use localdrop_server_lib::{build_state_for_root, storage};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

struct Harness {
    state: SharedState,
    _root: TempDir,
    /// A paired phone's bearer token.
    token: String,
    /// The desktop window's per-launch token.
    dashboard_token: String,
}

fn pair_request() -> PairRequest {
    PairRequest {
        protocol_version: PROTOCOL_VERSION,
        device_name: "Test iPhone".into(),
        device_id: "device-1".into(),
        os_version: "18.0".into(),
        app_version: "1.0.0".into(),
    }
}

/// A fully wired server backed by a temp library, with one device already paired.
fn harness() -> Harness {
    let root = TempDir::new().unwrap();
    let library = root.path().join("library");
    let state = build_state_for_root(&library, "TEST-PC").unwrap();

    // Seed a pairing code and exchange it, exactly as the phone would.
    let (code, _) = {
        let db = state.db.lock();
        localdrop_server_lib::auth::rotate_pairing_code(&db).unwrap()
    };
    let token = {
        let db = state.db.lock();
        localdrop_server_lib::auth::pair(&db, &pair_request(), &code).unwrap()
    };
    let dashboard_token = state.dashboard_token.clone();

    Harness {
        state,
        _root: root,
        token,
        dashboard_token,
    }
}

/// Issues a fresh pairing code, invalidating any previous one.
fn new_pairing_code(state: &SharedState) -> String {
    let db = state.db.lock();
    localdrop_server_lib::auth::rotate_pairing_code(&db)
        .unwrap()
        .0
}

fn build(method: Method, uri: &str, token: Option<&str>, body: Option<Vec<u8>>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    builder
        .header("content-type", "application/json")
        .body(body.map(Body::from).unwrap_or_else(Body::empty))
        .unwrap()
}

async fn send(state: &SharedState, req: Request<Body>) -> Response {
    build_router(Arc::clone(state)).oneshot(req).await.unwrap()
}

async fn get(state: &SharedState, token: &str, uri: &str) -> Response {
    send(state, build(Method::GET, uri, Some(token), None)).await
}

async fn get_dashboard(state: &SharedState, token: &str, uri: &str) -> Response {
    send(
        state,
        Request::builder()
            .method(Method::GET)
            .uri(uri)
            .header(DASHBOARD_TOKEN_HEADER, token)
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

async fn post_dashboard(
    state: &SharedState,
    token: &str,
    uri: &str,
    body: serde_json::Value,
) -> Response {
    send(
        state,
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(DASHBOARD_TOKEN_HEADER, token)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

async fn post_json(
    state: &SharedState,
    token: &str,
    uri: &str,
    body: serde_json::Value,
) -> Response {
    send(
        state,
        build(
            Method::POST,
            uri,
            Some(token),
            Some(body.to_string().into_bytes()),
        ),
    )
    .await
}

async fn put_bytes(state: &SharedState, token: &str, uri: &str, body: Vec<u8>) -> Response {
    send(state, build(Method::PUT, uri, Some(token), Some(body))).await
}

async fn json_of(response: Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn text_of(response: Response) -> String {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8_lossy(&bytes).to_string()
}

fn sha256_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn begin_body(
    asset_id: &str,
    filename: &str,
    media_type: &str,
    size: usize,
    sha: &str,
) -> serde_json::Value {
    json!({
        "assetId": asset_id,
        "filename": filename,
        "mediaType": media_type,
        "fileSize": size,
        "createdAt": "2026-09-26T12:00:00Z",
        "sha256": sha,
    })
}

async fn begin(state: &SharedState, token: &str, body: serde_json::Value) -> String {
    let response = post_json(state, token, "/api/transfers/begin", body).await;
    assert_eq!(response.status(), StatusCode::OK);
    json_of(response).await["transferId"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Drives a whole transfer: begin -> upload -> complete. Returns the complete response.
async fn run_transfer(
    h: &Harness,
    asset_id: &str,
    filename: &str,
    media_type: &str,
    content: &[u8],
    declared_sha: &str,
) -> Response {
    let transfer_id = begin(
        &h.state,
        &h.token,
        begin_body(asset_id, filename, media_type, content.len(), declared_sha),
    )
    .await;

    let upload = put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        content.to_vec(),
    )
    .await;
    assert_eq!(upload.status(), StatusCode::OK, "upload body was rejected");

    post_json(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/complete"),
        json!({ "sha256": declared_sha, "bytesSent": content.len(), "durationMs": 25 }),
    )
    .await
}

async fn pair_request_bytes(state: &SharedState, code: &str, device_id: &str) -> Response {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/pair")
        .header("content-type", "application/json")
        .header(API_VERSION_HEADER, PROTOCOL_VERSION.to_string())
        .body(Body::from(
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "deviceName": "My iPhone",
                "deviceId": device_id,
                "osVersion": "18.0",
                "appVersion": "1.0.0",
                "code": code,
            })
            .to_string(),
        ))
        .unwrap();
    send(state, req).await
}

/* ------------------------------------------------------------------ health */

#[tokio::test]
async fn health_is_reachable_without_a_token() {
    let h = harness();
    let response = send(&h.state, build(Method::GET, "/api/health", None, None)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = json_of(response).await;
    assert_eq!(json["product"], "LocalDrop");
    assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(json["serverName"], "TEST-PC");
    assert_eq!(json["paired"], true);
    assert!(json["storageWritable"].as_bool().unwrap());
    assert!(json["backupDirectory"].is_string());
}

/* ------------------------------------------------------------------ pairing */

#[tokio::test]
async fn pairing_succeeds_with_the_right_code() {
    let h = harness();
    let code = new_pairing_code(&h.state);
    let response = pair_request_bytes(&h.state, &code, "dev-42").await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = json_of(response).await;
    assert!(!json["token"].as_str().unwrap().is_empty());
    assert_eq!(json["serverName"], "TEST-PC");
    assert!(json["expiresInSeconds"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn pairing_rejects_a_wrong_code() {
    let h = harness();
    new_pairing_code(&h.state);
    let response = pair_request_bytes(&h.state, "000000", "dev-42").await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(json_of(response).await["error"]["code"], "pairing_failed");
}

#[tokio::test]
async fn pairing_rejects_a_malformed_code() {
    let h = harness();
    new_pairing_code(&h.state);
    let response = pair_request_bytes(&h.state, "12", "dev-42").await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_rejects_a_protocol_mismatch_in_the_body() {
    let h = harness();
    let code = new_pairing_code(&h.state);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/pair")
        .header("content-type", "application/json")
        .header(API_VERSION_HEADER, PROTOCOL_VERSION.to_string())
        .body(Body::from(
            json!({
                "protocolVersion": 99,
                "deviceName": "iPhone",
                "deviceId": "d",
                "osVersion": "18",
                "appVersion": "1",
                "code": code,
            })
            .to_string(),
        ))
        .unwrap();
    let response = send(&h.state, req).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_of(response).await["error"]["code"],
        "protocol_mismatch"
    );
}

#[tokio::test]
async fn pairing_requires_the_protocol_header() {
    let h = harness();
    let response = send(
        &h.state,
        build(Method::POST, "/api/pair", None, Some(b"{}".to_vec())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rotating_the_code_invalidates_the_previous_one() {
    let h = harness();
    let first = new_pairing_code(&h.state);
    let second = new_pairing_code(&h.state);
    assert_ne!(first, second);
    assert_eq!(
        pair_request_bytes(&h.state, &first, "dev-9").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        pair_request_bytes(&h.state, &second, "dev-9")
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn rotating_the_code_requires_authentication() {
    let h = harness();
    let response = send(
        &h.state,
        build(Method::POST, "/api/pairing/rotate", None, None),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_paired_phone_can_verify_its_session() {
    let h = harness();
    let response = post_json(&h.state, &h.token, "/api/session/verify", json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let json = json_of(response).await;
    assert_eq!(json["ok"], true);
    assert_eq!(json["deviceName"], "Test iPhone");
}

/* ------------------------------------------------------------------ auth */

#[tokio::test]
async fn an_unauthenticated_upload_is_rejected_and_writes_nothing() {
    let h = harness();
    let response = send(
        &h.state,
        build(
            Method::PUT,
            "/api/transfers/t1/content",
            None,
            Some(b"malicious payload".to_vec()),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json_of(response).await["error"]["code"], "unauthorized");

    let library = h.state.backup_dir();
    assert!(
        !library.join("Photos").exists(),
        "an unauthenticated upload must not create folders"
    );
    let staging = h.state.settings.read().staging_dir();
    let leftovers: Vec<_> = std::fs::read_dir(&staging)
        .map(|rd| rd.flatten().collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "no staging files may be created: {leftovers:?}"
    );
}

#[tokio::test]
async fn a_forged_token_is_rejected() {
    let h = harness();
    let response = get_dashboard(&h.state, "forged-token-value", "/api/stats").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_malformed_authorization_header_is_rejected() {
    let h = harness();
    for header in ["", "Bearer", "Basic abc", "Bearer   "] {
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/assets/status")
            .header("Authorization", header)
            .body(Body::empty())
            .unwrap();
        let response = send(&h.state, req).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "header {header:?} must not authenticate"
        );
    }
}

#[tokio::test]
async fn every_phone_route_requires_a_phone_token() {
    let h = harness();
    let routes: Vec<(Method, &str)> = vec![
        (Method::POST, "/api/session/verify"),
        (Method::POST, "/api/assets/status"),
        (Method::POST, "/api/transfers/begin"),
        (Method::PUT, "/api/transfers/x/content"),
        (Method::POST, "/api/transfers/x/complete"),
        (Method::POST, "/api/transfers/x/abort"),
    ];
    for (method, uri) in routes {
        let response = send(&h.state, build(method.clone(), uri, None, None)).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {uri} must require a phone token"
        );
    }
}

#[tokio::test]
async fn every_dashboard_route_requires_the_launch_token() {
    let h = harness();
    let routes: Vec<(Method, &str)> = vec![
        (Method::GET, "/api/stats"),
        (Method::GET, "/api/history"),
        (Method::GET, "/api/settings"),
        (Method::POST, "/api/settings/backup-directory"),
        (Method::GET, "/api/pairing/code"),
        (Method::POST, "/api/pairing/rotate"),
        (Method::GET, "/api/events"),
        (Method::GET, "/api/paired-devices"),
    ];
    for (method, uri) in routes {
        // No credential at all.
        let response = send(&h.state, build(method.clone(), uri, None, None)).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {uri} must require the dashboard token"
        );
        // A phone's bearer token is not a substitute: the two credential spaces are separate.
        let response = send(&h.state, build(method.clone(), uri, Some(&h.token), None)).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {uri} must not accept a phone token"
        );
    }
}

#[tokio::test]
async fn the_dashboard_token_is_regenerated_per_launch() {
    let first = harness();
    let second = harness();
    assert_ne!(first.dashboard_token, second.dashboard_token);
    assert_eq!(
        first.dashboard_token.len(),
        64,
        "expected a 256-bit hex token"
    );
}

#[tokio::test]
async fn the_dashboard_can_read_its_launch_token() {
    let h = harness();
    let response = get_dashboard(&h.state, "", "/api/dashboard-token").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json_of(response).await["token"],
        json!(h.dashboard_token),
        "the bootstrap route must return this launch's token"
    );
}

#[tokio::test]
async fn the_dashboard_shows_a_pairing_code_that_pairs_a_phone() {
    let h = harness();
    let response = get_dashboard(&h.state, &h.dashboard_token, "/api/pairing/code").await;
    assert_eq!(response.status(), StatusCode::OK);
    let code = json_of(response).await["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(code.len(), 6);

    // The code the PC is showing is the code the phone must be able to use.
    let response = pair_request_bytes(&h.state, &code, "dev-from-dashboard").await;
    assert_eq!(response.status(), StatusCode::OK);

    let devices =
        json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/paired-devices").await).await;
    assert!(devices["devices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["deviceId"] == "dev-from-dashboard"));
}

#[tokio::test]
async fn the_displayed_pairing_code_stays_valid_across_polls() {
    let h = harness();
    let first = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/pairing/code").await)
        .await["code"]
        .as_str()
        .unwrap()
        .to_string();
    // The dashboard polls this route; regenerating on every poll would invalidate a code the
    // user is in the middle of typing into their phone.
    let second = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/pairing/code").await)
        .await["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(first, second);
}

#[tokio::test]
async fn rotating_the_pairing_code_from_the_dashboard_invalidates_the_old_one() {
    let h = harness();
    let old = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/pairing/code").await).await
        ["code"]
        .as_str()
        .unwrap()
        .to_string();
    let response = post_dashboard(
        &h.state,
        &h.dashboard_token,
        "/api/pairing/rotate",
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let new = json_of(response).await["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(old, new);

    assert_eq!(
        pair_request_bytes(&h.state, &old, "dev-1").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        pair_request_bytes(&h.state, &new, "dev-1").await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_phone_token_cannot_read_library_stats() {
    let h = harness();
    let response = get(&h.state, &h.token, "/api/stats").await;
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "library stats are an operator surface, not a phone surface"
    );
}

#[tokio::test]
async fn an_unknown_route_returns_the_error_envelope() {
    let h = harness();
    let response = get_dashboard(&h.state, &h.dashboard_token, "/api/nope").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_of(response).await["error"]["code"], "not_found");
}

/* ------------------------------------------------------------------ transfers */

#[tokio::test]
async fn a_full_upload_round_trip_lands_verified_in_the_library() {
    let h = harness();
    let content = b"pretend this is a photograph";
    let sha = sha256_of(content);

    let complete = run_transfer(&h, "asset-abc", "IMG_1234.HEIC", "photo", content, &sha).await;
    assert_eq!(complete.status(), StatusCode::OK);
    let json = json_of(complete).await;
    assert_eq!(json["verified"], true);
    assert_eq!(json["stored"], true);
    assert_eq!(json["status"], "completed");
    assert_eq!(
        json["relativePath"],
        "Photos/2026/09-September/IMG_1234.heic"
    );
    assert_eq!(json["verifiedSha256"], sha);

    let on_disk = h
        .state
        .backup_dir()
        .join(json["relativePath"].as_str().unwrap());
    assert_eq!(std::fs::read(&on_disk).unwrap(), content.to_vec());

    let stats = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/stats").await).await;
    assert_eq!(stats["totalFiles"], 1);
    assert_eq!(stats["totalBytes"], content.len());
    assert_eq!(stats["photos"], 1);
    assert_eq!(stats["videos"], 0);
    assert_eq!(stats["months"][0]["label"], "Photos/2026/09-September");
}

#[tokio::test]
async fn a_live_photo_video_is_stored_beside_its_still_image() {
    let h = harness();
    let content = b"live photo video bytes";
    let sha = sha256_of(content);
    let mut body = begin_body("video-1", "IMG_5555.MOV", "video", content.len(), &sha);
    body["livePhotoId"] = json!("photo-1");
    body["isLivePhotoVideo"] = json!(true);
    let transfer_id = begin(&h.state, &h.token, body).await;

    put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        content.to_vec(),
    )
    .await;
    let complete = post_json(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/complete"),
        json!({ "sha256": sha, "bytesSent": content.len() }),
    )
    .await;
    let json = json_of(complete).await;
    assert_eq!(
        json["relativePath"], "Photos/2026/09-September/IMG_5555.mov",
        "a Live Photo's video half belongs next to its still image"
    );

    let history = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history").await).await;
    let entry = &history["entries"][0];
    assert_eq!(entry["mediaType"], "video");
    assert_eq!(entry["isLivePhotoVideo"], true);
    assert_eq!(entry["livePhotoId"], "photo-1");
}

#[tokio::test]
async fn a_corrupted_upload_is_reported_unverified_and_not_stored() {
    let h = harness();
    let content = b"these bytes are not what the phone promised";
    let promised = "b".repeat(64);
    let complete = run_transfer(
        &h,
        "asset-corrupt",
        "IMG_9999.MOV",
        "video",
        content,
        &promised,
    )
    .await;

    assert_eq!(complete.status(), StatusCode::OK);
    let json = json_of(complete).await;
    assert_eq!(json["verified"], false);
    assert_eq!(json["stored"], false);
    assert_eq!(json["status"], "failed");
    assert_eq!(
        json["verifiedSha256"],
        sha256_of(content),
        "the server must report the hash it actually computed"
    );

    assert!(!h
        .state
        .backup_dir()
        .join("Videos/2026/09-September/IMG_9999.mov")
        .exists());

    let stats = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/stats").await).await;
    assert_eq!(
        stats["totalFiles"], 0,
        "nothing may be recorded as backed up"
    );
}

#[tokio::test]
async fn a_truncated_body_fails_verification() {
    let h = harness();
    let full = b"the whole file contents";
    let sha = sha256_of(full);
    let transfer_id = begin(
        &h.state,
        &h.token,
        begin_body("asset-truncated", "IMG_4.MOV", "video", full.len(), &sha),
    )
    .await;

    // Only half the body arrives.
    put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        full[..10].to_vec(),
    )
    .await;
    let complete = post_json(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/complete"),
        json!({ "sha256": sha, "bytesSent": 10 }),
    )
    .await;
    let json = json_of(complete).await;
    assert_eq!(json["verified"], false);
    assert_eq!(json["stored"], false);
}

#[tokio::test]
async fn a_large_streamed_body_is_received_intact() {
    // 8 MiB delivered as 128 separate chunks: exercises the streaming path and the incremental
    // hashing rather than a single in-memory body.
    let h = harness();
    let chunk = vec![7u8; 64 * 1024];
    let total_chunks = 128usize;
    let total = chunk.len() * total_chunks;

    let mut hasher = Sha256::new();
    for _ in 0..total_chunks {
        hasher.update(&chunk);
    }
    let sha = hex::encode(hasher.finalize());

    let transfer_id = begin(
        &h.state,
        &h.token,
        begin_body("asset-big", "IMG_BIG.MOV", "video", total, &sha),
    )
    .await;

    let body = Body::from_stream(futures::stream::iter(
        (0..total_chunks).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
    ));
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/transfers/{transfer_id}/content"))
        .header("Authorization", format!("Bearer {}", h.token))
        .body(body)
        .unwrap();
    let response = send(&h.state, req).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_of(response).await["bytesReceived"], total);

    let complete = post_json(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/complete"),
        json!({ "sha256": sha, "bytesSent": total }),
    )
    .await;
    let json = json_of(complete).await;
    assert_eq!(json["verified"], true);
    assert_eq!(json["relativePath"], "Videos/2026/09-September/IMG_BIG.mov");
    let size = std::fs::metadata(
        h.state
            .backup_dir()
            .join("Videos/2026/09-September/IMG_BIG.mov"),
    )
    .unwrap()
    .len();
    assert_eq!(size, total as u64);
}

#[tokio::test]
async fn a_body_larger_than_declared_is_refused() {
    let h = harness();
    let transfer_id = begin(
        &h.state,
        &h.token,
        begin_body("a", "IMG_1.MOV", "video", 10, &"a".repeat(64)),
    )
    .await;
    let response = put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        vec![0u8; 4096],
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn aborting_removes_the_partial_file() {
    let h = harness();
    let transfer_id = begin(
        &h.state,
        &h.token,
        begin_body("a", "IMG_1.MOV", "video", 100, &"a".repeat(64)),
    )
    .await;
    put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        vec![1u8; 50],
    )
    .await;

    let part = h
        .state
        .settings
        .read()
        .staging_dir()
        .join(format!("{transfer_id}.part"));
    assert!(part.exists());

    let response = send(
        &h.state,
        build(
            Method::POST,
            &format!("/api/transfers/{transfer_id}/abort"),
            Some(&h.token),
            None,
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_of(response).await["aborted"], true);
    assert!(!part.exists());
}

/* ------------------------------------------------------------------ dedupe */

#[tokio::test]
async fn asset_status_reports_only_backed_up_ids() {
    let h = harness();
    let content = b"a photo";
    let sha = sha256_of(content);
    run_transfer(&h, "done-1", "IMG_1.HEIC", "photo", content, &sha).await;

    let response = post_json(
        &h.state,
        &h.token,
        "/api/assets/status",
        json!({ "assetIds": ["done-1", "not-done"] }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json_of(response).await["backedUpAssetIds"],
        json!(["done-1"])
    );
}

#[tokio::test]
async fn a_second_begin_for_a_backed_up_asset_is_skipped() {
    let h = harness();
    let content = b"unique content";
    let sha = sha256_of(content);
    let body = begin_body("same-asset", "IMG_1.HEIC", "photo", content.len(), &sha);

    run_transfer(&h, "same-asset", "IMG_1.HEIC", "photo", content, &sha).await;

    let response = post_json(&h.state, &h.token, "/api/transfers/begin", body).await;
    let json = json_of(response).await;
    assert_eq!(json["action"], "skip");
    assert_eq!(json["alreadyBackedUp"], true);
    assert_eq!(json["skipReason"], "already_backed_up");
}

#[tokio::test]
async fn the_same_bytes_under_a_different_asset_id_are_deduplicated() {
    let h = harness();
    let content = b"identical bytes arriving twice";
    let sha = sha256_of(content);
    run_transfer(&h, "first-id", "IMG_1.HEIC", "photo", content, &sha).await;

    // A Photos re-import gives the same image a new localIdentifier.
    let response = post_json(
        &h.state,
        &h.token,
        "/api/transfers/begin",
        begin_body("second-id", "IMG_1.HEIC", "photo", content.len(), &sha),
    )
    .await;
    let json = json_of(response).await;
    assert_eq!(json["action"], "skip");
    assert_eq!(json["skipReason"], "already_backed_up");
}

#[tokio::test]
async fn begin_reports_an_unsupported_format() {
    let h = harness();
    let response = post_json(
        &h.state,
        &h.token,
        "/api/transfers/begin",
        begin_body("raf-1", "IMG_1.RAF", "photo", 10, &"a".repeat(64)),
    )
    .await;
    let json = json_of(response).await;
    assert_eq!(json["action"], "unsupported");
    assert_eq!(json["skipReason"], "unsupported_format");
}

#[tokio::test]
async fn two_different_assets_with_the_same_name_do_not_collide() {
    let h = harness();
    let mut paths = Vec::new();
    for i in 0..2 {
        let content = format!("contents {i}");
        let sha = sha256_of(content.as_bytes());
        let complete = run_transfer(
            &h,
            &format!("asset-{i}"),
            "IMG_7.HEIC",
            "photo",
            content.as_bytes(),
            &sha,
        )
        .await;
        paths.push(
            json_of(complete).await["relativePath"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    assert_eq!(
        paths,
        vec![
            "Photos/2026/09-September/IMG_7.heic",
            "Photos/2026/09-September/IMG_7 (2).heic",
        ]
    );
    for path in &paths {
        assert!(h.state.backup_dir().join(path).exists());
    }
}

/* ------------------------------------------------------------------ history */

#[tokio::test]
async fn history_lists_a_completed_transfer() {
    let h = harness();
    let content = b"history content";
    let sha = sha256_of(content);
    run_transfer(&h, "hist-1", "IMG_77.HEIC", "photo", content, &sha).await;

    let json = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history").await).await;
    assert_eq!(json["total"], 1);
    assert_eq!(json["entries"][0]["filename"], "IMG_77.heic");
    assert_eq!(json["entries"][0]["status"], "completed");
    assert_eq!(json["entries"][0]["deviceName"], "Test iPhone");
    assert_eq!(json["entries"][0]["assetId"], "hist-1");
}

#[tokio::test]
async fn history_can_be_filtered_and_searched() {
    let h = harness();
    for (id, name) in [("h-1", "IMG_aaa.HEIC"), ("h-2", "holiday.png")] {
        let content = format!("body of {id}");
        let sha = sha256_of(content.as_bytes());
        run_transfer(&h, id, name, "photo", content.as_bytes(), &sha).await;
    }

    assert_eq!(
        json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history").await).await["total"],
        2
    );
    assert_eq!(
        json_of(
            get_dashboard(
                &h.state,
                &h.dashboard_token,
                "/api/history?status=completed"
            )
            .await
        )
        .await["total"],
        2
    );
    assert_eq!(
        json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history?status=failed").await)
            .await["total"],
        0
    );

    let searched =
        json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history?search=holiday").await)
            .await;
    assert_eq!(searched["total"], 1);
    assert_eq!(searched["entries"][0]["filename"], "holiday.png");
}

#[tokio::test]
async fn a_failed_transfer_is_visible_in_history() {
    let h = harness();
    let content = b"never matches";
    run_transfer(
        &h,
        "fail-1",
        "IMG_1.HEIC",
        "photo",
        content,
        &"c".repeat(64),
    )
    .await;

    let json =
        json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/history?status=failed").await)
            .await;
    assert_eq!(json["total"], 1);
    assert!(json["entries"][0]["errorMessage"]
        .as_str()
        .unwrap()
        .contains("checksum mismatch"));

    let stats = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/stats").await).await;
    assert_eq!(stats["failedTransfers"], 1);
}

/* ------------------------------------------------------------------ settings */

#[tokio::test]
async fn settings_can_be_read() {
    let h = harness();
    let json = json_of(get_dashboard(&h.state, &h.dashboard_token, "/api/settings").await).await;
    assert!(json["defaultDirectory"].is_string());
    assert!(json["suggestedDirectories"].as_array().unwrap().len() >= 3);
    assert!(json["defaultDirectoryAvailable"].is_boolean());
}

#[tokio::test]
async fn the_backup_directory_can_be_changed() {
    let h = harness();
    let new_dir = h._root.path().join("elsewhere");
    let response = post_dashboard(
        &h.state,
        &h.dashboard_token,
        "/api/settings/backup-directory",
        json!({ "directory": new_dir.display().to_string() }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(h.state.backup_dir(), new_dir);
    assert!(new_dir.join(".localdrop-staging").is_dir());
}

#[tokio::test]
async fn a_relative_backup_directory_is_rejected() {
    let h = harness();
    let response = post_dashboard(
        &h.state,
        &h.dashboard_token,
        "/api/settings/backup-directory",
        json!({ "directory": "relative\\path" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_transfer_after_changing_the_directory_lands_in_the_new_one() {
    let h = harness();
    let new_dir = h._root.path().join("moved");
    post_dashboard(
        &h.state,
        &h.dashboard_token,
        "/api/settings/backup-directory",
        json!({ "directory": new_dir.display().to_string() }),
    )
    .await;

    let content = b"after the move";
    let sha = sha256_of(content);
    let complete = run_transfer(&h, "moved-1", "IMG_1.HEIC", "photo", content, &sha).await;
    let json = json_of(complete).await;
    assert!(new_dir
        .join(json["relativePath"].as_str().unwrap())
        .exists());
}

/* ------------------------------------------------------------------ malformed input */

#[tokio::test]
async fn a_begin_body_that_is_not_json_is_rejected() {
    let h = harness();
    let response = send(
        &h.state,
        build(
            Method::POST,
            "/api/transfers/begin",
            Some(&h.token),
            Some(b"this is not json".to_vec()),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_of(response).await["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn an_invalid_begin_body_names_the_offending_field() {
    let h = harness();
    let response = post_json(
        &h.state,
        &h.token,
        "/api/transfers/begin",
        begin_body("a", "IMG_1.HEIC", "photo", 10, "short"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let text = text_of(response).await;
    assert!(
        text.contains("sha256"),
        "the error should name the offending field: {text}"
    );
}

#[tokio::test]
async fn completing_an_unknown_transfer_is_a_404() {
    let h = harness();
    let response = post_json(
        &h.state,
        &h.token,
        "/api/transfers/nope/complete",
        json!({ "sha256": "a".repeat(64), "bytesSent": 0 }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_of(response).await["error"]["code"],
        "transfer_not_found"
    );
}

#[tokio::test]
async fn a_traversal_filename_cannot_escape_the_library() {
    let h = harness();
    let content = b"traversal attempt";
    let sha = sha256_of(content);
    let complete = run_transfer(
        &h,
        "trav-1",
        "../../../../Windows/System32/evil.HEIC",
        "photo",
        content,
        &sha,
    )
    .await;
    let json = json_of(complete).await;
    let relative = json["relativePath"].as_str().unwrap();
    assert!(
        !relative.contains(".."),
        "the relative path must not contain traversal: {relative}"
    );
    // The name is flattened to its final segment and the file lives inside the library.
    assert!(relative.ends_with("/evil.heic"), "got {relative}");
    assert!(h.state.backup_dir().join(relative).exists());
    assert!(!h
        .state
        .backup_dir()
        .parent()
        .unwrap()
        .join("evil.heic")
        .exists());
}

#[tokio::test]
async fn an_unsupported_extension_is_refused_before_any_bytes_are_sent() {
    let h = harness();
    // `.dll` is not a v1 media type, so the PC answers `unsupported` and creates no transfer to
    // upload into - a follow-up PUT correctly 404s rather than writing a file.
    let response = post_json(
        &h.state,
        &h.token,
        "/api/transfers/begin",
        begin_body("dll-1", "payload.dll", "photo", 10, &"a".repeat(64)),
    )
    .await;
    let transfer_id = json_of(response).await["transferId"]
        .as_str()
        .unwrap()
        .to_string();
    let upload = put_bytes(
        &h.state,
        &h.token,
        &format!("/api/transfers/{transfer_id}/content"),
        vec![0u8; 16],
    )
    .await;
    assert_eq!(upload.status(), StatusCode::NOT_FOUND);
}

/* ------------------------------------------------------------------ staging hygiene */

#[tokio::test]
async fn startup_leaves_in_flight_uploads_alone_but_sweeps_abandoned_ones() {
    let h = harness();
    let staging = h.state.settings.read().staging_dir();
    let fresh = staging.join("in-flight.part");
    std::fs::write(&fresh, b"x").unwrap();
    let keep = staging.join("notes.txt");
    std::fs::write(&keep, b"x").unwrap();

    // The normal startup sweep uses a 6-hour threshold, so a file written seconds ago - which
    // could be a transfer the phone is still uploading - must survive.
    localdrop_server_lib::http::server::prepare_storage(&h.state)
        .await
        .unwrap();
    assert!(
        fresh.exists(),
        "startup must not delete a partial upload that may still be in flight"
    );
    assert!(keep.exists(), "unrelated staging files must be left alone");

    // An explicit sweep with no age threshold clears abandoned partials.
    let removed = storage::sweep_orphan_staging_files(&staging, 0)
        .await
        .unwrap();
    assert_eq!(removed, 1);
    assert!(!fresh.exists());
    assert!(keep.exists());
    assert!(storage::is_writable(&h.state.backup_dir()));
}
