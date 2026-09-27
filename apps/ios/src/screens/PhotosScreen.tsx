/**
 * The Photos screen: browse, filter, select and start a backup.
 *
 * The grid is a `FlatList` with `getItemLayout` so scrolling does not have to measure 300 tiles,
 * and windowing means only the visible ones hold a thumbnail URI at a time.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { isSupportedExtension } from '@localdrop/shared';
import { Button, EmptyState, Pill, Segmented } from '../components';
import { AssetDetails, AssetTile } from './AssetTile';
import { palette, radii, spacing, type } from '../theme';
import { useAppStore } from '../state/useStore';
import type { PhotoAsset } from '../native/NativeModules';
import type { PhotosFilter } from '../state/AppStore';

const TILE_GAP = 3;
const MIN_TILE = 104;

export function PhotosScreen() {
  const [state, store] = useAppStore();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<PhotoAsset>>(null);

  const [detail, setDetail] = useState<PhotoAsset | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});

  // Fewer, larger tiles on a narrow phone: 3 across on an SE, 5 on a Pro Max.
  const columns = Math.max(3, Math.floor((width - spacing.lg * 2) / MIN_TILE));
  const tileSize = Math.floor((width - spacing.lg * 2 - TILE_GAP * (columns - 1)) / columns);

  useEffect(() => {
    void store.loadAssets({ refresh: true });
    return () => {
      // Thumbnails are cached on disk by the native module; clearing on unmount keeps the
      // caches directory from growing across a long session.
      void store.clearThumbnailCache();
    };
  }, [state.filter, store]);

  useEffect(() => {
    if (state.selectedAssetIds.size > 0) {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [state.filter, state.selectedAssetIds.size]);

  /**
   * One shared thumbnail loader for the whole grid.
   *
   * Defined once with `useCallback` so every memoised tile sees a stable reference and does not
   * refetch on each re-render. Results are also cached in component state, which means scrolling
   * back up does not re-hit the native module.
   */
  const loadThumbnail = useCallback(
    async (assetId: string, size: number): Promise<string | null> => {
      const cached = thumbnails[assetId];
      if (cached !== undefined) {
        return cached;
      }
      const uri = await store.thumbnailFor(assetId, size);
      setThumbnails((previous) =>
        previous[assetId] === undefined ? { ...previous, [assetId]: uri } : previous,
      );
      return uri;
    },
    [store, thumbnails],
  );

  const onToggle = useCallback((assetId: string) => store.toggleSelection(assetId), [store]);
  const onOpen = useCallback((asset: PhotoAsset) => setDetail(asset), []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<PhotoAsset>) => (
      <AssetTile
        asset={item}
        size={tileSize}
        selected={state.selectedAssetIds.has(item.localIdentifier)}
        backedUp={state.backedUpAssetIds.has(item.localIdentifier)}
        loadThumbnail={loadThumbnail}
        onToggle={onToggle}
        onOpen={onOpen}
      />
    ),
    [tileSize, state.selectedAssetIds, state.backedUpAssetIds, loadThumbnail, onToggle, onOpen],
  );

  const keyExtractor = useCallback((item: PhotoAsset) => item.localIdentifier, []);

  const getItemLayout = useCallback(
    (_: ArrayLike<PhotoAsset> | null | undefined, index: number) => ({
      length: tileSize,
      offset: tileSize * index,
      index,
    }),
    [tileSize],
  );

  const selectedCount = state.selectedAssetIds.size;
  const backedUpCount = state.assets.filter((a) => state.backedUpAssetIds.has(a.localIdentifier)).length;
  const supportedCount = state.assets.filter((a) => isSupportedExtension(a.filename)).length;

  const header = useMemo(
    () => (
      <View style={styles.header}>
        <Segmented
          value={state.filter}
          onChange={(value) => store.setFilter(value as PhotosFilter)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'photo', label: 'Photos' },
            { value: 'video', label: 'Videos' },
          ]}
        />
        <View style={styles.headerMeta}>
          <Text style={styles.metaText}>
            {state.assets.length.toLocaleString()} loaded
            {backedUpCount > 0 ? ` · ${backedUpCount} backed up` : ''}
          </Text>
          {supportedCount < state.assets.length ? (
            <Text style={styles.metaWarning}>
              {state.assets.length - supportedCount} unsupported
            </Text>
          ) : null}
        </View>
      </View>
    ),
    [state.filter, state.assets.length, backedUpCount, supportedCount, store],
  );

  const empty = state.assetsLoading ? (
    <ActivityIndicator color={palette.inkFaint} style={styles.loader} />
  ) : state.filter === 'video' ? (
    <EmptyState icon="🎬" title="No videos" message="Videos from your library will appear here." />
  ) : state.filter === 'photo' ? (
    <EmptyState icon="🖼" title="No photos" message="Photos from your library will appear here." />
  ) : (
    <EmptyState
      icon="􀉉"
      title="Your library is empty"
      message="Photos and videos you take will show up here."
    />
  );

  return (
    <View style={styles.screen}>
      <FlatList
        ref={listRef}
        data={state.assets}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        numColumns={columns}
        key={`grid-${columns}`}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        // A fixed tile height makes `getItemLayout` valid, and `removeClippedSubviews` keeps
        // memory flat on a large library.
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={columns > 1 ? styles.row : undefined}
        removeClippedSubviews
        initialNumToRender={columns * 4}
        maxToRenderPerBatch={columns * 4}
        windowSize={5}
        onEndReachedThreshold={0.6}
        onEndReached={() => void store.loadMoreAssets()}
        ListFooterComponent={
          state.assetsLoadingMore ? (
            <ActivityIndicator color={palette.inkFaint} style={styles.footerLoader} />
          ) : state.assetsExhausted && state.assets.length > 0 ? (
            <Text style={styles.endOfList}>That’s everything in your library.</Text>
          ) : null
        }
        showsVerticalScrollIndicator={false}
      />

      {selectedCount > 0 ? (
        <View style={styles.selectionBar}>
          <Pressable onPress={() => store.clearSelection()} hitSlop={10} accessibilityRole="button">
            <Pill label="Clear" tone="neutral" />
          </Pressable>
          <Text style={styles.selectionText}>
            {selectedCount} selected
          </Text>
          <Button
            label={`Back up ${selectedCount}`}
            onPress={() => void store.startBackup()}
            size="small"
            testID="photos-backup-selected"
          />
        </View>
      ) : (
        <View style={styles.selectionBar}>
          <Pressable
            onPress={() => store.selectAll()}
            hitSlop={10}
            accessibilityRole="button"
            disabled={state.assets.length === 0}
          >
            <Pill label="Select all" tone="accent" />
          </Pressable>
          <View style={styles.spacer} />
          <Text style={styles.selectionHint}>Tap to select · long-press for details</Text>
        </View>
      )}

      <Modal
        visible={detail !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDetail(null)}>
          <Pressable style={styles.modalSheet} onPress={() => undefined}>
            <View style={styles.modalGrabber} />
            {detail ? (
              <>
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {detail.filename}
                </Text>
                <AssetDetails
                  asset={detail}
                  backedUp={state.backedUpAssetIds.has(detail.localIdentifier)}
                />
                <View style={styles.spacer} />
                <Button
                  label="Close"
                  variant="secondary"
                  onPress={() => setDetail(null)}
                  style={styles.fullWidth}
                />
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  listContent: { padding: spacing.lg, paddingBottom: 120 },
  row: { gap: TILE_GAP, marginBottom: TILE_GAP },
  header: { marginBottom: spacing.lg, gap: spacing.md },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  metaText: { ...type.caption, flexShrink: 1 },
  metaWarning: { ...type.caption, color: palette.warning },
  loader: { marginTop: spacing.xxxl },
  footerLoader: { marginVertical: spacing.lg },
  endOfList: {
    ...type.caption,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
  selectionBar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: palette.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    shadowColor: '#0b1220',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  spacer: { flex: 1 },
  selectionText: { ...type.callout, flexShrink: 1 },
  selectionHint: { ...type.caption, flexShrink: 1, textAlign: 'right' },
  modalBackdrop: { flex: 1, backgroundColor: palette.overlay, justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
  },
  modalGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.borderStrong,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  modalTitle: { ...type.heading },
  fullWidth: { width: '100%' },
});
