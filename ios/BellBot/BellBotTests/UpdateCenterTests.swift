import XCTest
import SwiftUI
@testable import BellBot

/// サーバーの有限例13種（Fixtures/update-examples.json。test/apple-update-fixtures.test.mjsが同一性を守る）をdecodeする。
@MainActor
final class UpdateModelTests: XCTestCase {
    private static let names = ["running", "no_update", "published_unavailable", "incompatible", "restart_required", "accepted",
                                "disconnected_unknown", "execution_failed", "verified_completed",
                                "module_update", "module_rollback", "all_modules", "interrupted"]

    func testAllThirteenServerExamplesDecode() throws {
        let examples = try UpdateFixtures.examples()
        XCTAssertEqual(Set(examples.keys), Set(Self.names))
        for name in Self.names { _ = try UpdateFixtures.inventory(name) }
        XCTAssertTrue(try UpdateFixtures.inventory("restart_required").hasAvailableUpdate)
        XCTAssertFalse(try UpdateFixtures.inventory("no_update").hasAvailableUpdate)
        XCTAssertEqual(try UpdateFixtures.inventory("restart_required").plans[0].impact.containerRestart, true)
        XCTAssertEqual(try UpdateFixtures.inventory("module_rollback").plans[0].action, .rollback)
        XCTAssertNil(try UpdateFixtures.inventory("restart_required").plans[0].action)
        XCTAssertNil(try UpdateFixtures.inventory("all_modules").plans[0].componentId)
    }

    func testOnlyVerifiedCompletedIsSettledSuccess() throws {
        XCTAssertTrue(try XCTUnwrap(UpdateFixtures.inventory("verified_completed").operation).isCompleted)
        for name in ["accepted", "disconnected_unknown", "interrupted"] {
            let operation = try XCTUnwrap(UpdateFixtures.inventory(name).operation)
            XCTAssertFalse(operation.isCompleted, name)
            XCTAssertFalse(operation.isSettled, name)
        }
        XCTAssertTrue(try XCTUnwrap(UpdateFixtures.inventory("execution_failed").operation).isSettled)
    }

    func testUnknownEnumValueIsReadAsUnknownButAnUnknownSchemaIsRejected() throws {
        var example = try UpdateFixtures.examples()["restart_required"]!
        var components = example["components"] as! [[String: Any]]
        components[0]["comparison"] = ["state": "newer", "reason": NSNull()]
        example["components"] = components
        var plans = example["plans"] as! [[String: Any]]
        plans[0]["action"] = "migrate"
        example["plans"] = plans
        let inventory = try UpdateFixtures.decode(example)
        XCTAssertEqual(inventory.components[0].comparison.state, .unknown, "新しい値でも画面全体は読める")
        XCTAssertEqual(inventory.plans[0].action, .unknown)
        XCTAssertEqual(inventory.plans[0].$action, "migrate", "元の文字列も持つ")
        let wording = UpdateContent.planWording(inventory.plans[0])
        XCTAssertEqual(wording.button, "実行する", "未知の計画も確認すれば実行できる")
        XCTAssertTrue(wording.serverPlan?.contains("action: migrate") == true, "アプリで言い換えずサーバーの値を見せる")
        XCTAssertTrue(wording.serverPlan?.contains("containerRestart: true") == true)
        XCTAssertEqual(UpdateContent.planWording(try UpdateFixtures.inventory("module_rollback").plans[0]).button, "戻す")
        XCTAssertNil(UpdateContent.planWording(try UpdateFixtures.inventory("restart_required").plans[0]).serverPlan)
        example["schema"] = "bellteam.updates.v2"
        XCTAssertThrowsError(try UpdateFixtures.decode(example), "schemaの不一致は別契約なので応答不正")
    }

    func testMissingNullableKeyIsAnInvalidResponseButUnknownKeyIsIgnored() throws {
        var example = try UpdateFixtures.examples()["running"]!
        example["notificationCandidates"] = [["componentId": "notifications", "id": "x"]]
        XCTAssertNoThrow(try UpdateFixtures.decode(example))
        example.removeValue(forKey: "operation")
        XCTAssertThrowsError(try UpdateFixtures.decode(example))
    }
}

