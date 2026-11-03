# Apple 機能図リファクタリングの手順と現在地

担当：ベル（Apple）。指導と成果確認：レヴィアタン。正本の入口は[README](README.md)。共通の変更手順は[module-ownership](../../module-ownership.md)。

## 指示

Ownerのリファクタリング指示の全文を、2026-11-03にレヴィアタンから受領した（call-bridge通話 `eaf2a294-2993-43b1-88b3-530200159a3e`、seq12）。対象は `ios/BellBot` の全体。

- 調査と実装は最新のSol（High）、責務の設計と最後の整合確認は最新のAstra（xhigh）を使う。fastは使わない。
- リファクタリング中は、Owner本人の指示と現行規範の修理例外のほかは受けない。
- 本番反映、公開、審査、停止・再起動の許可には広げない。
- 先にApple全体の機能一覧と接続図を揃え、その中でUI改善6点が触る範囲を先に詳しくする。

## 固定source

| 項目 | 値 |
| --- | --- |
| branch | `refactor/apple-feature-map-20261103` |
| base / HEAD | `4e01fadcb5edcaa74c010436a47be9cb26eabeec`（開始時のorigin/main） |
| 作業ツリー | このrepoの `.claude/worktrees/contact-bell-team-trony-d31d41` |
| 開始時の未コミット | なし |

トロニーがseq424で示した `afdc8731` は、この固定sourceより前の版。差は図の作成時に確認する。

## モデルの適用記録

| 工程 | 指示のモデル | 実際の経路 | 状態 |
| --- | --- | --- | --- |
| 候補の確認 | — | Aiterm `agent_models`（codex-cli） | `gpt-6.1-sol` と `gpt-6-astra` があり、どちらも high と xhigh を受け付ける |
| 実コードの調査と図化（先行範囲） | `gpt-6.1-sol` high | Aitermの `agent_launch` は2回とも「OSのprocess一覧を取得できません」で起動しなかった。公式CLI `codex exec` で実行。1回目（17:55 JST）は標準入力を閉じずに起動したため入力待ちで止まり、成果なしで停止した。2回目は19:4x JSTに起動し、ヘッダーで model `gpt-6.1-sol`、reasoning effort `high` を確認（session `01a1a0f7-de30-7521-b880-3c82ae8e2629`） | 完了。`afda947` でcommit。レヴィアタンが描画・目視し、送信失敗の図を1点補正 |
| 残りの機能の詳細図 | `gpt-6.1-sol` high | `codex exec`、別の作業ツリー（HEAD `afda947` のdetached）で実行。session `01a1a10a-9d03-7180-a6fd-6f4261ba00c9`。対象は新規の conversation.md、requests-and-auth.md、goals.md、lifecycle-and-platform.md、tests.md（試験の本文） | 完了。`822563d` で取り込み。レヴィアタンが描画・目視し、会話の送信図を1点補正（`defb299`） |
| 責務の設計（先行9件） | `gpt-6-astra` xhigh | `codex exec`、この作業ツリーで実行。session `01a1a10a-9cfb-76f0-a189-10a70111d959`。対象は refactor-design.md だけ | 完了。採用4・不採用4・保留1。`822563d` |
| 責務の設計（追加12件） | `gpt-6-astra` xhigh | `codex exec`、session `01a1a11d-7053-7300-9b78-db60e7d6cd34`。refactor-design.md へ追記 | 完了。採用4・不採用8。前回判断の変更なし。段階はPR0〜PR5 |
| 実装 PR0 | `gpt-6.1-sol` high | session `01a1a12e-19ca-7600-ad26-a04478153005` | 完了 `e58e5c0`。試験名とコメントだけ。ビルド・試験は設計どおり不要 |
| 実装 PR1 | `gpt-6.1-sol` high | session `01a1a130-daf2-76e2-bc48-b8f469847fdd` | 完了 `e82f12a`。BotSaveTests 20件通過（追加2件を含む）。対応表の補正 `bd19c00` |
| 実装 PR2 | `gpt-6.1-sol` high | session `01a1a13e-673b-7370-b596-fe9a68af0a5c` | 完了 `8ca6746`。BotTerminalTextViewTests 1件、MacのUI試験2件（インスペクター、端末画面）通過 |
| 実装 PR3 | `gpt-6.1-sol` high | session `01a1a148-b06a-7fe2-bb40-44c0ca965c4f` | 完了 `22d56bf`。MessageInputTests・ConversationDraftTests 6件、MacのUI試験2件（入力キー、会話切替の下書き）通過 |
| 実装 PR4 | `gpt-6.1-sol` high | session `01a1a150-4b74-7921-ae71-35d1bd9ebcf7` | 完了 `5356a7e`。BillingStoreTests 21件通過（再起動の直接試験5件を含む） |
| 実装 PR5 | `gpt-6.1-sol` high | session `01a1a157-97fd-7850-8e7a-3bc3a627154e` | 完了 `6b3ed89`。goalの直接試験4件と隣接1件通過 |
| 最後の整合確認 | `gpt-6-astra` xhigh | 未実行 | — |

