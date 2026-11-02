# call-bridge/grokbot-bridgeとの接点

担当：リター。通話製品と公開接続。

製品図の正本は[Bridge設計索引](/srv/bellteam/bots/bot-df96182b/grokbot-bridge/docs/architecture/README.md)。overview.svgから6詳細図とsource-indexへ辿る。編集原本のDOTも製品側だけで管理する。[本体との契約](/srv/bellteam/bots/bot-df96182b/docs/bridge-bellteam-contracts.md)へ入出力と配送分類を接続する。

`public`はHTTP /mcpのcall_open/send/poll/list/hangup/info/history/receipt/directory。conversation.messagesはUNIX /v0/directory・/v0/deliverとcall-bridge.delivery.v1で利用する。受付running/steeredは読了・完了を意味しない。N102が通話受付、ミカが利用設定、エピネルが登録、トロニーが共通中継/統合を持つ。製品内部図をここへ複製しない。担当の未公開候補を本番供給済みとしない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
