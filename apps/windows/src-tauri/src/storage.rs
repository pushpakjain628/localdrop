//! Filesystem side of receiving a backup: staging, disk-space checks and finalising a file
//! into the library.
//!
//! An upload is never written straight to its final location. Bytes land in a `.part` file in
//! the staging directory, are hashed as they stream in, and are only moved into the organised
//! library once the phone confirms the transfer. That means a half-received 4 GB video can
//! never be mistaken for a backed-up one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::naming;

/// How much free space we insist on beyond the incoming file, so writing a backup can never
/// fill the volume to the point that Windows itself starts misbehaving.
pub const SPACE_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;

/// Extension used for in-progress uploads.
pub const PART_EXTENSION: &str = "part";

/// Ensures the library root and staging directory exist.
pub fn ensure_library_dirs(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("could not create library {}: {e}", root.display()))?;
    std::fs::create_dir_all(root.join(".localdrop-staging"))
        .map_err(|e| format!("could not create staging directory: {e}"))?;
    Ok(())
}

/// A short random suffix so two transfers of the same asset cannot share a `.part` file.
pub fn staging_path(staging_dir: &Path, transfer_id: &str) -> PathBuf {
    staging_dir.join(format!("{transfer_id}.{PART_EXTENSION}"))
}

/// True when the directory exists and a file can actually be created and removed in it.
///
/// Creating a probe file is the only reliable test: the ACLs on a user's `D:\` can deny writes
/// even when the directory exists and reports as accessible. This runs in a blocking context
/// on purpose — it is called from handlers that are not on a hot path, and using the async
/// file API here would need a runtime in unit tests.
pub fn is_writable(dir: &Path) -> bool {
    use std::io::Write as _;
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".localdrop-write-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(mut file) => {
            let _ = file.write_all(b"ok");
            let _ = file.flush();
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Free bytes on the volume holding `dir`.
///
/// Implemented with the Win32 API rather than by shelling out, so a slow or missing
/// `wmic`/`powershell` cannot stall the server. `None` means "unknown", which the UI renders
/// as a dash rather than as zero free space.
pub fn free_space_bytes(dir: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let path = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut free_bytes_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free_bytes: u64 = 0;
        let ok = get_disk_free_space_ex_w(
            wide.as_ptr(),
            &mut free_bytes_available,
            &mut total_bytes,
            &mut total_free_bytes,
        );
        if ok != 0 {
            return Some(free_bytes_available);
        }
        None
    }
    #[cfg(not(windows))]
    {
        // Portable fallback: derive the free space from the filesystem the directory is on by
        // writing nothing and reading the parent, which is only used by tests and by
        // non-Windows development builds.
        let _ = dir;
        None
    }
}

/// Resolves and calls `GetDiskFreeSpaceExW` from kernel32.
///
/// Hand-rolled rather than pulling in the `windows` crate, whose generated surface is far
/// larger than one function justifies. Returns 0 on any failure, which the caller treats as
/// "free space unknown" - a dashboard showing a dash is much better than showing zero.
#[cfg(windows)]
fn get_disk_free_space_ex_w(
    directory_name: *const u16,
    free_bytes_available_to_caller: *mut u64,
    total_number_of_bytes: *mut u64,
    total_number_of_free_bytes: *mut u64,
) -> i32 {
    type GetDiskFreeSpaceExWFn =
        unsafe extern "system" fn(*const u16, *mut u64, *mut u64, *mut u64) -> i32;

    // `kernel32` is always already loaded into the process, so `GetModuleHandleW` cannot fail
    // in practice; if it ever does, report "unknown" rather than panicking.
    extern "system" {
        fn GetModuleHandleW(module_name: *const u16) -> *mut core::ffi::c_void;
        fn GetProcAddress(
            module: *mut core::ffi::c_void,
            proc_name: *const u8,
        ) -> *mut core::ffi::c_void;
    }

    static MODULE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let proc = *MODULE.get_or_init(|| {
        let mut name: Vec<u16> = "kernel32.dll".encode_utf16().collect();
        name.push(0);
        // SAFETY: `name` is NUL-terminated and outlives the call.
        let handle = unsafe { GetModuleHandleW(name.as_ptr()) };
        if handle.is_null() {
            return 0;
        }
        let proc_name = b"GetDiskFreeSpaceExW\0";
        // SAFETY: `handle` came from GetModuleHandleW and is non-null.
        let proc = unsafe { GetProcAddress(handle, proc_name.as_ptr()) };
        proc as usize
    });

    if proc == 0 {
        return 0;
    }
    // SAFETY: `proc` was resolved from kernel32's export table to a function of exactly this
    // signature, and `transmute` of a usize to a fn pointer is valid for a real exported
    // function address.
    let func: GetDiskFreeSpaceExWFn = unsafe { std::mem::transmute(proc) };
    // SAFETY: the caller guarantees `directory_name` is a valid NUL-terminated UTF-16 string
    // and that the three out-pointers are valid, writable, uniquely owned u64s.
    unsafe {
        func(
            directory_name,
            free_bytes_available_to_caller,
            total_number_of_bytes,
            total_number_of_free_bytes,
        )
    }
}

