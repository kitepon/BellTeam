# iPhoneで送信済み本文がキーボード再表示後に隠れる問題

オーナーが報告した「送信した吹き出しが半分だけ見える」画像について、撮影時のアプリ版とキーボード操作順は未確定。今回の隔離試験は、その画像と同じ種類の表示不良を、現行`main`の`40841b34eedab837698befedb2609e58fd1cb3cb`から再現した。実Botと本番サーバーには送信していない。

## 再現と原因

iPhone 16 Pro Max / iOS 26.5 Simulatorで、試験専用HTTPサーバーの長い返信と35件の先行履歴を表示した。本文を送信し、保留したPOSTを完了させた後、詳細画面を開閉してキーボードを開き直した。未修理では正本行の下端が`803.7pt`、入力欄上端が`567.7pt`となり、本文が約`240pt`下へ隠れた。画面画像は`runtime/apple/iphone-send-scroll-before/6CACB6F5-679C-42D2-8D5A-7D38A3D152A8.png`、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-463b47e4d06f/result-bundles/test_sim_2026-10-25T01-17-12-482Z_pid67816_6f464139.xcresult`。

会話のスクロール処理は本文の配置値を`ScrollMetricsKey`で監視していた。キーボードを開き直して見える高さだけが縮む時、本文の配置値は変わらず、従来の通知だけでは末尾へ移動しなかった。Debug時系列では、キーボードを閉じた時点の会話末尾`737pt`から再表示時の見える高さ`453pt`へ縮んだ。高さ変更に対して既存のアニメーション付き末尾移動を要求する試作は、通知を発したものの本文位置を直せず、同じ試験に失敗した。画面高さ変更時に末尾へ直接移動すると、同じ条件で本文が入力欄の上に収まった。

## 修理と確認

`ConversationView.swift`で会話の表示高さの縮小を観測し、末尾を見ている場合だけ、アニメーションなしで末尾へ追従させた。過去ログを読んでいる場合は移動しない。明示的な末尾移動の途中という追加条件は今回の再現では通らず、修理対象へ含めなかった。

- 修理前に失敗した`testAcceptedSendRemainsVisibleAfterKeyboardReopens`は修理後に成功。正本行の下端は`491.7pt`、入力欄上端は`567.7pt`。最終XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-463b47e4d06f/result-bundles/test_sim_2026-10-25T01-27-57-406Z_pid67816_b68f8874.xcresult`。
- `testKeyboardReopenKeepsOlderReadingPosition`は成功。長い返信の読書位置はキーボード再表示の前後とも`392.3pt`で、末尾へ飛ばなかった。
- 既存の`testSentTextIsVisibleAboveComposerWithKeyboardAndLongReply`も成功。以上の関連iPhone画面試験は合計3件成功。
- iPad Pro 11-inch (M5) / iOS 26.5 Simulatorで、横3列・右プロフィールあり/なし・英字QWERTY・キーボード開閉/入力再開の既存focused UI試験が1件成功。最初の実行は試験が大文字`Q`だけを探して停止したが、録画で小文字`q`の英字配列を実見し、試験側の判定だけを直した。成功XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-9cdb5724cf73/result-bundles/test_sim_2026-10-25T01-52-42-641Z_pid49762_496f8b95.xcresult`。
- Mac Catalystの署名無しDebugビルド成功。Nodeの全742試験成功。`git diff --check`成功。

iPad版62の修理は先に実機で合格済みだが、今回の変更をiPad実機で確認した結果ではない。オーナー画像と今回の隔離再現が同じ操作順・同じ内部状態だったことも未証明。

## 版63の内部配布

修理PR #72と版番号PR #73は、トロニーの独立レビューとセンチの事前受入で必須修正0件となり、GitHub `main`の`d490e0e0ebb8e14c0cc66bcfa925f31fdf0b6aec`へ通常統合した。決裁箱「BellTeam版63を署名してオーナー内部TestFlightへ配布する」の許可を確認してから、同じソースでiPhone/iPad版とMac版を署名・書き出し・Apple事前検証・各1回アップロードした。両方とも`VALID`となり、既存の「BellTeam オーナー」内部グループで`IN_BETA_TESTING`を読み戻した。成果物のSHA-256、Apple build IDと署名・配布状態は[非秘密manifest](2026-10-25-apple-build63-manifest.json)へ固定した。

MacのTestFlightは既に「開く」を表示し、`/Applications/BellTeam.app`は本体・通知拡張とも63、厳格な署名検査とGatekeeperの`source=Testflight`を通った。既に起動していた版63の画面でメンバー一覧と詳細が表示されることを読み取った。確認のために実メンバーへ送信したり、起動中のアプリを再起動・終了したりしていない。`jev-desktop`は対象候補を一意に選べず操作前に停止したため、上流`agent-desktop`で画面を読み取った。

iPhone版63の通常使用で送信本文が入力欄の上に全文見えるかは、決裁箱「BellTeam版63のiPhone送信本文の見え方を通常使用で確認する」の回答待ち。確認専用の新規送信は求めていない。一般App Store公開とBellTeam本番コンテナ更新は行っていない。
