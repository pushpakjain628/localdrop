/**
 * The app shell: a tab bar and the current screen.
 *
 * Hand-rolled rather than `react-navigation`: the app has five flat destinations and no deep
 * linking, no nested stacks and no custom transitions, so a navigation library would be several
 * times the code for the same behaviour - and one more dependency to keep current.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AppState as RNAppState,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import { palette, radii, spacing, type } from './theme';
import { Screen } from './components';
import { HomeScreen } from './screens/HomeScreen';
import { PhotosScreen } from './screens/PhotosScreen';
import { TransferScreen } from './screens/TransferScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useAppStore } from './state/useStore';
import type { ScreenName } from './state/AppStore';
import { NativeModuleUnavailableError } from './native/NativeModules';
import { CrashNotice } from './CrashNotice';

const TABS: Array<{ name: ScreenName; label: string; glyph: string }> = [
  { name: 'home', label: 'Home', glyph: '⌂' },
  { name: 'photos', label: 'Photos', glyph: '▦' },
  { name: 'transfer', label: 'Transfer', glyph: '⇪' },
  { name: 'history', label: 'History', glyph: '🕘' },
  { name: 'settings', label: 'Settings', glyph: '⚙' },
];

export function App() {
  const [state, store] = useAppStore();
  const [screen, setScreen] = useState<ScreenName>('home');

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  // Discovery is radio work; a phone in a pocket should not be browsing mDNS. Restart it when
  // the app comes back to the foreground, because the network almost certainly changed.
  useEffect(() => {
    const subscription = RNAppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') {
        void store.startDiscoveryAgain();
      } else if (status === 'background') {
        void store.stopDiscovery();
      }
    });
    return () => subscription.remove();
  }, [store]);

  const navigate = useCallback((next: ScreenName) => setScreen(next), []);

  if (!state.nativeReady) {
    return <NativeModulesMissing />;
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={palette.surface} />

      <CrashNotice />

      <View style={styles.content}>
        {screen === 'home' ? (
          <Screen
            title="LocalDrop"
            subtitle={
              state.pairing === 'paired'
                ? 'Backing up to your PC over Wi-Fi'
                : 'Back up to your PC over Wi-Fi'
            }
          >
            <HomeScreen navigate={navigate} />
          </Screen>
        ) : null}

        {screen === 'photos' ? (
          <Screen title="Your library" subtitle="Tap to select, then back up">
            <View style={styles.fill}>
              <PhotosScreen />
            </View>
          </Screen>
        ) : null}

        {screen === 'transfer' ? (
          <Screen title="Transfer" subtitle="Progress and retries">
            <TransferScreen navigate={navigate} />
          </Screen>
        ) : null}

        {screen === 'history' ? (
          <Screen
            title="Backup history"
            subtitle="What is stored on your PC"
            onRefresh={() => void store.loadHistory()}
            refreshing={state.historyLoading}
          >
            <HistoryScreen />
          </Screen>
        ) : null}

        {screen === 'settings' ? (
          <Screen title="Settings" subtitle="Computers, pairing and storage">
            <SettingsScreen />
          </Screen>
        ) : null}
      </View>

      <View style={styles.tabBar} accessibilityRole="tablist">
        {TABS.map((tab) => {
          const selected = tab.name === screen;
          return (
            <Pressable
              key={tab.name}
              onPress={() => setScreen(tab.name)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={tab.label}
              style={({ pressed }) => [styles.tab, pressed ? styles.tabPressed : null]}
            >
              <Text style={[styles.tabGlyph, selected ? styles.tabActive : null]}>
                {tab.glyph}
              </Text>
              <Text style={[styles.tabLabel, selected ? styles.tabActive : null]}>
                {tab.label}
              </Text>
              {tab.name === 'transfer' && state.summary.total > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {state.summary.inFlight === 'uploading' ? '•' : state.summary.failed}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

/**
 * Shown when the native modules are absent.
 *
 * This happens after pulling JavaScript changes onto a device without rebuilding the app, which
 * is a common and confusing failure; saying so explicitly is far more useful than a blank
 * screen or a wall of red-box errors.
 */
function NativeModulesMissing() {
  return (
    <SafeAreaView style={styles.missing}>
      <StatusBar barStyle="dark-content" backgroundColor={palette.surface} />
      <Text style={styles.missingTitle}>LocalDrop needs a rebuild</Text>
      <Text style={styles.missingBody}>
        The Photos, discovery and secure-storage modules are native iOS code. They are compiled
        into the app, so JavaScript changes alone are not enough after adding one.
      </Text>
      <Text style={styles.missingCode}>
        {`cd ios
pod install
open LocalDrop.xcworkspace
⌘B`}
      </Text>
      <Text style={styles.missingHint}>
        {NativeModuleUnavailableError.name} — this screen appears when NativeModules has no
        LocalDrop entry.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  content: { flex: 1 },
  fill: { marginHorizontal: -spacing.xl, marginBottom: -spacing.xl },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: palette.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing.xs, minHeight: 44 },
  tabPressed: { opacity: 0.6 },
  tabGlyph: { fontSize: 20, color: palette.inkFaint },
  tabLabel: { fontSize: 10.5, fontWeight: '600', color: palette.inkFaint },
  tabActive: { color: palette.accent },
  badge: {
    position: 'absolute',
    top: 0,
    right: '50%',
    marginRight: -22,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: palette.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  missing: {
    flex: 1,
    backgroundColor: palette.surface,
    padding: spacing.xl,
    justifyContent: 'center',
    gap: spacing.md,
  },
  missingTitle: { ...type.title },
  missingBody: { ...type.body, color: palette.inkMuted },
  missingCode: {
    ...type.mono,
    backgroundColor: palette.surfaceMuted,
    padding: spacing.lg,
    borderRadius: radii.md,
    lineHeight: 20,
  },
  missingHint: { ...type.caption },
});
