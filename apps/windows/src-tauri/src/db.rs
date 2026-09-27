//! SQLite library index.
//!
//! This database is the record of what has been safely backed up. It is what makes the
//! "already backed up" badge, the skip decision in `begin`, the history list and the total
//! storage figures all possible without re-reading the library from disk.
//!
//! Design notes:
//! * Migrations are forward-only and driven by `PRAGMA user_version`, so adding a column
//!   later never requires the user to delete their history.
//! * WAL mode lets the dashboard read while an upload is in flight.
//! * `sha256` is indexed because content-addressed dedupe catches the case where the same
//!   image reached the library from two different devices (or after a Photos re-import),
//!   which `asset_id` alone would miss.

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::protocol::{
    HistoryEntry, LibraryStats, MediaKind, MonthStat, TransferStatus, MAX_STATUS_QUERY_IDS,
};

/// Bumped whenever a migration is added; see [`migrate`].
const SCHEMA_VERSION: i64 = 1;

/// A history/history-query row, before it is mapped into the wire type.
#[derive(Debug, Clone)]
pub struct AssetRecord {
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

impl AssetRecord {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AssetRecord {
            transfer_id: row.get("transfer_id")?,
            asset_id: row.get("asset_id")?,
            filename: row.get("filename")?,
            media_type: MediaKind::parse(&row.get::<_, String>("media_type")?)
                .unwrap_or(MediaKind::Photo),
            file_size: row.get("file_size")?,
            created_at: row.get("created_at")?,
            sha256: row.get("sha256")?,
            relative_path: row.get("relative_path")?,
            absolute_path: row.get("absolute_path")?,
            backed_up_at: row.get("backed_up_at")?,
            status: parse_status(&row.get::<_, String>("status")?),
            device_name: row.get("device_name")?,
            live_photo_id: row.get("live_photo_id")?,
            is_live_photo_video: row.get::<_, i64>("is_live_photo_video")? != 0,
            error_message: row.get("error_message")?,
            duration_ms: row.get("duration_ms")?,
        })
    }

    pub fn to_wire(&self) -> HistoryEntry {
        HistoryEntry {
            transfer_id: self.transfer_id.clone(),
            asset_id: self.asset_id.clone(),
            filename: self.filename.clone(),
            media_type: self.media_type,
            file_size: self.file_size,
            created_at: self.created_at.clone(),
            sha256: self.sha256.clone(),
            relative_path: self.relative_path.clone(),
            absolute_path: self.absolute_path.clone(),
            backed_up_at: self.backed_up_at.clone(),
            status: self.status,
            device_name: self.device_name.clone(),
            live_photo_id: self.live_photo_id.clone(),
            is_live_photo_video: self.is_live_photo_video,
            error_message: self.error_message.clone(),
            duration_ms: self.duration_ms,
        }
    }
}

fn parse_status(value: &str) -> TransferStatus {
    match value {
        "pending" => TransferStatus::Pending,
        "uploading" => TransferStatus::Uploading,
        "verifying" => TransferStatus::Verifying,
        "completed" => TransferStatus::Completed,
        "skipped" => TransferStatus::Skipped,
        "aborted" => TransferStatus::Aborted,
        _ => TransferStatus::Failed,
    }
}

/// Result of a dedupe probe in [`Database::find_verified_by_asset`].
#[derive(Debug, Clone)]
pub struct VerifiedMatch {
    pub relative_path: String,
    pub absolute_path: String,
    pub sha256: String,
}

/// A transfer attempt's immutable header data, read back at `complete` time.
#[derive(Debug, Clone)]
pub struct TransferRecord {
    pub asset_id: String,
    pub filename: String,
    pub media_type: MediaKind,
    pub file_size: i64,
    pub sha256: String,
    pub created_at: String,
    pub device_name: Option<String>,
    pub live_photo_id: Option<String>,
    pub is_live_photo_video: bool,
}

