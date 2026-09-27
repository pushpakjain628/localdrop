/**
 * Backup library layout.
 *
 * ```
 * <backup dir>/
 *   Photos/2026/09-September/IMG_1234.HEIC
 *   Photos/2026/09-September/IMG_1234.MOV        <- paired Live Photo component
 *   Videos/2026/09-September/IMG_5678.MOV
 * ```
 *
 * The layout is computed on the phone (so the phone can show the destination before
 * uploading) and independently re-derived on the PC, which is the authority for the final
 * on-disk location. Both use these pure functions so the two can never drift.
 */

import { monthFolder, yearFolder } from './dates';
import type { MediaKind } from './media';

/** Top-level folder name for each media kind. */
export const TOP_LEVEL_FOLDER: Record<MediaKind, string> = {
  photo: 'Photos',
  video: 'Videos',
};

/**
 * `Photos/2026/09-September`
 *
 * Uses UTC deliberately: the folder must be identical on both machines regardless of the
 * phone's or the PC's timezone. The asset's own creation timestamp is what the user
 * remembers, and a UTC-stable grouping is at least reproducible.
 */
export function buildRelativeMediaDir(kind: MediaKind, createdAt: Date): string {
  return `${TOP_LEVEL_FOLDER[kind]}/${yearFolder(createdAt)}/${monthFolder(createdAt)}`;
}

/** `Photos/2026/09-September/IMG_1234.HEIC` */
export function buildRelativeMediaPath(
  kind: MediaKind,
  createdAt: Date,
  filename: string,
): string {
  return `${buildRelativeMediaDir(kind, createdAt)}/${filename}`;
}

/**
 * Decides which top-level folder an asset belongs in.
 *
 * A Live Photo is stored as two files that iOS names `IMG_1234.HEIC` and `IMG_1234.MOV`.
 * Filing the video half under `Videos/` would split the pair across two trees, so the
 * relationship the user sees in Photos would not survive on disk and neither half would be
 * findable from the other. The video half is therefore filed beside its still image, under
 * `Photos/`, and the database links the two via `live_photo_id`.
 *
 * The *media* kind reported to the UI and stored in the `media_type` column is still
 * `video`; only the folder placement changes.
 */
export function resolveStorageKind(input: {
  mediaType: MediaKind;
  isLivePhotoVideo?: boolean | null;
}): MediaKind {
  return input.isLivePhotoVideo ? 'photo' : input.mediaType;
}

/** Relative path for an asset, honouring the Live Photo placement rule. */
export function buildRelativeAssetPath(input: {
  mediaType: MediaKind;
  isLivePhotoVideo?: boolean | null;
  createdAt: Date;
  filename: string;
}): string {
  return buildRelativeMediaPath(
    resolveStorageKind(input),
    input.createdAt,
    input.filename,
  );
}

/** Top-level folder for an arbitrary relative path, used when grouping history rows. */
export function topLevelFolderOf(relativePath: string): string {
  return relativePath.split('/')[0] ?? '';
}

/**
 * Base name shared by both halves of a Live Photo.
 *
 * iOS names the pair `IMG_1234.HEIC` / `IMG_1234.MOV`. We keep the original stems so the
 * relationship survives on disk, but the two files must not be allowed to collide with
 * unrelated assets, so the base name is derived from the *photo* component of the pair and
 * both components are written next to each other in the same folder.
 */
export function livePhotoBaseName(photoFilename: string): string {
  const dot = photoFilename.lastIndexOf('.');
  return dot > 0 ? photoFilename.slice(0, dot) : photoFilename;
}
