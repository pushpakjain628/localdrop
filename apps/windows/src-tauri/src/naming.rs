//! Filesystem-safe filenames and backup library layout.
//!
//! Hand-maintained port of `packages/shared/src/filename.ts` and
//! `packages/shared/src/naming.ts`. The PC is the authority for where a file actually lands,
//! but it re-derives the layout with the same pure functions the phone used to *predict* it,
//! so the path shown in the phone's UI always matches the path on disk.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike as _, Utc};

use crate::protocol::MediaKind;

/// Top-level folder per media kind. A Live Photo's video half is filed under `Photos`
/// instead - see [`storage_kind`].
const TOP_LEVEL_PHOTOS: &str = "Photos";
const TOP_LEVEL_VIDEOS: &str = "Videos";

/// NTFS caps a single path component at 255 UTF-16 code units. Leave room for a collision
/// suffix so a long name can still be uniquified.
const MAX_STEM_CHARS: usize = 180;

const FALLBACK_STEM: &str = "LocalDrop_Asset";

/// Windows forbids these in a path segment.
const WINDOWS_FORBIDDEN: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// DOS device names. Windows cannot create a *file* with these names even with an extension.
const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Which top-level folder an asset belongs in.
///
/// A Live Photo is two files iOS names `IMG_1234.HEIC` + `IMG_1234.MOV`. Filing the video
/// half under `Videos/` would split the pair across two trees, so the relationship the user
/// sees in Photos would not survive on disk. The video half is therefore filed beside its
/// still image. Its `media_type` stays `video`; only the folder placement changes.
pub fn storage_kind(media_type: MediaKind, is_live_photo_video: bool) -> MediaKind {
    if is_live_photo_video {
        MediaKind::Photo
    } else {
        media_type
    }
}

/// `Photos/2026/09-September`, always using UTC so the phone and the PC agree regardless of
/// the timezone either machine is in.
///
/// `is_live_photo_video` is taken separately from `kind` because a Live Photo's video half
/// reports `MediaKind::Video` but is filed under `Photos/` beside its still image.
pub fn build_relative_media_dir(
    kind: MediaKind,
    is_live_photo_video: bool,
    created_at: DateTime<Utc>,
) -> String {
    let top = match storage_kind(kind, is_live_photo_video) {
        MediaKind::Photo => TOP_LEVEL_PHOTOS,
        MediaKind::Video => TOP_LEVEL_VIDEOS,
    };
    format!(
        "{}/{}/{:02}-{}",
        top,
        created_at.format("%Y"),
        created_at.month(),
        month_name(created_at.month()),
    )
}

fn month_name(month: u32) -> &'static str {
    match month {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        _ => "December",
    }
}

/// `Photos/2026/09-September/IMG_1234.HEIC`
pub fn build_relative_media_path(
    media_type: MediaKind,
    is_live_photo_video: bool,
    created_at: DateTime<Utc>,
    filename: &str,
) -> String {
    format!(
        "{}/{}",
        build_relative_media_dir(media_type, is_live_photo_video, created_at),
        filename
    )
}

/// Reduces an arbitrary string to a single path segment that is valid on both NTFS and APFS.
///
/// A phone must never be able to influence the path the PC writes to beyond the final
/// segment, so any directory component is stripped rather than escaped.
pub fn sanitize_filename_segment(input: &str, fallback: &str) -> String {
    // Strip any directory component: everything up to and including the last separator.
    let without_dirs = match input.rfind(['/', '\\']) {
        Some(idx) => &input[idx + 1..],
        None => input,
    };

    let mut name: String = without_dirs
        .chars()
        .map(|c| {
            if WINDOWS_FORBIDDEN.contains(&c) {
                '_'
            } else if c.is_control() {
                '\0' // dropped below
            } else {
                c
            }
        })
        .filter(|c| *c != '\0')
        .collect();

    // Leading dots would hide the file and turn the name into `.` or `..`.
    while name.starts_with('.') {
        name.remove(0);
    }
    // Windows silently strips trailing dots and spaces, which would make a later lookup by
    // name fail. Remove them up front so the on-disk name matches what we recorded.
    while name.ends_with('.') || name.ends_with(' ') {
        name.pop();
    }

    if name.is_empty() {
        return fallback.to_string();
    }

    let (stem, ext) = split_stem_extension(&name);
    let mut stem = if stem.is_empty() {
        fallback.to_string()
    } else {
        stem.to_string()
    };
    if stem.chars().count() > MAX_STEM_CHARS {
        stem = stem.chars().take(MAX_STEM_CHARS).collect();
    }
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        stem = fallback.to_string();
    }

    let ext_lower = ext.to_ascii_lowercase();
    let result = if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{ext_lower}")
    };

    // Only escape a reserved name when it is the whole stem: `CONCERT.HEIC` is legal.
    let (final_stem, final_ext) = split_stem_extension(&result);
    if RESERVED_DEVICE_NAMES.contains(&final_stem.to_ascii_lowercase().as_str()) {
        if final_ext.is_empty() {
            format!("{final_stem}_")
        } else {
            format!("{final_stem}_.{}", final_ext.to_ascii_lowercase())
        }
    } else {
        result
    }
}

