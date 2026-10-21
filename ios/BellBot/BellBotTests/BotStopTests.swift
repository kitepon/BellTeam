import Foundation
import XCTest
@testable import BellBot

@MainActor
final class BotStopTests: XCTestCase {
    func testOnlyMatching200ConfirmsTheStop() async throws {
        let (api, session) = makeAPI()
        defer { session.invalidateAndCancel() }

        try await api.stopBot("bot-confirmed")
        for id in ["bot-wrong-id", "bot-wrong-status", "bot-still-online", "bot-accepted", "bot-malformed"] {
            do {
                try await api.stopBot(id)
                XCTFail("一致しない停止応答を完了扱いしてはいけません: \(id)")
            } catch {
                XCTAssertTrue(BellAPIError.operationResultUnconfirmed(error), id)
            }
        }
        XCTAssertEqual(BotStopProtocol.requestCount(for: "bot-confirmed"), 1)
        XCTAssertTrue(BotStopProtocol.allRequestsHadNoBody)
    }

    func testUnconfirmedResultsAreNotRetried() async throws {
        let (api, session) = makeAPI()
        defer { session.invalidateAndCancel() }

        for id in ["bot-server-error", "bot-lost-response"] {
            do {
                try await api.stopBot(id)
                XCTFail("結果を確認できない要求を完了扱いしてはいけません: \(id)")
            } catch {
                XCTAssertTrue(BellAPIError.operationResultUnconfirmed(error), id)
            }
            XCTAssertEqual(BotStopProtocol.requestCount(for: id), 1)
        }

        do {
            try await api.stopBot("bot-missing")
            XCTFail("存在しないメンバーを停止済みにしてはいけません")
        } catch BellAPIError.httpStatus(404, _, _) {
            XCTAssertEqual(BotStopProtocol.requestCount(for: "bot-missing"), 1)
        } catch {
            XCTFail("期待しないエラー: \(error)")
        }
    }

    private func makeAPI() -> (BellAPI, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BotStopProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: URL(string: "https://bot-stop.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }),
                          cookieStorage: configuration.httpCookieStorage!)
        return (api, session)
    }
}

private final class BotStopProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var counts: [String: Int] = [:]
    private static var requestsWithoutBody = true

    static func requestCount(for id: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return counts[id, default: 0]
    }

    static var allRequestsHadNoBody: Bool {
        lock.lock()
        defer { lock.unlock() }
        return requestsWithoutBody
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "bot-stop.test.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let id = request.url!.path.split(separator: "/")[2].description
        Self.lock.lock()
        Self.counts[id, default: 0] += 1
        Self.requestsWithoutBody = Self.requestsWithoutBody && request.httpMethod == "POST"
            && request.httpBody == nil && request.httpBodyStream == nil
        Self.lock.unlock()

        if id == "bot-lost-response" {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let status: Int
        let body: String
        switch id {
        case "bot-accepted":
            status = 202
            body = #"{"botId":"bot-accepted","status":"stopped","online":false}"#
        case "bot-server-error":
            status = 502
            body = #"{"error":"BOT_STOP_UNCONFIRMED"}"#
        case "bot-missing":
            status = 404
            body = #"{"error":"BOT_NOT_FOUND"}"#
        case "bot-wrong-id":
            status = 200
            body = #"{"botId":"bot-other","status":"stopped","online":false}"#
        case "bot-wrong-status":
            status = 200
            body = #"{"botId":"bot-wrong-status","status":"pending","online":false}"#
        case "bot-still-online":
            status = 200
            body = #"{"botId":"bot-still-online","status":"stopped","online":true}"#
        case "bot-malformed":
            status = 200
            body = #"{"botId":"bot-malformed","status":"stopped"}"#
        default:
            status = 200
            body = #"{"botId":"bot-confirmed","status":"stopped","online":false}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
