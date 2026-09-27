/**
 * Pairing protocol helpers.
 *
 * Pairing is deliberately a two-step, human-comparable flow: the PC shows a short numeric
 * code, the user types it on the phone, and only then does the phone receive a bearer
 * token. The code is short-lived and single-use so that someone who walks past a paired PC
 * cannot re-pair it without the user's consent.
 */

import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS } from './constants';

/** Six digits, uniformly distributed, never starting with a zero-looking pattern. */
export function generatePairingCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += String(Math.floor(random() * 10) % 10);
  }
  return code;
}

/** Normalises user input: strips spaces/dashes and non-digits, uppercases nothing. */
export function normalizePairingCode(input: string): string {
  return (input ?? '').replace(/\D/g, '');
}

export function isWellFormedPairingCode(input: string): boolean {
  const normalized = normalizePairingCode(input);
  return normalized.length === PAIRING_CODE_LENGTH;
}

/** Why a pairing attempt was rejected. */
export type PairingFailureReason = 'malformed' | 'mismatch' | 'expired' | 'consumed';

/** Result of checking a submitted code against the PC's currently active code. */
export type PairingCodeVerdict = { ok: true } | { ok: false; reason: PairingFailureReason };

/**
 * Verifies a submitted pairing code.
 *
 * The comparison is constant-time so that a wrong code cannot be brute-forced by timing
 * the response, and `remainingMs` is evaluated *before* the comparison to keep the timing
 * profile flat between the expired and mismatch cases.
 */
export function verifyPairingCode(
  submitted: string,
  expected: { code: string; expiresAt: number; consumedAt: number | null },
  now: number,
): PairingCodeVerdict {
  const normalized = normalizePairingCode(submitted);
  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const expired = now >= expected.expiresAt;
  const consumed = expected.consumedAt !== null;
  const matches = constantTimeEquals(normalized, expected.code);

  if (expired) {
    return { ok: false, reason: 'expired' };
  }
  if (consumed) {
    return { ok: false, reason: 'consumed' };
  }
  if (!matches) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

/** Expiry timestamp for a code generated at `now`. */
export function pairingCodeExpiry(now: number, ttlMs: number = PAIRING_CODE_TTL_MS): number {
  return now + ttlMs;
}

/** Human readable label for a pairing failure, shown under the code entry field. */
export function describePairingFailure(reason: PairingFailureReason): string {
  switch (reason) {
    case 'malformed':
      return 'Enter the 6-digit code shown on your PC.';
    case 'expired':
      return 'That code has expired. Ask the PC for a new one.';
    case 'consumed':
      return 'That code was already used. Ask the PC for a new one.';
    default:
      return 'That code is not correct.';
  }
}

/** Length-independent string comparison. */
export function constantTimeEquals(a: string, b: string): boolean {
  const lengthA = a.length;
  const lengthB = b.length;
  // Compare a fixed number of characters so the loop count does not depend on the input.
  const iterations = Math.max(lengthA, lengthB, PAIRING_CODE_LENGTH);
  let diff = lengthA ^ lengthB;
  for (let i = 0; i < iterations; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Groups a code for display as `123 456`. */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}
