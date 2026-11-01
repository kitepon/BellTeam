# 機能図の詳細化と次の整理

基準sourceは `546f232180515a2a8cd9098b943673170c49e3d4`。第一段PR245は主要14図と接続整理として統合済みだが、Ownerが求めた全体の機能分解は継続中。ここでは調査済みの接続と残る調査を区別する。D1/D2/D6とD3は本branchで実装・局所検証済み。D7も局所検証済み。D4/D5は[Web所有設計](web-ownership-plan.md)に沿いcomposer/avatar editor/会話画像cache/timeline/予定editor/記憶/読取補助まで実装・局所確認済み。Bot/room/Ownerフォームも実装・局所確認済み。計画した変更を全体完成とせず、Astraで図/関数表と実装の最終照合、必要な不足修理、全体試験・独立採否を進める。

## 図の完成をどう判断するか

利用機能ごとに、入口→意味のある処理段階→実関数とcaller→データの所有・更新→外部製品窓口→成功/失敗/副作用を説明できること。全体図を入口とし、詳細図の箱から関数表とsourceへ辿る。ファイルの数、描画の成功、旧試験の成功で網羅を代用しない。

## 今回詳しく確認した接続

| 機能群 | 図と関数の対応 | 残っている範囲 |
| --- | --- | --- |
| HTTP/MCP全機能の入口 | [入口索引](entrypoints.md)。公開/内部/別MCPと各serviceを確認 | 入口を列挙しただけの機能は下の各行の調査が必要 |
| 秘密入力・質問 | [利用支援](support-details.md)。作成/提出/取消/取下げ/回答/保存/通知/失敗とWebを接続 | 新しい実入力や故障注入はしていない。既存の状態差を保持 |
| 初期設定・公式認証 | 同上。select/start/input/completeとrelogin/cancel、typed結果、Web入力とpoll | Aiterm内部/公式CLI内部は公開契約境界の外 |
| 任意機能・push・購読・診断 | 同上。設定保存→適用→背景反映、端末別通知、外部検証、診断集約と処置 | 外部検証/通知サービス内部は展開しない。Goal診断の接続不一致は下記D3 |
| メンバー/部屋台帳・予定 | [台帳詳細](registry-details.md)。正本/指示生成/稼働設定/削除/予定発行を確認 | nativeへの反映と停止競合は[制御詳細](control-details.md)へ接続。D2は実装・互換caller確認済み |
| Web会話・管理 | [Web詳細](web-details.md)と[管理詳細](web-management-details.md)。選択/送信/履歴/queue/SSE/入力、Bot/room/予定/画像/Goalを接続 | D4/D5の所有と回収UIは[Web所有設計](web-ownership-plan.md)に具体化。実装とブラウザ上の確認が残る |
| 直接/部屋配送・実行 | [配送詳細](delivery-details.md)。job/receipt/checkpoint/follower/回答担当/画像finally/通常復旧と旧adapterを接続 | D7の小関数化は実装済み、配送関連123件成功。通常構成のexecutionBridge=nullを保持 |
| 記憶・知識 | [記憶詳細](memory-details.md)。台帳選択、scope、DB改訂/pin/成長、知識file/索引、検索/終了失敗を確認 | DB/保存形式の変更なし。検索時の索引更新を単なる読取と呼ばない |
| 自主ターン/稼働/全停止/Goal | [観測詳細](observation-details.md)と[制御詳細](control-details.md)。cursor/重複抑止/停止世代/履歴/Goal receiptを対応付けた | sourceで区別した未知を試験済みにしない。D3は本物組立て反例から修理・局所確認済み |
| 起動/席実行/CLI登録 | [runtime詳細](runtime-details.md)。開始/終了、UID/short child、project/画像、CLI/hook登録を確認 | native長命実行は配送詳細へ。独立製品の内部hook変更は不要 |
| 通常供給・backup/restore | [供給詳細](distribution-details.md)。installer/state transfer/volume保存・復元、失敗後の保存世代を説明 | 本体全stateのbackupとimage/Cursor復元点を区別。今回再実行せず旧停止申請も復活させない |
| 共通処理と外部窓口 | [境界詳細](boundary-details.md)。モデル一覧・通話・BugHub・HTTP診断と実importを接続 | D1/D2/D6のtest/fixture/互換exportは確認済み。索引だけで全call graphの証明にしない |

