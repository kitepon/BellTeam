import Foundation

/// 接続先はHTTPS、または同じマシン・LANで使うHTTPを受け付ける。
enum ServerOrigin {
    static func url(_ address: String) -> URL? {
        guard var parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              scheme == "https" || (scheme == "http" && isLocalHost(host)) else { return nil }
        parts.scheme = scheme
        parts.host = host
        parts.path = ""
        return parts.url
    }

    static func isLocalHost(_ supplied: String) -> Bool {
        let host = supplied.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if host.contains(":") {
            return host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") || host.range(of: "^fe[89ab][0-9a-f]:", options: .regularExpression) != nil
        }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        let bytes = octets.compactMap { UInt8($0) }
        if octets.count == 4, bytes.count == 4 {
            return bytes[0] == 10 || bytes[0] == 127 || (bytes[0] == 192 && bytes[1] == 168)
                || (bytes[0] == 172 && (16...31).contains(bytes[1])) || (bytes[0] == 169 && bytes[1] == 254)
        }
        return !host.contains(".") && !host.allSatisfy { $0.isNumber }
    }
}
