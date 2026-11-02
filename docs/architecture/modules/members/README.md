# メンバー・予定

責任者：ベロータ。

作成・プロフィール・削除完了、規範/起動指示、Bot/部屋の予定定義と発行。部屋台帳本体はN102。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 所有データと公開契約

- [メンバー・予定・指示](registry.md)：Botのprofile/schedule、専用project構造・個別指示・画像、Owner profile/rulesと指示生成。全製品共通テンプレート`config/common-agents.md`は統合担当が持つ。
- [削除](deletion.md)：通常DELETE/MCPの受付、activeからの退役、既pendingの再開、専用データ削除、CLI同期との独立した成否。
- [予定](schedules.md)：Bot/部屋予定のMCP説明/schema/handler、HTTP受付、共通定義と発行。部屋の公開資格helperを使用する。

| 公開窓口 | 入出力と所有者間の境界 |
| --- | --- |
| registry | BotRegistryのprofile/create/update/hasPendingRemoval/remove/listForClient。実行対象はactive Map、一覧はpending receiptを含む。削除のHTTP handler/MCP schema・handler/業務は`src/members/deletion.mjs`が所有 |
| schedules | `members/schedules-mcp.mjs`のBot/部屋6道具と`members/schedules-http.mjs`の公開handler。Bot/RoomRegistryのlist/set/remove/mark、共通schedule-definition/schedule-mutations、scheduler発行は維持。部屋正本・targets/資格helper・command拒否はconversation |
| instructions | ProjectFilesの個別指示とstartup context、OwnerProfile/UserRules保存、global-instructionsの再生成。保存成功と生成失敗を区別。共通テンプレート差分は統合担当へ |

使用する公開窓口はexecution.stop、runtime.project-files/cli-registration、conversation.membership-cleanup/messages/room-access、memory.memory。共有CLI JSON、RoomRegistryの部屋正本、native停止の内部へ直接書き込まない。

## source分離の成立範囲

削除はmembersのmodule内で内部修理と公開handler/schema・関連試験を変更でき、BotAdministration/HTTP/MCPの共有入口は委譲・登録だけを持つ。初回入口差分は統合担当が取り込む。

予定のMCP説明/schema/handlerとHTTP受付もmembersへ分離した。RoomRegistry予定APIは維持し、部屋の資格にはconversationの`room-access.mjs`公開helperを使う。

プロフィール/画像/Owner規範の混在HTTP/MCP抽出は続く。担当移管、source分離、本番反映は別の成立条件であり、このsource差分は本番反映を含まない。
