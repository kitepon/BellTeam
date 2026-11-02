# メンバー・予定

責任者：ベロータ。

作成・プロフィール・削除完了、規範/起動指示、Bot/部屋の予定定義と発行。部屋台帳本体はN102。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 所有データと公開契約

- [メンバー・予定・指示](registry.md)：Botのprofile/schedule、専用project構造・個別指示・画像、Owner profile/rulesと指示生成。全製品共通テンプレート`config/common-agents.md`は統合担当が持つ。
- [削除](deletion.md)：通常DELETE/MCPの受付、activeからの退役、既pendingの再開、専用データ削除、CLI同期との独立した成否。
- [予定](schedules.md)：Bot/部屋予定のMCP説明/schema/handler、HTTP受付、共通定義と発行。部屋の公開資格helperを使用する。
- [プロフィール・画像](profiles.md)：9つのMCP説明/schema/handlerと一覧/profile/画像のHTTP受付。実行設定はexecutionへ委譲する。
- [Owner個別規範・起動指示](instructions.md)：読取/更新の専用窓口、保存後の生成、共通テンプレートとの境界。

| 公開窓口 | 入出力と所有者間の境界 |
| --- | --- |
| registry | BotRegistryのprofile/create/update/hasPendingRemoval/remove/listForClient。profiles-mcp/profiles-httpとdeletionのschema/handlerをmembersが所有。実行対象はactive Map、HTTP一覧はpending receiptを含む |
| schedules | `members/schedules-mcp.mjs`のBot/部屋6道具と`members/schedules-http.mjs`の公開handler。Bot/RoomRegistryのlist/set/remove/mark、共通schedule-definition/schedule-mutations、scheduler発行は維持。部屋正本・targets/資格helper・command拒否はconversation |
| instructions | owner-httpと既専用mcp-owner-tools、profiles-mcpのOwner読取。ProjectFiles個別指示/startup context、OwnerProfile/UserRules保存、global-instructionsの再生成。保存成功と生成失敗を区別。共通テンプレートは統合担当 |

使用する公開窓口はexecution.stop/configuration/observation、runtime.project-files/cli-registration、conversation.membership-cleanup/messages/room-access/history、memory.memory。共有CLI JSON、RoomRegistryの部屋正本、native停止の内部へ直接書き込まない。

## source分離の成立範囲

削除はmembersのmodule内で内部修理と公開handler/schema・関連試験を変更でき、BotAdministration/HTTP/MCPの共有入口は委譲・登録だけを持つ。初回入口差分は統合担当が取り込む。

予定のMCP説明/schema/handlerとHTTP受付もmembersへ分離した。RoomRegistry予定APIは維持し、部屋の資格にはconversationの`room-access.mjs`公開helperを使う。

プロフィール/画像/Owner個別規範の公開受付もmembersへ分離した。mcp-tools/http-bot-api/http-application-apiはmembersの登録/呼出を行い、残る実行/記憶/会話の業務は各担当へ委譲する。画像返却などの共通整形、認証・共通エラー・service組立てはintegrationが持つ。

members内部/schema/説明/HTTPの次の変更は、他機能の内部や保存データを編集せず行える。公開契約を変える時は相手と合わせる。初回共有入口の統合、main採用、本番反映と実対象の処理完了は別に確認し、このsource差分は本番反映を含まない。
