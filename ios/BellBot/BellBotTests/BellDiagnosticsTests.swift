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

    func testRequestRouteKeepsOnlyGeneratedOpaqueMemberIds() {
        XCTAssertEqual(BellRequestTrace.route(for: "/api/bots/bot-deadbeef/schedules"),
                       "/api/bots/bot-deadbeef/schedules")
        XCTAssertEqual(BellRequestTrace.route(for: "/api/rooms/room-1234abcd/messages"),
                       "/api/rooms/room-1234abcd/messages")
        XCTAssertEqual(BellRequestTrace.route(for: "/api/bots/private-name/messages"),
                       "/api/bots/:id/messages")
    }

    func testRequestContextSeparatesContractFromObservedFailure() {
        var logs: [String] = []
        let diagnostics = BellDiagnostics { _, _, _, log in logs.append(log) }
        let trace = BellRequestTrace(route: "/api/bots/bot-deadbeef/messages", method: "POST",
            startedAt: Date(), failedAt: Date(), appStateAtStart: "active", attempts: 1, metrics: nil)
        diagnostics.report(BellAPIError.httpStatus(500, "private response", trace),
            path: "/api/bots/private-name/messages?token=secret", method: "POST", observation: .write)
        let log = logs[0]
        XCTAssertTrue(log.contains("scope=app_request\noperation=message_send\ntrigger=unknown"))
        XCTAssertTrue(log.contains("expected_result=send_result_returned\nactual_result=http_500"))
        XCTAssertTrue(log.contains("expectation_basis=code_contract\nresult_basis=request_observation"))
        XCTAssertTrue(log.contains("handling_basis=code_classification\nscreen_observation=not_observed"))
        XCTAssertFalse(log.contains("private response"))
        XCTAssertFalse(log.contains("private-name"))
        XCTAssertFalse(log.contains("secret"))
    }

    func testRequestContextDoesNotInferOperationFromFallbackPath() {
        var log = ""
        let diagnostics = BellDiagnostics { _, _, _, value in log = value }
        diagnostics.report(URLError(.timedOut), path: "/api/bots", method: "GET",
            observation: .read(URLError(.timedOut), retainedData: true))
        XCTAssertTrue(log.contains("scope=app_operation"))
        XCTAssertTrue(log.contains("operation=unknown\ntrigger=unknown"))
        XCTAssertTrue(log.contains("expected_result=successful_response\nactual_result=network_timeout"))
        XCTAssertTrue(log.contains("result_basis=request_observation"))
    }

    func testScheduleTimeoutUsesTracedRequestWithoutClaimingScreenObservation() {
        var log = ""
        let diagnostics = BellDiagnostics { _, _, _, value in log = value }
        let trace = BellRequestTrace(route: "/api/bots/bot-deadbeef/schedules", method: "GET",
            startedAt: Date(), failedAt: Date(), appStateAtStart: "active", attempts: 1, metrics: nil)
        let error = URLError(.timedOut, userInfo: [BellRequestTrace.userInfoKey: trace])
        diagnostics.report(error, path: "/api/schedules", method: "GET",
            observation: .read(error, retainedData: true))
        XCTAssertTrue(log.contains("operation=schedule_read\ntrigger=unknown"))
        XCTAssertTrue(log.contains("expected_result=schedule_entries_loaded\nactual_result=network_timeout"))
        XCTAssertTrue(log.contains("screen_observation=not_observed"))
        XCTAssertTrue(log.contains("request_route=/api/bots/bot-deadbeef/schedules"))
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

    func testEventNameDistinguishesReadyFromMessageUpdate() throws {
        var parser = SSEParser()
        var names: [String?] = []
        let stream = "event: ready\ndata: {}\n\nevent: messages\ndata: {\"at\":\"2026-10-22T00:00:00Z\"}\n\n"
        for byte in stream.utf8 {
            if try parser.feed(byte) != nil { names.append(parser.lastEventName) }
        }
        XCTAssertEqual(names, ["ready", "messages"])
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
