import Foundation
import XCTest
@testable import BellBot

@MainActor
final class MemberActivityTests: XCTestCase {
    func testConversationQueueShowsOneRowPerBotAndStatus() throws {
        let response = try JSONDecoder().decode(QueueResponse.self, from: Data("""
        {"items":[
          {"id":"first","botId":"bot-one","status":"running"},
          {"id":"steered","botId":"bot-one","status":"running"},
          {"id":"waiting","botId":"bot-one","status":"queued"},
          {"id":"other","botId":"bot-two","status":"running"},
          {"id":"legacy-one","status":"running"},
          {"id":"legacy-two","status":"running"}
        ]}
        """.utf8))

        XCTAssertEqual(QueueItem.displayItems(response.items).map(\.id),
                       ["first", "waiting", "other", "legacy-one", "legacy-two"])
        XCTAssertEqual(response.items.count, 6, "配送項目そのものは変更しない")
    }

    func testMemberRowShowsCurrentWorkInsteadOfRecentMessage() throws {
        let work = """
        {"state":"working","summary":"Update画面を直している","summaryStatus":"current","summaryUpdatedAt":"2026-11-05T00:00:00Z","observedAt":"2026-11-05T00:00:01Z","source":"self_reported"}
        """
        let bot = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"bot-one","name":"ユキ","displayName":"ユキ","harness":"codex","model":"","reasoningEffort":"","fastMode":false,
         "color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":true,
         "recent":{"id":"m1","at":"2026-11-05T00:00:00Z","message":"[BellTeam schedule 80284] 予定の本文"},"currentWork":\(work)}
        """.utf8))
        XCTAssertEqual(CurrentWork.label(bot.currentWork), "Update画面を直している")

        let labels = try [
            #"{"state":"working","summary":null,"summaryStatus":"stale","summaryUpdatedAt":"2026-11-05T00:00:00Z","observedAt":"2026-11-05T00:10:01Z","source":"self_reported"}"#,
            #"{"state":"working","summary":null,"summaryStatus":"missing","summaryUpdatedAt":null,"observedAt":"2026-11-05T00:00:01Z","source":null}"#,
            #"{"state":"idle","summary":null,"summaryStatus":"missing","summaryUpdatedAt":null,"observedAt":"2026-11-05T00:00:01Z","source":null}"#,
            #"{"state":"unknown","summary":null,"summaryStatus":"missing","summaryUpdatedAt":null,"observedAt":null,"source":null}"#,
        ].map { CurrentWork.label(try JSONDecoder().decode(CurrentWork.self, from: Data($0.utf8))) }
        XCTAssertEqual(labels, ["作業中・要約期限切れ", "作業中・要約未設定", "待機中", "仕事状況を未取得"])
        XCTAssertEqual(CurrentWork.label(nil), "仕事状況を未取得", "currentWorkを返さない旧サーバー")
    }

    func testListsWithoutInlineAvatarStillDecode() throws {
        let bots = try JSONDecoder().decode(BotsResponse.self, from: Data("""
        {"bots":[{"id":"bot-one","name":"ユキ","displayName":"ユキ","harness":"codex","model":"","reasoningEffort":"","fastMode":false,
         "color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatarVersion":"v1",
         "avatarLargeVersion":"v2","avatarSourceVersion":"v3","avatarLargeSourceVersion":"v4","online":true,"recent":null}]}
        """.utf8))
        XCTAssertEqual(bots.bots.first?.avatar, "")
        XCTAssertEqual(bots.bots.first?.avatarVersion, "v1")
        let room = try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"room-one","name":"部屋","purpose":"","representativeId":null,"memberIds":["bot-one"],"avatarVersion":"r1","recent":null}
        """.utf8))
        XCTAssertEqual(room.avatar, "")
        let owner = try JSONDecoder().decode(Owner.self, from: Data("""
        {"name":"クオ","profile":"","avatarVersion":"o1","xUrl":"","githubUrl":"","links":[]}
        """.utf8))
        XCTAssertEqual(owner.avatar, "")
    }

    func testSteeredDeliveryJoinsTheRunningTurnInsteadOfAddingARow() throws {
        let response = try JSONDecoder().decode(QueueResponse.self, from: Data("""
        {"items":[
          {"id":"turn","botId":"bot-one","status":"running","steered":false},
          {"id":"steer-1","botId":"bot-one","status":"queued","steered":true},
          {"id":"steer-2","botId":"bot-one","status":"running","steered":true},
          {"id":"next","botId":"bot-two","status":"queued","steered":false},
          {"id":"old-server","botId":"bot-three","status":"queued"}
        ]}
        """.utf8))
        XCTAssertEqual(QueueItem.displayItems(response.items).map(\.id), ["turn", "next", "old-server"],
                       "差し込みは実行中ターンの1行にまとめ、steeredの無い旧形式は従来どおり")
    }

    func testStoppedDeliveryIsDistinctAndAnotherRunningMemberRemainsVisible() throws {
        let messages = try JSONDecoder().decode([TimelineMessage].self, from: Data("""
        [
          {"id":"direct","at":"2026-10-21T00:00:00Z","direction":"outgoing","delivery":"stopped"},
          {"id":"room-stopped","at":"2026-10-21T00:00:00Z","direction":"outgoing",
           "deliveries":[{"target":"bot-one","delivery":"stopped"},{"target":"bot-two","delivery":"delivered"}]},
          {"id":"room-running","at":"2026-10-21T00:00:00Z","direction":"outgoing",
           "deliveries":[{"target":"bot-one","delivery":"stopped"},{"target":"bot-two","delivery":"running"}]}
        ]
        """.utf8))
        XCTAssertEqual(messages.map(\.status), ["stopped", "stopped", "running"])
    }

    func testWorkingComesFromCurrentWorkNotFromQueue() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemberActivityProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let api = BellAPI(baseURL: URL(string: "https://member-activity.test.invalid")!, session: session)
        let store = AppStore(api: api)
        // A turn started by a schedule or after_turn has no running delivery but is working (a51).
        MemberActivityProtocol.bots = """
        {"bots":[
          \(member("bot-one", work: #"{"state":"working","summary":null,"summaryStatus":"missing"}"#)),
          \(member("bot-two", work: #"{"state":"idle","summary":null,"summaryStatus":"missing"}"#)),
          \(member("bot-three", work: nil))
        ]}
        """
        try await store.refresh()
        XCTAssertEqual(store.bots.filter(\.isWorking).map(\.id), ["bot-one"])

        MemberActivityProtocol.bots = "{\"bots\":[\(member("bot-one", work: #"{"state":"idle","summary":null,"summaryStatus":"missing"}"#))]}"
        try await store.refresh()
        XCTAssertFalse(store.bots.contains(where: \.isWorking))
    }

    private func member(_ id: String, work: String?) -> String {
        #"{"id":"\#(id)","name":"\#(id)","displayName":"\#(id)","harness":"claude","model":"","reasoningEffort":"","fastMode":false,"color":"indigo","profileText":"","personality":"","speechStyle":"","position":"","role":"","online":true"#
            + (work.map { #","currentWork":\#($0)"# } ?? "") + "}"
    }
}

private final class MemberActivityProtocol: URLProtocol {
    static var bots = "{\"bots\":[]}"
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "member-activity.test.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body: String
        switch request.url!.path {
        case "/api/bots": body = Self.bots
        case "/api/rooms": body = "{\"rooms\":[]}"
        case "/api/owner":
            body = "{\"owner\":{\"name\":\"試験\",\"profile\":\"\",\"avatar\":\"\",\"xUrl\":\"\",\"githubUrl\":\"\",\"links\":[]}}"
        default: fatalError("未定義の試験API: \(request.url!.path)")
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client!.urlProtocol(self, didLoad: Data(body.utf8))
        client!.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
