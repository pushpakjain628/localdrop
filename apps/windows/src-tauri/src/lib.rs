//! LocalDrop Windows companion.
//!
//! A small, self-contained HTTP server that a paired iPhone streams photos and videos to, plus
//! a Tauri window showing what it is doing. The HTTP server is the product; the window is
//! just the dashboard in front of it.
//!
//! Module map:
//! * [`protocol`] - wire types, mirrored from the TypeScript shared package
//! * [`naming`]   - the backup library layout and filename safety rules
//! * [`db`]       - the SQLite index of what has been backed up
//! * [`storage`]  - staging, disk space, and filing a verified file into the library
//! * [`auth`]     - pairing codes, bearer tokens, request authentication
//! * [`transfers`] - the transfer state machine and shared server state
//! * [`events`]   - live progress fan-out to the dashboard
//! * [`http`]     - router, middleware and route handlers

pub mod auth;
pub mod bonjour;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod http;
pub mod naming;
pub mod protocol;
pub mod storage;
pub mod transfers;

use std::sync::Arc;

use db::Database;
use events::EventBus;
use transfers::{AppState, SharedState};

/// Builds the shared state, applying migrations and preparing the library directory.
///
/// Split out from [`run`] so tests and a future headless mode can build the same state.
pub fn build_state() -> Result<SharedState, String> {
    let settings = config::load_settings()?;
    let database = Database::open(&config::database_path()?)?;

    let root = settings.backup_dir();
    storage::ensure_library_dirs(&root).map_err(|e| {
        format!(
            "could not prepare the backup library at {}: {e}",
            root.display()
        )
    })?;

    let state = Arc::new(AppState::new(database, settings, EventBus::new()));

    // Advertise over Bonjour for as long as the app runs. A failure here is not fatal:
    // the phone can still connect by IP address.
    let _advertisement = bonjour::Advertisement::start(
        &state.server_name(),
        http::server::server_port(),
        &state.backup_dir().display().to_string(),
    );

    if !storage::is_writable(&root) {
        tracing::warn!(
            directory = %root.display(),
            "the backup directory is not writable - choose another folder in the app"
        );
    }
    if let Some(free) = storage::free_space_bytes(&root) {
        tracing::info!(free_bytes = free, "library volume free space");
    }

    // A pairing code must exist before the first phone can connect.
    match auth::current_pairing_code(&state.db.lock()) {
        Ok((code, expires_at)) => {
            tracing::info!(
                code = %code,
                expires_at = %expires_at.to_rfc3339(),
                "pairing code ready - enter this on the iPhone"
            );
        }
        Err(e) => tracing::warn!(error = %e, "could not generate a pairing code"),
    }

    Ok(state)
}

/// Builds state rooted at an explicit library directory with an in-memory index.
///
/// Used by the integration tests in `tests/`, and by any future headless mode, so neither has
/// to touch the user's real config directory or backup history.
pub fn build_state_for_root(
    library_root: &std::path::Path,
    server_name: &str,
) -> Result<SharedState, String> {
    storage::ensure_library_dirs(library_root)?;
    let database = Database::open_in_memory()?;
    let settings = config::Settings {
        backup_directory: library_root.display().to_string(),
        server_name: server_name.to_string(),
        directory_confirmed: true,
    };
    Ok(Arc::new(AppState::new(database, settings, EventBus::new())))
}

/// Starts the Tauri app, which owns both the dashboard window and the HTTP server.
pub fn run() {
    init_tracing();

    let state = match build_state() {
        Ok(state) => state,
        Err(e) => {
            tracing::error!(error = %e, "could not start LocalDrop");
            eprintln!("LocalDrop could not start: {e}");
            std::process::exit(1);
        }
    };

    let server_state = Arc::clone(&state);
    let tauri_state = Arc::clone(&state);

    tauri::Builder::default()
        .manage(tauri_state)
        .setup(move |_app| {
            let server_state = Arc::clone(&server_state);
            let port = http::server::server_port();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = http::server::prepare_storage(&server_state).await {
                    tracing::error!(error = %e, "could not prepare storage");
                }
                if let Err(e) = http::server::serve(server_state, port).await {
                    tracing::error!(error = %e, "the LocalDrop server stopped");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the LocalDrop desktop app");
}

/// Console/log-file logging. `RUST_LOG` overrides the default.
fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,localdrop_server=debug"));

    // Logs go to stderr so a user launching the .exe from a terminal sees them; the GUI build
    // also shows them in the window's console when one is attached.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .try_init();
}
