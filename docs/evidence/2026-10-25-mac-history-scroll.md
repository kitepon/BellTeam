# Macの過去ログ閲覧後に会話欄が空白になる問題

オーナーは、Macアプリで過去ログへ上スクロールするとログ表示が崩れると報告した。崩れ方の画像と直前の操作順は未取得のため、ここで再現した条件との一致は未判定。修理の基準はBellTeam `main`の`49339d621827a457a64544f3b5df0732b40ca96d`。

## 隔離再現

通常版とは別のbundle ID `dev.kitepon.bellbot.scrollprobe`でMac Catalyst Debug版を起動し、実際の`DesktopWorkspaceView`でユキの会話を開いた。通信先は`127.0.0.1`の`test/helpers/conversation-scroll-server.mjs`だけ。人工30行は短文とMarkdownの見出し・表・コードを混在させ、初回10件から`before=m021`で過去20件を取得した。最古のm001を読んでいる時に人工の新着m031をSSE通知すると、APIは`?limit=20`と`?after=m030`を返し、m001の座標は通知前後で変わらず、新着ボタンが出た。

未修理版で「新着メッセージ ↓」を押すと、会話欄が空白のまま復帰しなかった。[未修理の隔離画面](images/2026-10-25-mac-history-scroll-before.png)。Debug時系列では、ボタン後に`renderedRows=nil`となり末尾移動が始まった直後、`updateWindow`がアニメーション途中のm017〜m027へ描画範囲を切り替えた。スクロールは`top=-8829pt`、`bottom=639pt`で末尾に到達したが、描画行は全て画面外となり、可視行を必要とする次の範囲更新も動けなくなった。本文の取得漏れやサーバーの応答異常ではない。原本は隔離worktreeの`runtime/apple/mac-history-scroll/{blank-no-resize.png,app-trace-before.log,proof-after-blank.json}`。

## 修理と受入

状態を所有する`ConversationView.updateWindow`の入口で、明示的な末尾移動中は中間地点の表示範囲への切替を保留する。変更は`!scroll.followingBottom`の条件1つ。移動完了後は既存の範囲更新が働く。

同じ人工30行・ウィンドウ変更なしの再現では、修正後に描画範囲を最新10行のまま末尾へ移動し、到着後にm025〜m031へ更新した。[修正後の隔離画面](images/2026-10-25-mac-history-scroll-after.png)。調査用ログを外してビルドし直した版でも、m001の位置は新着前後とも`y=-1266pt`で、ボタンからm031が表示された。修正前後のDebug時系列と画面・人工HTTP応答は`runtime/apple/mac-history-scroll/`に保存した。

同ソースのiPhone 16 Pro Max / iOS 26.5 Simulatorで、既存の`ConversationScrollUITests/testNewMessageWhileReadingOlderDoesNotJumpToBottom`が1件成功した。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-9cdb5724cf73/result-bundles/test_sim_2026-10-25T04-17-58-448Z_pid44139_c40f3a37.xcresult`。Mac Catalystの隔離Debugビルドと、着手時の`main`に対するNode全742試験も成功。並行して進んだ別件の`main`を取り込んだ後のNode全試験では、合成commandのprocess group終了確認1件が失敗し、試験プロセスが終了しなかったため自分の試験だけ中断した。失敗した機能を単独で切り分け中であり、統合後の全試験を合格とは記さない。MacのXCTestは隔離runnerがアプリ試験開始前に`Early unexpected exit, operation never finished bootstrapping`で終了したため、Mac画面の受入は実Workspaceの人工HTTP・アクセシビリティ座標・画面画像で行った。今回の修理を、既完了のiPhone版63の送信表示修理の結果で代用していない。

ウィンドウ高を768ptから実692ptへ変えた読み取りでは、m001の座標は変わらなかった。ただし`agent-desktop resize-window`は要求した650ptへ到達できずTIMEOUTを返したため、692ptでの観測として扱う。オーナーの実Macアプリ、実Bot、メンバーの設定には触れていない。署名・TestFlight・本番コンテナの操作も行っていない。
