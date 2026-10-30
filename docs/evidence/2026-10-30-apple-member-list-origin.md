# メンバー一覧GETの背景開始を追う観測

匿名の版78 iPhone診断では、`GET /api/bots`の一試行がアプリの`background`記録から246ms後に始まり、状態revisionを変えずに約155.3秒後に`-1001`となった。requestとsessionの60秒設定はidle timeoutであり、155秒の壁時計経過だけで設定違反や停止箇所を確定できない。TaskMetricsは再利用接続1transactionで応答開始が無い。サーバーの同時間帯に解析できた別GETは全HTTP 200だったが、端末要求と結ぶID・時計同期が無く、今回の要求の受付や応答を証明しない。画面状態と原因は未確認。

現行sourceの`member_list_read`は、`/api/bots`失敗時の共通名で、呼出し元が`trigger=unknown`のままだった。`AppStore.sceneChanged(.background)`は前面更新TaskとSSE更新Taskを取消す。一方、起動・手動更新・会話操作後・オーナー回答後・プロフィール画像やメンバーの保存後・削除確認からも同じGETを開始できる。既診断だけでは、どの呼出し元が背景で始めたかを判定できない。

今回の差分は、`/api/bots`の呼出し元を`member_list_origin`として失敗traceへ載せ、呼出し時の連続時計、アプリ状態、revision、直前の状態変更tickを既存の要求開始記録と並べる。HTTP、再試行、timeout、Task取消しの動作は変更しない。共通欄の`trigger=unknown`は変えず、`member_list_origin`でsourceの呼出し元だけを示す。

## 有限試験

人工の`background`中に`/api/bots`だけを`-1001`にしたfocused testは1件成功し、呼出し元・状態・時系列、GET試行1回で再試行なしを確認した。前面更新の取消し・SSE更新併合に関する既存3件も成功した。合同試験の初回には、既存試験が前面Taskを終了時に取消さず、次の試験で人工URLProtocolのfixtureを解放後に参照する試験欠陥が出た。終了時に背景化して前面Taskを取消すよう修正し、合同再試験は4件成功・失敗0。修理後XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T05-06-39-721Z_pid39301_75ac38d9.xcresult`。

## 人工試験のクラッシュと致命診断の照合

初回合同試験の失敗XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-30T05-03-43-824Z_pid39301_1c9804a1.xcresult`は、iOS 26.5 SimulatorのBellTeam PID73559が05:04:41ZにSIGTRAPで終了した記録を持つ。Macの`/Users/kite/Library/Logs/DiagnosticReports/BellTeam-2026-10-30-140518.ips`は52,405B、SHA256 `a80edfb07cc4c448462727a20bd36c3bff705c1a141f9bf0b677f9ed65558d43`。captureTimeは05:04:41.3201Z、報告ヘッダ時刻は05:05:18Z。BellBotTestsのUUIDは`022ed5c1-62cb-35b3-995a-ac26127561d9`、baseはdecimal `4453105664`（hex `0x1096d0000`）、BellTeam appのUUIDは`4cbf1d9e-7419-3ccb-991a-67af6a76c05f`。faulting thread 19はoffset `664836`の`DelayedForegroundProtocol.startLoading()`、`ForegroundRefreshTests.swift:153`で解放済みfixtureの強制unwrap。失敗XCResultのtestProductsで`dwarfdump --uuid`した両binaryのUUIDも、`.ips`のusedImagesと一致する。

受領したMetricKit診断の本文は24,028B、SHA256 `8a23e0ef3932efe553c3e844f2c079c0fe629326ebce2b336933365e7dc63d43`で末尾が切り詰められている。その第一threadは非faultだが、BellBotTestsの同UUID・同baseと12フレームoffset `[10856,1008236,786988,810908,817833,1032861,49709,54845,49917,55189,51137,55501]` が`.ips`のthread 0と数・順序・値まで一致した。MetricKit本文にincident IDとfaulting thread offsetが無いため、そのIDによる直接照合はできない。時刻とstackの一致から人工合同試験起源と高確度で判定し、実利用中の製品クラッシュとは扱わない。BugHubの状態変更はこのsource差分から自動では行わない。

この変更は既発生した`-1001`の原因特定・修理成功、実機画面の回復、画像選択消失との同一根因を示さない。次の同種診断で呼出し元と背景化の前後を結ぶための観測である。
