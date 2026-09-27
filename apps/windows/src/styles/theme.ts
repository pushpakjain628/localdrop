/**
 * Dashboard design tokens.
 *
 * The Windows app is a status display first: a user glances at it to answer "is my backup
 * running, how fast, and is there room". So the palette is a calm neutral surface with a
 * single accent, and colour is reserved for state (live / ok / warning / error) rather than
 * decoration.
 *
 * Depth comes from shadow and background steps rather than borders. A border on every panel
 * turns a screen full of cards into a grid of boxes; a soft shadow on a white surface reads as
 * the same thing with none of the noise, and it is what makes the pairing code - the one thing
 * the user came here to do - the thing the eye lands on.
 */

export const colors = {
  /** The canvas. Cool and slightly darker than the cards, so they lift without a border. */
  bg: '#eef1f6',
  surface: '#ffffff',
  surfaceMuted: '#f5f7fa',
  /** Kept for the few places that genuinely need a line: inputs and table rules. */
  border: '#e2e7ef',
  borderStrong: '#cdd5e1',

  text: '#0f1622',
  textMuted: '#59657a',
  textFaint: '#8b95a6',
  textInverse: '#ffffff',

  accent: '#2f6fed',
  accentHover: '#2560d4',
  accentSoft: '#e8f0ff',
  accentBorder: '#c3d8ff',

  success: '#0f7a4f',
  successSoft: '#e3f5ec',
  warning: '#a35c00',
  warningSoft: '#fdf0dc',
  danger: '#c0392f',
  dangerSoft: '#fbe9e7',
  live: '#0f7a4f',
} as const;

export const radii = {
  xs: '4px',
  sm: '6px',
  md: '10px',
  lg: '16px',
  xl: '20px',
  pill: '999px',
} as const;

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
} as const;

/**
 * Type scale.
 *
 * Named rather than inlined so the hierarchy is a decision in one place. `metric` is the one
 * that matters: the pairing code, a transfer rate and a byte total are all read as single
 * values, so they share a size, a weight and - critically - tabular figures. Without
 * `fontVariantNumeric` a countdown like 4:38 visibly jitters as the digits change width, which
 * on a status display is the kind of thing a user notices without knowing why it is annoying.
 */
export const type = {
  display: { fontSize: 44, fontWeight: 700, letterSpacing: 2, lineHeight: 1.05 },
  metric: {
    fontSize: 20,
    fontWeight: 680,
    lineHeight: 1.25,
    fontVariantNumeric: 'tabular-nums',
  },
  title: { fontSize: 15, fontWeight: 660, letterSpacing: -0.1 },
  body: { fontSize: 13.5, lineHeight: 1.55 },
  label: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  caption: { fontSize: 12, color: colors.textMuted },
} as const;

export const font = {
  family:
    '"Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"Cascadia Mono", "Consolas", ui-monospace, monospace',
} as const;

export const shadows = {
  /** Cards sit on the canvas by shadow alone - no border. */
  card: '0 1px 2px rgba(15, 22, 34, 0.05), 0 4px 12px rgba(15, 22, 34, 0.05)',
  /** The pairing code, which is the one element allowed to sit above the rest. */
  raised: '0 2px 4px rgba(15, 22, 34, 0.06), 0 8px 24px rgba(15, 22, 34, 0.08)',
} as const;
