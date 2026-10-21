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

    func testRunningWorkUsesBotIdentityAndUpdatesWhenWorkEnds() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemberActivityProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let api = BellAPI(baseURL: URL(string: "https://member-activity.test.invalid")!, session: session)
        let store = AppStore(api: api)
        MemberActivityProtocol.queue = """
        {"items":[
          {"id":"work-1","botId":"bot-one","status":"running"},
          {"id":"work-2","botId":"bot-one","status":"running"},
          {"id":"work-3","botId":"bot-two","status":"queued"},
          {"id":"legacy","status":"running"}
        ]}
        """
        try await store.refresh()
        XCTAssertEqual(store.workingBotIDs, ["bot-one"])

        MemberActivityProtocol.queue = "{\"items\":[]}"
        try await store.refresh()
        XCTAssertTrue(store.workingBotIDs.isEmpty)
    }
}

private final class MemberActivityProtocol: URLProtocol {
    static var queue = "{\"items\":[]}"
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "member-activity.test.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body: String
        switch request.url!.path {
        case "/api/bots": body = "{\"bots\":[]}"
        case "/api/rooms": body = "{\"rooms\":[]}"
        case "/api/queue": body = Self.queue
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
