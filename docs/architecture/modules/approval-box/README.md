# Approval Boxとの接点

担当：ナユタ。承認と回答配送の公開接点。

製品図の正本は[受入候補4a4f0e1の設計索引](https://github.com/kitepon/approval-box/blob/4a4f0e1e3e85ff784e9af6d62876aa2b324aa322/docs/refactoring/README.md)。全体→7詳細→flows→code索引へ辿る。PR15候補であり、本番反映済みとしない。[接点の保守手順](/srv/bellteam/bots/bot-4366a50b/docs/approval-box/architecture-maintenance.md)を参照し、内部図を複製しない。

公開窓口は製品docs/api.mdのsession /v1、connection /connector/v1、remote POST /mcp、connector stdio MCP/CLI。診断はdocs/diagnostics.md。製品Web/APNs/DB/connectorはナユタ、BellTeam質問/通知はミカ、会話受付はN102、実行はキロ、登録はエピネル。配送unknownを成功へ変えない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
