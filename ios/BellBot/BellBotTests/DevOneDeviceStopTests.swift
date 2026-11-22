#if DEBUG
import XCTest
@testable import BellBot

/// Live DEV run (Mint/Mika, a529m): the ONE-DEVICE stop from a phone proven on a home server. Skipped unless DEV_OPERATOR_URL and DEV_HOME_URL are set
/// (TEST_RUNNER_ prefix). Neon's Linux must be bound first (Mika says when). The simulator signs in at the operator (APPLE, default sub = Neon's),
/// joins the home server, lists /api/home/sessions, stop(passId) of the OTHER row only, then DELETE that session; prints the times.
@MainActor
final class DevOneDeviceStopTests: XCTestCase {
    private func stamp() -> String { ISO8601DateFormatter().string(from: Date()) }

    func testStopOneOtherDevice() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let operatorText = env["DEV_OPERATOR_URL"], let operatorURL = URL(string: operatorText), let homeText = env["DEV_HOME_URL"], let homeURL = URL(string: homeText) else { throw XCTSkip("no DEV_OPERATOR_URL / DEV_HOME_URL") }
        UserDefaults.standard.set(operatorText, forKey: "bellbot-dev-operator")
        let account = StoreAccount(baseURL: operatorURL.appending(path: "auth/v1"), productId: "dev.kitepon.bellbot.monthly")
        await account.signIn()
        XCTAssertTrue(account.signedIn, account.errorText ?? "not signed in")
        let home = try XCTUnwrap(account.home)
        let session = try await account.connectHome(homeURL, setupCode: nil, pushToken: nil)
        print("JOINED at \(stamp()) session state: \(session.state)")
        let listURL = homeURL.appending(path: "api/home/sessions")
        func list() async throws -> [[String: Any]] {
            var request = URLRequest(url: listURL)
            request.setValue(home.homeHeader(listURL), forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            return ((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["sessions"] as? [[String: Any]]) ?? []
        }
        let rows = try await list()
        print("ROWS: \(rows.map { "\($0["id"] ?? "?") kind=\($0["kind"] ?? "?") app=\($0["appKind"] ?? "?") passId=\(($0["passId"] as? String)?.prefix(8) ?? "-") current=\($0["current"] ?? "?")" })")
        let other = try XCTUnwrap(rows.first { ($0["current"] as? Bool) == false && $0["passId"] is String }, "no other row with a passId")
        let otherId = try XCTUnwrap(other["id"] as? String), otherPass = try XCTUnwrap(other["passId"] as? String)
        let t1 = stamp()
        try await account.devStop(passId: otherPass)
        print("STOP-PASSID at \(t1) (\(stamp()) done) for session \(otherId)")
        let deleteURL = homeURL.appending(path: "api/home/sessions/\(otherId)")
        var delete = URLRequest(url: deleteURL)
        delete.httpMethod = "DELETE"
        delete.setValue(home.homeHeader(deleteURL), forHTTPHeaderField: "Authorization")
        let t2 = stamp()
        let (_, response) = try await URLSession.shared.data(for: delete)
        print("DELETE at \(t2) -> \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let after = try await list()
        print("AFTER: own token still works, rows: \(after.map { "\($0["id"] ?? "?")" })")
        XCTAssertFalse(after.contains { ($0["id"] as? String) == otherId })
        XCTAssertTrue(after.contains { ($0["current"] as? Bool) == true })
    }
}
#endif
