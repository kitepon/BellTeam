import Foundation
import Combine
import SwiftUI
import UIKit
import XCTest
@testable import BellBot

@MainActor
final class NetworkRecoveryTests: XCTestCase {
    func testMessageAcknowledgementUsesExistingDirectAndRoomIDs() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let direct = try decoder.decode(MessageSendAcknowledgement.self,
                                        from: Data(#"{"delivery_id":"delivery-one"}"#.utf8))
        XCTAssertEqual(try direct.messageID(for: .bot("bot-one")), "delivery-one")
        let room = try decoder.decode(MessageSendAcknowledgement.self,
                                      from: Data(#"{"id":"room-message-one"}"#.utf8))
        XCTAssertEqual(try room.messageID(for: .room("planning")), "room-message-one")
        XCTAssertThrowsError(try room.messageID(for: .bot("bot-one")))
    }

    func testIdenticalRefreshDoesNotPublishWholeAppAgain() async {
        let scenario = NetworkScenario(failures: 0)
        let store = AppStore(api: makeAPI(scenario))
        await store.refreshFromView(refreshSubscription: false)
        var updates = 0
        let observation = store.objectWillChange.sink { updates += 1 }
        await store.refreshFromView(refreshSubscription: false)
        XCTAssertEqual(updates, 0)
        withExtendedLifetime(observation) {}
    }

    func testAccessRedirectDuringRefreshOpensLoginInsteadOfLeavingAnErrorBanner() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.phase = .ready
        store.draft(for: .bot("auth-test")).text = "送信前の本文"
        await store.refreshFromView()
        if case .signIn = store.phase {} else { XCTFail("Accessの期限切れからログイン画面へ進む") }
        XCTAssertEqual(store.authMode, "cloudflare")
        XCTAssertNil(store.connectionError)
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(store.draft(for: .bot("auth-test")).text, "送信前の本文")
    }
    func testAccessRedirectDuringBootstrapOpensWebLoginAutomatically() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        await store.bootstrap()
        if case .signIn = store.phase {} else { XCTFail("起動時の期限切れからログイン画面へ進む") }
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(scenario.count("/api/session"), 1)
    }

    func testAccessRedirectDuringEventsOpensWebLoginAutomatically() async {
        let scenario = NetworkScenario(failures: 0, accessExpired: true)
        let api = makeAPI(scenario)
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.phase = .ready
        let changed = expectation(description: "更新通知の認証エラーを表示")
        let observation = store.$phase.sink { phase in
            if case .signIn = phase { changed.fulfill() }
        }
        store.startEvents()
        await fulfillment(of: [changed], timeout: 2)
        store.stopEvents()
        observation.cancel()
        if case .signIn = store.phase {} else { XCTFail("更新通知の期限切れからログイン画面へ進む") }
        XCTAssertTrue(store.openLoginAutomatically)
        XCTAssertEqual(scenario.count("/api/events"), 1)
    }

    func testLostGETIsRetriedOnceWithoutReportingRecoveredFailure() async throws {
        let scenario = NetworkScenario(failures: 1)
        let api = makeAPI(scenario)
        let _: [String: String] = try await api.get("/api/session")
        XCTAssertEqual(scenario.count("/api/session"), 2)
        XCTAssertEqual(scenario.reports.count, 0)
    }

    func testRepeatedLostGETReportsOnceAndIncludesAnonymousContext() async throws {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        api.diagnostics.configure(serverURL: api.baseURL)
        api.diagnostics.updateAppState("active")
        let previous = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previous }
        let store = AppStore(api: api)
        store.rooms = [Room(id: "previous", name: "保持する一覧", purpose: "", representativeId: nil, memberIds: [], avatar: "", recent: nil)]
        await store.refreshFromView()
        XCTAssertEqual(store.rooms.first?.name, "保持する一覧")
        XCTAssertNotNil(store.connectionError)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = try XCTUnwrap(scenario.reports.first?.log)
        let attemptAttachment = XCTAttachment(data: Data(log.utf8), uniformTypeIdentifier: "public.plain-text")
        attemptAttachment.name = "人工GET二試行の診断原文"
        attemptAttachment.lifetime = .keepAlways
        add(attemptAttachment)
        XCTAssertTrue(log.contains("connection_route=public"))
        XCTAssertTrue(log.contains("app_state=active"))
        XCTAssertTrue(log.contains("severity=warn"))
        XCTAssertTrue(log.contains("app_handling=error_shown_data_retained"))
        XCTAssertTrue(log.contains("app_defect=not_established"))
        XCTAssertTrue(log.contains("attempt_1_error_code=-1005"))
        XCTAssertTrue(log.contains("attempt_2_error_code=-1005"))
        XCTAssertTrue(log.contains("attempt_1_transport_result=error_thrown"))
        XCTAssertTrue(log.contains("attempt_2_transport_result=error_thrown"))
        XCTAssertTrue(log.contains("attempt_1_started_at_ms="))
        XCTAssertTrue(log.contains("attempt_1_finished_at_ms="))
        XCTAssertTrue(log.contains("attempt_1_elapsed_monotonic_ms="))
        XCTAssertTrue(log.contains("attempt_2_started_at_ms="))
        XCTAssertTrue(log.contains("attempt_2_finished_at_ms="))
        XCTAssertTrue(log.contains("attempt_2_elapsed_monotonic_ms="))
        XCTAssertTrue(log.contains("attempt_1_task_metrics_available=true"))
        XCTAssertTrue(log.contains("attempt_2_task_metrics_available=true"))
        XCTAssertFalse(log.contains("attempt_3_"), "GETは既定の1回再試行だけ")
        XCTAssertFalse(log.contains("network.test.invalid"))
    }

