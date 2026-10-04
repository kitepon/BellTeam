# オーナープロフィール安全網

実行日: 2026-09-01

## 追加した契約

- JSON正本の初期化、更新、再読込、URL検証、アバター非注入。
- 認証済みWeb APIの取得と更新。
- 全Botが利用できるMCP `get_owner_profile`。
- セッション起動と通常配送が、その時点のオーナープロフィールを受け取ること。

## 実装前のfocused test

実行:

`node --test test/owner-profile.test.mjs test/http-server.test.mjs test/mcp-tools.test.mjs test/aiterm-transport.test.mjs`

結果:

- 30件成功。
- 4件失敗。
- 失敗は未実装の`src/owner-profile.mjs`、`GET/PATCH /api/owner`、MCP `get_owner_profile`、Aiterm起動・配送へのオーナー文脈添付に限定された。
- 既存契約の失敗はなかった。

この赤状態を実装前の安全網として固定し、同じfocused testを実装後に緑へする。
