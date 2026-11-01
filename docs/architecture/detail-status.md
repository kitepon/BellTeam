# 機能図の詳細化と次の整理

基準sourceは `546f232180515a2a8cd9098b943673170c49e3d4`。第一段PR245は主要14図と接続整理として統合済みだが、Ownerが求めた全体の機能分解は継続中。ここでは調査済みの接続と残る調査を区別する。以下の案は未実装である。

## 図の完成をどう判断するか

利用機能ごとに、入口→意味のある処理段階→実関数とcaller→データの所有・更新→外部製品窓口→成功/失敗/副作用を説明できること。全体図を入口とし、詳細図の箱から関数表とsourceへ辿る。ファイルの数、描画の成功、旧試験の成功で網羅を代用しない。

## 今回詳しく確認した接続

| 機能群 | 図と関数の対応 | 残っている範囲 |
| --- | --- | --- |
| HTTP/MCP全機能の入口 | [入口索引](entrypoints.md)。公開/内部/別MCPと各serviceを確認 | 入口を列挙しただけの機能は下の各行の調査が必要 |
| 秘密入力・質問 | [利用支援](support-details.md)。作成/提出/取消/取下げ/回答/保存/通知/失敗とWebを接続 | 新しい実入力や故障注入はしていない。既存の状態差を保持 |
| 初期設定・公式認証 | 同上。select/start/input/completeとrelogin/cancel、typed結果、Web入力とpoll | Aiterm内部/公式CLI内部は公開契約境界の外 |
| 任意機能・push・購読・診断 | 同上。設定保存→適用→背景反映、端末別通知、外部検証、診断集約と処置 | 外部検証/通知サービス内部は展開しない。Goal診断の接続不一致は下記D3 |
| メンバー/部屋台帳・予定 | [台帳詳細](registry-details.md)。正本/指示生成/稼働設定/削除/予定発行を確認 | 設定のnative反映と停止競合の全分岐は実行詳細へ接続が必要 |
| Web会話 | [Web詳細](web-details.md)。選択/送信/履歴/queue/SSE/入力を接続 | Bot/room/予定/画像編集/Goal dialogの内部関数は継続確認 |
| 直接/部屋配送・実行 | 既[会話図](conversation-flow.md)は再利用可能 | job/receipt/checkpoint/follower/画像finally/各復旧の全接続を詳細化 |
| 記憶・知識 | [記憶詳細](memory-details.md)。台帳選択、scope、DB改訂/pin/成長、知識file/索引、検索/終了失敗を確認 | DB/保存形式の変更なし。検索時の索引更新を単なる読取と呼ばない |
| 自主ターン/稼働/全停止/Goal | 主要図のみ | 監視の重複抑止・停止世代・履歴所有と公開receipt検証を対応付ける |
| 起動/席実行/CLI登録 | [runtime詳細](runtime-details.md)。開始/終了、UID/short child、project/画像、CLI登録を確認 | 各hook adapterとnative長命実行の詳細は実行機能図へ接続が必要 |
| 通常供給・backup/restore | 第一段の入口図 | installer/state transfer/volume保存・復元の分岐、失敗後に残るものを詳細化 |

調査の結果、現在分かっている範囲では内蔵独立製品の変更は必要ない。必要性が判明した場合だけ、その所有者と望む窓口・互換・移行を合わせる。本体の不備を外部へ押し出さない。

## 現状から導いた具体的な整理

### D1 認証応答の同じ判定を一つにする

`Onboarding.callAuth`と`HarnessAuth.call`は、`authResponseFailure`→`structuredContent.schema`→status集合の確認を同じ順で行う。その後の保存先、sessionの寿命、初回/再認証の判断、公開エラーcodeは別である。

設計：既存`auth-ui.mjs`に応答取出しの小関数を置き、result・session・呼出し側の不正応答エラーを受ける。typed失敗を先に返し、正しいreceiptだけを返す。call側のnative引数・save/Map更新・not_issued/unknownの包装は各serviceに残す。共通の認証managerや状態storeは追加しない。

確認：両callerの正常waiting/authenticated/blocked/failed、不正schema/status、typed not_issued/unknownを既存試験で確認。送信回数・session/binding・各エラーcode/効果を維持する。Webの既存`renderAuthFlow`も再発明しない。

### D2 機能の所有者を経由している共通処理を分離する

