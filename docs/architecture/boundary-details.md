# 外部窓口と共通処理の依存

固定source `546f232180515a2a8cd9098b943673170c49e3d4`。機能の内部と、その機能が使う汎用処理を分ける。別製品の内部を本体へ取り込む案ではない。

## モデル一覧は保存台帳ではなく、その時の実行環境への問い合わせ

`HTTP / MCP → LiveModelCatalog.list → forHarness → AitermClient.call(agent_models)`。`list`はCLIごとにallSettledし、一つのCLIの失敗を他の候補へ広げない。`forHarness`は短命clientを作り、schema/harness/efforts/models/fast_unavailableを確認してfinallyでcloseする。close自体の失敗も上位へ返り得る。

検証はBotRegistryの作成/設定変更とWebの編集候補から使う。空配列を成功した候補一覧の代わりにせず、errorを同じCLIの結果へ載せる。モデル候補は永続化も自動再試行もしない。model/effortの変換と取得元はAitermが所有する。

`cursor-models.mjs`の旧CLI文字列parserは現在のsrc/web/scriptsにcallerがなく、対応testだけが参照する。これを現在のモデル一覧図の途中へ入れない。別repoからの利用を今回の検索だけで否定はしないので、接続整理のために削除する必要はない。

## 通話とBugHubは同じ中継ではない

| 窓口 | caller → 実関数 | 本体が所有すること | 外部が所有すること・失敗 |
| --- | --- | --- | --- |
| 通話directory | 通話bridge → `createCallBridgeServer` GET | 台帳refresh、公開するid/name/title/role | 通話sessionの正本はbridge。Bot一覧を会話の宛先権限に読み替えない |
| 通話配達 | bridge → POST → `receiveCallBridge` | 64KiB上限、schema/event/送信元/宛先/本文型の検証。通常会話へ受付して記録 | 全停止423、宛先不在404、配送例外502。bridgeへの応答をBotの最終回答にしない |
| 通話socket | `listenCallBridge` → runtime.close | 親dir/socket型、listen/mode、setup失敗時close/unlink。所有するsocketを片付ける | 他の通信口を新設しない。setup cleanupの失敗もAggregateErrorへ保持 |
| SEC所見 | MCP `runBellTeamTool` → `createBugHubSecurity` | 席identityからactorを付ける。設定を呼出時に読む。writeのrequest_idを返す | 項目の意味・version・履歴・解決判断はBugHub。30秒の一回fetchのみ。unknownはrequest_id付きで返す |
| BugHub返却 | `callBugHubSecurity` | HTTP失敗と不正JSON/objectを区別。鍵を引数/返却へ出さない | 再送を自動化しない。同じrequest_idの重複処理は外部契約であり本体の配送queueを作らない |

両方のHTTP/JSON処理は目的も上限も返却契約も違う。`http-response.readJson`へ一括置換して16MiBにするような共通化はしない。席MCPの4MiB＋要素上限も別契約である。

## 観測した失敗を、返却・保存・表示へ分ける

| 処理 | 実関数 | 境界 |
| --- | --- | --- |
| HTTPのJSON | `readJson/json` | chunkを全部つないでUTF-8を復号、16MiB上限、JSON不正を入口の400へ。出力はno-store |
| HTTPの返却選択 | `respondHttpError` | typed code/status、機能別拒否、一般500の順。秘密入口は任意例外本文を記録せず専用固定文。診断保存失敗を新しい送信の理由にしない |
| HTTPの時刻観測 | `logReadRequest/logWriteRequest` | method/path/時間とfinishまたはaborted。GETは開始も記録。Nodeのfinishは端末受領の証明ではない。query/本文を保存しない |
| 診断文脈 | `diagnosticRequestContext/diagnosticFailureDetails` | routeのIDを型へ置換、既知code/type/native enumだけ。HTTP500選択と受領/配送/画面の未知を区別 |
| 診断の集約 | `diagnosticReportContext` → `Diagnostics` | 既知scope/operation/resultを集約keyへ。重複fieldや未知の操作は推測せずnull。一般HTTP500の保存が返れば3header、秘密の専用500はこの分岐を通らない |
| 停止失敗の報告 | `stopFailureReport` | 返却receiptの対象件数/安全codeだけ。送付結果と停止完了を同一視せず、例外全文を記録しない |

これらは「エラー処理」一個にまとめる対象ではない。共有すべきなのは狭い型判定や保存手段であり、公開エラーの選択と機能別の意味は各入口に残す。

## 依存の向きを直す具体的な箇所

| 現在の依存 | そのcallerが必要とするもの | 次の整理と保持する窓口 |
| --- | --- | --- |
| Diagnostics/OwnerProfile/RoomRegistry/UserRules → BotRegistry | `writeAtomic/exists` | 専用fileへそのまま移し直接import。BotRegistry側exportは互換のため残す。固定tmpへ変更しない |
| RoomRegistry → BotRegistry | `normalizeSchedule/scheduleDocument/validateAvatar` | 予定定義とアバター値検証をそれぞれ所有する小moduleへ。room targetsの検証はRoomRegistryのまま |
| ModelCatalog/ApplicationServices → AitermTransport | `AitermClient`だけ（Servicesはtransport生成も必要） | clientは既存`aiterm-client.mjs`から直接import。transportの既互換exportは保持。全callerの新経路移行を強制しない |
| AitermClient/HTTP診断/停止診断 → ExecutionBridge | `returnedExecutionError/ERROR_META` | 純粋なreceipt検証をadapterから分離。ExecutionBridgeの既exportとcodesの厳密性は維持。通常構成へ旧registerを復活させない |
| Onboarding/HarnessAuth | auth失敗→schema/status判定の重複 | 既存auth-uiへ小関数。保存/Map/CLI寿命/公開エラーはそれぞれのserviceに残す |
| Webの各画面 → 巨大app state | 選択・編集中対象・取得世代が混在 | timeline、avatar、予定編集の所有単位を分ける。全stateを引数で渡すだけの分割にはしない |

これは現srcのimportと使用箇所を読んだ結論。削除可能な全exportの証明や、全call graphを自動解析したという主張ではない。実装前には変更する窓口に限定してtest/fixture/exportも検索する。

実装：[model-catalog.mjs](../../src/model-catalog.mjs)、[call-bridge-server.mjs](../../src/call-bridge-server.mjs)、[bughub-security.mjs](../../src/bughub-security.mjs)、[http-errors.mjs](../../src/http-errors.mjs)、[diagnostic-request-context.mjs](../../src/diagnostic-request-context.mjs)、[diagnostic-report-context.mjs](../../src/diagnostic-report-context.mjs)。実際の通話・SEC操作・モデル取得・診断POSTは行っていない。
