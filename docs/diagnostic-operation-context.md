# 診断の操作文脈と調査注記

サーバーHTTP500の既存diagnostic_logには、operation、trigger、expected_result、actual_resultと根拠区分を添える。scope=server_requestはHTTP処理内の観測、アプリのscope=app_requestは端末側の要求観測。期待はexpectation_basis=code_contract、扱いはhandling_basis=code_classificationであり、画面観測ではない。trigger=unknown、screen_observation=not_observedを明示する。

サーバーは500応答を選んだcatchで記録する。actual_result=http_500_response_selectedはクライアントへの到着確認ではなく、response_deliveryとdelivery_outcomeはunknown。code/module/重大度/再送・取消条件は変えない。要求traceのある今後の報告の集約は[bughub-report-context.md](bughub-report-context.md)に従い操作・結果・例外符号を区別する。旧指紋は移行しない。診断へ出すrouteは固定の型だけで、query・本文・認証値・対象IDや任意名を追加しない。従来の運用stderrとBugHubへ渡す診断本文の範囲は分ける。

| HTTPの目的 | 共通operation | サーバーの期待（応答） | アプリの期待（受取/読込） |
| --- | --- | --- | --- |
| 会話GET | conversation_read | conversation_data_response | messages_loaded |
| 会話POST | message_send | message_acceptance_response | send_result_returned |
| Bot一覧GET | member_list_read | bot_list_response | member_list_loaded |
| 個別予定GET | schedule_read | schedule_data_response | schedule_entries_loaded |
| 購読状態GET | subscription_status_read | subscription_status_response | subscription_status_loaded |
| イベントGET | event_stream_connect | sse_stream_response | sse_stream_connected |
| セッションGET | session_check | session_status_response | session_confirmed |
| 機能設定GET | settings_read | settings_response | settings_loaded |

サーバーの不明な入口はoperation/expected_result=unknown。AitermTransport.dispatchを示すstackがある場合だけfailure_stage=dispatch。それだけで配送状態や原因は決めない。アプリは要求trace無しならscope=app_operation、operation=unknown、expected_result=successful_responseという一般の期待だけを記録し、呼出側の代替pathから実要求や具体的な目的を作らない。

## 過去登録の説明を添える

設置側が用意するJSONの絶対pathをBELLTEAM_DIAGNOSTIC_INVESTIGATIONSへ渡す。JSONは既存fingerprintをキーとし、値はBugHubが既に扱うinvestigation形：summary（4000字以内）、evidence（20件以下、各1000字以内の根拠参照）、updated_at（UTC ISO日時）。

Diagnostics.listの管理GETだけへこの設置別注記を添える。診断原文・版・受信日時・回数・状態・重大度はGETで書き換えず、このJSON由来の注記を診断保存fileへコピーしない。設置側のpathを指定しない環境にはこの注記を付けず、他の利用者の同じ指紋へ特定設置の過去履歴を配布しない。注記fileは起動時に読み、明示したfileの欠落/読取・形式の失敗は値を含まない汎用警告を出し、診断原本の取得と受付は継続する。

これとは別に、管理APIで後から付ける調査/終了理由は診断行の`investigation_note`という管理メタデータへ、既存の直列化保存経路で永続化する。受信した`diagnostic_log`や版・発生時刻を書き換えるものではない。管理GETはこの管理メタデータを`diagnostic_context.investigation_note`へ投影し、要求発生時の観測と後日の判定を分ける。設置別JSONの`investigation`本体は一文字も省略せず元の根拠と更新時刻を保つ。API/再発時の記録時累計と状態の扱いは[bughub-report-context.md](bughub-report-context.md)を参照する。

BellTeam内部設置のJSON所有者はトロニー。置き場はbot-7b140b27/integrations/bughub-event-audit-20261016/registration-investigations.json。private composeからその既存data bind内のpathを指定する。一般配布のcomposeには指定しない。BugHubのsignature adapter→collector→investigation表示という既存経路を使用し、中央DBを書き換えない。JSON更新後の適用は通常の反映窓で行う。特定の原本と新しい説明を混ぜず、注記には評価日時と対象の版/受信時刻を含める。

登録削除は追加しない。既存resolve/reopenは管理メタデータのnote保存に対応し、新しいannotateは状態を変えず理由だけを更新する。調査注記やcloseは、それ自体で修理成功や根因確定を示すものではない。
