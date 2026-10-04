# Aiterm会話とルーム実装証跡

観測日時: 2026-08-31T12:00:52.000Z

- `node --test test/aiterm-transport.test.mjs test/messenger.test.mjs test/room-registry.test.mjs test/room-messenger.test.mjs test/mcp-tools.test.mjs test/http-server.test.mjs`: 成功。
- `npm test`: 34件成功、失敗0件。
- `node --check web/app.js`: 成功。
- 実ブラウザ390x844: 追加メニュー、Bot追加フォーム、2 Botを着席させたルーム作成、作成直後のルームチャット遷移を確認。
- ローカルDocker build: Docker daemon停止のため未実施。メインサーバーで同一Dockerfileをbuildしてintegration確認する。

実装した挙動:

- ユーザーとBotの通常会話はAitermのevent cursorを待ち、`done`後の確定回答だけを会話へ記録する。
- Bot間直接通信とルーム通信はAitermへのdispatch受理で返り、受信Botの確定回答は自動転送しない。
- 直接通信には送信者ID・名前・役割、ルーム通信には部屋・目的・代表・全メンバー・送信者・対象者を含める。
- 画像は一時ファイルとしてターン完了まで維持して削除し、Botプロジェクト内の画像パスは削除しない。
- Botプロフィールを名前と役割へ分離し、ルーム設定・会話・一部宛先・予定をMCPとWeb API/UIへ追加した。
