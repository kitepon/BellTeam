import Foundation
import Security

/// アプリが書き、共有拡張が読む。接続先と、あればCloudflare Accessのクッキー、購読の有効期限を、
/// 共有Keychainの1項目（同じチーム・同じアプリの範囲）に置く。拡張は自分でログインしない。
enum ShareCredentials {
    struct Snapshot: Codable, Equatable {
        var serverURL: String
        /// `Cookie`ヘッダーの値。LANのHTTP接続などクッキーの無い接続先ではnil。
        var cookieHeader: String?
        var cookieExpiresAt: Date?
        /// Appleの購読が有効な期限。サーバーが開発者モードの接続先では使わない。
        var entitledUntil: Date?
    }

    enum Failure: Error, LocalizedError {
        case missingGroup
        case keychain(OSStatus)
        var errorDescription: String? {
            switch self {
            case .missingGroup: "共有Keychainのグループが設定されていません。"
            case .keychain(let status): "共有Keychainを使えません（\(status)）。"
            }
        }
    }

    private static let service = "dev.kitepon.bellteam.share"
    private static let account = "credentials"

    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "BellTeamKeychainGroup") as? String }

    private static func query() throws -> [String: Any] {
        guard let group, !group.isEmpty, !group.contains("$(") else { throw Failure.missingGroup }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
        #if targetEnvironment(macCatalyst)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    static func save(_ snapshot: Snapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        let base = try query()
        let update = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw Failure.keychain(update) }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    /// 書かれていなければnil（アプリで未ログイン）。
    static func load() throws -> Snapshot? {
        var read = try query()
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure.keychain(status) }
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func clear() throws {
        let status = SecItemDelete(try query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
    }
}
