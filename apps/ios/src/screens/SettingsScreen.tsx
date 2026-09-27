/**
 * Connection and settings: pick a PC, pair it, and see what the phone is holding on to.
 *
 * This is also where the manual IP fallback lives, because mDNS genuinely does get blocked on
 * some networks and a user who cannot find their PC needs a way forward that does not involve
 * reading a support page.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatBytes } from '@localdrop/shared';
import {
  Banner,
  Button,
  Card,
  Divider,
  FieldError,
  KeyValue,
  Pill,
  SectionTitle,
} from '../components';
import { palette, radii, spacing, type } from '../theme';
import { useAppStore } from '../state/useStore';
import { normalizePairingCode } from '@localdrop/shared';

export function SettingsScreen() {
  const [state, store] = useAppStore();
  const [identity, setIdentity] = useState<{ deviceName: string; deviceId: string } | null>(null);
  const [staging, setStaging] = useState<{ byteLength: number; fileCount: number } | null>(null);

  useEffect(() => {
    void store.deviceIdentity().then(setIdentity).catch(() => setIdentity(null));
    void store.stagingFootprint().then(setStaging).catch(() => setStaging(null));
  }, [store]);

  const onUnpair = useCallback(() => {
    void store.unpair();
  }, [store]);

  return (
    <>
      {state.connectionError ? (
        <Banner tone="warning" title="Pairing needs attention" message={state.connectionError} />
      ) : null}

      <Card>
        <SectionTitle
          title="Computers on this network"
          action={
            <Pressable onPress={() => void store.startDiscoveryAgain()} hitSlop={8} accessibilityRole="button">
              <Text style={styles.link}>Search again</Text>
            </Pressable>
          }
        />

        {state.discovery.servers.length === 0 ? (
          <View style={styles.noServers}>
            <Text style={styles.noServersText}>
              {state.discovery.status === 'searching'
                ? 'Looking for PCs running LocalDrop…'
                : 'No PCs found yet. Make sure LocalDrop is open on your PC and both devices are on the same Wi-Fi.'}
            </Text>
          </View>
        ) : (
          <View style={styles.serverList}>
            {state.discovery.servers.map((server) => {
              const selected = server.serverId === state.selectedServerId;
              return (
                <Pressable
                  key={server.serverId}
                  onPress={() => store.selectServer(server.serverId)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={({ pressed }) => [
                    styles.serverRow,
                    selected ? styles.serverRowSelected : null,
                    pressed ? styles.serverRowPressed : null,
                  ]}
                >
                  <View style={styles.serverInfo}>
                    <Text style={styles.serverName} numberOfLines={1}>
                      {server.name}
                    </Text>
                    <Text style={styles.serverHost} numberOfLines={1}>
                      {server.host}:{server.port}
                      {server.discovered ? '' : ' · entered manually'}
                    </Text>
                  </View>
                  {selected ? <Pill label="Selected" tone="accent" /> : null}
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={styles.spacer} />
        <Button
          label="Enter a PC's address manually"
          variant="secondary"
          onPress={() => store.openManualEntry()}
        />
        {state.discovery.error ? (
          <Text style={styles.discoveryError}>{state.discovery.error}</Text>
        ) : null}
      </Card>

      {state.pairing !== 'paired' ? (
        <Card>
          <SectionTitle title="Pair with your PC" />
          <Text style={styles.pairHelp}>
            Your PC shows a six-digit code. Enter it here to connect this iPhone.
          </Text>
          <PairingCodeField
            value={state.pairingCode}
            error={state.pairingError}
            busy={state.pairing === 'pairing'}
            onChange={store.setPairingCode}
            onSubmit={() => void store.completePairing()}
          />
        </Card>
      ) : null}

      {state.pairing === 'paired' ? (
        <Card>
          <SectionTitle
            title="Paired PC"
            action={<Pill label="Connected" tone="success" dot />}
          />
          <KeyValue label="Computer" value={state.discovery.servers.find((s) => s.serverId === state.selectedServerId)?.name ?? 'Your PC'} />
          {state.serverBackupDirectory ? (
            <KeyValue label="Saves to" value={state.serverBackupDirectory} mono />
          ) : null}
          <KeyValue
            label="Free space on PC"
            value={state.serverFreeSpaceBytes === null ? 'Unknown' : formatBytes(state.serverFreeSpaceBytes)}
          />
          <View style={styles.spacer} />
          <Button label="Refresh" variant="secondary" size="small" onPress={() => void store.refreshServerInfo()} />
          <View style={styles.spacer} />
          <Button label="Unpair this PC" variant="danger" onPress={onUnpair} />
          <Text style={styles.note}>
            Unpairing forgets the connection key on this iPhone. Nothing is deleted from your
            library, and nothing is deleted from your photos.
          </Text>
        </Card>
      ) : null}

      <Card>
        <SectionTitle title="This iPhone" />
        {identity ? (
          <>
            <KeyValue label="Name" value={identity.deviceName} />
            <KeyValue label="Identifier" value={identity.deviceId} mono />
          </>
        ) : null}
        {staging && staging.fileCount > 0 ? (
          <KeyValue
            label="Temporary space in use"
            value={`${formatBytes(staging.byteLength)} (${staging.fileCount} file${staging.fileCount === 1 ? '' : 's'})`}
          />
        ) : null}
        <View style={styles.spacer} />
        <Text style={styles.note}>
          LocalDrop only ever adds verified copies to your PC. It never deletes anything from your
          photo library, and it never deletes anything from the backup folder.
        </Text>
      </Card>

      <ManualEntrySheet />
    </>
  );
}

/* ------------------------------------------------------------------ code entry */

