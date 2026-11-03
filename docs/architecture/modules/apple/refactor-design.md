# Appleアプリの責務整理設計

[担当の正本](README.md) / [全体図](overview.md) / [状態と同期](state-and-sync.md) / [一覧・編集](members-and-rooms.md) / [設定・プロフィール](settings-and-profile.md) / [会話](conversation.md) / [要求と認証](requests-and-auth.md) / [goal](goals.md) / [背景とplatform](lifecycle-and-platform.md) / [試験](tests.md) / [関数索引](function-index.md) / [予定一覧](schedule-list.md) / [進行記録](refactor-progress.md)

## 結論と対象版

**今回の12件は採用4件、不採用8件、保留0件。前回9件の採否は変更せず、全21件では採用8件、不採用12件、保留1件とする。** 前回のPR1〜PR4に、試験の名前・コメントを訂正するPR0と、goalの既存定義を配置するPR5を加える。画面の振る舞いとHTTP/SSE契約を維持し、protocol、汎用wrapper、設定値、永続状態は増やさない。診断pathと認証失敗の扱いは別の修理として残す。

| 項目 | 確認した値・範囲 |
| --- | --- |
| branch | `refactor/apple-feature-map-20261103` |
| 調査の固定HEAD | `822563dcc9e154dc896d2db48336d7d66ee46df1` |
| コードの基準 | `4e01fadcb5edcaa74c010436a47be9cb26eabeec`。このbaseとHEADの`ios/BellBot`差分は空 |
| 読取中の作業ツリー更新 | HEADが`defb299ca7cba046c57e0e7f52ea2e56663cc750`へ進んだ。固定HEADとの差はconversation.mdの送信失敗図と説明だけで、`ios/BellBot`と本設計書のcommit間差分は空。実コードの根拠は上記固定HEADのまま |
| 調査方法 | 指定文書、実装、変更窓口の参照、直接試験の本文、fixtureとtarget登録の静的読取 |
| 今回の成果 | この設計書だけ。コード・他文書・git状態の変更操作、ビルド、試験、実画面操作は実施していない |

以下の`Core/`・`Views/`は`ios/BellBot/BellBot/`から、`BellBotTests/`・`BellBotUITests/`・`Tests/`は`ios/BellBot/`からの相対パス。行番号は上記固定sourceに対応する。「変更する」は後続実装の設計を意味する。採否は設計上の判断であり、実装・配布の完了を意味しない。

| ID | 採否 | 整理の範囲または残す理由 |
| --- | --- | --- |
| A-O1 | 採用 | 会話から独立している既存の入力部品、画像表示、プロフィール詳細、端末画面を責務ごとに配置する。状態の寿命と処理は移さない |
| A-S1 | 採用 | Bot保存・照合のBellAPI extensionを専用ファイルへ移し、値型の定義と分ける |
| A-S2 | 不採用 | 診断送信と通常APIはsession・応答条件・失敗の返却先が違う |
| A-M1 | 不採用 | 並び順と副題の統一は表示変更。検索の短い式だけの抽出にも利益がない |
| A-P1 | 保留 | 保存手順の分割は不要。読取失敗時の診断path不一致は修理として別に扱う |
| A-P2 | 採用 | 再起動前の利用権限確認とPOSTをAppStoreの一つの操作へ。画面ごとの成功・失敗表示は保持 |
| A-P3 | 不採用 | 画面の更新通知と、再認証・再生成をまたぐdraft保持は異なる責務 |
| A-X1（追加） | 採用 | Botプロフィール応答型のローカルな重複を削除し、既存`BotProfileResponse`を使う |
| A-X2（追加） | 不採用 | 空要求型4個の全面統一。重複した分岐や検査はなく、独立機能の型名変更まで広げない |
| A-C1 | 不採用 | 添付・宛先の画面更新と、画面再生成をまたぐdraft保持は別の責務。コピーを消すだけでは通知と復元を保てない |
| A-C2 | 不採用 | 書出し失敗の診断path訂正は診断契約の修理として別工程へ |
| A-C3 | 不採用 | 初回pageの保持と、表示中の差分・過去・仮送信のtimelineは別用途。保存頻度の統一は再表示を変える |
| A-R1 | 不採用 | 利用許可段階での認証失敗をrequireLoginへ結ぶ変更は画面遷移・秘密値の寿命を変える修理 |
| A-R2 | 不採用 | 初回setupと再認証は共有済みのtyped値・保護通信を使い、異なる寿命・読取順序をそれぞれ所有している |
| A-G1 | 採用 | 既存のgoal値型と取得・変更状態を2ファイルへ移す。画面と状態の生成位置、harness別decodeを保つ |
| A-G2 | 不採用 | 既存GoalEditorとGoalViewModelで処理は共通化済み。二つのsheet接続と独立した状態を残す |
| A-L1 | 不採用 | 二つのorigin処理は受理条件・既定port・失敗値が異なる。cacheキーと通知の識別を統一しない |
| A-L2 | 不採用 | 同じ秘密入力部品を各platformの根へ取り付ける短い接続。新しいmodifierや上位sheetへの移動は不要 |
| A-T1 | 採用 | 秘密入力UI試験を、既存assertが検査する登録表示・値の非表示・再起動後の表示を表す名前へ訂正 |
| A-T2 | 採用 | 1万行fixtureを使うUI試験を、履歴要求と画面取得までを表す名前・コメントへ訂正 |
| A-T3 | 採用 | 過去取得のコメントを20件から25件へ訂正。assert・製品のpageSizeは保持 |

前回のA-O1〜A-X2について、新しい詳細図と今回の実コード読取から採否を覆す事実は見つからなかった。A-C1はA-P3と同様に保持期間と画面通知を分け、A-L1はA-O1の画像定義の移動に正規化の変更を混ぜない。A-T2で明確になったUI試験の限界は後続検証と「未確認」へ追記し、A-O1の採用範囲は変えない。以前の図の「試験本文未読」は各調査時点の記録であり、今回の設計では新しいtests.mdと下記の直接読取を使う。

## 共通して維持する契約

- 本体のHTTP route、method、JSONキー、任意項目の省略とnull、応答の型、SSE topicと更新先を変えない。Appleから公開する新しい本体向けAPIはない。Swiftの既存internal窓口も、明記した呼出し置換以外は名前・引数・戻り値を維持する。
- `AppStore`、画面の`@State`・`@StateObject`、`ConversationDraft`、画像cacheの所有と寿命を維持する。移動のためにView階層を一段増やしたり、`.id`、`.task(id:)`、sheetの取付位置を変えたりしない。ディスク保存、cookie、ログアウト・削除時の掃除は変えない。
- 入力検査、認証失敗、取消、結果不明、部分成功、再取得の順序を保つ。既存のcatchを共通化するために範囲を広げたり、成功扱い・再送・新しい再試行を加えたりしない。
- 画面文言、accessibilityの識別子、診断のpath・method・observation・contextと送信回数を維持する。`BellDiagnostics.report`の分類（`Core/BellDiagnostics.swift:322`）である`IOS_NETWORK_TIMEOUT`、`IOS_NETWORK_FAILURE`、`IOS_HTTP_5XX`、`IOS_RESPONSE_INVALID`を変更しない。OS由来のエラー文言をアプリ独自の文言へ置換しない。
- 新しいSwiftファイルはアプリtargetだけへ登録する。`project.yml:28`の既存`BellBot`ディレクトリ指定で収まり、設定・依存・resourceの追加は不要。`ios/BellBot/README.md:27`に従う生成済み`BellBot.xcodeproj/project.pbxproj`の同期は実装PRに含める。通知拡張の`Shared`へUIやAPI操作を移さない。
- 図は実装PRで同期する。この設計段階では既存図を変更しない。Appleの本体への接続は同じHTTP/SSEのため`module.json`と全体接続線の変更は不要。内部の実装所在・caller・所有者の記述だけを該当図と関数索引で更新する。

## A-O1：会話ファイルに置かれた独立部品

**採用。** ファイルの長さではなく、既に別の型と呼出境界を持つ責務を分ける。

### 確認した事実

`ios/BellBot/BellBot/Views/ConversationView.swift:50`の`ConversationContent`は取得・送信・選択と画面状態を持つ。同じファイルの`:823`は入力欄、`:886`は添付画像の検査・JPEG化、`:1282`以降は画像表示とcache、`:1533`はプロフィール、`:1611`以降は端末画面である。端末画面は`Views/DesktopWorkspaceView.swift:280`からも使われる。さらに`Core/ConversationDraft.swift:18`と`Core/PreviewFixtures.swift:49`が、Viewファイルに定義された`PendingImage`を参照している。

### 変更後の所有者と関数の役割

| 配置先 | 移す既存定義・役割 | 残す境界 |
| --- | --- | --- |
| `Views/ConversationInput.swift`（新規） | `ConversationInput`（入力欄と送信/停止ボタン）、`MessageInput`（SwiftUIとUITextViewの値の同期・寸法）、`MessageTextView`（Return・貼付け・寸法cache） | `ConversationInput`だけprivateからinternalへ。`MessageInput`はprivate、`MessageTextView`は既存internal。送信・停止処理はcallbackの呼出元が所有 |
| `Core/ConversationDraft.swift`（既存） | `PendingImage`の二つのinitializer。下書きが持つ添付値を作り、画像かどうかを検査する | UIKit importを追加。型・initの署名は同じ。`ConversationDraft`の通知方式、画像の保存場所を変えない |
| `Views/ConversationImages.swift`（新規） | `ConversationGallery`、`MessageImages`、`MessageImageGallery`、`AuthenticatedImage`、`conversationImageOrigin`、`ConversationImageCache`。画像束・gallery・認証取得・縮小復号を一緒に置く | `MessageImages`と`MessageImageGallery`だけprivateからinternalへ。他のprivate定義は同一ファイルに保つ。cacheをAppStoreや汎用画像サービスへ移さない |
| `Views/ConversationDetailView.swift`（新規） | `ConversationDetailView`をそのまま移す。対象プロフィールの表示とsheet遷移を所有 | `BotProfileHero`、`BotProfileAISection`、`BotProfileDetails`、画像modifierを引き続き利用。`images`のStateObjectもこのViewに残す |
| `Views/BotScreenView.swift`（新規） | `ScreenResponse`、`BotTerminalView`、`BotTerminalTextView`、`BotScreenView`。表示中の端末snapshotの取得と表示 | `refreshScreen`は表示task、`show`は文字列置換と読書位置保持。前二型はprivate、後二型は既存internalのまま |
| `Core/Models.swift`（既存） | `EmptyBody`だけを移す。再起動要求の空JSON値 | 定義名・encode結果を変えない。A-P2実施後にCoreがViewの型定義へ依存することも避ける。別機能の空要求型の全面統一はA-X2で不採用 |

