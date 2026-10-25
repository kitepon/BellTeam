import XCTest
import WebKit
@testable import BellBot

@MainActor
final class AuthSetupOrderingTests: XCTestCase {
    func testOldSetupReadCannotReplaceConfirmedResponse() async throws {
        let base = try fixtureURL()
        try await reset(base)
        let store = makeStore(base)
        try await store.refreshSetup(explicit: true)
        let ui = try XCTUnwrap(store.setup?.auth?.authUi)
        try await get(base, "/test/setup/hold")
        let oldRead = Task { try await store.refreshSetup() }
        var held = 0
        for _ in 0..<50 {
            held = try await proof(base).heldSetupReads
            if held == 1 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(held, 1)
        try await store.submitAuthResponse(.authorizationCode("TEST-RESPONSE"), for: ui)
        XCTAssertEqual(store.setup?.auth?.status, .authenticated)
        try await get(base, "/test/setup/release")
        try await oldRead.value
        XCTAssertEqual(store.setup?.auth?.status, .authenticated, "旧GETを新しいPOST結果の後に適用しない")
        let final = try await proof(base)
        XCTAssertEqual(final.setupWrites, 1)
    }

    func testUnknownResponseStopsAutomaticReadsAndRepeatInputUntilExplicitRefresh() async throws {
        let base = try fixtureURL()
        try await reset(base)
        let store = makeStore(base)
        try await store.refreshSetup(explicit: true)
        let ui = try XCTUnwrap(store.setup?.auth?.authUi)
        try await get(base, "/test/setup/next-unknown")
        do {
            try await store.submitAuthResponse(.authorizationCode("TEST-RESPONSE"), for: ui)
            XCTFail("結果不明を成功扱いしない")
        } catch BellAPIError.httpStatus(let status, _, _) { XCTAssertEqual(status, 502) }
        XCTAssertTrue(store.setupAuthNeedsRefresh)
        let before = try await proof(base)
        try await store.refreshSetup()
        let afterAutomatic = try await proof(base)
        XCTAssertEqual(afterAutomatic.setupReads, before.setupReads, "結果不明後の自動GETを止める")
        do {
            try await store.submitAuthResponse(.authorizationCode("TEST-RESPONSE"), for: ui)
            XCTFail("同じ入力を自動再送しない")
        } catch BellAPIError.server { }
        let afterRetry = try await proof(base)
        XCTAssertEqual(afterRetry.setupWrites, 1)
        try await store.refreshSetup(explicit: true)
        XCTAssertFalse(store.setupAuthNeedsRefresh)
        XCTAssertEqual(store.setup?.auth?.status, .authenticated)
    }

    private func makeStore(_ base: URL) -> AppStore {
        let api = BellAPI(baseURL: base, diagnostics: BellDiagnostics(onReport: { _, _, _, _ in }))
        return AppStore(api: api, webDataStore: .nonPersistent())
    }

    private func fixtureURL() throws -> URL {
        try XCTUnwrap(ProcessInfo.processInfo.environment["BELLTEAM_AUTH_TYPED_URL"].flatMap(URL.init(string:)))
    }

    private func reset(_ base: URL) async throws { try await get(base, "/test/reset") }

    private func get(_ base: URL, _ path: String) async throws {
        let (_, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: path, relativeTo: base)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func proof(_ base: URL) async throws -> Proof {
        let (data, _) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: "/test/proof", relativeTo: base)))
        return try JSONDecoder().decode(Proof.self, from: data)
    }

    private struct Proof: Decodable {
        private struct Write: Decodable { }
        let setupReads: Int
        let heldSetupReads: Int
        let setupWrites: Int

        private enum CodingKeys: String, CodingKey { case setupReads, heldSetupReads, setupWrites }
        init(from decoder: Decoder) throws {
            let value = try decoder.container(keyedBy: CodingKeys.self)
            setupReads = try value.decode(Int.self, forKey: .setupReads)
            heldSetupReads = try value.decode(Int.self, forKey: .heldSetupReads)
            setupWrites = try value.decode([Write].self, forKey: .setupWrites).count
        }
    }
}
