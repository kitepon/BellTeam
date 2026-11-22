import Foundation
import XCTest
@testable import BellBot

final class ShareClientTests: XCTestCase {
    private final class Stub: URLProtocol {
        static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            let (response, data) = Stub.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private func client(cookie: String? = "CF_Authorization=abc", expires: Date? = nil) -> ShareClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Stub.self]
        return ShareClient(credentials: .init(serverURL: "https://bell.example", cookieHeader: cookie, cookieExpiresAt: expires),
                           session: URLSession(configuration: configuration))
    }

    private func respond(_ status: Int, _ json: String, host: String = "bell.example") {
        Stub.handler = { request in
            (HTTPURLResponse(url: URL(string: "https://\(host)\(request.url!.path)")!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
    }

    func testBodyCarriesShareTextUrlsAndOriginalImageBytes() throws {
        let content = SharedContent(text: "文章", urls: ["https://e.com/a"], images: [SharedImage(data: Data([1, 2, 3]), mime: "image/png")], refusal: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: ShareClient.body(comment: "これお願い", content: content)) as? [String: Any])
        XCTAssertEqual(object["message"] as? String, "これお願い")
        let share = try XCTUnwrap(object["share"] as? [String: Any])
        XCTAssertEqual(share["text"] as? String, "文章")
        XCTAssertEqual(share["urls"] as? [String], ["https://e.com/a"])
        XCTAssertNil(share["app"])
        let images = try XCTUnwrap(object["images"] as? [[String: Any]])
        XCTAssertEqual(images.first?["mime"] as? String, "image/png")
        XCTAssertEqual(images.first?["data"] as? String, Data([1, 2, 3]).base64EncodedString())
    }

    func testBodyOmitsEmptyShareFields() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: ShareClient.body(comment: "", content: SharedContent(text: "", urls: ["https://e.com"], images: [], refusal: nil))) as? [String: Any])
        XCTAssertNil((object["share"] as? [String: Any])?["text"])
        XCTAssertEqual((object["images"] as? [Any])?.count, 0)
    }

    func testValidateStopsOnAnExpiredCookieAndNeverLogsIn() {
        XCTAssertThrowsError(try client(expires: Date(timeIntervalSinceNow: -10)).validate()) { XCTAssertEqual($0 as? ShareClient.Failure, .expired) }
        XCTAssertNoThrow(try client(expires: Date(timeIntervalSinceNow: 3600)).validate())
        XCTAssertNoThrow(try client(cookie: nil).validate())
    }

    /// B2: only the server's own word opens the share (developer mode or entitlementState active); no date kept on the device.
    func testAccessNeedsDeveloperModeOrTheServersActiveWord() async throws {
        respond(200, #"{"subscription":{"accessMode":"developer"}}"#)
        try await client().requireAccess()
        respond(200, #"{"subscription":{"accessMode":"subscription","entitlementState":"active"}}"#)
        try await client().requireAccess()
        for state in [#""none""#, #""unknown""#, "null"] {
            respond(200, #"{"subscription":{"accessMode":"subscription","entitlementState":"# + state + "}}")
            do { try await client().requireAccess(); XCTFail("the server did not say active") } catch { XCTAssertEqual(error as? ShareClient.Failure, .subscription) }
        }
    }

    func testADifferentHostAnswerMeansTheLoginExpired() async {
        respond(200, "{}", host: "team.cloudflareaccess.com")
        do { _ = try await client().destinations(); XCTFail("redirected") } catch { XCTAssertEqual(error as? ShareClient.Failure, .expired) }
        respond(403, "{}")
        do { _ = try await client().destinations(); XCTFail("403") } catch { XCTAssertEqual(error as? ShareClient.Failure, .expired) }
    }

    func testDestinationsListBotsThenRoomsAndSkipDeleting() async throws {
        Stub.handler = { request in
            let json = request.url!.path == "/api/bots"
                ? #"{"bots":[{"id":"b1","name":"ユキ","displayName":"ユキ"},{"id":"b2","name":"X","deleting":true}]}"#
                : #"{"rooms":[{"id":"r1","name":"計画室"}]}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
        }
        let list = try await client().destinations()
        XCTAssertEqual(list.map(\.id), ["b1", "r1"])
        XCTAssertEqual(list.map(\.path), ["/api/bots/b1", "/api/rooms/r1"])
    }

    func testFailureWordsAreAPlainSentence() {
        XCTAssertTrue(ShareClient.words(ShareClient.Failure.expired).contains("ログインし直して"))
        XCTAssertTrue(ShareClient.words(ShareClient.Failure.subscription).contains("購読"))
        XCTAssertTrue(ShareClient.words(ShareClient.Failure.http(400)).contains("内容を確かめて"))
        XCTAssertTrue(ShareClient.words(ShareClient.Failure.network).contains("つながりません"))
    }
}