/// Owns the SQLite connection. Not `Sync`-safe by itself, so it is wrapped in a `Mutex` by
/// the caller; all operations here are short and synchronous, which is appropriate because
/// the actual file I/O happens in the upload path, not here.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Opens (creating if needed) the database at `path` and applies migrations.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("could not open database: {e}"))?;

        // WAL lets the dashboard query while an upload writes. busy_timeout stops a
        // concurrent write from failing immediately with SQLITE_BUSY.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("could not enable WAL: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("could not enable foreign keys: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| format!("could not set busy timeout: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("could not set synchronous mode: {e}"))?;

        let mut db = Database { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Opens an in-memory database.
    ///
    /// Used by tests and by [`crate::build_state_for_root`], which needs a throwaway library
    /// that does not touch the user's real config directory or history.
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("{e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("{e}"))?;
        let mut db = Database { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Direct access to the connection for the auth and storage modules.
    ///
    /// The caller is responsible for holding the surrounding `Mutex`, which is what makes
    /// `&self` sound here: rusqlite's `Connection` is `Send` but not `Sync`.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Forward-only migrations keyed on `PRAGMA user_version`.
    ///
    /// Re-running is a no-op, which is what makes startup safe to repeat.
    pub fn migrate(&mut self) -> Result<(), String> {
        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("could not read schema version: {e}"))?;

        if current > SCHEMA_VERSION {
            return Err(format!(
                "database was created by a newer LocalDrop (schema v{current}, this build understands v{SCHEMA_VERSION})"
            ));
        }

        if current < 1 {
            self.conn
                .execute_batch(
                    r#"
                    BEGIN;

                    -- One row per asset the phone has ever offered us. `asset_id` is the
                    -- iOS PHAsset.localIdentifier and is the primary dedupe key.
                    CREATE TABLE IF NOT EXISTS assets (
                        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                        transfer_id         TEXT    NOT NULL,
                        asset_id            TEXT    NOT NULL UNIQUE,
                        filename            TEXT    NOT NULL,
                        media_type          TEXT    NOT NULL,
                        file_size           INTEGER NOT NULL,
                        created_at          TEXT    NOT NULL,
                        sha256              TEXT    NOT NULL,
                        destination_path    TEXT    NOT NULL,
                        absolute_path       TEXT    NOT NULL,
                        backed_up_at        TEXT    NOT NULL,
                        status              TEXT    NOT NULL,
                        device_name         TEXT,
                        device_id           TEXT,
                        live_photo_id       TEXT,
                        is_live_photo_video INTEGER NOT NULL DEFAULT 0,
                        duration_ms         INTEGER,
                        error_message       TEXT
                    );
                    CREATE INDEX IF NOT EXISTS idx_assets_sha256     ON assets(sha256);
                    CREATE INDEX IF NOT EXISTS idx_assets_status     ON assets(status);
                    CREATE INDEX IF NOT EXISTS idx_assets_backed_at  ON assets(backed_up_at);
                    CREATE INDEX IF NOT EXISTS idx_assets_live_photo ON assets(live_photo_id);
                    CREATE INDEX IF NOT EXISTS idx_assets_kind_date  ON assets(media_type, created_at);

                    -- One row per *attempt*, so failures and retries are visible in history
                    -- rather than being lost when an asset eventually succeeds.
                    CREATE TABLE IF NOT EXISTS transfers (
                        transfer_id         TEXT PRIMARY KEY,
                        asset_id            TEXT    NOT NULL,
                        filename            TEXT    NOT NULL,
                        media_type          TEXT    NOT NULL,
                        file_size           INTEGER NOT NULL,
                        sha256              TEXT    NOT NULL,
                        created_at          TEXT    NOT NULL,
                        relative_path       TEXT,
                        absolute_path       TEXT,
                        started_at          TEXT    NOT NULL,
                        completed_at        TEXT,
                        status              TEXT    NOT NULL,
                        device_name         TEXT,
                        device_id           TEXT,
                        bytes_received      INTEGER NOT NULL DEFAULT 0,
                        duration_ms         INTEGER,
                        error_message       TEXT,
                        live_photo_id       TEXT,
                        is_live_photo_video INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
                    CREATE INDEX IF NOT EXISTS idx_transfers_asset  ON transfers(asset_id);
                    CREATE INDEX IF NOT EXISTS idx_transfers_started ON transfers(started_at);

                    -- Paired iPhones. Only the SHA-256 of the bearer token is stored, so a
                    -- leaked database cannot be used to impersonate a phone.
                    CREATE TABLE IF NOT EXISTS paired_devices (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id    TEXT    NOT NULL UNIQUE,
                        device_name  TEXT    NOT NULL,
                        token_hash   TEXT    NOT NULL UNIQUE,
                        os_version   TEXT    NOT NULL DEFAULT '',
                        app_version  TEXT    NOT NULL DEFAULT '',
                        issued_at    TEXT    NOT NULL,
                        expires_at   TEXT    NOT NULL,
                        revoked_at   TEXT,
                        last_seen_at TEXT
                    );

                    -- Only the hash of the current code is kept, and `consumed_at` makes a
                    -- code strictly single-use.
                    CREATE TABLE IF NOT EXISTS pairing_codes (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        code_hash  TEXT    NOT NULL,
                        created_at TEXT    NOT NULL,
                        expires_at TEXT    NOT NULL,
                        consumed_at TEXT
                    );

                    CREATE TABLE IF NOT EXISTS server_meta (
                        key   TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );

                    COMMIT;
                    "#,
                )
                .map_err(|e| format!("migration v1 failed: {e}"))?;
            self.conn
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| format!("could not record schema version: {e}"))?;
        }

        Ok(())
    }

    /* ------------------------------------------------------------ server meta */

    pub fn server_id(&self) -> Result<String, String> {
        if let Some(value) = self.meta_get("server_id")? {
            return Ok(value);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.meta_set("server_id", &id)?;
        Ok(id)
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM server_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("meta_get({key}) failed: {e}"))
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO server_meta(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| format!("meta_set({key}) failed: {e}"))?;
        Ok(())
    }

    /* ------------------------------------------------------------ dedupe */

    /// Returns a *verified* copy of this asset if one exists.
    ///
    /// Only `completed` rows count. A `failed` row must never suppress a retry, and a
    /// `skipped` row means we deliberately did not store the file.
    pub fn find_verified_by_asset(&self, asset_id: &str) -> Result<Option<VerifiedMatch>, String> {
        self.conn
            .query_row(
                "SELECT destination_path, absolute_path, sha256 FROM assets
                 WHERE asset_id = ?1 AND status = 'completed'
                 LIMIT 1",
                params![asset_id],
                |r| {
                    Ok(VerifiedMatch {
                        relative_path: r.get(0)?,
                        absolute_path: r.get(1)?,
                        sha256: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("find_verified_by_asset failed: {e}"))
    }

    /// Content-addressed dedupe: catches the same file arriving under a different
    /// `asset_id` (re-import, restore from backup, shared library).
    pub fn find_verified_by_sha256(&self, sha256: &str) -> Result<Option<VerifiedMatch>, String> {
        self.conn
            .query_row(
                "SELECT destination_path, absolute_path, sha256 FROM assets
                 WHERE sha256 = ?1 AND status = 'completed'
                 LIMIT 1",
                params![sha256],
                |r| {
                    Ok(VerifiedMatch {
                        relative_path: r.get(0)?,
                        absolute_path: r.get(1)?,
                        sha256: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("find_verified_by_sha256 failed: {e}"))
    }

    /// Subset of `asset_ids` that already have a verified copy.
    ///
    /// The id list is chunked because SQLite caps the number of bound parameters, and the
    /// caller may legitimately ask about hundreds of assets at once.
    pub fn find_verified_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<String>, String> {
        let mut found = Vec::new();
        for chunk in asset_ids.chunks(MAX_STATUS_QUERY_IDS.min(900)) {
            if chunk.is_empty() {
                continue;
            }
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT asset_id FROM assets WHERE status = 'completed' AND asset_id IN ({placeholders})"
            );
            let mut stmt = self
                .conn
                .prepare(&sql)
                .map_err(|e| format!("find_verified_asset_ids prepare failed: {e}"))?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                    r.get::<_, String>(0)
                })
                .map_err(|e| format!("find_verified_asset_ids query failed: {e}"))?;
            for row in rows {
                found.push(row.map_err(|e| format!("find_verified_asset_ids row failed: {e}"))?);
            }
        }
        Ok(found)
    }

    /// True when an upload for this asset is already in flight on this server.
    pub fn has_in_flight_transfer(&self, asset_id: &str) -> Result<bool, String> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM transfers
                 WHERE asset_id = ?1 AND status IN ('pending', 'uploading', 'verifying')",
                params![asset_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("has_in_flight_transfer failed: {e}"))?;
        Ok(count > 0)
    }

    /* ------------------------------------------------------------ transfers */

    // The argument list mirrors the columns being written; grouping them into a struct would
    // obscure the mapping rather than clarify it.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_transfer(
        &self,
        transfer_id: &str,
        asset_id: &str,
        filename: &str,
        media_type: MediaKind,
        file_size: i64,
        sha256: &str,
        created_at: &str,
        device_name: Option<&str>,
        device_id: Option<&str>,
        live_photo_id: Option<&str>,
        is_live_photo_video: bool,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO transfers
                   (transfer_id, asset_id, filename, media_type, file_size, sha256, created_at,
                    relative_path, absolute_path, started_at, status, device_name, device_id,
                    bytes_received, live_photo_id, is_live_photo_video)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,NULL,?8,'pending',?9,?10,0,?11,?12)",
                params![
                    transfer_id,
                    asset_id,
                    filename,
                    media_type.as_str(),
                    file_size,
                    sha256,
                    created_at,
                    Utc::now().to_rfc3339(),
                    device_name,
                    device_id,
                    live_photo_id,
                    i64::from(is_live_photo_video),
                ],
            )
            .map_err(|e| format!("insert_transfer failed: {e}"))?;
        Ok(())
    }

    pub fn set_transfer_status(
        &self,
        transfer_id: &str,
        status: TransferStatus,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE transfers SET status = ?2, error_message = ?3 WHERE transfer_id = ?1",
                params![transfer_id, status.as_str(), error],
            )
            .map_err(|e| format!("set_transfer_status failed: {e}"))?;
        Ok(())
    }

    pub fn set_transfer_bytes(&self, transfer_id: &str, bytes: i64) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE transfers SET bytes_received = ?2 WHERE transfer_id = ?1",
                params![transfer_id, bytes],
            )
            .map_err(|e| format!("set_transfer_bytes failed: {e}"))?;
        Ok(())
    }

    /// Everything needed to finish a transfer, or `None` when the id is unknown.
    pub fn get_transfer(&self, transfer_id: &str) -> Result<Option<TransferRecord>, String> {
        self.conn
            .query_row(
                "SELECT asset_id, filename, media_type, file_size, sha256, created_at,
                        device_name, live_photo_id, is_live_photo_video
                 FROM transfers WHERE transfer_id = ?1",
                params![transfer_id],
                |r| {
                    Ok(TransferRecord {
                        asset_id: r.get(0)?,
                        filename: r.get(1)?,
                        media_type: MediaKind::parse(&r.get::<_, String>(2)?)
                            .unwrap_or(MediaKind::Photo),
                        file_size: r.get(3)?,
                        sha256: r.get(4)?,
                        created_at: r.get(5)?,
                        device_name: r.get(6)?,
                        live_photo_id: r.get(7)?,
                        is_live_photo_video: r.get::<_, i64>(8)? != 0,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("get_transfer failed: {e}"))
    }

    /* ------------------------------------------------------------ verified writes */

    /// Records a verified, on-disk asset and closes out its transfer attempt.
    ///
    /// Both statements run in one transaction so a crash can never leave an `assets` row
    /// pointing at a file that was never finished.
    #[allow(clippy::too_many_arguments)]
    pub fn record_verified_asset(
        &self,
        transfer_id: &str,
        asset_id: &str,
        filename: &str,
        media_type: MediaKind,
        file_size: i64,
        created_at: &str,
        sha256: &str,
        relative_path: &str,
        absolute_path: &str,
        backed_up_at: &str,
        device_name: Option<&str>,
        device_id: Option<&str>,
        live_photo_id: Option<&str>,
        is_live_photo_video: bool,
        duration_ms: Option<i64>,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| format!("could not start transaction: {e}"))?;

        tx.execute(
            "INSERT INTO assets
               (transfer_id, asset_id, filename, media_type, file_size, created_at, sha256,
                destination_path, absolute_path, backed_up_at, status, device_name, device_id,
                live_photo_id, is_live_photo_video, duration_ms, error_message)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'completed',?11,?12,?13,?14,?15,NULL)
             ON CONFLICT(asset_id) DO UPDATE SET
                transfer_id    = excluded.transfer_id,
                filename       = excluded.filename,
                media_type     = excluded.media_type,
                file_size      = excluded.file_size,
                created_at     = excluded.created_at,
                sha256         = excluded.sha256,
                destination_path = excluded.destination_path,
                absolute_path  = excluded.absolute_path,
                backed_up_at   = excluded.backed_up_at,
                status         = 'completed',
                device_name    = excluded.device_name,
                device_id      = excluded.device_id,
                live_photo_id  = excluded.live_photo_id,
                is_live_photo_video = excluded.is_live_photo_video,
                duration_ms    = excluded.duration_ms,
                error_message  = NULL",
            params![
                transfer_id,
                asset_id,
                filename,
                media_type.as_str(),
                file_size,
                created_at,
                sha256,
                relative_path,
                absolute_path,
                backed_up_at,
                device_name,
                device_id,
                live_photo_id,
                i64::from(is_live_photo_video),
                duration_ms,
            ],
        )
        .map_err(|e| format!("insert asset failed: {e}"))?;

        tx.execute(
            "UPDATE transfers SET
                status = 'completed',
                relative_path = ?2,
                absolute_path = ?3,
                completed_at = ?4,
                bytes_received = file_size,
                duration_ms = COALESCE(?5, duration_ms),
                error_message = NULL
             WHERE transfer_id = ?1",
            params![
                transfer_id,
                relative_path,
                absolute_path,
                backed_up_at,
                duration_ms
            ],
        )
        .map_err(|e| format!("close transfer failed: {e}"))?;

        tx.commit().map_err(|e| format!("commit failed: {e}"))?;
        Ok(())
    }

    /// Marks a transfer failed without touching any `assets` row, so the phone is free to
    /// retry the same asset later.
    pub fn record_failed_transfer(&self, transfer_id: &str, error: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE transfers SET status = 'failed', error_message = ?2, completed_at = ?3
                 WHERE transfer_id = ?1",
                params![transfer_id, error, Utc::now().to_rfc3339()],
            )
            .map_err(|e| format!("record_failed_transfer failed: {e}"))?;
        Ok(())
    }

    /* ------------------------------------------------------------ history & stats */

    pub fn history(
        &self,
        limit: i64,
        offset: i64,
        status: Option<&str>,
        search: Option<&str>,
    ) -> Result<(Vec<AssetRecord>, i64), String> {
        let mut filters: Vec<String> = Vec::new();
        if let Some(status) = status.filter(|s| !s.is_empty() && *s != "all") {
            filters.push("status = ?".to_string());
            let _ = status;
        }
        if search.filter(|s| !s.trim().is_empty()).is_some() {
            filters.push("LOWER(filename) LIKE ?".to_string());
        }
        let where_clause = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" AND "))
        };

        let mut bind: Vec<String> = Vec::new();
        if let Some(status) = status.filter(|s| !s.is_empty() && *s != "all") {
            bind.push(status.to_string());
        }
        if let Some(search) = search.filter(|s| !s.trim().is_empty()) {
            bind.push(format!("%{}%", search.trim().to_lowercase()));
        }

        let total_sql = format!("SELECT COUNT(*) FROM transfers{where_clause}");
        let total: i64 = self
            .conn
            .query_row(&total_sql, rusqlite::params_from_iter(bind.iter()), |r| {
                r.get(0)
            })
            .map_err(|e| format!("history count failed: {e}"))?;

        let list_sql = format!(
            "SELECT transfer_id, asset_id, filename, media_type, file_size, created_at, sha256,
                    COALESCE(relative_path, '') AS relative_path,
                    COALESCE(absolute_path, '') AS absolute_path,
                    COALESCE(completed_at, started_at) AS backed_up_at, status, device_name,
                    live_photo_id, is_live_photo_video, error_message, duration_ms
             FROM transfers{where_clause}
             ORDER BY started_at DESC, rowid DESC
             LIMIT ? OFFSET ?"
        );
        let mut stmt = self
            .conn
            .prepare(&list_sql)
            .map_err(|e| format!("history prepare failed: {e}"))?;
        let params: Vec<Box<dyn rusqlite::ToSql>> = bind
            .iter()
            .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::ToSql>)
            .chain([
                Box::new(limit) as Box<dyn rusqlite::ToSql>,
                Box::new(offset),
            ])
            .collect();
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter()),
                AssetRecord::from_row,
            )
            .map_err(|e| format!("history query failed: {e}"))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| format!("history row failed: {e}"))?);
        }
        Ok((entries, total))
    }

    pub fn stats(&self) -> Result<LibraryStats, String> {
        let mut stats = LibraryStats::default();

        let (bytes, files, photos, videos): (i64, i64, i64, i64) = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(file_size),0), COUNT(*),
                        COALESCE(SUM(CASE WHEN media_type='photo' THEN 1 ELSE 0 END),0),
                        COALESCE(SUM(CASE WHEN media_type='video' THEN 1 ELSE 0 END),0)
                 FROM assets WHERE status = 'completed'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| format!("stats totals failed: {e}"))?;
        stats.total_bytes = bytes;
        stats.total_files = files;
        stats.photos = photos;
        stats.videos = videos;

        let cutoff = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let (recent_bytes, recent_files): (i64, i64) = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(file_size),0), COUNT(*) FROM assets
                 WHERE status = 'completed' AND backed_up_at >= ?1",
                params![cutoff],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| format!("stats 30d failed: {e}"))?;
        stats.bytes_last_30_days = recent_bytes;
        stats.files_last_30_days = recent_files;

        let failed: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM transfers WHERE status IN ('failed','aborted')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("stats failed count failed: {e}"))?;
        stats.failed_transfers = failed;

        // Group by the `YYYY/MM` prefix of the stored relative path so the dashboard can
        // chart the library by month without re-walking the filesystem.
        let mut stmt = self
            .conn
            .prepare(
                "SELECT destination_path, file_size FROM assets
                 WHERE status = 'completed' AND destination_path LIKE '%/%/%/%'",
            )
            .map_err(|e| format!("stats months prepare failed: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("stats months query failed: {e}"))?;
        let mut buckets: std::collections::HashMap<String, MonthStat> =
            std::collections::HashMap::new();
        for row in rows {
            let (path, size) = row.map_err(|e| format!("stats months row failed: {e}"))?;
            let mut parts = path.split('/');
            let top = parts.next().unwrap_or_default();
            let year = parts.next().unwrap_or_default();
            let month = parts.next().unwrap_or_default();
            if top.is_empty() || year.is_empty() || month.is_empty() {
                continue;
            }
            let label = format!("{top}/{year}/{month}");
            let entry = buckets.entry(label.clone()).or_insert_with(|| MonthStat {
                label,
                files: 0,
                bytes: 0,
            });
            entry.files += 1;
            entry.bytes += size;
        }
        stats.months = buckets.into_values().collect();
        stats.months.sort_by(|a, b| b.label.cmp(&a.label));
        Ok(stats)
    }

    /// Removes transfer rows for a transfer that never produced a file, so the history list
    /// is not polluted by a phone that started an upload and immediately went away.
    pub fn forget_transfer(&self, transfer_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM transfers WHERE transfer_id = ?1 AND status IN ('pending','aborted')",
                params![transfer_id],
            )
            .map_err(|e| format!("forget_transfer failed: {e}"))?;
        Ok(())
    }

    /// Re-parses stored ISO-8601 timestamps. Kept public for tests.
    #[allow(dead_code)]
    pub fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The argument list mirrors the columns being written; grouping them into a struct would
    /// obscure the mapping rather than clarify it.
    #[allow(clippy::too_many_arguments)]
    fn record(
        db: &Database,
        transfer_id: &str,
        asset_id: &str,
        filename: &str,
        kind: MediaKind,
        sha: &str,
        live_photo_id: Option<&str>,
        is_live: bool,
    ) {
        db.insert_transfer(
            transfer_id,
            asset_id,
            filename,
            kind,
            1024,
            sha,
            "2026-09-26T00:00:00Z",
            Some("Test iPhone"),
            Some("device-1"),
            live_photo_id,
            is_live,
        )
        .unwrap();
        db.record_verified_asset(
            transfer_id,
            asset_id,
            filename,
            kind,
            1024,
            "2026-09-26T00:00:00Z",
            sha,
            &format!("Photos/2026/09-September/{filename}"),
            &format!("D:/iPhone Backup/Photos/2026/09-September/{filename}"),
            "2026-09-26T10:00:00Z",
            Some("Test iPhone"),
            Some("device-1"),
            live_photo_id,
            is_live,
            Some(1234),
        )
        .unwrap();
    }

    #[test]
    fn migration_is_idempotent() {
        let mut db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.migrate().unwrap();
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn server_id_is_generated_once_and_stable() {
        let db = Database::open_in_memory().unwrap();
        let first = db.server_id().unwrap();
        let second = db.server_id().unwrap();
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn records_and_finds_a_verified_asset() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "aa11",
            None,
            false,
        );
        let found = db.find_verified_by_asset("asset-1").unwrap().unwrap();
        assert_eq!(found.sha256, "aa11");
        assert!(found.relative_path.ends_with("IMG_1.HEIC"));
    }

    #[test]
    fn dedupes_by_asset_id() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "aa11",
            None,
            false,
        );
        assert!(db.find_verified_by_asset("asset-1").unwrap().is_some());
        assert!(db.find_verified_by_asset("asset-2").unwrap().is_none());
    }

    #[test]
    fn dedupes_by_content_hash_across_different_asset_ids() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "samehash",
            None,
            false,
        );
        // Same bytes arriving from a re-import under a new identifier.
        let found = db.find_verified_by_sha256("samehash").unwrap();
        assert!(found.is_some());
    }

    #[test]
    fn a_failed_transfer_does_not_suppress_a_retry() {
        let db = Database::open_in_memory().unwrap();
        db.insert_transfer(
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            10,
            "h",
            "2026-09-26T00:00:00Z",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        db.record_failed_transfer("t1", "network dropped").unwrap();
        assert!(db.find_verified_by_asset("asset-1").unwrap().is_none());
        assert!(!db.has_in_flight_transfer("asset-1").unwrap());
    }

    #[test]
    fn in_flight_transfer_is_detected() {
        let db = Database::open_in_memory().unwrap();
        db.insert_transfer(
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            10,
            "h",
            "2026-09-26T00:00:00Z",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        assert!(db.has_in_flight_transfer("asset-1").unwrap());
        db.record_failed_transfer("t1", "boom").unwrap();
        assert!(!db.has_in_flight_transfer("asset-1").unwrap());
    }

    #[test]
    fn batch_status_lookup_only_returns_verified_ids() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "asset-2",
            "IMG_2.HEIC",
            MediaKind::Photo,
            "h2",
            None,
            false,
        );

        let ids: Vec<String> = ["asset-1", "asset-2", "asset-3"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut found = db.find_verified_asset_ids(&ids).unwrap();
        found.sort();
        assert_eq!(found, vec!["asset-1".to_string(), "asset-2".to_string()]);
    }

    #[test]
    fn batch_status_lookup_handles_more_ids_than_sqlite_bind_limit() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "asset-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        let ids: Vec<String> = (0..1500).map(|i| format!("asset-{i}")).collect();
        let found = db.find_verified_asset_ids(&ids).unwrap();
        assert_eq!(found, vec!["asset-1".to_string()]);
    }

    #[test]
    fn history_paginates_newest_first() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..5 {
            record(
                &db,
                &format!("t{i}"),
                &format!("asset-{i}"),
                &format!("IMG_{i}.HEIC"),
                MediaKind::Photo,
                &format!("h{i}"),
                None,
                false,
            );
        }
        let (page1, total) = db.history(2, 0, None, None).unwrap();
        assert_eq!(total, 5);
        assert_eq!(page1.len(), 2);

        let (page2, _) = db.history(2, 2, None, None).unwrap();
        assert_eq!(page2.len(), 2);
        assert_ne!(page1[0].transfer_id, page2[0].transfer_id);
    }

    #[test]
    fn history_filters_by_status() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        db.insert_transfer(
            "t2",
            "a2",
            "IMG_2.HEIC",
            MediaKind::Photo,
            10,
            "h2",
            "2026-09-26T00:00:00Z",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        db.record_failed_transfer("t2", "nope").unwrap();

        let (completed, total) = db.history(50, 0, Some("completed"), None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(completed[0].transfer_id, "t1");

        let (failed, total) = db.history(50, 0, Some("failed"), None).unwrap();
        assert_eq!(total, 1);
        assert_eq!(failed[0].error_message.as_deref(), Some("nope"));
    }

    #[test]
    fn history_searches_by_filename() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "a1",
            "IMG_1234.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "a2",
            "holiday.png",
            MediaKind::Photo,
            "h2",
            None,
            false,
        );
        let (found, total) = db.history(50, 0, None, Some("holiday")).unwrap();
        assert_eq!(total, 1);
        assert_eq!(found[0].filename, "holiday.png");
    }

    #[test]
    fn stats_count_only_verified_assets() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "a2",
            "IMG_2.MOV",
            MediaKind::Video,
            "h2",
            None,
            false,
        );
        db.insert_transfer(
            "t3",
            "a3",
            "IMG_3.HEIC",
            MediaKind::Photo,
            10,
            "h3",
            "2026-09-26T00:00:00Z",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        db.record_failed_transfer("t3", "boom").unwrap();

        let stats = db.stats().unwrap();
        assert_eq!(stats.total_files, 2);
        assert_eq!(stats.total_bytes, 2048);
        assert_eq!(stats.photos, 1);
        assert_eq!(stats.videos, 1);
        assert_eq!(stats.failed_transfers, 1);
    }

    #[test]
    fn stats_group_by_month() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "a2",
            "IMG_2.HEIC",
            MediaKind::Photo,
            "h2",
            None,
            false,
        );
        let stats = db.stats().unwrap();
        assert_eq!(stats.months.len(), 1);
        assert_eq!(stats.months[0].label, "Photos/2026/09-September");
        assert_eq!(stats.months[0].files, 2);
        assert_eq!(stats.months[0].bytes, 2048);
    }

    #[test]
    fn live_photo_pairing_is_preserved() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "photo-1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "video-1",
            "IMG_1.MOV",
            MediaKind::Video,
            "h2",
            Some("photo-1"),
            true,
        );

        let (entries, _) = db.history(50, 0, None, None).unwrap();
        let video = entries.iter().find(|e| e.filename == "IMG_1.MOV").unwrap();
        assert!(video.is_live_photo_video);
        assert_eq!(video.live_photo_id.as_deref(), Some("photo-1"));
        // media_type stays `video` even though it is filed under Photos/.
        assert_eq!(video.media_type, MediaKind::Video);
    }

    #[test]
    fn re_recording_an_asset_updates_rather_than_duplicating() {
        let db = Database::open_in_memory().unwrap();
        record(
            &db,
            "t1",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        record(
            &db,
            "t2",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            "h1",
            None,
            false,
        );
        let stats = db.stats().unwrap();
        assert_eq!(stats.total_files, 1);
    }

    #[test]
    fn forget_transfer_only_removes_unstarted_rows() {
        let db = Database::open_in_memory().unwrap();
        db.insert_transfer(
            "t1",
            "a1",
            "IMG_1.HEIC",
            MediaKind::Photo,
            10,
            "h",
            "2026-09-26T00:00:00Z",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        db.forget_transfer("t1").unwrap();
        assert!(db.get_transfer("t1").unwrap().is_none());

        record(
            &db,
            "t2",
            "a2",
            "IMG_2.HEIC",
            MediaKind::Photo,
            "h2",
            None,
            false,
        );
        db.forget_transfer("t2").unwrap();
        assert!(db.get_transfer("t2").unwrap().is_some());
    }
}
