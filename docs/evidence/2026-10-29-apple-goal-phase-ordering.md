# Apple Goal読取の呼出し・状態変更・通信試行の順序

製品sourceは`03c892f16990ddc4ef481524767cfb1b6702e7c3`。版75の固定署名source `7306e57ff81c3a5315aa69b737420100cff491dd`と配布成果物には含めていない。count29の原因・画面回復はunknown、状態はopen、修理成功はfalseのまま。

版72のcount29では`goal_view_phase_at_call=active`と要求開始・終了の`app_state=background`が異なる採取時点に属していた。既存のwall時刻とelapsedでは、画面callbackでTaskを作った時、診断状態が更新された時、実際の通信試行が始まった時の順序を同じ時計で結べない。

一覧の`list_pull_refresh`・`list_manual`・`list_view_task`・`list_foreground`・`list_event`、個別の`chat_manual`・`chat_view_task`・`chat_foreground`・`chat_event`は、各callerでTask開始前または構造化Taskの最初のawait前にtyped contextを作る。画面phaseの値を先に確定し、`CLOCK_MONOTONIC_RAW`のtick、診断状態snapshotの順に採る。これらは順次観測であって原子的な同時状態ではない。`change_reconcile`はGET開始直前に同じcontextを作り、画面phaseは`unknown`のままにする。既存の診断状態revisionと、同じ連続時計で採った状態変更tick・試行開始tickを記録する。新しいID、睡眠・回線原因の推測、GET/PATCH再送、通信・guardの変更は加えない。

## 有限検証

- 新focused試験`NetworkRecoveryTests/testGoalTimeoutOrdersCallPhaseChangeAndRequestOnContinuousClock`は1件成功・失敗0。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T06-31-11-409Z_pid49890_8b559811.xcresult`。
- [人工timeoutの診断原文](samples/2026-10-29-apple-goal-phase-order-artificial.txt)（SHA256 `8e1678eacca1d3e62999bad2fb6acfc310bfa947d7e0c81f9cf0adba61a50a61`）にはcall時のactive/revision1、状態変更後のbackground/revision2、連続時計のcall `357600913`ms・状態変更 `357600913`ms・試行開始 `357600915`msが出た。同じmsへ丸められたcallと状態変更の順序はrevision差で確認する。人工URLProtocolの即時timeoutであり、実端末の614秒や睡眠を再現していない。
- iOS Simulatorのfocused試験ビルドとMac Catalyst Debug buildは終了0。Macログ`runtime/apple/goal-phase-ordering/mac-build.log`のSHA256は`a12371e9aaa495fe75ddd80a2694d7a2b4f6240b775edbf4163da614287ed776`。ログ中の`error: ... exit code 0`はXcodeの文で、実プロセス終了0と区別する。既知のAppStore actor隔離警告以外の新しい警告は確認していない。

旧成功試験群、実端末・実Owner画像・実Bot、本体コンテナは操作していない。版75内部配布後の実通信出力と画面回復はまだ観測していない。Apple側の版75配布結果は別の証拠として記録する。