`ConversationContent`、`ReadCoordinator`、`ConversationCardStates`、`ConversationSheet`、`ConversationHistoryPage`、`MessageRow`、`PeerMessageSheet`、送信失敗の観測型は会話ファイルに残す。取得・送信・画面反映に結び付いた状態を別のViewModelへ写す必要はない。`load`・`send`・`stopBot`の再設計も本候補には含めない。

### 比較した代替案

1. 現在の配置を保つ案では、プロフィール/端末の利用者も会話の入力実装と同じファイルを編集し、Coreの添付値もView定義に依存し続ける。
2. 会話全体をViewModelへ移す案は、reader世代、SwiftUIのtask取消、入力の通知頻度まで変更対象が広がる。目的に必要な分離を既存の型だけで行えるため採らない。
3. cacheだけをCoreの共通画像サービスへ移す案は、異なる寿命・画像仕様を持つアバターcacheまでまとめる根拠がない。取得・表示の既存まとまりを保つ上表を選ぶ。

### 変更窓口と全直接caller

| 窓口 | 固定sourceの全直接caller・参照 |
| --- | --- |
| `ConversationInput` | `ConversationContent.composer`（`ConversationView.swift:432`） |
| `MessageInput`とそのcoordinator | `ConversationInput.body:843`、SwiftUIの`make/updateUIView`・`sizeThatFits`・`makeCoordinator`、`Coordinator.textViewDidChange:1021`。UIKitのdelegate/selectorは移動後も同じ |
| `MessageTextView` | `MessageInput.makeUIView:969`、同`updateUIView`・`update`・`sizeThatFits`・coordinator。`MessageInputTests.swift:11,37` |
| `PendingImage` | `ConversationContent`のattachments（`:72,73`）、`restoreUnconfirmedSend:737`、`attachImageFiles:805`、`loadPhotos:809`、入力部品のcallback（`:831,965,1030`）、`MessageTextView.paste:1087`、自身のfile initializer（`:902`）。ファイル外は`ConversationDraft.attachments:18`と`AppStore.preparePreview`（`PreviewFixtures.swift:49`）のみ |
| `ConversationGallery` | 会話の`presentedGallery:94`と`timelineRow:279`、`PeerMessageSheet.gallery:1250`と画像選択callback`:1266` |
| `MessageImages` | `MessageRow.body:1185,1197`、`PeerMessageSheet.body:1265` |
| `MessageImageGallery` | `ConversationContent`のcover`:175`、`PeerMessageSheet`のcover`:1277` |
| `AuthenticatedImage` | `MessageImages.body:1295,1301`、`MessageImageGallery.body:1357,1378` |
| `conversationImageOrigin` / `ConversationImageCache.image` | `AuthenticatedImage`のtask`:1440,1442,1444`だけ。cacheの`decode`は`image:1505`からだけ |
| `ConversationDetailView` | `ConversationContent`の詳細sheet`:215`だけ。SwiftUIがbodyとmodifierを実行 |
| `BotScreenView` | `ConversationDetailView`のsheet`:1598`、`DesktopInspector.body`（`DesktopWorkspaceView.swift:280`） |
| `ScreenResponse` / `BotTerminalView` / `BotTerminalTextView.show` | 順に`refreshScreen:1717`、`screenContent:1696`、`BotTerminalView.updateUIView:1635`。`BotTerminalTextViewTests.swift:7`も直接生成して`show`を呼ぶ |
| `EmptyBody` | `ConversationDetailView`の再起動`:1577`、`DesktopInspector.profile`の再起動（`DesktopWorkspaceView.swift:328`）。A-P2でこの二つをAppStoreの操作へ置換 |

名前検索に加え、SwiftUIのmodifier、UIKit delegate・`#selector`、private型を同居させる必要、XcodeのSources登録を確認した。移動先でも型のモジュール名はBellBotのまま。外部export、asset、JSON fixtureの改名はない。

### 試験・fixtureと維持する契約

- 直接単体試験は`BotTerminalTextViewTests.testSnapshotReplacementPreservesReadingPositionAndFollowsBottom`、`MessageInputTests.testTabletReturnSendsAndModifiersInsertNewlines`と非Catalystの`testPhoneReturnUsesSystemKeyboardBehavior`。`ConversationDraftTests`の入力通知・同じ会話での共有・外部clearの4試験も隣接契約として所在を確認した。draftのコードは変えないため全体のログアウト試験を追加実行する理由にはしない。
- 直接UI境界の既存試験は`DesktopWorkspaceUITests`の`testMacHasOneInspectorButtonAndNoProfilePopup`、`testBotScreenStaysInInspectorAndEditorOpensLargeWindow`、`testConversationReturnKeys`、`testConversationSwitchPreservesDraftAndInspector`。`ConversationAppearanceUITests`の画像表示2件、本文コピー、入力欄成長2件、貼付け失敗復元も対応する。`BotStopUITests`の2件は移動する入力欄の停止ボタンとルームの停止表示を扱う。
- iPhone/iPadの対応先は`ProfileTerminalUITests`の端末照会・1万行表示、旧schema、既存Botの画像操作各試験、`testTabletKeepsInspectorWithNewProfileContent`、`TabletWorkspaceUITests`のプロフィール・draft・キーボード・共通編集sheet。Owner写真と新規メンバー写真の試験はこの移動対象を直接検証しない。これらの端末を段階ごとの実画面確認へ加える計画ではない。
- `NetworkLifecycleProbeUITests.testFailedImagePostRestoresComposerWithoutResend`と`testHTTP503PostKeepsComposerUntilExplicitRetry`は添付復元、`testConfirmedSaveReferenceReachesMainReceiver`は詳細から編集への経路を通る。本体の診断受信まで含むため今回の直接試験の実行対象には加えない。
- fixtureは`Core/PreviewFixtures.swift`の`preparePreview`・`PreviewMessages`、`MessageInputTests`の`TextRecorder`、`BotTerminalTextViewTests`内の生成した1万行文字列。プロフィール/端末のHTTPは`test/helpers/profile-terminal-ui-server.mjs`、Mac編集は`test/helpers/member-editor-server.mjs`。型の移動による内容変更は不要。
- `ConversationAppearanceUITests`が要求する`BELLTEAM_IMAGE_SMOKE_URL`のサーバー実装は今回確認できなかった。画像移動の実装PRでは、同じ有限データ（`sent-many`、`legacy-one`、PNG/JPEG、画像GET失敗）を提供するfixtureの所在を確定してから画像確認を行う。URL未指定によるskipを画像確認の成功に含めない。
- `Tests/AppleSubscriptionAccessChecks.swift`と`Tests/BotStopContractChecks.swift`はどちらも移す型を参照しない。`Shared`・通知拡張にもこれらの型のcallerはない。試験用Swift型をアプリのpublic exportに変える必要はない。

添付のJPEG品質0.85、file URL検査、security scopeのdefer、二つの入力エラー文言（`:899,903`）を保持する。入力のReturn/修飾キーとiPhoneの標準動作、文字更新と外部復元の区別、最大5行の高さ、ファイル貼付け優先を保持する。

画像はorigin/pathと表示サイズを使うcacheキー、二つの64 MiB上限、取得taskの共有と成功/失敗後の除去、縮小復号、`invalidResponse`、読取失敗の表示・診断を保持する。サインアウト時のcache消去追加や大画像の前面復帰再読込は行わない。

端末は表示中かつactiveの1秒照会、`?history=1`、snapshot置換、Bot切替時の初期化、取消時の無表示、認証時の`requireLogin`、それ以外の失敗表示・診断後の停止を保持する。`show`の末尾判定28ポイントと読書位置も変えない。プロフィールのStateObject、編集sheet、削除検知によるdismissは型ごと移す。

## A-S1：Bot保存・照合と値型の同居

**採用。** 通信の所有者は既にBellAPIで正しい。所有者を変えず、実装の所在を明示する。

### 事実・設計・代替案

`ios/BellBot/BellBot/Core/BotSettings.swift:3–150`はプロフィール値、編集draft、画像選択、要求encode、保存結果を定義し、`:152–232`はBellAPIの4操作である。一般通信は`Core/BellAPI.swift:189`以降にあり、4操作はその`get`・`patch`・`diagnostics`だけを使う。

4操作を`Core/BellAPI+BotSettings.swift`へ移す。`saveBotSettings`と`saveBotAvatarSelection`は「PATCHし、限定した通信失敗だけをGET照合へ渡し、結果に応じて診断する」、二つの`confirm`は「GETした保存値と提出値を比較する」とする。署名・既定引数・catchの範囲は同じで、型とencodeは`BotSettings.swift`に残す。

代替は全てを`BellAPI.swift`へ集める案と、現在の同居を保つ案。前者はBot固有の比較まで汎用通信ファイルへ混ぜ、後者は値型と通信を分けられない。既存extensionの移動だけで境界が明瞭になる専用ファイルを選ぶ。保存/照合をclosure引数の汎用wrapperへまとめる案も、全プロフィール比較と画像3項目比較の違いを隠すため採らない。

### 全caller・試験・fixture・export

| 操作 | 製品の全caller | 直接単体試験（`BotSaveTests`） |
| --- | --- | --- |
| `saveBotSettings` | `BotEditor.save`（`ManagementView.swift:408`） | `testLostResponseAfterSavingIsConfirmedWithoutResendingPATCH`、`testAntigravityModelAndEffortSurviveSaveReadback`、`testFailureBeforeSavingReportsDifferentWithoutResendingPATCH`、`testUnavailableReadLeavesResultUnconfirmedWithoutResendingPATCH`、`testConfirmedSaveIsReferenceWithEvidenceAndNoRepeatedWrite`、`testTimedOutWriteAlsoChecksTheSavedContent`、`testTextSavePreservesAnAvatarChangedOnAnotherDevice`、`testExplicitConfirmationAfterReconnectDoesNotWriteAgain`、`testAuthenticationFailureDuringConfirmationStillRequiresLogin` |
| `confirmBotSettings` | `saveBotSettings:201`、`BotEditor.confirmSave`（`ManagementView.swift:484`） | 上記保存試験が内部呼出し。直接呼出しも行うのは`testExplicitConfirmationAfterReconnectDoesNotWriteAgain` |
| `saveBotAvatarSelection` | `BotProfileImageState.saveImage`（`BotProfileComponents.swift:57`） | `testSmallImageLostResponseConfirmsOnlySmallTriplet`、`testLargeImageLostResponseConfirmsOnlyLargeTriplet` |
| `confirmBotAvatarSelection` | `saveBotAvatarSelection:162`、`BotProfileImageState.confirmImageSave`（`BotProfileComponents.swift:93`） | 上記画像保存2試験が内部呼出し。単独での直接呼出し試験は確認していない |

