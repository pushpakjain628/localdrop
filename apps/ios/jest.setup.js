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
    getConstants: () => ({
      reactNativeVersion: { major: 0, minor: 76, patch: 5 },
      isTesting: true,
    }),
  },
  // `StyleSheet` reaches for screen metrics at import time, and it gets them from the `DeviceInfo`
  // TurboModule. Mocking `NativeModules` wholesale removes it, so without this every suite that
  // imports a component fails to even load - which is why the component tests below exist but
  // could not run before.
  DeviceInfo: {
    getConstants: () => ({
      Dimensions: {
        window: { width: 390, height: 844, scale: 3, fontScale: 1 },
        screen: { width: 390, height: 844, scale: 3, fontScale: 1 },
      },
    }),
  },
  // `Keyboard` constructs a `NativeEventEmitter` with this at module scope, and a `Modal` pulls
  // `ScrollView` (and therefore `Keyboard`) in. Absent, the emitter throws while rendering any
  // screen that contains a `Modal`.
  KeyboardObserver: {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  // `StatusBar` and `Modal` resolve these through `TurboModuleRegistry.getEnforcing`, which falls
  // back to `NativeModules` when there is no turbo module proxy - as there is not under Jest.
  // Mocking `NativeModules` wholesale therefore has to supply them, or importing a screen throws
  // before a single assertion runs.
  StatusBarManager: {
    getConstants: () => ({ HEIGHT: 20, DEFAULT_BACKGROUND_COLOR: null }),
    setColor: jest.fn(),
    setTranslucent: jest.fn(),
    setStyle: jest.fn(),
    setHidden: jest.fn(),
    setNetworkActivityIndicatorVisible: jest.fn(),
  },
  DevSettings: {
    reload: jest.fn(),
    setHotLoadingEnabled: jest.fn(),
    setIsDebuggingRemotely: jest.fn(),
    setProfilingEnabled: jest.fn(),
    toggleElementInspector: jest.fn(),
    addMenuItem: jest.fn(),
    setIsShakeToShowDevMenuEnabled: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  // Read by LogBox, which React mounts as soon as anything renders.
  SourceCode: {
    getConstants: () => ({ scriptURL: 'http://localhost:1420/index.bundle' }),
  },
  // `ActivityIndicator`, which the button inside the manual-entry sheet renders while busy.
  ImageLoader: {
    getConstants: () => ({}),
    getSize: jest.fn().mockResolvedValue([0, 0]),
    getSizeWithHeaders: jest.fn().mockResolvedValue([0, 0]),
    prefetchImage: jest.fn().mockResolvedValue(true),
    queryCache: jest.fn().mockResolvedValue({}),
  },
  SettingsManager: { settings: {}, getConstants: () => ({ settings: {} }) },
}));

// Silence the RN animation helper warning in the test environment.
jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper', () => ({}), { virtual: true });