調査の結果、現在分かっている範囲では内蔵独立製品の変更は必要ない。必要性が判明した場合だけ、その所有者と望む窓口・互換・移行を合わせる。本体の不備を外部へ押し出さない。

## 現状から導いた具体的な整理

### D1 認証応答の同じ判定を一つにする

実装：`authReceipt`を既存auth-uiへ置き、両callerのtyped失敗→schema/status判定を共通化した。エラー生成はcallerに残し、session/保存/Mapの更新順を保持。既存認証試験で確認済み。

以下は固定基底での調査と保持した設計。

`Onboarding.callAuth`と`HarnessAuth.call`は、`authResponseFailure`→`structuredContent.schema`→status集合の確認を同じ順で行う。その後の保存先、sessionの寿命、初回/再認証の判断、公開エラーcodeは別である。

設計：既存`auth-ui.mjs`に応答取出しの小関数を置き、result・session・呼出し側の不正応答エラーを受ける。typed失敗を先に返し、正しいreceiptだけを返す。call側のnative引数・save/Map更新・not_issued/unknownの包装は各serviceに残す。共通の認証managerや状態storeは追加しない。

確認：両callerの正常waiting/authenticated/blocked/failed、不正schema/status、typed not_issued/unknownを既存試験で確認。送信回数・session/binding・各エラーcode/効果を維持する。Webの既存`renderAuthFlow`も再発明しない。

### D2 機能の所有者を経由している共通処理を分離する

実装：`json-file.mjs`、`schedule-definition.mjs`、`avatar-value.mjs`へ既存定義を移し、各callerを直接接続した。BotRegistryの既exportは維持。`markScheduleRun`のBot/room固有の時刻評価・targetsとwriter順序はそのまま残した。

以下は固定基底での調査と保持した設計。

現状ではDiagnostics/OwnerProfileが、JSON保存と存在確認のためだけにBotRegistryをimportする。RoomRegistryは予定の正規化とアバター検証もBotRegistryから読む。予定やファイル保存はBotだけの責任ではない。

設計：`writeAtomic/exists`は小さい既存処理を専用fileへそのまま移す。予定の定義・次回時刻計算はschedule用moduleへ、Bot/roomはそこへ直接接続する。既存BotRegistryのexportは互換を確認して保持する。readFileで存在を確認する現意味、0600、UUID一時ファイル、rename、例外を変えない。似たsaveを全て同じ処理へ変えることはしない。固定tmpの直列化とUUIDtmpでは前提が異なる。

Bot/roomの`markScheduleRun`には同じrevision照合と次回更新がある。`mutateSchedules`は既に共有の短命writer順序を持つため、新しい汎用registryは作らない。共通化するとしても計算部分を小関数にし、room targets・Bot変更通知・戻り値の違いをcallerに残す。全caller/test/exportの調査を終えてから実装する。

### D3 Goal失敗の診断接続を正す

実装：本物のcreateApplicationServicesでinspect異常がDIAGNOSTIC_INVALIDへ置換される反例を保存。Diagnosticsへ既callerのcodeとmoduleを登録し、inspectはunavailable、mutationはunconfirmedを返す局所試験が通った。安全なstackのみを保存し、本文非露出・agent_goal各一回を確認。保存自体の失敗時の伝播は変更していない。

以下は固定基底での調査と保持した設計。

固定sourceの`application-services.mjs`はGoalからの報告を `Diagnostics.record({code:'GOAL_OPERATION_UNCONFIRMED', module:'goals', ...})` に渡す。現`diagnostics.mjs`のreports/modulesにどちらもなく、その組合せは`DIAGNOSTIC_INVALID`になる。`BotGoals`のエラー経路はreportErrorをawaitしてからunavailable/unconfirmedを返すので、組立てた時だけ代替エラーが伝わる。