要求の関連試験は同ファイルの`testImageOnlyRequestSendsExactlyTheSelectedTriplet`と`testFastModeIsSentOnlyWhenChanged`。fixtureは`oldSettings`・`newSettings`、`SaveFixture`・`SaveProtocol`・`makeAPI`（`BotSaveTests.swift:279–363`）。PATCHの適用前/後の応答喪失、GET失敗・401、method列を検査しており、この形を維持する。ファイル移動だけを確認する新しい試験は足さない。

UIのcaller経路は、`DesktopWorkspaceUITests.testSaveWithoutAvatarChangesWhileModelsArePending`、`AuthTypedUITests.testTabletAntigravityModelAndEffortReadback`、`ProfileTerminalUITests`の小画像保存・大画像保存・取消、`NetworkLifecycleProbeUITests.testConfirmedSaveReferenceReachesMainReceiver`。`InstalledConversationUITests.testPrepareExistingMemberSaveInterruption`は保存前の画面準備だけで、保存自体を試験しない。`ProfileTerminalUITests`の旧schema試験も保存ボタンの利用可否までである。実装PRの実行対象は直接の単体試験とMac編集画面の確認までで、本体受信の結合試験を定型追加しない。

関連HTTP fixtureは`test/helpers/member-editor-server.mjs`、`profile-terminal-ui-server.mjs`、`antigravity-editor-server.mjs`と、`BELLTEAM_REPORTING_PROBE_URL`で渡す診断試験環境。前の3ファイルは本文を確認したが、いずれも稼働確認はしていない。今回のファイル移動によるfixture変更はない。`Tests/`2本に直接callerはない。4操作のinternal公開範囲は同じで、Xcodeへの新ファイル登録だけが必要。

### 維持する契約

PATCHは一度だけ。GET照合へ進むのは`URLError.networkConnectionLost`と`.timedOut`だけで、5xx・復号失敗を追加しない。`confirmed`・`different`・`unconfirmed(Error)`の区別、GET認証失敗のthrow、それ以外の確認失敗を`unconfirmed`へ包む現状を維持する。

全プロフィールは4文字列のtrimと未変更画像の現在値補完を維持し、画像だけの保存は選択variantのrender/source/cropだけを送信・比較する。`fastMode`の変更時だけの送信、画像optionalのnull encodeも同じ。新規Bot作成は引き続き`BotEditor.save`のPOSTであり、この4操作へ取り込まない。

保存照合成功時は`handling=saved_content_confirmed_by_read`、`recovery=recovered`、`input=retained`、impact handledを保持する。他の結果は`.write`。診断のpathは`/api/bots/:id`、methodはPATCH。画面の`.saved`だけがrefresh/closeへ進む違い、画像保存成功後の表示更新失敗文言、選択保持は呼出元に残す。

## A-S2：診断送信と通常HTTPの共通化

**不採用。** `ios/BellBot/BellBot/Core/BellDiagnostics.swift:400–429`はURLSession.sharedと共有cookieを使い、HTTP 202だけを成功とする。本文をdecodeせず、失敗はLoggerへ書く。`onReport`があればHTTP自体を使わない。

対して`Core/BellAPI.swift:97–118,292–312,416–443`は専用sessionと注入されたcookieStorageを使い、Accept、認証、最終接続先、2xx、JSON MIME、decode・traceを扱い、失敗をcallerへthrowする。request生成の数行が似ていても、通常APIの`post`への置換は202以外の扱いと診断自身の失敗処理を変える。

代替の小さなURLRequest生成helperも、片方だけのAccept、異なるURL構成、sessionとcookieの所有を引数へ持ち出す必要がある。既存部品が不足している根拠はなく、診断はBellDiagnostics、通常HTTPはBellAPIに残す。通常APIが自動で診断を再送するという事実はないため、架空の無限再帰を不採用の根拠にはしない。

`BellDiagnosticsTests`の分類・匿名化・pathの試験は送信経路統合の許可を与えない。両経路の現行契約、Loggerの「診断の送信に失敗: 応答が不正」とエラー型の文言、`IOS_HANG`・`IOS_CRASH`を含むコードは変更しない。

## A-M1：一覧の検索・順序・副題

**不採用。** `ios/BellBot/BellBot/Views/HomeView.swift:9–27,206,245`と`Views/DesktopWorkspaceView.swift:16–22,151,156`を照合した。

名前検索の式は同じだが、Homeは日時parse・不正値distantPast・同日時の元順維持、Desktopは日時文字列の降順である。Homeだけにpeer文言とposition/purpose空時の固定文がある。両者を一つのsort/subtitleへ置換すると表示が変わる。

代替のplatform別policyを取る共通関数は、現状の違いを設定に写すだけになる。検索の1行をBot/Roomの新しい抽象へ移す案にも、消せる処理や不要な受渡しがない。現在の画面内の検索語と表示決定を残す。`currentWork`表示、役職検索、ルーム参加者検索は後段のUI改善であり、既存候補の採用として混ぜない。

関連する既存UI試験は`ProfileTerminalUITests.testPhoneSearchProfileAndVisibleScreenPolling`と`testTabletKeepsInspectorWithNewProfileContent`。名前検索のtrim追加、検索対象追加、peer文言の統一、日時処理の統一は行わない。

## A-P1：Owner保存手順と診断path

**保留。今回の採用対象にしない。** 関数分割は採らず、診断path不一致の修理を別の差分で判断する。

`ios/BellBot/BellBot/Views/SettingsView.swift:277–296`の`save`は、名前検査、savingのdefer、Owner PATCH、規範PUT、一覧refresh、dismissと失敗表示を20行で表す。この順序は一つのフォーム保存の完了条件である。callbackを含むcallerは同`:249`の保存ボタンだけ。読取は同`:252`のtaskから`load`へ入り、`:267`で`/api/user-rules`をGETする一方、`:272`の診断pathは`/api/owner`である。

APIにOwner+規範の複合保存関数を新設する案は、利用者が一つで、画面のrefresh/dismissは結局残る。Owner全体の新しいViewModelも、現在のdraftと保存手順を写すだけになる。今のprivate関数とprivate要求型を残す。

診断pathを`/api/user-rules`へ直すこと、失敗した段階ごとに文言を分けることは、診断/表示契約の変更である。今回の整理で静かに変更しない。現状は`BellDiagnostics.report`がtraceのrouteを優先し、両pathはowner moduleへ分類される（`Core/BellDiagnostics.swift:341–348`、`BellDiagnosticsTests.swift:189`）。このため、不一致だけから既発行診断が誤分類されたとは断定しない。

維持するのは、未trimの名前を本文へ送ること（trimは空検査だけ）、規範PUT失敗時にOwnerをrollbackしないこと、refresh失敗時にsheetとdraftを残すこと、認証時の`requireLogin`、保存中にキャンセルとフォーム全体を無効化しない現状である。loadのpath・method・`.read(...retainedData: store.owner != nil)`とsaveの`method:nil`・`.write`もそのまま。

関連試験はOwner写真保持の`ProfileTerminalUITests.testPhoneOwnerPhotoSurvivesInitialRulesReply`、`AvatarCropUITests`2件。Owner PATCH→規範PUTの部分成功を直接検査する単体試験は確認できなかった。診断修理を行う工程ではこの失敗点を直接確認する必要があるが、今回その実装・試験は行わない。

## A-P2：プロフィール二画面の再起動

**採用。** 共通化するのは利用権限確認とPOSTの順序だけ。

### 事実・設計・代替案

`ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift:323–335`と`Views/ConversationView.swift:1572–1581`はともに`authorizeAIUse(target:)`の後で`target.path + "/restart"`へ空bodyをPOSTする。成功時はDesktopがerrorを消し、詳細sheetがdismissする。失敗時もDesktopは`operationFailureMessage`と診断`.write`、詳細sheetは`localizedDescription`だけという違いがある。

`AppStore.restartConversation(target:) async throws`を追加し、既存の`authorizeAIUse`と`api.post`の二つをこの順で実行する。`APIAcknowledgement`の受領までを担い、再起動完了の新しい意味を足さない。catch、UI状態、画面遷移、診断は入れない。AppStoreは既に利用権限、共有API、メンバー削除などのアプリ操作を持つ（`Core/AppStore.swift:394,543,571`）。

代替の`BellAPI.restartBot`は購読確認まで所有できず、二画面に権限確認の重複が残る。`BotProfileAISection`へ通信を埋める案は表示部品へAppStoreと画面ごとの失敗方針を持ち込む。AppStoreの一つの具体的操作が最小である。利用者の異なる`send`やgoal操作まで同じwrapperへ取り込まない。

### 全caller・試験・fixture・export

- 変更するcallerは上記の`DesktopInspector.profile`と`ConversationDetailView.body`の`onRestart`だけ。`BotProfileAISection`（`BotProfileComponents.swift:455–472`）はcallback契約を維持する。`authorizeAIUse`の他callerは変更しない。
- `EmptyBody`はA-O1でModelsへ移動済みの同じ型を利用する。新しいpublic export、endpoint、設定、payload型はない。
- 再起動のHTTP順序・回数を直接検査する既存単体試験は確認できなかった。実装PRでは`BellBotTests/BillingStoreTests.swift`内の既存`BillingScenario`・`BillingProtocol`・`makeAPI`と`readAppleEntitlement`注入を利用し、`restartConversation`を直接呼ぶ最小の試験を追加する。権限確認失敗でPOSTゼロ、許可で正しい宛先へ空JSONのPOST一回、POSTのtimeout/401/不正JSONを元のErrorのまま返し再送しないことを検査する。初期guideについては既存`authorizeAIUse`のsetup照会順を維持し、その分岐を直接通すケースも置く。
- `BillingScenario`は現状GET `/api/subscription`だけを受け付け、`BillingProtocol`は成功時200を返す（`BillingStoreTests.swift:277–317`）。後続PRで再起動POSTの空body記録・成功/401/timeout/不正JSONと、初期guide用GET `/api/setup`の有限の応答を追加する。製品用protocolや購読の迂回条件は作らない。詳細/inspectorの違いはcallbackの成功・失敗後のコードを残して確認する。
- 既存UI試験`DesktopWorkspaceUITests.testMacHasOneInspectorButtonAndNoProfilePopup`と`ProfileTerminalUITests.testTabletKeepsInspectorWithNewProfileContent`は再起動ボタンの存在までで、POSTは検証しない。Mac実画面では既存`profile-terminal-ui-server.mjs`に人工の購読応答と再起動の成功/失敗応答・要求記録を足して確認する。このfixtureには現状restartとsubscriptionのrouteがないため、そのままで成功確認ができるとは扱わない。
- `Tests/AppleSubscriptionAccessChecks.swift`は許可判定の既存契約、`Tests/BotStopContractChecks.swift`は別操作の停止契約。いずれも再起動callerではなく今回の追加実行対象にしない。

