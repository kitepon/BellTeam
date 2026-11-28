import Foundation

/// 共有された内容。ファイルは、本体の対応が本番に出るまで受け付けない（forward.md）。
struct SharedContent: Equatable {
    var text = ""
    var urls: [String] = []
    var images: [SharedImage] = []
    var refusal: String?

    var isEmpty: Bool { text.isEmpty && urls.isEmpty && images.isEmpty }
}

struct SharedImage: Equatable {
    let data: Data
    let mime: String
}

enum ShareLimits {
    static let images = 10
    static let urls = 20
    static let text = 20_000
    static let imageBytes = 40 * 1024 * 1024
}

/// 送り先の一覧と送信。認証情報は、アプリが共有Keychainへ書いたものだけを使う。
struct ShareClient {
    struct Destination: Identifiable, Equatable {
        enum Kind { case bot, room }
        let kind: Kind
        let id: String
        let name: String
        var path: String { "/api/\(kind == .bot ? "bots" : "rooms")/\(id)" }
    }

    enum Failure: Error, Equatable {
        case notSignedIn
        case expired
        case subscription
        case http(Int)
        case network
    }

    let credentials: ShareCredentials.Snapshot
    /// トークンを付けた要求はリダイレクトを辿らない（BellAPIと同じ規則、Mintの適合確認 c）。
    var session: URLSession = ShareClient.guarded

    static let guarded = URLSession(configuration: .default, delegate: BearerRedirectGuard(), delegateQueue: nil)

    var base: URL? { URL(string: credentials.serverURL) }

    /// ログイン情報を確かめる。アプリを開いて直してもらう。
    func validate(now: Date = Date()) throws {
        guard base != nil else { throw Failure.notSignedIn }
        if let expires = credentials.cookieExpiresAt, expires <= now { throw Failure.expired }
    }

    private func request(_ path: String, method: String, body: Data? = nil) throws -> URLRequest {
        guard let base, let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw Failure.notSignedIn }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 60
        if let token = credentials.sessionToken { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let cookie = credentials.cookieHeader { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw Failure.network }
        guard let http = response as? HTTPURLResponse else { throw Failure.network }
        // Cloudflare Accessのログイン画面へ飛ばされた（クッキー切れ）なら、別のホストが応答する。
        if http.url?.host != request.url?.host || http.statusCode == 401 || http.statusCode == 403 { throw Failure.expired }
        guard (200..<300).contains(http.statusCode) else { throw Failure.http(http.statusCode) }
        return data
    }

    /// AIを使う送信は、アプリがこの端末の購読確認で書いた期限が今より先の時だけ（a540: サーバーは課金を判断しない）。
    func requireAccess(now: Date = Date()) throws {
        guard let until = credentials.paidUntil, until > now else { throw Failure.subscription }
    }

    func destinations() async throws -> [Destination] {
        struct Named: Decodable { let id: String; let name: String?; let displayName: String?; let deleting: Bool? }
        struct Bots: Decodable { let bots: [Named] }
        struct Rooms: Decodable { let rooms: [Named] }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let bots = try decoder.decode(Bots.self, from: try await send(try request("/api/bots?avatar=omit", method: "GET")))
        let rooms = try decoder.decode(Rooms.self, from: try await send(try request("/api/rooms?avatar=omit", method: "GET")))
        return bots.bots.filter { $0.deleting != true }.map { Destination(kind: .bot, id: $0.id, name: $0.displayName ?? $0.name ?? $0.id) }
            + rooms.rooms.map { Destination(kind: .room, id: $0.id, name: $0.name ?? $0.id) }
    }

    /// POST本文。`share`には内容、`message`にはコメント。画像は元のバイト列をbase64で（既存の`images`と同じ形）。
    static func body(comment: String, content: SharedContent) throws -> Data {
        var share: [String: Any] = [:]
        if !content.text.isEmpty { share["text"] = content.text }
        if !content.urls.isEmpty { share["urls"] = content.urls }
        let object: [String: Any] = [
            "message": comment,
            "share": share,
            "images": content.images.map { ["mime": $0.mime, "data": $0.data.base64EncodedString()] },
        ]
        return try JSONSerialization.data(withJSONObject: object)
    }

    func post(to destination: Destination, comment: String, content: SharedContent) async throws {
        _ = try await send(try request(destination.path + "/messages", method: "POST", body: Self.body(comment: comment, content: content)))
    }

    static func words(_ failure: Error) -> String {
        switch failure as? Failure {
        case .notSignedIn?: return String(localized: "BellTeamのアプリを開いて、接続先を設定してください。")
        case .expired?: return String(localized: "ログインの期限が切れています。BellTeamのアプリを開いて、ログインし直してください。")
        case .subscription?: return String(localized: "AIを使う送信には購読が必要です。BellTeamのアプリで購読を確認してください。")
        case .http(let status)?: return status == 400 ? String(localized: "送れませんでした。内容を確かめてください。") : String(localized: "送れませんでした（\(status)）。少し待って、もう一度お試しください。")
        case .network?, nil: return String(localized: "BellTeamにつながりません。ネットワークを確かめて、もう一度お試しください。")
        }
    }
}
