//! Router assembly, listener and graceful shutdown.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};

use axum::http::HeaderValue;
use axum::routing::{get, post, put};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::protocol::{API_PREFIX, DEFAULT_PORT};
use crate::storage;
use crate::transfers::SharedState;

use super::middleware;
use super::routes;

/// Origins the dashboard webview is served from.
///
/// The iPhone is a native client and sends no `Origin`, so for the phone there is no cross-origin
/// scenario to permit. The dashboard is a webview, and it *is* cross-origin to this server:
/// `http://localhost:1420` under `tauri dev`, and the Tauri custom-protocol origin in a bundled
/// build. Without these the browser rejects the preflight, every request fails with `ERR_FAILED`,
/// and the dashboard reports "server unreachable" - which is indistinguishable from a wrong URL,
/// and is how this looked.
///
/// An explicit list, never `Any`. This server is reachable by everything on the LAN, and an open
/// policy would let any web page the user visits read the dashboard token. These are the only
/// origins the app is ever served from, and the dashboard routes stay protected by that token plus
/// a loopback-only check.
const DASHBOARD_ORIGINS: [&str; 3] = [
    "http://localhost:1420",
    "tauri://localhost",
    "http://tauri.localhost",
];

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
    // The phone is a native client, so there is no cross-origin scenario to permit for it. The
    // dashboard, however, is a webview on a different origin and needs its own origins allowed -
    // see `DASHBOARD_ORIGINS`. It is a fixed list rather than `Any` because a permissive policy
    // would widen the attack surface for a server that is reachable by everything on the LAN.
    let cors = CorsLayer::new()
        .allow_origin(
            DASHBOARD_ORIGINS
                .iter()
                .map(|origin| {
                    HeaderValue::from_str(origin).expect("DASHBOARD_ORIGINS must be valid headers")
                })
                .collect::<Vec<_>>(),
        )
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

/// This machine's IPv4 addresses, best effort, cached briefly.
///
/// Uses the OS interface list so the log shows the address on the Wi-Fi subnet rather than a
/// virtual adapter. Failure is not an error: mDNS discovery is the primary mechanism and the
/// IP fallback only needs the list for a friendlier log line.
///
/// Cached because `/api/health` is polled every few seconds by the dashboard, and enumerating
/// interfaces means spawning `ipconfig`. Thirty seconds is short enough to notice a phone moving
/// to a different network, and long enough that the process is not launched on every poll.
pub fn local_ipv4_addresses() -> Vec<String> {
    static CACHE: OnceLock<Mutex<CachedAddresses>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| {
        Mutex::new(CachedAddresses {
            value: Vec::new(),
            read_at: None,
        })
    });

    let Ok(mut guard) = cache.lock() else {
        // A poisoned lock must not take the health endpoint down with it.
        return enumerate_ipv4_addresses();
    };

    let fresh = guard
        .read_at
        .is_some_and(|read_at| read_at.elapsed() < ADDRESS_CACHE_TTL);
    if !fresh || guard.value.is_empty() {
        guard.value = enumerate_ipv4_addresses();
        guard.read_at = Some(std::time::Instant::now());
    }
    guard.value.clone()
}

struct CachedAddresses {
    value: Vec<String>,
    read_at: Option<std::time::Instant>,
}

/// How long an interface enumeration is reused.
const ADDRESS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Runs `ipconfig` and parses it. Separate from the cache so it can be tested without a process.
fn enumerate_ipv4_addresses() -> Vec<String> {
    let mut command = std::process::Command::new("ipconfig");
    command.stdout(std::process::Stdio::piped());
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    parse_ipv4_addresses(&String::from_utf8_lossy(&output.stdout))
}

