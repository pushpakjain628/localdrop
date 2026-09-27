/**
 * A memoised grid tile.
 *
 * Split into its own component so a re-render of the grid (a selection change, a progress
 * update) does not re-render every visible tile. The thumbnail is fetched once per asset and
 * cached by the native module, so scrolling back does not re-request it.
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { isSupportedExtension } from '@localdrop/shared';
import { LiveBadge, Thumbnail, VideoOverlay } from '../components';
import { palette, radii, spacing, type } from '../theme';
import type { PhotoAsset } from '../native/NativeModules';

export interface AssetTileProps {
  asset: PhotoAsset;
  size: number;
  selected: boolean;
  backedUp: boolean;
  /** Supplied by the parent so a whole grid shares one fetcher. */
  loadThumbnail: (assetId: string, size: number) => Promise<string | null>;
  onToggle: (assetId: string) => void;
  onOpen: (asset: PhotoAsset) => void;
}

function AssetTileImpl({
  asset,
  size,
  selected,
  backedUp,
  loadThumbnail,
  onToggle,
  onOpen,
}: AssetTileProps) {
  const [uri, setUri] = useState<string | null>(null);
  // Guards against a slow thumbnail request for a tile that has scrolled away and come back,
  // or been unmounted, overwriting newer state.
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    void loadThumbnail(asset.localIdentifier, Math.round(size * 2)).then((result) => {
      if (!cancelled && requestId.current === id) {
        setUri(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset.localIdentifier, loadThumbnail, size]);

  const supported = isSupportedExtension(asset.filename);
  const checkOnly = selected || backedUp;

  return (
    <Pressable
      onPress={() => onToggle(asset.localIdentifier)}
      onLongPress={() => onOpen(asset)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !supported }}
      accessibilityLabel={`${asset.filename}${backedUp ? ', already backed up' : ''}${
        asset.isLivePhoto ? ', Live Photo' : ''
      }${asset.mediaType === 'video' ? ', video' : ''}`}
      style={({ pressed }) => [{ width: size }, pressed ? styles.pressed : null]}
    >
      <View style={[styles.frame, { width: size, height: size }]}>
        <Thumbnail uri={uri} size={size} />

        {asset.mediaType === 'video' ? (
          <VideoOverlay durationSeconds={asset.durationSeconds} />
        ) : null}
        {asset.isLivePhoto && asset.mediaType === 'photo' ? (
          <View style={styles.liveSlot}>
            <LiveBadge />
          </View>
        ) : null}

        {checkOnly ? (
          <View
            style={[
              styles.check,
              backedUp ? styles.checkBackedUp : styles.checkSelected,
            ]}
          >
            <Text style={[styles.checkGlyph, backedUp ? styles.checkGlyphBackedUp : null]}>
              {selected ? '✓' : '✓'}
            </Text>
          </View>
        ) : null}

        {!supported ? (
          <View style={styles.unsupported}>
            <Text style={styles.unsupportedText}>Unsupported</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export const AssetTile = memo(AssetTileImpl, (previous, next) => {
  return (
    previous.asset.localIdentifier === next.asset.localIdentifier &&
    previous.size === next.size &&
    previous.selected === next.selected &&
    previous.backedUp === next.backedUp &&
    previous.loadThumbnail === next.loadThumbnail &&
    previous.onToggle === next.onToggle &&
    previous.onOpen === next.onOpen
  );
});

/** Detail sheet content for a single asset. */
export function AssetDetails({ asset, backedUp }: { asset: PhotoAsset; backedUp: boolean }) {
  const megapixels =
    asset.pixelWidth > 0 && asset.pixelHeight > 0
      ? ((asset.pixelWidth * asset.pixelHeight) / 1_000_000).toFixed(1)
      : null;

  return (
    <View style={styles.details}>
      <Row label="File name" value={asset.filename} />
      <Row label="Type" value={asset.mediaType === 'video' ? 'Video' : 'Photo'} />
      {asset.durationSeconds !== null && asset.durationSeconds > 0 ? (
        <Row label="Duration" value={`${Math.round(asset.durationSeconds)}s`} />
      ) : null}
      {megapixels !== null ? (
        <Row label="Dimensions" value={`${asset.pixelWidth} × ${asset.pixelHeight} (${megapixels} MP)`} />
      ) : null}
      <Row label="Taken" value={formatTaken(asset.creationDate)} />
      <Row label="Identifier" value={asset.localIdentifier} mono />
      {asset.isLivePhoto ? (
        <Row
          label="Live Photo"
          value={asset.livePhotoVideo ? `Paired with ${asset.livePhotoVideo.filename}` : 'Yes'}
        />
      ) : null}
      {asset.hasCloudContent === false ? (
        <Row label="Storage" value="In iCloud — will download before backup" />
      ) : null}
      <Row
        label="Status"
        value={backedUp ? 'Already backed up' : 'Not backed up yet'}
        tone={backedUp ? palette.success : palette.ink}
      />
    </View>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[styles.rowValue, mono ? type.mono : null, tone ? { color: tone } : null]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function formatTaken(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: palette.surfaceSunken,
  },
  pressed: { opacity: 0.7 },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  checkSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  checkBackedUp: { backgroundColor: palette.success, borderColor: palette.success },
  checkGlyph: { color: '#fff', fontSize: 12, fontWeight: '800' },
  checkGlyphBackedUp: { color: '#fff' },
  liveSlot: { position: 'absolute', top: 6, left: 6 },
  unsupported: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,23,38,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unsupportedText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  details: { gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.lg },
  rowLabel: { ...type.callout, flexShrink: 0 },
  rowValue: { ...type.callout, color: palette.ink, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
});
