import Foundation
import Photos
import React

/// The JS-facing transfer API: prepare a file, upload it, hash it, clean up.
///
/// Splitting this from `LocalDropPhotos` keeps the read-only library queries (which the Photos
/// screen uses constantly) separate from the transfer path (which the Transfer screen drives).
///
/// Subclasses `RCTEventEmitter` so upload progress can be pushed to JS. Progress is the reason
/// this is an event rather than a polled value: a `URLSession` delegate callback is the only
/// place the byte count is known, and polling would either lag or spin.
@objc(LocalDropTransfer)
final class LocalDropTransfer: RCTEventEmitter {

    /// Must match `TRANSFER_PROGRESS_EVENT` in `src/native/NativeModules.ts`.
    private static let progressEvent = "LocalDropTransferProgress"

    private let uploader = FileUploader()

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String]! { [Self.progressEvent] }

    override func startObserving() {}

    override func stopObserving() {
        // A screen that goes away should not leave uploads running forever.
        uploader.cancelAll()
    }

    /// Pushes a progress event to JS, if anything is listening.
    private func emitProgress(_ body: [String: Any]) {
        sendEvent(withName: Self.progressEvent, body: body)
    }

    // MARK: - Introspection

    /// Resolves the number of uploads in flight, so JS can assert its retry logic is actually
    /// retrying rather than silently doing nothing.
    @objc(activeUploadCount:rejecter:)
    func activeUploadCount(_ resolve: RCTPromiseResolveBlock,
                           rejecter _: RCTPromiseRejectBlock) {
        resolve(NSNumber(value: uploader.activeCount))
    }

    // MARK: - Prepare

    /// Exports an asset (or its Live Photo video half) to a staging file and returns its
    /// SHA-256, so the PC can verify the bytes it receives.
    ///
    /// `asset` is a JS object: `{ localIdentifier, kind, livePhotoVideo? }` where `kind` is
    /// `"photo"`, `"video"` or `"livePhotoVideo"`.
    @objc(prepareAsset:resolver:rejecter:)
    func prepareAsset(_ options: NSDictionary,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let localIdentifier = options["localIdentifier"] as? String else {
            reject("bad_arguments", "localIdentifier is required", nil)
            return
        }
        let kind = options["kind"] as? String ?? "photo"

        // `AssetFileWriter.prepare` / `prepareLivePhotoVideo` are `async throws`, so this cannot
        // be a plain `DispatchQueue.async` closure - a synchronous function cannot await
        // ("'async' call in a function that does not support concurrency"). A `Task` provides
        // the concurrency context and still keeps the work off the main thread, because
        // `prepare` hops itself onto a background queue before touching PhotoKit.
        Task {
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
            guard let asset = assets.firstObject else {
                reject("not_found", "This item is no longer in your photo library.", nil)
                return
            }

            // Clear anything a previous attempt left behind before adding more.
            AssetFileWriter.sweepStaging(maxAge: 6 * 60 * 60)

            do {
                try AssetFileWriter.ensureSpace(forEstimatedBytes: AssetFileWriter.estimatedSize(of: asset))

                let prepared: AssetFileWriter.Prepared
                if kind == "livePhotoVideo" {
                    prepared = try await AssetFileWriter.prepareLivePhotoVideo(
                        localIdentifier: localIdentifier, asset: asset)
                } else {
                    prepared = try await AssetFileWriter.prepare(
                        localIdentifier: localIdentifier, asset: asset)
                }

                resolve([
                    "path": prepared.path,
                    "filename": prepared.filename,
                    "byteLength": NSNumber(value: prepared.byteLength),
                    "sha256": prepared.sha256,
                    "didTranscode": NSNumber(value: prepared.didTranscode),
                ])
            } catch {
                reject("prepare_failed", error.localizedDescription, error as NSError)
            }
        }
    }

    // MARK: - Upload

    /// Streams a prepared file to the PC.
    ///
    /// Progress events carry `{ transferId, bytesSent, totalBytes, fraction, bytesPerSecond,
    /// estimatedSecondsRemaining }`. Nothing about the file's contents crosses the bridge.
    @objc(uploadFile:resolver:rejecter:)
    func uploadFile(_ options: NSDictionary,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let transferId = options["transferId"] as? String,
              let path = options["path"] as? String,
              let urlString = options["url"] as? String,
              let url = URL(string: urlString) else {
            reject("bad_arguments", "transferId, path and url are required", nil)
            return
        }
        let method = options["method"] as? String ?? "PUT"

        var headers: [String: String] = [:]
        if let raw = options["headers"] as? [String: Any] {
            for (key, value) in raw {
                headers[key] = String(describing: value)
            }
        }

        let emit = { (progress: FileUploader.Progress) in
            self.emitProgress([
                "transferId": transferId,
                "bytesSent": NSNumber(value: progress.bytesSent),
                "totalBytes": NSNumber(value: progress.totalBytes),
                "fraction": NSNumber(value: progress.fraction),
                "bytesPerSecond": NSNumber(value: progress.bytesPerSecond),
                "estimatedSecondsRemaining": progress.estimatedSecondsRemaining.map { NSNumber(value: $0) } ?? NSNull(),
            ])
        }

        uploader.upload(transferId: transferId,
                        filePath: path,
                        to: url,
                        method: method,
                        headers: headers,
                        onProgress: emit) { result in
            switch result {
            case .success(let value):
                resolve([
                    "statusCode": NSNumber(value: value.statusCode),
                    "body": String(data: value.body, encoding: .utf8) ?? "",
                ])
            case .failure(let error):
                reject("upload_failed", error.localizedDescription, error as NSError)
            }
        }
    }

    @objc(cancelUpload:resolver:rejecter:)
    func cancelUpload(_ transferId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter _: RCTPromiseRejectBlock) {
        uploader.cancel(transferId: transferId)
        resolve(true)
    }

    @objc(cancelAllUploads:rejecter:)
    func cancelAllUploads(_ resolve: RCTPromiseResolveBlock,
                          rejecter _: RCTPromiseRejectBlock) {
        uploader.cancelAll()
        resolve(true)
    }

    // MARK: - Housekeeping

    /// Deletes a prepared file once its transfer is finished.
    @objc(discardPreparedFile:resolver:rejecter:)
    func discardPreparedFile(_ path: String,
                             resolve: @escaping RCTPromiseResolveBlock,
                             rejecter _: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .utility).async {
            AssetFileWriter.discard(path: path)
            resolve(true)
        }
    }

    /// Removes staged files left behind by a crash. Called on launch.
    @objc(sweepStaging:rejecter:)
    func sweepStaging(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter _: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .utility).async {
            AssetFileWriter.sweepStaging(maxAge: 6 * 60 * 60)
            resolve(true)
        }
    }

    /// Frees temporary space and reports what is reclaimable.
    @objc(stagingFootprint:rejecter:)
    func stagingFootprint(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter _: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .utility).async {
            guard let directory = try? AssetFileWriter.stagingDirectory(),
                  let entries = try? FileManager.default.contentsOfDirectory(
                    at: directory,
                    includingPropertiesForKeys: [.fileSizeKey]
                  ) else {
                resolve(["fileCount": 0, "byteLength": 0, "freeSpaceBytes": 0])
                return
            }
            var bytes: Int64 = 0
            for url in entries {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                bytes += Int64(size)
            }
            resolve([
                "fileCount": NSNumber(value: entries.count),
                "byteLength": NSNumber(value: bytes),
                "freeSpaceBytes": NSNumber(value: AssetFileWriter.freeSpace(at: directory)),
            ])
        }
    }
}