/// Pulls the IPv4 addresses a phone could actually reach, out of `ipconfig` output.
///
/// Split out from the process call so it can be tested: the only bug this ever had was in
/// parsing, and it shipped because the parsing was unreachable from a test.
///
/// **Only adapters with a default gateway are reported.** This matters more than it looks. A
/// developer machine typically has a virtual adapter too - VirtualBox, WSL, Hyper-V, Docker -
/// and those have an address but no route off the host. Offering one to the user is worse than
/// offering none: they type it into the phone, it times out, and the app looks broken when the
/// real address was on screen the whole time. A gateway is the reliable signal for "this adapter
/// is on a network the phone could share".
///
/// If nothing has a gateway - genuinely offline, or an unusual configuration - every non-loopback
/// address is returned rather than nothing, because a wrong guess still beats a blank field.
fn parse_ipv4_addresses(text: &str) -> Vec<String> {
    let mut routed: Vec<String> = Vec::new();
    let mut unrouted: Vec<String> = Vec::new();

    for block in adapter_blocks(text) {
        let Some(address) = block_ipv4_address(&block) else {
            continue;
        };
        if has_default_gateway(&block) {
            routed.push(address);
        } else {
            unrouted.push(address);
        }
    }

    if routed.is_empty() {
        unrouted
    } else {
        routed
    }
}

