import Foundation
import Network
import React

/// Finds LocalDrop servers on the local network with Bonjour/mDNS.
///
/// `NWBrowser` is used directly rather than a third-party library: it is the system resolver,
/// it works on every iOS version this app supports, and it adds no dependency. The user never
/// types an IP address unless discovery is blocked, which is why the manual-entry fallback in
/// the UI still matters.
@objc(LocalDropDiscovery)
final class LocalDropDiscovery: RCTEventEmitter {

    /// Must match `DISCOVERY_EVENT` in `src/native/NativeModules.ts`.
    private static let eventName = "LocalDropDiscoveryEvent"

    private let queue = DispatchQueue(label: "com.localdrop.discovery", qos: .userInitiated)
    private var browser: NWBrowser?
    private var listenerId: String?

    /// Suppresses duplicate results for the same host within this window.
    ///
    /// Bonjour re-announces on any network change, and a phone moving between access points can
    /// produce the same server several times a second. Without this the device list flickers.
    private var recentlySeen: [String: Date] = [:]
    private let duplicateWindow: TimeInterval = 10

    override static func requiresMainQueueSetup() -> Bool { false }

    // MARK: - RCTEventEmitter

    override func supportedEvents() -> [String]! { [Self.eventName] }

    override func startObserving() {}

    override func stopObserving() {
        // Leaving the screen stops the browse: mDNS traffic on a phone is not free, and a
        // background browse would keep the radio awake.
        queue.async {
            self.browser?.cancel()
            self.browser = nil
        }
    }

    private func emit(_ body: [String: Any]) {
        sendEvent(withName: Self.eventName, body: body)
    }

    // MARK: - Browsing

    /// Starts a browse for `_localdrop._tcp`.
    ///
    /// Resolves with immediately; results arrive as `LocalDropDiscoveryEvent` messages so the
    /// device list fills in progressively rather than after a fixed delay.
    @objc(startBrowsing:resolver:rejecter:)
    func startBrowsing(_ options: NSDictionary,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter _: @escaping RCTPromiseRejectBlock) {
        let serviceType = options["serviceType"] as? String ?? "_localdrop._tcp"
        let domain = options["domain"] as? String ?? "local."
        let listenerId = options["listenerId"] as? String ?? UUID().uuidString

        queue.async {
            self.listenerId = listenerId

            guard self.browser == nil else {
                // Already browsing; just acknowledge so a second call is harmless.
                resolve(["started": true, "listenerId": listenerId])
                return
            }

            let parameters = NWParameters()
            parameters.includePeerToPeer = false

            let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(
                type: serviceType,
                domain: domain
            )
            let browser = NWBrowser(for: descriptor, using: parameters)
            self.browser = browser

            browser.stateUpdateHandler = { [weak self] state in
                // `self` is weak, so it is optional here. An earlier version called
                // `self.emit(...)` directly, which does not compile
                // ("must be unwrapped to refer to member 'emit'").
                switch state {
                case .ready:
                    self?.emit([
                        "listenerId": listenerId,
                        "type": "ready",
                    ])
                case .failed(let error):
                    self?.emit([
                        "listenerId": listenerId,
                        "type": "failed",
                        "error": error.localizedDescription,
                    ])
                case .cancelled:
                    self?.emit([
                        "listenerId": listenerId,
                        "type": "stopped",
                    ])
                default:
                    break
                }
            }

            browser.browseResultsChangedHandler = { [weak self] results, _ in
                self?.handle(results: results, listenerId: listenerId, serviceType: serviceType, domain: domain)
            }

            browser.start(queue: self.queue)
            resolve(["started": true, "listenerId": listenerId])
        }
    }

    @objc(stopBrowsing:resolver:rejecter:)
    func stopBrowsing(_ listenerId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter _: @escaping RCTPromiseRejectBlock) {
        queue.async {
            self.listenerId = nil
            self.browser?.cancel()
            self.browser = nil
            self.recentlySeen.removeAll()
            self.emit([
                "listenerId": listenerId,
                "type": "stopped",
            ])
            resolve(true)
        }
    }

