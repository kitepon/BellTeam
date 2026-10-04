import Foundation
import XCTest
@testable import BellBot

@MainActor
final class MemberActivityTests: XCTestCase {
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