Aitermの起動の失敗はエレグへ報告した（call-bridge通話 `29cba01a-03a0-4301-851d-acba07bc25c1`、seq9とseq10）。`codex exec` での実行は、Aitermの欠陥が直ったことを意味しない。

## 工程

1. 調査と図化（Sol High）：全体の機能一覧と接続図、状態と同期、一覧と検索とメンバー・ルーム編集、設定とプロフィール、ファイルと関数の対応表。
2. 調査結果を親が実コードと照合して受け入れる。未調査の範囲を残す。
3. 責務の設計（Astra xhigh）：整理候補から、所有者の付け替え、重複の統合、迂回の除去の案と比較を出す。
4. 段階的な実装（Sol High）：変更する窓口の全caller、test、fixture、exportを確認してから、PR単位で行う。
5. 図とコードの同期、描画と目視、関連試験、最後にAstra xhighで整合を確認する。
6. 残りの機能（会話、予定、goal、質問・承認・秘密入力、接続認証、SSE再接続と背景復帰、push拡張、購読、端末保存とlogout削除、各platformの配置）を全体へつなぐ。

## 後段の要望（現状の図とは分ける）

Ownerからトロニー経由で受けたUI改善6点（トロニー通話 seq423）。全体リファクタリングの受け入れ後に、別の差分で行う。

1. 一覧の最新発言の断片を、今の仕事の短い要約へ変える。データはRootが公開する `currentWork` を使う。Appleでは要約を作らない。Rootの契約v1（トロニー通話 seq425、正本はトロニーの `docs/current-work-contract-20261103.md`）：Bot一覧の各要素に `currentWork {state, summary, summaryStatus, summaryUpdatedAt, observedAt, source}`、ルームは `currentWork {scope: participants, members: [{botId, currentWork}]}`。要約が無い、期限切れ、観測不能の時は直近発言へ戻さずそのまま表示する。実装sourceと有限のJSON例の到着後に接続する。試験用の契約資材はトロニー通話 seq427 に全文がある（Mollyの `contract-artifacts.json` SHA256 `b9767b66…2cced`、`schemas.json` `fb3d3dba…3161a`、`finite-examples.json` `e58896bb…0dbb6`）。一覧で使うのは `currentWork` と `roomCurrentWork` だけで、`currentWorkBinding` は使わない。この時点で本体の公開HTTPとSSEは未供給。
2. メンバーとルームの検索に役職を含める。
3. ルームのメンバー追加に、名前と役職の検索を足す。
4. 設定画面を整理する。
5. メンバー編集を同じ体系にそろえる。
6. Ownerとメンバーのプロフィール編集の流れを整理する。

保留中の修理：配達失敗の赤表示（`deliveryTracking`）と、大画像の前面復帰時の再読込。どちらも全体の受け入れ後。

## 次の作業

試験の原本（xcresultとlog）は親のMacの `~/Library/Developer/BellTeam-evidence/2026-11-03-apple-refactor/` にある。試験はすべて Mac Catalyst（macOS 27.0）で、iPhone・iPadでは実行していない。

全体の受け入れ前に残る確認：

