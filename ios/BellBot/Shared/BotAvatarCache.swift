import Foundation
import ImageIO
import UniformTypeIdentifiers

/// アプリと通知拡張がApp Groupで共有するアバター。拡張はネットワークを使わない。
struct BotAvatarCache {
    static var appGroupIdentifier: String {
        get throws {
            guard let value = Bundle.main.object(forInfoDictionaryKey: "BellTeamAppGroupIdentifier") as? String,
                  value.hasPrefix("group."), !value.contains("$") else {
                throw CacheError.invalidAppGroup
            }
            return value
        }
    }

    static var shared: BotAvatarCache {
        get throws {
            guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: try appGroupIdentifier) else {
                throw CacheError.unavailableAppGroup
            }
            return BotAvatarCache(root: root)
        }
    }

    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func store(_ avatars: [(id: String, dataURL: String)], server: String) throws {
        try storeVersioned(avatars.map { (id: $0.id, dataURL: $0.dataURL, version: Optional<String>.none) }, server: server)
    }

    func storeVersioned(_ avatars: [(id: String, dataURL: String, version: String?)], server: String) throws {
        guard let directory = try directoryURL(server: server, create: true) else { return }
        let versionFile = directory.appendingPathComponent("versions.json")
        let previous = try versions(in: directory)
        var current: [String: String] = [:]
        var kept: Set<String> = []
        for avatar in avatars {
            guard let name = Self.fileName(for: avatar.id) else { continue }
            let file = directory.appendingPathComponent(name)
            if let data = Self.imageData(from: avatar.dataURL) {
                if avatar.version == nil || previous[name] != avatar.version || !FileManager.default.fileExists(atPath: file.path) {
                    try data.write(to: file, options: .atomic)
                }
                current[name] = avatar.version
                kept.insert(name)
            } else if FileManager.default.fileExists(atPath: file.path) {
                try FileManager.default.removeItem(at: file)
            }
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        for name in names where !kept.contains(name) && Self.fileName(for: name) != nil {
            try FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
        if current != previous { try JSONEncoder().encode(current).write(to: versionFile, options: .atomic) }
    }

    func dataURL(botID: String, server: String, version: String) throws -> String? {
        guard let directory = try directoryURL(server: server, create: false),
              try versions(in: directory)[botID] == version,
              let data = try imageData(botID: botID, server: server) else { return nil }
        guard let image = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(image),
              let mime = UTType(type as String)?.preferredMIMEType else { throw CacheError.invalidImage }
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }

    private func versions(in directory: URL) throws -> [String: String] {
        let file = directory.appendingPathComponent("versions.json")
        if !FileManager.default.fileExists(atPath: file.path) { return [:] }
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
    }

    func imageData(botID: String, server: String) throws -> Data? {
        guard let directory = try directoryURL(server: server, create: false),
              let name = Self.fileName(for: botID) else { return nil }
        let file = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let data = try Data(contentsOf: file)
        guard Self.isImageData(data) else { throw CacheError.invalidImage }
        return data
    }

    static func origin(_ server: String) -> String? {
        ServerOrigin.url(server)?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func fileName(for identifier: String) -> String? {
        guard (1...64).contains(identifier.count), identifier.first != "-",
              identifier.unicodeScalars.allSatisfy({ safeIdentifier.contains($0) }) else { return nil }
        return identifier
    }

    static func imageData(from dataURL: String) -> Data? {
        guard let comma = dataURL.firstIndex(of: ",") else { return nil }
        let header = dataURL[..<comma].lowercased()
        guard header.hasPrefix("data:image/"), header.hasSuffix(";base64"),
              ["jpeg", "jpg", "png", "webp", "gif"].contains(where: { header.contains("image/\($0)") }) else { return nil }
        guard let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]), options: .ignoreUnknownCharacters),
              isImageData(data) else { return nil }
        return data
    }

    private func directoryURL(server: String, create: Bool) throws -> URL? {
        guard let origin = Self.origin(server) else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-"))
        guard let name = origin.addingPercentEncoding(withAllowedCharacters: allowed), !name.isEmpty else { return nil }
        let directory = root.appendingPathComponent("avatars", isDirectory: true).appendingPathComponent(name, isDirectory: true)
        if create {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } else if !FileManager.default.fileExists(atPath: directory.path) {
            return nil
        }
        return directory
    }

    private static let safeIdentifier = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")

    static func isImageData(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
        return CGImageSourceCreateImageAtIndex(source, 0, nil) != nil
    }

    private enum CacheError: LocalizedError {
        case invalidAppGroup, unavailableAppGroup, invalidImage

        var errorDescription: String? {
            switch self {
            case .invalidAppGroup: return "通知のApp Group設定が不正です。"
            case .unavailableAppGroup: return "通知の共有アバター保存先を開けません。"
            case .invalidImage: return "通知のアバター画像を読み込めません。"
            }
        }
    }
}