/// Convenience wrapper using the default fallback stem.
pub fn sanitize_filename(input: &str) -> String {
    sanitize_filename_segment(input, FALLBACK_STEM)
}

fn split_stem_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // A leading dot means a dotfile, not an extension.
        Some(0) | None => (name, ""),
        Some(idx) => (&name[..idx], &name[idx + 1..]),
    }
}

/// `IMG_1234 (2).HEIC` for the given 1-based duplicate index.
pub fn with_collision_suffix(filename: &str, index: usize) -> String {
    if index <= 1 {
        return filename.to_string();
    }
    let (stem, ext) = split_stem_extension(filename);
    if ext.is_empty() {
        format!("{stem} ({index})")
    } else {
        format!("{stem} ({index}).{ext}")
    }
}

/// Picks a filename that does not collide with anything already present in `existing`.
///
/// An exact-name match is returned unchanged so that re-running a failed transfer overwrites
/// its own partial result instead of littering the library with `IMG_1 (2).HEIC`.
pub fn resolve_filename_collision(
    desired: &str,
    existing: &HashSet<String>,
    case_insensitive: bool,
) -> String {
    let safe = sanitize_filename(desired);
    let taken = |candidate: &str| -> bool {
        if case_insensitive {
            existing.iter().any(|e| e.eq_ignore_ascii_case(candidate))
        } else {
            existing.contains(candidate)
        }
    };
    if !taken(&safe) {
        return safe;
    }
    for index in 2..=1000 {
        let candidate = with_collision_suffix(&safe, index);
        if !taken(&candidate) {
            return candidate;
        }
    }
    // Pathological folder: fall back to a timestamp rather than looping forever.
    with_collision_suffix(&safe, chrono::Utc::now().timestamp_millis() as usize)
}

/// Joins a relative, `/`-separated library path onto the library root.
///
/// The relative path is produced exclusively by this crate's own functions, but it still
/// goes through a check that rejects traversal so a bug upstream cannot write outside the
/// library.
pub fn resolve_under_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for segment in relative.split('/').filter(|s| !s.is_empty()) {
        if segment == "." || segment == ".." || segment.contains(['/', '\\']) {
            return Err(format!("illegal path segment in {relative:?}"));
        }
        out.push(segment);
    }
    Ok(out)
}