/// Splits `ipconfig` output into one chunk per adapter.
///
/// Adapters are separated by a blank line, and the output is CRLF, so this goes line by line
/// rather than splitting on a fixed newline sequence.
fn adapter_blocks(text: &str) -> Vec<Vec<&str>> {
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();

    for line in text.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(line);
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

/// The adapter's IPv4 address, if it has a usable one.
///
/// The label is padded with dot leaders before the colon, so a real line reads
/// `   IPv4 Address. . . . . . . . . . . . : 192.168.1.7`. Taking the first
/// whitespace-separated token returns a bare "." - which is how this once logged `http://.:47821`
/// for every adapter. The address is whatever follows the last colon.
fn block_ipv4_address(block: &[&str]) -> Option<String> {
    let line = block
        .iter()
        .map(|line| line.trim())
        .find(|line| line.starts_with("IPv4 Address."))?;
    let value = line.split_once(':')?.1.trim();
    if value.is_empty() {
        return None;
    }
    // Skip loopback and link-local; neither is reachable from a phone.
    if value.starts_with("127.") || value.starts_with("169.254.") {
        return None;
    }
    Some(value.to_string())
}
/// True when the adapter is connected *and* has a usable default gateway.
///
/// Both matter. A disconnected adapter still reports a default gateway, on its own line, next to
/// a media-state line reading `Media State disconnected` - so a gateway alone is not evidence that
/// anything is plugged in. A connected adapter with no gateway is a link with no route, which is
/// the virtual-adapter case all over again.
fn has_default_gateway(block: &[&str]) -> bool {
    let disconnected = block.iter().any(|line| {
        let line = line.trim();
        line.starts_with("Media State") && line.to_ascii_lowercase().contains("disconnected")
    });
    if disconnected {
        return false;
    }

    block.iter().any(|line| {
        let line = line.trim();
        if !line.starts_with("Default Gateway") {
            return false;
        }
        line.split_once(':')
            .map(|(_, value)| !value.trim().is_empty())
            .unwrap_or(false)
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `ipconfig` on a machine with a VirtualBox host-only adapter, Wi-Fi and
    /// loopback. Two things are pinned down here: the dot leaders before the colon, which once made
    /// the parser return "." for every adapter; and the virtual adapter, which has an address but
    /// no route off the host.
    const IPCONFIG: &str = r"
Windows IP Configuration

Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . :
   Link-local IPv6 Address . . . . . : fe80::1
   IPv4 Address. . . . . . . . . . . . : 192.168.56.1
   Subnet Mask . . . . . . . . . . . : 255.255.255.0

Wireless LAN adapter Wi-Fi:

   Connection-specific DNS Suffix  . :
   IPv4 Address. . . . . . . . . . . . : 192.168.1.7
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1

Loopback Pseudo-Interface 1:

   IPv4 Address. . . . . . . . . . . . : 127.0.0.1
";

    #[test]
    fn a_virtual_adapter_with_no_gateway_is_not_offered_to_the_user() {
        // The reported failure: the dashboard showed 192.168.56.1, a VirtualBox host-only
        // adapter; the user typed it into the phone; the phone timed out - while the address that
        // would have worked sat in the same field.
        assert_eq!(
            parse_ipv4_addresses(IPCONFIG),
            vec!["192.168.1.7".to_string()],
            "only the adapter on a real network should be offered"
        );
    }

    #[test]
    fn the_address_is_the_text_after_the_colon_not_the_dot_leader() {
        // The dot-leader parsing itself, isolated from the gateway rule.
        let block = ["   IPv4 Address. . . . . . . . . . . . : 192.168.1.7"];
        assert_eq!(block_ipv4_address(&block), Some("192.168.1.7".to_string()));
    }

    #[test]
    fn a_disconnected_ethernet_port_is_not_treated_as_a_network() {
        // Windows keeps reporting a default gateway with the cable out, on its own line, next to
        // a media-state line. Offering that address would repeat the virtual-adapter mistake.
        let block = [
            "   Media State . . . . . . . . . . . . : Media State disconnected",
            "   IPv4 Address. . . . . . . . . . . . : 10.0.0.5",
            "   Default Gateway . . . . . . . . . . . : 10.0.0.1",
        ];
        assert!(!has_default_gateway(&block));

        // Alongside a working Wi-Fi, it is filtered out. On its own it is still offered, because
        // the fallback exists for a genuinely offline machine and a blank field is worse than a
        // guess.
        let mixed = "Ethernet adapter Ethernet:\n\n   Media State . . . . . . . . . . . . : Media State disconnected\n   IPv4 Address. . . . . . . . . . . . : 10.0.0.5\n   Default Gateway . . . . . . . . . . . : 10.0.0.1\n\nWireless LAN adapter Wi-Fi:\n\n   IPv4 Address. . . . . . . . . . . . : 192.168.1.7\n   Default Gateway . . . . . . . . . . : 192.168.1.1\n";
        assert_eq!(parse_ipv4_addresses(mixed), vec!["192.168.1.7".to_string()]);
    }

    #[test]
    fn with_no_gateway_at_all_every_usable_address_is_still_offered() {
        // Offline, or an unusual configuration. A wrong guess beats a blank field, and blank is
        // indistinguishable from "no network hardware".
        let offline =
            "Ethernet adapter Ethernet:\n\n   IPv4 Address. . . . . . . . . . . . : 192.168.56.1\n";
        assert_eq!(
            parse_ipv4_addresses(offline),
            vec!["192.168.56.1".to_string()]
        );
    }

    #[test]
    fn both_routed_adapters_are_offered_when_there_are_two() {
        // A desktop with wired and Wi-Fi on separate networks is a real case, and either may be
        // the one the phone shares. Both are genuine, so neither is hidden.
        let two_routed = "Ethernet adapter Ethernet:\n\n   IPv4 Address. . . . . . . . . . . . : 10.0.0.5\n   Default Gateway . . . . . . . . . . : 10.0.0.1\n\nWireless LAN adapter Wi-Fi:\n\n   IPv4 Address. . . . . . . . . . . . : 192.168.1.7\n   Default Gateway . . . . . . . . . . : 192.168.1.1\n";
        assert_eq!(
            parse_ipv4_addresses(two_routed),
            vec!["10.0.0.5".to_string(), "192.168.1.7".to_string()]
        );
    }

    #[test]
    fn every_returned_address_is_something_a_phone_could_be_told() {
        for address in parse_ipv4_addresses(IPCONFIG) {
            assert!(!address.is_empty(), "an empty host is not an address");
            assert!(!address.starts_with("127."), "loopback: {address}");
            assert!(!address.starts_with("169.254."), "link-local: {address}");
            assert_eq!(
                address.split('.').count(),
                4,
                "not an IPv4 address: {address}"
            );
            assert!(
                address.chars().all(|c| c.is_ascii_digit() || c == '.'),
                "not an IPv4 address: {address}"
            );
        }
    }

    #[test]
    fn ipv6_and_subnet_lines_are_not_mistaken_for_addresses() {
        // Only the `IPv4 Address.` prefix is a match, so IPv6 and the other dot-leader lines
        // must be ignored rather than partially parsed.
        assert!(parse_ipv4_addresses("   Link-local IPv6 Address . . . : fe80::1\n").is_empty());
        assert!(parse_ipv4_addresses("   Subnet Mask . . . . . . . : 255.255.255.0\n").is_empty());
        assert!(parse_ipv4_addresses("").is_empty());
    }
}
