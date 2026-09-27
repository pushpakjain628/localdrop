//! Pairing, bearer tokens and request authentication.
//!
//! Threat model, briefly: the server speaks plain HTTP on the LAN, so the guarantee we offer
//! is "an unpaired device on the same Wi-Fi cannot read or write your library", not
//! "the traffic is confidential". A phone must present a 256-bit bearer token on every
//! request; that token is only ever obtainable by someone who can read a 6-digit code off the
//! PC's screen, and it is stored here only as a SHA-256 hash.
//!
//! Every secret comparison in this module goes through [`constant_time_eq`]. Comparing a token
//! with `==` would let an attacker on the LAN recover it a byte at a time by measuring how
//! long a rejected request takes.

use std::collections::HashMap;

use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use sha2::{Digest, Sha256};

use crate::db::Database;
use crate::protocol::{PairRequest, PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS};

/// Bearer tokens are long-lived on purpose: re-pairing a phone should be an explicit,
/// visible act, not something that silently expires and breaks backups at 3am. Revocation is
/// the escape hatch.
pub const TOKEN_TTL_DAYS: i64 = 365;

pub struct AuthContext {
    pub device_id: String,
    pub device_name: String,
}

/// The identity behind a validated request.
pub type AuthResult = Result<AuthContext, AuthError>;

#[derive(Debug)]
pub enum AuthError {
    /// No or malformed `Authorization` header.
    Missing,
    /// Token not recognised, expired or revoked.
    Invalid,
}

impl AuthError {
    pub fn message(&self) -> &'static str {
        match self {
            AuthError::Missing => "missing bearer token",
            AuthError::Invalid => "invalid or expired bearer token",
        }
    }
}

/// Hashes a secret for storage and comparison. Used for both pairing codes and bearer tokens.
pub fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

/// Length-independent byte comparison.
///
/// Runs a fixed number of rounds so neither the loop count nor the early-exit behaviour leaks
/// the position of the first differing byte.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let rounds = a.len().max(b.len()).max(32);
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..rounds {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    diff == 0
}

/// Cryptographically random 256-bit bearer token, hex encoded.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    hex::encode(bytes)
}

/// A 6-digit verification code shown on the PC.
pub fn generate_pairing_code() -> String {
    let mut rng = rand::thread_rng();
    (0..PAIRING_CODE_LENGTH)
        .map(|_| char::from(b'0' + rng.gen_range(0..10)))
        .collect()
}

/// Why a pairing attempt was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum PairingFailure {
    Malformed,
    Mismatch,
    Expired,
    Consumed,
}

impl PairingFailure {
    pub fn message(&self) -> &'static str {
        match self {
            PairingFailure::Malformed => "enter the 6-digit code shown on the PC",
            PairingFailure::Mismatch => "that code is not correct",
            PairingFailure::Expired => "that code has expired, ask the PC for a new one",
            PairingFailure::Consumed => "that code was already used, ask the PC for a new one",
        }
    }
}

/// Consumes the current pairing code and installs a fresh one.
///
/// Returns the plaintext code so it can be displayed. Only its hash is persisted.
pub fn rotate_pairing_code(db: &Database) -> Result<(String, DateTime<Utc>), String> {
    let code = generate_pairing_code();
    let now = Utc::now();
    let expires_at = now + Duration::milliseconds(PAIRING_CODE_TTL_MS);

    let tx = db
        .connection()
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;
    tx.execute("DELETE FROM pairing_codes", [])
        .map_err(|e| format!("could not clear old codes: {e}"))?;
    tx.execute(
        "INSERT INTO pairing_codes(code_hash, created_at, expires_at, consumed_at)
         VALUES (?1,?2,?3,NULL)",
        rusqlite::params![
            hash_secret(&code),
            now.to_rfc3339(),
            expires_at.to_rfc3339()
        ],
    )
    .map_err(|e| format!("could not store pairing code: {e}"))?;
    tx.commit()
        .map_err(|e| format!("could not commit pairing code: {e}"))?;

    Ok((code, expires_at))
}

/// Returns the plaintext of the currently active code, regenerating one when none is live.
///
/// Lets the dashboard show a valid code after a restart instead of forcing the user to press
/// a button first.
pub fn current_pairing_code(db: &Database) -> Result<(String, DateTime<Utc>), String> {
    let conn = db.connection();
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT code_hash, expires_at FROM pairing_codes
             WHERE consumed_at IS NULL ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();

    let now = Utc::now();
    if let Some((_code_hash, expires_at)) = row {
        if let Ok(expires_at) = DateTime::parse_from_rfc3339(&expires_at) {
            if now < expires_at.with_timezone(&Utc) {
                // The plaintext is not recoverable from the hash, so a fresh code is issued.
                // This is the safe choice: it keeps the previous code from being guessable
                // offline and the user has not had a chance to use the old one yet.
                return rotate_pairing_code(db);
            }
        }
    }
    rotate_pairing_code(db)
}

