# Apple GET通信3件の再調査と試行別計測

Ownerが再開した3件は、保存済み診断の最後の観測を対象とする。版は3件とも`1.0.3(69)`。件数23/10/5は同じfingerprintの集計であり、過去の各発生の原因や端末操作を復元する数ではない。原本はRoot席の`bughub-normal-log-closure-fields-20261027/logging-policy/reopen-corrected-rule-20261029/`に保存されている。

| 対象 | 最後の観測 | 分かること |
| --- | --- | --- |
| Goal GET / -1001 | 壁時計872,505ms、1試行、背景→背景 | 最後のtask metricsはtransaction 1、再利用接続、要求開始/終了時刻はほぼ同時、応答開始なし。通信失敗の原因と背景休止時間は不明。 |
| Goal GET / -1005 | 壁時計30,374ms、2試行、前面→背景 | 保存されたmetricsは再試行側の1 transactionだけ。最初の失敗試行の時間・経路・計測値は旧実装で失われた。 |
| 会話GET / -1001 | 壁時計2,341ms、1試行、前面→前面 | 再利用接続で要求開始/終了の記録あり、応答開始なし。サーバー到達と画面回復は不明。 |

3件とも`screen_observation=not_observed`、`handling_basis=code_classification`、`cause_assessment=unconfirmed`。現在のGoal画面は取得失敗時に古い値を現在値として表示せず、明示更新と前面復帰時の読取経路を持つ。会話画面は失敗を表示し、入力・取得済み行を保持して再読込を提示する。これはコード上の処理であり、保存診断から実際の画面表示や回復成功を確認したことにはならない。

原因が特定できないため、通信動作や再試行回数を変更しない。`BellAPI.load`の各試行が終わる時点で、開始/終了の壁時計、単調時計の経過、前後のアプリ状態、URLSessionが応答を返したか例外を投げたかとURLエラー符号、当該試行のURLSession metricsの有無・task区間・最後のtransactionの要求/応答時刻と再利用接続を保存する。HTTP 5xxを成功扱いにしないため、transportの返却とHTTP結果は区別する。既存の要求全体と最後のmetricsのfieldは維持する。新しい値はURL・query・本文・tokenを含まない。初回の-1005後にmetrics collectorを置き換える前に初回分を記録する。

人工のGET二度切断と単一timeoutのfocused2件は成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T16-13-03-849Z_pid49890_e1bb8b5e.xcresult`。試験は各試行の符号・時間・状態・metrics可用性、再試行2回上限、秘密本文なしを確認する。実回線の原因、iPhoneの休止時間、サーバー受領、利用者画面での回復は依然未確認。後続の通常利用で再発した場合の調査には、新しい試行別値とRootの同時刻のサーバー記録、Ownerの見た画面と回復操作を突き合わせる。自然再発を今回の閉鎖条件にはしない。

関連の`NetworkRecoveryTests`と`BellDiagnosticsTests`は計39件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T16-14-49-764Z_pid49890_de4a6273.xcresult`。

再試行の最初と二番目のmetricsが人工fixtureで共に取得でき、transport返却とHTTP成否を混同しない表記にした後のfocused1件も成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T16-21-37-448Z_pid49890_a64fcc60.xcresult`。

人工fixtureが出した診断原文を2件のXCTest attachmentからそのまま保存した。[2試行の原文](samples/2026-10-29-apple-get-two-attempts.txt)は1,942 bytes / SHA256 `440f9ce19bcdd177c564cef30ed643e218311d4f766634d0b0c2a8ca2d687e5f`、[単一timeoutの原文](samples/2026-10-29-apple-get-timeout.txt)は1,429 bytes / SHA256 `4e5e5cd736c2b18254f03ec9360ab81766713e88ceb36bddba5daa5204f83ad9`。両test成功のXCResultとsource commitへの対応は[サンプル目録](2026-10-29-apple-network-attempt-samples.json)に固定した。これはURLProtocolの人工出力で、実端末の試行時間・transaction内容や休止時間を証明しない。

Mac Catalyst Debugの署名無しコンパイルも1回成功した。ログはgit管理外の`runtime/apple/network-attempts/mac-debug.log`に保持。実Botへの通信は行っていない。

この診断追加は固定Apple版70の署名無し候補・署名申請に含めない。通常反映と閉鎖判断にはAnchorの受入を先に受ける。実Botへの試験送信、Owner認証・画面操作、BellTeam本体反映は行っていない。
