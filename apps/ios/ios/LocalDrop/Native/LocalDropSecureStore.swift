import Foundation
import Security

/// Keychain-backed storage for the pairing token and the saved PC address.
///
/// The bearer token is a credential that grants write access to a user's photo library backup,
/// so it goes in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
/// readable by background uploads after the first unlock, never synced to iCloud Keychain, and
/// never restored onto a different device. `WhenUnlocked` would break a backup that resumes
/// while the phone is locked, and `Always` would leak the token into an unencrypted backup.
@objc(LocalDropSecureStore)
final class LocalDropSecureStore: NSObject {

    /// Service name; also the namespace for every item this module stores.
    private static let service = "com.localdrop.windows.pairing"

    private enum Key {
        static let token = "serverToken"
        static let serverId = "serverId"
        static let serverName = "serverName"
        static let host = "serverHost"
        static let port = "serverPort"
        static let deviceId = "deviceId"
        static let deviceName = "deviceName"
    }

    @objc static func requiresMainQueueSetup() -> Bool { false }

    // MARK: - Generic accessors

    /// Stores a value, replacing any existing item with the same key.
    @objc(setValue:forKey:resolver:rejecter:)
    func setValue(_ value: String,
                  forKey key: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let data = value.data(using: .utf8) else {
            reject("bad_arguments", "value must be a UTF-8 string", nil)
            return
        }

        // Delete first: `SecItemUpdate` fails with `errSecItemNotFound` on the first write, and
        // delete-then-add keeps the logic to one path.
        SecItemDelete(Self.baseQuery(key: key) as CFDictionary)

        var attributes = Self.baseQuery(key: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess {
            resolve(true)
        } else {
            reject("keychain_write_failed",
                   "Could not save to the Keychain (status \(status)).", nil)
        }
    }

    /// Reads a value, resolving to `null` when the item does not exist.
    @objc(getValue:forKey:resolver:rejecter:)
    func getValue(_ key: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter _: @escaping RCTPromiseRejectBlock) {
        var query = Self.baseQuery(key: key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                resolve(nil)
                return
            }
            resolve(value)
        case errSecItemNotFound:
            resolve(nil)
        default:
            // A Keychain that is unavailable (a jailbroken device, a misconfigured entitlement)
            // must not look like "no pairing stored" - that would silently make the user re-pair
            // every launch. Surface it.
            resolve(["__error": "keychain_read_failed", "status": NSNumber(value: status)])
        }
    }

    @objc(removeValue:forKey:resolver:rejecter:)
    func removeValue(_ key: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter _: @escaping RCTPromiseRejectBlock) {
        let status = SecItemDelete(Self.baseQuery(key: key) as CFDictionary)
        resolve(NSNumber(value: status == errSecSuccess || status == errSecItemNotFound))
    }

    /// Removes every LocalDrop item. Used by "Unpair this PC".
    @objc(clearAll:rejecter:)
    func clearAll(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter _: @escaping RCTPromiseRejectBlock) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
        ]
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        let status = SecItemDelete(query as CFDictionary)
        resolve(NSNumber(value: status == errSecSuccess || status == errSecItemNotFound))
    }

    // MARK: - Pairing

    /// The whole saved pairing, or `null` when this device has never paired.
    ///
    /// Returned as one object so the UI can make a single decision ("is this the PC I was
    /// talking to?") rather than assembling it from several async reads.
    @objc(loadPairing:rejecter:)
    func loadPairing(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter _: @escaping RCTPromiseRejectBlock) {
        let token = readString(Key.token)
        let serverId = readString(Key.serverId)

        guard let token, let serverId else {
            resolve(nil)
            return
        }

        resolve([
            "token": token,
            "serverId": serverId,
            "serverName": readString(Key.serverName) ?? "",
            "host": readString(Key.host) ?? "",
            "port": readString(Key.port).flatMap(Int.init) ?? 0,
            "deviceId": readString(Key.deviceId) ?? "",
            "deviceName": readString(Key.deviceName) ?? "",
        ])
    }

    /// Persists a successful pairing. Every field is written in one go so a crash midway cannot
    /// leave a token with no server address.
    @objc(savePairing:resolver:rejecter:)
    func savePairing(_ pairing: NSDictionary,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let token = pairing["token"] as? String, !token.isEmpty,
              let serverId = pairing["serverId"] as? String, !serverId.isEmpty else {
            reject("bad_arguments", "token and serverId are required", nil)
            return
        }

        let values: [String: String] = [
            Key.token: token,
            Key.serverId: serverId,
            Key.serverName: pairing["serverName"] as? String ?? "",
            Key.host: pairing["host"] as? String ?? "",
            Key.port: String((pairing["port"] as? NSNumber)?.intValue ?? 0),
            Key.deviceId: pairing["deviceId"] as? String ?? "",
            Key.deviceName: pairing["deviceName"] as? String ?? "",
        ]

        for (key, value) in values {
            guard let data = value.data(using: .utf8) else { continue }
            SecItemDelete(Self.baseQuery(key: key) as CFDictionary)
            var attributes = Self.baseQuery(key: key)
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(attributes as CFDictionary, nil)
            guard status == errSecSuccess else {
                reject("keychain_write_failed",
                       "Could not save the pairing (status \(status) for \(key)).", nil)
                return
            }
        }
        resolve(true)
    }

    /// Forgets the pairing without forgetting this device's identity.
    ///
    /// The install id and device name are kept so re-pairing does not register a second device
    /// row on the PC, and so the PC's "unpair" list does not accumulate duplicates.
    @objc(clearPairing:rejecter:)
    func clearPairing(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter _: @escaping RCTPromiseRejectBlock) {
        for key in [Key.token, Key.serverId, Key.serverName, Key.host, Key.port] {
            SecItemDelete(Self.baseQuery(key: key) as CFDictionary)
        }
        resolve(true)
    }

    // MARK: - Install identity

    /// A stable per-install identifier, generated on first use.
    ///
    /// `identifierForVendor` is not used: it resets when the last app from the same vendor is
    /// removed, which would make the PC see a "new" device and leave a stale token behind.
    @objc(deviceIdentity:rejecter:)
    func deviceIdentity(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter _: @escaping RCTPromiseRejectBlock) {
        let deviceId = readString(Key.deviceId) ?? ""
        if !deviceId.isEmpty {
            resolve(["deviceId": deviceId, "deviceName": readString(Key.deviceName) ?? ""])
            return
        }

        let generated = UUID().uuidString
        write(generated, forKey: Key.deviceId)
        let name = UIDevice.current.name
        write(name, forKey: Key.deviceName)
        resolve(["deviceId": generated, "deviceName": name])
    }

    // MARK: - Internals

    private static func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private func readString(_ key: String) -> String? {
        var query = Self.baseQuery(key: key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    private func write(_ value: String, forKey key: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        SecItemDelete(Self.baseQuery(key: key) as CFDictionary)
        var attributes = Self.baseQuery(key: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }
}
