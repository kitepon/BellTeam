# Web UI 実装確認

実行日: 2026-08-31

## focused test

- `npm test`: 12件すべてgreen。
- 会話ストア: ユーザー会話2方向、Bot間送信、Bot間受信、無関係な会話の除外を確認。
- HTTP API: Bearer token必須、Bot一覧、会話取得、ユーザー送信、未定義Bot、空本文を確認。
- 既存のBot間tmux直接配達試験もgreenを維持。

## 視覚確認

ローカルHTTPサーバーを実ブラウザで描画した。

- 390x844: メンバー一覧、一覧から個別チャットへの遷移、下部composerを確認。
- 390x844: Bot間の送信・受信が各1行で表示され、タップ時だけ相手・時刻・本文が展開されることを確認。
- 1280x720: 左にメンバー一覧、右に選択Botとの会話を置く2ペイン表示を確認。

ローカルMacのDocker CLIにはCompose pluginがないため、`docker compose config`はデプロイ先のメインサーバーで実施する。