### 維持する契約

購読確認・初期guide判定が完了するまでPOSTしない。POST後の一覧refresh、再起動完了待ち、送信排他、取消検査、認証画面への自動移動を新設しない。両callbackのTaskと捕捉するtargetをそのままにする。

Desktop成功時の`errorText=nil`、詳細成功時のdismiss、Desktop失敗時の結果未確認案内と`/restart`・POST・`.write`診断、詳細失敗時の`localizedDescription`だけを保持する。共通関数が診断を追加して二重送信したり、詳細にもDesktopの文言を適用したりしない。

## A-P3：画像選択の画面状態と再生成用draft

**不採用。** `ios/BellBot/BellBot/Views/BotProfileComponents.swift:16,22–36`は画面のPublishedな`pendingSelections`を、非Publishedの`AppStore.profileImageDrafts`（`Core/AppStore.swift:86`）へ保存/復元する。後者は接続先変更（`:173`）、メンバーの一覧消失（`:567`）、明示logout（`:811`）で除去され、再認証（`:782`）では保持される。

`AvatarSelectionDrafts.finish`（`Core/BotSettings.swift:91`）は返答が現在の選択と一致した時だけ成功選択を除去する。`BotSaveTests.swift:7,23,254`は遅延確認、variantごとの保持、再認証保持とlogout消去、draft変更でAppStoreの更新通知が出ないことを検査している。

代替のAppStore辞書だけをPublishedにする案は通知対象が変わり、画面だけに残す案は再生成後の保持が失われる。AppStoreにBotProfileImageState自体を保持する案は、sheet・crop・保存中・エラーまでアプリ寿命に広げる。参照型へ変えて全画面で共有する案も、現在のコピーのタイミングと複数画面の相互反映を変える。

現状の`loadDrafts`（Heroの`.task(id: bot.id)`）、save/confirm/discard後の`persistImageSelections`、成功後のrefreshと失敗選択保持を残す。二画面同時編集時にコピーが古くならないかは実測しておらず、欠陥とは断定しない。大画像の前面復帰再読込の保留修理もここへ取り込まない。

## A-X1：Botプロフィール応答の重複定義（追加）

**採用。** `ios/BellBot/BellBot/Core/BotSettings.swift:3`の`BotProfileResponse`と`:215`のローカル`ProfileResponse`は、ともに`Decodable { let bot: BotSettings }`である。後者だけを削除し、`confirmBotSettings`のGET戻り値を既存`BotProfileResponse`にする。新しい型もtypealiasも不要。

所有者は引き続き`BotSettings.swift`の応答値型で、確認処理はA-S1のBellAPI extensionが持つ。代替の両型維持は同じJSON構造を二重に管理し、汎用`Response<T>`の新設は他の応答まで変更範囲を広げる。既存型への置換を選ぶ。

ローカル型の全callerは`confirmBotSettings:217`だけ。既存型のcallerは`confirmBotAvatarSelection:176`と`BotProfileAvatarActions.loadSettings`（`BotProfileComponents.swift:398`）で、この二つは変更不要。`confirmBotSettings`の上流caller・試験・fixtureはA-S1表の全項目と同じである。`Tests/`とUI試験からローカル型を直接参照する箇所はない。privateなローカル型の削除だけで外部exportの削除はない。

`bot`キーの必須性、BotSettingsの必須/optional項目、BellAPIのsnake_case変換、保存値比較を維持する。GET復号失敗は`unconfirmed`、認証失敗はthrowのまま。診断は生の型名を出さずDecodingErrorの種類・許可されたcoding pathを記録する（`Core/BellDiagnostics.swift:437`）。実装PRでは`BotSaveTests`の確認GETに`bot`欠落/型不正を返す小さなケースを追加し、`unconfirmed(DecodingError)`と元のcoding pathが残ることを確かめる。保存の再送は増やさない。

## A-X2：空のHTTP要求型4個（追加）

**不採用。全面統一は行わない。** `ios/BellBot/BellBot/Views/ConversationView.swift:958`の`EmptyBody`、`Core/Models.swift:423`の`SetupEmptyBody`、`Core/BillingStore.swift:23`の`EmptyBillingRequest`、`Views/SchedulesView.swift:280`の`ScheduleEmptyBody`は、いずれもフィールドのないEncodableである。

利用先は順に再起動二画面、初期案内開始（`AppStore.swift:377`）とAI再認証の開始/取消（`HarnessAuthenticationFlow.swift:47,69`）、購読再確認（`BillingStore.swift:280`）、予定手動実行（`SchedulesView.swift:205`）。重複しているのは空型の宣言だけで、分岐、encode実装、入力検査の重複ではない。

代替は既存`EmptyBody`を全用途へ使う案。型宣言3行は消せるが、独立した初回認証・購読・予定のcallerまで変更する利益が小さいため採らない。再起動で既に共有される`EmptyBody`の配置だけをA-O1でCoreへ移す。各用途の公開HTTPと空JSON本文を維持し、全面統一用の試験や設定を増やさない。

## A-C1：添付・宛先の画面状態と会話draft

**不採用。** 保持先が二つあることだけを理由に削除しない。画面の更新通知と、会話を開き直した時の復元は現状の二つの所有者へ残す。

### 確認した事実と代替案

`Views/ConversationView.swift:72–80`は添付の`@State visibleAttachments`を表示に使い、`attachments`のsetterでdraftにも同じ配列を書き込む。宛先は`@State selectedTargets`を`:241`のonChangeでdraftへ返す。`:236–241`のonAppearで両者を復元する。`Core/ConversationDraft.swift:18–19`の添付・宛先は非Publishedで、通知するのは本文の`textRevision`（`:17,35–45`）。`ConversationContent`はdraftをObservedObjectとして保持せず、入力部品だけが購読する（`ConversationView.swift:432,824`）。AppStoreの辞書は画面再生成をまたいで同じ宛先の参照を返す（`Core/AppStore.swift:118–126`）。

画面のコピーを削除して現在のdraftを直接読む案では、添付・宛先変更を画面へ知らせる経路が足りない。draftをPublishedにして親Viewでも購読する案は、本文通知が届く範囲と、別画面から同じdraftを変えた時の反映時点まで変える。画面だけに残す案は会話切替後の復元を失う。同期helperを新設する案も既存setterとonChangeを包むだけであり、採らない。

### caller・試験・fixture・exportと維持する契約

変更する窓口・export・設定はない。検討した値の直接利用は、同ファイルの表のbottomInset（`:121`）、復元/onChange（`:237–241`）、composerと貼付けcallback（`:432–436`）、添付stripと除去（`:483–498`）、宛先Menuとlabel（`:518–550`）、canSend（`:555`）、失敗復元（`:737–741`）、send（`:745–801`）、ファイル/写真読取（`:805–815`）。draftの外部生成・消去は`AppStore.draft/removeDraft/signOut`、添付fixtureは`Core/PreviewFixtures.swift:49`である。A-O1のPendingImage移動はこの受渡しを変えない。

対応試験は`ConversationDraftTests.swift:8–78`の通知・参照共有・logout、`AuthenticationRecoveryTests`の再認証保持、`ConversationAppearanceUITests.testPastedImagesBecomeAttachmentsAndReturnAfterFailedSend`、`DesktopWorkspaceUITests.testConversationSwitchPreservesDraftAndInspector`、`TabletWorkspaceUITests.testLandscapeColumnsRotationAndConversationDrafts`、`NetworkLifecycleProbeUITests`の画像送信失敗2件。draftの単体試験は主に本文を検査し、添付/宛先の画面間同期をすべて証明するものではない。fixtureは既存previewと`test/fixtures/bughub-ui-probe.mjs`を参照する既存UI経路であり、変更しない。

添付のsetterと宛先onChangeの順序、送信中に入力された本文・画像を元の送信分の後へ残すこと、宛先を送信前に消さないこと、再認証保持と明示logoutのclearを維持する。複数画面の同期不全や不要な再描画は実測しておらず、現状を欠陥と断定しない。

## A-C2：会話書出し失敗の診断path

**不採用。診断の修理として別工程に分ける。** path訂正を挙動不変の整理として採らない。

### 確認した事実と代替案

`Views/ConversationView.swift:297–307`は`T/export`のDataを`ConversationDocument`へ渡す一方、catchのreportへ`T/messages`を渡す。`Core/BellAPI.swift:229–230`は渡されたpathでGETする。実HTTPの送信先がmessagesになっているわけではない。`Core/BellDiagnostics.swift:341–348`はtraceのrouteを優先し、trace無しのrequest contextはunknownを使うため、引数の不一致だけで既発行診断の誤分類・誤送信までは断定できない。

診断pathだけ直す案も診断の入力契約を変更する。書出し取得とcatchを新しいサービスへ移す案は一つしかない操作を分けるだけである。`kind`を消して`target.path`へ置換する案も診断不一致を解決せず、本候補を部分採用する理由にしない。

### caller・試験・fixture・exportと修理時の範囲

今回変更する窓口はない。Viewの全callerはtoolbarのボタン（`:201`）だけ、APIの`exportConversation`の全callerはそのView関数（`:302`）だけ。後続は同`:220–223`のfileExporterと`Core/ConversationDocument.swift`のFileDocumentである。exportのHTTP経路・保存UIを直接検査する既存試験は確認できなかった。隣接する診断試験は`BellDiagnosticsTests.testRequestContextDoesNotInferOperationFromFallbackPath`と`NetworkRecoveryTests.testHTTP500ReportUsesFailedConversationRoute`であり、書出しの実画面試験ではない。専用fixtureと外部exportの変更は今回ない。