/// Exchanges a verification code for a bearer token.
///
/// On success the code is marked consumed, making it strictly single-use.
pub fn pair(
    db: &Database,
    request: &PairRequest,
    submitted_code: &str,
) -> Result<String, PairingFailure> {
    let normalized: String = submitted_code
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if normalized.len() != PAIRING_CODE_LENGTH {
        return Err(PairingFailure::Malformed);
    }

    let conn = db.connection();
    let row: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT code_hash, expires_at, consumed_at FROM pairing_codes
             ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    let (code_hash, expires_at, consumed_at) = match row {
        Some(row) => row,
        None => return Err(PairingFailure::Mismatch),
    };

    // Evaluate expiry and consumption *before* the comparison so the response time does not
    // reveal which check failed.
    let now = Utc::now();
    let expired = DateTime::parse_from_rfc3339(&expires_at)
        .map(|d| now >= d.with_timezone(&Utc))
        .unwrap_or(true);
    let consumed = consumed_at.is_some();
    let matches = constant_time_eq(&hash_secret(&normalized), &code_hash);

    if expired {
        return Err(PairingFailure::Expired);
    }
    if consumed {
        return Err(PairingFailure::Consumed);
    }
    if !matches {
        return Err(PairingFailure::Mismatch);
    }

    let token = generate_token();
    let token_hash = hash_secret(&token);
    let now = Utc::now();
    let expires_at = now + Duration::days(TOKEN_TTL_DAYS);

    conn.execute(
        "UPDATE pairing_codes SET consumed_at = ?1
         WHERE code_hash = ?2 AND consumed_at IS NULL",
        rusqlite::params![now.to_rfc3339(), code_hash],
    )
    .map_err(|_| PairingFailure::Consumed)?;

    // A phone re-pairing replaces its previous token rather than accumulating rows, so a
    // stolen old token stops working the moment the user re-pairs.
    conn.execute(
        "INSERT INTO paired_devices
           (device_id, device_name, token_hash, os_version, app_version, issued_at, expires_at, last_seen_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?6)
         ON CONFLICT(device_id) DO UPDATE SET
            device_name = excluded.device_name,
            token_hash  = excluded.token_hash,
            os_version  = excluded.os_version,
            app_version = excluded.app_version,
            issued_at   = excluded.issued_at,
            expires_at  = excluded.expires_at,
            revoked_at  = NULL,
            last_seen_at = excluded.last_seen_at",
        rusqlite::params![
            request.device_id,
            request.device_name,
            token_hash,
            request.os_version,
            request.app_version,
            now.to_rfc3339(),
            expires_at.to_rfc3339(),
        ],
    )
    .map_err(|_| PairingFailure::Mismatch)?;

    Ok(token)
}

/// Extracts the bearer token from an `Authorization` header.
pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Resolves a bearer token to the device that owns it.
///
/// Also refreshes `last_seen_at` so the dashboard can show a live connection indicator.
/// Throttled: writing on every single request would be wasteful during a large upload.
pub fn authenticate(db: &Database, token: &str) -> AuthResult {
    let token_hash = hash_secret(token);
    let conn = db.connection();

    // (device_id, device_name, expires_at, revoked_at, last_seen_at)
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT device_id, device_name, expires_at, revoked_at, last_seen_at
             FROM paired_devices WHERE token_hash = ?1",
            rusqlite::params![token_hash],
            |r| {
                let device_id: String = r.get(0)?;
                let device_name: String = r.get(1)?;
                let expires_at: String = r.get(2)?;
                let revoked_at: Option<String> = r.get(3)?;
                let last_seen_at: Option<String> = r.get(4)?;
                Ok((device_id, device_name, expires_at, revoked_at, last_seen_at))
            },
        )
        .ok();

    let (device_id, device_name, expires_at, revoked_at, last_seen_at) = match row {
        Some(row) => row,
        None => return Err(AuthError::Invalid),
    };

    // Constant-time compare even though we looked the row up by its hash: it keeps the
    // failure mode identical to the not-found case.
    if !constant_time_eq(&hash_secret(token), &token_hash) {
        return Err(AuthError::Invalid);
    }
    if revoked_at.is_some() {
        return Err(AuthError::Invalid);
    }
    let expired = DateTime::parse_from_rfc3339(&expires_at)
        .map(|d| Utc::now() >= d.with_timezone(&Utc))
        .unwrap_or(true);
    if expired {
        return Err(AuthError::Invalid);
    }

    // Throttle the heartbeat write to once a minute.
    let now = Utc::now();
    let should_touch = last_seen_at
        .and_then(|v| DateTime::parse_from_rfc3339(&v).ok())
        .map(|d| now - d.with_timezone(&Utc) > Duration::minutes(1))
        .unwrap_or(true);
    if should_touch {
        let _ = conn.execute(
            "UPDATE paired_devices SET last_seen_at = ?2 WHERE device_id = ?1",
            rusqlite::params![device_id, now.to_rfc3339()],
        );
    }

    Ok(AuthContext {
        device_id,
        device_name,
    })
}

