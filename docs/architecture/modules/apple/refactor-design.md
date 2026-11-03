# Appleアプリの責務整理設計

[担当の正本](README.md) / [全体図](overview.md) / [状態と同期](state-and-sync.md) / [一覧・編集](members-and-rooms.md) / [設定・プロフィール](settings-and-profile.md) / [関数索引](function-index.md) / [予定一覧](schedule-list.md) / [進行記録](refactor-progress.md)

## 結論と対象版

**既存7件は採用3件、不採用3件、保留1件。追加2件は採用1件、不採用1件。合計は採用4件、不採用4件、保留1件とする。** 採用分は既存の型・状態・通信窓口を使う4段階の整理で、画面の振る舞いとHTTP/SSE契約を維持する。protocol、汎用通信wrapper、設定値、永続状態は増やさない。

| 項目 | 確認した値・範囲 |
| --- | --- |
| branch | `refactor/apple-feature-map-20261103` |
| HEAD | `afda9477bba4aaa7c8a6905100d3bacf26e47c90` |
| コードの基準 | `4e01fadcb5edcaa74c010436a47be9cb26eabeec`。このbaseとHEADの`ios/BellBot`差分は空 |
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

## PR単位の順序と検証

今回は以下の検証を実行していない。後続の各PRは、変更した関数の直接試験とMacの実画面確認に限る。試験一覧は影響先の目録であり、関連する全クラスを毎回走らせる指示ではない。既存のgreen結果を、無関係な次のPRで繰り返さない。

| 段階 | 採用項目・変更 | 依存と危険度 | 直接試験とMac実画面の確認 |
| --- | --- | --- | --- |
| PR1：Bot保存窓口と応答型 | A-S1、A-X1。extension移動、ローカル応答型削除、Xcode登録、state-and-sync/settings-and-profile/function-indexの所在更新 | 他段階から独立。低。比較・例外処理をそのまま移す | A-S1表の保存/確認11ケースと手動確認の直接呼出しを含む既存試験、A-X1の復号失敗ケース。Macは既存メンバーの保存、画像変更なし、画像保存の結果表示。名簿/入力保持、PATCHが一回であることを人工fixtureと照合 |
| PR2：プロフィールと端末画面の配置 | A-O1の`ConversationDetailView.swift`、`BotScreenView.swift`、`EmptyBody`のModels移動。Xcode登録、overview/members-and-rooms/function-index更新 | PR1と論理依存なし。低。ただしSwiftUIの型とsheetの同一性を保持 | `BotTerminalTextViewTests`の1件。Macでinspector→端末→戻る、内容置換・過去読書位置・末尾追従、非表示後の照会停止、メンバー編集windowを確認。iPhone詳細sheetの実動作はこのMac確認では証明できない |
| PR3：入力・添付・会話画像の配置 | A-O1の残り。`ConversationInput.swift`、`ConversationImages.swift`、PendingImageを既存draftファイルへ。Xcode登録、overview/state-and-sync/function-index更新 | PR2と同じ元ファイルを触るので後に置く。中。入力・galleryの状態寿命とprivate境界が中心 | `MessageInputTests`のMacで実行できる直接ケース。MacでReturn/Shift/Option、外部clear/失敗復元、画像ファイルと画像の貼付け、会話切替のdraft、画像束・単画像・gallery切替・画像GET失敗表示を確認。画像fixtureの所在未確認は先に解消する |
| PR4：再起動操作の共有 | A-P2。AppStoreの具体的操作と二callbackの置換、限定した直接試験・人工HTTP fixture、settings-and-profile/state-and-sync/function-index更新 | PR2のEmptyBody移動に依存。PR3との論理依存はないが元ファイルの移動を完了してから行う。中。権限確認順序と画面別の失敗処理が中心 | 新しい`restartConversation`直接試験（許可/拒否、初期guide、POST失敗）。Macで失敗文言と診断が一回、再操作で成功した時にerrorが消えinspectorが残ることを確認。実Botは再起動せず人工fixtureを使う |

PR1の試験数は`saveBotSettings`を呼ぶ9ケースと画像保存2ケースであり、`testExplicitConfirmationAfterReconnectDoesNotWriteAgain`の直接GET確認を別件に重複計上しない。移動しないencodeやdraftの単体試験は所在を残し、同時にそのコードを変えた場合だけ実行対象へ加える。

Mac確認には実際に表示された画面と、必要なHTTP要求記録を使う。単にウィンドウが開いたことやHTTPを要求したことを成功としない。実装時に新規作成したfixtureプロセスと確認用アプリは確認後に終了し、他の常用資源には触れない。本体のdeploy・停止・再起動・公開はこの計画に含めない。

## 挙動を変える変更の切り分け

採用4件は定義の移動、重複型の削除、既存の二操作の集約だけである。現在の表示差・通信差を解消する意図は持たせない。

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
| その他の現状差 | 一覧sort/subtitleの統一、再起動の成功遷移・失敗文言・診断送信の統一、画像draftの共有方法変更、診断HTTPの成功条件変更 |

## 未確認

- ビルド、単体試験、UI試験、Mac実画面、Simulator、実端末は一切実行していない。新ファイルのimport・アクセス修飾・生成Xcode登録の成立は後続PRで確認が必要。
- private型の移動後もSwiftUIの状態・task・sheetの寿命が同じになることは静的設計上の条件であり、実行結果ではない。特にiPhone詳細sheetのdismiss、iPad配置、OS操作でのwindow終了と複数window同時編集はMac確認だけでは網羅できない。
- 画像cacheの競合、取消、メモリ圧迫時の実効挙動、添付のsecurity scopeの実OS権限は測っていない。既存コードを移すことを理由に試験済みとは扱わない。
- `BELLTEAM_IMAGE_SMOKE_URL`の既存サーバー実装・稼働先は確認できなかった。`BELLTEAM_REPORTING_PROBE_URL`の診断環境と、`InstalledConversationUITests`が使うインストール済みアプリも利用していない。既存UI試験の環境変数が設定されれば成功するとは断定しない。
- 再起動の既存試験はボタン存在までで、権限確認→POSTの直接試験は不足している。A-P2欄の試験・fixture追加は未実装。Owner保存の部分成功と診断path不一致の実害も未実測。
- fixtureの本文を確認した範囲は`PreviewFixtures.swift`、保存/入力/端末の単体fixture、`member-editor-server.mjs`、`profile-terminal-ui-server.mjs`、`network-lifecycle-server.mjs`など本文中で明記したもの。関連試験の全45ファイルを全文読了したとはしない。広範な会話/goal/通知の試験は今回の直接変更対象外。
- 本体内部の保存・再起動・認証・診断受信の処理、APNs、StoreKit実取引、公開後の動作は確認していない。設計上の責務整理を、本体処理の完了や既存の保留修理の解決とは扱わない。