    func testGoalListFailureDirectReportIncludesCallerContext() async {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        api.diagnostics.updateAppState("active")
        do {
            let _: [String: String] = try await api.get("/api/goals?token=private-token")
            XCTFail("二試行とも切断したGETを成功として返さない")
        } catch {
            api.diagnostics.report(error, path: "/api/goals?token=private-token", method: "GET",
                                   observation: .read(error, retainedData: false),
                                   diagnosticContext: "goal_load_trigger=list_view_task\ngoal_view_phase_at_call=active")
        }
        XCTAssertEqual(scenario.count("/api/goals"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = scenario.reports.first?.log ?? ""
        XCTAssertTrue(log.contains("request_route=/api/goals"))
        XCTAssertTrue(log.contains("attempt_1_error_code=-1005"))
        XCTAssertTrue(log.contains("attempt_2_error_code=-1005"))
        XCTAssertTrue(log.contains("goal_load_trigger=list_view_task"))
        XCTAssertTrue(log.contains("goal_view_phase_at_call=active"))
        XCTAssertFalse(log.contains("private-token"))
        let attachment = XCTAttachment(data: Data(log.utf8), uniformTypeIdentifier: "public.plain-text")
        attachment.name = "人工Goal一覧二試行の直接report原文（UI未再現）"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testGoalTimeoutOrdersCallPhaseChangeAndRequestOnContinuousClock() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut)
        let api = makeAPI(scenario)
        api.diagnostics.updateAppState("active")
        let context = GoalLoadCallContext.capture(trigger: "chat_foreground", viewPhase: .active,
                                                  diagnostics: api.diagnostics)
        api.diagnostics.updateAppState("background")
        do {
            let _: [String: String] = try await api.get("/api/bots/bot-network/goal")
            XCTFail("人工の時間切れを成功として返さない")
        } catch {
            api.diagnostics.report(error, path: "/api/bots/bot-network/goal", method: "GET",
                                   observation: .read(error, retainedData: true),
                                   diagnosticContext: context.log)
        }
        XCTAssertEqual(scenario.count("/api/bots/bot-network/goal"), 1)
        let log = scenario.reports.first?.log ?? ""
        XCTAssertTrue(log.contains("goal_load_trigger=chat_foreground"))
        XCTAssertTrue(log.contains("goal_view_phase_at_call=active"))
        XCTAssertTrue(log.contains("goal_app_state_at_call=active"))
        XCTAssertTrue(log.contains("goal_app_state_revision_at_call=1"))
        XCTAssertTrue(log.contains("attempt_1_app_state_at_start=background"))
        XCTAssertTrue(log.contains("attempt_1_app_state_revision_at_start=2"))
        func tick(_ key: String) -> UInt64 {
            let line = log.split(separator: "\n").first { $0.hasPrefix(key + "=") }
            return UInt64(line?.split(separator: "=").last ?? "") ?? 0
        }
        let call = tick("goal_call_continuous_ms")
        let changed = tick("attempt_1_app_state_changed_continuous_ms_at_start")
        let started = tick("attempt_1_started_continuous_ms")
        XCTAssertGreaterThan(call, 0)
        XCTAssertLessThanOrEqual(tick("goal_app_state_changed_continuous_ms_at_call"), call)
        XCTAssertLessThanOrEqual(call, changed)
        XCTAssertLessThanOrEqual(changed, started)
        XCTAssertTrue(log.contains("attempt_1_elapsed_continuous_ms="))
        XCTAssertFalse(log.contains("attempt_2_"))
        XCTAssertFalse(log.contains("bot-network"))
        let attachment = XCTAttachment(data: Data(log.utf8), uniformTypeIdentifier: "public.plain-text")
        attachment.name = "人工Goal個別timeoutのcall→状態変更→試行の原文"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testForegroundGoalReadCancelsStaleGETAndWaitsBeforeNewActiveGET() async {
        let scenario = NetworkScenario(failures: 0)
        let api = makeAPI(scenario)
        let foreground = GoalForegroundLoad()
        let oldStarted = expectation(description: "旧読取の処理開始")
        var resumeOld: CheckedContinuation<Void, Never>?
        var oldLoading = false
        foreground.start {
            oldLoading = true
            await withCheckedContinuation { continuation in
                resumeOld = continuation
                oldStarted.fulfill()
            }
            oldLoading = false
        }
        await fulfillment(of: [oldStarted], timeout: 3)
        foreground.start {
            let _: [String: String]? = try? await api.get("/api/goals")
        }
        foreground.cancel()
        let current = foreground.start {
            XCTAssertFalse(oldLoading, "再activeのGETは旧読取の終了を待つ")
            let result: [String: String]? = try? await api.get("/api/goals")
            XCTAssertEqual(result?["result"], "ok")
        }
        XCTAssertEqual(scenario.count("/api/goals"), 0, "非activeになった旧TaskはGETを始めない")
        resumeOld?.resume()
        await current.value
        XCTAssertEqual(scenario.count("/api/goals"), 1, "再activeの現TaskだけがGETを行う")
        XCTAssertTrue(scenario.reports.isEmpty, "取消で通信障害warnを作らない")
    }

    func testGoalViewTaskCancellationDoesNotCancelItsReplacement() async {
        let scenario = NetworkScenario(failures: 0)
        let api = makeAPI(scenario)
        let foreground = GoalForegroundLoad()
        let firstStarted = expectation(description: "画面Taskの旧読取が開始")
        var resumeFirst: CheckedContinuation<Void, Never>?
        var firstCancelled = false
        let firstWrapper = Task {
            await foreground.runForViewTask(whenActive: true) {
                await withCheckedContinuation { continuation in
                    resumeFirst = continuation
                    firstStarted.fulfill()
                }
                firstCancelled = Task.isCancelled
            }
        }
        await fulfillment(of: [firstStarted], timeout: 3)
        firstWrapper.cancel()
        resumeFirst?.resume()
        await firstWrapper.value
        XCTAssertTrue(firstCancelled, "SwiftUIの画面Task取消は自身の読取へ伝わる")

        let nextStarted = expectation(description: "切替前の旧読取が開始")
        var resumeNext: CheckedContinuation<Void, Never>?
        var oldLoading = false
        var nextCancelled = false
        let nextWrapper = Task {
            await foreground.runForViewTask(whenActive: true) {
                oldLoading = true
                await withCheckedContinuation { continuation in
                    resumeNext = continuation
                    nextStarted.fulfill()
                }
                nextCancelled = Task.isCancelled
                oldLoading = false
            }
        }
        await fulfillment(of: [nextStarted], timeout: 3)
        foreground.cancel()
        let current = foreground.start {
            XCTAssertFalse(oldLoading, "再activeの読取は旧loading解除を待つ")
            let response: [String: String]? = try? await api.get("/api/goals")
            XCTAssertEqual(response?["result"], "ok")
        }
        nextWrapper.cancel()
        XCTAssertEqual(scenario.count("/api/goals"), 0)
        resumeNext?.resume()
        await nextWrapper.value
        await current.value
        XCTAssertTrue(nextCancelled)
        XCTAssertEqual(scenario.count("/api/goals"), 1, "旧wrapperの遅い取消は現読取を止めない")
        XCTAssertTrue(scenario.reports.isEmpty)
    }

    func testInactiveGoalViewTaskDoesNotStartOrCancelCurrentRead() async {
        let foreground = GoalForegroundLoad()
        let currentStarted = expectation(description: "稼働中の読取が開始")
        var resumeCurrent: CheckedContinuation<Void, Never>?
        var currentCancelled = false
        var inactiveLoadCalls = 0
        let current = foreground.start {
            await withCheckedContinuation { continuation in
                resumeCurrent = continuation
                currentStarted.fulfill()
            }
            currentCancelled = Task.isCancelled
        }
        await fulfillment(of: [currentStarted], timeout: 3)
        await foreground.runForViewTask(whenActive: false) {
            inactiveLoadCalls += 1
        }
        XCTAssertEqual(inactiveLoadCalls, 0, "非activeの初回表示はGETを開始しない")
        resumeCurrent?.resume()
        await current.value
        XCTAssertFalse(currentCancelled, "非activeの入口は稼働中のTaskを取り消さない")
    }

    func testSendFailureReconcileReportsOnlyTheLoadCallBoundary() async {
        let lost = URLError(.networkConnectionLost)
        var loadCalls = 0
        let inactive = await SendFailureReconcileObservation.observe(error: lost, appActive: false) {
            loadCalls += 1
            return .startedReaderReturned
        }
        let known = await SendFailureReconcileObservation.observe(
            error: BellAPIError.httpStatus(400, nil), appActive: true) {
            loadCalls += 1
            return .startedReaderReturned
        }
        XCTAssertEqual(loadCalls, 0)
        XCTAssertTrue(inactive.log.contains("send_reconcile_decision=skipped_app_inactive"))
        XCTAssertTrue(known.log.contains("send_reconcile_decision=skipped_known_result"))
        XCTAssertTrue(inactive.log.contains("send_reconcile_load_calls=0"))
        let scene = await SendFailureReconcileObservation.observe(error: lost, appActive: true) {
            loadCalls += 1
            return .skippedSceneInactive
        }
        let awaiting = await SendFailureReconcileObservation.observe(error: lost, appActive: true) {
            loadCalls += 1
            return .skippedAwaitingSend
        }
        let joined = await SendFailureReconcileObservation.observe(error: lost, appActive: true) {
            loadCalls += 1
            return .joinedReaderReturned
        }
        let started = await SendFailureReconcileObservation.observe(error: lost, appActive: true) {
            loadCalls += 1
            return .startedReaderReturned
        }
        XCTAssertEqual(loadCalls, 4)
        XCTAssertTrue(scene.log.contains("send_reconcile_load_result=skipped_scene_inactive"))
        XCTAssertTrue(awaiting.log.contains("send_reconcile_load_result=skipped_awaiting_send"))
        XCTAssertTrue(joined.log.contains("send_reconcile_load_result=joined_reader_returned"))
        XCTAssertTrue(started.log.contains("send_reconcile_load_result=started_reader_returned"))
        var reports: [String] = []
        let diagnostics = BellDiagnostics { _, _, _, log in reports.append(log) }
        diagnostics.report(lost, path: "/api/bots/bot-deadbeef/messages", method: "POST",
                           observation: .write, diagnosticContext: scene.log)
        XCTAssertEqual(reports.count, 1, "同じPOST失敗を一度だけ報告する")
        XCTAssertTrue(reports[0].contains("send_reconcile_load_result=skipped_scene_inactive"))
        let raw = ["case=app_inactive\n\(inactive.log)", "case=known_result\n\(known.log)",
                   "case=scene_inactive\n\(scene.log)", "case=awaiting_send\n\(awaiting.log)",
                   "case=joined_reader\n\(joined.log)",
                   "case=started_reader\n\(started.log)"].joined(separator: "\n")
        let attachment = XCTAttachment(data: Data(raw.utf8), uniformTypeIdentifier: "public.plain-text")
        attachment.name = "人工POST失敗の読直し分岐原文"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testPostIsNotReplayed() async throws {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.post("/api/bots/bot-a/messages", body: ["message": "本文の秘密値"])
            XCTFail("切断したPOSTを成功として返さない")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .networkConnectionLost)
            api.diagnostics.report(error, path: "/api/bots", method: "POST", observation: .write)
        }
        XCTAssertEqual(scenario.count("/api/bots/bot-a/messages"), 1)
        XCTAssertEqual(scenario.reports.count, 1)
        let log = scenario.reports[0].log
        XCTAssertTrue(log.contains("request_route=/api/bots/:id/messages"))
        XCTAssertTrue(log.contains("request_attempts=1"))
        XCTAssertTrue(log.contains("user_impact=result_unconfirmed"))
        XCTAssertFalse(log.contains("本文の秘密値"))
    }

    func testHTTP500PostTellsUserToCheckConversationBeforeRetry() async {
        let scenario = NetworkScenario(failures: 0, httpStatus: 500)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.post("/api/bots/bot-a/messages", body: ["message": "未送信か不明な本文"])
            XCTFail("500を成功として返さない")
        } catch {
            let guidance = BellAPIError.operationFailureMessage(error)
            XCTAssertTrue(guidance.contains("操作の結果を確認できませんでした"))
            XCTAssertTrue(guidance.contains("現在の状態を更新して確認してください"))
            api.diagnostics.report(error, path: "/api/bots/bot-a/messages", method: "POST", observation: .write)
        }
        XCTAssertEqual(scenario.count("/api/bots/bot-a/messages"), 1)
        XCTAssertTrue(scenario.reports.first?.log.contains("user_impact=result_unconfirmed") == true)
    }

