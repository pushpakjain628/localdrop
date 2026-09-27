import {
  buildRelativeMediaDir,
  buildRelativeMediaPath,
  buildRelativeAssetPath,
  livePhotoBaseName,
  resolveStorageKind,
  TOP_LEVEL_FOLDER,
} from '../naming';
import { monthFolder, yearFolder } from '../dates';

describe('buildRelativeMediaDir', () => {
  it('matches the documented layout for a photo', () => {
    expect(buildRelativeMediaDir('photo', new Date('2026-09-26T12:00:00Z'))).toBe(
      'Photos/2026/09-September',
    );
  });

  it('uses the Videos folder for videos', () => {
    expect(buildRelativeMediaDir('video', new Date('2026-09-26T12:00:00Z'))).toBe(
      'Videos/2026/09-September',
    );
  });

  it('is timezone-stable: late-evening UTC does not roll into the next month', () => {
    // 2026-10-01T00:30Z. A local-time implementation in UTC+2 would file this under
    // September, producing a different folder on the phone than on the PC.
    const date = new Date('2026-10-01T00:30:00Z');
    expect(buildRelativeMediaDir('photo', date)).toBe('Photos/2026/10-October');
  });

  it('groups by the asset creation month, not the backup month', () => {
    const created = new Date('2024-02-29T23:59:59Z');
    expect(buildRelativeMediaDir('photo', created)).toBe('Photos/2024/02-February');
  });

  it('handles the single-digit months that are easiest to get wrong', () => {
    for (const [month, name] of [
      ['01', 'January'],
      ['02', 'February'],
      ['03', 'March'],
      ['04', 'April'],
      ['05', 'May'],
      ['06', 'June'],
      ['07', 'July'],
      ['08', 'August'],
      ['09', 'September'],
      ['10', 'October'],
      ['11', 'November'],
      ['12', 'December'],
    ] as const) {
      const date = new Date(`2026-${month}-15T00:00:00Z`);
      expect(buildRelativeMediaDir('photo', date)).toBe(`Photos/2026/${month}-${name}`);
    }
  });

  it('pads single-digit months and years consistently', () => {
    expect(monthFolder(new Date('2026-03-05T00:00:00Z'))).toBe('03-March');
    expect(yearFolder(new Date('2026-03-05T00:00:00Z'))).toBe('2026');
  });

  it('exposes a distinct top-level folder per media kind', () => {
    expect(TOP_LEVEL_FOLDER.photo).toBe('Photos');
    expect(TOP_LEVEL_FOLDER.video).toBe('Videos');
  });
});

describe('buildRelativeMediaPath', () => {
  it('joins the folder and the original filename', () => {
    expect(buildRelativeMediaPath('photo', new Date('2026-09-26T00:00:00Z'), 'IMG_1234.HEIC')).toBe(
      'Photos/2026/09-September/IMG_1234.HEIC',
    );
  });

  it('keeps both components of a Live Photo in the same folder', () => {
    const created = new Date('2026-09-26T00:00:00Z');
    const photo = buildRelativeAssetPath({
      mediaType: 'photo',
      createdAt: created,
      filename: 'IMG_1234.HEIC',
    });
    const video = buildRelativeAssetPath({
      mediaType: 'video',
      isLivePhotoVideo: true,
      createdAt: created,
      filename: 'IMG_1234.MOV',
    });
    expect(photo).toBe('Photos/2026/09-September/IMG_1234.HEIC');
    // The video half is filed beside its still image rather than under Videos/, otherwise
    // the pair the user sees in Photos would be split across two trees on disk.
    expect(video).toBe('Photos/2026/09-September/IMG_1234.MOV');
  });

  it('does not misfile an ordinary video as a Live Photo half', () => {
    const created = new Date('2026-09-26T00:00:00Z');
    expect(
      buildRelativeAssetPath({
        mediaType: 'video',
        isLivePhotoVideo: false,
        createdAt: created,
        filename: 'IMG_9999.MOV',
      }),
    ).toBe('Videos/2026/09-September/IMG_9999.MOV');
  });
});

describe('resolveStorageKind', () => {
  it('uses the media kind as-is for ordinary assets', () => {
    expect(resolveStorageKind({ mediaType: 'photo' })).toBe('photo');
    expect(resolveStorageKind({ mediaType: 'video', isLivePhotoVideo: false })).toBe('video');
  });

  it('files a Live Photo video half under Photos', () => {
    expect(resolveStorageKind({ mediaType: 'video', isLivePhotoVideo: true })).toBe('photo');
  });

  it('treats a null/undefined flag as an ordinary asset', () => {
    expect(resolveStorageKind({ mediaType: 'video', isLivePhotoVideo: null })).toBe('video');
    expect(resolveStorageKind({ mediaType: 'video', isLivePhotoVideo: undefined })).toBe('video');
  });
});

describe('livePhotoBaseName', () => {
  it('drops the extension so both halves share a base', () => {
    expect(livePhotoBaseName('IMG_1234.HEIC')).toBe('IMG_1234');
    expect(livePhotoBaseName('IMG_1234.MOV')).toBe('IMG_1234');
  });

  it('leaves an extension-less name untouched', () => {
    expect(livePhotoBaseName('IMG_1234')).toBe('IMG_1234');
  });
});
