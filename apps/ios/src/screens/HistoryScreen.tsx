/**
 * Backup history: what the PC has actually received.
 *
 * Read from the PC rather than cached on the phone, because the PC's database is the record of
 * truth - a file the user deleted from the library on Windows must stop showing as backed up.
 */

import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { formatBytes, parseIsoTimestamp, toIsoDate } from '@localdrop/shared';
import { Button, Card, EmptyState, Pill } from '../components';
import { palette, radii, spacing, type } from '../theme';
import { useAppStore } from '../state/useStore';
import type { HistoryEntry, TransferStatus } from '@localdrop/shared';

const STATUS_TONE: Record<string, 'success' | 'danger' | 'neutral' | 'accent'> = {
  completed: 'success',
  failed: 'danger',
  aborted: 'neutral',
  skipped: 'neutral',
  uploading: 'accent',
  verifying: 'accent',
  pending: 'neutral',
};

const STATUS_LABEL: Record<TransferStatus, string> = {
  completed: 'Backed up',
  failed: 'Failed',
  aborted: 'Cancelled',
  skipped: 'Already backed up',
  uploading: 'Receiving',
  verifying: 'Verifying',
  pending: 'Queued',
};

export function HistoryScreen() {
  const [state, store] = useAppStore();

  useEffect(() => {
    void store.loadHistory();
  }, [store]);

  const sections = groupByDay(state.history);

  const refresh = useCallback(() => {
    void store.loadHistory();
  }, [store]);

  if (!state.connection) {
    return (
      <EmptyState
        icon="🖥"
        title="No PC connected"
        message="Pair with your PC to see what has been backed up."
      />
    );
  }

  if (state.history.length === 0 && state.historyLoading) {
    return <ActivityIndicator color={palette.inkFaint} style={styles.loader} />;
  }

  if (state.history.length === 0) {
    return (
      <EmptyState
        icon="🗂"
        title="No backups yet"
        message="Transfers you send to your PC will be listed here, with the exact folder each file was saved to."
        action={<Button label="Refresh" variant="secondary" onPress={refresh} />}
      />
    );
  }

  const totalBytes = state.history
    .filter((entry) => entry.status === 'completed')
    .reduce((sum, entry) => sum + entry.fileSize, 0);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.transferId}
      contentContainerStyle={styles.content}
      stickySectionHeadersEnabled
      refreshing={state.historyLoading}
      onRefresh={refresh}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <Card style={styles.summary}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryValue}>{formatBytes(totalBytes)}</Text>
            <Text style={styles.summaryLabel}>
              across {state.history.length} transfer{state.history.length === 1 ? '' : 's'} on this
              PC
            </Text>
          </View>
        </Card>
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </View>
      )}
      renderItem={({ item }) => <HistoryRow entry={item} />}
    />
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const tone = STATUS_TONE[entry.status] ?? 'neutral';
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.filename}
        </Text>
        <Pill label={STATUS_LABEL[entry.status]} tone={tone} />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowMetaText}>{formatBytes(entry.fileSize)}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.rowMetaText}>{entry.mediaType === 'video' ? 'Video' : 'Photo'}</Text>
        {entry.isLivePhotoVideo ? (
          <>
            <Text style={styles.dot}>·</Text>
            <Text style={styles.liveTag}>Live Photo</Text>
          </>
        ) : null}
        {entry.deviceName ? (
          <>
            <Text style={styles.dot}>·</Text>
            <Text style={styles.rowMetaText} numberOfLines={1}>
              {entry.deviceName}
            </Text>
          </>
        ) : null}
      </View>
      {entry.relativePath ? (
        <Text style={styles.path} numberOfLines={1}>
          {entry.relativePath}
        </Text>
      ) : null}
      {entry.errorMessage ? <Text style={styles.error}>{entry.errorMessage}</Text> : null}
      <Pressable
        onPress={() => undefined}
        disabled
        style={styles.hashRow}
        accessibilityLabel={`SHA-256 ${entry.sha256}`}
      >
        <Text style={styles.hash} numberOfLines={1}>
          {entry.sha256.slice(0, 16)}…
        </Text>
      </Pressable>
    </View>
  );
}

/** Groups transfers by the day the *asset* was taken, which is how a user thinks about them. */
export function groupByDay(entries: HistoryEntry[]): Array<{ title: string; data: HistoryEntry[] }> {
  const buckets = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const created = parseIsoTimestamp(entry.createdAt) ?? parseIsoTimestamp(entry.backedUpAt);
    const key = created ? toIsoDate(created) : 'Unknown date';
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([title, data]) => ({ title, data }));
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  loader: { marginTop: spacing.xxxl },
  summary: { marginBottom: spacing.md },
  summaryRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  summaryValue: { ...type.title },
  summaryLabel: { ...type.callout, flexShrink: 1 },
  sectionHeader: {
    backgroundColor: palette.canvas,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitle: { ...type.heading, fontSize: 16 },
  row: {
    backgroundColor: palette.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: 2,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowName: { ...type.body, fontWeight: '600', flex: 1 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  rowMetaText: { ...type.caption },
  dot: { ...type.caption, color: palette.inkFaint },
  liveTag: { ...type.caption, color: palette.accent, fontWeight: '600' },
  path: { ...type.mono, fontSize: 11.5, marginTop: 2 },
  error: { ...type.caption, color: palette.danger, marginTop: 2 },
  hashRow: { marginTop: 2 },
  hash: { ...type.mono, fontSize: 10.5, color: palette.inkFaint },
});
