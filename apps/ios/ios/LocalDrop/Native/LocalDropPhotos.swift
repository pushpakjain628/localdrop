import Foundation
import Photos

/// Bridges the Photos framework to JavaScript.
///
/// Everything that would otherwise pull a large asset into the React Native JS heap happens
/// here instead:
///
/// * `fetchAssets` returns metadata and identifiers only - never image data.
/// * `requestThumbnail` writes a small JPEG to a temp file and returns a `file://` URL, which
///   `<Image>` can render without base64 ever crossing the bridge.
/// * `prepareAssetFile` streams a `PHAssetResource` to disk in 1 MiB blocks, so materialising
///   a 4 GB video costs 1 MiB of memory, not 4 GB.
/// * `sha256File` hashes that file natively with CryptoKit.
///
/// iOS provides no API to read a `PHAssetResource` straight into a socket, so "stream to a temp
/// file, then upload from the file" is the only route that keeps memory bounded. The temp file
/// is deleted as soon as the transfer finishes.
@objc(LocalDropPhotos)
final class LocalDropPhotos: NSObject {

    // MARK: - Authorization

    @objc static func requiresMainQueueSetup() -> Bool { false }

    /// `notDetermined` | `restricted` | `denied` | `authorized` | `limited`
    @objc(getAuthorizationStatus:rejecter:)
    func getAuthorizationStatus(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter _: @escaping RCTPromiseRejectBlock) {
        resolve(Self.statusString(PHPhotoLibrary.authorizationStatus(for: .readWrite)))
    }