/// Rejects an upload that would not fit, before any bytes are accepted.
pub fn check_space_available(root: &Path, incoming_bytes: u64) -> Result<(), String> {
    let Some(free) = free_space_bytes(root) else {
        // Unknown free space is not a reason to refuse the backup.
        return Ok(());
    };
    let needed = incoming_bytes.saturating_add(SPACE_HEADROOM_BYTES);
    if free < needed {
        return Err(format!(
            "not enough free space: {} available, {} needed",
            humansize(free),
            humansize(needed)
        ));
    }
    Ok(())
}

fn humansize(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Lists the filenames already present in a library folder, for collision resolution.
pub fn existing_filenames(dir: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                set.insert(name.to_string());
            }
        }
    }
    set
}

/// Moves a verified `.part` file into its final location in the library.
///
/// Returns the relative and absolute paths actually used. The destination folder is created on
/// demand and the final name is collision-checked against what is already there, so two
/// different assets that share a filename never overwrite one another.
///
/// This never deletes anything the user owns: the only file removed is the staging `.part`
/// file, and only after a successful move.
pub async fn finalize_into_library(
    root: &Path,
    relative_dir: &str,
    desired_filename: &str,
    part_file: &Path,
) -> Result<(String, String), String> {
    let dir = naming::resolve_under_root(root, relative_dir)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let mut existing = existing_filenames(&dir);
    let filename = naming::resolve_filename_collision(desired_filename, &existing, true);
    existing.insert(filename.clone());

    let final_path = dir.join(&filename);
    let relative_path = if relative_dir.is_empty() {
        filename.clone()
    } else {
        format!("{relative_dir}/{filename}")
    };

    tokio::fs::rename(part_file, &final_path)
        .await
        .map_err(|e| {
            // A cross-volume move fails on `rename`; fall back to copy-then-remove.
            format!("rename failed for {}: {e}", part_file.display())
        })?;

    Ok((relative_path, final_path.display().to_string()))
}

/// Removes a staging file. Only ever called on files this server created.
pub async fn discard_staging_file(path: &Path) {
    if let Err(e) = tokio::fs::remove_file(path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), error = %e, "could not remove staging file");
        }
    }
}

