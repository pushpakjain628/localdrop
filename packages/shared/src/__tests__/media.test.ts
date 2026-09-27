import {
  extensionOf,
  isSupportedExtension,
  mediaKindForFilename,
  mediaKindForPhAssetType,
  mediaKindForUti,
  mimeTypeForFilename,
  EXTENSION_TO_MEDIA_KIND,
} from '../media';

describe('extensionOf', () => {
  it('lowercases and drops the dot', () => {
    expect(extensionOf('IMG_1.HEIC')).toBe('heic');
    expect(extensionOf('a.b.c.MOV')).toBe('mov');
  });

  it('returns empty for no extension, a trailing dot, or a leading dot', () => {
    expect(extensionOf('IMG_1')).toBe('');
    expect(extensionOf('IMG_1.')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});

describe('mediaKindForFilename', () => {
  it('classifies the v1 supported formats', () => {
    expect(mediaKindForFilename('IMG_1.HEIC')).toBe('photo');
    expect(mediaKindForFilename('IMG_1.HEIF')).toBe('photo');
    expect(mediaKindForFilename('IMG_1.JPG')).toBe('photo');
    expect(mediaKindForFilename('IMG_1.JPEG')).toBe('photo');
    expect(mediaKindForFilename('IMG_1.PNG')).toBe('photo');
    expect(mediaKindForFilename('IMG_1.MOV')).toBe('video');
    expect(mediaKindForFilename('IMG_1.MP4')).toBe('video');
  });

  it('is case insensitive', () => {
    expect(mediaKindForFilename('img_1.HeIc')).toBe('photo');
  });

  it('returns null for unknown or absent extensions rather than guessing', () => {
    expect(mediaKindForFilename('IMG_1.RAF')).toBeNull();
    expect(mediaKindForFilename('IMG_1')).toBeNull();
    expect(mediaKindForFilename('')).toBeNull();
  });

  it('does not treat a directory dot as an extension', () => {
    expect(mediaKindForFilename('my.folder/IMG_1')).toBeNull();
  });
});

describe('mediaKindForUti', () => {
  it('maps the UTIs Photos actually reports', () => {
    expect(mediaKindForUti('public.heic', 'IMG_1.HEIC')).toBe('photo');
    expect(mediaKindForUti('public.jpeg', 'IMG_1.JPG')).toBe('photo');
    expect(mediaKindForUti('com.apple.quicktime-movie', 'IMG_1.MOV')).toBe('video');
    expect(mediaKindForUti('public.mpeg-4', 'IMG_1.MP4')).toBe('video');
  });

  it('falls back to the bare UTI when iOS reports a vendor-qualified variant', () => {
    expect(mediaKindForUti('com.apple.heic', 'IMG_1.HEIC')).toBe('photo');
  });

  it('falls back to the filename when the UTI is unknown', () => {
    expect(mediaKindForUti('com.acme.weird', 'IMG_1.MOV')).toBe('video');
  });

  it('returns null when neither the UTI nor the filename helps', () => {
    expect(mediaKindForUti('com.acme.weird', 'IMG_1.RAF')).toBeNull();
    expect(mediaKindForUti(null, undefined)).toBeNull();
  });
});

describe('mediaKindForPhAssetType', () => {
  it('maps PHAssetMediaType values', () => {
    expect(mediaKindForPhAssetType(1)).toBe('photo');
    expect(mediaKindForPhAssetType(2)).toBe('video');
  });

  it('returns null for the audio/other types v1 does not back up', () => {
    expect(mediaKindForPhAssetType(0)).toBeNull();
    expect(mediaKindForPhAssetType(3)).toBeNull();
  });
});

describe('mimeTypeForFilename', () => {
  it('maps supported extensions', () => {
    expect(mimeTypeForFilename('IMG_1.HEIC')).toBe('image/heic');
    expect(mimeTypeForFilename('IMG_1.MOV')).toBe('video/quicktime');
    expect(mimeTypeForFilename('IMG_1.MP4')).toBe('video/mp4');
  });

  it('falls back to octet-stream so an unknown type is still transferable', () => {
    expect(mimeTypeForFilename('IMG_1.RAF')).toBe('application/octet-stream');
  });
});

describe('isSupportedExtension', () => {
  it('accepts exactly the v1 format list', () => {
    for (const name of [
      'a.HEIC',
      'a.HEIF',
      'a.JPG',
      'a.JPEG',
      'a.PNG',
      'a.MOV',
      'a.MP4',
    ]) {
      expect(isSupportedExtension(name)).toBe(true);
    }
  });

  it('rejects formats v1 does not handle, so they are skipped visibly', () => {
    for (const name of ['a.RAF', 'a.CR2', 'a.NEF', 'a.GIF', 'a.TIFF', 'a']) {
      expect(isSupportedExtension(name)).toBe(false);
    }
  });
});

describe('extension table integrity', () => {
  it('has no duplicate extensions across kinds', () => {
    const seen = new Set<string>();
    for (const ext of Object.keys(EXTENSION_TO_MEDIA_KIND)) {
      expect(seen.has(ext)).toBe(false);
      seen.add(ext);
    }
  });
});
