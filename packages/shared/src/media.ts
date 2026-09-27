/**
 * Media classification.
 *
 * The iOS side classifies with `PHAssetMediaType` + the asset's UTI/filename; the Windows
 * side classifies with the filename extension it received. Both must agree, otherwise an
 * asset could be filed under the wrong top-level folder.
 */

/** The two top-level folders the backup library is organised into. */
export type MediaKind = 'photo' | 'video';

export const MEDIA_KINDS: readonly MediaKind[] = ['photo', 'video'] as const;

/** Human readable singular/plural labels used across both UIs. */
export const MEDIA_KIND_LABELS: Record<MediaKind, { singular: string; plural: string }> = {
  photo: { singular: 'Photo', plural: 'Photos' },
  video: { singular: 'Video', plural: 'Videos' },
};

/** `PHAssetMediaType.image` */
export const PH_ASSET_MEDIA_TYPE_IMAGE = 1;
/** `PHAssetMediaType.video` */
export const PH_ASSET_MEDIA_TYPE_VIDEO = 2;

/** Uniform Type Identifiers we accept from Photos, mapped to a media kind. */
export const UTI_TO_MEDIA_KIND: Readonly<Record<string, MediaKind>> = {
  'public.heic': 'photo',
  'public.heif': 'photo',
  'public.jpeg': 'photo',
  'public.png': 'photo',
  'public.tiff': 'photo',
  'com.compuserve.gif': 'photo',
  'public.mpeg-4': 'video',
  'com.apple.quicktime-movie': 'video',
  'com.apple.m4v-video': 'video',
  'public.avi': 'video',
  'com.microsoft.avi': 'video',
};

/** Extensions we are willing to back up in v1, mapped to a media kind. */
export const EXTENSION_TO_MEDIA_KIND: Readonly<Record<string, MediaKind>> = {
  heic: 'photo',
  heif: 'photo',
  jpg: 'photo',
  jpeg: 'photo',
  png: 'photo',
  gif: 'photo',
  tif: 'photo',
  tiff: 'photo',
  mov: 'video',
  mp4: 'video',
  m4v: 'video',
};

/**
 * Extensions backed up in v1. Anything else is skipped by the phone with a clear reason
 * rather than being silently dropped.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  'heic',
  'heif',
  'jpg',
  'jpeg',
  'png',
  'mov',
  'mp4',
] as const;

/** MIME types for the supported extensions, used as upload content types. */
export const EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  heic: 'image/heic',
  heif: 'image/heif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
};

/** Lowercased extension without the dot, or `''` when there is none. */
export function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return '';
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

/** Classifies a filename by extension. Returns `null` for unknown/absent extensions. */
export function mediaKindForFilename(filename: string): MediaKind | null {
  return EXTENSION_TO_MEDIA_KIND[extensionOf(filename)] ?? null;
}

/** Classifies a UTI. Falls back to the filename when the UTI is unknown. */
export function mediaKindForUti(uti: string | null | undefined, filename?: string): MediaKind | null {
  if (uti) {
    const byUti = UTI_TO_MEDIA_KIND[uti.toLowerCase()];
    if (byUti) {
      return byUti;
    }
    // Some iOS versions report vendor UTIs such as `com.apple.live-photo-bundle`;
    // strip the vendor prefix and try again before giving up on the UTI.
    const withoutVendor = uti.includes('.') ? uti.slice(uti.indexOf('.') + 1) : uti;
    const byBareUti = UTI_TO_MEDIA_KIND[withoutVendor.toLowerCase()];
    if (byBareUti) {
      return byBareUti;
    }
  }
  return filename ? mediaKindForFilename(filename) : null;
}

/** Maps a `PHAssetMediaType` raw value to a media kind. */
export function mediaKindForPhAssetType(phAssetMediaType: number): MediaKind | null {
  if (phAssetMediaType === PH_ASSET_MEDIA_TYPE_IMAGE) {
    return 'photo';
  }
  if (phAssetMediaType === PH_ASSET_MEDIA_TYPE_VIDEO) {
    return 'video';
  }
  return null;
}

/** Content type to send with an upload, defaulting to `application/octet-stream`. */
export function mimeTypeForFilename(filename: string): string {
  return EXTENSION_TO_MIME[extensionOf(filename)] ?? 'application/octet-stream';
}

/** True when the extension is one of the formats v1 supports. */
export function isSupportedExtension(filename: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}
