#if DEBUG
import Foundation
import LoginBilling
@_spi(Testing) import LoginBilling
import XCTest
@testable import BellBot

/// Live DEV run against approval-box's local dev server (packages/server dev.ts, 127.0.0.1 only; approval-box docs/architecture/peer-channel-adoption.md section 8).
/// Skipped unless PEER_DEV_URL is set (xcodebuild: TEST_RUNNER_PEER_DEV_URL=http://127.0.0.1:8788). The web browser step cannot run in a test, so the pass comes from the dev server's fake
/// sign-in (dev-person, Apple) through the library's Testing seam into the same pass store the app's ApprovalBoxLink reads; everything after the pass is the app's own code.
/// Phase "admit": a registry made by the lab approver (dev:approve) exists. The link must say NeedsApproval, show its code (written to PEER_CODE_FILE), be admitted by `npm run dev:admit`,
/// become Live, receive a request filed through the connector, and answer it (the connector's own answer line says answered).
@MainActor
final class ApprovalBoxLiveTests: XCTestCase {
    private func post(_ base: URL, _ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var r = URLRequest(url: base.appending(path: path)); r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type"); r.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (d, resp) = try await URLSession.shared.data(for: r)
        XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 200, String(decoding: d, as: UTF8.self))
        return (try JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }

    private func wait(_ what: String, seconds: Double = 60, _ condition: () -> Bool) async {
        var left = seconds * 10
        while !condition() && left > 0 { try? await Task.sleep(nanoseconds: 100_000_000); left -= 1 }
        XCTAssertTrue(condition(), what)
    }

    func testAdmitAndAnswerAgainstTheLocalDevServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let text = env["PEER_DEV_URL"], let base = URL(string: text) else { throw XCTSkip("no PEER_DEV_URL") }
        let codeFile = env["PEER_CODE_FILE"] ?? "/tmp/bellbot-peer-code.txt"
        let passes = InMemoryPassStore()
        let client = try LoginBillingClient(baseURL: base.appending(path: "auth/v1"), store: passes)
        try await client.signIn(deviceLabel: "BellBot live test") { nonce in
            try await self.post(base, "dev/id-token", ["provider": "apple", "nonce": nonce, "sub": "dev-person"])["id_token"] as! String
        }
        let history = FileManager.default.temporaryDirectory.appending(path: "bellbot-peer-live-\(UUID().uuidString)")
        let link = ApprovalBoxLink(origin: base, passStore: passes, deviceStore: PeerDeviceStore(service: "dev.kitepon.bellbot.approval-box.peer.live.\(UUID().uuidString)"), historyRoot: history)
        defer { link.stopForTest() }
        await link.start()
        defer { if let d = link.lastFailureDetail { print("LIVE last failure: \(d)") } }
        await wait("NeedsApproval") { if case .needsApproval = link.state { true } else { false } }
        let asking = Task { await link.askForApproval() }  // returns only when admitted
        defer { asking.cancel() }
        await wait("Waiting") { if case .waiting = link.state { true } else { false } }
        guard case .waiting(let code, _, _) = link.state else { return XCTFail("not waiting: \(link.state)") }
        try code.replacingOccurrences(of: " ", with: "").write(toFile: codeFile, atomically: true, encoding: .utf8)
        print("LIVE waiting for dev:admit, code \(code)")
        await wait("Live after dev:admit", seconds: 240) { link.state == .live }
        print("LIVE state live at \(Date())")
        await wait("a request arrives", seconds: 180) { link.decisions.contains { $0.canAnswer } }
        let request = try XCTUnwrap(link.decisions.first { $0.canAnswer })
        print("LIVE request '\(request.title)' options \(request.options.map(\.id))")
        let outcome = try await link.answer(request.id, optionId: request.options[0].id, text: nil)
        XCTAssertEqual(outcome, .accepted)
        await wait("the history says answered") { link.decisions.first { $0.id == request.id }?.status == "answered" }
        print("LIVE answered \(request.id) with \(request.options[0].id)")
    }
}
#endif
