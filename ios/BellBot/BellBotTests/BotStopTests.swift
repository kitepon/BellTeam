import Foundation
import XCTest
@testable import BellBot

@MainActor
final class BotStopTests: XCTestCase {
    func testOnlyMatching202ReportsSentAndMatchingLegacy200ConfirmsInterruption() async throws {
        let (api, session) = makeAPI()
        defer { session.invalidateAndCancel() }

        let sent = try await api.stopBot("bot-sent")
        XCTAssertEqual(sent, .sent)
        let confirmed = try await api.stopBot("bot-confirmed")
        XCTAssertEqual(confirmed, .confirmed)
        let stillOnline = try await api.stopBot("bot-still-online")
        XCTAssertEqual(stillOnline, .confirmed)
        for id in ["bot-wrong-id", "bot-wrong-status", "bot-session-closed", "bot-mismatched-202", "bot-mismatched-200", "bot-malformed"] {
            do {
                _ = try await api.stopBot(id)
                XCTFail("一致しない停止応答を完了扱いしてはいけません: \(id)")
            } catch {
                XCTAssertTrue(BellAPIError.operationResultUnconfirmed(error), id)
            }
        }
        XCTAssertEqual(BotStopProtocol.requestCount(for: "bot-sent"), 1)
        XCTAssertEqual(BotStopProtocol.requestCount(for: "bot-confirmed"), 1)
        XCTAssertEqual(BotStopProtocol.requestCount(for: "bot-still-online"), 1)
        XCTAssertTrue(BotStopProtocol.allRequestsHadNoBody)
    }

    func testUnconfirmedResultsAreNotRetried() async throws {
        let (api, session) = makeAPI()
        defer { session.invalidateAndCancel() }

        for id in ["bot-server-error", "bot-lost-response"] {
            do {
                _ = try await api.stopBot(id)
                XCTFail("結果を確認できない要求を完了扱いしてはいけません: \(id)")
            } catch {
                XCTAssertTrue(BellAPIError.operationResultUnconfirmed(error), id)
            }
            XCTAssertEqual(BotStopProtocol.requestCount(for: id), 1)
        }

        do {
            _ = try await api.stopBot("bot-missing")
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
        case "bot-sent":
            status = 202
            body = #"{"botId":"bot-sent","status":"stop_sent"}"#
        case "bot-server-error":
            status = 502
            body = #"{"error":"BOT_STOP_UNCONFIRMED"}"#
        case "bot-missing":
            status = 404
            body = #"{"error":"BOT_NOT_FOUND"}"#
        case "bot-wrong-id":
            status = 202
            body = #"{"botId":"bot-other","status":"stop_sent"}"#
        case "bot-wrong-status":
            status = 202
            body = #"{"botId":"bot-wrong-status","status":"stopped"}"#
        case "bot-session-closed":
            status = 200
            body = #"{"botId":"bot-session-closed","status":"interrupted","sessionPreserved":false}"#
        case "bot-mismatched-202":
            status = 202
            body = #"{"botId":"bot-mismatched-202","status":"interrupted","sessionPreserved":true}"#
        case "bot-mismatched-200":
            status = 200
            body = #"{"botId":"bot-mismatched-200","status":"stop_sent"}"#
        case "bot-still-online":
            status = 200
            body = #"{"botId":"bot-still-online","status":"interrupted","sessionPreserved":true,"online":true}"#
        case "bot-malformed":
            status = 200
            body = #"{"botId":"bot-malformed","status":"interrupted"}"#
        default:
            status = 200
            body = #"{"botId":"bot-confirmed","status":"interrupted","sessionPreserved":true}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
