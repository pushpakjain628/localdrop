/**
 * Catches a render-time throw so it becomes a message instead of an empty screen.
 *
 * React unmounts the whole tree when a render throws, and in a Release build there is no red box
 * to say why. The user is left staring at a blank app with no way to report what happened. This
 * boundary is the second half of `errorReporting`: that one catches errors thrown outside
 * rendering (an event handler, a promise), this one catches errors thrown inside it.
 */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, radii, spacing, type } from './theme';
import { clearLatestError, recordErrorForDisplay } from './native/errorReporting';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
  stack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: null, stack: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: describe(error).message, stack: describe(error).stack };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Recorded like any other unhandled error, so the banner and the log agree and a report from
    // the banner carries the component stack too.
    recordErrorForDisplay(error, info.componentStack ?? null);
  }

  private readonly retry = (): void => {
    this.setState({ message: null, stack: null });
  };

  private readonly dismiss = (): void => {
    clearLatestError();
    this.setState({ message: null, stack: null });
  };

  override render(): ReactNode {
    const { message, stack } = this.state;
    if (message === null) {
      return this.props.children;
    }

    return (
      <View style={styles.screen}>
        <Text style={styles.title}>LocalDrop hit a problem</Text>
        <Text style={styles.body}>
          Nothing was lost and nothing was sent. This is a bug in the app, not something you did.
        </Text>
        <View style={styles.box}>
          <Text style={styles.message}>{message}</Text>
        </View>
        {stack ? (
          <View style={styles.box}>
            <Text style={styles.stack} numberOfLines={12}>
              {stack}
            </Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            onPress={this.retry}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
          >
            <Text style={styles.buttonLabel}>Try again</Text>
          </Pressable>
          <Pressable
            onPress={this.dismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss and carry on"
            style={({ pressed }) => [styles.button, styles.buttonGhost, pressed ? styles.pressed : null]}
          >
            <Text style={styles.buttonGhostLabel}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    );
  }
}

function describe(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? null };
  }
  return { message: String(error), stack: null };
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.surface,
    padding: spacing.xl,
    justifyContent: 'center',
    gap: spacing.md,
  },
  title: { ...type.title },
  body: { ...type.body, color: palette.inkMuted },
  box: {
    backgroundColor: palette.surfaceMuted,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  message: { ...type.mono, color: palette.danger },
  stack: { ...type.caption, color: palette.inkMuted },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: {
    backgroundColor: palette.accent,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonLabel: { ...type.callout, color: '#fff' },
  buttonGhostLabel: { ...type.callout, color: palette.accent },
  pressed: { opacity: 0.6 },
});