    func testTimedOutGETReportKeepsItsOwnRouteAndStartStateWithoutQuery() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut)
        let api = makeAPI(scenario)
        api.diagnostics.updateAppState("active")
        do {
            let _: [String: String] = try await api.get("/api/bots/private-bot/messages?after=private-token")
            XCTFail("時間切れを失敗として返す")
        } catch {
            api.diagnostics.updateAppState("background")
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
        let log = scenario.reports.first?.log ?? ""
        let timeoutAttachment = XCTAttachment(data: Data(log.utf8), uniformTypeIdentifier: "public.plain-text")
        timeoutAttachment.name = "人工GET単一timeoutの診断原文"
        timeoutAttachment.lifetime = .keepAlways
        add(timeoutAttachment)
        XCTAssertTrue(log.contains("request_route=/api/bots/:id/messages"))
        XCTAssertTrue(log.contains("app_state_at_request_start=active"))
        XCTAssertTrue(log.contains("app_state=background"))
        XCTAssertTrue(log.contains("request_started_at_ms="))
        XCTAssertTrue(log.contains("request_failed_at_ms="))
        XCTAssertEqual(scenario.count("/api/bots/private-bot/messages"), 1)
        XCTAssertEqual(scenario.reports.first?.code, "IOS_NETWORK_TIMEOUT")
        XCTAssertTrue(log.contains("request_attempts=1"))
        XCTAssertTrue(log.contains("request_timeout_interval_ms=60000"))
        XCTAssertTrue(log.contains("session_timeout_interval_for_request_ms=60000"))
        XCTAssertTrue(log.contains("task_metrics_available=true"))
        XCTAssertTrue(log.contains("attempt_1_error_code=-1001"))
        XCTAssertTrue(log.contains("attempt_1_elapsed_monotonic_ms="))
        XCTAssertTrue(log.contains("attempt_1_elapsed_continuous_ms="))
        XCTAssertTrue(log.contains("attempt_1_app_state_at_start=active"))
        XCTAssertTrue(log.contains("attempt_1_app_state_at_end=active"), "報告時のbackgroundと要求失敗時を分ける")
        XCTAssertTrue(log.contains("attempt_1_app_state_revision_at_start=1"))
        XCTAssertTrue(log.contains("attempt_1_app_state_revision_at_end=1"))
        XCTAssertTrue(log.contains("attempt_1_app_state_changed_at_start_ms="))
        XCTAssertTrue(log.contains("attempt_1_app_state_changed_at_end_ms="))
        XCTAssertFalse(log.contains("attempt_2_"))
        XCTAssertFalse(log.contains("private-bot"))
        XCTAssertFalse(log.contains("private-token"))
    }

    func testSuccessfulManualGETClearsOnlyItsErrorAndKeepsDraft() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        store.rooms = [Room(id: "known", name: "既知の一覧", purpose: "", representativeId: nil, memberIds: [], avatar: "", recent: nil)]
        store.draft(for: .bot("bot-network")).text = "未送信の本文"
        await store.refreshFromView()
        XCTAssertNotNil(store.connectionError)
        XCTAssertEqual(store.rooms.first?.name, "既知の一覧")
        await store.refreshFromView()
        XCTAssertEqual(store.bots.first?.id, "bot-network")
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(store.draft(for: .bot("bot-network")).text, "未送信の本文")
        XCTAssertEqual(scenario.count("/api/bots"), 2, "GETの時間切れを自動再送しない")
    }

    func testTLSReadFailureStopsUntilExplicitScheduleReload() async throws {
        let scenario = NetworkScenario(failures: 1, failureCode: .secureConnectionFailed)
        let api = makeAPI(scenario)
        let path = "/api/bots/bot-network/schedules"
        do {
            let _: SchedulesResponse = try await api.get(path)
            XCTFail("TLS失敗を成功として返さない")
        } catch {
            api.diagnostics.report(error, path: path, method: "GET",
                                   observation: .read(error, retainedData: true))
        }
        XCTAssertEqual(scenario.count(path), 1, "TLS失敗を自動再送しない")
        XCTAssertEqual(scenario.reports.first?.code, "IOS_NETWORK_FAILURE")
        XCTAssertTrue(scenario.reports.first?.log.contains("error_code=-1200") == true)

        let result: SchedulesResponse = try await api.get(path)
        XCTAssertTrue(result.schedules.isEmpty)
        XCTAssertEqual(scenario.count(path), 2, "明示した次のGETだけを送る")
    }

    func testPushRegistrationTimeoutDoesNotAutomaticallyRepeatPost() async throws {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut)
        let api = makeAPI(scenario)
        let path = "/api/notifications/devices"
        let body = SyntheticPushDevice(token: "artificial-token", environment: "Sandbox",
                                       server: "https://network.test.invalid", previousToken: nil,
                                       signedTransaction: nil)
        do {
            let _: SyntheticPushRegistration = try await api.post(path, body: body)
            XCTFail("通知登録の時間切れを成功にしない")
        } catch {
            api.diagnostics.reportPush(error, stage: "register_device")
        }
        XCTAssertEqual(scenario.count(path), 1, "登録POSTを自動再送しない")
        XCTAssertEqual(scenario.reports.first?.code, "IOS_PUSH_FAILED")
        XCTAssertTrue(scenario.reports.first?.log.contains("stage=register_device") == true)
        XCTAssertTrue(scenario.reports.first?.log.contains("notification_error_code=-1001") == true)

        let result: SyntheticPushRegistration = try await api.post(path, body: body)
        XCTAssertTrue(result.registered)
        XCTAssertEqual(scenario.count(path), 2, "次の明示的な登録要求だけを送る")
    }

    func testSuccessfulGETDoesNotHideSSEReconnectWarning() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true, holdEventsOpen: true, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        defer { store.stopEvents() }
        let warning = expectation(description: "SSEの再接続警告")
        var sawWarning = false
        let observation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続"), !sawWarning { sawWarning = true; warning.fulfill() }
        }
        store.startEvents()
        await fulfillment(of: [warning], timeout: 2)
        await store.refreshFromView()
        XCTAssertEqual(store.bots.first?.id, "bot-network")
        XCTAssertTrue(store.connectionError?.contains("再接続") == true)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        withExtendedLifetime(observation) {}
    }

    func testSSERecoveryKeepsOutstandingGETErrorUntilGETRecovers() async {
        let scenario = NetworkScenario(failures: 1, failureCode: .timedOut,
                                       events502ThenReady: true, holdEventsOpen: true, skipAvatarVersion: true)
        let store = AppStore(api: makeAPI(scenario))
        store.phase = .ready
        defer { store.stopEvents() }
        let warning = expectation(description: "SSEの再接続警告")
        let event = expectation(description: "SSEの回復")
        var errorAtEvent: String?
        var sawWarning = false
        let warningObservation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続"), !sawWarning { sawWarning = true; warning.fulfill() }
        }
        let eventObservation = store.$eventRevision.dropFirst().sink { _ in
            errorAtEvent = store.connectionError
            event.fulfill()
        }
        store.startEvents()
        await fulfillment(of: [warning], timeout: 2)
        await store.refreshFromView()
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        await fulfillment(of: [event], timeout: 3)
        XCTAssertNotNil(errorAtEvent, "SSE回復時に未解決の一覧GETエラーを消さない")
        XCTAssertFalse(errorAtEvent?.contains("再接続") == true)
        withExtendedLifetime((warningObservation, eventObservation)) {}
    }

    func testHTTP500ReportUsesFailedConversationRoute() async {
        let scenario = NetworkScenario(failures: 0, httpStatus: 500)
        let api = makeAPI(scenario)
        do {
            let _: [String: String] = try await api.get("/api/rooms/private-room/messages?after=private-token")
            XCTFail("500を成功として返さない")
        } catch {
            api.diagnostics.report(error, path: "/api/bots", method: "GET", observation: .read(error, retainedData: true))
        }
        let report = scenario.reports.first
        XCTAssertEqual(report?.code, "IOS_HTTP_5XX")
        XCTAssertTrue(report?.log.contains("module=conversation") == true)
        XCTAssertTrue(report?.log.contains("request_route=/api/rooms/:id/messages") == true)
        XCTAssertTrue(report?.log.contains("http_status=500") == true)
        XCTAssertTrue(report?.log.contains("task_metrics_available=true") == true)
        XCTAssertFalse(report?.log.contains("private-room") == true)
        XCTAssertFalse(report?.log.contains("private-token") == true)
    }

    func testEvents502ThenReadyReportsInterruptionAndReceivesUpdate() async throws {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true)
        let api = makeAPI(scenario)
        do {
            try await api.events { _ in }
            XCTFail("初回502を成功にしない")
        } catch BellAPIError.httpStatus(let status, _, let trace) {
            XCTAssertEqual(status, 502)
            api.diagnostics.report(BellAPIError.httpStatus(status, nil, trace), path: "/api/events",
                                   method: "GET", observation: .reconnecting)
        }
        var received: [String] = []
        try await api.events { event in if let type = event.type { received.append(type) } }
        XCTAssertEqual(received, ["messages"])
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        XCTAssertEqual(scenario.reports[0].code, "IOS_HTTP_5XX")
        XCTAssertTrue(scenario.reports[0].log.contains("request_route=/api/events"))
        XCTAssertTrue(scenario.reports[0].log.contains("request_started_at_ms="))
        XCTAssertTrue(scenario.reports[0].log.contains("request_failed_at_ms="))
        XCTAssertTrue(scenario.reports[0].log.contains("task_metrics_available="))
        XCTAssertTrue(scenario.reports[0].log.contains("severity=warn"))
    }

    func testEvents502ShowsReconnectThenClearsItAfterReady() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true, holdEventsOpen: true)
        let api = makeAPI(scenario)
        let previousOpen = BellNotifications.shared.onOpen
        defer { BellNotifications.shared.onOpen = previousOpen }
        let store = AppStore(api: api)
        defer { store.stopEvents() }
        let banner = expectation(description: "502で再接続を表示")
        let recovered = expectation(description: "再接続後の知らせを受信")
        let errorObservation = store.$connectionError.compactMap { $0 }.sink { value in
            if value.contains("再接続") { banner.fulfill() }
        }
        let eventObservation = store.$eventRevision.dropFirst().sink { _ in recovered.fulfill() }
        store.startEvents()
        await fulfillment(of: [banner, recovered], timeout: 4)
        XCTAssertNil(store.connectionError)
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.reports.filter { $0.code == "IOS_HTTP_5XX" }.count, 1)
        withExtendedLifetime((errorObservation, eventObservation)) {}
    }

    func testReadyAfterReconnectFetchesUpdatesMissedDuringDisconnection() async {
        let scenario = NetworkScenario(failures: 0, events502ThenReady: true,
                                       holdEventsOpen: true, skipAvatarVersion: true,
                                       readyOnlyAfterReconnect: true)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        store.startEvents()
        for _ in 0..<80 where !store.bots.contains(where: { $0.id == "bot-network" }) {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(scenario.count("/api/events"), 2)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertTrue(store.bots.contains(where: { $0.id == "bot-network" }))
    }

    func testTargetedSSEUpdatesOnlyAffectedConversationAndBotList() async {
        let stream = "event: messages\ndata: {\"at\":\"2026-10-23T00:00:00Z\",\"all\":false,\"topics\":[\"timeline\"],\"botIds\":[\"bot-network\"],\"roomIds\":[]}\n\n"
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true,
                                       skipAvatarVersion: true, eventStream: stream)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        var changedTargets: [ChatTarget] = []
        let observation = store.conversationChanges.sink { changedTargets.append($0) }
        store.startEvents()
        for _ in 0..<80 where store.bots.isEmpty {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(changedTargets, [.bot("bot-network")])
        XCTAssertEqual(store.eventRevision, 0)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertEqual(scenario.count("/api/rooms"), 0)
        XCTAssertEqual(scenario.count("/api/owner"), 0)
        XCTAssertEqual(scenario.count("/api/queue"), 0)
        withExtendedLifetime(observation) {}
    }

    func testInitialReadyClosesTheGapBetweenFirstReadAndEventConnection() async {
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true,
                                       skipAvatarVersion: true,
                                       eventStream: "event: ready\ndata: {}\n\n")
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        store.startEvents()
        for _ in 0..<80 where store.bots.isEmpty {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.eventRevision, 1)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertEqual(scenario.count("/api/rooms"), 1)
        XCTAssertEqual(scenario.count("/api/owner"), 1)
        XCTAssertEqual(scenario.count("/api/queue"), 1)
    }

    func testTargetedScheduleEventDoesNotFetchConversationOrLists() async {
        let stream = "event: messages\ndata: {\"all\":false,\"topics\":[\"schedules\"],\"botIds\":[\"bot-network\"],\"roomIds\":[]}\n\n"
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true, eventStream: stream)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        let notified = expectation(description: "予定だけを更新")
        let observation = store.scheduleChanges.sink { targets in
            XCTAssertEqual(targets, [.bot("bot-network")])
            notified.fulfill()
        }
        store.startEvents()
        await fulfillment(of: [notified], timeout: 4)
        XCTAssertEqual(store.eventRevision, 0)
        XCTAssertEqual(scenario.count("/api/bots"), 0)
        XCTAssertEqual(scenario.count("/api/rooms"), 0)
        withExtendedLifetime(observation) {}
    }

    func testMixedBotRoomQueueEventKeepsEveryTarget() async {
        let stream = "event: messages\ndata: {\"all\":false,\"topics\":[\"timeline\",\"queue\"],\"botIds\":[\"bot-network\"],\"roomIds\":[\"room-a\"]}\n\n"
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true,
                                       skipAvatarVersion: true, eventStream: stream)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        var changedTargets: [ChatTarget] = []
        let observation = store.conversationChanges.sink { changedTargets.append($0) }
        store.startEvents()
        for _ in 0..<80 where scenario.count("/api/bots") + scenario.count("/api/rooms") + scenario.count("/api/queue") < 3 {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(Set(changedTargets), [.bot("bot-network"), .room("room-a")])
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertEqual(scenario.count("/api/rooms"), 1)
        XCTAssertEqual(scenario.count("/api/queue"), 1)
        XCTAssertEqual(scenario.count("/api/owner"), 0)
        withExtendedLifetime(observation) {}
    }

    func testQueueOnlyEventReadsQueueWithoutUnrelatedLists() async {
        let stream = "event: messages\ndata: {\"all\":false,\"topics\":[\"queue\"],\"botIds\":[\"bot-network\"],\"roomIds\":[]}\n\n"
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true, eventStream: stream)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        let notified = expectation(description: "該当会話の処理状態を更新")
        let observation = store.conversationChanges.sink { target in
            if target == .bot("bot-network") { notified.fulfill() }
        }
        store.startEvents()
        await fulfillment(of: [notified], timeout: 4)
        for _ in 0..<80 where scenario.count("/api/queue") == 0 {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(scenario.count("/api/queue"), 1)
        XCTAssertEqual(scenario.count("/api/bots"), 0)
        XCTAssertEqual(scenario.count("/api/rooms"), 0)
        XCTAssertEqual(scenario.count("/api/owner"), 0)
        withExtendedLifetime(observation) {}
    }

    func testUnknownTopicFallsBackToFullRefresh() async {
        let stream = "event: messages\ndata: {\"all\":false,\"topics\":[\"future-topic\"],\"botIds\":[\"bot-network\"],\"roomIds\":[]}\n\n"
        let scenario = NetworkScenario(failures: 0, holdEventsOpen: true,
                                       skipAvatarVersion: true, eventStream: stream)
        let store = AppStore(api: makeAPI(scenario))
        defer { store.stopEvents() }
        store.startEvents()
        for _ in 0..<80 where store.bots.isEmpty {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.eventRevision, 1)
        XCTAssertEqual(scenario.count("/api/bots"), 1)
        XCTAssertEqual(scenario.count("/api/rooms"), 1)
        XCTAssertEqual(scenario.count("/api/owner"), 1)
        XCTAssertEqual(scenario.count("/api/queue"), 1)
    }

    func testNotificationFailureHasOnlyItsStageReport() async {
        let scenario = NetworkScenario(failures: 2)
        let api = makeAPI(scenario)
        api.diagnostics.configure(serverURL: api.baseURL)
        let notifications = BellNotifications()
        await notifications.activate(api: api, signedTransaction: nil)
        XCTAssertEqual(scenario.count("/api/notifications"), 2)
        XCTAssertEqual(scenario.reports.count, 1)
        XCTAssertEqual(scenario.reports.first?.code, "IOS_PUSH_FAILED")
        XCTAssertTrue(scenario.reports.first?.log.contains("stage=server_status") == true)
        XCTAssertTrue(scenario.reports.first?.log.contains("request_elapsed_ms=") == true)
    }

    func testUnchangedAvatarsAreNotDownloadedAgain() async throws {
        let scenario = NetworkScenario(failures: 0, avatars: true)
        let api = makeAPI(scenario)
        let server = api.baseURL!.absoluteString
        try BotAvatarCache.shared.store([], server: server)
        let previousOpen = BellNotifications.shared.onOpen
        defer {
            BellNotifications.shared.onOpen = previousOpen
            try? BotAvatarCache.shared.store([], server: server)
        }
        let store = AppStore(api: api)
        try await store.refresh()
        let first = store.bots.first?.avatar
        try await store.refresh()
        XCTAssertEqual(store.bots.first?.avatar, first)
        XCTAssertTrue(first?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertEqual(scenario.count("/api/bots/bot-network/avatar"), 1)
        XCTAssertTrue(scenario.queries.filter { $0.0 == "/api/bots" }.allSatisfy { $0.1 == "avatar=omit" })
        let restored = try BotAvatarCache.shared.dataURL(botID: "bot-network", server: server, version: "version-a")
        XCTAssertEqual(restored, first)
    }

    private func makeAPI(_ scenario: NetworkScenario) -> BellAPI {
        NetworkScenarioProtocol.scenario = scenario
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NetworkScenarioProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let diagnostics = BellDiagnostics { code, _, _, log in scenario.record(code: code, log: log) }
        return BellAPI(baseURL: URL(string: "https://network.test.invalid")!, session: session, diagnostics: diagnostics)
    }
}

