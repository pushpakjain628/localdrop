import type { CSSProperties, ReactNode } from 'react';
import { colors, radii, shadows, spacing } from '../styles/theme';
import { toneColors, type Tone } from '../lib/format';

/* ------------------------------------------------------------------ primitives */

export function Card({
  title,
  subtitle,
  actions,
  children,
  padded = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section style={styles.card}>
      {(title || actions) && (
        <header style={styles.cardHeader}>
          <div>
            {title && <h2 style={styles.cardTitle}>{title}</h2>}
            {subtitle && <p style={styles.cardSubtitle}>{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div style={padded ? styles.cardBody : undefined}>{children}</div>
    </section>
  );
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const { fg, bg } = toneColors(tone);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: radii.pill,
        background: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const palette = {
    primary: { bg: colors.accent, fg: colors.textInverse, border: colors.accent },
    secondary: { bg: colors.surface, fg: colors.text, border: colors.borderStrong },
    ghost: { bg: 'transparent', fg: colors.textMuted, border: 'transparent' },
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...styles.button,
        background: palette.bg,
        color: palette.fg,
        borderColor: palette.border,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function ProgressBar({
  fraction,
  tone = 'accent',
  indeterminate = false,
}: {
  fraction: number;
  tone?: Tone;
  indeterminate?: boolean;
}) {
  const clamped = Math.min(Math.max(Number.isFinite(fraction) ? fraction : 0, 0), 1);
  const { fg } = toneColors(tone);
  return (
    <div
      style={styles.progressTrack}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        style={{
          ...styles.progressFill,
          width: indeterminate ? '35%' : `${clamped * 100}%`,
          background: fg,
          animation: indeterminate ? 'localdrop-indeterminate 1.2s ease-in-out infinite' : undefined,
        }}
      />
      <style>{`
        @keyframes localdrop-indeterminate {
          0%   { margin-left: 0%; }
          50%  { margin-left: 65%; }
          100% { margin-left: 0%; }
        }
      `}</style>
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div style={styles.statTile}>
      <span style={styles.statLabel}>{label}</span>
      <span style={{ ...styles.statValue, color: tone === 'neutral' ? colors.text : toneColors(tone).fg }}>
        {value}
      </span>
      {hint && <span style={styles.statHint}>{hint}</span>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={styles.empty}>
      <p style={{ margin: 0, fontWeight: 600, color: colors.textMuted }}>{title}</p>
      {hint && <p style={{ margin: `${spacing.xs}px 0 0`, color: colors.textFaint }}>{hint}</p>}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div style={styles.errorBanner} role="alert">
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ styles */

const styles: Record<string, CSSProperties> = {
  card: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.lg,
    boxShadow: shadows.card,
    overflow: 'hidden',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: `${spacing.lg}px ${spacing.lg}px ${spacing.md}px`,
    borderBottom: `1px solid ${colors.border}`,
  },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 650 },
  cardSubtitle: { margin: '2px 0 0', fontSize: 12.5, color: colors.textMuted },
  cardBody: { padding: spacing.lg },
  button: {
    padding: '7px 14px',
    borderRadius: radii.sm,
    border: '1px solid',
    fontSize: 13,
    fontWeight: 600,
    transition: 'filter 120ms ease',
  },
  progressTrack: {
    position: 'relative',
    height: 8,
    borderRadius: radii.pill,
    background: colors.surfaceMuted,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.pill,
    transition: 'width 180ms linear',
  },
  statTile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: `${spacing.md}px ${spacing.lg}px`,
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.md,
  },
  statLabel: {
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: colors.textFaint,
  },
  statValue: { fontSize: 20, fontWeight: 680, lineHeight: 1.25 },
  statHint: { fontSize: 12, color: colors.textMuted },
  empty: {
    padding: `${spacing.xl}px`,
    textAlign: 'center',
    background: colors.surfaceMuted,
    borderRadius: radii.md,
  },
  errorBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    padding: `${spacing.md}px ${spacing.lg}px`,
    background: colors.dangerSoft,
    color: colors.danger,
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 13,
    fontWeight: 550,
  },
};
