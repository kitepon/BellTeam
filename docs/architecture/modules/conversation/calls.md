# 通話の本体受付

[担当と公開契約](README.md) / [Bridge接続登録](../bridge/README.md)。Bridge内部の通話保存と配送判断はリターが持つ。本体の公開受付と会話記録はN102が持つ。

| 窓口 | caller → 実関数 | 本体が所有すること | 外部が所有すること・失敗 |
| --- | --- | --- | --- |
| 通話directory | 通話bridge → `createCallBridgeServer` GET | 台帳refresh、公開するid/name/title/role | 通話sessionの正本はbridge。Bot一覧を会話の宛先権限に読み替えない |
| 通話配達 | bridge → POST → `receiveCallBridge` | 64KiB上限、schema/event/送信元/宛先/本文型の検証。通常会話へ受付して記録 | 全停止423、宛先不在404、配送例外502。bridgeへの応答をBotの最終回答にしない |
| 通話socket | `listenCallBridge` → runtime.close | 親dir/socket型、listen/mode、setup失敗時close/unlink。所有するsocketを片付ける | 他の通信口を新設しない。setup cleanupの失敗もAggregateErrorへ保持 |

UNIX socketのGET `/v0/directory`は`bellteam.call-directory.v1`のmembersを返す。POST `/v0/deliver`は`call-bridge.delivery.v1`、`session.message/session.reply`、`session_id/target_id/source_system/source_id/source_label/message`を検証する。source_systemはgrokbot/bellteam/local。検証済みの外側schemaだけを受口で除去し、残るfieldをcall.receiveの閉DTOへ渡す。閉DTOはschemaを受けず、未知fieldの拒否も維持する。既存のreply_required/seqを会話metadataへ渡す。本文上限は64KiBで、通常HTTPの上限へ統一しない。

通常組立てでは親がbridge actorを捕捉し、`receiveCallBridge` facade→閉`call.receive`→会話子の`BellTeamMessenger.receiveCallBridge`からwriterへ保存する。native実行には公開transport.notifyを使う。受付delivery=running/steeredは読了・業務完了・画面反映を証明しない。例外時も保存した元発言を残してfailed/stoppedを追記する。通常会話の返信をBridgeへ自動転送せず、通話MCPのcall_sendで返す案内を付ける。

Bridge内部図は[Bridge module](../bridge/README.md)から製品の正本へ辿る。本体API/MCP中継とsocket機能の有効化は統合/利用設定、席の実行はAI実行制御、共有ランタイムは実行環境へ接続する。Bridgeの未公開候補採用や製品修理を本体受付のsource分離と混同しない。

Owner recovery of a saved failed call uses the [saved delivery recovery contract](delivery.md#saved-image-and-call-delivery-recovery). Keep the original call session/event/seq and reply requirement; a call is not excluded by its sender category. Bridge peers do not receive the owner-only resume/close authority.
