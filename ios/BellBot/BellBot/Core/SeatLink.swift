import Foundation

/// 「AIの許可待ちを決裁箱へ送る」 (seat-approval-card.md, the pairing view). Drawn only from the body's three routes GET /api/approvals/seat-link, POST …/start, POST …/stop; the same view and words on every client. Never a token, never a path to Approval Box.
struct SeatLink: Decodable, Equatable {
    /// none | waiting | linked | removed | failed, plus the client's own: unavailable (the route could not say) and absent (the body has no such route, 404: nothing is drawn).
    var state: String
    var code: String?
    var typedSecret: String?
    var qrText: String?
    var expiresAt: Date?
    /// failed: rejected | expired | other.
    var reason: String?

    static let absent = SeatLink(state: "absent")
    static let unavailable = SeatLink(state: "unavailable")
    var waiting: Bool { state == "waiting" && !(qrText ?? "").isEmpty }

    init(state: String, code: String? = nil, typedSecret: String? = nil, qrText: String? = nil, expiresAt: Date? = nil, reason: String? = nil) {
        self.state = state; self.code = code; self.typedSecret = typedSecret; self.qrText = qrText; self.expiresAt = expiresAt; self.reason = reason
    }

    private enum Keys: String, CodingKey { case state, code, typedSecret, qrText, expiresAt, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = try c.decode(String.self, forKey: .state)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        typedSecret = try c.decodeIfPresent(String.self, forKey: .typedSecret)
        qrText = try c.decodeIfPresent(String.self, forKey: .qrText)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt).flatMap(Self.date)
    }

    private static func date(_ text: String) -> Date? {
        let fraction = ISO8601DateFormatter(); fraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// The contract's table, word for word (the same on every client).
enum SeatLinkWords {
    static let title = "AIの許可待ちを決裁箱へ送る"
    static let none = "AIが許可を待って止まった時、決裁箱のアプリに届きます。つなぐのは1回だけです。"
    static let steps = "決裁箱のアプリで、接続 → 「AIをつなぐ」 → 「QRコードを読む」を開き、このQRコードを読んで、許可してください。"
    static let linked = "つながっています。AIが許可待ちで止まると、決裁箱に届きます。"
    static let removed = "決裁箱でつなぎが外されています。もう一度つないでください。"
    static let rejected = "決裁箱のアプリで「心当たりがない」が押されました。"
    static let expired = "許可の待ち時間が過ぎました。もう一度つないでください。"
    static let unavailable = "いまはつなげません。少し待って、もう一度押してください。"
    static let connect = "つなぐ"
    static let again = "もう一度つなぐ"
    static let cancel = "やめる"
    static let badgeLinked = "つながっています"
    static let badgeRemoved = "つなぎが外れています"
    static let badgeFailed = "つなげませんでした"

    static func until(_ date: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Tokyo"); f.dateFormat = "HH:mm"
        return f.string(from: date) + "まで（JST）"
    }

    static func line(_ link: SeatLink) -> String {
        switch link.state {
        case "none": none
        case "waiting": steps
        case "linked": linked
        case "removed": removed
        case "failed": link.reason == "rejected" ? rejected : link.reason == "expired" ? expired : unavailable
        default: unavailable
        }
    }
}

/// The three calls. A body without the routes (404) is absent: the section is not drawn. Anything else the route cannot say (503, 403, a failed read) is unavailable: a plain line and the one button.
@MainActor
final class SeatLinkModel: ObservableObject {
    @Published private(set) var link: SeatLink?
    private let api: BellAPI?
    private static let path = "/api/approvals/seat-link"

    init(api: BellAPI?) { self.api = api }

    #if DEBUG
    /// 画面確認用: 決まった状態を置く。本体へは触れない。
    init(preview: SeatLink) { api = nil; link = preview }
    #endif

    func read() async { await run { try await $0.get(Self.path) } }
    func start() async { await run { try await $0.post(Self.path + "/start", body: EmptyBody()) } }
    func stop() async { await run { try await $0.post(Self.path + "/stop", body: EmptyBody()) } }

    private func run(_ call: (BellAPI) async throws -> SeatLink) async {
        guard let api else { return }
        do { link = try await call(api) }
        catch is CancellationError { }
        catch BellAPIError.httpStatus(404, _, _) { link = .absent }
        catch { if !Task.isCancelled { link = .unavailable } }
    }
}