    private func handle(results: Set<NWBrowser.Result>,
                        listenerId: String,
                        serviceType: String,
                        domain: String) {
        let now = Date()
        var payload: [[String: Any]] = []

        for result in results {
            // `NWBrowser.Result` is not itself matched: the service information lives on its
            // `.endpoint`, an `NWEndpoint`. The current shape is
            //   .service(name:type:domain:interface:)
            // and there is no `txtRecord` associated value on the result - see the comment
            // below on why the port therefore comes from the TXT record only.
            guard case let .service(name, type, resolvedDomain, _) = result.endpoint else {
                continue
            }

            // The Bonjour service instance name is the PC's advertised name; mDNS publishes it
            // as `<name>.local`, and that is what forms the `http://host:port` the rest of the
            // app builds. NWBrowser deliberately does not resolve an address here - per Apple's
            // Network team that is intended behaviour, and resolving every result would be a
            // Bonjour anti-pattern - so the name is used and the OS resolves it on connect.
            //
            // The `.local` suffix is not optional. `URLSession` will not resolve a bare
            // single-label name, so `http://TEST-PC:47821` fails with "could not connect to
            // server" even though the browse found the PC, and the user sees an empty device
            // list. `.local` is also what `NSAllowsLocalNetworking` keys off, so it has to be
            // spelled here rather than appended later.
            let host = "\(Self.dnsLabel(name)).local"
            let txtRecord = Self.txtRecord(from: result)
            let port = Self.port(fromTXTRecord: txtRecord) ?? Self.defaultPort
            let key = "\(host):\(port)"

            if let seen = self.recentlySeen[key], now.timeIntervalSince(seen) < self.duplicateWindow {
                continue
            }
            self.recentlySeen[key] = now

            payload.append([
                "name": name,
                "host": host,
                "port": NSNumber(value: port),
                "serviceType": type,
                "domain": resolvedDomain.isEmpty ? domain : resolvedDomain,
                "protocolVersion": Self.stringValue("protocolVersion", in: txtRecord).flatMap(Int.init) ?? 0,
                "appVersion": Self.stringValue("appVersion", in: txtRecord) ?? "",
                "fullName": Self.stringValue("fullName", in: txtRecord) ?? "",
            ])
        }

        // Drop entries that have aged out so the map cannot grow for the life of the process.
        self.recentlySeen = self.recentlySeen.filter { now.timeIntervalSince($0.value) < 60 }

        self.emit([
            "listenerId": listenerId,
            "type": "results",
            "servers": payload,
        ])
    }

    // MARK: - Direct connection