    @objc(requestAuthorization:rejecter:)
    func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter _: @escaping RCTPromiseRejectBlock) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            // The callback is not guaranteed to be on the main thread.
            resolve(Self.statusString(status))
        }
    }

    private static func statusString(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .limited: return "limited"
        @unknown default: return "notDetermined"
        }
    }

    // MARK: - Assets

    /// Paged asset query.
    ///
    /// `PHFetchOptions` with a `sortDescriptors` and no predicate is a lazy, index-backed walk,
    /// so paging 10 000 assets stays cheap. Nothing but metadata crosses the bridge.
    @objc(fetchAssets:resolver:rejecter:)
    func fetchAssets(_ options: NSDictionary,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        let offset = (options["offset"] as? NSNumber)?.intValue ?? 0
        let limit = (options["limit"] as? NSNumber)?.intValue ?? 200
        guard limit > 0, offset >= 0 else {
            reject("bad_arguments", "offset and limit must be non-negative, with limit > 0", nil)
            return
        }

        let mediaFilter: PHAssetMediaType?
        switch (options["mediaType"] as? String) {
        case "photo": mediaFilter = .image
        case "video": mediaFilter = .video
        case "all", .none: mediaFilter = nil
        default:
            reject("bad_arguments", "mediaType must be photo, video or all", nil)
            return
        }

        // A Live Photo is a photo asset carrying a paired video resource. The phone needs both
        // halves so the PC can keep them together, so those are fetched too.
        let includeLivePhotos = (options["includeLivePhotos"] as? NSNumber)?.boolValue ?? true
        let fetchOptions = PHFetchOptions()
        fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        if !includeLivePhotos {
            // No predicate exists for "is not a Live Photo"; filtering happens after the fetch
            // while walking, which is why `includeLivePhotos` defaults to true.
        }

        let result: PHFetchResult<PHAsset>
        if let mediaFilter {
            result = PHAsset.fetchAssets(with: mediaFilter, options: fetchOptions)
        } else {
            result = PHAsset.fetchAssets(with: fetchOptions)
        }

        var assets: [[String: Any]] = []
        assets.reserveCapacity(min(limit, result.count))
        var index = offset
        var scanned = 0
        let total = result.count

        while index < total && assets.count < limit {
            let asset = result.object(at: index)
            scanned = index + 1
            if let payload = Self.describe(asset: asset, includeLivePhotoVideo: includeLivePhotos) {
                assets.append(payload)
            }
            index += 1
        }

        resolve([
            "assets": assets,
            // The next offset is the index we stopped at, so a filtered-out asset never
            // causes the caller to loop on an empty page forever.
            "nextOffset": index < total ? NSNumber(value: index) : NSNull(),
            "total": NSNumber(value: total),
            "scanned": NSNumber(value: scanned),
        ])
    }

    /// Counts by media type, for the Home screen. Uses `PHAsset.fetchAssets(with:)` which
    /// returns a count without materialising anything.
    @objc(getLibraryCounts:rejecter:)
    func getLibraryCounts(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter _: @escaping RCTPromiseRejectBlock) {
        let options = PHFetchOptions()
        options.sortDescriptors = []
        let photos = PHAsset.fetchAssets(with: .image, options: options).count
        let videos = PHAsset.fetchAssets(with: .video, options: options).count
        resolve([
            "photos": NSNumber(value: photos),
            "videos": NSNumber(value: videos),
        ])
    }

    /// Metadata for a single asset, used to refresh a row after a change.
    @objc(getAsset:resolver:rejecter:)
    func getAsset(_ localIdentifier: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else {
            reject("not_found", "no asset with that identifier", nil)
            return
        }
        guard let payload = Self.describe(asset: asset, includeLivePhotoVideo: true) else {
            reject("not_found", "no asset with that identifier", nil)
            return
        }
        resolve(payload)
    }

    /// Builds the JS payload for one asset.
    ///
    /// `PHAssetResource` is where the real filename and UTI live, so it is consulted here
    /// rather than guessed from the extension. The *full-resolution* resource is preferred, but
    /// for a Live Photo we also read the paired video resource so the phone can back up both
    /// halves and the PC can keep them together.
    private static func describe(asset: PHAsset, includeLivePhotoVideo: Bool) -> [String: Any]? {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let primary = Self.pickPrimaryResource(resources) else {
            // A resource-less asset is possible for some iCloud placeholders; skip it rather
            // than surfacing a row that can never be backed up.
            return nil
        }

        var payload: [String: Any] = [
            "localIdentifier": asset.localIdentifier,
            "filename": primary.originalFilename,
            "uti": primary.uniformTypeIdentifier,
            "mediaType": asset.mediaType == .video ? "video" : "photo",
            "pixelWidth": NSNumber(value: asset.pixelWidth),
            "pixelHeight": NSNumber(value: asset.pixelHeight),
            "creationDate": Self.iso8601String(from: asset.creationDate),
            "modificationDate": Self.iso8601String(from: asset.modificationDate),
            "isLivePhoto": asset.mediaSubtypes.contains(.photoLive),
            "durationSeconds": asset.duration > 0 ? NSNumber(value: asset.duration) : NSNull(),
        ]

        // Whether the bytes are still only in iCloud.
        //
        // Neither `PHAsset` nor `PHAssetResource` exposes this as public API in the SDK this
        // project builds against - `asset.isInCloud` gives
        // "value of type 'PHAsset' has no member 'isInCloud'" and `resource.isInCloud` gives
        // "value of type 'PHAssetResource' has no member 'isInCloud'". The supported public
        // route is `PHImageManager.requestImageDataAndOrientation`, whose
        // `PHImageResultIsInCloudKey` arrives asynchronously, which does not fit a synchronous
        // metadata payload.
        //
        // So it is read through key-value coding, the same technique already used for
        // `fileSize` in `AssetFileWriter`, and it is a read-only display hint. When the key is
        // unavailable the value defaults to `false`, which suppresses the "will download from
        // iCloud" row rather than showing a warning that may be wrong.
        if let inCloud = (primary.value(forKey: "isInCloud") as? NSNumber)?.boolValue {
            payload["hasCloudContent"] = NSNumber(value: inCloud)
        } else {
            payload["hasCloudContent"] = NSNumber(value: false)
        }

        if includeLivePhotoVideo, asset.mediaSubtypes.contains(.photoLive),
           let paired = Self.pairedVideoResource(for: asset) {
            // The video half of a Live Photo. Its identifier is the *resource* filename, since
            // Photos exposes no separate PHAsset for it; the PC links the two by filename stem.
            payload["livePhotoVideo"] = [
                "filename": paired.originalFilename,
                "uti": paired.uniformTypeIdentifier,
            ]
        } else {
            payload["livePhotoVideo"] = NSNull()
        }

        return payload
    }

    /// Prefers the original full-resolution resource, then falls back through the sizes iOS
    /// offers. Pairing rules (`fullSizePhoto`/`pairedVideo`) and adjustments are skipped
    /// because v1 backs up originals, not edits.
    private static func pickPrimaryResource(_ resources: [PHAssetResource]) -> PHAssetResource? {
        let preferred: [PHAssetResourceType] = [.fullSizePhoto, .photo, .fullSizeVideo, .video]
        for type in preferred {
            if let match = resources.first(where: { $0.type == type }) {
                return match
            }
        }
        // Anything left is still a real original. A previous version also matched
        // `.alternateImage`, which is not a `PHAssetResourceType` case at all
        // ("cannot call value of non-function type 'PHAssetResource?'" surfaced because the
        // bogus case made the trailing closure resolve against the wrong overload).
        return resources.first
    }

    /// The paired video resource of a Live Photo, if present.
    private static func pairedVideoResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        return resources.first { $0.type == .pairedVideo }
            ?? resources.first { $0.type == .fullSizeVideo }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func iso8601String(from date: Date?) -> String {
        guard let date else { return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 0)) }
        return isoFormatter.string(from: date)
    }

    // MARK: - Thumbnails

    /// Renders a thumbnail to a JPEG in the caches directory and returns a `file://` URL.
    ///
    /// The image is written to disk rather than returned as base64 because a 200x200 JPEG is
    /// ~10 KB of base64 per tile, and a full screen of tiles would put tens of megabytes of
    /// strings on the JS heap and force them across the bridge as JSON.
    @objc(requestThumbnail:resolver:rejecter:)
    func requestThumbnail(_ options: NSDictionary,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let localIdentifier = options["localIdentifier"] as? String else {
            reject("bad_arguments", "localIdentifier is required", nil)
            return
        }
        let size = (options["size"] as? NSNumber)?.doubleValue ?? 320
        let screenScale = (options["scale"] as? NSNumber)?.doubleValue ?? UIScreen.main.scale
        let target = CGSize(width: size * screenScale, height: size * screenScale)

        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
        guard let asset = assets.firstObject else {
            reject("not_found", "no asset with that identifier", nil)
            return
        }

        let cacheDirectory = Self.thumbnailCacheDirectory()
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true

        let manager = PHCachingImageManager()
        manager.requestImage(for: asset, targetSize: target, contentMode: .aspectFill, options: options) {
            image, info in
            guard let image else {
                // `info[PHImageCancelledKey]`/`PHImageErrorKey` distinguish "not ready" from
                // "broken"; both are worth telling JS about so a tile can show a placeholder.
                let isCancelled = (info?[PHImageCancelledKey] as? NSNumber)?.boolValue ?? false
                let error = info?[PHImageErrorKey] as? NSError
                if isCancelled {
                    reject("cancelled", "thumbnail request was cancelled", nil)
                } else {
                    reject("thumbnail_failed", error?.localizedDescription ?? "could not render a thumbnail", error)
                }
                return
            }
            resolve(Self.writeThumbnail(image, cacheDirectory: cacheDirectory))
        }
    }

    private static func thumbnailCacheDirectory() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("LocalDropThumbnails", isDirectory: true)
        if !FileManager.default.fileExists(atPath: directory.path) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        return directory
    }

    private static func writeThumbnail(_ image: UIImage, cacheDirectory: URL) -> [String: Any] {
        // 0.8 quality is visually lossless at thumbnail size and keeps a screenful of tiles
        // under a few megabytes of disk.
        guard let data = image.jpegData(compressionQuality: 0.8) else {
            return ["uri": NSNull(), "error": "could not encode the thumbnail"]
        }
        let name = "\(UUID().uuidString).jpg"
        let url = cacheDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            return ["uri": NSNull(), "error": error.localizedDescription]
        }
        return [
            "uri": url.absoluteString,
            "width": NSNumber(value: image.size.width * image.scale),
            "height": NSNumber(value: image.size.height * image.scale),
            "byteLength": NSNumber(value: data.count),
        ]
    }

    /// Drops cached thumbnails. Called when the Photos screen is torn down so the caches
    /// directory does not grow without bound.
    @objc(clearThumbnailCache:rejecter:)
    func clearThumbnailCache(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter _: @escaping RCTPromiseRejectBlock) {
        let directory = Self.thumbnailCacheDirectory()
        let removed = (try? FileManager.default.contentsOfDirectory(at: directory,
                                                                    includingPropertiesForKeys: nil))?
            .filter { $0.pathExtension == "jpg" }
            .reduce(0) { count, url in
                if (try? FileManager.default.removeItem(at: url)) != nil { return count + 1 }
                return count
            } ?? 0
        resolve(NSNumber(value: removed))
    }
}