| 段階 | 設計が求めるMac実画面確認 | 現状 |
| --- | --- | --- |
| PR1 | 既存メンバーの文面保存、画像変更なし、画像保存の結果表示、一覧と入力の保持、PATCHが1回 | 確認済み。文面保存は `DesktopWorkspaceUITests.testSaveWithoutAvatarChangesWhileModelsArePending`（役職編集、PATCH1回、画像キー省略、モデル保持、保存後の一覧、画面の一覧と会話の下書きの保持）、画像保存は `testMacSmallCropSaveShowsResultAndWritesOnce`（成功文言、PATCH1回、小画像3キーだけ、大画像cropの保持）がMacで通過。前者の変更前からの失敗は、Mac Catalystのツールバーで保存ボタンの識別子が外れるため（試験をラベルで探す形へ直した）。後者の「使用する」はシート内のボタンとして探す |
| PR2 | 非表示にした後の端末画面の照会停止 | 確認済み。`DesktopWorkspaceUITests.testMacInspectorScreenPollsOnlyWhileVisible` がMacで通過（表示中はscreen要求が続き、すべて history=1、⌘⇧Iで非表示にした後2.4秒間は要求が増えない） |
| PR3 | 画像の束・単画像・galleryの切替、画像GET失敗の表示、画像ファイルと画像の貼付け、添付の除去、送信失敗後の画像の復元 | 確認済み。`test/helpers/conversation-images-server.mjs`と`ConversationAppearanceUITests`の5件（DM3枚・room2枚の束とgallery切替、旧単画像と枚数ラベル、画像GET失敗のカードとgallery、ファイル選択と除去、画像2枚の貼付けとPOST失敗後の復元）がMacで通過。既存画像2件と画像GET失敗の試験は、変更前の`22d56bf^`でも同じ行で失敗した。原因は試験側で、Macのgalleryは全画面表示でsheetとして公開されず、`tap()`がSwiftUIのボタンへ届かない（`click()`で押す形へ直した）。Finderからの画像ファイルURLの貼付けは自動化していない（[tests.md](tests.md#pr3のmac確認の補助試験)） |
| PR4 | 失敗文言と診断が1回、再操作の成功でerrorが消えinspectorが残る | 確認済み。`profile-terminal-ui-server.mjs` に購読、再起動の失敗と成功、要求と診断の記録、resetを足し、`DesktopWorkspaceUITests.testMacInspectorRestartFailureReportsOnceAndSuccessKeepsInspector` がMacで通過（失敗文言、診断1回、POST1回、再操作の成功で文言が消えinspectorが残る、POST計2回、診断計1回） |
| PR5 | goals-ui fixtureでの一覧・会話・editor・単独項目・結果不明・読取失敗後の回復 | 10件中8件がMacで通過（作成と編集、読取失敗後の一覧と会話、応答喪失、会話内3件、Grokのtoken、Grokの詳細）。`testUnconfirmedGoalChangeWaitsForRefreshWithoutResending`（239行、結果不明の後の一時停止ボタンが無い）と `testTaggedClaudeGoalAndClearedHistory`（369行、取り消し後の履歴）は失敗。同じ試験を変更前の `4e01fad` に入れても同じ行で失敗したので、PR5による変化ではない。結果不明の後と取り消しの後に一覧からカードが外れる製品の表示と、試験の期待が元から合っていない（iPhone・iPadで同じかは未確認） |
| 全体 | 最後の整合確認（Astra xhigh） | 未実行 |

前回（PR1文面・PR4）の試験準備は固定source `refactor/apple-feature-map-20261103` / `d1114a499cab282da7dff9826861ad5c71a4a1d0` に対して行った。変更範囲はhelper二本、`DesktopWorkspaceUITests.swift`、`tests.md`、本書のみ。製品コード・Shared・NotificationServiceは未変更。ビルド・試験・helper起動・gitの変更操作は行っていない。[tests.mdの起動手順とPR1の静的調査](tests.md#pr1pr4のmac確認の補助試験)に環境変数・対象selector・未解明の境界を記載した。実行結果による表の更新は親の確認後に行う。

今回（PR1画像・PR2・PR5）の準備sourceは `refactor/apple-feature-map-20261103` / `e9935631c1cd6d9f319377be2d249db93dc36837`。変更範囲は `DesktopWorkspaceUITests.swift`、`GoalsUITests.swift`、`tests.md`、本書だけ。fixtureは既存の応答と記録を利用し、変更不要。製品コード・Shared・NotificationServiceは未変更。ビルド・試験・helper起動・gitの変更操作は行っていない。画像保存はiPhoneの既存試験と同じ現在画像の再調整で確認するため写真libraryは不要で、Macの写真pickerの操作可否は判定していない。[今回の実行手順](tests.md#pr1pr2pr5のmac確認の補助試験)に環境変数と構成別selectorを記載し、実行結果は記載していない。

- 第一版（`afda947`）は2026-11-03に返却済み。レヴィアタンの描画・目視で、送信失敗の図の分岐を1点補正した。製品Swiftは全文読了、XCTest 45本は宣言だけで本文は未読（tests.md で補う）。
- 責務の設計の第一版は2026-11-04 12:00 JSTまでに返す。各調査担当の完了イベントを親の照合の開始条件にし、入力待ちのまま待たない。
- 設計で特に確かめる点：A-M1はiPhoneとiPad/Macで副題と日時の並べ方が違うので、無意識に同じにしない。A-P3は`pendingSelections`とAppStoreのdraftの寿命と所有の違いを確かめ、二重に持つことだけで不要と決めない。
- 第一版の完了条件：6文書がそろい、実関数へつながる。overviewには未読の範囲（BillingStore、BackgroundMessageSend、AvatarImage、ConversationTimelineState、Design、Shared、NotificationService、試験とpack）も対象一覧、所有、入口、未調査として残す。読んだ部分と全文を確認した部分を分ける。停止、取消、途中失敗、結果不明、後始末、原本の保持は実sourceで裏付け、未確認を推測で埋めない。
- 返却物：照合済みのcommitと完全なHEAD、6つのMarkdown原図、README、module.json、対応するsourceの参照、SHA256のmanifest。レヴィアタンが読める正規の共有経路か通話本文で渡す。Macの絶対pathだけでは渡さない。未承認のpushはしない。
- 描画と目視はレヴィアタンの環境で行い、版と接点もレヴィアタンが独立に確認する。
