# メンバー削除の受付・再開・完了

[担当の正本](README.md)。実装は[deletion.mjs](../../../../src/members/deletion.mjs)と[BotRegistry](../../../../src/bot-registry.mjs)。

```mermaid
flowchart TD
  Input["DELETE /api/bots/:id<br/>MCP delete_bot"] --> Target{"active / 既pending / 不在"}
  Target -->|"不在"| Missing["404 / BOT_NOT_FOUND<br/>副作用なし"]
  Target -->|"active"| Accepted["202 / deleting:id<br/>受付のみ・背景で実行"]
  Target -->|"既pending"| Resume["202 / deleting:id<br/>同じ削除意図の再開"]
  Accepted --> Stop["execution.stop<br/>席終了"]
  Stop --> Rooms["conversation.membership-cleanup<br/>部屋・予定targetsから外す"]
  Rooms --> Gate["対象Bot画像の新save停止・旧save終端"]
  Gate --> Record["receipt保存・active Map退役<br/>stateを.deletingへrename"]
  Record --> Listing["通常一覧へdeletingを保持"]
  Record --> Cleanup["runtime.project-filesで専用project削除<br/>pending state→receiptを削除"]
  Resume -->|"native停止・部屋整理を繰り返さない"| Cleanup
  Cleanup -->|"完了"| Absent["一覧・project・pending不在"]
  Cleanup -->|"失敗"| Pending["BOT_DELETE_PENDING<br/>pending維持・明示再開可"]
  Absent --> Sync["active台帳を入力に<br/>runtime.cli-registrationへ一回同期"]
  Pending --> Sync
  Sync -->|"失敗"| SyncError["configurationSync:failed<br/>削除の実態と別に記録"]
```

## 入出力と失敗の公開契約

| 窓口 | 契約 |
| --- | --- |
| HTTP `createMemberDeletionApi({administration})` | DELETEだけを受け、`administration.remove(id)`の受付を202/{deleting:id}で返す。GET/PATCHの既pendingは従来どおり404 |
| MCP `deleteBotTool/runDeleteBotTool` | schemaと説明もmembersが所有。botId省略時はfrom。callerはactiveな席として従来の共通認証を通る。既pendingは実行Map不在でも同じinternalApi.remove→HTTP入口へ送れる |
| `startMemberRemoval` | activeはstop→rooms.removeBot→bots.remove。stop/部屋整理の失敗では後続を進めずwriteLog。pendingは既存削除意図だけを再開し、別のnative sessionを起動/停止しない |
| `BotRegistry.hasPendingRemoval(id)` | IDを検証し、split stateの既pending directory又はreceiptの有無を返す。active/不在の分類のためだけに実行Mapへ再採用しない |
| `BotRegistry.remove(id)` | 通常`{id}`。cleanup完了・CLI同期失敗時は`{id,configurationSync:{state:'failed',name,message,code?,status?}}`。同期はcleanup試行後に一回。共有writerの既onChange(bots) Promise/reject契約は変えない |
| cleanup失敗 | `BOT_DELETE_PENDING`をthrowしpendingを残す。同期も失敗した場合は同じ例外の`configurationSync`へ独立した失敗を添える。背景moduleが同期失敗と削除失敗を別のlogへ各一回記録 |
| 同じ対象への並行更新/削除 | BotRegistryの既存プロフィール変更順序でremoveも直列化する。receipt作成途中へ別のcleanupが割り込まない。先の削除完了後は不存在として扱う |
| 初期化の既pending再開 | resumePendingRemovalsの既契約を維持。active stateだけ残る準備receiptを外し、active/pending両方なら競合。CLI同期はbootstrapの別工程 |

configurationSync失敗で削除を未完へ戻したり、削除成功として同期成功を補完したりしない。独立したlogは`BellTeam CLI configuration sync error after delete: <id>:`、cleanup失敗は`BellTeam delete error: <id>:`。自動再送・新しい永続queue・native起動は加えない。

一覧ではreceiptを保持する間deleting=true/online=false。project・pending state・receiptが消えた時だけ通常一覧から消える。背景受付202を物理削除完了として表示しない。room自体の削除はconversationの別契約。

## 所有データ、caller、限定検証

membersは`state/bots/<id>`、`.deleting/<id>`と`<id>.json`、専用`bots/<id>`の削除意図と順序を持つ。projectの実操作はruntimeの公開proxy、部屋参照整理はconversation、native停止はexecutionへ委譲する。共有CLI JSONを直接読書きしない。

