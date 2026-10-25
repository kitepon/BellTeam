# Macの過去ログ閲覧後に会話欄が空白になる問題

オーナーは、Macアプリで過去ログへ上スクロールするとログ表示が崩れると報告した。崩れ方の画像と直前の操作順は未取得のため、ここで再現した条件との一致は未判定。修理の基準はBellTeam `main`の`49339d621827a457a64544f3b5df0732b40ca96d`。

## 隔離再現

通常版とは別のbundle ID `dev.kitepon.bellbot.scrollprobe`でMac Catalyst Debug版を起動し、実際の`DesktopWorkspaceView`でユキの会話を開いた。通信先は`127.0.0.1`の`test/helpers/conversation-scroll-server.mjs`だけ。人工30行は短文とMarkdownの見出し・表・コードを混在させ、初回10件から`before=m021`で過去20件を取得した。最古付近を読んでいる時に人工の新着m031をSSE通知すると、APIは`?limit=20`と`?after=m030`を返し、新着ボタンが出た。

未修理版で「新着メッセージ ↓」を押すと、会話欄が空白のまま復帰しなかった。[未修理の隔離画面](images/2026-10-25-mac-history-scroll-before.png)。Debug時系列では、ボタン後に`renderedRows=nil`となり末尾移動が始まった直後、`updateWindow`がアニメーション途中のm017〜m027へ描画範囲を切り替えた。スクロールは`top=-8829pt`、`bottom=639pt`で末尾に到達したが、描画行は全て画面外となり、可視行を必要とする次の範囲更新も動けなくなった。本文の取得漏れやサーバーの応答異常ではない。原本は隔離worktreeの`runtime/apple/mac-history-scroll/{blank-no-resize.png,app-trace-before.log,proof-after-blank.json}`。

## 修理と受入

状態を所有する`ConversationView.updateWindow`の入口で、明示的な末尾移動中は中間地点の表示範囲への切替を保留する。変更は`!scroll.followingBottom`の条件1つ。移動完了後は既存の範囲更新が働く。

同じ人工30行・ウィンドウ変更なしの再現では、修正後に描画範囲を最新10行のまま末尾へ移動し、到着後にm025〜m031へ更新した。[修正後の隔離画面](images/2026-10-25-mac-history-scroll-after.png)。調査用ログを外してビルドし直した版では、実際に見えているm002の見出しが新着前後とも`x=546pt, y=-948pt, 幅127.4pt, 高さ26pt`で、画面中央の会話領域内に全表示された。[新着後の読書位置](images/2026-10-25-mac-history-scroll-reading.png)。新着ボタンからm031へ戻り、その後の通常上スクロールでもm027〜m029が表示された。修正前後のDebug時系列と画面・人工HTTP応答は`runtime/apple/mac-history-scroll/`に保存した。

同ソースのiPhone 16 Pro Max / iOS 26.5 Simulatorで、既存の`ConversationScrollUITests/testNewMessageWhileReadingOlderDoesNotJumpToBottom`が1件成功した。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-9cdb5724cf73/result-bundles/test_sim_2026-10-25T04-17-58-448Z_pid44139_c40f3a37.xcresult`。Mac Catalystの隔離Debugビルドと、着手時の`main`に対するNode全742試験も成功。並行して進んだ別件の`main`を取り込んだ後の最初の`npm test`では、合成commandのprocess group終了確認1件が失敗し、試験プロセスが終了しなかったため自分の試験だけ中断した。該当1件のfocused試験は成功し、`npm test`の再実行も成功した。ただしtestgateが対象を選んだ再実行は113件であり、統合後に全742件を再実行した結果ではない。MacのXCTestは隔離runnerがアプリ試験開始前に`Early unexpected exit, operation never finished bootstrapping`で終了したため、Mac画面の受入は実Workspaceの人工HTTP・アクセシビリティ座標・画面画像で行った。今回の修理を、既完了のiPhone版63の送信表示修理の結果で代用していない。

新着から末尾へ戻った後、ウィンドウ高を768ptから720ptへ変えても、見えているm027は`x=493pt, y=-1019pt, 幅158.8pt, 高さ23pt`のまま全表示された。[高さ変更後の画面](images/2026-10-25-mac-history-scroll-resized.png)。それ以前に650ptを要求した操作は実692ptでTIMEOUTとなったため、その試行の成否を根拠にしない。調査・修理の段階ではオーナーの実Macアプリ、実Bot、メンバー設定に触れず、署名・TestFlight・本番コンテナ操作も行っていない。

## 版64の内部配布

修理PR #75と版番号PR #76はトロニーの独立レビューとセンチの事前受入で必須修正0件となり、GitHub `main`の`85a91b218f5cd05bea70a2f292a41755778b6fcc`へ通常統合した。決裁箱「BellTeam版64を署名してオーナー内部TestFlightへ配布する」の許可後、同じAppleソースでiPhone/iPad版とMac版を署名・書き出し・Apple事前検証・各1回アップロードした。両方`VALID`となり、既存の「BellTeam オーナー」内部グループで`IN_BETA_TESTING`を読み戻した。成果物のSHA-256、Apple build IDと配布結果は[非秘密manifest](2026-10-25-apple-build64-manifest.json)に固定した。

MacのTestFlightには版64の「アップデート」が表示された。旧版63のMacアプリが起動中の間は「ダウンロード中」のまま実ファイルが変わらず、アプリを通常終了した直後にTestFlightが「開く」へ変わった。`/Applications/BellTeam.app`の本体・通知拡張は64で、厳格な署名検査とGatekeeperの`source=Testflight`を確認した。TestFlightから64を開き、メンバー・ルーム一覧が表示された。実Botへの確認専用メッセージは送っていない。`jev-desktop`は更新対象を一意に選べず操作前に停止したため、上流`agent-desktop`でBellTeam版64の表示を読んで更新した。

決裁箱「BellTeam版64のMac過去ログ表示を通常使用で確認する」で、オーナーから「はなしたとおり。崩れではなくなったよ。上にスクロールできるときと、できない時があるってこと。」と回答を受けた。空白化修理は実利用で効果があったが、Macの過去ログ閲覧全体は受入未達。上スクロールが時々効かない条件は、空白化と原因を同一視せず隔離環境で調査を続ける。元の報告と空白化の隔離再現の操作順の一致は未判定のまま。一般App Store公開とBellTeam本番コンテナ更新は行っていない。