private struct SyntheticPushDevice: Encodable {
    let token: String
    let environment: String
    let server: String
    let previousToken: String?
    let signedTransaction: String?
}
private struct SyntheticPushRegistration: Decodable { let registered: Bool }

private final class NetworkScenario {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    private var storedReports: [(code: String, log: String)] = []
    private var storedQueries: [(String, String?)] = []
    let failures: Int
    let failureCode: URLError.Code
    let avatars: Bool
    let accessExpired: Bool
    let httpStatus: Int
    let events502ThenReady: Bool
    let readyOnlyAfterReconnect: Bool
    let eventStream: String?
    let holdEventsOpen: Bool
    let skipAvatarVersion: Bool
    private let png: Data

    @MainActor
    init(failures: Int, failureCode: URLError.Code = .networkConnectionLost,
         avatars: Bool = false, accessExpired: Bool = false, httpStatus: Int = 200,
         events502ThenReady: Bool = false, holdEventsOpen: Bool = false,
         skipAvatarVersion: Bool = false, readyOnlyAfterReconnect: Bool = false,
         eventStream: String? = nil) {
        self.failures = failures
        self.failureCode = failureCode
        self.avatars = avatars
        self.accessExpired = accessExpired
        self.httpStatus = httpStatus
        self.events502ThenReady = events502ThenReady
        self.readyOnlyAfterReconnect = readyOnlyAfterReconnect
        self.eventStream = eventStream
        self.holdEventsOpen = holdEventsOpen
        self.skipAvatarVersion = skipAvatarVersion
        png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { c in
            UIColor.systemPink.setFill(); c.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }.pngData()!
    }

