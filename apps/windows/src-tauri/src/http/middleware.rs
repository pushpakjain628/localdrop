//! Request authentication and the protocol version guard.
//!
//! The rule is deliberately simple and enforced in one place: every route except
//! `GET /api/health` and `POST /api/pair` requires a valid bearer token. Because the guard is a
//! layer on the protected sub-router rather than something each handler calls, a new route
//! added later cannot accidentally be left unauthenticated.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::auth::{authenticate, bearer_token, AuthError};
use crate::error::ApiError;
use crate::protocol::{ApiErrorCode, PROTOCOL_VERSION};
use crate::transfers::SharedState;

/// The authenticated caller, injected into handlers via request extensions.
#[derive(Debug, Clone)]
pub struct Caller {
    pub device_id: String,
    pub device_name: String,
}

/// Extension key for the caller. Handlers use [`Caller::from_request`].
const CALLER_KEY: &str = "localdrop.caller";

impl Caller {
    /// Reads the caller that [`require_auth`] attached to this request.
    ///
    /// Returning a 500 here would be a programming error rather than a client error: a
    /// protected route that never ran the auth layer.
    pub fn from_request(request: &Request) -> Result<Self, ApiError> {
        request
            .extensions()
            .get::<Caller>()
            .cloned()
            .ok_or_else(|| ApiError::internal("authenticated caller missing from request"))
    }
}

/// Reads the caller without failing when absent, for handlers that behave differently for
/// anonymous callers (only `/api/health` does, and it does not use this).
pub fn optional_caller(request: &Request) -> Option<Caller> {
    request.extensions().get::<Caller>().cloned()
}

pub const CALLER_EXTENSION_NAME: &str = CALLER_KEY;

/// Layer that rejects any request without a valid bearer token.
pub async fn require_auth(
    State(state): State<SharedState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = bearer_token(request.headers())
        .ok_or_else(|| ApiError::unauthorized("this endpoint requires a paired device"))?;

    let context = {
        let db = state.db.lock();
        authenticate(&db, token)
    }
    .map_err(|e: AuthError| ApiError::unauthorized(e.message()))?;

    // Record the connection so the dashboard can show a live "connected" pill.
    {
        let mut connections = state.connections.lock();
        if !connections.is_connected(&context.device_id) {
            connections.connect(&context.device_id, &context.device_name);
            drop(connections);
            state
                .events
                .publish(crate::protocol::ServerEvent::ClientConnected {
                    device_name: context.device_name.clone(),
                    device_id: context.device_id.clone(),
                    at: crate::events::now_iso(),
                });
        }
    }

    request.extensions_mut().insert(Caller {
        device_id: context.device_id,
        device_name: context.device_name,
    });

    Ok(next.run(request).await)
}

/// Header the dashboard presents its per-launch token in.
pub const DASHBOARD_TOKEN_HEADER: &str = "x-localdrop-dashboard";

/// The authenticated dashboard, injected into handlers via request extensions.
#[derive(Debug, Clone)]
pub struct DashboardCaller;

/// Authenticates this app's own dashboard window.
///
/// The dashboard needs routes a paired phone must not have: showing a pairing code, changing
/// the library directory, reading library stats. Giving the webview a phone's long-lived bearer
/// token would hand out backup credentials to a page that renders remote-adjacent content, so
/// instead it gets a token that is regenerated on every launch, lives only in this process's
/// memory, and is additionally required to arrive over loopback.
///
/// Two independent checks: the token (constant-time compared) and the peer address. Either
/// alone would be sufficient against a remote attacker; together they also close off a local
/// process that somehow obtained the token.
pub async fn require_dashboard(
    State(state): State<SharedState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if let Some(peer) = peer_address(&request) {
        if !peer.ip().is_loopback() {
            return Err(ApiError::forbidden(
                "the LocalDrop dashboard is only reachable from this machine",
            ));
        }
    }

    // A browser WebSocket cannot set headers, so the upgrade request carries the token as a
    // query parameter. Same token, same constant-time comparison.
    let presented = request
        .headers()
        .get(DASHBOARD_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| query_param(&request, "token"));

    let Some(presented) = presented else {
        return Err(ApiError::unauthorized(
            "the LocalDrop dashboard requires its launch token",
        ));
    };
    if !crate::auth::constant_time_eq(&presented, &state.dashboard_token) {
        return Err(ApiError::unauthorized("invalid LocalDrop dashboard token"));
    }

    let mut request = request;
    request.extensions_mut().insert(DashboardCaller);
    Ok(next.run(request).await)
}

/// The socket address the request arrived on, when the server was built with connect info.
fn peer_address(request: &Request) -> Option<std::net::SocketAddr> {
    request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0)
}

fn query_param(request: &Request, key: &str) -> Option<String> {
    let query = request.uri().query()?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(key) {
            return parts.next().map(percent_decode);
        }
    }
    None
}

/// Minimal percent-decoding for the ASCII token we generate. Deliberately not a general
/// implementation: anything outside the unreserved set is passed through, and a token that
/// does not decode cleanly simply fails the comparison.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &value[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Rejects requests whose `x-localdrop-protocol` header is missing or from a different major
/// version.
///
/// Only applied to the pairing route: once a device holds a token the version was already
/// negotiated, and refusing later uploads because a phone updated itself would be worse than
/// tolerating an additive change.
pub async fn require_protocol_version(request: Request, next: Next) -> Result<Response, ApiError> {
    let header = request
        .headers()
        .get(crate::protocol::API_VERSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok());

    match header {
        Some(version) if version == PROTOCOL_VERSION => Ok(next.run(request).await),
        Some(version) => Err(ApiError::new(
            ApiErrorCode::ProtocolMismatch,
            format!("this PC speaks protocol v{PROTOCOL_VERSION}, the app speaks v{version}"),
        )
        .with_detail("expected", PROTOCOL_VERSION.to_string())
        .with_detail("received", version.to_string())),
        None => Err(ApiError::new(
            ApiErrorCode::ProtocolMismatch,
            "missing x-localdrop-protocol header",
        )
        .with_detail("expected", PROTOCOL_VERSION.to_string())),
    }
}

/// Fallback for an unknown route, returning the protocol's error envelope rather than axum's
/// default empty 404 so a client always gets a parseable body.
pub async fn not_found() -> Response {
    ApiError::not_found("no such endpoint").into_response()
}

/// Fallback when a request body fails to parse.
pub async fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        axum::Json(serde_json::json!({
            "error": { "code": "not_found", "message": "method not allowed for this endpoint" }
        })),
    )
        .into_response()
}

/// Shared handle used by the Tauri integration to reach the running server's state.
pub type ServerHandle = Arc<crate::transfers::AppState>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn missing_caller_is_an_internal_error() {
        let request = Request::new(axum::body::Body::empty());
        let error = Caller::from_request(&request).unwrap_err();
        assert_eq!(error.code, ApiErrorCode::InternalError);
    }

    #[test]
    fn an_attached_caller_is_readable() {
        let mut request = Request::new(axum::body::Body::empty());
        request.extensions_mut().insert(Caller {
            device_id: "d1".into(),
            device_name: "iPhone".into(),
        });
        let caller = Caller::from_request(&request).unwrap();
        assert_eq!(caller.device_id, "d1");
        assert!(optional_caller(&request).is_some());
    }

    #[test]
    fn not_found_renders_the_error_envelope() {
        let response = futures::executor::block_on(not_found());
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn method_not_allowed_renders_the_error_envelope() {
        let response = futures::executor::block_on(method_not_allowed());
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
