/**
 * The Transfer screen: what is happening right now, and what to do about failures.
 *
 * Progress, speed and remaining time come straight from the queue summary, which is derived from
 * the native progress events - so the numbers on screen are the same ones driving the upload,
 * not an estimate.
 */

import React, { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes, formatDuration } from '@localdrop/shared';
import { Banner, Button, Card, EmptyState, Pill, ProgressBar, SectionTitle } from '../components';
import { palette, radii, spacing, type } from '../theme';
import { useAppStore } from '../state/useStore';
import type { QueueSummary, TransferItem, TransferState } from '../transfer/TransferEngine';
import type { ScreenName } from '../state/AppStore';

const STATE_LABELS: Record<TransferState, string> = {
  queued: 'Waiting',
  preparing: 'Preparing',
  uploading: 'Sending',
  verifying: 'Verifying',
  completed: 'Backed up',
  skipped: 'Already on PC',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function TransferScreen({ navigate }: { navigate: (screen: ScreenName) => void }) {
  const [state, store] = useAppStore();
  const { summary, queue } = state;

  const onRetry = useCallback(() => {
    void store.retryFailed();
  }, [store]);

  if (queue.length === 0) {
    return (
      <EmptyState
        icon="⇪"
        title="No transfers yet"
        message="Choose photos or videos from your library and tap Backup to send them to your PC."
        action={<Button label="Browse your library" onPress={() => navigate('photos')} />}
      />
    );
  }

  return (
    <FlatList
      data={queue}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <View style={styles.header}>
          <OverallProgress summary={summary} />
          {summary.failed > 0 ? (
            <Card>
              <Banner
                tone="warning"
                title={`${summary.failed} file${summary.failed === 1 ? '' : 's'} failed`}
                message="Your iPhone is untouched — nothing is deleted. Retrying re-sends only the failed files."
                action={
                  <Button label="Retry" variant="secondary" size="small" onPress={onRetry} />
                }
              />
            </Card>
          ) : null}
          {state.queueRunning ? (
            <Button
              label="Stop after this file"
              variant="secondary"
              onPress={() => void store.cancelTransfers()}
            />
          ) : null}
          <SectionTitle title="Files" />
        </View>
      }
      renderItem={({ item }) => <TransferRow item={item} />}
      ListFooterComponent={
        summary.total > 0 && summary.failed === 0 && !state.queueRunning ? (
          <View style={styles.footer}>
            <Button
              label="Clear finished"
              variant="ghost"
              onPress={() => store.clearFinished()}
              style={styles.fullWidth}
            />
          </View>
        ) : null
      }
      showsVerticalScrollIndicator={false}
    />
  );
}

/* ------------------------------------------------------------------ overall */

