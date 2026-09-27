//! Server configuration and settings persistence.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Preferred library root when the volume exists. Chosen because `D:` is the conventional
/// data drive on a Windows desktop, and a full library is usually tens of gigabytes.
pub const PREFERRED_BACKUP_DIR: &str = r"D:\iPhone Backup";

/// Used when [`PREFERRED_BACKUP_DIR`] is unavailable (no D: drive, or no permission).
pub const FALLBACK_BACKUP_DIR: &str = r"%USERPROFILE%\iPhone Backup";

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Absolute path of the library root.
    pub backup_directory: String,
    /// Name broadcast over Bonjour and shown in the phone's device list.
    pub server_name: String,
    /// Whether the user has explicitly chosen a directory (suppresses the first-run prompt).
    pub directory_confirmed: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            backup_directory: default_backup_dir().display().to_string(),
            server_name: computer_name(),
            directory_confirmed: false,
        }
    }
}

impl Settings {
    pub fn backup_dir(&self) -> PathBuf {
        PathBuf::from(&self.backup_directory)
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.backup_dir().join(".localdrop-staging")
    }

    /// `D:\iPhone Backup` when it exists, otherwise the fallback in use.
    pub fn default_directory(&self) -> PathBuf {
        default_backup_dir()
    }

    /// Whether the preferred `D:\iPhone Backup` location is actually usable.
    pub fn default_directory_available(&self) -> bool {
        Path::new(PREFERRED_BACKUP_DIR).is_dir()
    }

    /// Drives the "choose a folder" list in the Windows UI.
    pub fn suggested_directories(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |p: PathBuf| {
            let s = p.display().to_string();
            if !out.iter().any(|existing| existing.eq_ignore_ascii_case(&s)) {
                out.push(s);
            }
        };
        push(PathBuf::from(PREFERRED_BACKUP_DIR));
        if let Some(profile) = dirs::home_dir() {
            push(profile.join("iPhone Backup"));
            push(profile.join("Pictures").join("iPhone Backup"));
            // The profile's own drive is the most likely place a user will accept.
            let profile_str = profile.to_string_lossy().to_string();
            if profile_str.len() >= 2 && profile_str.as_bytes()[1] == b':' {
                push(PathBuf::from(format!("{}\\", &profile_str[..2])).join("iPhone Backup"));
            }
        }
        for letter in ['D', 'E', 'F'] {
            push(PathBuf::from(format!("{letter}:\\iPhone Backup")));
        }
        out
    }
}

/// Resolves the library root to use on first run.
///
/// `D:\iPhone Backup` when that drive exists, otherwise a folder in the user's profile. Never
/// returns a path that does not exist: the caller creates it.
pub fn default_backup_dir() -> PathBuf {
    let preferred = PathBuf::from(PREFERRED_BACKUP_DIR);
    if preferred.is_dir() {
        return preferred;
    }
    if let Some(profile) = dirs::home_dir() {
        return profile.join("iPhone Backup");
    }
    std::env::temp_dir().join("iPhone Backup")
}

/// The machine's display name. Falls back to a generic name when the environment variable is
/// missing, which happens in some service contexts.
pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Windows PC".to_string())
}

/// Directory holding the settings file and the SQLite library index.
pub fn config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("LocalDrop"))
        .ok_or_else(|| "could not determine a config directory for this user".to_string())
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(SETTINGS_FILE))
}

pub fn database_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("library.db"))
}

pub fn load_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    if !path.exists() {
        let settings = Settings::default();
        save_settings(&settings)?;
        return Ok(settings);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    match serde_json::from_str::<Settings>(&raw) {
        Ok(settings) => Ok(settings),
        // A corrupt settings file must not stop the server from starting: fall back to
        // defaults and keep the unreadable file around for diagnosis.
        Err(e) => {
            tracing::warn!(error = %e, "settings file was unreadable, using defaults");
            let settings = Settings::default();
            save_settings(&settings)?;
            Ok(settings)
        }
    }
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialise settings: {e}"))?;
    // Write-then-rename so an interrupted save cannot leave a truncated file behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_directory_is_created_or_usable() {
        let dir = default_backup_dir();
        assert!(!dir.as_os_str().is_empty());
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = Settings {
            backup_directory: r"D:\Media\iPhone".to_string(),
            directory_confirmed: true,
            ..Settings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.backup_directory, settings.backup_directory);
        assert!(parsed.directory_confirmed);
    }

    #[test]
    fn settings_tolerate_missing_fields() {
        // A settings file written by an older build must still load.
        let parsed: Settings = serde_json::from_str("{}").unwrap();
        assert!(!parsed.backup_directory.is_empty());
        assert!(!parsed.server_name.is_empty());
    }

    #[test]
    fn staging_dir_lives_inside_the_library() {
        let settings = Settings::default();
        assert!(settings.staging_dir().starts_with(settings.backup_dir()));
    }

    #[test]
    fn suggestions_are_deduplicated_and_include_the_default() {
        let settings = Settings::default();
        let suggestions = settings.suggested_directories();
        let mut sorted = suggestions.clone();
        sorted.sort_by_key(|s| s.to_lowercase());
        sorted.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        assert_eq!(sorted.len(), suggestions.len());
        assert!(suggestions
            .iter()
            .any(|s| s.eq_ignore_ascii_case(&settings.default_directory().display().to_string())));
    }
}
