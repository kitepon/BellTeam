import XCTest
@testable import BellBot

final class BellDiagnosticsTests: XCTestCase {
    func testSameOfflineErrorKeepsMajorImpactVisibleWithoutAssigningAppDefect() {
        var logs: [String] = []
        let diagnostics = BellDiagnostics { _, _, _, log in logs.append(log) }
        let error = URLError(.notConnectedToInternet)
        diagnostics.report(error, path: "/api/session", method: "GET", observation: .startup)
        diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        XCTAssertEqual(logs.count, 2)
        XCTAssertTrue(logs[0].contains("severity=high"))
        XCTAssertTrue(logs[0].contains("user_impact=app_unavailable"))
        XCTAssertTrue(logs[1].contains("severity=warn"))
        XCTAssertTrue(logs[1].contains("app_handling=error_shown_data_retained"))
        XCTAssertTrue(logs.allSatisfy { $0.contains("cause_assessment=unconfirmed") && $0.contains("app_defect=not_established") })
    }

    func testReadFailureIsNotNoImpactOnlyBecauseItPreservesData() {
        var log = ""
        let diagnostics = BellDiagnostics { _, _, _, value in log = value }
        diagnostics.report(URLError(.timedOut), path: "/api/schedules", method: "GET", observation: .read(URLError(.timedOut), retainedData: true))
        XCTAssertTrue(log.contains("severity=warn"))
        XCTAssertFalse(log.contains("user_impact=none"))
    }

    func testExpectedCancellationDoesNotBecomeRepairRequest() {
        var count = 0
        let diagnostics = BellDiagnostics { _, _, _, _ in count += 1 }
        diagnostics.report(CancellationError(), path: "/api/schedules", method: "GET", observation: .read(CancellationError(), retainedData: false))
        diagnostics.reportPush(CancellationError(), stage: "register_device")
        XCTAssertEqual(count, 0)
    }

    func testNetworkLogExcludesURLAndErrorText() {
        let error = URLError(.timedOut, userInfo: [
            NSLocalizedDescriptionKey: "https://example.invalid/private?token=secret"
        ])
        let log = BellDiagnostics.errorLog(error, module: "conversation")
        XCTAssertEqual(log, "module=conversation\nerror_domain=NSURLErrorDomain\nerror_code=-1001")
        XCTAssertFalse(log.contains("secret"))
    }

    func testServerErrorLogExcludesResponseText() {
        let log = BellDiagnostics.errorLog(
            BellAPIError.httpStatus(503, "private response"), module: "queue")
        XCTAssertEqual(log, "module=queue\nhttp_status=503")
    }
}

final class EventStreamTests: XCTestCase {
    private func parse(_ text: String) throws -> [String?] {
        var parser = SSEParser()
        var types: [String?] = []
        for byte in text.utf8 { if let payload = try parser.feed(byte) { types.append(payload["type"] as? String) } }
        return types
    }

    func testKeepaliveCommentsAreSkipped() throws {
        let stream = ": keepalive\n\nevent: ready\ndata: {}\n\n: keepalive\n\n: keepalive\n\nevent: x\ndata: {\"type\":\"settings\"}\n\n"
        XCTAssertEqual(try parse(stream), [nil, "settings"])
    }

    func testCRLFAndSplitDataLines() throws {
        XCTAssertEqual(try parse(": keepalive\r\n\r\ndata: {\"type\":\r\ndata: \"setup\"}\r\n\r\n"), ["setup"])
    }

    func testDeviceStateIsNotReportedAsFailure() {
        XCTAssertTrue(BellDiagnostics.isDeviceState(URLError(.notConnectedToInternet)))
        XCTAssertFalse(BellDiagnostics.isDeviceState(URLError(.networkConnectionLost)))
        XCTAssertFalse(BellDiagnostics.isDeviceState(URLError(.timedOut)))
    }
}

final class ConnectionResetTests: XCTestCase {
    func testResetConnectionsKeepsAccessCookie() async throws {
        let url = URL(string: "https://team.example.invalid")!
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "team.example.invalid", .path: "/", .name: "CF_Authorization", .value: "test", .secure: "TRUE"
        ]))
        HTTPCookieStorage.shared.setCookie(cookie)
        defer { HTTPCookieStorage.shared.deleteCookie(cookie) }
        await BellAPI(baseURL: url).resetConnections()
        XCTAssertEqual(HTTPCookieStorage.shared.cookies(for: url)?.map(\.name), ["CF_Authorization"])
    }
}
