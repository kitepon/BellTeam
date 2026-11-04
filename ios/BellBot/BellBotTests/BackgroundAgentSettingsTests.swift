import Foundation
import XCTest
@testable import BellBot

/// ミカの公開契約v1（背景の要約AIの設定）の合成fixtureで、読取・保存本文・候補の判定を確かめる。
final class BackgroundAgentSettingsTests: XCTestCase {
    func testSettingsDistinguishUnsupportedServerFromUnconfiguredAndConfigured() throws {
        let decode = { (json: String) in try JSONDecoder().decode(FeatureSettingsResponse.self, from: Data(json.utf8)) }
        XCTAssertNil(try decode(#"{"settings":[]}"#).backgroundAgent, "旧版は設定不可。未設定扱いにしない")
        XCTAssertEqual(try decode(#"{"settings":[],"backgroundAgent":{"revision":null,"selection":null}}"#).backgroundAgent,
                       BackgroundAgentRecord(revision: nil, selection: nil))
        let configured = try decode(#"""
        {"settings":[],"backgroundAgent":{"revision":"11111111-1111-4111-8111-111111111111",
         "selection":{"harness":"codex","model":"gpt-6.1-sol","reasoningEffort":"high"}}}
        """#).backgroundAgent
        XCTAssertEqual(configured?.selection, BackgroundAgentSelection(harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high"))
    }

    func testUpdateSendsExactlyFourKeysWithExplicitNullRevision() throws {
        let body = BackgroundAgentUpdate(expectedRevision: nil,
                                         selection: BackgroundAgentSelection(harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["expectedRevision", "harness", "model", "reasoningEffort"])
        XCTAssertTrue(object["expectedRevision"] is NSNull)
        XCTAssertEqual(object["reasoningEffort"] as? String, "high")
    }

    func testChoicesUseEachModelsOwnEffortsAndNeverSubstitute() throws {
        let catalog = try JSONDecoder().decode(ModelsResponse.self, from: Data(#"""
        {"models":{
          "codex":{"efforts":["low","high"],"models":[{"id":"synthetic-high-only","efforts":["high"],"fast":false},{"id":"no-effort","efforts":[],"fast":false}]},
          "grok":{"efforts":[],"models":[],"error":{"code":"MODEL_CATALOG_UNAVAILABLE","message":"モデル一覧を取得できません。"}}}}
        """#.utf8)).models
        let choices = BackgroundAgentChoices(catalog: catalog)
        let check = { (harness: String, model: String, effort: String) in
            choices.problem(for: BackgroundAgentSelection(harness: harness, model: model, reasoningEffort: effort))
        }
        XCTAssertNil(check("codex", "synthetic-high-only", "high"))
        XCTAssertNotNil(check("codex", "synthetic-high-only", "low"), "harness全体のeffortsでは許可しない")
        XCTAssertNil(check("codex", "no-effort", ""), "個別effortsが空の時だけCLIの既定")
        XCTAssertNotNil(check("codex", "no-effort", "high"))
        XCTAssertEqual(check("codex", "gone-model", "high"), "保存されているモデルは現在の候補にありません。選び直してください。")
        XCTAssertNotNil(check("codex", "", ""))
        XCTAssertEqual(check("grok", "any", ""), "モデル一覧を取得できません。")
        XCTAssertNotNil(check("claude", "any", ""), "候補を読めないharnessは保存しない")
    }
}