@MainActor
final class UpdateStoreTests: XCTestCase {
    private let operationID = "22222222-2222-4222-8222-222222222222"

    func testConfirmedExecuteSendsOneRequestWithAFreshSavedRequestID() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("GET", "/api/updates"): return .json(200, try UpdateFixtures.examples()["restart_required"]!)
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"):
                var operation = try UpdateFixtures.examples()["accepted"]!["operation"] as! [String: Any]
                operation["requestId"] = try request.json()["requestId"]
                return .json(202, ["operation": operation])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        await store.refresh()
        await store.makePlan(componentID: "container")
        let plan = try XCTUnwrap(store.plan)
        XCTAssertEqual(try UpdateProtocol.requests.last?.json() as? [String: String], ["scope": "component", "componentId": "container"])

        await store.execute(confirmContainerRestart: false)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0, "再起動の確認なしでは送らない")

        await store.execute(confirmContainerRestart: true)
        let body = try XCTUnwrap(UpdateProtocol.requests.last { $0.path == "/api/updates/operations" }).json()
        let requestID = try XCTUnwrap(body["requestId"] as? String)
        XCTAssertNotNil(requestID.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", options: .regularExpression))
        XCTAssertEqual(body["planId"] as? String, plan.planId)
        XCTAssertEqual(body["confirmContainerRestart"] as? Bool, true)
        XCTAssertEqual(store.requestID, requestID)
        XCTAssertEqual(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"), requestID)
        XCTAssertNil(store.plan)

        await store.execute(confirmContainerRestart: true)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1, "結果が確定するまで再送しない")
    }

    func testConflictAsksForANewPlanWithoutReplanningOrResending() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .json(409, ["error": "UPDATE_PLAN_STALE"])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        await store.makePlan(componentID: nil)
        let planID = try XCTUnwrap(store.plan?.planId)
        await store.execute(confirmContainerRestart: true)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("再計画が必要"))
        XCTAssertNil(store.plan)
        XCTAssertNil(store.requestID)
        XCTAssertNil(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"))
        // 未受付と表示しても、要求ID・計画IDは消さずに残す。
        let kept = try XCTUnwrap(store.history.first)
        XCTAssertEqual(kept.planId, planID)
        XCTAssertEqual(store.history.count, 1)
        XCTAssertNotNil(defaults.data(forKey: "bellbot.updateRequestHistory.https://update.test.invalid"))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/plans"), 1)
        XCTAssertEqual(try UpdateProtocol.requests.first?.json() as? [String: String], ["scope": "all"])
        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(kept.requestId)"), 1, "同じIDで照会し直す")
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
        XCTAssertEqual(store.history.count, 1)
    }

    func testSavedRequestIDIsQueriedAndOnlyVerifiedCompletionClearsIt() async throws {
        var answer = "disconnected_unknown"
        let operationID = self.operationID
        let (store, defaults) = try makeStore { request in
            switch request.path {
            case "/api/updates": return .json(200, try UpdateFixtures.examples()["running"]!)
            case "/api/updates/operations/\(operationID)":
                return .json(200, ["operation": try UpdateFixtures.examples()[answer]!["operation"]!])
            default: return .json(404, ["error": "NOT_FOUND"])
            }
        }
        let key = "bellbot.updateRequestID.https://update.test.invalid"
        defaults.set(operationID, forKey: key)
        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(operationID)"), 1)
        XCTAssertEqual(store.operation?.phase, .unknown)
        XCTAssertEqual(store.requestID, operationID, "unknownは消さない")
        XCTAssertEqual(defaults.string(forKey: key), operationID)

        answer = "verified_completed"
        await store.refresh()
        XCTAssertEqual(store.operation?.isCompleted, true)
        XCTAssertNil(store.requestID)
        XCTAssertNil(defaults.string(forKey: key))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0)
    }

    func testDisconnectionKeepsTheRequestUnconfirmedWithoutResending() async throws {
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["accepted"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .fail(.notConnectedToInternet)
            case ("GET", "/api/updates"): return .json(200, try UpdateFixtures.examples()["accepted"]!)
            default: return .fail(.notConnectedToInternet)
            }
        }
        await store.makePlan(componentID: "container")
        await store.execute(confirmContainerRestart: true)
        let requestID = try XCTUnwrap(store.requestID)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("確認中"))
        XCTAssertNil(store.operation)

        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(requestID)"), 1)
        XCTAssertEqual(store.requestID, requestID)
        XCTAssertNil(store.operation, "照会できない間に成功を補わない")
        XCTAssertEqual(defaults.string(forKey: "bellbot.updateRequestID.https://update.test.invalid"), requestID)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
    }

    func testNotFoundDoesNotClearTheSavedRequestAndQueriesItAgain() async throws {
        let operationID = self.operationID
        let (store, defaults) = try makeStore { request in
            request.path == "/api/updates" ? .json(200, try UpdateFixtures.examples()["running"]!) : .json(404, ["error": "UPDATE_OPERATION_NOT_FOUND"])
        }
        let key = "bellbot.updateRequestID.https://update.test.invalid"
        defaults.set(operationID, forKey: key)
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(operationID)"), 2, "同じUUIDで照会し直せる")
        XCTAssertEqual(store.requestID, operationID, "404だけでは未受付と確定しない")
        XCTAssertEqual(defaults.string(forKey: key), operationID)
        XCTAssertNil(store.operation)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("確認できません"))
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0)
    }

    func testNewExecutionKeepsTheUnconfirmedRequestInHistory() async throws {
        let operationID = self.operationID
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .fail(.notConnectedToInternet)
            case ("GET", "/api/updates"): return .json(200, try UpdateFixtures.examples()["restart_required"]!)
            default: return .fail(.notConnectedToInternet)
            }
        }
        defaults.set(operationID, forKey: "bellbot.updateRequestID.https://update.test.invalid")
        await store.refresh()
        await store.makePlan(componentID: nil)
        await store.execute(confirmContainerRestart: true)
        let newID = try XCTUnwrap(store.requestID)
        XCTAssertNotEqual(newID, operationID)
        XCTAssertEqual(store.history.map(\.requestId), [operationID], "前の要求は消さずに残す")
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1)
        await store.refresh()
        XCTAssertGreaterThanOrEqual(UpdateProtocol.count(method: "GET", path: "/api/updates/operations/\(operationID)"), 2)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1, "自動で再送しない")
    }

    func testTheSameUnconfirmedPlanIsNotExecutedAgain() async throws {
        let (store, _) = try makeStore { request in
            switch (request.method, request.path) {
            case ("POST", "/api/updates/plans"):
                return .json(200, ["plan": (try UpdateFixtures.examples()["restart_required"]!["plans"] as! [[String: Any]])[0]])
            case ("POST", "/api/updates/operations"): return .fail(.notConnectedToInternet)
            default: return .fail(.notConnectedToInternet)
            }
        }
        await store.makePlan(componentID: nil)
        await store.execute(confirmContainerRestart: true)
        let first = try XCTUnwrap(store.requestID)
        await store.execute(confirmContainerRestart: true)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1, "同じ未確定の計画は再実行しない")
        XCTAssertEqual(store.requestID, first)
        XCTAssertTrue(try XCTUnwrap(store.message).contains("同じ計画では実行しません"))
    }

    func testInterruptedRequestAllowsAnotherPlanButNotTheSamePlanAgain() async throws {
        let interrupted = try UpdateFixtures.examples()["interrupted"]!
        let operation = try XCTUnwrap(interrupted["operation"] as? [String: Any])
        let samePlan = try XCTUnwrap(operation["plan"] as? [String: Any])
        var anotherPlan = samePlan; anotherPlan["planId"] = "33333333-3333-4333-8333-333333333333"
        var planned = samePlan
        let (store, defaults) = try makeStore { request in
            switch (request.method, request.path) {
            case ("GET", "/api/updates"): return .json(200, interrupted)
            case ("GET", _): return .json(200, ["operation": operation])
            case ("POST", "/api/updates/plans"): return .json(200, ["plan": planned])
            default: return .fail(.notConnectedToInternet)
            }
        }
        defaults.set(operation["requestId"] as? String, forKey: "bellbot.updateRequestID.https://update.test.invalid")
        defaults.set(samePlan["planId"] as? String, forKey: "bellbot.updateRequestPlanID.https://update.test.invalid")
        await store.refresh()
        XCTAssertEqual(store.operation?.admission, .accepted)
        XCTAssertEqual(store.operation?.phase, .unknown)
        XCTAssertTrue(store.canStartPlan, "受け付け済みでも状態が分からない要求は、新しい計画を止めない")

        await store.makePlan(componentID: "notifications")
        await store.execute(confirmContainerRestart: false)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 0, "同じ未確定の計画は再実行しない")

        planned = anotherPlan
        await store.makePlan(componentID: "notifications")
        await store.execute(confirmContainerRestart: false)
        XCTAssertEqual(UpdateProtocol.count(method: "POST", path: "/api/updates/operations"), 1, "別の計画は明示的に一回実行できる")
        XCTAssertEqual(store.history.map(\.requestId), [operation["requestId"] as? String].compactMap { $0 }, "前の要求は照会できるまま残す")
    }

    func testInventoryWithAnUnknownSchemaIsShownAsAnInvalidResponse() async throws {
        let (store, _) = try makeStore { _ in
            var example = try UpdateFixtures.examples()["running"]!
            example["schema"] = "bellteam.updates.v2"
            return .json(200, example)
        }
        await store.refresh()
        XCTAssertNil(store.inventory)
        XCTAssertEqual(store.failure, "更新情報の応答形式を確認できません。")
    }

    private func makeStore(_ handler: @escaping (UpdateProtocol.Request) throws -> UpdateProtocol.Reply) throws -> (UpdateStore, UserDefaults) {
        UpdateProtocol.reset(handler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://update.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let suite = "update-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return (UpdateStore(api: api, defaults: defaults), defaults)
    }
}