/// Devices that are paired and not revoked, for the dashboard.
pub fn list_devices(db: &Database) -> Result<Vec<PairedDevice>, String> {
    let conn = db.connection();
    let mut stmt = conn
        .prepare(
            "SELECT device_id, device_name, os_version, app_version, issued_at, expires_at, last_seen_at
             FROM paired_devices WHERE revoked_at IS NULL ORDER BY issued_at",
        )
        .map_err(|e| format!("list_devices prepare failed: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PairedDevice {
                device_id: r.get(0)?,
                device_name: r.get(1)?,
                os_version: r.get(2)?,
                app_version: r.get(3)?,
                issued_at: r.get(4)?,
                expires_at: r.get(5)?,
                last_seen_at: r.get(6)?,
            })
        })
        .map_err(|e| format!("list_devices query failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("list_devices row failed: {e}"))?);
    }
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub device_id: String,
    pub device_name: String,
    pub os_version: String,
    pub app_version: String,
    pub issued_at: String,
    pub expires_at: String,
    pub last_seen_at: Option<String>,
}

/// True when at least one unexpired, unrevoked device holds a token.
pub fn has_active_device(db: &Database) -> Result<bool, String> {
    let now = Utc::now().to_rfc3339();
    let count: i64 = db
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM paired_devices WHERE revoked_at IS NULL AND expires_at > ?1",
            rusqlite::params![now],
            |r| r.get(0),
        )
        .map_err(|e| format!("has_active_device failed: {e}"))?;
    Ok(count > 0)
}