現状ではDiagnostics/OwnerProfileが、JSON保存と存在確認のためだけにBotRegistryをimportする。RoomRegistryは予定の正規化とアバター検証もBotRegistryから読む。予定やファイル保存はBotだけの責任ではない。

設計：`writeAtomic/exists`は小さい既存処理を専用fileへそのまま移す。予定の定義・次回時刻計算はschedule用moduleへ、Bot/roomはそこへ直接接続する。既存BotRegistryのexportは互換を確認して保持する。readFileで存在を確認する現意味、0600、UUID一時ファイル、rename、例外を変えない。似たsaveを全て同じ処理へ変えることはしない。固定tmpの直列化とUUIDtmpでは前提が異なる。

Bot/roomの`markScheduleRun`には同じrevision照合と次回更新がある。`mutateSchedules`は既に共有の短命writer順序を持つため、新しい汎用registryは作らない。共通化するとしても計算部分を小関数にし、room targets・Bot変更通知・戻り値の違いをcallerに残す。全caller/test/exportの調査を終えてから実装する。

### D3 Goal失敗の診断接続を正す

固定sourceの`application-services.mjs`はGoalからの報告を `Diagnostics.record({code:'GOAL_OPERATION_UNCONFIRMED', module:'goals', ...})` に渡す。現`diagnostics.mjs`のreports/modulesにどちらもなく、その組合せは`DIAGNOSTIC_INVALID`になる。`BotGoals`のエラー経路はreportErrorをawaitしてからunavailable/unconfirmedを返すので、組立てた時だけ代替エラーが伝わる。

設計：この診断を本体が受け付ける契約を一箇所で定義し、種類とmoduleを一致させる。Goalの未知結果を成功へ変えず、本文/認証値をlogへ加えない。既存ログschemaを広く許す変更ではない。保存自体の失敗をどう返すかは既存の本体方針と区別して確認する。

確認：本物のDiagnosticsを組み合わせた局所試験で、Goal read/mutationの異常が安全な診断へ届き、元のunavailable/unconfirmedが返ることを示す。実席や元配送の再送は不要。現時点はsourceの不一致確認までで、実行反例・修理済みとは言わない。

### D4 Webの送信結果と表示更新結果を分ける

`web/app.js:sendMessage`は、画像変換→POST→画像preview登録→一覧GET→履歴GETを一つのtryに入れ、どの失敗でもcatchで本文と画像を入力欄へ戻す。POST受付成功後のGET失敗でも、送信失敗表示と再入力が起き得る。通信異常そのものではなく、異なる段階を同じ失敗として扱う接続の問題である。

設計：送る対象と下書きの取得、送信、受付後の表示更新を小さい関数へ分ける。POST受付後の表示更新失敗では元の送信を未受付に戻さず、表示だけを更新できなかったと示す。本文再送・二回目POSTを発生させない。選択中会話が変わった場合や、その間に新しい入力がある場合の下書き所有を明示する。失敗した旧本文を別会話の入力へ無条件上書きする現catchも同じ所有境界から評価する。

確認：POST成功→一覧GET失敗、POST成功→履歴GET失敗でPOSTは一回・旧本文は再送用に復活しない。POST拒否時の入力保持は維持。選択変更/新入力/画像・返信者snapshotを別に確認。新しい永続draft storeや一般的なtransaction frameworkは作らない。

### D5 Webの表示状態を機能の所有単位へ分ける

現`app.js`の一つのstateにはsetup/台帳/設定、編集中フォーム、会話選択、timeline索引/queue/page/token、画像preview/入力、既読が混在している。図では読取元と更新元を分けた。まずtimelineの取得・適用・表示を所有するまとまりを作り、選択のsnapshotと結果を渡す窓口を明確にする。

分けるために全stateを別fileへ渡すだけの整理はしない。既存timelineToken/queueRequest、ページ順、スクロール保持、画像後読、入力保持は各責務に残す。Bot/room編集・予定編集・アバター編集の全callerを調べ、最小の関数群と依存を決めてから実装する。この段階では最終モジュール分割を決めていない。

## 保持するもの

- 秘密の提出/取消と質問回答の失敗契約を、汎用カード更新へまとめない。
- service作成とlistener/監視の開始、保存設定とnative受付、送信受付と回答/描画の結果を分ける。
- 第一段のsource/image採用、元full1045pass1failとfixture是正5passを保存する。今回の設計の試験結果にはしない。
- 本番停止申請K-QSYMSEは取り下げ済み。詳細設計と必要実装が揃う前に本番反映へ進めない。
