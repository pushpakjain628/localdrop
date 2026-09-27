/**
 * Binds a React component to the `AppStore`.
 *
 * Uses `useSyncExternalStore` so a re-render is scheduled by React rather than by a manual
 * subscription, and so concurrent rendering cannot tear.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { AppStore, type AppState } from './AppStore';

const store = new AppStore();

/** The app-wide store. A single instance is intentional: the phone is one user, one session. */
export function getStore(): AppStore {
  return store;
}

export function useStore(): AppState {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), []);
  return useSyncExternalStore(subscribe, store.getState, store.getState);
}

/** `useStore` plus the store itself, for screens that dispatch intents. */
export function useAppStore(): [AppState, AppStore] {
  return [useStore(), store];
}
