# Throughlineとの接点

担当：リヴァリン。会話記録・引継ぎの公開契約。

製品内部図の正本は[Three-layer memory model](https://github.com/kitepon/Throughline/blob/main/README.md#three-layer-memory-model)、詳細索引は[docs/00_overview.md](https://github.com/kitepon/Throughline/blob/main/docs/00_overview.md)。[担当手順と接点](/srv/bellteam/bots/bot-220e0f1b/docs/throughline-maintenance.md)へリンクし、内部図は複製しない。

`context`はhandoff-context（throughline.handoff_context.v1）、observer-read（v1/v2）、room-context（throughline.room_context.v1）。hook登録はinstall、診断はfactory-diagnostics。起動/配送はキロ、部屋/自主回答はN102、記憶の利用方針はビスケット、席実行/hook登録はエピネルへ接続する。

self-turns.mjsとrun-seat-runtime.mjsのDB/WAL mtime参照は既存の私有ファイル名依存として残る。公開窓口だけに分離済みとはしない。解消時は製品所有者とconversation/runtimeの契約を合わせる。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