    /// Resolves a user-entered host to a reachable address.
    ///
    /// The IP fallback exists because mDNS is blocked on some corporate and guest networks, and
    /// asking a user to type `192.168.1.42` should still work.
    @objc(resolveHost:port:resolver:rejecter:)
    func resolveHost(_ host: String,
                     port: NSNumber,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        let endpointHost = NWEndpoint.Host(host)
        // `NWEndpoint.Port` is a `RawRepresentable` of `UInt16`; the JS number has to be
        // converted rather than passed through, which is what
        // "cannot convert value of type 'NSNumber' to expected argument type 'NWEndpoint.Port'"
        // was about. A value outside 1...65535 is rejected here rather than trapping.
        guard let rawPort = UInt16(exactly: port.uint16Value), rawPort != 0 else {
            reject("bad_arguments", "\(host):\(port) is not a valid port", nil)
            return
        }
        let resolvedPort = NWEndpoint.Port(rawValue: rawPort)!

        queue.async {
            let connection = NWConnection(host: endpointHost, port: resolvedPort, using: .tcp)
            var settled = false

            // `RCTPromiseResolveBlock` takes `Any?`, so the value handed to it crosses into
            // JavaScript. A Swift `Result` is a non-`@objc` enum: boxed into `Any?` it becomes an
            // opaque `__SwiftValue` that serialises to `null`, so the promise resolved with
            // `null` and the caller threw on `reachability.reachable`. Only plain bridgeable
            // values - dictionaries, strings, numbers - are ever passed across.
            //
            // Failure is a `reject`, not a resolved result: a caller checking `reachable` cannot
            // tell "no" from "here is an error" otherwise, and the two need different wording.
            func succeed(_ body: [String: Any]) {
                guard !settled else { return }
                settled = true
                connection.cancel()
                resolve(body)
            }

            func fail(_ code: String, _ message: String) {
                guard !settled else { return }
                settled = true
                connection.cancel()
                reject(code, message, nil)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    succeed([
                        "reachable": true,
                        "host": host,
                        "port": NSNumber(value: Int(resolvedPort.rawValue)),
                    ])
                case .failed(let error):
                    fail("unreachable", "\(host):\(resolvedPort.rawValue) did not accept a connection: \(error.localizedDescription)")
                case .cancelled:
                    if !settled {
                        settled = true
                        reject("cancelled", "The connection attempt was cancelled", nil)
                    }
                default:
                    break
                }
            }

            // A short timeout: this runs on the UI thread's critical path when the user taps a
            // manually entered address, and a 30s TCP timeout would feel broken.
            self.queue.asyncAfter(deadline: .now() + 5) {
                if !settled {
                    settled = true
                    connection.cancel()
                    reject("timeout", "\(host) did not respond within 5 seconds", nil)
                }
            }

            connection.start(queue: self.queue)
        }
    }

    // MARK: - TXT record helpers

    /// Reads a TXT record entry as a string.
    ///
    /// `NWBrowser` exposes the record as `[String: String?]` where a value may be absent when
    /// the advertiser encoded it as binary, hence the `String?` and the trimming.
    static func stringValue(_ key: String, in record: [String: String?]) -> String? {
        guard let value = record[key] else { return nil }
        return value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func port(fromTXTRecord record: [String: String?]) -> UInt16? {
        guard let raw = stringValue("port", in: record) else { return nil }
        return UInt16(raw)
    }

    /// Best-effort TXT record for a browse result.
    ///
    /// `NWBrowser.Result` has no public accessor for the TXT record - it is not part of the
    /// `.service` associated values and not on `metadata`. Reading it therefore goes through
    /// key-value coding, which is the technique used across the Network framework's own
    /// helpers. It is fully guarded: if a future SDK stops answering this key, discovery still
    /// works, it just falls back to `defaultPort` and empty version strings.
    static func txtRecord(from result: NWBrowser.Result) -> [String: String?] {
        let mirror = Mirror(reflecting: result)
        for child in mirror.children where child.label == "metadata" {
            let metadataMirror = Mirror(reflecting: child.value)
            for field in metadataMirror.children
            where field.label == "txtRecord" || field.label == "bonjourTXTRecord" {
                if let record = field.value as? [String: String?] {
                    return record
                }
                if let record = field.value as? [String: String] {
                    return record.mapValues { Optional($0) }
                }
            }
        }
        return [:]
    }

    /// Kept in lock-step with `DEFAULT_PORT` in the shared contract and the Rust server.
    static let defaultPort: UInt16 = 47821

    /// Reduces a Bonjour instance name to a single DNS label.
    ///
    /// A Windows PC can be called "Anna's PC", and mDNS instance names may contain spaces, but
    /// the name we hand to `URLSession` is a host label and cannot. This mirrors `dns_label` in
    /// `apps/windows/src-tauri/src/bonjour.rs`, which builds the server's own host name from the
    /// same computer name with the same rule - so the two sides agree on what `Anna's PC` is
    /// called. If they disagreed, the browse would succeed and the connection would not.
    static func dnsLabel(_ name: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        let mapped = String(name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" })
        let trimmed = mapped.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? "localdrop-pc" : trimmed
    }
}
