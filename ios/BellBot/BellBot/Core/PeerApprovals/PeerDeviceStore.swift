import CryptoKit
import Foundation
import PeerChannel
import Security

/// This device's peer-channel keys and its verified registry copy (contract 5; docs/architecture/modules/approval-box-extension/peer-channel-signin.md).
/// Keychain only, readable after the first unlock so a notification extension can use them. Own service: nothing of BellTeam's own sign-in shares it.
/// Ported from Approval Box's Apple app (kitepon/approval-box-apps PeerDeviceStore.swift) with its service name changed.
struct PeerDeviceKeys {
    let signer: Signer
    let sealing: SealingKey
    var identity: PublicIdentity { get throws { try PublicIdentity(signingPoint: signer.signingPoint, sealingPoint: sealing.point) } }
}

struct PeerDeviceStore: Sendable {
    var service = "dev.kitepon.bellbot.approval-box.peer"
    var accessGroup: String?

    private enum Kind: UInt8 { case secureEnclave = 1, software = 2 }

    private func signer(from item: Data) throws -> Signer {
        switch (Kind(rawValue: item.first ?? 0), item.dropFirst()) {
        case let (.secureEnclave?, data): return try .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data))
        case let (.software?, data): return .software(try P256.Signing.PrivateKey(rawRepresentation: data))
        default: throw PeerDeviceStoreError.unreadable("signing")
        }
    }

    private func sealing(from item: Data) throws -> SealingKey {
        switch (Kind(rawValue: item.first ?? 0), item.dropFirst()) {
        case let (.secureEnclave?, data): return try .secureEnclave(try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data))
        case let (.software?, data): return .software(try P256.KeyAgreement.PrivateKey(rawRepresentation: data))
        default: throw PeerDeviceStoreError.unreadable("sealing")
        }
    }

    /// The keys this device already has, never new ones (a Notification Service Extension must not make keys of its own). nil when either is missing.
    func existingKeys() throws -> PeerDeviceKeys? {
        guard let s = try read("signing"), let e = try read("sealing") else { return nil }
        return PeerDeviceKeys(signer: try signer(from: s), sealing: try sealing(from: e))
    }

    /// Loads the keys, or makes them on first use: Secure Enclave where the device has one, else Keychain software keys.
    /// The registry entry carries the real `protection` of each key (hardware or os_store), so the other devices see what this one is.
    func keys() throws -> PeerDeviceKeys {
        let signer: Signer
        if let item = try read("signing") { signer = try self.signer(from: item) }
        else if SecureEnclave.isAvailable {
            let key = try SecureEnclave.P256.Signing.PrivateKey()
            try write("signing", Data([Kind.secureEnclave.rawValue]) + key.dataRepresentation)
            signer = try .secureEnclave(key)
        } else {
            let key = P256.Signing.PrivateKey()
            try write("signing", Data([Kind.software.rawValue]) + key.rawRepresentation)
            signer = .software(key)
        }
        let sealing: SealingKey
        if let item = try read("sealing") { sealing = try self.sealing(from: item) }
        else if SecureEnclave.isAvailable {
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
            try write("sealing", Data([Kind.secureEnclave.rawValue]) + key.dataRepresentation)
            sealing = try .secureEnclave(key)
        } else {
            let key = P256.KeyAgreement.PrivateKey()
            try write("sealing", Data([Kind.software.rawValue]) + key.rawRepresentation)
            sealing = .software(key)
        }
        return PeerDeviceKeys(signer: signer, sealing: sealing)
    }

    private struct StoredSnapshot: Codable { let body: Data, signer: Data, sig: Data }

    /// The verified registry of `account`: its head snapshots, bootstrapped again on load (the checks run again). nil when none is stored.
    func registry(account: String) throws -> Registry? {
        guard let data = try read("registry." + account) else { return nil }
        let stored = try JSONDecoder().decode([StoredSnapshot].self, from: data).map { SignedSnapshot(body: $0.body, signer: $0.signer, sig: $0.sig) }
        guard let first = stored.first else { throw PeerDeviceStoreError.unreadable("registry") }
        var registry = Registry(account: account)
        try registry.bootstrap(first, expectedHash: first.hash)
        try registry.apply(Array(stored.dropFirst()), source: .mirror)
        return registry
    }

    func save(_ registry: Registry) throws {
        try write("registry." + registry.account, try JSONEncoder().encode(registry.headSnapshots.map { StoredSnapshot(body: $0.body, signer: $0.signer, sig: $0.sig) }))
    }

    /// Removes the keys and every stored registry of this device (account deleted, close 4410).
    func eraseAll() throws {
        var q = base(nil)
        #if targetEnvironment(macCatalyst)
        q[kSecMatchLimit as String] = kSecMatchLimitAll  // the Mac keychain deletes one item per call without this; iOS refuses the key (errSecParam)
        #endif
        let status = SecItemDelete(q as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PeerDeviceStoreError.keychain(status) }
    }

    private func base(_ account: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let account { q[kSecAttrAccount as String] = account }
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    private func read(_ account: String) throws -> Data? {
        var q = base(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw PeerDeviceStoreError.keychain(status) }
        return data
    }

    private func write(_ account: String, _ data: Data) throws {
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem { status = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary) }
        guard status == errSecSuccess else { throw PeerDeviceStoreError.keychain(status) }
    }
}

enum PeerDeviceStoreError: Error, Equatable { case keychain(OSStatus), unreadable(String) }
