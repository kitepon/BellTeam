import XCTest
@testable import BellBot

final class BellDiagnosticsTests: XCTestCase {
    func testAppStateRevisionChangesOnlyWhenScenePhaseChanges() {
        let diagnostics = BellDiagnostics { _, _, _, _ in }
        let initial = diagnostics.requestAppStateSnapshot()
        diagnostics.updateAppState("active")
        let active = diagnostics.requestAppStateSnapshot()
        diagnostics.updateAppState("active")
        let repeated = diagnostics.requestAppStateSnapshot()
        diagnostics.updateAppState("background")
        let background = diagnostics.requestAppStateSnapshot()
        XCTAssertEqual(active.revision, initial.revision + 1)
        XCTAssertEqual(repeated.revision, active.revision)
        XCTAssertEqual(background.revision, active.revision + 1)
        XCTAssertEqual(background.state, "background")
    }

    func testGoalTimeoutCarriesCallsiteWithoutPrivateRoute() {
        var log = ""
        let diagnostics = BellDiagnostics { _, _, _, value in log = value }
        let trace = BellRequestTrace(route: "/api/bots/bot-deadbeef/goal", method: "GET",
                                     startedAt: Date(), failedAt: Date(),
                                     appStateAtStart: "background", attempts: 1, metrics: nil)
        let error = URLError(.timedOut, userInfo: [BellRequestTrace.userInfoKey: trace])
        diagnostics.report(error, path: "/api/bots/private-name/goal?token=secret", method: "GET",
                           observation: .read(error, retainedData: true),
                           diagnosticContext: "goal_load_trigger=chat_view_task\ngoal_view_phase_at_call=background")
        XCTAssertTrue(log.contains("goal_load_trigger=chat_view_task"))
        XCTAssertTrue(log.contains("goal_view_phase_at_call=background"))
        XCTAssertFalse(log.contains("private-name"))
        XCTAssertFalse(log.contains("secret"))
        let attachment = XCTAttachment(data: Data(log.utf8), uniformTypeIdentifier: "public.plain-text")
        attachment.name = "人工Goal timeoutの呼出し原文"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testServerErrorStoresOnlyThisResponsesDiagnosticReference() async throws {
        let fingerprint = String(repeating: "a", count: 64)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerErrorProtocol.self]
        let api = BellAPI(baseURL: URL(string: "https://server-error.test.invalid")!,
                          session: URLSession(configuration: configuration),
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }))
        func log(_ path: String) async throws -> String {
            do {
                try await api.delete(path)
                XCTFail("500を成功にしない")
                return ""
            } catch {
                return try XCTUnwrap(BellRequestTrace.from(error)).log
            }
        }
        ServerErrorProtocol.headers = [
            "X-BellTeam-Diagnostic-Fingerprint": fingerprint,
            "X-BellTeam-Diagnostic-Occurrence-Count": "7",
            "X-BellTeam-Diagnostic-Received-At": "2026-11-01T01:21:10.123Z",
        ]
        let saved = try await log("/api/bots/first")
        XCTAssertTrue(saved.contains("server_diagnostic_fingerprint=\(fingerprint)\n"))
        XCTAssertTrue(saved.contains("server_diagnostic_occurrence_count=7\n"))
        XCTAssertTrue(saved.contains("server_diagnostic_received_at=2026-11-01T01:21:10.123Z\n"))

        ServerErrorProtocol.headers = [:]
        let missing = try await log("/api/bots/second")
        XCTAssertFalse(missing.contains(fingerprint))
        XCTAssertTrue(missing.contains("server_diagnostic_fingerprint=unknown\nserver_diagnostic_occurrence_count=unknown\nserver_diagnostic_received_at=unknown"))

        ServerErrorProtocol.headers = [
            "X-BellTeam-Diagnostic-Fingerprint": "secret-value",
            "X-BellTeam-Diagnostic-Occurrence-Count": "0",
            "X-BellTeam-Diagnostic-Received-At": "2026-11-01 01:21",
        ]
        let invalid = try await log("/api/bots/third")
        XCTAssertFalse(invalid.contains("secret-value"))
        XCTAssertTrue(invalid.contains("server_diagnostic_fingerprint=unknown\nserver_diagnostic_occurrence_count=unknown\nserver_diagnostic_received_at=unknown"))

        ServerErrorProtocol.status = 502
        let other = try await log("/api/bots/fourth")
        ServerErrorProtocol.status = 500
        XCTAssertFalse(other.contains("server_diagnostic_"))
    }

    func testProtectedRequestFailureStoresDiagnosticReferenceWithoutSecretOrID() async throws {
        let fingerprint = String(repeating: "c", count: 64)
        ServerErrorProtocol.status = 500
        ServerErrorProtocol.headers = [
            "X-BellTeam-Diagnostic-Fingerprint": fingerprint,
            "X-BellTeam-Diagnostic-Occurrence-Count": "5",
            "X-BellTeam-Diagnostic-Received-At": "2026-11-01T11:07:30.419Z",
        ]
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerErrorProtocol.self]
        let api = BellAPI(baseURL: URL(string: "https://server-error.test.invalid")!,
                          session: URLSession(configuration: configuration),
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }))
        do {
            _ = try await api.finishSecretRequest(id: "request-private-id", value: "secret-value")
            XCTFail("500を成功にしない")
        } catch {
            let log = try XCTUnwrap(BellRequestTrace.from(error)).log
            XCTAssertTrue(log.contains("request_route=/api/other\n"))
            XCTAssertTrue(log.contains("request_method=POST\n"))
            XCTAssertTrue(log.contains("server_diagnostic_fingerprint=\(fingerprint)\n"))
            XCTAssertTrue(log.contains("server_diagnostic_occurrence_count=5\n"))
            XCTAssertTrue(log.contains("server_diagnostic_received_at=2026-11-01T11:07:30.419Z\n"))
            XCTAssertFalse(log.contains("request-private-id"))
            XCTAssertFalse(log.contains("secret-value"))
        }
    }

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

    func testServerErrorLogKeepsOnlyFixedServerErrorCodeFromActualResponse() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerErrorProtocol.self]
        let api = BellAPI(baseURL: URL(string: "https://server-error.test.invalid")!,
                          session: URLSession(configuration: configuration),
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }))
        func failure(_ body: String) async throws -> Error {
            ServerErrorProtocol.body = body
            do { try await api.delete("/api/bots/first"); XCTFail("503を成功にしない") } catch { return error }
            return BellAPIError.invalidResponse
        }
        ServerErrorProtocol.status = 503
        defer { ServerErrorProtocol.status = 500; ServerErrorProtocol.body = ServerErrorProtocol.defaultBody }
        let typed = try await failure(#"{"error":"MEMBERS_NOT_ACCEPTED","message":"メンバーの受付を一時停止しています"}"#)
        XCTAssertEqual(typed.localizedDescription, "BellTeam: メンバーの受付を一時停止しています")
        XCTAssertTrue(BellAPIError.operationResultUnconfirmed(typed))
        XCTAssertEqual(BellDiagnostics.errorLog(typed, module: "bots"),
                       "module=bots\nhttp_status=503\nhttp_error_code=MEMBERS_NOT_ACCEPTED")
        let located = try await failure(#"{"error":"BOT_NOT_FOUND: bot-deadbeef","message":"見つかりません"}"#)
        XCTAssertEqual(BellDiagnostics.errorLog(located, module: "bots"), "module=bots\nhttp_status=503")
    }

    func testRequestRouteKeepsOnlyGeneratedOpaqueMemberIds() {
        XCTAssertEqual(BellRequestTrace.route(for: "/api/bots/bot-deadbeef/schedules"),
                       "/api/bots/bot-deadbeef/schedules")
        XCTAssertEqual(BellRequestTrace.route(for: "/api/rooms/room-1234abcd/messages"),
                       "/api/rooms/room-1234abcd/messages")
        XCTAssertEqual(BellRequestTrace.route(for: "/api/bots/private-name/messages"),
                       "/api/bots/:id/messages")
    }

    func testUnknownRequestRouteDoesNotBecomeSettingsFailure() {
        let route = BellRequestTrace.route(for: "/api/unlisted/private-value")
        XCTAssertEqual(route, "/api/other")
        XCTAssertEqual(BellRequestTrace.route(for: "/api/harness-auth/private-value/input"), "/api/other")
        var module = ""
        var log = ""
        let diagnostics = BellDiagnostics { _, value, _, message in module = value; log = message }
        let trace = BellRequestTrace(route: route, method: "GET", startedAt: Date(), failedAt: Date(),
                                     appStateAtStart: "active", attempts: 1, metrics: nil)
        let error = URLError(.timedOut, userInfo: [BellRequestTrace.userInfoKey: trace])
        diagnostics.report(error, path: "/api/settings", method: "GET", observation: .read(error, retainedData: true))
        XCTAssertEqual(module, "app", "要求自身の未知経路を設定画面と決めつけない")
        XCTAssertTrue(log.contains("module=app"))
        XCTAssertTrue(log.contains("request_route=/api/other"))
        XCTAssertTrue(log.contains("operation=unknown"))
        XCTAssertFalse(log.contains("private-value"))
        XCTAssertFalse(log.contains("settings_read"))
    }

    func testScheduleImageAndHarnessGetRoutesAreNamedWithoutTheirValues() {
        let routes = [
            "/api/schedules": ("/api/schedules", "schedules", "schedule_read"),
            "/api/message-images/private-owner/private-file.png": ("/api/message-images/:id/:id", "image", "unknown"),
            "/api/harness-auth/private-value": ("/api/harness-auth/:id", "session", "unknown"),
        ]
        for (path, expected) in routes {
            let route = BellRequestTrace.route(for: path)
            XCTAssertEqual(route, expected.0, path)
            var module = ""
            var log = ""
            let diagnostics = BellDiagnostics { _, value, _, message in module = value; log = message }
            let trace = BellRequestTrace(route: route, method: "GET", startedAt: Date(), failedAt: Date(),
                                         appStateAtStart: "active", attempts: 1, metrics: nil)
            let error = BellAPIError.httpStatus(503, nil, trace)
            diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: false))
            XCTAssertEqual(module, expected.1, path)
            XCTAssertTrue(log.contains("request_route=\(expected.0)\n"), path)
            XCTAssertTrue(log.contains("operation=\(expected.2)\n"), path)
            XCTAssertFalse(log.contains("private"), path)
        }
    }

    func testFixedPublicGetRoutesKeepOnlyKnownNames() {
        let routes = ["/api/setup": "session", "/api/harness-auth": "session", "/api/goals": "bots",
                      "/api/ai-control": "settings", "/api/user-rules": "owner"]
        for (path, expectedModule) in routes {
            let route = BellRequestTrace.route(for: path)
            XCTAssertEqual(route, path)
            var module = ""
            var log = ""
            let diagnostics = BellDiagnostics { _, value, _, message in module = value; log = message }
            let trace = BellRequestTrace(route: route, method: "GET", startedAt: Date(), failedAt: Date(),
                                         appStateAtStart: "active", attempts: 1, metrics: nil)
            let error = URLError(.timedOut, userInfo: [BellRequestTrace.userInfoKey: trace])
            diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: false))
            XCTAssertEqual(module, expectedModule, path)
            XCTAssertTrue(log.contains("request_route=\(path)"), path)
            XCTAssertTrue(log.contains("operation=unknown"), path)
        }
        XCTAssertEqual(BellRequestTrace.route(for: "/api/notifications"), "/api/notifications")
    }

    func testExistingSettingsModelAndSubscriptionModulesStaySettings() {
        for path in ["/api/settings", "/api/settings/:id", "/api/models", "/api/subscription"] {
            let route = BellRequestTrace.route(for: path)
            XCTAssertEqual(route, path)
            var module = ""
            let diagnostics = BellDiagnostics { _, value, _, _ in module = value }
            let trace = BellRequestTrace(route: route, method: "GET", startedAt: Date(), failedAt: Date(),
                                         appStateAtStart: "active", attempts: 1, metrics: nil)
            let error = URLError(.timedOut, userInfo: [BellRequestTrace.userInfoKey: trace])
            diagnostics.report(error, path: path, method: "GET", observation: .read(error, retainedData: true))
            XCTAssertEqual(module, "settings", path)
        }
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

    func testDecodingLogKeepsStaticFieldsAndHidesDynamicKeysAndValues() throws {
        struct Inner: Decodable { let required: String }
        struct Outer: Decodable { let items: [Inner]; let byName: [String: Inner] }
        let cases = [
            (#"{"items":[{"required":"secret-value"},{}],"byName":{}}"#, "items.[1]"),
            (#"{"items":[],"byName":{"private-bot-name":{}}}"#, "byName.*"),
            (#"{"items":[],"byName":{"12345678":{}}}"#, "byName.*"),
        ]
        for (json, path) in cases {
            do {
                _ = try JSONDecoder().decode(Outer.self, from: Data(json.utf8))
                XCTFail("読み取れない本文")
            } catch let error as DecodingError {
                let located = error.located(route: "/api/session", status: 200)
                let log = BellDiagnostics.errorLog(located, module: "session")
                XCTAssertTrue(log.contains("error_type=DecodingError.keyNotFound"), log)
                XCTAssertTrue(log.contains("decoding_key=required"), log)
                XCTAssertTrue(log.contains("decoding_path=\(path)"), log)
                XCTAssertTrue(log.contains("decoding_route=/api/session"), log)
                XCTAssertTrue(log.contains("decoding_http_status=200"), log)
                XCTAssertFalse(log.contains("secret-value") || log.contains("private-bot-name") || log.contains("12345678"), log)
            }
        }
    }

    func testDecodingRouteRemovesQueryAndGeneratedIDs() {
        XCTAssertEqual(BellRequestTrace.decodingRoute(for: "/api/session"), "/api/session")
        XCTAssertEqual(BellRequestTrace.decodingRoute(for: "/api/bots?avatar=omit"), "/api/bots")
        XCTAssertEqual(BellRequestTrace.decodingRoute(for: "/api/bots/bot-12345678/messages?limit=20"),
                       "/api/bots/:id/messages")
        XCTAssertEqual(BellRequestTrace.decodingRoute(for: "/api/rooms/room-abcdef01/messages"),
                       "/api/rooms/:id/messages")
        XCTAssertEqual(BellRequestTrace.decodingRoute(for: "/api/bots/private-name"), "/api/bots/:id")
    }

    private func decodedBot(id: String, deleting: Bool?) throws -> Bot {
        let flag = deleting.map { ",\"deleting\":\($0)" } ?? ""
        return try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"\(id)","name":"n","displayName":"\(id)","harness":"h","model":"m","reasoningEffort":"e","fastMode":false,
         "color":"c","profileText":"","personality":"","speechStyle":"","position":"","role":"","avatar":"","online":false\(flag)}
        """.utf8))
    }

    private func scheduleResponse(_ sources: [(kind: String, id: String)]) throws -> AllSchedulesResponse {
        let body = sources.map { "{\"kind\":\"\($0.kind)\",\"id\":\"\($0.id)\",\"schedules\":[]}" }.joined(separator: ",")
        return try JSONDecoder().decode(AllSchedulesResponse.self, from: Data("{\"sources\":[\(body)]}".utf8))
    }

    func testDeletingBotIsNotExpectedFromTheAllSchedulesResponse() throws {
        let bots = [try decodedBot(id: "bot-kept", deleting: nil), try decodedBot(id: "bot-gone", deleting: true),
                    try decodedBot(id: "bot-false", deleting: false)]
        let sources = ScheduleSource.listed(bots: bots, rooms: [])
        XCTAssertEqual(sources.map(\.target), [.bot("bot-kept"), .bot("bot-false")])
        let pages = try scheduleResponse([("bot", "bot-kept"), ("bot", "bot-false")])
            .schedules(expected: Set(sources.map(\.target)))
        XCTAssertEqual(Set(pages.keys), [.bot("bot-kept"), .bot("bot-false")])
    }

    func testMissingScheduleTargetFailsAndReportsCountsWithoutIDs() throws {
        let expected: Set<ChatTarget> = [.bot("bot-kept"), .bot("bot-private"), .room("room-private")]
        XCTAssertThrowsError(try scheduleResponse([("bot", "bot-kept")]).schedules(expected: expected)) { error in
            guard let incomplete = error as? ScheduleListIncomplete else { return XCTFail("\(error)") }
            XCTAssertEqual(incomplete.errorDescription, BellAPIError.invalidResponse.errorDescription)
            var code = ""
            var log = ""
            let diagnostics = BellDiagnostics { value, _, _, text in code = value; log = text }
            diagnostics.report(error, path: "/api/schedules", method: "GET",
                observation: .read(error, retainedData: false), diagnosticContext: incomplete.diagnosticContext)
            XCTAssertEqual(code, "IOS_RESPONSE_INVALID")
            XCTAssertTrue(log.contains("schedule_expected=3\nschedule_received=1"), log)
            XCTAssertTrue(log.contains("schedule_missing_bots=1\nschedule_missing_rooms=1"), log)
            XCTAssertTrue(log.contains("error_type=InvalidResponse"), log)
            XCTAssertFalse(log.contains("private"), log)
        }
    }

    func testDuplicateScheduleSourceStaysAnInvalidResponse() throws {
        XCTAssertThrowsError(try scheduleResponse([("bot", "bot-one"), ("bot", "bot-one")])
            .schedules(expected: [.bot("bot-one")])) { error in
            guard case BellAPIError.invalidResponse = error else { return XCTFail("\(error)") }
        }
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

    func testTargetedMessageEventKeepsEveryAffectedConversation() {
        let event = BellEvent(payload: [
            "at": "2026-10-23T00:00:00Z", "all": false,
            "topics": ["timeline", "queue"],
            "botIds": ["bot-a", "bot-b"], "roomIds": ["room-a"]
        ], eventName: "messages")
        guard case .targeted(let topics, let botIDs, let roomIDs) = event.scope else {
            return XCTFail("宛先付き通知を全体通知へ変えない")
        }
        XCTAssertEqual(topics, [.timeline, .queue])
        XCTAssertEqual(botIDs, ["bot-a", "bot-b"])
        XCTAssertEqual(roomIDs, ["room-a"])
    }

    func testLegacyAndInvalidEventScopesRequireFullRefresh() {
        let payloads: [[String: Any]] = [
            ["at": "旧形式"],
            ["all": false, "topics": ["timeline"], "botIds": [], "roomIds": []],
            ["all": false, "topics": ["未知"], "botIds": ["bot-a"], "roomIds": []],
            ["all": 0, "topics": ["timeline"], "botIds": ["bot-a"], "roomIds": []]
        ]
        for payload in payloads {
            let event = BellEvent(payload: payload, eventName: "messages")
            guard case .all = event.scope else { return XCTFail("未対応の通知を部分更新にしない") }
        }
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

private final class ServerErrorProtocol: URLProtocol {
    static var status = 500
    static var headers: [String: String] = [:]
    static let defaultBody = #"{"error":"INTERNAL_ERROR"}"#
    static var body = defaultBody

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "server-error.test.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1",
                                       headerFields: Self.headers.merging(["Content-Type": "application/json"]) { $1 })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
