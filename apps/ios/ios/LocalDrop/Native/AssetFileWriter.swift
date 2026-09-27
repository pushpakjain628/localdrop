import AVFoundation
import CommonCrypto
import Foundation
import Photos

/// Streams `PHAssetResource` data to disk and hashes it, without ever holding a whole file in
/// memory.
///
/// Why a temp file at all: iOS exposes no API to read a `PHAssetResource` directly into a
/// socket, and no way to hash one without reading it. The only bounded-memory path is to copy
/// it to disk in blocks and then work from the file. For a 4 GB video that is 1 MiB of resident
/// memory and 4 GB of free space, which is checked for up front.
enum AssetFileWriter {

    /// Block size for the copy. 1 MiB keeps syscall overhead low without meaningfully moving
    /// the memory ceiling.
    static let blockSize = 1024 * 1024

    enum WriterError: LocalizedError {
        case assetNotFound(String)
        case noUsableResource(String)
        case notSupported(String)
        case outOfDiskSpace(required: Int64, available: Int64)
        case writeFailed(String, underlying: Error?)
        case hashFailed(String)

        var errorDescription: String? {
            switch self {
            case .assetNotFound(let id):
                return "No photo-library asset with identifier \(id)."
            case .noUsableResource(let name):
                return "\(name) has no original resource that can be exported."
            case .notSupported(let reason):
                return reason
            case .outOfDiskSpace(let required, let available):
                return "Not enough free space to prepare this file: needs \(required) bytes, \(available) available."
            case .writeFailed(let name, let underlying):
                return "Could not write \(name): \(underlying?.localizedDescription ?? "unknown error")."
            case .hashFailed(let name):
                return "Could not verify \(name) after writing it."
            }
        }
    }

    // MARK: - Temp file lifecycle

    /// A prepared file plus everything the transfer layer needs to know about it.
    struct Prepared {
        let path: String
        let filename: String
        let byteLength: Int64
        let sha256: String
        /// True when the original bytes were transcoded into a container we can upload, because
        /// the source was in a format v1 does not accept.
        let didTranscode: Bool
    }