function OverallProgress({ summary }: { summary: QueueSummary }) {
  const done = summary.completed + summary.skipped;
  const isRunning = summary.inFlight === 'uploading';

  return (
    <Card>
      <View style={styles.overallTop}>
        <View style={styles.overallText}>
          <Text style={styles.overallTitle}>
            {isRunning
              ? `Backing up ${done + 1} of ${summary.total}`
              : summary.failed > 0
                ? 'Finished with problems'
                : 'Backup complete'}
          </Text>
          <Text style={styles.overallMeta}>
            {summary.completed} backed up
            {summary.skipped > 0 ? ` · ${summary.skipped} already there` : ''}
            {summary.failed > 0 ? ` · ${summary.failed} failed` : ''}
          </Text>
        </View>
        <Pill
          label={isRunning ? 'In progress' : summary.failed > 0 ? 'Needs retry' : 'Done'}
          tone={isRunning ? 'accent' : summary.failed > 0 ? 'warning' : 'success'}
          dot={isRunning}
        />
      </View>

      {summary.fraction !== null ? (
        <View style={styles.progressWrap}>
          <ProgressBar
            fraction={summary.fraction}
            tone={summary.failed > 0 && !isRunning ? 'warning' : 'success'}
            height={10}
          />
        </View>
      ) : null}

      {summary.bytesTotal > 0 ? (
        <>
          <View style={styles.metricRow}>
            <Metric
              label="Transferred"
              value={`${formatBytes(summary.bytesDone)} / ${formatBytes(summary.bytesTotal)}`}
            />
            <Metric
              label="Speed"
              value={summary.bytesPerSecond > 0 ? `${formatBytes(summary.bytesPerSecond)}/s` : '—'}
            />
            <Metric
              label="Remaining"
              value={
                summary.estimatedSecondsRemaining !== null
                  ? formatDuration(summary.estimatedSecondsRemaining)
                  : '—'
              }
            />
          </View>
        </>
      ) : null}

      {isRunning ? (
        <Text style={styles.keepAwake}>
          Keep LocalDrop open and your iPhone plugged in for the fastest transfer.
        </Text>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ row */

function TransferRow({ item }: { item: TransferItem }) {
  const inFlight = ['preparing', 'uploading', 'verifying'].includes(item.state);
  const fraction = item.fileSize > 0 ? Math.min(item.bytesSent / item.fileSize, 1) : 0;

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.filename}
          {item.isLivePhotoVideo ? '  ·  Live Photo' : ''}
        </Text>
        <Pill
          label={STATE_LABELS[item.state]}
          tone={
            item.state === 'completed'
              ? 'success'
              : item.state === 'failed'
                ? 'danger'
                : item.state === 'cancelled'
                  ? 'neutral'
                  : inFlight
                    ? 'accent'
                    : 'neutral'
          }
        />
      </View>

      {inFlight ? (
        <>
          <View style={styles.rowProgress}>
            <ProgressBar fraction={fraction} tone="accent" height={6} />
          </View>
          <View style={styles.rowMeta}>
            <Text style={styles.rowMetaText}>
              {item.fileSize > 0
                ? `${formatBytes(item.bytesSent)} of ${formatBytes(item.fileSize)}`
                : 'Measuring…'}
            </Text>
            {item.bytesPerSecond > 0 ? (
              <Text style={styles.rowMetaText}>{formatBytes(item.bytesPerSecond)}/s</Text>
            ) : null}
            {item.estimatedSecondsRemaining !== null ? (
              <Text style={styles.rowMetaText}>
                {formatDuration(item.estimatedSecondsRemaining)} left
              </Text>
            ) : null}
          </View>
        </>
      ) : null}

      {item.verified && item.destinationPath ? (
        <Text style={styles.destination} numberOfLines={1}>
          {item.destinationPath}
        </Text>
      ) : null}

      {item.error ? (
        <Text style={styles.error}>{item.error}</Text>
      ) : null}

      {item.attempts > 1 && item.state === 'failed' ? (
        <Text style={styles.attempts}>Attempted {item.attempts} times</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.md },
  header: { gap: spacing.lg, marginBottom: spacing.sm },
  overallTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  overallText: { flex: 1 },
  overallTitle: { ...type.heading },
  overallMeta: { ...type.callout, marginTop: 2 },
  progressWrap: { marginTop: spacing.lg },
  metricRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  metric: {
    flex: 1,
    backgroundColor: palette.surfaceMuted,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  metricLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: palette.inkFaint,
  },
  metricValue: { fontSize: 14, fontWeight: '600', color: palette.ink },
  keepAwake: { ...type.caption, marginTop: spacing.md },

  row: {
    backgroundColor: palette.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowName: { ...type.body, fontWeight: '600', flex: 1 },
  rowProgress: { marginTop: spacing.xs },
  rowMeta: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs },
  rowMetaText: { ...type.caption },
  destination: { ...type.mono, fontSize: 11.5, color: palette.success, marginTop: 2 },
  error: { ...type.caption, color: palette.danger, marginTop: 2 },
  attempts: { ...type.caption, color: palette.inkFaint },
  footer: { marginTop: spacing.lg },
  fullWidth: { width: '100%' },
});
