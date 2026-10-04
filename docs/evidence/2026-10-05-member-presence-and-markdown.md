# メンバーの仕事中表示と会話のMarkdown表示

## 実装と配布

2026-10-05に、アプリ改修の`7a36e3a`と配布番号の`05366f4`をGitHubのmainへ反映した。iPhone・Macのビルド1.0（40）は配布署名付きで書き出し、App Store Connectの`VALID`とオーナーグループの`IN_BETA_TESTING`を確認した。

- メンバー一覧は、待機中を緑、仕事中を赤の点滅、オフラインを灰色で表示する。共通の`BotPresenceDot`をiPhoneとMac・iPadの画面で使う。
- `AppStore`が既存の`/api/queue`の`running`と`botId`から仕事中のメンバーを取得し、SSE通知後の再取得で更新する。サーバー変更とコンテナの再起動は不要。
- 共通の`MessageText`に[EnrichedMarkdown](https://github.com/software-mansion-labs/enriched-markdown-ios)を採用した。見出し・表・箇条書き・引用・コードの標準表示を使い、本文の範囲選択・コピー、表のコピー、リンクを維持する。

## 検証

- iOSの最終試験は77件成功、失敗なし、3件スキップ。スキップは実接続先・秘密入力のHTTPS試験サーバー・iPadの外付けキーボードを必要とする既存試験。
- 部分選択のコピーと表の列のコピーを実際の本文ビューで確認した。最終画面試験ではリンクを開く操作と、長短の本文が更新される間のスクロール・入力欄・詳細画面の操作を確認した。
- iPhoneシミュレーターとMac Catalystの画面で、見出し・表・箇条書き・引用・コードの配置を確認した。Macの試験用会話はJevで開いた。
- Nodeの全362件が成功した。
- 配布物のアプリ本体と通知拡張は両OSともビルド40。配布署名とMacのパッケージ署名を確認した。
- 本番データは変更せず、本番コンテナも再起動していない。

## 手元への導入待ち

このMacの導入済みアプリはビルド39。通常のファイル更新は管理者所有のため拒否され、TestFlightの操作もJevが完了できなかった。未更新を導入済みとは扱わない。試したインストーラは閉じ、既存アプリの署名が有効であることを確認した。

残る操作は、MacとiPhoneのTestFlightでBellTeamをビルド40に更新すること。更新後に導入した版と起動を確認する。アプリの手動コピーとアップロード用パッケージの手動導入は使わない。

署名済み配布物、試験結果、画面、Jevの実行記録、Appleの配布確認はGit管理外の`runtime/apple/markdown-presence-40/`と`runtime/markdown-presence-*.xcresult`に保存した。旧Mac版は`runtime/apple/markdown-presence-40/Mac-39.app`へ退避した。