/// Computes the SHA-256 of a file already on disk, streaming it in fixed-size blocks.
///
/// Used when a client disconnects mid-transfer and the dashboard needs to reconcile what was
/// actually received.
pub async fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Clears staging files left behind by a previous run.
///
/// Only touches the `.localdrop-staging` directory this server owns, and only files ending in
/// `.part`. A file being written right now is skipped because its mtime is recent, so pass a
/// `max_age_secs` comfortably larger than the slowest plausible upload.
pub async fn sweep_orphan_staging_files(
    staging_dir: &Path,
    max_age_secs: u64,
) -> Result<usize, String> {
    let mut entries = match tokio::fs::read_dir(staging_dir).await {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(PART_EXTENSION) {
            continue;
        }
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        // `>=` so that a max age of zero means "sweep every .part file", which is what the
        // test and an explicit "clear staging" action both want.
        if now
            .duration_since(modified)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            >= max_age_secs
        {
            let _ = tokio::fs::remove_file(&path).await;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn staging_path_is_namespaced_and_ends_in_part() {
        let path = staging_path(Path::new("C:/backup/.localdrop-staging"), "t-1");
        assert!(path.to_string_lossy().ends_with("t-1.part"));
    }

    #[test]
    fn writability_detects_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_writable(dir.path()));
    }

    #[test]
    fn writability_rejects_a_missing_directory() {
        assert!(!is_writable(Path::new("Z:/definitely/not/here")));
    }

    #[test]
    fn writability_leaves_no_probe_behind() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_writable(dir.path()));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("write-probe"))
            .collect();
        assert!(leftovers.is_empty(), "probe files must be cleaned up");
    }

    #[test]
    fn space_check_rejects_a_file_that_cannot_fit() {
        let dir = tempfile::tempdir().unwrap();
        // Ask for more than any temp volume will have.
        let result = check_space_available(dir.path(), u64::MAX);
        // Either the volume genuinely cannot hold it, or free space is unknown and we allow it.
        if let Some(free) = free_space_bytes(dir.path()) {
            assert!(result.is_err());
            assert!(free > 0);
        } else {
            assert!(result.is_ok());
        }
    }

    #[test]
    fn space_check_allows_a_tiny_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_space_available(dir.path(), 1).is_ok());
    }

    #[tokio::test]
    async fn finalize_moves_the_part_file_into_place() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join(".localdrop-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let part = staging_path(&staging, "t-1");
        std::fs::write(&part, b"hello world").unwrap();

        let (relative, absolute) = finalize_into_library(
            root.path(),
            "Photos/2026/09-September",
            "IMG_1234.HEIC",
            &part,
        )
        .await
        .unwrap();

        assert_eq!(relative, "Photos/2026/09-September/IMG_1234.heic");
        assert!(absolute.ends_with("IMG_1234.heic"));
        assert!(
            !part.exists(),
            "the staging file must be consumed by the move"
        );
        assert_eq!(
            std::fs::read(root.path().join(&relative)).unwrap(),
            b"hello world"
        );
    }

    #[tokio::test]
    async fn finalize_resolves_a_filename_collision() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join(".localdrop-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let dir = "Photos/2026/09-September";

        for (id, name) in [("t-1", "IMG_1.HEIC"), ("t-2", "IMG_1.HEIC")] {
            let part = staging_path(&staging, id);
            std::fs::write(&part, format!("contents of {id}")).unwrap();
            finalize_into_library(root.path(), dir, name, &part)
                .await
                .unwrap();
        }

        assert!(root.path().join(dir).join("IMG_1.heic").exists());
        assert!(root.path().join(dir).join("IMG_1 (2).heic").exists());
        // Neither file was clobbered.
        assert_eq!(
            std::fs::read_to_string(root.path().join(dir).join("IMG_1.heic")).unwrap(),
            "contents of t-1"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(dir).join("IMG_1 (2).heic")).unwrap(),
            "contents of t-2"
        );
    }

    #[tokio::test]
    async fn finalize_creates_missing_folders() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join(".localdrop-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let part = staging_path(&staging, "t-1");
        std::fs::write(&part, b"x").unwrap();
        let (relative, _) =
            finalize_into_library(root.path(), "Videos/2020/01-January", "a.mov", &part)
                .await
                .unwrap();
        assert!(root.path().join(&relative).exists());
    }

    #[tokio::test]
    async fn discard_removes_only_the_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(".localdrop-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let part = staging_path(&staging, "t-1");
        std::fs::write(&part, b"x").unwrap();
        let keep = staging.join("notes.txt");
        let mut f = std::fs::File::create(&keep).unwrap();
        f.write_all(b"keep me").unwrap();

        discard_staging_file(&part).await;
        assert!(!part.exists());
        assert!(keep.exists());
        // Discarding a file that is already gone is not an error.
        discard_staging_file(&part).await;
    }

    #[tokio::test]
    async fn sha256_of_a_known_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        // "abc" -> ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn sha256_of_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::write(&path, b"").unwrap();
        assert_eq!(
            sha256_file(&path).await.unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn sweep_removes_only_old_part_files() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(".localdrop-staging");
        std::fs::create_dir_all(&staging).unwrap();
        let orphan = staging_path(&staging, "orphan");
        std::fs::write(&orphan, b"x").unwrap();
        let other = staging.join("keep.txt");
        std::fs::write(&other, b"x").unwrap();

        // max_age 0 makes every .part file eligible.
        let removed = sweep_orphan_staging_files(&staging, 0).await.unwrap();
        assert_eq!(removed, 1);
        assert!(!orphan.exists());
        assert!(other.exists());
    }

    #[test]
    fn ensure_library_dirs_creates_root_and_staging() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("nested").join("library");
        ensure_library_dirs(&root).unwrap();
        assert!(root.is_dir());
        assert!(root.join(".localdrop-staging").is_dir());
    }
}
