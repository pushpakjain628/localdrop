import Foundation

/// A file-backed `URLSession` upload with progress.
///
/// This is the reason the transfer layer can promise that a large video never enters the
/// React Native JS heap: `URLSession.uploadTask(with:fromFile:)` reads the body from disk and
/// streams it over the socket, so peak memory is one socket buffer regardless of file size.
/// A `Data`-body task would materialise the whole file in the app process.
///
/// Progress arrives as delegate callbacks on an operation queue; they are forwarded to JS as
/// events, rate-limited so a fast transfer does not flood the bridge.
final class FileUploader: NSObject {

    struct Progress {
        let bytesSent: Int64
        let totalBytes: Int64
        let fraction: Double
        let bytesPerSecond: Double
        let estimatedSecondsRemaining: Double?
    }

    struct Result {
        let statusCode: Int
        let body: Data
        /// True when the server's response indicated the bytes arrived intact.
        var isSuccess: Bool { (200..<300).contains(statusCode) }
    }

    enum UploadError: LocalizedError {
        case badURL(String)
        case fileMissing(String)
        case responseTooLarge
        case http(Int, String)
        case transport(Error)
        case cancelled

        var errorDescription: String? {
            switch self {
            case .badURL(let url): return "Invalid destination URL: \(url)"
            case .fileMissing(let path): return "The prepared file disappeared: \(path)"
            case .responseTooLarge: return "The server sent an unexpectedly large response."
            case .http(let code, let message): return "Server returned \(code): \(message)"
            case .transport(let error): return "Network error: \(error.localizedDescription)"
            case .cancelled: return "The transfer was cancelled."
            }
        }
    }

    /// One in-flight upload, so it can be cancelled and so its delegate callbacks can be
    /// attributed to the right transfer id.
    private final class Job: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate {
        let transferId: String
        let task: URLSessionUploadTask
        var collected = Data()
        var response: HTTPURLResponse?
        // `Swift.Result<UploadError, FileUploader.Result>`: an unqualified `Result` here binds
        // to the enclosing `FileUploader.Result` struct, which is not generic, so
        // `Result<UploadError>` was rejected with "cannot specialize non-generic type".
        var completion: ((Swift.Result<UploadError, FileUploader.Result>) -> Void)?
        var onProgress: ((Progress) -> Void)?

        private var lastEmit: TimeInterval = 0
        private var startedAt: Date?
        private let emitInterval: TimeInterval

        init(transferId: String,
             task: URLSessionUploadTask,
             emitInterval: TimeInterval = 0.2) {
            self.transferId = transferId
            self.task = task
            self.emitInterval = emitInterval
        }

        // MARK: Progress

        func didSendBodyData(_ session: URLSession,
                             task: URLSessionTask,
                             didSendBodyData bytesSent: Int64,
                             totalBytesSent: Int64,
                             totalBytesExpectedToSend: Int64) {
            let now = Date()
            if startedAt == nil { startedAt = now }
            // Throttle: a fast upload would otherwise emit hundreds of events per second, each
            // one a bridge crossing and a React render.
            guard now.timeIntervalSince(lastEmit) >= emitInterval else { return }
            lastEmit = now.timeIntervalSince1970

            let total = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : 0
            let fraction = total > 0 ? min(Double(totalBytesSent) / Double(total), 1) : 0
            let elapsed = now.timeIntervalSince(startedAt ?? now)
            let rate = elapsed > 0 ? Double(totalBytesSent) / elapsed : 0
            let remaining = total > totalBytesSent && rate > 0
                ? Double(total - totalBytesSent) / rate
                : nil

            onProgress?(Progress(
                bytesSent: totalBytesSent,
                totalBytes: total,
                fraction: fraction,
                bytesPerSecond: rate,
                estimatedSecondsRemaining: remaining
            ))
        }

        // MARK: Response

