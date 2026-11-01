# 機能図の確認範囲と残る作業

調査起点は `546f232180515a2a8cd9098b943673170c49e3d4`。第一段PR245の主要14図・接続整理を土台とし、製品head `4704446416ffa56ac8f3c6ab8e78bac57234056e` までを本branchで実装した。Astraの最終照合で現状図・関数表を同期したが、Webの具体的な残欠陥を見つけたため**全体未完**。[追加設計G1〜G4](web-final-gaps.md)の修理、必要な再照合、全体試験一回、独立採否、通常候補が残る。

## 図の完成をどう判断するか

利用機能ごとに、入口→意味のある処理段階→実関数とcaller→データ所有/更新→公開製品窓口→成功/失敗/副作用を説明できること。全体図から詳細図、関数表、sourceへ辿る。機械的な関数数、描画成功、局所試験の成功だけで完成にしない。

## 利用機能からの照合

次は実入口と処理先を読んだ対応である。全内部関数の自動call graphや全分岐を実行した証明ではない。

| 利用機能群 | 入口 → 詳細図/関数 → 所有と結果 | 今回の境界・残件 |
| --- | --- | --- |
| HTTP/MCP・接続 | [入口索引](entrypoints.md)の各handler/tool→同じ本体service | 認証・内部席の名札・公開/内部mutationを区別。入口索引だけで各機能の完了にしない |
| Owner会話・Bot間・通話 | [会話](conversation-flow.md)→[配送詳細](delivery-details.md) | Messengerの発言保存、DeliveryJobの受付/停止、native結果、背景回答を分離。通常executionBridge=null |
| 部屋・reply/silent | [配送詳細](delivery-details.md)→RoomMessenger/MCP | 参加者snapshot・全員配送・返信資格・routing失敗。部分配送失敗でも元投稿は残る |
| 履歴・添付・書出し・SSE | [会話](conversation-flow.md)と[Web](web-details.md) | JSONL writer、読取store/index、表示projection、Web token/queue/URLを分離。一覧の返却競合G1が未修理 |
| Bot/部屋・プロフィール・規範 | [台帳](registry-details.md)→[Web管理](web-management-details.md) | 台帳保存と指示生成・背景削除・設定反映を区別。規範未読保存G2、背景削除表示G4が未修理 |
| 予定 | [台帳](registry-details.md)→[制御](control-and-state.md)→schedule editor | 正本/期限発行/command終了/手動run、revision、開いた対象の所有を説明 |
| 設定適用・個別/全体停止 | [制御詳細](control-details.md) | 保存希望値、pending、native受付、停止意図と停止結論を別に持つ |
| Goal | [制御詳細](control-details.md)→[Web管理](web-management-details.md) | native binding/readbackが正本。診断接続D3修理済み、unknownを成功へ変えない |
| 秘密入力・質問 | [支援詳細](support-details.md) | 値/回答保存と通知受付を区別。secret notification failedとquestion例外を一本化しない |
| 初期設定・公式認証 | [支援詳細](support-details.md)→既認証UI | CLIの資格情報、Aitermのauth、Onboardingの導入段階を区別。保存/Mapは各service、receipt判定のみ共通 |
| 任意設定・通知・購読・診断 | [支援詳細](support-details.md) | settings保存/適用、端末通知受付、外部検証、調査処置を別にする。Web設定再描画G3が未修理 |
| 記憶・知識・検索 | [記憶詳細](memory-details.md) | 最終scope/botId、DB/Markdown、索引更新、transaction/部分保存、Web検索の所有を説明 |
| 自主ターン・報告・idle | [観測詳細](observation-details.md) | native進行とThroughline保存回答、cursor、報告依頼、idle判定を区別。自然30分や旧会話を再実行しない |
| 起動・短命席処理・MCP/hook登録 | [runtime詳細](runtime-details.md)と[境界](boundary-details.md) | 構築/start、UID、env、stream/JSON、管理節、公開製品窓口を説明。独立製品内部は展開しない |
| 供給・移行・backup/restore | [供給詳細](distribution-details.md) | image採用/更新、保存世代、writer停止、data移行、image/Cursor控えと全stateの違い。今回Host実行なし |

