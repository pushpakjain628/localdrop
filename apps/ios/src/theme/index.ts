/**
 * Design tokens.
 *
 * A consumer backup app should feel calm and obvious: one accent colour, generous spacing, and
 * typography that scales cleanly from a 4-inch SE to a Pro Max. Everything visual is defined
 * here so a screen never hard-codes a hex value.
 */

import { Platform, type TextStyle } from 'react-native';

export const palette = {
  // Neutrals, warm-leaning so photos (which are almost always the content) sit comfortably.
  white: '#ffffff',
  canvas: '#f6f7fb',
  surface: '#ffffff',
  surfaceMuted: '#f0f2f7',
  surfaceSunken: '#e8ebf2',

  border: '#e2e6ee',
  borderStrong: '#cdd4e0',

  ink: '#111726',
  inkMuted: '#5a6478',
  inkFaint: '#8b94a6',
  inkInverse: '#ffffff',

  accent: '#2f6fed',
  accentPressed: '#2559c9',
  accentSoft: '#e8f0ff',

  success: '#0f8a58',
  successSoft: '#e2f5ec',
  warning: '#b26a00',
  warningSoft: '#fdf1dd',
  danger: '#c0392f',
  dangerSoft: '#fceceb',

  overlay: 'rgba(17, 23, 38, 0.45)',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 44,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  pill: 999,
} as const;

/**
 * Type scale.
 *
 * `fontFamily` is left to the system font (San Francisco) on purpose: it is the only font that
 * has the right optical sizes, and it renders CJK filenames - which iOS photo libraries are full
 * of - without falling back to a mismatched face.
 */
export const type: Record<
  'display' | 'title' | 'heading' | 'body' | 'callout' | 'caption' | 'mono',
  TextStyle
> = {
  display: { fontSize: 34, fontWeight: '700', letterSpacing: -0.6, color: palette.ink },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.35, color: palette.ink },
  heading: { fontSize: 19, fontWeight: '600', letterSpacing: -0.2, color: palette.ink },
  body: { fontSize: 16, fontWeight: '400', color: palette.ink, lineHeight: 22 },
  callout: { fontSize: 14, fontWeight: '500', color: palette.inkMuted, lineHeight: 19 },
  caption: { fontSize: 12, fontWeight: '500', color: palette.inkFaint, lineHeight: 16 },
  mono: {
    fontSize: 13,
    color: palette.inkMuted,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
};

/** Minimum touch target, per the iOS HIG. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 44;

export const shadow = {
  card: Platform.select({
    ios: {
      shadowColor: '#0b1220',
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    default: { elevation: 2 },
  }) as object,
  raised: Platform.select({
    ios: {
      shadowColor: '#0b1220',
      shadowOpacity: 0.12,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 10 },
    },
    default: { elevation: 8 },
  }) as object,
};

/** Semantic colours for a transfer state, so every screen agrees. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export const tones: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: palette.inkMuted, bg: palette.surfaceMuted },
  accent: { fg: palette.accent, bg: palette.accentSoft },
  success: { fg: palette.success, bg: palette.successSoft },
  warning: { fg: palette.warning, bg: palette.warningSoft },
  danger: { fg: palette.danger, bg: palette.dangerSoft },
};
