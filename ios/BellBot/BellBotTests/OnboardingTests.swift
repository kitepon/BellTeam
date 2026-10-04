import XCTest
@testable import BellBot

final class OnboardingTests: XCTestCase {
    func testHTTPSAndLocalHTTPOrigins() {
        for address in ["https://team.example.com", "http://localhost:18891", "http://bellteam:18891", "http://team.local:18891", "http://192.168.1.2:18891", "http://10.1.2.3", "http://172.31.2.3", "http://127.0.0.1", "http://[::1]:18891", "http://[fd00::1]:18891", "http://[fe80::1]:18891"] {
            XCTAssertNotNil(ServerOrigin.url(address), address)
            XCTAssertNotNil(BotAvatarCache.origin(address), address)
        }
        for address in ["http://example.com", "http://8.8.8.8", "http://172.32.1.2", "https://user:password@example.com", "https://example.com/api", "ftp://localhost"] {
            XCTAssertNil(ServerOrigin.url(address), address)
        }
    }

    func testSetupDecodesOfficialAuthenticationAndGuide() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let data = Data(#"{"phase":"authenticate","harness":"codex","harnesses":[{"id":"codex","name":"Codex"}],"guideBotId":"bot-guide","complete":false,"auth":{"status":"waiting","url":"https://example.com/login","user_code":"ABCD","input_required":true,"message":"公式サイトで認証してください"}}"#.utf8)
        let setup = try decoder.decode(SetupResponse.self, from: data)
        XCTAssertEqual(setup.guideBotId, "bot-guide")
        XCTAssertEqual(setup.auth?.userCode, "ABCD")
        XCTAssertEqual(setup.auth?.inputRequired, true)
        XCTAssertFalse(setup.complete)
    }

    func testSessionDistinguishesLocalAndCloudflareAuthentication() throws {
        let local = try JSONDecoder().decode(SessionResponse.self, from: Data(#"{"authenticated":true,"authMode":"local"}"#.utf8))
        let external = try JSONDecoder().decode(SessionResponse.self, from: Data(#"{"authenticated":false,"authMode":"cloudflare"}"#.utf8))
        XCTAssertTrue(local.authenticated)
        XCTAssertEqual(local.authMode, "local")
        XCTAssertFalse(external.authenticated)
        XCTAssertEqual(external.authMode, "cloudflare")
    }

    func testAuthenticationInputsAndSettingsRejectPublicHTTP() async {
        let api = BellAPI(baseURL: URL(string: "http://example.com"))
        do {
            _ = try await api.submitAuthenticationInput(AuthInput(text: "dummy", key: nil))
            XCTFail("外部HTTPへ認証情報を送信してはいけません。")
        } catch BellAPIError.notConfigured { }
        catch { XCTFail("期待しないエラー: \(type(of: error))") }
        do {
            _ = try await api.updateSetting(id: "routing", body: FeatureSettingUpdate(enabled: true, values: ["apiKey": "dummy"]))
            XCTFail("外部HTTPへ秘密の設定を送信してはいけません。")
        } catch BellAPIError.notConfigured { }
        catch { XCTFail("期待しないエラー: \(type(of: error))") }
    }

    func testFeatureErrorsRemainVisibleForEnabledSettings() throws {
        let data = Data(#"{"settings":[{"id":"notifications","title":"通知","enabled":true,"status":"enabled","fields":[],"error":{"code":"RELAY_CONNECT_FAILED","message":"通知送信サービスへ接続できませんでした。"}},{"id":"routing","title":"自動選択","enabled":false,"status":"unconfigured","fields":[]}]}"#.utf8)
        let response = try JSONDecoder().decode(FeatureSettingsResponse.self, from: data)
        XCTAssertTrue(response.settings[0].enabled)
        XCTAssertEqual(response.settings[0].status, "enabled")
        XCTAssertEqual(response.settings[0].statusText, "反映エラー")
        XCTAssertEqual(response.settings[0].error?.code, "RELAY_CONNECT_FAILED")
        XCTAssertEqual(response.settings[0].error?.message, "通知送信サービスへ接続できませんでした。")
        XCTAssertNil(response.settings[1].error)
        XCTAssertEqual(response.settings[1].statusText, "未設定")
    }

    func testLocalNotificationKeepsOriginAndTarget() throws {
        let route = try XCTUnwrap(BellNotificationRoute(userInfo: ["bellteam": [
            "server": "http://192.168.1.2:18891", "kind": "reply", "botId": "bot-guide"
        ]]))
        XCTAssertEqual(route.target, .bot("bot-guide"))
        XCTAssertTrue(route.belongs(to: URL(string: "http://192.168.1.2:18891/")))
        XCTAssertFalse(route.belongs(to: URL(string: "http://192.168.1.3:18891")))
    }
}