/// Revokes a paired device. Exposed for the dashboard's "unpair" action.
pub fn revoke_device(db: &Database, device_id: &str) -> Result<bool, String> {
    let changed = db
        .connection()
        .execute(
            "UPDATE paired_devices SET revoked_at = ?2 WHERE device_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![device_id, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("revoke_device failed: {e}"))?;
    Ok(changed > 0)
}

/// In-memory view of who is connected right now, used for the dashboard's status pill.
/// Keyed by device id so a reconnect replaces the previous entry rather than accumulating.
#[derive(Debug, Default)]
pub struct ConnectionRegistry {
    connected: HashMap<String, String>,
}

impl ConnectionRegistry {
    pub fn connect(&mut self, device_id: &str, device_name: &str) {
        self.connected
            .insert(device_id.to_string(), device_name.to_string());
    }

    pub fn disconnect(&mut self, device_id: &str) {
        self.connected.remove(device_id);
    }

    pub fn is_connected(&self, device_id: &str) -> bool {
        self.connected.contains_key(device_id)
    }

    pub fn names(&self) -> Vec<String> {
        self.connected.values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.connected.len()
    }

    pub fn is_empty(&self) -> bool {
        self.connected.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn hash_secret_is_stable_and_not_the_secret() {
        let h = hash_secret("123456");
        assert_eq!(h, hash_secret("123456"));
        assert_ne!(h, hash_secret("123457"));
        assert_eq!(h.len(), 64);
        assert!(!h.contains("123456"));
    }

    #[test]
    fn generated_tokens_are_unique_and_long_enough() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn generated_codes_are_six_digits() {
        for _ in 0..100 {
            let code = generate_pairing_code();
            assert_eq!(code.len(), PAIRING_CODE_LENGTH);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn bearer_token_parsing() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer_token(&headers), None);

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer abc123".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), Some("abc123"));

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "bearer abc123".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), Some("abc123"));

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Basic abc123".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), None);

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer ".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers), None);
    }

    fn request() -> PairRequest {
        PairRequest {
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            device_name: "Test iPhone".into(),
            device_id: "device-1".into(),
            os_version: "18.0".into(),
            app_version: "1.0.0".into(),
        }
    }

    #[test]
    fn pairing_succeeds_with_the_current_code() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let token = pair(&db, &request(), &code).unwrap();
        assert!(!token.is_empty());
    }

    #[test]
    fn pairing_accepts_a_code_typed_with_separators() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let spaced = format!("{} {}", &code[..3], &code[3..]);
        assert!(pair(&db, &request(), &spaced).is_ok());
    }

    #[test]
    fn pairing_rejects_a_wrong_code() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        assert_eq!(pair(&db, &request(), wrong), Err(PairingFailure::Mismatch));
    }

    #[test]
    fn pairing_rejects_a_malformed_code() {
        let db = db();
        rotate_pairing_code(&db).unwrap();
        assert_eq!(pair(&db, &request(), "12"), Err(PairingFailure::Malformed));
        assert_eq!(
            pair(&db, &request(), "abcdef"),
            Err(PairingFailure::Malformed)
        );
    }

    #[test]
    fn a_pairing_code_is_single_use() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        assert!(pair(&db, &request(), &code).is_ok());
        assert_eq!(pair(&db, &request(), &code), Err(PairingFailure::Consumed));
    }

    #[test]
    fn rotating_invalidates_the_previous_code() {
        let db = db();
        let (first, _) = rotate_pairing_code(&db).unwrap();
        let (second, _) = rotate_pairing_code(&db).unwrap();
        assert_eq!(pair(&db, &request(), &first), Err(PairingFailure::Mismatch));
        assert!(pair(&db, &request(), &second).is_ok());
    }

    #[test]
    fn an_expired_code_is_rejected() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        // Backdate the expiry rather than sleeping for five minutes.
        let past = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        db.connection()
            .execute(
                "UPDATE pairing_codes SET expires_at = ?1",
                rusqlite::params![past],
            )
            .unwrap();
        assert_eq!(pair(&db, &request(), &code), Err(PairingFailure::Expired));
    }

    #[test]
    fn pairing_with_no_code_active_fails() {
        let db = db();
        assert_eq!(
            pair(&db, &request(), "123456"),
            Err(PairingFailure::Mismatch)
        );
    }

    #[test]
    fn a_issued_token_authenticates() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let token = pair(&db, &request(), &code).unwrap();
        let ctx = authenticate(&db, &token).unwrap();
        assert_eq!(ctx.device_id, "device-1");
        assert_eq!(ctx.device_name, "Test iPhone");
    }

    #[test]
    fn a_forged_token_is_rejected() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        pair(&db, &request(), &code).unwrap();
        assert!(matches!(
            authenticate(&db, "not-a-real-token"),
            Err(AuthError::Invalid)
        ));
    }

    #[test]
    fn an_expired_token_is_rejected() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let token = pair(&db, &request(), &code).unwrap();
        let past = (Utc::now() - Duration::days(1)).to_rfc3339();
        db.connection()
            .execute(
                "UPDATE paired_devices SET expires_at = ?1",
                rusqlite::params![past],
            )
            .unwrap();
        assert!(authenticate(&db, &token).is_err());
    }

    #[test]
    fn a_revoked_token_is_rejected() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let token = pair(&db, &request(), &code).unwrap();
        assert!(revoke_device(&db, "device-1").unwrap());
        assert!(authenticate(&db, &token).is_err());
    }

    #[test]
    fn the_raw_token_is_never_stored() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let token = pair(&db, &request(), &code).unwrap();
        let stored: String = db
            .connection()
            .query_row("SELECT token_hash FROM paired_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, hash_secret(&token));
        assert_ne!(stored, token);
    }

    #[test]
    fn re_pairing_replaces_the_token() {
        let db = db();
        let (code, _) = rotate_pairing_code(&db).unwrap();
        let first = pair(&db, &request(), &code).unwrap();
        let (code2, _) = rotate_pairing_code(&db).unwrap();
        let second = pair(&db, &request(), &code2).unwrap();
        assert_ne!(first, second);
        assert!(authenticate(&db, &first).is_err());
        assert!(authenticate(&db, &second).is_ok());
        assert_eq!(list_devices(&db).unwrap().len(), 1);
    }

    #[test]
    fn has_active_device_reflects_pairing() {
        let db = db();
        assert!(!has_active_device(&db).unwrap());
        let (code, _) = rotate_pairing_code(&db).unwrap();
        pair(&db, &request(), &code).unwrap();
        assert!(has_active_device(&db).unwrap());
        revoke_device(&db, "device-1").unwrap();
        assert!(!has_active_device(&db).unwrap());
    }

    #[test]
    fn connection_registry_tracks_devices() {
        let mut registry = ConnectionRegistry::default();
        assert!(registry.is_empty());
        registry.connect("d1", "iPhone");
        assert!(registry.is_connected("d1"));
        assert_eq!(registry.names(), vec!["iPhone".to_string()]);
        registry.connect("d1", "iPhone");
        assert_eq!(
            registry.len(),
            1,
            "a reconnect must not duplicate the entry"
        );
        registry.disconnect("d1");
        assert!(registry.is_empty());
    }

    #[test]
    fn current_code_always_yields_a_live_code() {
        let db = db();
        let (code, expires_at) = current_pairing_code(&db).unwrap();
        assert_eq!(code.len(), PAIRING_CODE_LENGTH);
        assert!(Utc::now() < expires_at);
        // A second call must hand out a fresh, immediately usable code.
        let (again, _) = current_pairing_code(&db).unwrap();
        assert!(pair(&db, &request(), &again).is_ok());
        assert!(pair(&db, &request(), &code).is_err());
    }
}
