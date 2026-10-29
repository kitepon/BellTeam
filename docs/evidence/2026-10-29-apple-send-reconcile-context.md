# Apple会話POST失敗後の読直し分岐

製品sourceは`90910e46f9cb9bf1f401d32dc6b5f2669a0b0392`。固定版77の署名済みsource `1b5f9e46ed39aac4dc824f2dbdfcfc2b49a9ade8`とTestFlight成果物には含めていない。

[eaab count2の本人評価原本](samples/2026-10-29-apple-eaab-count2-evaluation.json)（SHA256 `57f62e7f0d527e043f55e3f8e7a4b28b44a248569c63ab347b563cc50872526a`）は、POST一試行の接続喪失`-1005`、約6.1秒後の失敗、送信側のrequestEndあり・responseStartなしを示す。元の診断原文は2,100B、SHA256 `a640ad2e5246af1361cd058277fe6b115df38874869e9ce0d94bc1046abbc4f9`。サーバーの受付、実画面の入力、読直し実行・結果は未観測で、原因・回復unknown、warn/open、repair_success=falseを維持する。

既存の会話送信catchは、optimistic行を外して元の本文・画像を入力欄へ戻し、結果未確認かつUIKitでactiveの場合だけ`load()`を呼ぶ。その失敗報告1件の`diagnosticContext`へ、固定enumの`send_reconcile_decision`、0/1の`send_reconcile_load_calls`、固定enumの`send_reconcile_load_result`を加える。`load()`内のScenePhase・送信待ちguard、既存readerへ合流して戻った場合、新reader Taskから戻った場合を分ける。これらはメソッド境界の観測で、HTTP GETの実試行・成功やサーバー受付・配送を補完しない。本文・画像・認証値・新IDを記録しない。POST自動再送、入力復元、認証、送信後の読直し条件は変更しない。

## 有限検証

- 新focused試験`NetworkRecoveryTests/testSendFailureReconcileReportsOnlyTheLoadCallBoundary`は1件成功・失敗0。UIApplication非activeと結果既知のskip、ScenePhase/送信待ちguardのskip、既存readerへの合流と新readerからの戻りを[人工原文](samples/2026-10-29-apple-send-reconcile-artificial.txt)（SHA256 `398b6fc4dbc753d5c88ac305150557a8f5a3618a74fff48c8452943a082170f8`）へ保存した。同じ人工POST失敗の診断報告は1件。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T11-48-47-622Z_pid49890_f33a591f.xcresult`。
- 同試験でiOS Simulatorのコードはコンパイルでき、Mac Catalyst Debug buildは終了0。Macログ`runtime/apple/send-reconcile-context/mac-build.log`のSHA256は`aa9c8fb1a289c55fdb454ba1cadbb4594aef3fa166aaa486ee391a867af43638`。既知のAppStore actor隔離警告以外の新しい警告は確認していない。

人工分岐の確認は実端末のPOST応答喪失、GET読直しのHTTP結果、画面の入力保持、サーバー配送を再現しない。旧Save・UI・Node・Goal試験群は再実行していない。実Bot、Host UI、実Owner画像、本体コンテナ、Apple署名・uploadは操作していない。