修理する場合は、まず書出しGETの失敗を人工応答で再現し、trace有り/無しの診断と表示を確認する。変更範囲はこのcatchのpathと直接試験・必要な有限のexport応答fixture、conversation/testsの対応記述まで。共通診断の分類方針変更は混ぜない。HTTP route/method、JSONのData、保存名、fileExporterの失敗表示、exportingのdefer、診断の回数とretainedDataの判断はそのままにし、文言・分類も変える必要があるなら別途明記する。

## A-C3：初回page保持と表示中のtimeline

**不採用。** 初回表示用のpageと、表示中の履歴を一つの状態へまとめる必要はない。

### 確認した事実と代替案

`Views/ConversationView.swift:634–651`は前回pageを先に表示し、初回GETの10件を世代付きで`AppStore.remember`へ渡す。通常更新（`:700–734`）はlatest/afterを併合し、過去取得（`:681–697`）は既知IDを除いて先頭へ加える。両経路にrememberはない。`Core/ConversationTimelineState.swift:5–19,27–75`は受信履歴と未照合送信を分け、受付IDで照合する。`AppStore.swift:158–165`の保持pageは単なる値で、削除時に世代を進める。

全取得後にpageを保存する案は、開き直した直後の内容・件数・hasMoreとメモリ保持量を変える。timelineをAppStoreへ移す案はpending送信・queue・画面寿命まで広げる。pageを削除する案は再表示時の先行表示を失う。既存の`ConversationTimelineState`と`remember`で各役割を表せており、新しいrepositoryやcache protocolは不要。

### caller・試験・fixture・exportと維持する契約

変更する窓口はない。製品のpage読取は`loadInitial:638`、rememberは`:650`の1か所。`clearConversationPages`は接続先変更（`AppStore.swift:172`）とsignOut（`:810`）、世代値はloadInitialとrememberが使う。直接試験は`ConversationAppearanceTests.testClearedConversationPagesRejectLateResponses`（`:224–232`）。timelineのreplace/merge/prependは`loadInitial`・`refresh`・`loadOlder`とDebug履歴、begin/accept/rejectはsend・restoreUnconfirmedSendが使い、`ConversationTimelineStateTests`の2件が直接検査する。

UIの接続は`ConversationScrollUITests`の初回・過去取得・新着・対象通知・最古到達・回転、`DesktopWorkspaceUITests`の短page追加、`NetworkLifecycleProbeUITests`の会話/queue取得失敗・受付と履歴照合。fixtureは`PreviewMessages`、`test/helpers/conversation-scroll-server.mjs`、`test/fixtures/bughub-ui-probe.mjs`で、payloadや起動設定を変えない。pageの製品callerを増やさず、旧世代応答の棄却、初回本文をqueueより先に出すこと、過去追加時の読書位置、仮送信を保持pageへ混ぜないことを保つ。

## A-R1：秘密入力の利用許可段階の認証失敗

**不採用。認証復帰の修理として別工程に分ける。** catchの統一は画面遷移と秘密値の扱いを変える。

### 確認した事実と代替案

`Views/SecretRequestView.swift:93–111`は、利用許可の失敗をlocalizedDescriptionへ表示してreturnし、値はその時点で消さない。許可後にだけ値を退避・消去してPOSTする。POSTの認証失敗はdismiss→requireLogin、その他は固定文言とsecretWrite診断。`Core/AppStore.swift:394–398`は要求元Bot IDが既知のguideBotIdと一致すれば、初期案内の免除判定前にsetup GETを行い、そのエラーをthrowする。したがって前段で認証エラーが届く経路は静的に確認できるが、実環境での発生は未確認である。

両段階を一つのdo/catchへまとめる案は、許可失敗に秘密POSTの結果不明文言・診断を使うことにもなる。前段に認証catchだけ足す案でも、sheet終了・非表示時の値消去（`:88–89`）とloginへの移動が新たに起きる。A-P2の再起動操作の共有に混ぜたり、全AI操作用wrapperを追加したりしない。

### caller・試験・fixture・exportと修理時の範囲

今回は全窓口を維持する。`finish(submit:)`の全callerは登録/拒否ボタン（`:72,74`）。`SecretInputSheet`の全生成元は会話カード（`ConversationView.swift:170`）、BellTabs（`App/BellBotApp.swift:201`）、DesktopWorkspaceView（`:92`）。共通の利用許可関数と`BellAPI.finishSecretRequest`の署名・送信先は変えない。

関連試験は`AuthenticationRecoveryTests`の認証種別とdraft、`BillingStoreTests`の権利確認、`SecretTransportTests`のHTTP拒否/redirect、`SecretInputUITests`の登録表示、`ConversationFreezeUITests.testSecretSheetSurvivesUpdatesThatMoveItsRowOffscreen`。`scripts/secret-input-smoke.mjs`はHTTPSと保存値/通知本文の確認用で、許可段階の認証失敗を直接再現しない。`BotSaveTests`と`BellDiagnosticsTests`の秘密POST診断も前段のcatchは通らない。

修理時は、初期guideのsetup GETを401/Access認証要求にする有限fixtureで、submit/cancel両操作の前段を再現する。前段の認証失敗での画面遷移、値を消す時点、秘密POSTゼロ、通常の購読拒否での既存表示、POST後の認証失敗を直接確認する。修正範囲はSecretInputSheetと必要な試験・fixture・requests-and-authの記述であり、AppStoreやBillingStoreの全callerを一括変更する根拠にはしない。秘密の通常会話送信、自動再POST、秘密値の診断記録は加えない。

## A-R2：初回認証と再認証の状態管理

**不採用。** 同じtyped入力・通信は既に共有されている。状態管理まで統合する根拠はない。

### 確認した事実と代替案

`Core/AppStore.swift:337–379`はアプリ寿命のSetupResponse全体とrevision/readSequence/updatingを所有し、AI選択・guide開始・phase遷移へ接続する。自動GETは変更中/明示更新待ちならreturn、変更の前後でrevisionを進める。`Core/HarnessAuthenticationFlow.swift:6–87`は選んだharnessの画面寿命でauth/started/busy/needsRefresh/requestSequenceを持つ。明示refreshはbusyを立て、pollは入力を無効化せず、cancelはPOSTの後にGETを行う。両方とも現行UI一致と`AuthenticationUI.reply`を使い、入力送信はBellAPIの保護通信を使う。

共通flowへまとめる案はSetupResponseとHarnessAuthenticationResponse、guideへの遷移、startedとcancelの有無、pollと明示refreshの違いをpolicy/closureへ持ち出す。世代カウンタだけのhelperも変更前後の更新時点と取消の差を隠す。初回状態を新しいObservableObjectへ移すだけの案も、AppStore外の所有者と通知の接続を増やす。既存の値型・AuthenticationInstructions・BellAPIを引き続き使う。

### caller・試験・fixture・exportと維持する契約

変更する窓口はない。初回の全callerは`OnboardingView.swift:23,39,42,46,49,65`の選択/入力/開始/明示更新/poll、AppStore内の購読setup要求（`:138`）、guide利用確認（`:396`）、SSE setup（`:697,760`）。`loadInitialState`は初回SetupResponseを直接読む。再認証flowは`HarnessAuthenticationView.swift:126`で生成し、`:139,150,158,161,176,178,184`でrespond/start/refresh/cancel/pollを呼ぶ。flow内部のperform/applyは同じファイルの各操作だけが使う。

直接試験は`AuthSetupOrderingTests.swift:7–103`の4件と`HarnessAuthenticationTests.swift:41–152`の読取/開始/入力/取消/失敗/pollの7件。前者は`test/helpers/auth-ui-server.mjs`の保留GETと旧成功/503、後者は同ファイルの`RequestLog`・`HarnessAuthProtocol`を使う。UI経路は`AuthTypedUITests`の初回とtyped表示、`HarnessAuthenticationUITests`の4件。関連fixtureはauth-ui、antigravity-onboarding、harness-authの各serverで、変更不要。新しいpublic export・設定・依存を作らない。

旧成功/旧失敗の棄却、入力失敗後の自動GETと再入力停止、明示更新での解除、poll時の入力可、取消POST後のGET、認証入力の消去、閉じるだけではcancelしない契約を保つ。読取順序を一律の仕組みに変えることを「同じ機能」と扱わない。

## A-G1：goalの値型・取得状態と画面の同居

**採用。** 応答の解釈と取得・変更状態を、既存の型のまま配置する。画面は引き続きGoalsView.swiftにまとめる。

### 確認した事実

`Views/GoalsView.swift:65–310`はharness別の値型とdecode・表示用算出値、`:343–462`はGoalViewModelのHTTPと状態遷移、`:464,602,715,839`は一覧・会話bar・カード・editorである。`GoalLoadCallContext`（`:4–25`）と`GoalForegroundLoad`（`:28–55`）はViewを生成せず、診断の観測と読取taskを扱い、既に単体試験から直接使われている。GoalViewModelは一覧と会話barが別々に生成する（`:467,606`）。UI階層を変えずにこれらの定義だけを移せる境界がある。

### 変更後の所有者と関数の役割

| 配置先 | 移す定義・役割 | 可視性と残す境界 |
| --- | --- | --- |
| `Core/GoalModels.swift`（新規） | `GoalAvailability`、`GoalStatus`、`GoalCapabilities`、`GoalFields`、`GoalFieldCapabilities`、`GoalBinding`、`CodexGoal`、`ClaudeGoalStatus`、`ClaudeGoalPhase`、`GrokGoalNative`、`GrokCurrentStatus`、`GoalHistoryKind`、`GoalTerminal`、`NativeGoal`、`GoalNativeHistory`、`GoalSnapshot`（現`:65–310`）。応答の型・decode・既存の文言算出を所有 | 上記16のトップレベル型だけprivateからinternalへ。関連型を公開範囲の狭い別型へ包み直さず、case・プロパティ・initializerを保つ。型内のprivateなSource/CodingKeysはprivateのまま。Foundationをimport |
| `Core/GoalViewModel.swift`（新規） | `GoalLoadCallContext`、`GoalForegroundLoad`、`GoalViewModel`と、その通信専用の`GoalsResponse`・`GoalDetailResponse`・`GoalChangeResponse`・`GoalChangeOutcome`・`GoalChangeRequest`・`GoalViewError`。loadList/loadDetail/loadは取得と適用、run/changeは既存の変更と失敗時照合、replaceは同じBotの置換 | GoalViewModelだけprivateからinternalへ。通信専用型とGoalViewErrorは同じファイル内のprivateを保つ。context/foregroundは既存internal。Darwin/SwiftUIのimportとMainActor、Taskの生成位置・待機順を保つ。Core/AppStore.swiftにもあるSwiftUI状態型との接続を維持 |
| `Views/GoalsView.swift`（既存） | `GoalEditorSelection`、`GoalsView`、`ChatGoalBar`、`GoalCardPresentation`、`GoalCard`、`GoalEditField`、`GoalEditor`を残す | StateObject、foregroundLoadのState、editing/expanded/入力draft、sheet、task、modifierの取付位置を変えない。既存private/internalの範囲を保つ |