function PairingCodeField({
  value,
  error,
  busy,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.pairBlock}>
      <TextInput
        value={value}
        onChangeText={(next) => onChange(next.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        placeholderTextColor={palette.inkFaint}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        editable={!busy}
        accessibilityLabel="Pairing code from your PC"
        style={styles.codeInput}
        onSubmitEditing={onSubmit}
        returnKeyType="go"
      />
      <FieldError>{error}</FieldError>
      <View style={styles.spacer} />
      <Button
        label={busy ? 'Connecting…' : 'Connect'}
        onPress={onSubmit}
        loading={busy}
        disabled={normalizePairingCode(value).length !== 6}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ manual entry */

function ManualEntrySheet() {
  const [state, store] = useAppStore();
  const entry = state.manualEntry;
  if (!entry) {
    return null;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => store.closeManualEntry()}>
      <Pressable style={styles.backdrop} onPress={() => store.closeManualEntry()}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>Enter your PC's address</Text>
          <Text style={styles.sheetHelp}>
            Open LocalDrop on your PC. The address it shows is in the top bar, next to “Library”.
          </Text>

          <Text style={styles.fieldLabel}>IP address</Text>
          <TextInput
            value={entry.host}
            onChangeText={store.setManualHost}
            placeholder="192.168.1.42"
            placeholderTextColor={palette.inkFaint}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="IP address of your PC"
            style={styles.textInput}
          />

          <Text style={styles.fieldLabel}>Port</Text>
          <TextInput
            value={String(entry.port)}
            onChangeText={(text) => {
              const parsed = Number.parseInt(text.replace(/\D/g, ''), 10);
              store.setManualPort(Number.isFinite(parsed) ? parsed : 0);
            }}
            placeholder="47821"
            placeholderTextColor={palette.inkFaint}
            keyboardType="number-pad"
            accessibilityLabel="Port"
            style={styles.textInput}
          />

          <FieldError>{entry.error}</FieldError>
          <View style={styles.spacer} />

          <Button
            label="Connect"
            onPress={() => void store.submitManualEntry()}
            loading={entry.checking}
            disabled={entry.host.trim().length === 0}
          />
          <View style={styles.spacer} />
          <Button label="Cancel" variant="ghost" onPress={() => store.closeManualEntry()} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  link: { ...type.callout, color: palette.accent, fontWeight: '600' },
  spacer: { height: spacing.md },
  noServers: { padding: spacing.lg, backgroundColor: palette.surfaceMuted, borderRadius: radii.md },
  noServersText: { ...type.callout },
  serverList: { gap: spacing.sm },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  serverRowSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  serverRowPressed: { backgroundColor: palette.surfaceMuted },
  serverInfo: { flex: 1 },
  serverName: { ...type.body, fontWeight: '600' },
  serverHost: { ...type.mono, fontSize: 11.5 },
  discoveryError: { ...type.caption, color: palette.warning, marginTop: spacing.sm },
  pairHelp: { ...type.callout, marginBottom: spacing.lg },
  pairBlock: { gap: spacing.xs },
  codeInput: {
    ...type.display,
    textAlign: 'center',
    letterSpacing: 12,
    backgroundColor: palette.surfaceMuted,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  note: { ...type.caption, marginTop: spacing.md },
  backdrop: { flex: 1, backgroundColor: palette.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.borderStrong,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  sheetTitle: { ...type.heading },
  sheetHelp: { ...type.callout, marginBottom: spacing.md },
  fieldLabel: { ...type.caption, marginTop: spacing.sm },
  textInput: {
    ...type.body,
    backgroundColor: palette.surfaceMuted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
