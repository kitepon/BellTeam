# iPhoneで送信済み本文がキーボード再表示後に隠れる問題

オーナーが報告した「送信した吹き出しが半分だけ見える」画像について、撮影時のアプリ版とキーボード操作順は未確定。今回の隔離試験は、その画像と同じ種類の表示不良を、現行`main`の`40841b34eedab837698befedb2609e58fd1cb3cb`から再現した。実Botと本番サーバーには送信していない。

## 再現と原因

iPhone 16 Pro Max / iOS 26.5 Simulatorで、試験専用HTTPサーバーの長い返信と35件の先行履歴を表示した。本文を送信し、保留したPOSTを完了させた後、詳細画面を開閉してキーボードを開き直した。未修理では正本行の下端が`803.7pt`、入力欄上端が`567.7pt`となり、本文が約`240pt`下へ隠れた。画面画像は`runtime/apple/iphone-send-scroll-before/6CACB6F5-679C-42D2-8D5A-7D38A3D152A8.png`、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-463b47e4d06f/result-bundles/test_sim_2026-10-25T01-17-12-482Z_pid67816_6f464139.xcresult`。

会話のスクロール処理は本文の配置値を`ScrollMetricsKey`で監視していた。キーボードを開き直して見える高さだけが縮む時、本文の配置値は変わらず、従来の通知だけでは末尾へ移動しなかった。Debug時系列では、キーボードを閉じた時点の会話末尾`737pt`から再表示時の見える高さ`453pt`へ縮んだ。高さ変更に対して既存のアニメーション付き末尾移動を要求する試作は、通知を発したものの本文位置を直せず、同じ試験に失敗した。画面高さ変更時に末尾へ直接移動すると、同じ条件で本文が入力欄の上に収まった。

## 修理と確認

`ConversationView.swift`で会話の表示高さの縮小を観測し、末尾を見ているか明示的な末尾移動中の場合だけ、アニメーションなしで末尾へ追従させた。過去ログを読んでいる場合は移動しない。

- 修理前に失敗した`testAcceptedSendRemainsVisibleAfterKeyboardReopens`は修理後に成功。正本行の下端は`491.7pt`、入力欄上端は`567.7pt`。最終XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-463b47e4d06f/result-bundles/test_sim_2026-10-25T01-27-57-406Z_pid67816_b68f8874.xcresult`。
- `testKeyboardReopenKeepsOlderReadingPosition`は成功。長い返信の読書位置はキーボード再表示の前後とも`392.3pt`で、末尾へ飛ばなかった。
- 既存の`testSentTextIsVisibleAboveComposerWithKeyboardAndLongReply`も成功。以上の関連iPhone画面試験は合計3件成功。
- Mac Catalystの署名無しDebugビルド成功。Nodeの全742試験成功。`git diff --check`成功。

iPad横3列の既存画面試験は試験用Simulatorで英字QWERTYを選択できず、その条件を成立させる前に停止した。iPad版62の修理は先に実機で合格済みだが、今回の変更をiPad実機で確認した結果ではない。オーナー画像と今回の隔離再現が同じ操作順・同じ内部状態だったことも未証明。Apple内部TestFlightへの新ビルド配布と実機受入は、この候補のレビュー後に行う。
