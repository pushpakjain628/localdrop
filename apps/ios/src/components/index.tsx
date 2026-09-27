/**
 * Shared presentational components.
 *
 * Everything here is pure: no store access, no side effects. Screens compose them, which keeps
 * the visual language consistent and the screens easy to read.
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { formatBytes, formatDuration, formatMediaDuration } from '@localdrop/shared';
import {
  HIT_SLOP,
  MIN_TOUCH,
  palette,
  radii,
  shadow,
  spacing,
  tones,
  type,
  type Tone,
} from '../theme';

/* ------------------------------------------------------------------ Button */

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'regular',
  disabled,
  loading,
  icon,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'regular' | 'large' | 'small';
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const isDisabled = Boolean(disabled) || Boolean(loading);
  const height = size === 'large' ? 54 : size === 'small' ? 36 : MIN_TOUCH;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: Boolean(loading) }}
      style={({ pressed }) => [
        styles.button,
        { height, paddingHorizontal: size === 'small' ? spacing.md : spacing.xl },
        variantStyles[variant].container,
        pressed && !isDisabled ? variantStyles[variant].pressed : null,
        isDisabled ? styles.buttonDisabled : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variantStyles[variant].label.color} size="small" />
      ) : (
        <>
          {icon ? <Text style={[styles.buttonIcon, variantStyles[variant].label]}>{icon}</Text> : null}
          <Text
            numberOfLines={1}
            style={[
              styles.buttonLabel,
              size === 'small' ? styles.buttonLabelSmall : null,
              variantStyles[variant].label,
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ Card */

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  return <View style={[styles.card, padded ? styles.cardPadded : null, style]}>{children}</View>;
}

export function SectionTitle({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

/* ------------------------------------------------------------------ Pill */

export function Pill({
  label,
  tone = 'neutral',
  dot,
}: {
  label: string;
  tone?: Tone;
  dot?: boolean;
}) {
  const { fg, bg } = tones[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {dot ? <View style={[styles.pillDot, { backgroundColor: fg }]} /> : null}
      <Text style={[styles.pillLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ Progress */

export function ProgressBar({
  fraction,
  tone = 'accent',
  height = 8,
  indeterminate,
}: {
  /** 0..1. Ignored when `indeterminate`. */
  fraction: number;
  tone?: Tone;
  height?: number;
  indeterminate?: boolean;
}) {
  const clamped = Math.min(Math.max(Number.isFinite(fraction) ? fraction : 0, 0), 1);
  return (
    <View
      style={[styles.progressTrack, { height, borderRadius: height / 2 }]}
      accessibilityRole="progressbar"
      accessibilityValue={
        indeterminate ? undefined : { min: 0, max: 100, now: Math.round(clamped * 100) }
      }
    >
      <View
        style={[
          styles.progressFill,
          {
            height,
            borderRadius: height / 2,
            backgroundColor: tones[tone].fg,
            width: indeterminate ? '35%' : `${clamped * 100}%`,
          },
          indeterminate ? styles.progressIndeterminate : null,
        ]}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ Stat */

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  style,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.statTile, style]}>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, tone !== 'neutral' ? { color: tones[tone].fg } : null]}>
        {value}
      </Text>
      {hint ? (
        <Text style={styles.statHint} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ States */

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: string;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function Banner({
  tone,
  title,
  message,
  action,
  onDismiss,
}: {
  tone: Tone;
  title: string;
  message?: string;
  action?: React.ReactNode;
  onDismiss?: () => void;
}) {
  const { fg, bg } = tones[tone];
  return (
    <View style={[styles.banner, { backgroundColor: bg, borderColor: fg }]}>
      <View style={styles.bannerBody}>
        <Text style={[styles.bannerTitle, { color: fg }]}>{title}</Text>
        {message ? <Text style={styles.bannerMessage}>{message}</Text> : null}
      </View>
      {action}
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={HIT_SLOP} accessibilityLabel="Dismiss">
          <Text style={[styles.bannerDismiss, { color: fg }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Inline error text, for form fields. */
export function FieldError({ children }: { children: React.ReactNode }) {
  if (!children) {
    return null;
  }
  return <Text style={styles.fieldError}>{children}</Text>;
}

/* ------------------------------------------------------------------ Segmented */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segmented, style]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.segment, selected ? styles.segmentActive : null]}
          >
            <Text style={[styles.segmentLabel, selected ? styles.segmentLabelActive : null]}>
              {option.label}
              {option.count !== undefined ? `  ${option.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ KeyValue */

export function KeyValue({
  label,
  value,
  valueStyle,
  mono,
}: {
  label: string;
  value: string;
  valueStyle?: StyleProp<TextStyle>;
  mono?: boolean;
}) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueLabel}>{label}</Text>
      <Text
        style={[styles.keyValueValue, mono ? type.mono : null, valueStyle]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ Video badge */

/** A play badge + duration for a video thumbnail. */
export function VideoOverlay({ durationSeconds }: { durationSeconds: number | null }) {
  return (
    <View style={styles.videoOverlay} pointerEvents="none">
      <View style={styles.videoBadge}>
        <Text style={styles.videoBadgeGlyph}>▶</Text>
      </View>
      {durationSeconds !== null && durationSeconds > 0 ? (
        <Text style={styles.videoDuration}>{formatMediaDuration(durationSeconds)}</Text>
      ) : null}
    </View>
  );
}

/** A small "LIVE" chip for a Live Photo. */
export function LiveBadge() {
  return (
    <View style={styles.liveBadge}>
      <Text style={styles.liveBadgeText}>LIVE</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ Thumbnail */

/**
 * A photo tile that loads its own thumbnail and fades it in.
 *
 * Thumbnails arrive as `file://` URLs from the native cache, so no base64 crosses the bridge and
 * the JS heap stays flat even with a few hundred tiles on screen.
 */
export function Thumbnail({
  uri,
  size,
  rounded = 0,
  dimmed,
}: {
  uri: string | null;
  size: number;
  rounded?: number;
  dimmed?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const dimensions = useMemo(
    () => ({ width: size, height: size, borderRadius: rounded }),
    [size, rounded],
  );

  return (
    <View style={[styles.thumbnailFrame, dimensions, dimmed ? styles.thumbnailDimmed : null]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={[styles.thumbnail, dimensions, loaded ? styles.thumbnailVisible : null]}
          onLoadEnd={() => setLoaded(true)}
          // A cancelled or failed tile should not show a broken-image glyph.
          onError={() => setLoaded(true)}
          resizeMode="cover"
          accessible
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {!uri || !loaded ? <View style={[styles.thumbnailShimmer, dimensions]} /> : null}
    </View>
  );
}

/* ------------------------------------------------------------------ Divider */

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

/* ------------------------------------------------------------------ Screen scaffold */

/**
 * A scrollable screen with a large-title header.
 *
 * Wrapping every screen in the same scaffold is what makes them feel like one app: consistent
 * safe-area handling, a consistent header, and a consistent pull-to-refresh affordance.
 */
export function Screen({
  title,
  subtitle,
  headerRight,
  children,
  onRefresh,
  refreshing,
}: {
  title: string;
  subtitle?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.screenTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.screenSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerRight}
      </View>
      <ScrollView
        style={styles.screenScroll}
        contentContainerStyle={styles.screenContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={Boolean(refreshing)}
              onRefresh={onRefresh}
              tintColor={palette.inkFaint}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ styles */

const variantStyles: Record<
  'primary' | 'secondary' | 'ghost' | 'danger',
  { container: ViewStyle; pressed: ViewStyle; label: TextStyle }
> = {
  primary: {
    container: { backgroundColor: palette.accent, borderColor: palette.accent },
    pressed: { backgroundColor: palette.accentPressed, borderColor: palette.accentPressed },
    label: { color: palette.inkInverse },
  },
  secondary: {
    container: { backgroundColor: palette.surface, borderColor: palette.borderStrong },
    pressed: { backgroundColor: palette.surfaceMuted },
    label: { color: palette.ink },
  },
  ghost: {
    container: { backgroundColor: 'transparent', borderColor: 'transparent' },
    pressed: { backgroundColor: palette.surfaceMuted },
    label: { color: palette.accent },
  },
  danger: {
    container: { backgroundColor: palette.dangerSoft, borderColor: palette.danger },
    pressed: { backgroundColor: palette.danger },
    label: { color: palette.danger },
  },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: palette.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
    gap: spacing.md,
  },
  screenHeaderText: { flex: 1 },
  screenTitle: type.title,
  screenSubtitle: { ...type.callout, marginTop: 2 },
  screenScroll: { flex: 1 },
  screenContent: { padding: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.lg },

  card: {
    backgroundColor: palette.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    ...shadow.card,
  },
  cardPadded: { padding: spacing.lg },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.sm,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  buttonLabelSmall: { fontSize: 14 },
  buttonIcon: { fontSize: 16, fontWeight: '600' },

  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  sectionTitle: { ...type.heading, flexShrink: 1 },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.pill,
    gap: 6,
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillLabel: { fontSize: 12.5, fontWeight: '600' },

  progressTrack: {
    backgroundColor: palette.surfaceSunken,
    overflow: 'hidden',
    width: '100%',
  },
  progressFill: { minWidth: 2 },
  progressIndeterminate: { opacity: 0.7 },

  statTile: {
    flex: 1,
    minWidth: 96,
    backgroundColor: palette.surfaceMuted,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  statLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: palette.inkFaint,
  },
  statValue: { fontSize: 20, fontWeight: '700', color: palette.ink },
  statHint: { ...type.caption },

  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
  emptyIcon: { fontSize: 40, color: palette.inkFaint },
  emptyTitle: { ...type.heading, textAlign: 'center' },
  emptyMessage: { ...type.callout, textAlign: 'center', maxWidth: 300 },
  emptyAction: { marginTop: spacing.md },

  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bannerBody: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: 15, fontWeight: '600' },
  bannerMessage: { ...type.callout, color: palette.inkMuted },
  bannerDismiss: { fontSize: 15, fontWeight: '700', paddingHorizontal: spacing.xs },

  fieldError: { ...type.caption, color: palette.danger, marginTop: spacing.xs },

  segmented: {
    flexDirection: 'row',
    backgroundColor: palette.surfaceSunken,
    borderRadius: radii.md,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
  },
  segmentActive: { backgroundColor: palette.surface, ...shadow.card },
  segmentLabel: { fontSize: 14, fontWeight: '600', color: palette.inkMuted },
  segmentLabelActive: { color: palette.ink },

  keyValue: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  keyValueLabel: { ...type.callout },
  keyValueValue: { ...type.callout, color: palette.ink, fontWeight: '500', flexShrink: 1 },

  videoOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', alignItems: 'flex-end', padding: 6 },
  videoBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(17,23,38,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  videoBadgeGlyph: { color: '#fff', fontSize: 9, marginLeft: 2 },
  videoDuration: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(17,23,38,0.6)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },

  liveBadge: {
    backgroundColor: palette.accent,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  liveBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  thumbnailFrame: { backgroundColor: palette.surfaceSunken, overflow: 'hidden' },
  thumbnail: { opacity: 0 },
  thumbnailVisible: { opacity: 1 },
  thumbnailDimmed: { opacity: 0.45 },
  thumbnailShimmer: { ...StyleSheet.absoluteFillObject, backgroundColor: palette.surfaceSunken },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border },
});

export { formatBytes, formatDuration };
