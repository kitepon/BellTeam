import XCTest
@testable import BellBot

final class SecretTransportTests: XCTestCase {
    func testSecretSubmissionRejectsPublicHTTP() async {
        let api = BellAPI(baseURL: URL(string: "http://example.com:18443"))
        do {
            _ = try await api.finishSecretRequest(id: "example", value: "dummy")
            XCTFail("外部HTTPへの秘密情報送信を拒否する必要があります。")
        } catch BellAPIError.notConfigured { }
        catch { XCTFail("期待しないエラー: \(type(of: error))") }
    }

    func testSecretBodyDoesNotFollowRedirect() async throws {
        guard ProcessInfo.processInfo.environment["BELLTEAM_SECRET_SMOKE"] == "1" else {
            throw XCTSkip("秘密入力用のHTTPS試験サーバーが必要です。")
        }
        let api = BellAPI(baseURL: URL(string: "https://localhost:18443"))
        do {
            _ = try await api.finishSecretRequest(id: "redirect", value: "dummy")
            XCTFail("リダイレクトを拒否する必要があります。")
        } catch BellAPIError.httpStatus(let status, _) {
            XCTAssertEqual(status, 307)
        }
    }
}
