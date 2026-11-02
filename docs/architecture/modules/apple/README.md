# Appleアプリとの接点

担当：ベル。Apple各画面と配布。

Apple内部の機能図は未作成（担当ベルの2026-11-02回答）。現在の資料は[iOS README](../../../../ios/BellBot/README.md)と[iPad設計](../../../ipad-app.md)、実装はios/BellBot。次のコード変更前に該当範囲の図を製品担当が整える。内部図が揃ったとはしない。

範囲図：[予定一覧の取得](schedule-list.md)。

本体への提供窓口はなく、利用側としてHTTP /api/*とSSE /api/eventsを使う。MCP利用はない。会話はN102、設定/通知はミカ、モデル操作はキロ、更新実行はエピネルへ、共通HTTP/SSEはトロニーへ接続する。ベルはlocalチームのためBellTeam botIdを持たず、連絡はトロニーの既call-bridge通話から中継する。

商用更新は[Webとの共通状態設計](../web/update-notice-design.md)へ接続し、新機能は未実装。ロゴ右を置けない画面の通知帯は未採用の代替案で、Ownerの配置指示を変更したことにしない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