/// Update画面の標準表示。状態ごとの見出しと、実画面の画像（試験結果に添付）を確かめる。
@MainActor
final class UpdateViewTests: XCTestCase {
    func testEachServerStateShowsOneSimpleStatus() async throws {
        let expected = ["restart_required": "更新があります", "no_update": "最新の状態です", "verified_completed": "更新しました",
                        "disconnected_unknown": "更新の結果を確認中", "execution_failed": "更新できませんでした",
                        "accepted": "更新しています", "published_unavailable": "更新を確認できませんでした"]
        for (name, title) in expected.sorted(by: { $0.key < $1.key }) {
            let store = try await store(for: name)
            let content = UpdateContent(updates: store)
            XCTAssertEqual(content.heroText.1, title, name)
            for width in [390.0, 820.0] {
                let renderer = ImageRenderer(content: content.background(BellTheme.canvas).frame(width: width))
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage, name)
                let attachment = XCTAttachment(image: image)
                attachment.name = "update-\(name)-\(Int(width))"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    func testUpdateBadgeIsIconOnlyAndKeepsNarrowSidebarTitleOnOneLine() async throws {
        let store = try await store(for: "restart_required")
        XCTAssertEqual(store.inventory?.hasAvailableUpdate, true)
        let badge = ImageRenderer(content: UpdateBadge(updates: store) {})
        let size = try XCTUnwrap(badge.uiImage).size
        XCTAssertLessThanOrEqual(max(size.width, size.height), 36, "見える文字を外したアイコンだけの入口")
        // DesktopWorkspaceView.sidebarのheaderと同じ並びを、iPadのsidebarの最小幅と標準幅で描く。
        for width in [230.0, 270.0] {
            let header = HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(BellTheme.violet).font(.title2)
                Text("BellTeam").font(.system(size: 22, weight: .bold, design: .rounded)).fixedSize()
                UpdateBadge(updates: store) {}
                Spacer()
                Image(systemName: "plus.circle").font(.title3)
            }
            .padding(20).frame(width: width).background(BellTheme.canvas)
            let renderer = ImageRenderer(content: header)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertLessThanOrEqual(image.size.height, 80, "タイトルも入口も追加ボタンも一行のまま")
            let attachment = XCTAttachment(image: image)
            attachment.name = "update-badge-sidebar-\(Int(width))"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testJobsAndProblemsAreShownAsStoredAndMergedOncePerJob() async throws {
        let job: (String, String, Any) -> [String: Any] = { id, state, reason in
            ["schema": "bellteam.update-job.v1", "jobId": id, "idempotencyKey": id, "kind": "module",
             "target": ["catalogSha256": NSNull(), "moduleId": "notifications", "versionId": "builtin"],
             "state": state, "reason": reason, "transitions": [], "updatedAtNs": "1793974459000000000"]
        }
        let running = job("11111111-1111-4111-8111-111111111111", "swapping", NSNull())
        let failed = job("22222222-2222-4222-8222-222222222222", "failed", ["code": "READY_TIMEOUT", "message": "ready probe timed out"])
        var example = try XCTUnwrap(try UpdateFixtures.examples()["running"])
        example["jobs"] = [running, failed]
        example["problems"] = [["fingerprint": "fp-1", "status": "open", "kind": "module_restart_limit", "moduleId": "notifications",
                                "count": 5, "windowSeconds": 1800, "lastExit": ["code": NSNull(), "signal": "SIGKILL"], "lastReason": "process_exit"]]
        var operation = try XCTUnwrap(example["operation"] as? [String: Any])
        operation["admission"] = "pending"; operation["jobs"] = [running]; example["operation"] = operation
        let store = try await store(json: example)
        let inventory = try XCTUnwrap(store.inventory, "jobs・problems・admission pendingを含む応答を読める")
        XCTAssertEqual(inventory.operation?.admission, .pending)
        XCTAssertEqual(inventory.jobs?.map(\.state), [.swapping, .failed])
        XCTAssertEqual(inventory.problems?.first?.lastExit.signal, "SIGKILL")
        let content = UpdateContent(updates: store)
        XCTAssertEqual(content.jobRecords.map(\.jobId), [running["jobId"] as! String, failed["jobId"] as! String], "同じジョブは1回だけ")
        XCTAssertEqual(content.jobRecords.last?.reason?.code, "READY_TIMEOUT")

        var unknownState = example
        unknownState["jobs"] = [job("33333333-3333-4333-8333-333333333333", "paused", NSNull())]
        let lenient = try await self.store(json: unknownState)
        XCTAssertEqual(lenient.inventory?.jobs?.first?.state, .unknown, "6つ以外の状態はunknownとして読み、画面全体は読める")
        XCTAssertNil(lenient.failure)
    }

    func testPartStatusLineReplacesTheJobListOnlyWhenTheServerSendsIt() async throws {
        var example = try XCTUnwrap(try UpdateFixtures.examples()["running"])
        let plain = try await store(json: example)
        XCTAssertTrue(UpdateContent(updates: plain).partStatuses.isEmpty, "statusの無い旧サーバーは今までの表示")
        var components = try XCTUnwrap(example["components"] as? [[String: Any]])
        let line = "最初から入っている版を使っています。11/8 10:06 の更新はできませんでした。元の版のまま動いています。対応は不要です。"
        components[0]["status"] = ["line": line, "tone": "attention", "actionRequired": true, "action": "設定を確認してください。",
                                   "latestJob": ["jobId": "33333333-3333-4333-8333-333333333333", "kind": "runtime", "state": "failed",
                                                 "outcome": "failed", "at": "2026-11-08T01:06:00Z",
                                                 "reason": ["code": "READY_TIMEOUT", "message": "ready probe timed out"]]]
        example["components"] = components
        let content = UpdateContent(updates: try await store(json: example))
        XCTAssertEqual(content.partStatuses.first?.status.line, line, "サーバーの文をそのまま持つ")
        XCTAssertEqual(content.partStatuses.first?.status.action, "設定を確認してください。")
        XCTAssertEqual(content.partStatuses.first?.status.latestJob?.reason?.code, "READY_TIMEOUT")

        // 未知のtoneの機能だけ従来表示に戻し、他の機能と画面全体は読める。
        var other = components[0]
        other["id"] = "notifications"
        components[0]["status"] = ["line": line, "tone": "loud", "actionRequired": false, "action": NSNull(), "latestJob": NSNull()]
        components.append(other)
        example["components"] = components
        let lenient = try await store(json: example)
        let inventory = try XCTUnwrap(lenient.inventory, "未知の値を含むstatusでも在庫全体は読める")
        XCTAssertNil(inventory.components[0].status)
        XCTAssertEqual(UpdateContent(updates: lenient).partStatuses.map(\.component.id), ["notifications"])
    }

    func testUnconfirmedRequestKeepsCheckingButOffersAnotherFormalCandidate() async throws {
        var interrupted = try XCTUnwrap(try UpdateFixtures.examples()["interrupted"])
        let plain = try await store(for: "interrupted")
        XCTAssertEqual(UpdateContent(updates: plain).heroText.1, "更新の結果を確認中")
        XCTAssertFalse(UpdateContent(updates: plain).offersAnotherPlan, "正式な候補が無ければ出さない")

        var components = try XCTUnwrap(interrupted["components"] as? [[String: Any]])
        components[0]["comparison"] = ["state": "update_available", "reason": NSNull()]
        components[0]["capability"] = ["supported": true, "reason": NSNull()]
        interrupted["components"] = components
        let store = try await store(json: interrupted)
        let content = UpdateContent(updates: store)
        XCTAssertEqual(content.heroText.1, "更新の結果を確認中", "主操作は状況の確認のまま")
        XCTAssertTrue(store.canStartPlan)
        XCTAssertTrue(content.offersAnotherPlan, "別の正式な候補は利用者が選べる")
        XCTAssertEqual(UpdateProtocol.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testRejectionCodesStayInDetailsNotOnTheStandardScreen() async throws {
        let store = try await store(json: try XCTUnwrap(try UpdateFixtures.examples()["restart_required"]),
                                    plan: .json(409, ["error": "UPDATE_PLAN_STALE", "message": "UPDATE_PLAN_STALE: plan changed"]))
        await store.makePlan(componentID: "container")
        let raw = try XCTUnwrap(store.message)
        XCTAssertTrue(raw.contains("UPDATE_PLAN_STALE"), "元の説明はそのまま保持して詳細に出す")
        let content = UpdateContent(updates: store)
        XCTAssertFalse(try XCTUnwrap(content.heroNote).contains("UPDATE_"))
        XCTAssertFalse(content.heroText.2.contains("UPDATE_"))

        let failed = UpdateContent(updates: try await self.store(for: "execution_failed"))
        XCTAssertEqual(failed.heroText.1, "更新できませんでした")
        XCTAssertFalse(failed.heroText.2.contains("UPDATE_"))
        XCTAssertFalse(failed.heroText.2.contains("更新処理が失敗しました"), "サーバーの元の説明は詳細へ")
    }

    private func store(for name: String) async throws -> UpdateStore {
        try await store(json: try XCTUnwrap(try UpdateFixtures.examples()[name]))
    }

    private func store(json example: [String: Any], plan: UpdateProtocol.Reply? = nil) async throws -> UpdateStore {
        UpdateProtocol.reset { request in
            if request.path == "/api/updates" { return .json(200, example) }
            if request.method == "POST", request.path == "/api/updates/plans", let plan { return plan }
            return .json(404, ["error": "NOT_FOUND"])
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let api = BellAPI(baseURL: URL(string: "https://update.test.invalid")!, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let suite = "update-view-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let store = UpdateStore(api: api, defaults: defaults)
        await store.refresh()
        return store
    }
}

/// SSEの`updates`、kind=updateの通知、タップ。AppStoreの経路を通す。
@MainActor
final class UpdateNotificationTests: XCTestCase {
    private func userInfo(_ overrides: [String: Any] = [:], removing: String? = nil) -> [AnyHashable: Any] {
        var value: [String: Any] = ["server": "https://update.test.invalid", "kind": "update", "messageId": String(repeating: "a", count: 64)]
        for (key, item) in overrides { value[key] = item }
        if let removing { value.removeValue(forKey: removing) }
        return ["bellteam": value, "aps": ["alert": "更新"]]
    }

    func testOnlyTheExactThreeKeysAreAccepted() {
        XCTAssertNotNil(BellUpdateRoute(userInfo: userInfo()))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["botId": "bot-a"])), "余分なkey")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(removing: "messageId")))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": 12])), "型違い")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": String(repeating: "A", count: 64)])), "大文字")
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["messageId": String(repeating: "a", count: 63)])))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["kind": "reply"])))
        XCTAssertNil(BellUpdateRoute(userInfo: userInfo(["server": 1])))
        XCTAssertNil(BellNotificationRoute(userInfo: userInfo()), "既存の解析はkind=updateを受けない")
    }

    func testEventTypeUpdatesIsNotAFullRefresh() {
        let event = BellEvent(payload: ["at": "2026-11-04T00:00:00Z", "topics": ["updates"], "botIds": [], "roomIds": [], "type": "updates", "all": true],
                              eventName: "messages")
        XCTAssertEqual(event.type, "updates")
    }

    func testUpdatesEventReadsOnlyTheInventory() async throws {
        let store = makeAppStore { request in
            if request.path == "/api/events" { return .stream("event: messages\ndata: {\"type\":\"updates\",\"topics\":[\"updates\"],\"botIds\":[],\"roomIds\":[],\"all\":true}\n\n") }
            if request.path == "/api/updates" { return .json(200, try UpdateFixtures.examples()["restart_required"]!) }
            return .json(404, ["error": "NOT_FOUND"])
        }
        store.startEvents()
        defer { store.stopEvents() }
        await until { store.updates.inventory != nil }
        XCTAssertEqual(store.updates.inventory?.hasAvailableUpdate, true)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates"), 1)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/bots"), 0)
    }

    func testTapOpensUpdateAndReadsWithoutAnyPost() async throws {
        let store = makeAppStore { request in
            request.path == "/api/updates" ? .json(200, try UpdateFixtures.examples()["restart_required"]!) : .json(404, ["error": "NOT_FOUND"])
        }
        store.phase = .ready
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo())))
        await until { store.updates.inventory != nil }
        XCTAssertTrue(store.updatePresented)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates"), 1)
        XCTAssertEqual(UpdateProtocol.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testTapForAnotherServerOpensNothingAndCallsNothing() async throws {
        let store = makeAppStore { _ in .json(404, ["error": "NOT_FOUND"]) }
        store.phase = .ready
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo(["server": "https://other.example"]))))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(store.updatePresented)
        XCTAssertTrue(UpdateProtocol.requests.isEmpty)
        XCTAssertEqual(store.pendingUpdateNotification?.server, "https://other.example", "開かずに1件だけ残す")
    }

    func testPendingTapForAnotherServerOpensOnlyAfterTheUserSwitchesThere() async throws {
        let defaults = UserDefaults.standard, previous = defaults.string(forKey: "bellbot.serverURL")
        addTeardownBlock { defaults.set(previous, forKey: "bellbot.serverURL") }
        let store = makeAppStore(baseURL: URL(string: "https://other.example")!) { request in
            request.path == "/api/updates" ? .json(200, try UpdateFixtures.examples()["restart_required"]!) : .json(404, ["error": "NOT_FOUND"])
        }
        store.phase = .ready
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo())))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(store.updatePresented, "受信やタップで自動で切り替えない")
        XCTAssertTrue(UpdateProtocol.requests.isEmpty)

        // 利用者が明示的にその接続先へ切り替え、認証してreadyになった後だけ開く。
        try await store.setServerAddress("https://update.test.invalid")
        store.phase = .ready
        await store.openPendingUpdateNotification()
        XCTAssertTrue(store.updatePresented)
        XCTAssertNil(store.pendingUpdateNotification)
        XCTAssertEqual(UpdateProtocol.count(method: "GET", path: "/api/updates"), 1)
        XCTAssertEqual(UpdateProtocol.requests.filter { $0.method == "POST" }.count, 0)
    }

    func testTapBeforeReadyWaitsInsteadOfConnecting() async throws {
        let store = makeAppStore { _ in .json(404, ["error": "NOT_FOUND"]) }
        store.phase = .signIn
        BellNotifications.shared.onOpenUpdate?(try XCTUnwrap(BellUpdateRoute(userInfo: userInfo())))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(store.updatePresented)
        XCTAssertTrue(UpdateProtocol.requests.isEmpty)
    }

    private func makeAppStore(baseURL: URL = URL(string: "https://update.test.invalid")!,
                              _ handler: @escaping (UpdateProtocol.Request) throws -> UpdateProtocol.Reply) -> AppStore {
        UpdateProtocol.reset(handler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateProtocol.self]
        let session = URLSession(configuration: configuration)
        let api = BellAPI(baseURL: baseURL, session: session,
                          diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }), cookieStorage: configuration.httpCookieStorage!)
        let previousOpen = BellNotifications.shared.onOpen, previousUpdate = BellNotifications.shared.onOpenUpdate
        addTeardownBlock {
            session.invalidateAndCancel()
            BellNotifications.shared.onOpen = previousOpen
            BellNotifications.shared.onOpenUpdate = previousUpdate
            UserDefaults.standard.removeObject(forKey: "bellbot.updateRequestID.https://update.test.invalid")
            UserDefaults.standard.removeObject(forKey: "bellbot.updateRequestPlanID.https://update.test.invalid")
            UserDefaults.standard.removeObject(forKey: "bellbot.updateRequestHistory.https://update.test.invalid")
        }
        return AppStore(api: api, webDataStore: .nonPersistent())
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<80 where !condition() { try? await Task.sleep(for: .milliseconds(50)) }
    }
}