型の配置以外の所有権移譲はない。取得・変更結果をAppStoreへ新たに保存せず、GoalEditorSelectionを通信modelに混ぜない。文言算出を別のformatterへ抽出することも本候補には含めない。

### 比較した代替案

1. 現状維持ではharness別応答の変更、取得状態の修理、画面配置の変更が同じファイルへ集まる。既存の独立した型を移すだけで責務を示せるため上表を選ぶ。
2. 各Viewをさらに別ファイルへ分ける案は、共有するprivateのカード・editor・selectionの可視性を追加で広げる。今回の責務分離には不要。
3. AppStoreの共有goal辞書や汎用APIサービス/protocolを新設する案は、画面間の状態共有・通知・task寿命を変える。既存のBellAPIとGoalViewModelで足りる。
4. 全値型をCore/Models.swiftへ集める案は、goal固有のharness decodeまで共通名簿・予定と混在させる。通信専用型を新しいpublic APIとしてexportする必要もない。

### 変更窓口と全直接caller

下表の行番号はすべて移動前のGoalsView.swift。ただしファイル名を明記したものはそのファイルを指す。callerの式・署名は変更せず、定義の所在と上記のアクセス修飾だけを変える。

| 窓口 | 全直接caller・参照 |
| --- | --- |
| `GoalsView` / `ChatGoalBar` | 順に`App/BellBotApp.swift:193`と`Views/DesktopWorkspaceView.swift:38`、`Views/ConversationView.swift:431`。型名と生成式は同じ |
| `GoalViewModel`生成・状態 | GoalsViewのStateObject（`:467`）、ChatGoalBarのStateObject（`:606`）だけ。両Viewがloading/loaded/mutating/needsRefresh/errorTextとcurrentSnapshots/currentSnapshotを読む。editorへのsnapshots/loadingのBindingは`:564,680` |
| `loadList` | 一覧のpull（`:532`）、手動（`:540`）、view task（`:576`）、前面復帰（`:584`）、event（`:593`） |
| `loadDetail` | 会話barの手動（`:653`）、view task（`:691`）、前面復帰（`:698`）、event（`:707`） |
| `load` / `replace` / `currentSnapshot` | loadはloadList/detail（`:357,361`）、replaceはchange（`:448,455`）、currentSnapshotはChatGoalBar.snapshot（`:611`）だけ |
| `run` / `change` | runはカードのcallback二つ（`:520,643`）。changeはrun内部（`:408`）とeditorの保存callback二つ（`:565,681`） |
| `GoalLoadCallContext.capture/log` | captureは上記全9読取callerとchange失敗後の照合（`:434`）。logはloadList/detail（`:358,362`）と照合診断（`:441`）。ファイル外は`NetworkRecoveryTests.swift:189,198` |
| `GoalForegroundLoad` | 各ViewのState（`:468,607`）。runForViewTaskは`:575,690`、startは`:584,698`と自身`:48`、cancelは`:586,596,700,710`。単体試験は`NetworkRecoveryTests.swift:228,260,314`の3関数 |
| 通信専用の応答・要求・結果・エラー | GoalsResponseはload一覧（`:377`）、GoalDetailResponseはload詳細（`:372`）とchange照合（`:433,436`）、GoalChangeResponse/Requestはchange（`:424,426,428`）、outcomeは`:456`。GoalViewErrorはload/changeのthrowだけ。これらは移動先内に収まる |
| `GoalSnapshot`と共有値型 | 応答3型、GoalViewModelの保持/取得/変更、GoalEditorSelection（`:335`）、一覧の抽出/select（`:471–481`）、会話snapshot（`:611`）、GoalCard（`:716`）、GoalEditorのBinding/current（`:843,853,863`）。availability・capabilities・fieldCapabilities・bindingはこれらが読む |
| harness別decodeと算出値 | NativeGoalがCodexGoal/ClaudeGoalStatus/ClaudeGoalPhase/GrokGoalNative/GrokCurrentStatusを復号（`:214–233`）。GrokCurrentStatusは内部のSourceとStatusSnapshot/DetailSnapshotを復号（`:160–165`）。GoalNativeHistoryがGoalHistoryKind/GoalTerminal/ClaudeGoalStatusを持つ。GoalStatusはCodexGoal、GoalFieldsはGoalFieldCapabilitiesとeditor.fields（`:864`）、GoalBindingはsnapshotと要求が使う。型内のstatus/usage/elapsed/objective/tokenBudget等はNativeGoal、pill、card、editorから参照され、別ファイルの直接参照はない |
| 残す画面部品 | GoalCardは`:517,637`、GoalEditorは`:564,680`、GoalEditorSelectionは`:481,640`、GoalCardPresentationはcardと会話bar、GoalEditFieldはeditor内だけ。editor.saveは保存ボタン（`:936`）から入り、onSave（`:957`）を呼ぶ |

private型のファイル内参照、Decodableの関連型、SwiftUIのBindingとcallbackも確認した。アプリのモジュール名BellBotは維持し、外部public export、HTTP route、resource、JSONキーは増減しない。`project.yml:28`の既存ディレクトリ指定を使い、新規2ファイルの生成Xcode登録を実装PRへ含める。通知拡張と独立Tests2本からのcallerはない。

### 試験・fixtureと維持する契約

直接単体試験は`NetworkRecoveryTests`の`testGoalTimeoutOrdersCallPhaseChangeAndRequestOnContinuousClock`と、上表のforeground3件。既存の`NetworkScenario`・`makeAPI`・保留continuationをそのまま使う。`testGoalListFailureDirectReportIncludesCallerContext`と`BellDiagnosticsTests.testGoalTimeoutCarriesCallsiteWithoutPrivateRoute`は人工contextでreportする隣接試験であり、GoalViewModelのload/changeを直接検査しない。