        func urlSession(_ session: URLSession,
                        dataTask: URLSessionDataTask,
                        didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            if let http = response as? HTTPURLResponse {
                self.response = http
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession,
                        dataTask: URLSessionDataTask,
                        didReceive data: Data) {
            // A well-behaved server answers these routes with a small JSON object. Cap the
            // buffer so a misbehaving one cannot exhaust memory.
            if collected.count < 1_048_576 {
                collected.append(data)
            }
        }

        func urlSession(_ session: URLSession,
                        task: URLSessionTask,
                        didCompleteWithError error: Error?) {
            // `Swift.Result` is spelled out because, from inside this nested class, an
            // unqualified `Result` binds to the enclosing `FileUploader.Result` (a plain
            // struct, not generic), which made `Result<UploadError>.failure` fail to compile.
            let finish: (UploadError?) -> Void = { failure in
                self.completion?(failure.map { Swift.Result<UploadError, FileUploader.Result>.failure($0) }
                    ?? .success(self.result()))
            }
            if let error = error as? URLError, error.code == .cancelled {
                finish(.cancelled)
                return
            }
            if let error {
                finish(.transport(error))
                return
            }
            finish(nil)
        }

        private func result() -> Result {
            let status = response?.statusCode ?? 0
            let body = collected
            guard status > 0 else { return .init(statusCode: 0, body: body) }
            return .init(statusCode: status, body: body)
        }
    }

    private let session: URLSession
    /// Jobs by transfer id, so `cancel` can find them.
    private var jobs: [String: Job] = [:]
    private let lock = NSLock()

    /// A per-host session. `waitsForConnectivity` matters on Wi-Fi: without it a transfer that
    /// starts while the phone is still associating fails instantly instead of waiting.
    override init() {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForRequest = 60
        // Uploads must not be treated as cacheable; a retry must actually resend the body.
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.networkServiceType = .responsiveData
        // A big video over a long-lived Wi-Fi link: allow the OS to batch to save radio time.
        configuration.allowsConstrainedNetworkAccess = true
        session = URLSession(configuration: configuration)
        super.init()
    }

    deinit {
        session.finishTasksAndInvalidate()
    }

    /// Uploads `filePath` to `url` and reports progress.
    ///
    /// The completion receives `Swift.Result<UploadError, Result>`: the failure side carries an
    /// `UploadError` so `LocalDropTransfer` can reject the JS promise with a real reason, and
    /// the success side carries the HTTP `Result`. It is spelled `Swift.Result` because, in this
    /// file, a bare `Result` means the nested `FileUploader.Result` struct.
    func upload(transferId: String,
                filePath: String,
                to url: URL,
                method: String,
                headers: [String: String],
                onProgress: @escaping (Progress) -> Void,
                completion: @escaping (Swift.Result<UploadError, Result>) -> Void) {
        guard FileManager.default.fileExists(atPath: filePath) else {
            completion(.failure(.fileMissing(filePath)))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        // The body is the file itself; nothing is set as `httpBody`, which is the entire point.
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")

        let task = session.uploadTask(with: request, fromFile: URL(fileURLWithPath: filePath))
        let job = Job(transferId: transferId, task: task)
        job.onProgress = onProgress
        job.completion = { result in
            self.lock.lock()
            self.jobs.removeValue(forKey: transferId)
            self.lock.unlock()
            completion(result)
        }

        lock.lock()
        jobs[transferId] = job
        lock.unlock()

        task.resume()
    }

    func cancel(transferId: String) {
        lock.lock()
        let job = jobs[transferId]
        lock.unlock()
        job?.task.cancel()
    }

    func cancelAll() {
        lock.lock()
        let active = Array(jobs.values)
        lock.unlock()
        active.forEach { $0.task.cancel() }
    }

    /// Number of uploads currently in flight. Used by the JS layer to detect that a retry
    /// actually reached the network.
    var activeCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return jobs.count
    }
}
