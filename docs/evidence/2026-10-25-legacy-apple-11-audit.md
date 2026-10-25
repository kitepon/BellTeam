# 旧Apple診断11件の分類共通調査

旧診断11件は、当時の画面・応答本文・サーバー内部状態を復元できない。各件の通信種別と、現在のAppleアプリを人工条件で動かした結果を結び、担当する状態の境界を記録する。人工試験で元件を解消済みにはしない。

## 書き込み5xx：3件

メッセージPOST 503 `aa88228ef94f29780973bff78679da03a90f729172659ee62f57d0224251b89b`は[本文・画像の保持と明示再試行](2026-10-25-legacy-apple-post-503.md)、メッセージPOST 500 `b7ba16cde1238790f2c81859a819201e974166b6c8859eeb30bc4d848d111b1c`と停止POST 502 `74e509a86df1b237f0fc23dd76ef048d7151d562c124064cc2de187f7dfa8974`は[書き込みの人工画面](2026-10-25-legacy-apple-write-5xx.md)で確認した。Appleは送信失敗後の下書き・添付・既存行を保持し、停止の結果不明を表示する。変更POSTを自動再送せず、利用者が明示的に押した次のPOSTとGETを記録した。5xxを返した本体側の原因は本体の所有で、人工500/502/503の成功から原因を補わない。

## GET時間切れ`-1001`：4件

Bot一覧 `8343d1f5086fa530990491f14cca5cb3ac70adcba3f5c27293c9d1af0dd61c4a`と会話 `52b5ec54030ebaf626d7ef820d36503e8c3dc64e201b871a90be62ee1d9d820c`は[Storeと会話画面](2026-10-25-legacy-apple-read-timeout.md)、予定 `03caf6627f0a3fc22f95f329fa63e0259ec25df926c942fa9d15f4936235f713`と処理待ち `44906d2387428e5108c0384c1c742e1cda0d4f6c36fef68ee4df3f8592fdaef4`は[予定・処理待ち画面](2026-10-25-legacy-apple-schedules-queue-timeout.md)で確認した。既知のデータを残して時間切れを表示し、失敗後に自動GETを増やさず、利用者が再表示した後の正常GETで戻る。Bot一覧は注入`URLError.timedOut`のStore試験で、他の3つは人工HTTPを実際のURLSession時間切れまで待つ画面試験である。元の60秒遅延箇所は不明。

会話画面では1回の復帰時に会話GETが同時に2本出た。この試験では両方を保留してから時間切れと次の明示GETを判定した。2本の発生理由と、通常環境で利用者に害があるかは未確認で、現時点で製品欠陥や必要なguardとは判定しない。

## TLS・SSE・通知登録：4件

モデルGET TLS `-1200` `2f6b9daed6a3e57a5adfb4d6ac92d8bcd8931904161353c1c47bee092a058e66`、予定GET TLS `-1200` `061c46a64270dad38e6eaded6a79c6c7751058788c7959f08b420d3a62dec2db`、SSE GET 502 `95eef79b1e34dfcba7b55bb3ad1a54bbc1da5a272be7a271faeabe5ca7c030cd`、通知登録POST `-1001` `faab4b9ef06c02f7e957c0ed46def26ce17ae62bb8d9328e96710f8e17e72d68`は[TLS・SSE・通知登録の人工通信](2026-10-25-legacy-apple-tls-sse-push.md)に記録した。TLSは予定GETの`BellAPI`境界で診断と次の明示GETを確認し、モデル編集画面と実証明書は未測。SSEはiPhoneの502→再接続表示→`ready`後の消去を画面で確認した。通知登録は人工tokenの`BellAPI`/診断境界だけで、OSのAPNs token発行・`BellNotifications`の登録状態・配達は未測。

## 判定と境界

分類共通の人工条件で、書き込み5xx、GET時間切れ、TLS、SSE、通知登録の現在の処理を確認した。Apple製品コードを変更すべき再現欠陥はこの結果からは特定できず、通信を返す本体、TLS接続基盤、APNsのOS/providerの責務をAppleへ移さない。旧11件の原因・当時の操作結果・実環境での回復は未確定のまま保持する。人工試験が作った同じ診断fingerprintを元件の再発や解消と数えない。

実Bot、オーナー通常アプリ、実APNs token、認証、公開サービス、本番コンテナへの操作は0。今回の人工試験で起動したサーバーは停止、SimulatorはShutdownを確認した。

証拠を統合した現`main`から`TESTGATE_FULL=1 npm test`を1回実行し、全99ファイルで終了コード0だった。
