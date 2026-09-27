/**
 * Jest setup.
 *
 * The native modules have no implementation outside a simulator, so they are replaced with
 * explicit fakes rather than being left undefined. That way a test that forgets to stub one
 * fails loudly with a useful message instead of throwing `undefined is not a function`.
 */

/**
 * Minimal `NativeEventEmitter`.
 *
 * React Native's index re-exports this as `require(...).default`, so the mock has to present an
 * ES-module shape or the named import resolves to `undefined`.
 *
 * `emit` is not part of the real API; it exists so a test can push a progress event into the
 * engine and assert on the row it updates.
 */
class MockNativeEventEmitter {
  constructor(nativeModule) {
    if (nativeModule === undefined || nativeModule === null) {
      throw new Error('NativeEventEmitter requires a non-null native module.');
    }
    this.nativeModule = nativeModule;
    this.listeners = new Map();
  }

  addListener(event, handler) {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
    return {
      remove: () => {
        const current = this.listeners.get(event) ?? [];
        this.listeners.set(
          event,
          current.filter((h) => h !== handler),
        );
      },
    };
  }

  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount(event) {
    return (this.listeners.get(event) ?? []).length;
  }

  /** Test-only: deliver an event to every registered handler. */
  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}

jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => ({
  __esModule: true,
  default: MockNativeEventEmitter,
}));

jest.mock('react-native/Libraries/BatchedBridge/NativeModules', () => ({
  LocalDropPhotos: {
    getAuthorizationStatus: jest.fn().mockResolvedValue('authorized'),
    requestAuthorization: jest.fn().mockResolvedValue('authorized'),
    fetchAssets: jest.fn().mockResolvedValue({ assets: [], nextOffset: null, total: 0, scanned: 0 }),
    getLibraryCounts: jest.fn().mockResolvedValue({ photos: 0, videos: 0 }),
    getAsset: jest.fn(),
    requestThumbnail: jest.fn().mockResolvedValue({ uri: null }),
    clearThumbnailCache: jest.fn().mockResolvedValue(0),
  },
  LocalDropTransfer: {
    // NativeEventEmitter calls these on the module it is constructed with.
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    activeUploadCount: jest.fn().mockResolvedValue(0),
    prepareAsset: jest.fn(),
    uploadFile: jest.fn(),
    cancelUpload: jest.fn().mockResolvedValue(true),
    cancelAllUploads: jest.fn().mockResolvedValue(true),
    discardPreparedFile: jest.fn().mockResolvedValue(true),
    sweepStaging: jest.fn().mockResolvedValue(true),
    stagingFootprint: jest
      .fn()
      .mockResolvedValue({ fileCount: 0, byteLength: 0, freeSpaceBytes: 0 }),
  },
  LocalDropDiscovery: {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    startBrowsing: jest.fn().mockResolvedValue({ started: true, listenerId: 'test' }),
    stopBrowsing: jest.fn().mockResolvedValue(true),
    resolveHost: jest.fn().mockResolvedValue({ reachable: true, host: '1.2.3.4', port: 47821 }),
  },
  LocalDropSecureStore: {
    setValue: jest.fn().mockResolvedValue(true),
    getValue: jest.fn().mockResolvedValue(null),
    removeValue: jest.fn().mockResolvedValue(true),
    clearAll: jest.fn().mockResolvedValue(true),
    loadPairing: jest.fn().mockResolvedValue(null),
    savePairing: jest.fn().mockResolvedValue(true),
    clearPairing: jest.fn().mockResolvedValue(true),
    deviceIdentity: jest.fn().mockResolvedValue({ deviceId: 'test-device', deviceName: 'Test iPhone' }),
  },
  PlatformConstants: {
    forceTouchAvailable: true,
    isTesting: true,
  },
  SettingsManager: { settings: {}, getConstants: () => ({ settings: {} }) },
}));

// Silence the RN animation helper warning in the test environment.
jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper', () => ({}), { virtual: true });
