/**
 * Mounts the real screens and drives their text inputs.
 *
 * The app is shipped as an unsigned Release build, where an unhandled JavaScript error is fatal -
 * React Native's default handler calls `RCTFatal` and the process terminates. There is no red box
 * and no console, so a throw in an event handler looks exactly like "the app just closed", with
 * nothing to read. That is how a crash on every keystroke reached a user's phone.
 *
 * These tests exist to make that failure mode a test failure. They are deliberately about
 * rendering and interaction rather than logic: the store and the managers are covered by
 * `discovery.test.ts` and `TransferEngine.test.ts`.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';

import { App } from '../App';
import { HomeScreen } from '../screens/HomeScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { getStore } from '../state/useStore';

jest.setTimeout(20000);

/** Mounts a component and flushes the effects it kicks off. */
async function mount(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Every `TextInput` in the tree, so a test can drive the one it cares about. */
function textInputs(root: TestRenderer.ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType('TextInput' as unknown as React.ComponentType);
}

/** One input by position, failing with a useful message rather than a type error. */
function inputAt(inputs: ReactTestInstance[], index: number): ReactTestInstance {
  const input = inputs[index];
  if (!input) {
    throw new Error(`expected at least ${index + 1} TextInput(s), found ${inputs.length}`);
  }
  return input;
}

/** Fires a keystroke through the real `onChangeText` handler. */
async function typeInto(input: ReactTestInstance, text: string): Promise<void> {
  const onChangeText = input.props.onChangeText as ((next: string) => void) | undefined;
  if (typeof onChangeText !== 'function') {
    throw new Error('the TextInput under test has no onChangeText');
  }
  await act(async () => {
    onChangeText(text);
  });
}

afterEach(() => {
  const store = getStore();
  store.setPairingCode('');
  store.closeManualEntry();
});

describe('the app renders', () => {
  it('mounts the whole app shell without throwing', async () => {
    const renderer = await mount(<App />);
    expect(renderer.toJSON()).not.toBeNull();
    renderer.unmount();
  });

  it('mounts the home screen without throwing', async () => {
    const renderer = await mount(<HomeScreen navigate={() => undefined} />);
    expect(renderer.toJSON()).not.toBeNull();
    renderer.unmount();
  });

  it('mounts the settings screen without throwing', async () => {
    const renderer = await mount(<SettingsScreen />);
    expect(renderer.toJSON()).not.toBeNull();
    renderer.unmount();
  });
});

describe('typing does not take the app down', () => {
  it('accepts every keystroke in the pairing code field', async () => {
    const renderer = await mount(<SettingsScreen />);
    const code = inputAt(textInputs(renderer.root), 0);

    // One character at a time, because the real report was "the app closes when I type", and a
    // single call with the finished value would skip every intermediate state.
    for (const value of ['0', '05', '052', '0523', '05230', '052300']) {
      await typeInto(code, value);
      expect(renderer.toJSON()).not.toBeNull();
    }
    renderer.unmount();
  });

  it('accepts typing into the manual address sheet', async () => {
    const store = getStore();
    await act(async () => {
      store.openManualEntry();
    });

    const renderer = await mount(<SettingsScreen />);
    const inputs = textInputs(renderer.root);
    expect(inputs.length).toBeGreaterThanOrEqual(3);

    // IP address, then port. The port field parses its text, so a partial value matters.
    const host = inputAt(inputs, 1);
    const port = inputAt(inputs, 2);
    await typeInto(host, '1');
    await typeInto(host, '19');
    await typeInto(host, '192.168.1.42');
    await typeInto(port, '4');
    await typeInto(port, '47');
    await typeInto(port, '');
    expect(renderer.toJSON()).not.toBeNull();
    renderer.unmount();
  });
});
