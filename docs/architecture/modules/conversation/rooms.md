# rooms — 会話・履歴

[担当と公開契約](README.md) / [全体図](../../feature-map.md)。章を旧詳細図から移管した。

## 部屋定義と会話の所有

`RoomRegistry.create/update/normalizeRoom`が名前・目的・メンバー・代表・アバターを検証し、`rooms/<id>/room.json`に保存する。`refresh`はファイルmetadataでcacheを確認し、現在のBot台帳に照らして正規化する。MCPの参加者/代表資格は`room-access.mjs`の公開helperを使う`callConversationTool`が持ち、投稿の資格と参加者snapshotはRoomMessenger側であり、保存の型検証とは別である。

`appendMessage`が`messages.jsonl`のwriter。`messages/messageView`は同じRoomHistoryを使用する。`watch`はroom/schedule/messagesのstat差分をtopicへ変換する。履歴初出・inode置換・縮小・同サイズ書換えは全体通知へ、通常追記は対象roomへ。Macで親名しか来ない時は既存fileのstatで確認し、名前から対象を推定しない。監視で失敗した時も未知の変更を無視せずallを通知する。
