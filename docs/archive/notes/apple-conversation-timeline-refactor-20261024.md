# Apple会話履歴の状態分離

出典: Apple版61の`ConversationView.swift`・`BellAPI.swift`・`Models.swift`、`docs/current-design.md`の会話契約、隔離Simulatorの回帰試験。取得日: 2026-10-24。確度: 変更したソースと記載した試験で確認。

`ConversationTimelineState`は、サーバーから読んだ会話履歴を正本として保持し、送信中の本人発言だけを画面用に重ねる。受理された発言は本文ではなく既存のサーバーIDで突き合わせ、最新ページにある既知行の配送状態を更新し、cursor以降の新着だけを末尾へ加える。過去ページは既知IDを重複させず先頭へ加える。この型はHTTP要求、SSE接続、永続化、再送、画面のスクロールを持たない。

`ConversationView`は宛先ごとのGET/POST、購読確認と送信結果の扱い、下書き・添付画像の復元、画面が開いている間の取得取消、キーボードとスクロールを引き続き所有する。受付応答まで履歴GETの反映を保留するため、IDがまだ分からない仮行と先着SSEの正本を二重に表示しない。APIの経路・JSON、直接会話の`delivery_id`とルームの`id`、自動再送しない扱い、末尾追従と過去ログの読書位置は変更しない。iPhone・iPad・Macは同じ状態型と会話画面を使う。

`ConversationTimelineStateTests`は同文2件を既存IDごとに照合し、既知行の配送状態・新着・過去ページの統合を確認した。iPhoneの関連UI試験では受付前の仮行、正本への置換、キーボード上の可視性、過去ログ閲覧時の位置を確認した。Mac Catalystの共通コードをビルドした。サーバー本体と他OSSのソース、Apple配布物、本番環境は変更しない。

隔離Simulatorの単体2件と会話UI4件、Mac Catalyst Debugビルド、`TESTGATE_FULL=1 npm test`の全711件が成功した。UI試験は人工HTTP履歴とSSEだけを使い、実Botへ送信していない。Appleの内部配布と実機導入はこの隔離リファクタリングに含めない。

次の候補は、会話のURLとページ指定を`BellAPI`の公開メソッドへ閉じ、Viewから経路文字列の組立てを外すこと。今回の差分には含めない。
