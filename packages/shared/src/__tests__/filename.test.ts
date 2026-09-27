import {
  encodeRelativePath,
  resolveFilenameCollision,
  sanitizeFilenameSegment,
  splitFilename,
  withCollisionSuffix,
} from '../filename';

describe('sanitizeFilenameSegment', () => {
  it('passes a normal iOS filename through unchanged apart from extension casing', () => {
    expect(sanitizeFilenameSegment('IMG_1234.HEIC')).toBe('IMG_1234.heic');
    expect(sanitizeFilenameSegment('IMG_0001.MOV')).toBe('IMG_0001.mov');
  });

  it('strips directory components so a name can never escape the destination folder', () => {
    expect(sanitizeFilenameSegment('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilenameSegment('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFilenameSegment('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
  });

  it('replaces characters Windows forbids', () => {
    expect(sanitizeFilenameSegment('a:b*c?d"e<f>g|h.jpg')).toBe('a_b_c_d_e_f_g_h.jpg');
  });

  it('removes control characters', () => {
    expect(sanitizeFilenameSegment('IMG\u00001234\u001f.HEIC')).toBe('IMG1234.heic');
  });

  it('removes trailing dots and spaces, which Windows would strip anyway', () => {
    expect(sanitizeFilenameSegment('IMG_1234.HEIC...')).toBe('IMG_1234.heic');
    expect(sanitizeFilenameSegment('IMG_1234.HEIC   ')).toBe('IMG_1234.heic');
    expect(sanitizeFilenameSegment('trailing...  ')).toBe('trailing');
  });

  it('strips leading dots so files are not hidden and . / .. are impossible', () => {
    expect(sanitizeFilenameSegment('.hidden.jpg')).toBe('hidden.jpg');
    expect(sanitizeFilenameSegment('..')).toBe('LocalDrop_Asset');
    expect(sanitizeFilenameSegment('.')).toBe('LocalDrop_Asset');
  });

  it('escapes reserved DOS device names, which cannot be created as files on Windows', () => {
    expect(sanitizeFilenameSegment('CON.HEIC')).toBe('CON_.heic');
    expect(sanitizeFilenameSegment('nul.jpg')).toBe('nul_.jpg');
    expect(sanitizeFilenameSegment('COM1')).toBe('COM1_');
    expect(sanitizeFilenameSegment('lpt9.png')).toBe('lpt9_.png');
  });

  it('only escapes a reserved name when it is the whole stem', () => {
    // `CONCERT.jpg` is a perfectly legal file and must not be mangled.
    expect(sanitizeFilenameSegment('CONCERT.jpg')).toBe('CONCERT.jpg');
  });

  it('falls back to a usable name when the input is empty or unusable', () => {
    expect(sanitizeFilenameSegment('')).toBe('LocalDrop_Asset');
    expect(sanitizeFilenameSegment('   ')).toBe('LocalDrop_Asset');
    expect(sanitizeFilenameSegment('///')).toBe('LocalDrop_Asset');
    expect(sanitizeFilenameSegment('...')).toBe('LocalDrop_Asset');
  });

  it('truncates an over-long stem but keeps the extension', () => {
    const long = `${'a'.repeat(500)}.heic`;
    const result = sanitizeFilenameSegment(long);
    expect(result.endsWith('.heic')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(190);
  });

  it('leaves an extension-less name without adding one', () => {
    expect(sanitizeFilenameSegment('IMG_1234')).toBe('IMG_1234');
  });

  it('preserves non-ASCII names, which iOS commonly uses', () => {
    expect(sanitizeFilenameSegment('写真_2026.JPG')).toBe('写真_2026.jpg');
    expect(sanitizeFilenameSegment('Ünïcødé.png')).toBe('Ünïcødé.png');
  });

  it('is idempotent, so re-sanitising a stored name is a no-op', () => {
    const once = sanitizeFilenameSegment('../../My Photo:1?.HEIC');
    expect(sanitizeFilenameSegment(once)).toBe(once);
  });
});

describe('splitFilename', () => {
  it('splits stem and extension', () => {
    expect(splitFilename('IMG_1234.HEIC')).toEqual({ stem: 'IMG_1234', extension: 'heic' });
  });

  it('treats a dotfile as all stem', () => {
    expect(splitFilename('.hidden')).toEqual({ stem: '.hidden', extension: '' });
  });

  it('uses the last dot for multi-dot names', () => {
    expect(splitFilename('IMG_1234.ORIGINAL.HEIC')).toEqual({
      stem: 'IMG_1234.ORIGINAL',
      extension: 'heic',
    });
  });
});

describe('withCollisionSuffix', () => {
  it('inserts the counter before the extension', () => {
    expect(withCollisionSuffix('IMG_1234.HEIC', 2)).toBe('IMG_1234 (2).heic');
    expect(withCollisionSuffix('IMG_1234.HEIC', 37)).toBe('IMG_1234 (37).heic');
  });

  it('appends to an extension-less name', () => {
    expect(withCollisionSuffix('IMG_1234', 2)).toBe('IMG_1234 (2)');
  });

  it('is a no-op for the first copy', () => {
    expect(withCollisionSuffix('IMG_1234.HEIC', 1)).toBe('IMG_1234.HEIC');
  });
});

describe('resolveFilenameCollision', () => {
  it('returns the sanitized name when the folder is empty', () => {
    expect(resolveFilenameCollision('IMG_1.HEIC', () => false)).toBe('IMG_1.heic');
  });

  it('appends the first free counter', () => {
    const taken = new Set(['IMG_1.heic']);
    expect(resolveFilenameCollision('IMG_1.HEIC', (c) => taken.has(c))).toBe('IMG_1 (2).heic');
  });

  it('skips counters that are already taken', () => {
    const taken = new Set(['IMG_1.heic', 'IMG_1 (2).heic', 'IMG_1 (3).heic']);
    expect(resolveFilenameCollision('IMG_1.HEIC', (c) => taken.has(c))).toBe('IMG_1 (4).heic');
  });

  it('never returns a name that is already taken', () => {
    const taken = new Set<string>();
    for (let i = 1; i <= 50; i += 1) {
      taken.add(i === 1 ? 'IMG_1.heic' : `IMG_1 (${i}).heic`);
    }
    const result = resolveFilenameCollision('IMG_1.HEIC', (c) => taken.has(c));
    expect(taken.has(result)).toBe(false);
  });

  it('sanitizes before probing, so it never asks about an unsafe name', () => {
    const probed: string[] = [];
    resolveFilenameCollision('../../evil.HEIC', (c) => {
      probed.push(c);
      return false;
    });
    expect(probed).toEqual(['evil.heic']);
  });

  it('falls back to a timestamped name past the attempt bound instead of looping forever', () => {
    const result = resolveFilenameCollision('IMG_1.HEIC', () => true, 5);
    expect(result.startsWith('IMG_1 (')).toBe(true);
  });
});

describe('encodeRelativePath', () => {
  it('encodes each segment and preserves separators', () => {
    expect(encodeRelativePath('Photos/2026/09-September/IMG 1.HEIC')).toBe(
      'Photos/2026/09-September/IMG%201.HEIC',
    );
  });

  it('encodes non-ASCII names', () => {
    expect(encodeRelativePath('Photos/写真.jpg')).toBe('Photos/%E5%86%99%E7%9C%9F.jpg');
  });

  it('drops empty segments', () => {
    expect(encodeRelativePath('Photos//2026/')).toBe('Photos/2026');
  });
});