設計：この診断を本体が受け付ける契約を一箇所で定義し、種類とmoduleを一致させる。Goalの未知結果を成功へ変えず、本文/認証値をlogへ加えない。既存ログschemaを広く許す変更ではない。保存自体の失敗をどう返すかは既存の本体方針と区別して確認する。

確認：本物のDiagnosticsを組み合わせた局所試験で、Goal read/mutationの異常が安全な診断へ届き、元のunavailable/unconfirmedが返ることを示す。実席や元配送の再送は不要。この反例と修理は上記の局所試験で確認済み。元事故との相関と本番反映は未確認。

### D4 Webの送信結果と表示更新結果を分ける

`web/app.js:sendMessage`は、画像変換→POST→画像preview登録→一覧GET→履歴GETを一つのtryに入れ、どの失敗でもcatchで本文と画像を入力欄へ戻す。POST受付成功後のGET失敗でも、送信失敗表示と再入力が起き得る。通信異常そのものではなく、異なる段階を同じ失敗として扱う接続の問題である。

設計：送る対象と下書きの取得、送信、受付後の表示更新を小さい関数へ分ける。POST受付後の表示更新失敗では元の送信を未受付に戻さず、表示だけを更新できなかったと示す。本文再送・二回目POSTを発生させない。選択中会話が変わった場合や、その間に新しい入力がある場合の下書き所有を明示する。失敗した旧本文を別会話の入力へ無条件上書きする現catchも同じ所有境界から評価する。

確認：POST成功→一覧GET失敗、POST成功→履歴GET失敗でPOSTは一回・旧本文は再送用に復活しない。POST拒否時の入力保持は維持。選択変更/新入力/画像・返信者snapshotを別に確認。新しい永続draft storeや一般的なtransaction frameworkは作らない。

### D5 Webの表示状態を機能の所有単位へ分ける

現`app.js`の一つのstateにはsetup/台帳/設定、編集中フォーム、会話選択、timeline索引/queue/page/token、画像preview/入力、既読が混在している。図では読取元と更新元を分けた。まずtimelineの取得・適用・表示を所有するまとまりを作り、選択のsnapshotと結果を渡す窓口を明確にする。

分けるために全stateを別fileへ渡すだけの整理はしない。既存timelineToken/queueRequest、ページ順、スクロール保持、画像後読、入力保持は各責務に残す。Bot/room編集・予定編集・アバター編集の関数は[管理詳細](web-management-details.md)へ対応付けた。次の単位は具体化している。

- avatar editor：現3instanceの閉包と`reset/value/changed`を保つ。DOM/name/color等だけを受ける。decode中のreset/再選択の結果所有とURL解放を確認する。
- schedule editor：開いた対象のtype/id/memberIdsとフォーム/一覧を所有する。会話の選択が変わってもAPI pathを変えない。run/deleteはその一覧の対象、timezoneとroom targetsは元契約を保持。
- timeline：開いた会話とtoken、ページ/queue/画像の取得と適用を所有する。appは選択変更とSSEの意味を渡す。Goal/秘密/質問の既部品は再実装しない。

失敗した旧入力と新しい入力は、会話別の下書きと「保持した入力」の回収欄で両方保持する設計にした。元targetが削除されても本文と画像を回収でき、復元は空の元下書きへだけ行う。具体的な操作・URLの寿命・局所確認条件は[Web所有設計](web-ownership-plan.md)へ記載。永続draft store・自動再送queueは追加しない。ブラウザ上の成立は実装後に確認する。

### D6 純粋な返却判定を実行adapterから分ける

実装：`execution-error.mjs`がcode集合と厳密receipt判定を所有する。旧bridgeの既exportを残し、client/HTTP/診断/停止報告を直接接続。ModelCatalog/組立てはAitermClientを直接importする。