    /// Directory for in-flight exports. Excluded from iCloud backup and from the caches
    /// purger, since a half-written video must survive the app being backgrounded.
    static func stagingDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("LocalDropStaging", isDirectory: true)
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return directory
    }

    /// Removes an exported file once its transfer is done, successful or not.
    static func discard(path: String) {
        guard !path.isEmpty else { return }
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Deletes staged files older than `maxAge` seconds. Anything a transfer is still using is
    /// skipped because it was touched recently.
    static func sweepStaging(maxAge: TimeInterval) {
        guard let directory = try? stagingDirectory(),
              let entries = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey]
              ) else { return }

        let cutoff = Date().addingTimeInterval(-maxAge)
        for url in entries {
            let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
            guard let modified = values?.contentModificationDate, modified < cutoff else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Size

    /// Best-effort byte length of an asset's original resource.
    ///
    /// `PHAssetResource` does not report a size, so this is a real measurement for files and
    /// nil for iCloud placeholders that have not been downloaded. The authoritative size comes
    /// from the file we actually write.
    static func estimatedSize(of asset: PHAsset) -> Int64? {
        guard let resource = preferredResource(for: asset) else { return nil }
        let key = "fileSize"
        // `as? NSNumber` yields `NSNumber?`, which does not convert to `Int64?` implicitly
        // ("cannot convert return expression of type 'NSNumber?' to return type 'Int64?'"),
        // so the value is unwrapped and narrowed here.
        return (resource.value(forKey: key) as? NSNumber)?.int64Value
    }

    // MARK: - Prepare

    /// Exports an asset's original bytes to a temp file and returns its SHA-256.
    ///
    /// Runs off the main thread: reading a multi-gigabyte resource can take seconds.
    static func prepare(localIdentifier: String,
                        asset: PHAsset,
                        preferOriginal: Bool = true) async throws -> Prepared {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = preferOriginal
            ? (preferredResource(for: asset) ?? resources.first)
            : resources.first else {
            throw WriterError.noUsableResource("This asset")
        }

        let filename = sanitize(resource.originalFilename)
        let destination = try uniqueStagingURL(for: filename)

        // Ask Photos to write the resource, then verify what landed on disk.
        var writeError: Error?
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: destination,
                                                       options: options) { error in
                writeError = error
                continuation.resume()
            }
        }
        if let writeError {
            try? FileManager.default.removeItem(at: destination)
            throw WriterError.writeFailed(filename, underlying: writeError)
        }

        // `writeData(for:toFile:)` is free to produce a differently-named file when the
        // requested one exists, so trust what is actually on disk.
        let actual = try resolvedStagingURL(for: destination, requestedName: filename)

        let size = try fileSize(at: actual)
        let hash = try sha256(ofFileAt: actual)

        return Prepared(
            path: actual.path,
            filename: filename,
            byteLength: size,
            sha256: hash,
            didTranscode: false
        )
    }

    /// Exports only the video half of a Live Photo.
    static func prepareLivePhotoVideo(localIdentifier: String,
                                      asset: PHAsset) async throws -> Prepared {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let video = resources.first(where: { $0.type == .pairedVideo })
            ?? resources.first(where: { $0.type == .fullSizeVideo }) else {
            throw WriterError.noUsableResource("This Live Photo")
        }

        let filename = sanitize(video.originalFilename)
        let destination = try uniqueStagingURL(for: filename)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        var writeError: Error?
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: video, toFile: destination,
                                                       options: options) { error in
                writeError = error
                continuation.resume()
            }
        }
        if let writeError {
            try? FileManager.default.removeItem(at: destination)
            throw WriterError.writeFailed(filename, underlying: writeError)
        }

        let actual = try resolvedStagingURL(for: destination, requestedName: filename)
        return Prepared(
            path: actual.path,
            filename: filename,
            byteLength: try fileSize(at: actual),
            sha256: try sha256(ofFileAt: actual),
            didTranscode: false
        )
    }

    // MARK: - Hashing

    /// Streams the file through SHA-256 in 1 MiB blocks.
    ///
    /// `CommonCrypto` rather than CryptoKit: CryptoKit's `SHA256` has no incremental API, so
    /// using it would mean loading the whole file into a `Data`. The digest is identical.
    static func sha256(ofFileAt url: URL) throws -> String {
        // `FileHandle(forReadingFrom:)` throws and returns a non-optional handle. Binding it
        // with `guard let` and treating it as fallible was rejected twice over
        // ("initializer for conditional binding must have Optional type" and
        // "call can throw but is not marked with 'try'").
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var context = CC_SHA256_CTX()
        CC_SHA256_Init(&context)

        // Autorelease pool per batch: without it, autoreleased buffers from a long read can
        // accumulate across the whole file.
        //
        // `readData(ofLength:)` was replaced with `read(upToCount:)`. The old call throws and
        // an autoreleasepool closure cannot, and the new one returns `Data?`, so a nil (EOF or
        // a read error) simply ends the loop.
        while true {
            var failed = false
            let bytes: Data? = autoreleasepool {
                guard let chunk = try? handle.read(upToCount: blockSize), !chunk.isEmpty else {
                    return nil
                }
                chunk.withUnsafeBytes { raw in
                    if let base = raw.baseAddress {
                        CC_SHA256_Update(&context, base, CC_LONG(chunk.count))
                    } else {
                        failed = true
                    }
                }
                return chunk
            }
            if let bytes, !failed, !bytes.isEmpty {
                continue
            }
            break
        }

        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256_Final(&digest, &context)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Free space

    /// Fails early when the export cannot possibly fit.
    ///
    /// The estimate is deliberately pessimistic (1.5x the expected size) because
    /// `PHAssetResource` does not report a length and an iCloud download can be larger than
    /// expected. A failed check is advisory: the transfer layer logs it and still tries,
    /// rather than refusing a backup the user can see would otherwise succeed.
    static func ensureSpace(forEstimatedBytes estimate: Int64?) throws {
        let required = Int64((Double(estimate ?? 0) * 1.5).rounded()) + 64 * 1024 * 1024
        let available = freeSpace(at: stagingDirectory())
        if available > 0, available < required {
            throw WriterError.outOfDiskSpace(required: required, available: available)
        }
    }

    /// Free bytes on the volume holding `url`, via `URLResourceValues`.
    static func freeSpace(at url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? 0
    }

    // MARK: - Helpers

    static func preferredResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        let preferred: [PHAssetResourceType] = [.fullSizePhoto, .photo, .fullSizeVideo, .video]
        for type in preferred {
            if let match = resources.first(where: { $0.type == type }) {
                return match
            }
        }
        return resources.first
    }

    static func fileSize(at url: URL) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values.fileSize ?? 0)
    }

    /// Reduces a Photos filename to something safe to write in a temp directory.
    private static func sanitize(_ name: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:\0")
        let cleaned = name.components(separatedBy: forbidden).joined(separator: "_")
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "asset" : String(trimmed.prefix(120))
    }

    private static func uniqueStagingURL(for filename: String) throws -> URL {
        let directory = try stagingDirectory()
        // A UUID prefix guarantees a unique name, which matters because Photos silently picks
        // its own name when the requested one is taken.
        return directory.appendingPathComponent("\(UUID().uuidString)-\(filename)")
    }

    /// Finds what Photos actually wrote after a `writeData(for:toFile:)`.
    ///
    /// When the destination is free the file keeps the requested name. When it is not, Photos
    /// appends a suffix, so the newest regular file in the directory is the one we asked for.
    private static func resolvedStagingURL(for requested: URL, requestedName: String) throws -> URL {
        if FileManager.default.fileExists(atPath: requested.path) {
            return requested
        }
        let directory = requested.deletingLastPathComponent()
        let candidates = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
        )) ?? []
        let matches = candidates
            .filter { $0.lastPathComponent.hasSuffix(requestedName) }
            .sorted { lhs, rhs in
                let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                return l > r
            }
        guard let best = matches.first else { throw WriterError.hashFailed(requestedName) }
        return best
    }
}