直接callerはHTTPの登録、MCPの登録と席API中継、BotAdministrationの委譲、BotRegistryのremove/初期化resume、一覧投影。既export/設定/fixtureは保ち、共通入口の初回差分だけを統合担当へ渡す。機能図はpendingの正規受付と同期失敗の独立を反映し、全体には既存callbackのruntime.cli-registration接続を登録した。

`test/member-deletion.test.mjs`で同期失敗時のcleanup、cleanup失敗との同時報告、receiptだけ/dirだけ/両方のpendingを正規MCP→HTTPで再開、GET/PATCH/完全不存在の拒否、native呼出0、無関係Bot保持、並行cleanupを確認する。既Bot state/registry/Administration/HTTP/MCP/席API試験を直接境界として併走する。

これはsourceと隔離fixtureの修理。実対象Andersonへの再DELETE、手動rm、状態手変更、実席の停止/再起動、本番反映は行っていない。共有JSON競合の修理はruntime担当、外部CLI writerの競合解消までをこの差分の保証に含めない。

## 独立更新でのleaseと画像gate

親startMemberRemovalはtransportと同じMembersAdmissionから一leaseを取り、fresh refresh/target確認→既stop→Room整理→子profile.removeの完了まで保持する。HTTP202を返しても背景処理終端までfinishしない。各bots refresh/hasPending/removeとtransport.stopの追加optionsは同opaqueで、新root化しない。pendingは従来どおりnative停止/Room整理を繰り返さない。

子`profile.remove({botId})`は既BotRegistry.removeの完了返却（id/configurationSync）を持ち、native stop/Room整理は親で既に済ませる。子は固定assets.prepareBotAssetRemoval `{botId}` effectでopaque string leaseを得てからreceipt/退役へ進み、project/CLIは同rootの固定effect。prepare不明/失敗では退役0。親conversationの同一MessageAssetsへ接続し、別writerを作らない。

BotRegistryのassetRemoval adapterはprepare/cancelの2関数。早期失敗時だけ同削除operation順序内でfresh refresh/active/intent/pending/退役を短い状態lockで確認し、active=true/hasIntent=false/retired=falseと同opaqueを固定cancel effectへ渡す。保存lockは外部待ち前に解放し、次の削除operationは早期中止終端まで開始しない。unknown、receipt残存、退役済み、fresh検査失敗ではcancel0。callbackへ値を自己申告させず、一覧不在から許可しない。

親CLI唯一queueは実開始時に専用callback`profiles.cli({})`→`{botIds:[id]}`を同leaseで取得する。childのrefresh→keysだけで、外部effect/状態mutation lock/投影送信/新root0。子effect送信時のbotIdsをそのまま採用せず、親がroot/bots/idへ解決する。

## conversation子導入の部屋整理context

```mermaid
flowchart LR
  Reserve[共通moduleOperations.reserve / 作用前両入場] --> Existing[親削除受付の同opaque context]
  Existing --> Stop[既execution stop]
  Stop --> Rooms[親安定Room facade removeBot]
  Rooms --> Remove[子profile.remove / 親画像gate / rename]
```

rooms.removeBot(botId, options)へfresh/stop/profile.removeと同じ内部optionsを渡す。親stable facadeはconversation子の唯一Room writerへ委譲し、当callerはpath/別writerを持たない。202返却後も削除背景終端まで同leaseを維持する。BotAdministrationとstartMemberRemovalはmoduleOperationsを受け、refresh/native停止/intentより前にreserve()する。一方拒否なら202前にnot_acceptedで作用0。fresh失敗又は202背景削除の実終端finallyだけfinish(context)を要請し、Room整理/子profile.remove/親gate/renameの同contextを保持する。既pendingはnative停止/Room整理を繰り返さず同予約でcleanupを完了する。provider未注入の既builtinは従来membersAdmissionだけ。親削除gate/cancel fresh条件、contextの親IPC相関束縛は所有者公開口で維持する。

直接境界は同member operation試験で予約拒否/202背景/早期fresh失敗/既pendingを確認し、実共通factoryでも両drainが背景終端まで待つことを確認する。親画像gateと実child逆effectの結合は共通/runtime/conversation作者sourceへ接続して確認する別の必要境界として残る。
