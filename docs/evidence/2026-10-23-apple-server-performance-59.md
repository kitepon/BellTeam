# Apple・サーバー性能修理の結合確認

出典: BellTeam の `apple-performance-59`、サーバーPR #50、専用SimulatorのXCTest結果、実`createBellTeamServer`の隔離fixture、Macの`fs.watch`再現、Appleのアーカイブ検証。取得日: 2026-10-23。確度: 記載した人工データと環境での実測。本番Linux、実Bot、配布後の体感と電池消費は含まない。

## 実装と責務

- Appleは同値のBot画面再描画を省き、会話の本文配置を画面と上下2画面分へ絞った。初回10行・過去20行の取得、最新位置、過去の読書位置、新着ボタン、日本語入力、質問カードの下書きと結果、秘密入力画面の状態を維持する。配置範囲の実測と制限は[会話の検証記録](2026-10-23-conversation-window.md)へ置いた。
- サーバーの`messages` SSEには`at`と既存`type`を保ったまま`all`、`topics`、`botIds`、`roomIds`を加えた。Appleは確定した宛先の会話へ直接通知し、必要なBot・room・owner・queueだけを取り直す。予定だけの通知では予定タブの対象Botまたはroomの予定だけを再取得する。初回・再接続の`ready`、旧形式、有効JSONで宛先形式が不正な通知、未知topic、`all:true`は全体照合する。壊れたJSONは応答形式の異常として接続を止め、画面へ表示する。
- サーバーは画面照会中の重複`pty_list`、履歴索引と旧差分、質問・秘密依頼カードの対象探索、room定義の変化検出を状態の所有者で修理した。Macの再帰`fs.watch`が子ファイル名のほか親やrootだけを通知する実測に対し、room監視はファイルのstat差分から変わった部屋とtopicを確定する。読取不能、watch error、履歴の初出・置換・縮小・同サイズ書換・消失は全体照合とする。

## 結合と試験

Appleの結合ソースは`e11a053c4067bcf2a2349f55bb2669108f159853`、サーバーPR #50の結合fixtureは`1f0a6babf74375db4dfaa41e1e8a7a804e36adff`。実サーバーをloopbackの人工履歴・人工Bot・人工roomで起動した一時mergeのrevisionは`d09ae935517ca83524922c9314e79efb447cf9db`。`1f0a6ba`の製品sourceは、レビュー済み`3f2e19f`から差分ゼロだった。以後のroom監視修理は`61a9e4c3a17999c55a2133d41bdbe57c52e36682`である。

| 確認 | 結果・原本 |
| --- | --- |
| 実サーバーとiPhone画面: Bot別・対象新着、予定対象限定、初回/再接続ready、互換通知、破損JSON停止 | 2件成功、失敗・skipゼロ。`runtime/apple/performance-59/final-apple-server-pair.xcresult` |
| windowed会話と宛先付きSSEの同時動作 | 人工100行の更新中操作と別Bot通知抑制の2件成功。`runtime/apple/performance-59/combined-window-sse.xcresult` |
| 予定の背景取消・前面復帰 | 1件成功。`runtime/apple/performance-59/schedule-background-final.xcresult` |
| Appleの予定宛先と未知topic | 単体2件成功。`runtime/apple/performance-59/schedule-target-unit.xcresult` |
| サーバーの監視方言・性能・結合helper | 関連3ファイル22件成功。root通知60件を2部屋に与えた時、ディレクトリ列挙1回・stat6回・本文read0回。 |
| サーバー全体 | `TESTGATE_FULL=1 npm test`で663件成功、失敗・skipゼロ。`runtime/apple/performance-59/npm-test-final.log` |
| 統合後のビルド | iOS SimulatorとMac CatalystのDebugビルドが成功。Macの会話UI自動試験は開発用アカウント・通知capability付きprofileが無く未実施。 |

最初のNode統合実行ではMacの親/root名通知が`all:true`に合流し、予定を対象だけへ通知する試験が失敗した。単独の同試験は成功した。`fs.watch(root,{recursive:true})`で60回の人工更新を観測すると、`room-a/schedule.json`だけでなく`room-a`とroot basenameも届いた。サーバー所有者がstat差分に基づく修理と4件の方言試験を追加した後、Macで関連試験と全663件を再確認した。イベントを捨てる変更や、全体通知を対象通知と見なす試験緩和はしていない。

## 配布候補と未完了

ビルド番号は本体・通知拡張とも`1.0.3 (59)`。Appleソースと版を含むアーカイブ時のcommitは`9ca8547d64e2e308da9fa004195999374e76506d`で、後続のサーバー監視修理はApple本体のsourceを変えていない。`runtime/apple/performance-59/ios-59.xcarchive`と`mac-59.xcarchive`を作り、厳格な署名検証と本体・通知拡張の版一致を確認した。書き出し後のiOS IPAのSHA-256は`6404b27f17836c25ec98e0397c905cc7f96b95c6f7e01112c7cd4951770f3eca`、Mac pkgは`1e72bad24fc19078dbfe9a13cdf3213fe4d635f310a27c90acc8b49da31d152c`。Mac pkgのInstaller署名とApple公式の両成果物の事前検証は成功した。

この記録時点でGitHub `main`へのpush、Appleへの送信、TestFlight内部配布、Mac導入後smoke、サーバー本番反映は未実施。公開対象commitを`origin/main`の祖先にしてから送信する。本番BellTeamコンテナの再作成・再起動には別個のオーナー許可が必要。iPhone実機の挙動は、内部TestFlight配布後にオーナー本人が確認する。

取得済み本文と行高の保持、余白と配置範囲の計算は履歴行数に比例する。サーバーの初期索引作成にはメモリを使い、逆時刻順の大量挿入には並べ替えコストが残る。Macのrootだけの監視通知は、対象を確定するため既知部屋の3ファイルのstatを読む。これらは今回の表示契約と通知の取りこぼし防止のため残した処理であり、実機の速度・電池消費の改善率を推定しない。
