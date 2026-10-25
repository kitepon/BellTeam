# Macで過去ログへ上スクロールできない間欠不良

オーナーは版64について「はなしたとおり。崩れではなくなったよ。上にスクロールできるときと、できない時があるってこと。」と回答した。版64で直した「古い履歴から新着ボタンを押すと会話欄が空白になる」問題とは分けて調査した。今回の修理基準はGitHub `main`の`016e4523fa504ce7b67f2259fbddeb7ef0ba30ea`。

## 隔離再現と原因

通常版と異なるbundle ID `dev.kitepon.bellbot.scrollprobe`のMac Catalyst Debug実Workspaceを、`127.0.0.1`の`test/helpers/conversation-scroll-server.mjs`だけにつないだ。短文とMarkdownの見出し・表・コードを混ぜた人工60件を初回10件から表示し、中央会話列に物理ホイールを`dy=50`、`500`、`1000`の順で送った。未修理では`before=m051`の過去20件GETが成功した後、次の大きな上移動で会話欄の可視行が0件となり空白のまま残った。[未修理の人工画面](images/2026-10-25-mac-paging-before.png)。通信応答の欠落ではない。原本のAX snapshotとHTTP記録は作業treeの`runtime/apple/mac-history-scroll/{snapshot-wheel-blank.json,proof-wheel-blank.json}`。

`ConversationView.updateWindow`は描画範囲を行高と現在のスクロール位置から計算できる一方、入口で「いま描画済みの行が画面内に見えること」を必須にしていた。Macのホイールが描画済み範囲を飛び越えると全行が画面外になり、次の範囲への切替へ進めない。前回の末尾移動中の範囲保留はこの利用者の上移動には発動しない。

## 修理とFocused確認

可視行を見つけられない時も既存のスクロール位置・行高による範囲計算を使い、可視行がある場合だけその行を追加の位置補助にする。新しい再試行や永続状態は足さない。

同じMacの物理ホイール操作で、修正後の最初の大きな上移動はm030〜m032を表示して`before=m031`を取得し、続く上移動もm005〜m007を表示して`before=m011`を取得した。[最初の移動](images/2026-10-25-mac-paging-after.png)、[続く移動](images/2026-10-25-mac-paging-after-second.png)。表示中の行順と本文を人工画像で確認した。

別の人工30行では最古付近の可視m002の位置が新着m031の前後とも`y=-852pt`で、新着ボタンからm031へ戻り、その後の通常上スクロールでm027〜m029を表示できた。前回の末尾移動中の表示範囲保留も維持した。

同ソースでiPhone 16 Pro Max / iOS 26.5 Simulatorの既存画面試験`testWindowCanReachOldestAcrossMultiplePages`と`testNewMessageWhileReadingOlderDoesNotJumpToBottom`が2件成功・失敗0件。XcodeBuildMCPの呼出しは300秒で時間切れとなったが、残ったXCTestは正常終了し、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T06-18-37-004Z_pid8412_ab95b55b.xcresult`を読んで合否を確定した。隔離Mac Catalyst Debugビルドも成功した。

Macでは`npm test`がtestgate選択の46ファイルで成功し、続けて`TESTGATE_FULL=1 npm test`で全99ファイルを実行して終了コード0だった。独立レビュー担当TronyはPR #80の`c35e423eecef55e699c0fca24388e0a4902d4df2`をLinuxで試し、既定の全Node試験747件成功・失敗・取消・スキップ0件と報告した。MacのUI試験・ビルドとLinuxのNode試験は別の検証結果である。

人工画面3枚の下部には「更新へ接続できません。再接続しています。」の警告がある。履歴ページのHTTP GETと可視行の前後確認は成立するが、この画面をSSE接続の正常性の証拠にはしない。警告の発生条件は今回特定しておらず、上スクロール修理の受入範囲にも含めない。

オーナーが実際にホイールとトラックパッドのどちらを使ったか、隔離操作と元の不発の順序が同じだったかは未確認。通常のMacアプリ画面・実Bot・メンバー設定には触れていない。署名・TestFlight配布・本番コンテナ操作はまだ行っていない。

## 版65の内部配布

上の記録は修理時点の観測である。修理PR #80と版番号PR #82をGitHub `main`へ統合し、オーナーの新たな許可を受けて版65をiOS・Macの内部TestFlightへ配布した。両platformでAppleの`VALID`と`IN_BETA_TESTING`を確認した。MacはTestFlightから版65へ更新し、本体・通知拡張の番号、署名、起動後の一覧を確認した。署名ソース、配布物のハッシュ、Apple受付番号と導入結果は[版65配布記録](2026-10-25-apple-build65-manifest.json)にまとめた。

オーナーは版65を通常使用し、過去ログを上へ安定して読めると回答した。これをMac上スクロール修理の実使用合格と判定する。隔離操作と元の不発条件が逐語で同じだったかは未確認のまま記録する。
