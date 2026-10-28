# BOT画面の履歴

認証付き `GET /api/bots/:id/screen?history=1` は、既存と同じ `{online, screen}` を返す。指定のないscreen APIは従来どおり末尾25行。履歴指定はAitermのscreen captureで端末に実在するscrollbackと現在paneを読み、既存の起動コマンド除去・空行整形後の末尾最大10000行を返す。端末自身の保持設定が小さければ、それ以前の行は取得できない。

配送と共有する読取位置を変更しない。clientは表示中のBotだけ1秒ごとに取得し、取得したsnapshotへ置換する。同じsnapshotを追記せず、過去を読んでいる間はスクロール位置を保持する。alternate画面や再描画は変化したsnapshotとして扱い、消えた行を履歴として合成しない。閉鎖は既存のoffline応答、読取中の消滅は既存のエラー処理に従う。同名セッションの再作成へ旧snapshotを持ち越さない。
