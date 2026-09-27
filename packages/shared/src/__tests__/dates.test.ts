import { formatBytes, formatDuration, parseIsoTimestamp, toIsoDate, toIsoTimestamp } from '../dates';

describe('toIsoDate', () => {
  it('formats a UTC date', () => {
    expect(toIsoDate(new Date('2026-09-26T17:57:03Z'))).toBe('2026-09-26');
  });

  it('zero-pads single digit months and days', () => {
    expect(toIsoDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});

describe('toIsoTimestamp', () => {
  it('emits a full millisecond-precision UTC timestamp', () => {
    expect(toIsoTimestamp(new Date('2026-09-26T17:57:03.042Z'))).toBe('2026-09-26T17:57:03.042Z');
  });

  it('round-trips through parseIsoTimestamp', () => {
    const iso = toIsoTimestamp(new Date('2026-09-26T17:57:03.042Z'));
    expect(parseIsoTimestamp(iso)?.toISOString()).toBe('2026-09-26T17:57:03.042Z');
  });
});

describe('parseIsoTimestamp', () => {
  it('returns null for missing or unparseable values rather than an Invalid Date', () => {
    expect(parseIsoTimestamp(null)).toBeNull();
    expect(parseIsoTimestamp(undefined)).toBeNull();
    expect(parseIsoTimestamp('')).toBeNull();
    expect(parseIsoTimestamp('not a date')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('handles multi-gigabyte video files', () => {
    expect(formatBytes(4_294_967_296)).toBe('4.0 GB');
  });

  it('renders an em dash for values a progress bar can produce mid-flight', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(599)).toBe('9:59');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('renders an em dash for an unknown remaining time', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});
