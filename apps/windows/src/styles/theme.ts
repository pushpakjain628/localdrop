/**
 * Dashboard design tokens.
 *
 * The Windows app is a status display first: a user glances at it to answer "is my backup
 * running, how fast, and is there room". So the palette is a calm neutral surface with a
 * single accent, and colour is reserved for state (live / ok / warning / error) rather than
 * decoration.
 */

export const colors = {
  bg: '#f4f6fa',
  surface: '#ffffff',
  surfaceMuted: '#eef1f6',
  border: '#dde3ec',
  borderStrong: '#c3ccdb',

  text: '#131a26',
  textMuted: '#5b6779',
  textFaint: '#8b95a6',
  textInverse: '#ffffff',

  accent: '#2f6fed',
  accentHover: '#2560d4',
  accentSoft: '#e6efff',

  success: '#128a5a',
  successSoft: '#e2f5ec',
  warning: '#b26a00',
  warningSoft: '#fdf0dc',
  danger: '#c0392f',
  dangerSoft: '#fbe9e7',
  live: '#128a5a',
} as const;

export const radii = {
  sm: '6px',
  md: '10px',
  lg: '14px',
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

export const font = {
  family:
    '"Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"Cascadia Mono", "Consolas", ui-monospace, monospace',
} as const;

export const shadows = {
  card: '0 1px 2px rgba(19, 26, 38, 0.06), 0 1px 3px rgba(19, 26, 38, 0.04)',
  raised: '0 4px 16px rgba(19, 26, 38, 0.10)',
} as const;
