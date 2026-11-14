# call-bridge/grokbot-bridgeとの接点

担当：リター。通話製品と公開接続。

製品図の正本は[Bridge設計索引](/srv/bellteam/bots/bot-df96182b/grokbot-bridge/docs/architecture/README.md)。overview.svgから6詳細図とsource-indexへ辿る。編集原本のDOTも製品側だけで管理する。[本体との契約](/srv/bellteam/bots/bot-df96182b/docs/bridge-bellteam-contracts.md)へ入出力と配送分類を接続する。

## BellTeamへ約束する入口（2026-11-14 Owner：製品の間は契約された入口だけ、a105）

正本は製品repoの `docs/architecture/connection-handoff.md`。旧い総称 `public` と `conversation.messages` の利用は次の名前付きの入口に分けた。

| 入口（接続線の名前） | 中身 | BellTeam側の使い手 |
| --- | --- | --- |
| `connection export (call-bridge.connection.v1)` | `python3 scripts/export_connection.py --json`（deploy userで実行）、`{schema, url, token}`。.envや発行済みheaderファイルは読まない | runtime（モリー、bd10、ホストで実行して取込み口へ渡す）、usage（ミカ、bd11、形を検証して保存） |
| `MCP /mcp` | HTTP /mcpのcall_open/send/poll/list/hangup/info/history/receipt/directory | integration（モリー、席の中継）、runtime（モリー、CLIへの登録） |
| `call-bridge delivery (/v0/directory, /v0/deliver)` | 橋からBellTeamへの向き。UNIX socketの /v0/directory・/v0/deliver、call-bridge.delivery.v1 | conversation（N102）が提供し、橋が呼ぶ |

従来の説明：HTTP /mcpのcall_open/send/poll/list/hangup/info/history/receipt/directory。conversation.messagesはUNIX /v0/directory・/v0/deliverとcall-bridge.delivery.v1で利用する。受付running/steeredは読了・完了を意味しない。N102が通話受付、ミカが利用設定、エピネルが登録、トロニーが共通中継/統合を持つ。製品内部図をここへ複製しない。担当の未公開候補を本番供給済みとしない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