UIの影響目録は`GoalsUITests.swift:6–652`の全20件（[全関数とassertの対応](tests.md#goalsuitestsswift)）。内訳は一覧/編集/capability・binding・結果不明/旧GETが8件、Claude/Grok表示とclearが6件、会話pill/不可状態/長文/editorが4件、一覧と会話の読取失敗後回復が2件。型移動による試験名・操作・assertの変更はない。関数名が示す範囲を越えて証明しない。例えば長文chat試験（`:533`）は高さとcomposerの存在までで、スクロール操作は検査しない。

fixtureは`test/helpers/goals-ui-server.mjs:3–11,45–63,74–196`の既存モード、binding、harness別応答、保留一覧、unconfirmed/応答喪失、GET失敗、read/write記録を使う。単なる移動のためにfixtureを変更しない。UI試験の多くはtabBarsやHome操作を使うため、Macでそのまま全20件実行可能とは扱わない。PR5では上記4単体試験と、Macでの人工fixtureによる直接の画面・HTTP確認を行い、移動を模倣する新しい試験は作らない。

維持する契約は、kind無しCodex/タグ付き3harnessのdecode、未知kind/statusの拒否、Claudeのtype/met条件、Grokの空elapsed拒否・符号付きtoken・null/raw表示、capability/binding/単独項目検査である。`loading/mutating/needsRefresh`、取得失敗時の古い値の非表示、POST一回、応答喪失後GETで得た現在値を変更成功へ読み替えないことを保つ。照合GETの認証失敗も内側catchでunknownOutcomeになる現状（`:436–442`）は変更しない。

foregroundの前task取消→終了待ち→新task、view task取消の自分の子への伝播、context採取の順序・trigger文字列を保つ。一覧eventはtab=3だけを検査し、会話eventはactiveを検査する現状差（`:589–594,703–708`）も統一しない。editorは成功だけdismissし、draft・閉じる操作・保存中の取消方針を変えない。

## A-G2：二画面から共通goal editorへの接続

**不採用。** 既存の共通部品で足りており、二つの接続を消すための新しいwrapperは不要。

### 事実・代替案・所有者

`Views/GoalsView.swift:563–569,679–685`は同じGoalEditorへ、その画面のsnapshots/loadingとchange callbackを渡す。一覧は全Bot、会話barは1Botを取得し、StateObjectはそれぞれ`:467,606`にある。editorのcurrent（`:863`）はBindingから現在値を読み、初期draft（`:859–860`）はselectionから一度生成する。

editorがGoalViewModelを直接ObservedObjectとして受ける案は、保存処理と表示の結合を増やし、既存callback/Bindingを置き換えるだけになる。共通sheet modifierはsheetの取付位置と型構造まで変える。AppStoreで一つのモデルを共有する案は一覧と個別GETの相互上書き、busy/needsRefreshの連動を新設する。現状の接続を残す。

### caller・試験・fixture・exportと維持する契約

変更窓口はない。全callerは上記2つのsheetで、GoalEditor.save→onSave→その画面のGoalViewModel.changeまでをA-G1のcaller表に含めた。既存試験は`GoalsUITests`の`testTabletGoalEditorSavesOneFieldAtATime`、`testGoalCreateAndEditWhenCapabilityIsAvailable`、`testEditorKeepsDraftWhenSameBindingCapabilitiesChange`、`testOldGoalListCannotOverwriteAnEdit`、`testChatGoalEditorSavesOneObjectiveChange`。fixtureは同じgoals-ui-serverのFULL/CHAT、field変更、一覧保留とwrite記録。新しいexport・設定・fixtureを追加しない。

独立したモデルの寿命、選択時のbindingと現在値の照合、同bindingのfield変更後もdraftを残すこと、一覧取得中の保存抑止、onSave成功時だけ閉じる契約を保つ。A-G1は定義の配置だけを変え、この結線を共通化しない。

## A-L1：会話画像と通知アバターのorigin

**不採用。** 既存処理の受理条件とキーの意味が一致しない。

### 確認した事実と代替案

`Views/ConversationView.swift:1457–1465`はURL?からscheme/hostを小文字化し、HTTP 80/HTTPS 443を省き、構成できなければ文字列`unconfigured`を返す。`Shared/BotAvatarCache.swift:94–95`は`ServerOrigin.url`を通し、許可されたHTTPS/local HTTPの文字列を返し、不正ならnil。`Shared/ServerOrigin.swift:5–14`は資格情報/query/fragment/ルート以外のpathを拒否し、明示portを削除する処理はない。

BotAvatarCache.originへの置換は、会話画像のキー・task IDと不正入力時の値を変える。逆方向の置換は通知originの受理条件と保存先識別を変える。例えば`https://team.example:443`の明示portを落とす処理は会話用だけにあり、同じ変換とは扱えない。共通helperに受理方針・port除去・失敗値の設定を足す案は、短い異なる処理のための新しい抽象化になる。現在の関数を残す。

### caller・試験・fixture・exportと維持する契約

変更窓口はない。conversationImageOriginの全callerはAuthenticatedImageのtask ID（`:1440`）とcache引数（`:1444`）。BotAvatarCache.originの製品callerは自身のdirectoryURL（`:115`）と`Shared/CommunicationNotification.swift:45`で、単体試験は`OnboardingTests.swift:8`。directoryURLはstoreVersioned/dataURL/imageData（`:37,69,85`）から使われ、アプリのBotAvatarCacheAccessと通知拡張の画像読取へつながる。

関連試験は`OnboardingTests.testHTTPSAndLocalHTTPOrigins`、`CommunicationNotificationTests`のserver別cache・削除/破損・Intent/通知本文、`NetworkRecoveryTests.testUnchangedAvatarsAreNotDownloadedAgain`、会話画像の`ConversationAppearanceUITests`2件。fixtureは一時cache root・合成画像・NetworkScenario・既存画像UI環境で、二つのoriginが全入力で同値というassertはない。アプリ/通知拡張のShared登録とApp Group保存形式を維持する。A-O1/PR3で会話画像を移動する際も、この関数とcacheを一緒に移し、キー・nil/文字列・既定portを変えない。

## A-L2：通知から開く秘密sheetのplatform接続

**不採用。** 実際の入力・通信は既にSecretInputSheetに共通化されている。

### 確認した事実と代替案

`App/BellBotApp.swift:200–203`と`Views/DesktopWorkspaceView.swift:91–93`は、それぞれの根へnotificationSecretのsheetを取り付け、完了時にeventRevisionを1増やす。値の所有者は`Core/AppStore.swift:87`で、pending要求のGETが成功すると設定される（`:822–839`）。会話から開くsheet（`ConversationView.swift:165–172`）はカードのresultを更新する別のcallbackである。

共通modifierを作る案は2つの短い結線を別名へ隠すだけで、入力処理の重複を消さない。RootViewへsheetを引き上げる案はready以外のphaseも含む取付位置と寿命を変える。完了callbackをAppStoreの新関数にする案も1行のincrementを包むだけである。platformごとの根と会話カードの結線を残す。

### caller・試験・fixture・exportと維持する契約

変更窓口はない。SecretInputSheetの全3生成元は上記のtabs/workspace/会話カード。notificationSecretの直接書込みはAppStoreのpending GET成功（`:832`）、logoutのnil（`:814`）、二つのsheet Bindingであり、別の永続配送状態はない。`NotificationTests.testSecretRequestOpensRoomAndInput`はrouteとrequest IDを検査するだけで、秘密sheetの表示・完了incrementは検査しない。`NotificationNavigationUITests`は会話置換、`SecretInputUITests`と`ConversationFreezeUITests`は会話からの秘密sheetを扱う。preview通知とsecret-input-smokeを合わせてもplatform両方の通知秘密完了を実測済みとはしない。

AppStoreによる接続先照合・pendingだけの表示、再認証時のroute退避、完了時incrementとカード直接更新の違い、通常の閉じる操作がcancel POSTを呼ばないことを維持する。fixture・public export・起動設定は変更しない。

## A-T1：秘密入力UI試験の名前とassertの範囲

**採用。試験名と説明だけを訂正する。** 製品の挙動・既存assert・fixtureは変えない。

### 事実・変更後の所有者・代替案

`BellBotUITests/SecretInputUITests.swift:4`の`testSecureInputSavesWithoutPostingChatText`は、`:24–29`で登録済み、秘密値/入力欄が画面に無いこと、再起動後も登録済みであることを検査する。通常chatへのPOST件数は読まない。`scripts/secret-input-smoke.mjs:51–59`も終了時に合成値の保存・通知本文への非混入・redirectを検査するだけで、通常chat POSTゼロを直接数えない。製品は`SecretInputSheet.finish`から専用の`BellAPI.finishSecretRequest`を呼ぶが、この静的接続をUI試験のassertとは扱わない。

所有者は同じSecretInputUITests。名前を`testSecureInputHidesValueAndShowsSubmittedAfterRelaunch`へ変え、「登録表示・値と入力欄の非表示・再起動後の表示を確認する。通常会話へのPOST件数はこの試験では確認しない」とコメントする。XCTestのtest接頭辞と署名は保つ。

代替のPOSTゼロassert追加には、HTTPS fixtureに通常会話POSTの観測と返却を設ける必要がある。製品を変えずに試験を強化する別案としては成立するが、今回の記述訂正には不要。現名を残す案は未検証の範囲を検証済みに読ませるため採らない。既存assertを削除して名前へ合わせることもしない。

### 全caller・試験・fixture・exportと維持する契約

直接のSwift callerはなく、XCTestの列挙で呼ばれる。repo内のhidden設定を含む名前検索と`project.yml`・共有schemeの読取では、個別のtest selectorを固定する実行設定は見つからなかった。現名への文書参照は`tests.md`の対応表で、実装PR0では改名と同時に更新する。`function-index.md`のSecretInputUITests行も、現状は「通常chatへ送信されないこと」と記載しているため、同じ検証範囲へ訂正する。本設計段階では両文書を変更しない。

fixtureは同じscript・専用Simulatorの信頼済み試験証明書、`BELLTEAM_SECRET_SMOKE=1`と既存preview引数。製品の秘密送信先、値消去、購読確認、assertの待機時間、再起動操作、添付画像、skip条件を維持する。外部public export・target登録は変わらず、変わる識別子はXCTestのこの関数名だけ。repo外の手動test selectorは未確認で、実行時は新名を使う。

## A-T2：1万行端末UI試験の名前と画面取得

**採用。要求と画面取得の試験であることを名前・コメントへ合わせる。** 1万行の表示を確認したというassertは追加しない。

### 事実・変更後の所有者・代替案

`BellBotUITests/ProfileTerminalUITests.swift:62–85`の`testPhoneTenThousandLineHistoryRequestsAndRenders`は、long-history設定の200、screen読取が非空で全てhistory=1、screenshot添付まで。本文の取得完了・先頭/末尾・行数のassertは無い。fixtureの`test/helpers/profile-terminal-ui-server.mjs:48–50,113–115`は`保持行1`〜`保持行10000`をscreenとして返す。製品のBotScreenViewは応答screenを代入し、BotTerminalTextViewへ渡す（`ConversationView.swift:1696,1717–1721`）。これはUI試験でその全経路が成功した証拠にはならない。

所有者は同じProfileTerminalUITests。名前を`testPhoneLongHistoryRequestsHistoryAndCapturesScreen`へ変え、「1万行fixtureでhistory=1の要求と画面取得を確認する。端末本文の行数・最終行はこの試験では照合しない」とコメントする。既存のscreenshot名と添付・assert・sleep・操作は保つ。

代替の本文assert追加は、既存`bot-screen-text`のvalueを待ち、行数と`保持行10000`を照合する範囲なら製品変更なしで設計できる。ただし現在の実行環境で値の可視性と取得完了を確認しておらず、今回の採用には含めない。既存の`BotTerminalTextViewTests.swift:6–24`は1万行文字列の末尾・位置・置換を直接検査するため、描画部品の検証は失われない。これをHTTPからiPhone画面までの証明へ広げない。

### 全caller・試験・fixture・exportと維持する契約

全callerはXCTestの列挙。repo内にこの関数名を固定した実行selectorはなく、`tests.md`の関数名参照を実装PR0で更新する。`reset`・`screenReads`等の同ファイルの補助関数、profile-terminal fixture、`BELLTEAM_PROFILE_TERMINAL_URL`、phoneだけの条件、Appの起動/終了、history=1のHTTP契約、画面のaccessibility IDを維持する。fixtureの1万行を短くしたり、製品のscreen文字列を試験専用に変えたりしない。新しいpublic exportやtarget登録はない。

## A-T3：過去取得件数のコメント

**採用。コメントの20件を25件へ訂正する。** 所有者は同じConversationScrollUITests。

### 確認した事実と代替案

`BellBotUITests/ConversationScrollUITests.swift:34`の説明は20件だが、同`:46`は`?limit=25&before=m051`を照合する。製品の`ConversationHistoryPage.pageSize`（`Views/ConversationView.swift:935`）は25で、`loadOlder:686`がそれを使う。`test/helpers/conversation-scroll-server.mjs:22–36,100–103`も受け取ったlimitで履歴を切り出し、要求queryをproofへ記録する。

assertを20へ合わせる案は現在の製品契約と矛盾する。pageSizeを20へ戻す案は通信とページ境界を変更する。試験内の期待値を製品定数から生成する案は固定queryの照合を弱め、単なる説明誤りのために試験の依存を増やす。コメントの数値だけを直す。

### 全caller・試験・fixture・exportと維持する契約

対象は`testOlderMessagesLoadAutomaticallyAtTopAndKeepPosition`のコメントだけで、実行callerはXCTest、関数名も変えない。関連する同ファイルの短page（`:63`）・最古到達（`:125`）、DesktopWorkspaceUITestsの過去取得、fixtureのrequest記録は変更不要。古い実測記録`docs/evidence/2026-10-22-apple-performance-investigation.md`にある20行はその時点の記録として保持する。25件要求、初回10件、beforeのID、取得回数、読書位置とMarkdown後の位置のassert、HTTP fixture、export・設定をすべて維持する。

## PR単位の順序と検証

今回は以下の検証を実行していない。後続の製品コードを変える各PRは、変更した関数の直接試験とMacの実画面確認に限る。PR0は試験名・コメント・対応文書だけなので、差分・test宣言・selector参照の静的照合までとし、製品のビルド・UI再走を訂正の成立条件にしない。試験一覧は影響先の目録であり、関連する全クラスを毎回走らせる指示ではない。既存のgreen結果を、無関係な次のPRで繰り返さない。

| 段階 | 採用項目・変更 | 依存と危険度 | 直接試験とMac実画面の確認 |
| --- | --- | --- | --- |
| PR0：試験の説明を実際の検査へ合わせる | A-T1〜T3。試験2関数の改名と説明、過去件数コメント、tests/function-indexの対応訂正 | 独立。PR1より前に置き、PR2/PR3の検証計画が試験名を過信しないようにする。低。製品コード・assertは不変 | diffで操作・assert不変、test接頭辞/署名の維持、旧名のselector参照を確認。Mac画面の再確認は不要。T1のPOST非送信とT2のHTTP経由1万行表示は確認済みにしない |
| PR1：Bot保存窓口と応答型 | A-S1、A-X1。extension移動、ローカル応答型削除、Xcode登録、state-and-sync/settings-and-profile/function-indexの所在更新 | 他段階から独立。低。比較・例外処理をそのまま移す | A-S1表の保存/確認11ケースと手動確認の直接呼出しを含む既存試験、A-X1の復号失敗ケース。Macは既存メンバーの保存、画像変更なし、画像保存の結果表示。名簿/入力保持、PATCHが一回であることを人工fixtureと照合 |
| PR2：プロフィールと端末画面の配置 | A-O1の`ConversationDetailView.swift`、`BotScreenView.swift`、`EmptyBody`のModels移動。Xcode登録、overview/members-and-rooms/function-index更新 | PR1と論理依存なし。低。ただしSwiftUIの型とsheetの同一性を保持 | `BotTerminalTextViewTests`の1件。Macでinspector→端末→戻る、内容置換・過去読書位置・末尾追従、非表示後の照会停止、メンバー編集windowを確認。iPhone詳細sheetの実動作はこのMac確認では証明できない |
| PR3：入力・添付・会話画像の配置 | A-O1の残り。`ConversationInput.swift`、`ConversationImages.swift`、PendingImageを既存draftファイルへ。Xcode登録、overview/state-and-sync/function-index更新 | PR2と同じ元ファイルを触るので後に置く。中。入力・galleryの状態寿命とprivate境界が中心 | `MessageInputTests`のMacで実行できる直接ケース。MacでReturn/Shift/Option、外部clear/失敗復元、画像ファイルと画像の貼付け、会話切替のdraft、画像束・単画像・gallery切替・画像GET失敗表示を確認。画像fixtureの所在未確認は先に解消する |
| PR4：再起動操作の共有 | A-P2。AppStoreの具体的操作と二callbackの置換、限定した直接試験・人工HTTP fixture、settings-and-profile/state-and-sync/function-index更新 | PR2のEmptyBody移動に依存。PR3との論理依存はないが元ファイルの移動を完了してから行う。中。権限確認順序と画面別の失敗処理が中心 | 新しい`restartConversation`直接試験（許可/拒否、初期guide、POST失敗）。Macで失敗文言と診断が一回、再操作で成功した時にerrorが消えinspectorが残ることを確認。実Botは再起動せず人工fixtureを使う |
| PR5：goalの値型と取得状態の配置 | A-G1。GoalModels/GoalViewModelの既存定義移動、必要なinternal化、生成Xcode登録、goals/overview/state-and-sync/function-indexの所在とtestsの対応更新 | PR1〜PR4との論理依存はない。既存の会話整理を完了してから独立したgoal変更を確認するためPR4の後。中。decode・アクセス修飾・状態寿命が中心 | A-G1のNetworkRecoveryTests直接4件。Macでは既存goals-ui fixtureのFULL/CHATで一覧・会話・editor・単独項目・unconfirmed/応答喪失後GET・読取失敗後回復を画面とproofで照合。TAGGED/GROK系は移した表示算出の代表値（Claude履歴、符号付きtoken、detailのnull/raw）を確認。製品の変更に合わせてfixtureの期待値を書き換えない |

順番は**PR0 → PR1 → PR2 → PR3 → PR4 → PR5**とする。実装上の依存はPR2→PR3（同じ元ファイルの分離順）とPR2→PR4（EmptyBody移動）であり、PR0/PR5を新しい承認待ちの関所にしない。PR1〜PR4の採否・責務は前回どおり。実装PRで新しい詳細図へ所在を反映する範囲は、PR2にconversation/lifecycle-and-platform、PR3にconversation、PR4にconversationを加える。HTTP/SSEの公開接点は変わらず、module.jsonの変更は不要。

PR1の試験数は`saveBotSettings`を呼ぶ9ケースと画像保存2ケースであり、`testExplicitConfirmationAfterReconnectDoesNotWriteAgain`の直接GET確認を別件に重複計上しない。移動しないencodeやdraftの単体試験は所在を残し、同時にそのコードを変えた場合だけ実行対象へ加える。

Mac確認には実際に表示された画面と、必要なHTTP要求記録を使う。単にウィンドウが開いたことやHTTPを要求したことを成功としない。実装時に新規作成したfixtureプロセスと確認用アプリは確認後に終了し、他の常用資源には触れない。本体のdeploy・停止・再起動・公開はこの計画に含めない。

## 挙動を変える変更の切り分け

採用8件のうち製品コードの整理は前回4件とA-G1、残る3件は試験の名前・コメントの訂正である。現在の表示差・通信差を解消する意図は持たせない。試験assertを追加する案は今回採用せず、後で必要になった時も既存製品の挙動を確かめる範囲とし、通すための製品修正は別の修理として切り分ける。

| 別工程へ残す項目 | 今回行わない変更 |
| --- | --- |
| UI改善1：一覧の仕事要約 | `currentWork`導入、recentからの表示変更、本体契約の接続 |
| UI改善2：役職検索 | Bot/Roomの検索対象の追加、検索語の正規化変更 |
| UI改善3：ルーム参加者の検索 | 参加者選択の名前/役職検索追加 |
| UI改善4：設定画面 | 設定の並べ替え、区分や操作導線の変更 |
| UI改善5：メンバー編集の統一 | フォーム体系、保存/取消/閉じる動作の統一 |
| UI改善6：Owner・メンバーの編集フロー | 保存のまとめ方、partial success表示、未保存確認、入力無効化の変更 |
| 保留修理2件 | `deliveryTracking`による配達失敗の赤表示、大画像の前面復帰時再読込 |
| 本設計で保留のA-P1 | Owner/規範読取の診断path修正。既存2修理と同じ案件であるとは扱わない |
| 整理として不採用のA-C2 | 書出しGETと診断pathの不一致。修理ではtrace有り/無しの実効診断を再現し、catchと直接試験・必要なexport fixtureを扱う。HTTP送信先変更や共通診断方針の変更へ広げない |
| 整理として不採用のA-R1 | 秘密入力の利用許可段階での認証復帰。修理では初期guideのsetup認証失敗、sheet/値の寿命、秘密POSTゼロを確認。購読拒否・POST後の失敗方針まで統一しない |
| 今回採らない状態・識別の変更 | 添付/宛先をPublishedへ集約、更新/過去履歴を保持pageへ随時保存、初回認証/再認証flowの統合、goalの画面間状態共有、画像originのport/受理条件統一、通知秘密sheetの取付位置変更 |
| その他の現状差 | 一覧sort/subtitleの統一、再起動の成功遷移・失敗文言・診断送信の統一、画像draftの共有方法変更、診断HTTPの成功条件変更 |

## 未確認

- ビルド、単体試験、UI試験、Mac実画面、Simulator、実端末は一切実行していない。新ファイルのimport・アクセス修飾・生成Xcode登録の成立は後続PRで確認が必要。
- private型の移動後もSwiftUIの状態・task・sheetの寿命が同じになることは静的設計上の条件であり、実行結果ではない。特にiPhone詳細sheetのdismiss、iPad配置、OS操作でのwindow終了と複数window同時編集はMac確認だけでは網羅できない。
- 画像cacheの競合、取消、メモリ圧迫時の実効挙動、添付のsecurity scopeの実OS権限は測っていない。既存コードを移すことを理由に試験済みとは扱わない。
- `BELLTEAM_IMAGE_SMOKE_URL`の既存サーバー実装・稼働先は確認できなかった。`BELLTEAM_REPORTING_PROBE_URL`の診断環境と、`InstalledConversationUITests`が使うインストール済みアプリも利用していない。既存UI試験の環境変数が設定されれば成功するとは断定しない。
- 再起動の既存試験はボタン存在までで、権限確認→POSTの直接試験は不足している。A-P2欄の試験・fixture追加は未実装。Owner保存の部分成功と診断path不一致の実害も未実測。
- 今回は`docs/architecture/modules/apple/`配下の全文書と12候補の実装・直接試験を静的に確認した。goalの製品ファイル・GoalsUITests・goals-ui-server、秘密UI試験・secret-input-smoke、認証順序/再認証の直接試験などを追加で読んだ。tests.mdの47ファイル読了は先行調査の記録であり、今回の設計担当が全47ファイルを再読・再実行したという意味ではない。
- A-G1の新配置のimport・16値型とGoalViewModelのアクセス修飾・Xcode登録は未実装。既存goal単体試験はcontext/foregroundの4件で、GoalViewModel.load/changeやharness decodeの全失敗分岐を直接検査するものではない。GoalsUITestsの全20件がMacで実行可能とも確認していない。PR5の人工fixtureによるMac表示・要求記録の照合は未実施。
- A-T1は会話POST件数、A-T2はHTTPからiPhoneへの1万行本文表示をassertしないまま残す。改名・コメント訂正は検証の追加ではない。repo外で旧試験名を使う手動selectorは未確認。証明書・Simulator・既存URLを用意しておらず、これらのUI試験が現行環境で通るかも未確認。
- A-C2の診断path不一致が実際のreportへ及ぼした影響、A-R1の許可段階の認証失敗からの画面遷移は未実測。通知秘密sheetの両platformでの完了通知、複数画面の添付/宛先同期、originの全入力比較も未実測であり、修理済み・同値とは扱わない。
- 本体内部の保存・再起動・認証・診断受信の処理、APNs、StoreKit実取引、公開後の動作は確認していない。設計上の責務整理を、本体処理の完了や既存の保留修理の解決とは扱わない。
