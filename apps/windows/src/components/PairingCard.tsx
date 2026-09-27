import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatPairingCode } from '@localdrop/shared';
import { colors, font, radii, spacing, type } from '../styles/theme';
import { formatCountdown } from '../lib/format';
import { Button, Card } from './ui';

interface PairingCardProps {
  code: string | null;
  expiresAt: number | null;
  onRotate: () => Promise<void> | void;
  busy: boolean;
  error: string | null;
}

/**
 * The pairing code, sized to be read off the screen and typed on a phone across the room.
 *
 * The countdown is the reason this card is prominent: a code that silently expires while the
 * user is walking over to their phone is the most common way pairing appears to be broken.
 */
export function PairingCard({ code, expiresAt, onRotate, busy, error }: PairingCardProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const remaining = expiresAt === null ? null : formatCountdown(expiresAt, now);
  const expired = code !== null && remaining === null;

  return (
    <Card
      title="Pair an iPhone"
      subtitle="On the iPhone, tap the PC name and enter this code."
      actions={
        <Button onClick={() => void onRotate()} disabled={busy}>
          {busy ? 'Generating…' : 'New code'}
        </Button>
      }
    >
      {error ? (
        <p style={styles.error}>{error}</p>
      ) : code === null ? (
        <p style={styles.muted}>Waiting for a pairing code…</p>
      ) : expired ? (
        <div style={styles.expiredBox}>
          <p style={styles.expiredTitle}>This code has expired</p>
          <p style={styles.muted}>Generate a new one to pair another device.</p>
        </div>
      ) : (
        <div style={styles.codeBox}>
          <div style={styles.code} aria-label={`Pairing code ${formatPairingCode(code)}`}>
            {formatPairingCode(code)}
          </div>
          <div style={styles.countdown}>
            Expires in <strong style={styles.timer}>{remaining}</strong>
          </div>
        </div>
      )}
    </Card>
  );
}
const styles: Record<string, CSSProperties> = {
  // Centred and stacked, not a row. The code is the one thing a user walks over to the phone to
  // read, so it is treated as a hero: big, centred, with the countdown as a caption underneath
  // rather than competing for the same line.
  codeBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.sm,
    padding: `${spacing.xl}px ${spacing.xl}px ${spacing.lg}px`,
    background: colors.accentSoft,
    border: `1px solid ${colors.accentBorder}`,
    borderRadius: radii.lg,
  },
  code: {
    ...type.display,
    fontFamily: font.mono,
    color: colors.accent,
    // Wide tracking is what makes six digits read as three groups rather than one smear. The
    // format function already inserts a space; this separates the glyphs within each group.
    letterSpacing: 8,
    paddingLeft: 8,
  },
  countdown: { fontSize: 12.5, color: colors.textMuted },
  timer: { fontFamily: font.mono, color: colors.text, fontVariantNumeric: 'tabular-nums' },
  expiredBox: {
    padding: spacing.lg,
    background: colors.warningSoft,
    borderRadius: radii.md,
  },
  expiredTitle: { margin: 0, fontWeight: 650, color: colors.warning },
  muted: { margin: 0, color: colors.textMuted, fontSize: 13 },
  error: { margin: 0, color: colors.danger, fontSize: 13 },
};