private enum UpdateFixtures {
    static func examples() throws -> [String: [String: Any]] {
        let url = try XCTUnwrap(Bundle(for: UpdateModelTests.self).url(forResource: "update-examples", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [String: Any]])
    }

    static func decode(_ value: [String: Any]) throws -> UpdateInventory {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UpdateInventory.self, from: JSONSerialization.data(withJSONObject: value))
    }

    static func inventory(_ name: String) throws -> UpdateInventory {
        try decode(XCTUnwrap(examples()[name]))
    }
}

private final class UpdateProtocol: URLProtocol {
    struct Request {
        let method: String, path: String, body: Data
        func json() throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any]) }
    }
    enum Reply { case json(Int, Any), fail(URLError.Code), stream(String) }

    private static let lock = NSLock()
    private static var handler: ((Request) throws -> Reply)?
    private static var recorded: [Request] = []

    static func reset(_ handler: @escaping (Request) throws -> Reply) {
        lock.lock(); self.handler = handler; recorded = []; lock.unlock()
    }
    static var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
    static func count(method: String, path: String) -> Int { requests.filter { $0.method == method && $0.path == path }.count }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "update.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        let item = Request(method: request.httpMethod ?? "GET", path: request.url!.path, body: body)
        Self.lock.lock()
        Self.recorded.append(item)
        let handler = Self.handler
        Self.lock.unlock()
        do {
            switch try handler!(item) {
            case .fail(let code): client!.urlProtocol(self, didFailWithError: URLError(code))
            case .json(let status, let value):
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client!.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: value))
                client!.urlProtocolDidFinishLoading(self)
            case .stream(let text):
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
                client!.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client!.urlProtocol(self, didLoad: Data(text.utf8))
            }
        } catch { client!.urlProtocol(self, didFailWithError: error) }
    }
}
