# 旧Apple HTTP 5xx群の最初の人工送信試験

旧記録`aa88228ef94f29780973bff78679da03a90f729172659ee62f57d0224251b89b`はメッセージPOSTのHTTP 503を示す。元の応答本文、画面、サーバー側の原因は確認できていない。ここでは同じ種類の失敗を人工HTTPで作り、現在のAppleアプリの表示と操作を測った。旧事象が回復したという判定には使わない。

通常の`AppStore`と`ConversationView`をiPhone 16 Pro Max / iOS 26.5 Simulatorで起動し、loopbackの`test/fixtures/bughub-ui-probe.mjs`を接続した。試験用Bot会話の既存行を表示し、添付画像1枚と本文「503の後も残す本文」を入力して送信した。サーバーは最初のPOSTだけHTTP 503を返す。アプリは失敗を表示し、本文、添付画像、既存の会話行を保持した。サーバーの記録はPOST 1回、画像1枚で、自動再送は無い。サーバーを正常応答へ切り替え、利用者の送信ボタンをもう一度押すと初めて2回目のPOSTが出て、入力欄が空になった。後続のGETが終わるまでに不正応答の診断は無かった。

focused UI試験`NetworkLifecycleProbeUITests/testHTTP503PostKeepsComposerUntilExplicitRetry`は1件成功・失敗0件。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T09-18-28-633Z_pid8412_0322220b.xcresult`。通信と診断の原本は作業treeの`runtime/apple/legacy-errors/post503-proof.json`、SHA-256は`b58e94ecd9e8a280c9dd358cd11e405f52da090564c202ff80ffdfe45576a28b`。人工503で生成した診断のfingerprintは旧記録と同じで、同じ分類を通ったことを示す。

初回の人工サーバーは正常切替後のメンバーGETで必須の`id`と`fastMode`を欠き、別の`IOS_RESPONSE_INVALID`を生んだ。人工サーバーが完全なBotを返すよう直して再実行し、最終証拠ではこの余計な診断が0件になった。製品コードの判定を緩めて通した結果ではない。

直接Bot宛の送信先は同じ会話のまま。ルームで個別に選んだ返信者の保持、HTTP 500、停止POST 502、実障害のサーバー原因はこの試験の対象外。実Bot・オーナーの通常アプリ・実APNs token・認証・公開サービスには触れていない。試験サーバーとSimulatorは終了を確認した。
