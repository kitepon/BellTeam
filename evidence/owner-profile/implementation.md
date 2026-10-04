# オーナープロフィール実装結果

実装日: 2026-09-01

## 実装

- `src/owner-profile.mjs`が`/srv/bellteam/owner/profile.json`の初期化、取得、更新、検証、Bot向け文脈生成を所有する。
- `GET /api/owner`と`PATCH /api/owner`を認証済みWeb APIへ追加した。
- BellTeam MCPへ`get_owner_profile`を追加した。
- Aitermの新規・復元起動、通常配送、明示的な割り込みへ、配送直前に読み直した現在のオーナー文脈を添付する。
- アバターdata URLはBot向け文脈へ含めない。
- 左上のオーナーアバターから設定画面を開き、名前、プロフィール、X、GitHub、名称付きその他URL、切り抜き済みアバターを編集できる。
- Botとオーナーのアバター編集は同じ切り抜き部品を使う。
- 共通規範には現在値を複製せず、添付文脈と`get_owner_profile`を正本として扱う固定指示だけを追加した。

## focused test

実行:

`node --test test/owner-profile.test.mjs test/http-server.test.mjs test/mcp-tools.test.mjs test/aiterm-transport.test.mjs test/messenger.test.mjs test/room-messenger.test.mjs test/scheduler.test.mjs test/chat-input.test.mjs`

結果: 57件成功、失敗0件、skip 0件。

実装commit:

- `6520d3b` オーナープロフィール正本、API、MCP、全配送共有。
- `87b5a9e` 左上アバターと設定画面、共通アバター切り抜き部品。