    var reports: [(code: String, log: String)] { lock.lock(); defer { lock.unlock() }; return storedReports }
    var queries: [(String, String?)] { lock.lock(); defer { lock.unlock() }; return storedQueries }
    func count(_ path: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[path] ?? 0 }
    func record(code: String, log: String) { lock.lock(); storedReports.append((code, log)); lock.unlock() }

    func response(_ request: URLRequest) throws -> (Data, String) {
        let path = request.url!.path
        lock.lock()
        counts[path, default: 0] += 1
        let count = counts[path]!
        storedQueries.append((path, request.url!.query))
        lock.unlock()
        if count <= failures { throw URLError(failureCode) }
        if path == "/api/events", let eventStream {
            return (Data(eventStream.utf8), "text/event-stream")
        }
        if events502ThenReady, path == "/api/events" {
            if count == 1 { return (Data("{\"error\":\"MOCK_UNAVAILABLE\"}".utf8), "application/json") }
            if readyOnlyAfterReconnect {
                return (Data("event: ready\ndata: {\"type\":\"ready\"}\n\n".utf8), "text/event-stream")
            }
            return (Data("data: {\"type\":\"messages\"}\n\n".utf8), "text/event-stream")
        }
        if avatars, path.hasSuffix("/avatar") { return (png, "image/png") }
        let object: [String: Any]
        switch path {
        case "/api/bots":
            object = ["bots": [["id": "bot-network", "name": "試験", "display_name": "試験", "harness": "codex", "model": "", "reasoning_effort": "", "fast_mode": false, "color": "#000000", "profile_text": "", "personality": "", "speech_style": "", "position": "", "role": "", "avatar": "", "avatarVersion": skipAvatarVersion ? "" : "version-a", "online": false]]]
        case "/api/rooms": object = ["rooms": []]
        case let path where path.hasSuffix("/schedules"): object = ["schedules": []]
        case "/api/notifications/devices": object = ["registered": true]
        case "/api/queue": object = ["items": []]
        case "/api/owner": object = ["owner": ["name": "試験", "profile": "", "avatar": "", "avatarVersion": "", "x_url": "", "github_url": "", "links": []]]
        default: object = ["result": "ok"]
        }
        return (try JSONSerialization.data(withJSONObject: object), "application/json")
    }
}

private final class NetworkScenarioProtocol: URLProtocol {
    static var scenario: NetworkScenario!
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "network.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        do {
            let (data, mime) = try Self.scenario.response(request)
            let url = Self.scenario.accessExpired ? URL(string: "https://test.cloudflareaccess.com/cdn-cgi/access/login")! : request.url!
            let status = Self.scenario.events502ThenReady && request.url!.path == "/api/events"
                && Self.scenario.count("/api/events") == 1 ? 502 : Self.scenario.httpStatus
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime])!
            client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client!.urlProtocol(self, didLoad: data)
            if !(Self.scenario.holdEventsOpen && request.url!.path == "/api/events" && status == 200) {
                client!.urlProtocolDidFinishLoading(self)
            }
        } catch { client!.urlProtocol(self, didFailWithError: error) }
    }
}
