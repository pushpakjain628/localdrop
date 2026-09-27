/**
 * Filesystem-safe filenames and collision handling.
 *
 * Original names from iOS are almost always already valid (`IMG_1234.HEIC`), but a
 * receiving PC must never trust that: a name can contain path separators, Windows
 * reserved characters or reserved device names, and two different assets can legitimately
 * share a name after an import or a restore from another device.
 */

import { extensionOf } from './media';

/** Characters Windows forbids in a path segment. */
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/g;

/** ASCII control characters, which are invalid on both NTFS and APFS. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Reserved DOS device names. Windows refuses to create a *file* with these names even
 * with an extension, so `CON.HEIC` has to be renamed.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * NTFS caps a single path component at 255 UTF-16 code units. We stay well below that so
 * that the collision suffix added later still fits.
 */
const MAX_STEM_LENGTH = 180;

export const FALLBACK_FILENAME_STEM = 'LocalDrop_Asset';

/**
 * Reduces a string to something safe to use as a single path segment on Windows and
 * APFS. Never returns an empty string, a `.`/`..`, or a reserved device name.
 */
export function sanitizeFilenameSegment(input: string, fallback = FALLBACK_FILENAME_STEM): string {
  let name = (input ?? '').normalize('NFC');

  // Drop any directory component: a phone must never be able to influence the path the
  // PC writes to beyond the final segment.
  name = name.replace(/^.*[\\/]/, '');
  name = name.replace(WINDOWS_FORBIDDEN, '_');
  name = name.replace(CONTROL_CHARS, '');

  // Windows silently strips trailing dots and spaces, which would make a later lookup by
  // name fail. Remove them up front so the on-disk name matches what we recorded.
  name = name.replace(/[. ]+$/, '');

  // Leading dots would hide the file and confuse the `.`/`..` special cases.
  name = name.replace(/^\.+/, '');

  if (name.length === 0) {
    return fallback;
  }

  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  let stem = dot > 0 ? name.slice(0, dot) : name;

  if (stem.length === 0) {
    stem = fallback;
  }
  if (stem.length > MAX_STEM_LENGTH) {
    stem = stem.slice(0, MAX_STEM_LENGTH);
  }

  // Strip characters that are invalid in the stem only; the extension is preserved as-is
  // apart from being forced to lowercase so that `IMG_1.HEIC` and `IMG_1.heic` agree.
  stem = stem.replace(WINDOWS_FORBIDDEN, '_').replace(CONTROL_CHARS, '').replace(/[. ]+$/, '');
  if (stem.length === 0) {
    stem = fallback;
  }

  const safeExt = ext.replace(WINDOWS_FORBIDDEN, '');
  const result = safeExt.length > 0 ? `${stem}${safeExt.toLowerCase()}` : stem;

  const finalDot = result.lastIndexOf('.');
  const finalStem = finalDot > 0 ? result.slice(0, finalDot) : result;
  if (RESERVED_DEVICE_NAMES.has(finalStem.toLowerCase())) {
    return `${finalStem}_${safeExt ? safeExt.toLowerCase() : ''}`;
  }
  return result;
}

/**
 * Splits a sanitised filename into its stem and extension so collision suffixes can be
 * inserted in the right place (`IMG_1234 (2).HEIC`, not `IMG_1234.HEIC (2)`).
 */
export function splitFilename(filename: string): { stem: string; extension: string } {
  const ext = extensionOf(filename);
  if (ext.length === 0) {
    return { stem: filename, extension: '' };
  }
  return { stem: filename.slice(0, filename.length - ext.length - 1), extension: ext };
}

/** Builds `IMG_1234 (2).HEIC` for the given 1-based duplicate index. */
export function withCollisionSuffix(filename: string, index: number): string {
  if (index <= 1) {
    return filename;
  }
  const { stem, extension } = splitFilename(filename);
  return extension.length > 0 ? `${stem} (${index}).${extension}` : `${stem} (${index})`;
}

/**
 * Picks a filename that does not collide with anything already present.
 *
 * `isTaken` is called with candidate names and must answer whether that exact name already
 * exists in the destination folder. When it is a pure in-memory lookup the search is cheap;
 * callers that must hit the filesystem should pass a memoised predicate.
 *
 * The counter is bounded so a pathological folder cannot spin forever; past the bound we
 * fall back to a timestamped name, which is still deterministic within a single run.
 */
export function resolveFilenameCollision(
  desired: string,
  isTaken: (candidate: string) => boolean,
  maxAttempts = 1000,
): string {
  const safe = sanitizeFilenameSegment(desired);
  if (!isTaken(safe)) {
    return safe;
  }
  for (let index = 2; index <= maxAttempts; index += 1) {
    const candidate = withCollisionSuffix(safe, index);
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  return withCollisionSuffix(safe, Date.now());
}

/** Percent-encodes each path segment for use in a URL, keeping `/` separators intact. */
export function encodeRelativePath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
}
