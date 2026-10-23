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

GitHub `main`は`bbd5f5b523dac70c012e7746cf73beeffb39253c`へ通常の前進pushで更新した。アーカイブ元`9ca8547`が`origin/main`の祖先であることを確認してからAppleへ送った。iOS IPAのdelivery/build IDは`21fb5a21-6792-4f64-825b-7316bffa2fcf`、Mac pkgは`ba75d5e9-9ffd-476b-94dd-94ff3250db67`。両方の`1.0.3 (59)`がAppleで`VALID`となり、既存の内部グループ「BellTeam オーナー」`58133050-1c39-4915-b6da-aac18b95921b`へ追加した。再読取した両方の`internalBuildState`は`IN_BETA_TESTING`。

MacのTestFlightは当初古い候補を表示していた。`表示 > 更新`で再読込し、画面にビルド59が表示された後に「アップデート」を選んだ。`/Applications/BellTeam.app`と通知拡張がともに59であり、厳格な署名検証とGatekeeperのTestFlight受理を確認した。TestFlightのBellTeam行と更新ボタンはアクセシビリティ上のClick操作を受けず、Jevは対象に確信を持てず停止した。画面上の位置を確認した標準のデスクトップ操作で選び、導入版の実ファイルを別経路で読み取って確認した。

導入済みMac版59を通常起動し、既存の試験用ルームを開いた。会話を上へスクロールすると表示する内容が変わり、入力欄は残った。入力欄へ短い試験文字を物理入力すると送信ボタンが有効になり、全選択して消すと無効へ戻った。送信、設定変更、実Bot操作はしていない。確認のために起動したBellTeamアプリは通常終了し、終了を確認した。MacのXCTest自動試験は開発用署名profile不足で未実施のままであり、このsmokeは自動試験の代替結果として記録しない。

サーバー本番は後述の商用コンテナで反映した。iPhone版59の操作感について、オーナー本人は決裁箱「iPhone版59の会話操作を確認する」で「軽くなり問題なし」と回答した。端末へ導入した版の機械読取と、CPU・電池消費の計測は行っていない。

一般配布用DockerイメージのGitHub Actionsは当初失敗した。main `bbd5f5b`のrun `39865985889`ではarm64・amd64ともイメージの作成と起動までは成功し、公式認証の開始で`POST /api/setup/harness`がHTTP 500となった。コンテナログはAiterm 0.61.5の`EXECUTION_UNSUPPORTED`を`AitermClient.call`から報告し、イメージの公開段はskipされた。以前の`59df581`でも同じ工程の失敗があるため、今回の性能差分が原因とは判定できない。Aitermが所有する認証受付の調査・修理を担当者へ伝え、BellTeam側に別経路や握りつぶしを追加していない。

その後、オーナーの商用コンテナ内部先行方針を含むmain `42460b8810355205c4431a32fb7b10cc0eefe7c7`で、公開候補のrun `39887007478`は両arch・認証を含め成功した。固定indexは`ghcr.io/kitepon/bellteam-server@sha256:f49bc515e57a4eee7aac81ddf6f7203fb5e926d55d3859bd888033f825e8fedb`。内部先行のため候補digestを固定し、`latest`等の安定タグへの昇格は内部受入の結果と区別する。

## 商用コンテナの本番反映

2026-10-23 02:49 UTCに本番checkoutは`42460b8`、BellTeamコンテナは上記の固定digestへ切り替わった。`main-server`の`runtime/backups/deploy-20261023T024920.log`は`deploy-exit=0`。02:49:26と02:49:31の待機判定は実行担当`bot-7b140b27`を除くCLI・queue・runningがすべて0で`quiet:true`だった。直前の`queue-before-deploy-20261023T1149.json`は2件とも実行担当の処理で、他メンバーの処理は保存対象になっていない。旧image ID`sha256:1044f0a494517403a71279817e132e515c516030cc915b4e9accdf46e38ff0a1`は`bellteam-rollback:20261023-performance-pre59`へ保全済み。

反映後のcheckoutはtracked差分なし、healthzは`ok`。実APIの読み取りではBot62件・room6件・queue3件、選んだBotの履歴1件・予定6件をいずれもHTTP 200で取得した。SSEはHTTP 200の`text/event-stream`で`event: ready`と`data: {}`を返した。コンテナのlabel revisionは`42460b8`、Nodeは26.12.1、Aitermは0.61.8、Throughlineは0.16.43。本人の実Botやメッセージを試験用に変更していない。

実行担当トロニーは別件の決裁箱「配送修理と新共通規範を含む商用コンテナへ本番を切り替えてよい？」を正規に読み戻し、`answered`・version 3・`deploy_when_quiet`・回答02:33:58 UTCを確認した。正規deploy入口は02:49:18 UTCに1回だけ呼ばれ、ログのSHA-256は`f8a76076371588c299f63298295971f624a312a073898b9205cf4c967e9c1b81`。コンテナはhealthy・restart 0・read-only root。旧imageとCursor/内部構成の復旧点は保全され、復元操作はしていない。

担当の事後原本では、nightly backupの正規verifyはDB514件・bad 0・論理file159634件一致・取得失敗0。全514件の本番DB pathに欠落なし、代表4DBのquick_checkはすべて`ok`。反映前の直接会話14139件を保持し、JSON不正行0だった。Bot起動・配送は、オーナーの限定停止と本人再開指示に従うPepperの通常MCP1回がrunningとなり、本人の11:54 JSTの再開点検は正常・未完なしだった。全席の再開や未知本文の再送はしていない。残る限定配送の監査は別の担当作業として続くため、ここで全席の配送完了とは主張しない。

一般配布への昇格run `39892221365`は`42460b8`と上記固定digestを照合して成功し、同digestを再ビルドせず`ghcr.io/kitepon/bellteam-server:latest`と`:preview`へ反映した。内部先行の結果と安定版の実物が同じであることを、公開ジョブのdigest出力で確認した。

取得済み本文と行高の保持、余白と配置範囲の計算は履歴行数に比例する。サーバーの初期索引作成にはメモリを使い、逆時刻順の大量挿入には並べ替えコストが残る。Macのrootだけの監視通知は、対象を確定するため既知部屋の3ファイルのstatを読む。これらは今回の表示契約と通知の取りこぼし防止のため残した処理であり、実機の速度・電池消費の改善率を推定しない。