以下は固定基底での調査と保持した設計。

`returnedExecutionError/ERROR_META`を使うAitermClient・HTTP・診断・停止報告が、旧実行登録adapter全体をimportしている。純粋な返却型と定数を小moduleへ移し、既ExecutionBridgeのexportは互換を保つ。codes/effect/follow_upの厳密な判定を緩めず、native入力の再試行条件を変更しない。ModelCatalog/組立てのAitermClientは既存client moduleへ直接接続する。

変更対象は[境界詳細](boundary-details.md)に列挙した。client、execution bridge/error、HTTP/診断/stopの既存試験と互換importを確認する。旧bridgeを通常構成へ復活させたり、未使用parserを根拠なく削除したりしない。

### D7 配送の一つの関数にある段階を名前で追えるようにする

実装：`followAcceptedDelivery`は追跡担当とjob.followsを同期決定、`readTurnAnswer`は同じpty_read/turn照合、`retainUntrackedImages`は保持判定とMap更新だけを同期で所有する。submitがaccepted/completion、全checkpointとonTurnEnd、削除のawait、activity.releaseを保持。配送関連123件が通った。

以下は固定基底から保持した設計。

現`submit`はjob登録・入場・dispatch・receipt照合・follower・accepted・完了・回答・finallyを所有する。第一段では待機だけを`waitForTurnCompletion`へ抽出した。残りは[配送詳細](delivery-details.md)の表を正とし、受付後の同期follower決定、回答を出す担当の判定、回答取得、画像片付けを小関数にする。

jobとaccepted/completionの二本のPromiseはsubmitが所有する。checkpoint/停止適用/running callbackの位置を動かさない。follower判定とjob.followsの間は同期処理、callback重複なし、借用画像削除なし。関数化でawaitを増やす必要がある案は採らない。旧adapterあり/なし、steerの追跡可否/配置、親job有無、読取失敗と片付け失敗の既反例を確認してから変更する。

## 次の実装順と完了範囲

1. **本体共通処理（実装済み）**：D1/D2/D6を直接接続と小関数へ整理し、caller・test・fixture・exportを照合、関連試験成功。第一段の試験成績と区別して保存した。
2. **接続不一致と配送（実装済み）**：D3は本物のDiagnosticsとの反例から修理し、D7は同期追跡・回答取得・画像保持を分離した。Goalの未知結果と全checkpoint順を保持。
3. **画面の所有（次の実装）**：[Web所有設計](web-ownership-plan.md)に従いD4/D5を実装し、旧入力と新入力の保全、非同期結果の対象、回収UIを局所確認する。前二項だけで全体リファクタ完了にしない。
4. **図の最終整合**：実装後にAstraで現状図/関数表/残設計を揃え、描画・人への説明・必要全体試験一回・独立採否・通常候補へ。停止を伴う本番操作は別の既条件に従う。

現状機能の各詳細とD4/D5の実装設計は揃ってきたが、全callerの機械解析・全分岐実行を済ませた意味ではない。D4/D5の実装・確認と全体の整合が残るため、全体完成とはしない。

## 保持するもの

- 秘密の提出/取消と質問回答の失敗契約を、汎用カード更新へまとめない。
- service作成とlistener/監視の開始、保存設定とnative受付、送信受付と回答/描画の結果を分ける。
- 第一段のsource/image採用、元full1045pass1failとfixture是正5passを保存する。今回の設計の試験結果にはしない。
- 本番停止申請K-QSYMSEは取り下げ済み。詳細設計と必要実装が揃う前に本番反映へ進めない。

## Web残工程の具体化

Astraで[Web所有設計](web-ownership-plan.md)へD4/D5をまとめた。composerの会話別入力と送信snapshot/回収欄、timelineの対象と世代、予定editor/画像decode/補助表示の寿命を決めた。実関数のVM反例3件とschedulePath観測1件を保存し、既製品codeは変更していない。回収欄は画面内の入力保全であり永続store/自動配送queueではない。次は同文書の実装順と確認表に従う。
