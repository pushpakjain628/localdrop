#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

/**
 * Objective-C bridge declarations for the LocalDrop native modules.
 *
 * The implementation is Swift (`LocalDropPhotos.swift`, `LocalDropTransfer.swift`,
 * `LocalDropDiscovery.swift`, `LocalDropSecureStore.swift`). This file is what makes those
 * classes visible to the React Native bridge, because the bridge looks up modules by their
 * Objective-C runtime name. `RCT_EXTERN_MODULE` registers the class; `RCT_EXTERN_METHOD`
 * declares each exported method with its argument and callback types.
 *
 * This must be an Objective-C *implementation* file (`.m`), not a header. `RCT_EXTERN_MODULE`
 * expands to an `@implementation` carrying a module constructor calling
 * `RCTRegisterModule`, and a header is never compiled, so nothing is ever registered. That
 * failure is invisible at build time: the app compiles, links and launches, and then every
 * `NativeModules.LocalDrop*` lookup is `undefined`, which is exactly what `hasNativeModules` in
 * `src/native/NativeModules.ts` reports as "LocalDrop needs a rebuild".
 *
 * Each `@interface RCT_EXTERN_MODULE` below therefore needs its own `@end`, because the macro
 * opens an `@implementation` that the trailing `@end` closes. The file was originally a header
 * with no `@end` anywhere, which is consistent with it never having been compiled; once it is,
 * the missing `@end`s surface as "missing '@end'" against the *next* block, which reads like a
 * problem with the wrong block. `scripts/verify.js` now checks the balance.
 *
 * Two things must stay in step with the TypeScript wrappers in `src/native/NativeModules.ts`:
 * the module names and the method signatures. The return shapes are documented there. Each
 * `@objc(...)` selector in the Swift files must match the `RCT_EXTERN_METHOD` selector here.
 *
 * `LocalDropTransfer` and `LocalDropDiscovery` subclass `RCTEventEmitter` in Swift, which is how
 * native code pushes progress and discovery results up to JS. `supportedEvents` is overridden in
 * Swift rather than declared here, because it is a method override rather than an exported
 * bridge method.
 */

#pragma mark - LocalDropPhotos

@interface RCT_EXTERN_MODULE (LocalDropPhotos, NSObject)

/// Resolves `"notDetermined" | "restricted" | "denied" | "authorized" | "limited"`.
RCT_EXTERN_METHOD(getAuthorizationStatus
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Prompts for read/write access, resolving with the resulting status.
RCT_EXTERN_METHOD(requestAuthorization
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Options: `{ offset, limit, mediaType, includeLivePhotos }`.
/// Resolves `{ assets, nextOffset, total, scanned }`.
RCT_EXTERN_METHOD(fetchAssets
                  : (NSDictionary *)options resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves `{ photos, videos }`.
RCT_EXTERN_METHOD(getLibraryCounts
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves a single asset's metadata.
RCT_EXTERN_METHOD(getAsset
                  : (NSString *)localIdentifier resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Options: `{ localIdentifier, size, scale }`. Resolves `{ uri, width, height, byteLength }`
/// where `uri` is a `file://` URL to a cached JPEG.
RCT_EXTERN_METHOD(requestThumbnail
                  : (NSDictionary *)options resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves the number of cached thumbnails removed.
RCT_EXTERN_METHOD(clearThumbnailCache
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end

#pragma mark - LocalDropTransfer

@interface RCT_EXTERN_MODULE (LocalDropTransfer, RCTEventEmitter)

/// Emits `LocalDropTransferProgress` with
/// `{ transferId, bytesSent, totalBytes, fraction, bytesPerSecond, estimatedSecondsRemaining }`.

/// Resolves the number of uploads currently in flight.
RCT_EXTERN_METHOD(activeUploadCount
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Options: `{ localIdentifier, kind }` where `kind` is `photo`, `video` or `livePhotoVideo`.
/// Resolves `{ path, filename, byteLength, sha256, didTranscode }`. The file is a staging copy
/// on disk; its contents never enter the JS heap.
RCT_EXTERN_METHOD(prepareAsset
                  : (NSDictionary *)options resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Options: `{ transferId, path, url, method, headers }`.
/// Resolves `{ statusCode, body }`.
RCT_EXTERN_METHOD(uploadFile
                  : (NSDictionary *)options resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelUpload
                  : (NSString *)transferId resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelAllUploads
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(discardPreparedFile
                  : (NSString *)path resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sweepStaging
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves `{ fileCount, byteLength, freeSpaceBytes }`.
RCT_EXTERN_METHOD(stagingFootprint
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end

#pragma mark - LocalDropDiscovery

@interface RCT_EXTERN_MODULE (LocalDropDiscovery, RCTEventEmitter)

/// Emits `LocalDropDiscoveryEvent` with
/// `{ listenerId, type: 'ready'|'results'|'failed'|'stopped', servers, error }`.

/// Options: `{ serviceType, domain, listenerId }`. Resolves `{ started, listenerId }`.
RCT_EXTERN_METHOD(startBrowsing
                  : (NSDictionary *)options resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopBrowsing
                  : (NSString *)listenerId resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)
/// TCP reachability probe for the manual IP-address fallback. Resolves
/// `{ reachable, host, port }`.
RCT_EXTERN_METHOD(resolveHost
                  : (NSString *)host port
                  : (nonnull NSNumber *)port resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end

#pragma mark - LocalDropSecureStore

@interface RCT_EXTERN_MODULE (LocalDropSecureStore, NSObject)

RCT_EXTERN_METHOD(setValue
                  : (NSString *)value forKey
                  : (NSString *)key resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves the stored string, `null` when absent, or `{ __error, status }` when the Keychain
/// itself is unavailable.
RCT_EXTERN_METHOD(getValue
                  : (NSString *)key resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(removeValue
                  : (NSString *)key resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(clearAll
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves `{ token, serverId, serverName, host, port, deviceId, deviceName }` or `null`.
RCT_EXTERN_METHOD(loadPairing
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(savePairing
                  : (NSDictionary *)pairing resolver
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Forgets the PC's credentials but keeps this install's identity.
RCT_EXTERN_METHOD(clearPairing
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

/// Resolves `{ deviceId, deviceName }`, generating a stable id on first call.
RCT_EXTERN_METHOD(deviceIdentity
                  : (RCTPromiseResolveBlock)resolve rejecter
                  : (RCTPromiseRejectBlock)reject)

@end
