import {
  constantTimeEquals,
  describePairingFailure,
  formatPairingCode,
  generatePairingCode,
  isWellFormedPairingCode,
  normalizePairingCode,
  pairingCodeExpiry,
  verifyPairingCode,
} from '../pairing';
import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS } from '../constants';

const NOW = 1_700_000_000_000;

function activeCode(code = '123456', overrides: Partial<{ expiresAt: number; consumedAt: number | null }> = {}) {
  return {
    code,
    expiresAt: overrides.expiresAt ?? pairingCodeExpiry(NOW),
    consumedAt: overrides.consumedAt ?? null,
  };
}

describe('generatePairingCode', () => {
  it('always produces the configured number of digits', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePairingCode()).toMatch(/^\d{6}$/);
    }
  });

  it('is driven entirely by the injected RNG, which is what makes it testable', () => {
    expect(generatePairingCode(() => 0)).toBe('000000');
    expect(generatePairingCode(() => 0.999999)).toBe('999999');
  });

  it('produces different codes across calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('normalizePairingCode', () => {
  it('strips the separators a user is likely to type', () => {
    expect(normalizePairingCode('123 456')).toBe('123456');
    expect(normalizePairingCode('123-456')).toBe('123456');
    expect(normalizePairingCode(' 123456 ')).toBe('123456');
  });

  it('drops any other non-digit, including letters pasted in by mistake', () => {
    expect(normalizePairingCode('12a3b4c5d6')).toBe('123456');
  });

  it('tolerates nullish input', () => {
    expect(normalizePairingCode(undefined as unknown as string)).toBe('');
  });
});

describe('isWellFormedPairingCode', () => {
  it('accepts a code with or without separators', () => {
    expect(isWellFormedPairingCode('123456')).toBe(true);
    expect(isWellFormedPairingCode('123 456')).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isWellFormedPairingCode('12345')).toBe(false);
    expect(isWellFormedPairingCode('1234567')).toBe(false);
  });
});

describe('verifyPairingCode', () => {
  it('accepts the correct active code', () => {
    expect(verifyPairingCode('123456', activeCode('123456'), NOW)).toEqual({ ok: true });
  });

  it('accepts a code typed with separators', () => {
    expect(verifyPairingCode('123 456', activeCode('123456'), NOW)).toEqual({ ok: true });
  });

  it('rejects a wrong code as a mismatch', () => {
    expect(verifyPairingCode('654321', activeCode('123456'), NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a malformed code before comparing', () => {
    expect(verifyPairingCode('12', activeCode('123456'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyPairingCode('abcdef', activeCode('123456'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an expired code, including exactly at the expiry instant', () => {
    const expiresAt = pairingCodeExpiry(NOW);
    expect(verifyPairingCode('123456', activeCode('123456', { expiresAt }), expiresAt)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyPairingCode('123456', activeCode('123456', { expiresAt }), expiresAt - 1)).toEqual({
      ok: true,
    });
  });

  it('rejects an already-consumed code so it cannot be replayed', () => {
    expect(verifyPairingCode('123456', activeCode('123456', { consumedAt: NOW - 1 }), NOW)).toEqual({
      ok: false,
      reason: 'consumed',
    });
  });

  it('reports expiry ahead of consumption, matching the display order in the UI', () => {
    const consumed = activeCode('123456', { expiresAt: NOW - 1, consumedAt: NOW - 2 });
    expect(verifyPairingCode('123456', consumed, NOW)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('pairingCodeExpiry', () => {
  it('defaults to the configured TTL', () => {
    expect(pairingCodeExpiry(NOW)).toBe(NOW + PAIRING_CODE_TTL_MS);
  });

  it('honours an explicit TTL', () => {
    expect(pairingCodeExpiry(NOW, 1000)).toBe(NOW + 1000);
  });
});

describe('describePairingFailure', () => {
  it('gives an actionable message for every failure reason', () => {
    for (const reason of ['malformed', 'mismatch', 'expired', 'consumed'] as const) {
      const message = describePairingFailure(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message.endsWith('.')).toBe(true);
    }
  });
});

describe('constantTimeEquals', () => {
  it('compares equal strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('rejects strings of different length', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('formatPairingCode', () => {
  it('groups the digits for readability', () => {
    expect(formatPairingCode('123456')).toBe('123 456');
    expect(formatPairingCode('123 456')).toBe('123 456');
  });

  it('leaves an incomplete code alone so it can be typed progressively', () => {
    expect(formatPairingCode('123')).toBe('123');
    expect(formatPairingCode('')).toBe('');
  });
});

describe('code length coupling', () => {
  it('keeps the generator and the validator in step', () => {
    expect(generatePairingCode().length).toBe(PAIRING_CODE_LENGTH);
    expect(isWellFormedPairingCode(generatePairingCode())).toBe(true);
  });
});
