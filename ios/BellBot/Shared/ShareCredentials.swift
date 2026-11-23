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
        /// サーバーのセッショントークン（app-sessions.md）。あれば`Authorization: Bearer`で使う。
        var sessionToken: String?
        /// この端末の購読確認の期限（アプリが書く。a540: 課金はこの端末の確認だけ）。購読が無ければnil。
        var paidUntil: Date?
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

    /// 書き直す時は消してから足す。`SecItemUpdate`は保護クラスを変えられないので、項目は常に「この端末だけ」で作り直す
    /// （クッキーを暗号化バックアップで別の端末へ渡さない）。
    static func save(_ snapshot: Snapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        let base = try query()
        let removed = SecItemDelete(base as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else { throw Failure.keychain(removed) }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
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