/// Case-insensitive comparison helper for Windows filenames.
pub fn same_file_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, mi, s).unwrap()
    }

    #[test]
    fn builds_photo_folder() {
        assert_eq!(
            build_relative_media_dir(MediaKind::Photo, false, ts(2026, 9, 26, 12, 0, 0)),
            "Photos/2026/09-September"
        );
    }

    #[test]
    fn builds_video_folder() {
        assert_eq!(
            build_relative_media_dir(MediaKind::Video, false, ts(2026, 9, 26, 12, 0, 0)),
            "Videos/2026/09-September"
        );
    }

    #[test]
    fn is_timezone_stable_at_month_boundaries() {
        assert_eq!(
            build_relative_media_dir(MediaKind::Photo, false, ts(2026, 10, 1, 0, 30, 0)),
            "Photos/2026/10-October"
        );
        assert_eq!(
            build_relative_media_dir(MediaKind::Photo, false, ts(2026, 1, 31, 23, 30, 0)),
            "Photos/2026/01-January"
        );
    }

    #[test]
    fn files_live_photo_video_beside_its_still_image() {
        let created = ts(2026, 9, 26, 12, 0, 0);
        let photo = build_relative_media_path(MediaKind::Photo, false, created, "IMG_1234.HEIC");
        let video = build_relative_media_path(MediaKind::Video, true, created, "IMG_1234.MOV");
        assert_eq!(photo, "Photos/2026/09-September/IMG_1234.HEIC");
        assert_eq!(video, "Photos/2026/09-September/IMG_1234.MOV");
    }

    #[test]
    fn does_not_misfile_an_ordinary_video() {
        assert_eq!(
            build_relative_media_path(MediaKind::Video, false, ts(2026, 9, 26, 0, 0, 0), "V.MOV"),
            "Videos/2026/09-September/V.MOV"
        );
    }

    #[test]
    fn storage_kind_only_special_cases_live_photo_videos() {
        assert_eq!(storage_kind(MediaKind::Photo, false), MediaKind::Photo);
        assert_eq!(storage_kind(MediaKind::Video, false), MediaKind::Video);
        assert_eq!(storage_kind(MediaKind::Video, true), MediaKind::Photo);
    }

    #[test]
    fn passes_normal_names_through() {
        assert_eq!(sanitize_filename("IMG_1234.HEIC"), "IMG_1234.heic");
        assert_eq!(sanitize_filename("IMG_0001.MOV"), "IMG_0001.mov");
    }

    #[test]
    fn strips_directory_components() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\me\\photo.jpg"), "photo.jpg");
    }

    #[test]
    fn replaces_forbidden_characters() {
        assert_eq!(
            sanitize_filename("a:b*c?d\"e<f>g|h.jpg"),
            "a_b_c_d_e_f_g_h.jpg"
        );
    }

    #[test]
    fn removes_control_characters() {
        assert_eq!(sanitize_filename("IMG\u{0}1234\u{1f}.HEIC"), "IMG1234.heic");
    }

    #[test]
    fn removes_trailing_dots_and_spaces() {
        assert_eq!(sanitize_filename("IMG_1234.HEIC..."), "IMG_1234.heic");
        assert_eq!(sanitize_filename("IMG_1234.HEIC   "), "IMG_1234.heic");
    }

    #[test]
    fn strips_leading_dots() {
        assert_eq!(sanitize_filename(".hidden.jpg"), "hidden.jpg");
        assert_eq!(sanitize_filename(".."), FALLBACK_STEM);
        assert_eq!(sanitize_filename("."), FALLBACK_STEM);
    }

    #[test]
    fn escapes_reserved_device_names() {
        assert_eq!(sanitize_filename("CON.HEIC"), "CON_.heic");
        assert_eq!(sanitize_filename("nul.jpg"), "nul_.jpg");
        assert_eq!(sanitize_filename("COM1"), "COM1_");
    }

    #[test]
    fn leaves_similar_names_alone() {
        assert_eq!(sanitize_filename("CONCERT.jpg"), "CONCERT.jpg");
    }

    #[test]
    fn falls_back_when_unusable() {
        assert_eq!(sanitize_filename(""), FALLBACK_STEM);
        assert_eq!(sanitize_filename("   "), FALLBACK_STEM);
        assert_eq!(sanitize_filename("///"), FALLBACK_STEM);
    }

    #[test]
    fn truncates_long_stems_but_keeps_extension() {
        let long = format!("{}.heic", "a".repeat(500));
        let result = sanitize_filename(&long);
        assert!(result.ends_with(".heic"));
        assert!(result.chars().count() <= MAX_STEM_CHARS + 5);
    }

    #[test]
    fn preserves_non_ascii() {
        assert_eq!(sanitize_filename("写真_2026.JPG"), "写真_2026.jpg");
    }

    #[test]
    fn is_idempotent() {
        let once = sanitize_filename("../../My Photo:1?.HEIC");
        assert_eq!(sanitize_filename(&once), once);
    }

    #[test]
    fn collision_suffix_goes_before_the_extension() {
        assert_eq!(
            with_collision_suffix("IMG_1234.heic", 2),
            "IMG_1234 (2).heic"
        );
        assert_eq!(
            with_collision_suffix("IMG_1234.heic", 37),
            "IMG_1234 (37).heic"
        );
        assert_eq!(with_collision_suffix("IMG_1234", 2), "IMG_1234 (2)");
        assert_eq!(with_collision_suffix("IMG_1234.heic", 1), "IMG_1234.heic");
    }

    #[test]
    fn resolves_collisions_against_a_set() {
        let empty = HashSet::new();
        assert_eq!(
            resolve_filename_collision("IMG_1.HEIC", &empty, false),
            "IMG_1.heic"
        );

        let taken: HashSet<String> = ["IMG_1.heic".to_string()].into_iter().collect();
        assert_eq!(
            resolve_filename_collision("IMG_1.HEIC", &taken, false),
            "IMG_1 (2).heic"
        );

        let many: HashSet<String> = ["IMG_1.heic".to_string(), "IMG_1 (2).heic".to_string()]
            .into_iter()
            .collect();
        assert_eq!(
            resolve_filename_collision("IMG_1.HEIC", &many, false),
            "IMG_1 (3).heic"
        );
    }

    #[test]
    fn collision_detection_is_case_insensitive_on_windows() {
        let taken: HashSet<String> = ["img_1.heic".to_string()].into_iter().collect();
        assert_eq!(
            resolve_filename_collision("IMG_1.HEIC", &taken, true),
            "IMG_1 (2).heic"
        );
    }

    #[test]
    fn resolve_under_root_rejects_traversal() {
        let root = Path::new("C:/backup");
        assert!(resolve_under_root(root, "Photos/2026/x.heic").is_ok());
        assert!(resolve_under_root(root, "../escape/x.heic").is_err());
        assert!(resolve_under_root(root, "Photos/../../escape").is_err());
    }
}
