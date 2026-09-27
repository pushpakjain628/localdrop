/**
 * The Home screen.
 *
 * Answers, in order, the three questions a user opens the app with: is my PC connected, how much
 * is left to back up, and where do I tap. Everything else is secondary.
 */

import React, { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes } from '@localdrop/shared';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  KeyValue,
  Pill,
  ProgressBar,
  SectionTitle,
  StatTile,
} from '../components';
import { palette, radii, spacing, type } from '../theme';
import { useAppStore } from '../state/useStore';
import type { ScreenName } from '../state/AppStore';

export function HomeScreen({ navigate }: { navigate: (screen: ScreenName) => void }) {
  const [state, store] = useAppStore();

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  // The checkmark state goes stale whenever the queue finishes something, so refresh it when
  // the screen regains focus rather than on a timer.
  useEffect(() => {
    if (state.connection) {
      void store.refreshBackedUpStatus();
    }
  }, [state.connection, state.summary.completed, store]);

  const hasPermission = state.authorization === 'authorized' || state.authorization === 'limited';
  const server = state.discovery.servers.find((s) => s.serverId === state.selectedServerId);
  const selected = state.selectedAssetIds.size;
  const remaining = state.assets.filter((a) => !state.backedUpAssetIds.has(a.localIdentifier));

  const onBackup = useCallback(() => {
    if (selected > 0) {
      void store.startBackup();
    } else {
      void store.startBackup(remaining);
    }
    navigate('transfer');
  }, [selected, store, remaining, navigate]);

  return (
    <>
      {state.error ? (
        <Banner
          tone="danger"
          title="Something went wrong"
          message={state.error}
          onDismiss={() => store.dismissError()}
        />
      ) : null}

      {!hasPermission ? (
        <PermissionCard
          status={state.authorization}
          busy={state.requestingAuthorization}
          onRequest={() => void store.requestAuthorization()}
        />
      ) : null}

      <ConnectionCard
        paired={state.pairing === 'paired'}
        serverName={server?.name ?? state.discovery.servers[0]?.name ?? null}
        serverCount={state.discovery.servers.length}
        searching={state.discovery.status === 'searching'}
        discoveryError={state.discovery.error}
        connectionError={state.connectionError}
        freeSpaceBytes={state.serverFreeSpaceBytes}
        backupDirectory={state.serverBackupDirectory}
        onSelect={() => navigate('settings')}
        onRetryDiscovery={() => void store.startDiscoveryAgain()}
        onOpenManual={() => store.openManualEntry()}
      />

      {hasPermission ? (
        <Card>
          <SectionTitle
            title="Your library"
            action={
              <Pressable
                onPress={() => navigate('photos')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Browse your photos"
              >
                <Text style={styles.link}>Browse</Text>
              </Pressable>
            }
          />
          <View style={styles.statRow}>
            <StatTile
              label="Photos"
              value={state.library.photos.toLocaleString()}
              hint={selected > 0 ? `${selected} selected` : undefined}
              tone={selected > 0 ? 'accent' : 'neutral'}
            />
            <StatTile
              label="Videos"
              value={state.library.videos.toLocaleString()}
              hint={state.libraryLoading ? 'Loading…' : undefined}
            />
          </View>

          {state.connection && remaining.length > 0 ? (
            <View style={styles.remaining}>
              <Text style={styles.remainingText}>
                {remaining.length.toLocaleString()} item{remaining.length === 1 ? '' : 's'} in the
                loaded pages {selected > 0 ? `· ${selected} selected` : 'not yet backed up'}
              </Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      {state.summary.total > 0 ? (
        <Card>
          <SectionTitle
            title="Backup progress"
            action={<Pill label={state.summary.inFlight === 'uploading' ? 'Running' : 'Idle'} tone={state.summary.inFlight === 'uploading' ? 'accent' : 'neutral'} />}
          />
          {state.summary.fraction !== null ? (
            <ProgressBar fraction={state.summary.fraction} tone="success" height={10} />
          ) : null}
          <View style={styles.progressMeta}>
            <Text style={styles.progressText}>
              {state.summary.completed} of {state.summary.total} done
              {state.summary.skipped > 0 ? ` · ${state.summary.skipped} already on PC` : ''}
              {state.summary.failed > 0 ? ` · ${state.summary.failed} failed` : ''}
            </Text>
            {state.summary.bytesTotal > 0 ? (
              <Text style={styles.progressText}>
                {formatBytes(state.summary.bytesDone)} of {formatBytes(state.summary.bytesTotal)}
              </Text>
            ) : null}
          </View>
          <Button
            label="Show transfer details"
            variant="secondary"
            onPress={() => navigate('transfer')}
            style={styles.fullWidthButton}
          />
        </Card>
      ) : null}

      {state.history.length > 0 ? (
        <Card>
          <SectionTitle
            title="Last backup"
            action={
              <Pressable onPress={() => navigate('history')} hitSlop={8} accessibilityRole="button">
                <Text style={styles.link}>See all</Text>
              </Pressable>
            }
          />
          <KeyValue
            label="Most recent file"
            value={state.history[0]?.filename ?? '—'}
          />
          <KeyValue
            label="Saved to"
            value={state.history[0]?.relativePath ?? (state.serverBackupDirectory || '—')}
            mono
          />
        </Card>
      ) : null}

      <Button
        label={
          !hasPermission
            ? 'Allow access to your photos'
            : !state.connection
              ? 'Pair with your PC'
              : selected > 0
                ? `Back up ${selected} selected item${selected === 1 ? '' : 's'}`
                : `Backup to PC${remaining.length > 0 ? ` (${remaining.length})` : ''}`
        }
        size="large"
        disabled={!hasPermission || !state.connection || state.queueRunning}
        loading={state.queueRunning}
        onPress={onBackup}
        testID="home-backup-button"
      />

      {state.connection ? null : (
        <Text style={styles.helper}>
          LocalDrop sends photos straight to your own PC over Wi-Fi. Nothing goes through the
          internet, and nothing is ever deleted from your iPhone.
        </Text>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ permission */

function PermissionCard({
  status,
  busy,
  onRequest,
}: {
  status: string;
  busy: boolean;
  onRequest: () => void;
}) {
  if (status === 'denied' || status === 'restricted') {
    return (
      <Card>
        <Banner
          tone="warning"
          title="Photos access is turned off"
          message="LocalDrop needs permission to read your photo library. Turn it on in Settings › LocalDrop › Photos."
        />
        <View style={styles.spacer} />
        <Text style={styles.helper}>
          Nothing is uploaded until you choose what to back up, and your library is only ever
          read.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <EmptyState
        icon="􀉉"
        title="Let LocalDrop see your photos"
        message="LocalDrop reads your photo library so you can choose what to back up to your PC. It never deletes anything."
        action={<Button label="Continue" onPress={onRequest} loading={busy} />}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ connection */

function ConnectionCard({
  paired,
  serverName,
  serverCount,
  searching,
  discoveryError,
  connectionError,
  freeSpaceBytes,
  backupDirectory,
  onSelect,
  onRetryDiscovery,
  onOpenManual,
}: {
  paired: boolean;
  serverName: string | null;
  serverCount: number;
  searching: boolean;
  discoveryError: string | null;
  connectionError: string | null;
  freeSpaceBytes: number | null;
  backupDirectory: string;
  onSelect: () => void;
  onRetryDiscovery: () => void;
  onOpenManual: () => void;
}) {
  return (
    <Card>
      <SectionTitle
        title="Your PC"
        action={
          paired ? (
            <Pill label="Paired" tone="success" dot />
          ) : (
            <Pill label={searching ? 'Searching…' : 'Not paired'} tone={searching ? 'accent' : 'neutral'} />
          )
        }
      />

      {connectionError ? (
        <>
          <Banner tone="warning" title="Needs attention" message={connectionError} />
          <View style={styles.spacer} />
        </>
      ) : null}

      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={serverName ? `Connected to ${serverName}` : 'Choose a PC'}
        style={({ pressed }) => [styles.serverRow, pressed ? styles.serverRowPressed : null]}
      >
        <View style={[styles.serverIcon, paired ? styles.serverIconPaired : null]}>
          <Text style={styles.serverIconGlyph}>{paired ? '✓' : '🖥'}</Text>
        </View>
        <View style={styles.serverText}>
          <Text style={styles.serverName} numberOfLines={1}>
            {serverName ?? (searching ? 'Looking for your PC…' : 'No PC found yet')}
          </Text>
          <Text style={styles.serverMeta} numberOfLines={1}>
            {paired && backupDirectory
              ? backupDirectory
              : serverCount > 0
                ? `${serverCount} PC${serverCount === 1 ? '' : 's'} on this network`
                : 'Make sure LocalDrop is running on your PC'}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      {paired ? (
        <View style={styles.connectionFacts}>
          <KeyValue
            label="Free space on PC"
            value={freeSpaceBytes === null ? 'Unknown' : formatBytes(freeSpaceBytes)}
          />
        </View>
      ) : null}

      {discoveryError ? (
        <>
          <View style={styles.spacer} />
          <Text style={styles.helper}>{discoveryError}</Text>
        </>
      ) : null}

      <View style={styles.connectionActions}>
        <Button label="Find another PC" variant="secondary" size="small" onPress={onRetryDiscovery} />
        <View style={styles.actionGap} />
        <Button label="Enter address" variant="ghost" size="small" onPress={onOpenManual} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  link: { ...type.callout, color: palette.accent, fontWeight: '600' },
  statRow: { flexDirection: 'row', gap: spacing.md },
  remaining: { marginTop: spacing.md },
  remainingText: { ...type.caption },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  progressText: { ...type.caption, flexShrink: 1 },
  fullWidthButton: { marginTop: spacing.lg },
  helper: { ...type.caption, textAlign: 'center', paddingHorizontal: spacing.lg },
  spacer: { height: spacing.md },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  serverRowPressed: { backgroundColor: palette.surfaceMuted },
  serverIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: palette.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverIconPaired: { backgroundColor: palette.successSoft },
  serverIconGlyph: { fontSize: 20, color: palette.inkMuted },
  serverText: { flex: 1 },
  serverName: { ...type.heading, fontSize: 17 },
  serverMeta: { ...type.caption, marginTop: 1 },
  chevron: { fontSize: 26, color: palette.inkFaint, fontWeight: '300' },
  connectionFacts: {
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  connectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  actionGap: { width: spacing.xs },
});
