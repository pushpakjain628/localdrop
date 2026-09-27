//! Router assembly, listener and graceful shutdown.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::routing::{get, post, put};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::protocol::{API_PREFIX, DEFAULT_PORT};
use crate::storage;
use crate::transfers::SharedState;

use super::middleware;
use super::routes;

/// Assembles the router.
///
/// The three groups make the security model visible in one place:
///
/// * `public`   - the only routes reachable with no credential at all (`/health`, `/pair`)
/// * `phone`    - the paired iPhone: upload, asset status, session verify. Bearer token.
/// * `dashboard`- this app's own window: stats, history, settings, pairing code, live events.
///   Per-launch token, loopback only.
///
/// Adding a route to the wrong group is visible here rather than buried in a handler.
pub fn build_router(state: SharedState) -> Router {
    // The phone is a native client, not a browser, so there is no cross-origin scenario to
    // permit. A permissive policy would only widen the attack surface for a server that is
    // reachable by everything on the LAN.
    let cors = CorsLayer::new()
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        .max_age(std::time::Duration::from_secs(600));

    let public = Router::new()
        .route("/health", get(routes::health))
        // The dashboard token bootstrap has to be reachable without the token, otherwise the
        // window could never obtain it. It is safe here because the handler refuses anything
        // that did not arrive over loopback, and the value is worthless off this machine: it is
        // regenerated on every launch and only unlocks loopback-only routes.
        .route("/dashboard-token", get(routes::dashboard_token))
        .route(
            "/pair",
            post(routes::pair).layer(axum::middleware::from_fn(
                middleware::require_protocol_version,
            )),
        );

    // `from_fn_with_state` rather than `from_fn`: these layers need `SharedState`, and at this
    // point the router's own state has not been pinned down yet.
    let phone = Router::new()
        .route("/session/verify", post(routes::verify_session))
        .route("/assets/status", post(routes::asset_status))
        .route("/transfers/begin", post(routes::begin_transfer))
        .route("/transfers/:id/content", put(routes::upload_content))
        .route("/transfers/:id/complete", post(routes::complete_transfer))
        .route("/transfers/:id/abort", post(routes::abort_transfer))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            middleware::require_auth,
        ));

    let dashboard = Router::new()
        .route("/stats", get(routes::stats))
        .route("/history", get(routes::history))
        .route("/settings", get(routes::get_settings))
        .route(
            "/settings/backup-directory",
            post(routes::set_backup_directory),
        )
        .route("/pairing/code", get(routes::get_pairing_code))
        .route("/pairing/rotate", post(routes::rotate_pairing_code))
        .route("/events", get(routes::events))
        .route("/paired-devices", get(routes::paired_devices))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            middleware::require_dashboard,
        ));

    Router::new()
        .nest(API_PREFIX, public.merge(phone).merge(dashboard))
        .fallback(middleware::not_found)
        .method_not_allowed_fallback(middleware::method_not_allowed)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// Binds and serves until the process is asked to stop.
///
/// Binds to `0.0.0.0` because the whole point is to be reachable from the phone on the same
/// Wi-Fi. Authentication is what protects it, not the bind address.
pub async fn serve(state: SharedState, port: u16) -> Result<(), String> {
    let router = build_router(state.clone());

    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not bind {addr}: {e}"))?;

    let local_addr = listener.local_addr().map_err(|e| format!("{e}"))?;
    tracing::info!(%local_addr, "LocalDrop server listening");

    // Log the addresses a phone is most likely to reach us on, so the user is not hunting
    // through `ipconfig` output.
    let bound_port = local_addr.port();
    for ip in local_ipv4_addresses() {
        tracing::info!(url = %format!("http://{ip}:{bound_port}"), "reachable on the LAN");
    }

    state
        .events
        .publish(crate::protocol::ServerEvent::ServerStarted {
            server_name: state.server_name(),
            backup_directory: state.backup_dir().display().to_string(),
            at: crate::events::now_iso(),
        });

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|e| format!("server error: {e}"))
}

/// Ctrl-C / SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("shutdown requested (Ctrl-C)"),
        _ = terminate => tracing::info!("shutdown requested (SIGTERM)"),
    }
}

/// This machine's IPv4 addresses, best effort.
///
/// Uses the OS interface list so the log shows the address on the Wi-Fi subnet rather than a
/// virtual adapter. Failure is not an error: mDNS discovery is the primary mechanism and the
/// IP fallback only needs the list for a friendlier log line.
pub fn local_ipv4_addresses() -> Vec<String> {
    let mut command = std::process::Command::new("ipconfig");
    command.stdout(std::process::Stdio::piped());
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix("IPv4 Address.")?;
            let value = rest.split('(').next()?.split_whitespace().next()?;
            // Skip loopback and link-local; neither is reachable from a phone.
            if value.starts_with("127.") || value.starts_with("169.254.") {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

/// Prepares the library directory and sweeps abandoned staging files at startup.
pub async fn prepare_storage(state: &SharedState) -> Result<(), String> {
    let root = state.backup_dir();
    storage::ensure_library_dirs(&root)?;
    let staging = state.settings.read().staging_dir();
    // 6 hours: long enough that a transfer interrupted by the phone going to sleep mid-upload
    // is not swept out from under it when the app relaunches.
    match storage::sweep_orphan_staging_files(&staging, 6 * 60 * 60).await {
        Ok(count) if count > 0 => tracing::info!(count, "removed abandoned partial uploads"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "could not sweep the staging directory"),
    }
    Ok(())
}

/// The port the app should listen on.
pub fn server_port() -> u16 {
    std::env::var("LOCALDROP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}