現時点で合理的な独立製品の責任変更は必要ない。本体に残る問題は本体で持つ。今後公開窓口を変える必要が判明した時だけ、根拠・互換・移行を製品所有者と合わせる。

## 実装した整理

### D1 認証応答の同じ判定を一つにする

`authReceipt`を既auth-uiへ置いた。typed失敗→schema/statusの同じ順序だけを共通化し、Onboarding/HarnessAuthの公開エラー、session/Map/保存順はcallerに残した。共通認証managerは増やしていない。

### D2 機能の所有者を経由している共通処理を分離する

`json-file/schedule-definition/avatar-value`へ既定義を移し、Diagnostics/OwnerProfile/UserRules/RoomRegistry等を直接接続。BotRegistry互換export、0600/UUIDtmp/readFileの意味、例外、予定revision/room targetsを維持。保存方式が異なる他のsaveまで一括置換していない。

### D3 Goal失敗の診断接続を正す

本物の組立てでGOAL_OPERATION_UNCONFIRMED/goalsがDIAGNOSTIC_INVALIDへ変わる反例を確認し、Diagnosticsへ既callerのcode/moduleを登録。inspect unavailable/mutation unconfirmed、安全な診断、本文非露出、各一回callを局所確認した。元事故との相関や実Goal回復を証明したものではない。

### D4 Webの送信結果と表示更新結果を分ける

composerが会話別draft/送信snapshot/回収欄を所有する。宛先/返信者/本文/画像を変換前に固定し、POST成功後のGET失敗から旧入力を復活させない。失敗した旧入力と新入力は両保持し、利用者が回収する。永続store・自動再送queueはない。

### D5 Webの表示状態を機能の所有単位へ分ける

timeline、画像cache、各editor、記憶/読取補助へ対象と寿命を移した。appは組立て/一覧/選択を持ち、内部Mapや全stateを別機能へ渡さない。avatarは既共通処理にdecode世代を加え、URLを生成者が解放する。Bot/room保存受付と表示更新、Ownerのprofile/rules部分成功も区別した。ただし一覧/未読規範/任意機能callbackの残欠陥G1〜G3は別途修理する。

### D6 純粋な返却判定を実行adapterから分ける

`execution-error`がcode集合/厳密receipt判定を所有し、client/HTTP/診断/停止が直接import。旧bridgeの互換exportを維持。ModelCatalog/組立てもAitermClientへ直接接続し、通常運転へ旧adapterを復活させない。

### D7 配送の一つの関数にある段階を名前で追えるようにする

`followAcceptedDelivery`で追跡担当/job.followsを同期決定、`readTurnAnswer`で同じpty_read/turn照合、`retainUntrackedImages`で同期の保持判断。submitがaccepted/completion、全checkpoint、回答担当/onTurnEnd、削除await/releaseを保つ。責務の違う自主ターンwatchを同じ処理へ潰していない。

## 確認済みと、まだ確認していないこと

各実装で関連試験を実行した。共通処理の112/82/47/123、Webの45/11/38/35/4、timelineの10、予定/補助の44/7/42、フォーム最終54はいずれも各runの成功数であり、重複があるため合算しない。最新の3フォーム実DOM＋人工API4writeと、全Web＋人工APIの入力回収は成功。旧失敗logも保持する。

Astra最終照合では一覧返却逆転、規範GET待ち/失敗後保存、任意機能の同open/再open後入力消失を人工応答で実観測した。これらは[追加設計](web-final-gaps.md)へ接続し、まだ修理成功を主張しない。

- 設計起点と現状図の対応を更新した。変更図は描画/目視確認を工程原本へ記録する。
- 追加修理後にAstraで再照合し、今回の全実装を揃えてから全体試験を一回行う。今回の全体試験はまだ実行していない。
- センチの独立採否、正規PR/通常候補はその後。第一段PR245の採否を今回全体へ流用しない。
- 本番dd46は維持。K-QSYMSEは取消済みで、停止/商用反映へ進まない。必要な判断は完成した候補で既条件に従う。

設計経緯は[第一段計画](refactor-plan.md)と[Web所有設計](web-ownership-plan.md)、今の説明は各詳細図、未実装は[追加設計](web-final-gaps.md)。この三つを混ぜず更新する。
