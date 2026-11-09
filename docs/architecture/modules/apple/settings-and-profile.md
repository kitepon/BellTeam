# 設定・Ownerプロフィール・メンバー画像

[全体図](overview.md) / [状態と同期](state-and-sync.md) / [メンバー・ルーム編集](members-and-rooms.md) / [関数索引](function-index.md)。固定sourceは全体図に記載。以下のファイル名は`ios/BellBot/BellBot/`からの相対名。

## 設定画面の責任

```mermaid
flowchart TD
  Settings["SettingsView"] -->|"compact（iPhone）"| Phone["SettingsPhoneView<br/>NavigationStack + 項目一覧（insetGrouped）"]
  Settings -->|"regular（iPad・Mac）"| Split["SettingsSplitView<br/>左に項目（sidebar）、右に選んだページ"]
  Phone --> Page["SettingsPageView(page)"]
  Split --> Page
  Page --> Profile["プロフィール: ProfileEditor(embedded)<br/>Ownerとユーザー規範のdraft"]
  Page --> AI["AIの設定: HarnessAuthenticationList<br/>+ BackgroundAgentSettingsCard"]
  Page --> Terminals["端末: TerminalListPage<br/>terminals.md"]
  Page --> Features["追加機能: FeatureSettingsList / Editor"]
  Page --> Push["通知: BellNotifications.shared<br/>登録・OS設定を開く"]
  Page --> Session["接続: host・ログイン方法<br/>AppStore.changeServer / signOut"]
  Page --> Opening["表示: 会話の開き方Picker<br/>AppStorage conversationOpening"]
  Page --> Billing["利用と課金: SubscriptionCard / BillingStore"]
  Page --> Update["アップデート: UpdateContent(store.updates)"]
  Page --> About["このアプリについて: Bundleの版・接続先"]
  Page --> Control["全体停止: AppStoreのAI停止状態<br/>赤い別グループ"]
```

項目は`SettingsPage`（題名・一行の説明・SF Symbol・色・`accessibilityID`）が一か所で持つ。一覧の各行はアイコン・題名・説明と、通知未設定・購読・停止状態の短い状態表示。各ページの先頭は`SettingsPageHeader`（大きいアイコン・題名・説明）。失敗は`SettingsBanner`で平易な文を出し、生の文は「詳細」の中だけに置く。全体停止は一覧の最下部の単独グループで赤く表示する。プロフィールはsheetでなくページとして開き、保存後は閉じずに「保存しました」を出す。通知のエラーはsingletonのerrorText。会話の開き方はrise/fadeの端末設定で、HTTPへ保存しない。Cloudflareの時だけ接続ページにログアウトを出す。UI試験は`settings-profile`と`settings-row-<page>`で入る。DEBUGの`-bellbot-preview-settings <page>`は試料データ（`AppStore.prepareSettingsPreview`）でそのページを開く。認証・購読・通知の実装全体は[全体図](overview.md)と[索引](function-index.md)へ接続する。

## Ownerと規範のdraft

| 所有と操作 | 確認した処理 |
| --- | --- |
| ProfileEditorの@State | name/profile/xUrl/githubUrl/rules/avatar、links配列、cropSource、loading/saving/errorText |
| load | name/profile/URL/avatar/linksをstore.ownerから複製。その後`GET /api/user-rules`のtextをrulesへ。Ownerを別GETする処理はここには無い |
| リンク | LinkDraftのlabel/urlを編集。追加は空の要素、削除は配列index。送信時OwnerLinkRequestへmap |
| 画像 | AvatarImagePicker → AvatarCropEditorの既存形式callback → avatarへrender文字列。写真選択自体は本体へ保存しない |
| 検査 | saveでnameの空白除去後が空ならerrorText。保存ボタンはloadingまたはsavingで無効 |
| 取消・未保存 | 明示キャンセルはdismiss。Owner/規範へ書き込まない。未保存変更を確認する状態・dialog、AppStoreへのdraft退避は定義されていない |
| エラー | 読込失敗はerrorText、認証失敗はrequireLogin。loadingは最後にfalse。save失敗はoperationFailureMessageを表示してdraftを保持 |

```mermaid
flowchart TD
  Draft["ProfileEditor.save<br/>名前を検査・draftから要求を作る"] --> OwnerPatch["PATCH /api/owner<br/>name・profile・画像・URL・links"]
  OwnerPatch --> Rules["PUT /api/user-rules<br/>rulesのtext"]
  Rules --> Refresh["AppStore.refresh<br/>共通一覧とOwnerを再取得"]
  Refresh -->|"成功"| Done["AppStore.ownerが画面へ反映<br/>dismiss"]
  OwnerPatch -->|"失敗"| Error["errorText・draftを保持<br/>認証失敗はrequireLogin"]
  Rules -->|"失敗"| Partial["先のOwner更新を戻す処理なし"]
  Partial --> Error
  Refresh -->|"失敗"| Saved["2更新を戻す処理なし<br/>sheetを残してエラー"]
  Saved --> Error
```

OwnerResponseとUserRulesResponseを受けても、その戻り値を直接store.owner/rulesへ適用しない。通常の画面反映は後続refreshから。規範PUTやrefreshの失敗時にOwner PATCHを取り消す呼出しは無い。キャンセルボタンとフォームはsave中も全体disabledにはしていない。通信中の画面操作の実効結果は未調査。

## AIControlCard

状態の所有者はAppStore。表示部品は`control.state`の4値をstatus(for:)で文言化し、Toggleを`setAIControlPaused`へ渡す。更新中はToggleを無効化する。stopping/unconfirmedは状態更新ボタン、aiControlが無く未読込中でもなければ再確認ボタンを表示する。unconfirmedの未確認Bot IDは件数だけを画面へ出す。

初回taskは`refreshAIControl`。PATCH失敗からのGET、readの順序とepoch、SSE `ai-control`、背景停止は[状態図](state-and-sync.md)を参照。画面が独自に停止済み値を作る処理は無い。

## 追加機能のdraft・秘密値・保存

```mermaid
flowchart TD
  List["FeatureSettingsList<br/>AppStore.featureSettingsを列挙"] --> Editor["FeatureSettingEditor"]
  Editor --> Read["loadSettings<br/>GET /api/settings"]
  Read --> Draft["enabled / fields / values<br/>非secretはvalue、secretは空"]
  Draft --> Write["save<br/>空secretを要求から除外"]
  Write --> Clear["画面のsecret値を消去"]
  Clear --> Patch["BellAPI.updateSetting<br/>保護sessionでPATCH /api/settings/:id"]
  Patch --> Session["GET /api/session<br/>AppStore.authModeを更新"]
  Session --> Reload["GET /api/settings<br/>AppStore.featureSettingsを更新"]
  Reload -->|"currentSetting.errorなし"| Close["dismiss"]
  Reload -->|"反映errorあり"| Stay["画面に反映エラーを表示"]
  Read -->|"失敗"| Error["errorText・再読込ボタン<br/>初回成功前は編集と保存を出さない"]
  Patch -->|"失敗・結果不明"| Error
  Session -->|"失敗"| Error
  Reload -->|"失敗"| Error
```

| 状態・操作 | 返却先と保持 |
| --- | --- |
| 一覧（`onePassword`） | 行は題名と状態バッジ（アイコン付き）。反映errorはcodeを付けずサーバーの平易な文だけ。行は`FeatureSettingDestination`が`OnePasswordSettingEditor`へ渡す。項目が無い旧本体の一覧には何も増えない |
| 一覧 | taskでrefreshSettings。読み取れない時はerrorText。各settingのstatusText、error.code/messageを表示 |
| 初回読取 | loaded=falseではフォーム項目を出さず、保存も無効。成功したsettingsに編集対象IDが無ければinvalidResponse |
| currentSetting | AppStore.featureSettingsから同IDを検索し、無ければ引数setting。反映error表示はこの現在値、編集中のenabled/valuesは別の@State |
| loadSettings成功 | fields/enabled/valuesを置き換え、loaded=true、errorText=nil。再読込成功も入力をこの読取値で置換 |
| 後続読取失敗 | loadedや既存fields/valuesを消す処理なし。errorTextを表示 |
| save | 秘密項目の空文字を送らない。他の項目は空でも送る。画面の秘密値はHTTP前に消す。PATCH応答のsettingは直接適用せず、sessionとsettingsを再取得 |
| 保存失敗 | 非秘密のdraftは残る。秘密値は既に消去済み。operationFailureMessageとsecretWrite診断。認証失敗はrequireLogin |
| 非active・画面終了 | clearSecrets。非秘密draftをAppStoreへ退避する経路は無い |
| 取消・未保存 | navigationで戻る。専用取消ボタンや未保存確認dialogは定義されていない |

### 1Password連携（`onePassword`、usage #838）

契約は[secret credentials「Settings 1Password連携 token field」](../usage/secret-credentials.md#settings-1password連携-token-field-2026-11-09-owner-ask-trony-un-hold)。Webの設定画面（`web/onboarding.js`）と同じ文・同じ状態にする。`FeatureSetting`は`guide`と`connection`を省略可・読めなければnilで読み、旧本体や崩れた本体でも一覧の読込を失敗させない。

```mermaid
flowchart TD
  List["FeatureSettingsList<br/>onePassword行 = OnePasswordBadge + 平易なerror文"] --> Editor["OnePasswordSettingEditor<br/>Form（ヘッダ・案内・token・主ボタン）"]
  Editor --> Load["load: GET /api/settings<br/>enabled初期値 = enabled または 未設定"]
  Load --> View["ヘッダ: バッジ（連携中/未連携/失敗）<br/>失敗: error.messageをそのまま<br/>連携中: 読める保管庫と鍵の数の一行<br/>案内: 未連携は開く、連携中は「作り方を見る」の中"]
  Editor --> Save["保存して連携を確かめる"]
  Save --> Check["OnePasswordState.tokenProblem<br/>ops_で始まらなければ送らない"]
  Check --> Patch["updateSetting<br/>PATCH /api/settings/onePassword {enabled, values:{token}}"]
  Patch --> Reload["GET /api/settings<br/>store.featureSettings更新 → バッジ再計算"]
  Patch -->|"失敗"| Err["平易な文とsecretWrite診断（tokenは消去済み）"]
```

| 状態・部品 | 内容 |
| --- | --- |
| `OnePasswordState` | `error`があれば失敗、無くて`status=='enabled'`なら連携中、他は未連携。バッジは連携中=緑・未連携=灰・失敗=赤。接続の一行は連携中だけ（`connection`が無ければ「1Passwordにつながっています。」、鍵0件はWebと同じ次の一手の文） |
| 案内 | `guide.steps`を順に表示し、`link`は`https`の時だけ開く（`FeatureGuide.openableLink`）。連携の状態が変わった時だけ開閉し、読んでいる途中の案内は閉じない |
| token欄 | `SecureField`、`privacySensitive`、保存後も画面に返さない（一覧のtokenは空）。非active・画面終了で消す。空のまま保存できるのは、設定済みで連携の切替だけの時 |
| 保存 | `ops_`の検査（前後の空白は除く）→ PATCH → 一覧を読み直して結果をバッジで見せる。PATCH成功後に読み直しだけ失敗した時は「保存しました。表示を更新できませんでした」。非冪等の自動再送なし |
| 旧本体 | `onePassword`項目が無い一覧は従来のまま（行も編集も増えない） |

試験は`TerminalsTests`（読込・バッジ・`ops_`・https）と`TerminalsUITests.testOnePasswordSettingBadgeGuideAndTokenCheck`。

## 仕事の要約を書くAI

`Views/BackgroundAgentSettingsView.swift`。ミカの公開契約v1（`/srv/bellteam/bots/bot-203444ca/docs/background-agent-settings-20261105.md`）を使う。追加機能の`FeatureSetting`には混ぜず、設定画面の別カードにする。

| 段階 | 入出力 |
| --- | --- |
| 読取 | `GET /api/settings`のトップ`backgroundAgent`を`AppStore.backgroundAgent`へ。キーが無い応答は旧版として編集不可、`{revision:null,selection:null}`は未設定 |
| 候補 | `GET /api/models`。モデルは対象harnessの`models`（Pickerの表示名は`ModelChoice.label`＝`display_name`、null・欠落・空ならid。tagと保存値はid）、エフォートはそのモデル個別の`efforts`。個別effortsが空の時だけ`""`（CLIの既定）。候補に無い保存値は「現在の候補にありません」と出し、選び直すまで保存不可。別の値で埋めない |
| 保存 | `PATCH /api/settings/backgroundAgent`へ`expectedRevision`（初回null）と`harness`・`model`・`reasoningEffort`の4キー。200の`backgroundAgent`で保存値とrevisionを更新。自動の再送はしない |
| 失敗 | 案内文を出し、入力中の選択は残す。409と500は`GET /api/settings`で保存値とrevisionを読み直し、保存済みの値を並べて見せる |
| 通知 | SSE `settings`で`refreshSettings`。編集中の選択は上書きしない |

保存の成功は、要約が作られたことを示さない。要約の状態はメンバー一覧の現在の仕事で見る。試験は`BackgroundAgentSettingsTests`。

## メンバー画像の共通部品

```mermaid
flowchart TD
  Detail["ConversationDetailView / DesktopInspector<br/>StateObject BotProfileImageState"] --> Hero["BotProfileHero<br/>小画像・大画像・結果表示"]
  Detail --> Modifier["botProfileImageActions<br/>sheetを画面の根へ付ける"]
  Hero --> Actions["openImageActions<br/>small / large"]
  Modifier --> Sheet["BotProfileAvatarActions<br/>画像情報と切り抜き途中状態"]
  Actions --> Sheet
  Sheet --> Read["GET /api/bots/:id<br/>render / source / crop・schema確認"]
  Read --> Pick["AvatarImagePicker / adjust<br/>選択または元画像から再調整"]
  Pick --> Crop["AvatarCropEditor<br/>render・source・cropを返す"]
  Crop --> Save["BotProfileImageState.saveImage<br/>選択をAppStore.profileImageDraftsへ保持"]
  Save --> API["BellAPI.saveBotAvatarSelection<br/>Core/BellAPI+BotSettings.swift:4<br/>選んだvariantの3項目だけPATCH"]
  API --> Result["saved / confirmed / different / unconfirmed"]
  Result --> Refresh["成功時は選択を消してrefresh<br/>不一致・不明は選択とエラーを保持"]
```

| 部品・関数 | 責任と戻り先 |
| --- | --- |
| BotProfileImageState | imageAction、cropSource/cropSettings、loadedLargeAvatar、保存中、variant別errorとpendingSelectionsを所有。AppStoreのID別draftをload/persist |
| BotProfileHero | 小画像はbot.avatar。大画像版が無い/空/小画像版と同じなら小画像を使う。それ以外は`GET /api/bots/:id/avatar-large?v=:version`。taskの版が変わると表示を読み直す |
| BotProfileImageActionsModifier | 同じimages参照を使いsheetへ渡す。保存中は操作とinteractiveDismissを無効化 |
| BotProfileAvatarActions.loadSettings | GET BotProfileResponse（`Core/BotSettings.swift:3`）。avatarLarge/avatarSource/avatarLargeSourceが欠けた旧schemaは独立画像編集を無効にし理由表示。loadは選択前prepareと調整操作で使う |
| cancelOperations / AvatarActionLifetime | 閉じる・非表示・busyでgenerationを無効化し調整taskをcancel。古い画像情報応答が状態を書き換えないようacceptsで照合 |
| adjust / adjustmentImage | pending選択があればそのsource/crop。無ければvariantの保存済みsource、source無しならrender。大画像が無ければ小画像。読めない時はerrorText |
| AvatarImagePicker | iPhone/iPadはPhotosPicker、Macはimage fileImporter。prepareがあれば成功後に選択を開く。非表示等でprepare taskをcancel。失敗はcallerのonFailure |
| AvatarCropEditor | 拡大・drag、crop範囲を保持。小512角/大1024角。画像選択用callbackはrender/source/crop、Owner/ルームの既存形式callbackはrenderだけを返す。キャンセルはdismissでcallbackしない |
| AvatarImage | 画像decode・file読取、表示寸法、offset制限、render JPEG、正規化cropの計算と復元、source画像のJPEG化。sourceは長辺1600以下・文字列300万以下 |
| BotSettingsRequest（`Core/BotSettings.swift:102`） | imageOnlyVariantでは対象render/source/cropだけencodeしてreturn。プロフィールや他方の画像を要求に入れない |
| saveBotAvatarSelection / confirmBotAvatarSelection（`Core/BellAPI+BotSettings.swift:4,24`） | PATCH成功はsaved。networkConnectionLost/timedOutだけGET照合へ。確認は対象3項目だけ。GET認証以外の失敗はunconfirmed |
| saveImage / confirmImageSave | 選択の一致をfinishで検査。saved/confirmedなら選択を除去し名簿refresh。不一致・不明は選択を保持して結果確認/破棄を表示。確認操作自体はPATCHしない |
| discardImageSelection | 対象variantだけdraftとerrorを消す。サーバー変更はしない |
| BotProfileAISection / BotProfileDetails | 共通のAI表示・操作callbackとプロフィール本文。再起動callbackは各画面が持ち、利用権限確認とPOSTはAppStore.restartConversationへ渡す |

`saveImage`は成功結果を受けてpending選択を除去した後に一覧をrefreshする。refreshだけ失敗した場合は「画像を保存しましたが、表示を更新できませんでした」と別表示する。認証失敗では選択を保持してrequireLogin。`confirmImageSave`も確認成功と表示更新を別段階で扱う。

プロフィール本文・AI設定のメンバー編集は[BotEditor](members-and-rooms.md#メンバーdraftモデル候補画像)へ接続する。Owner/ルーム画像のdraftと、メンバー画像のvariant別未確認選択を同じ保存方式とは記述しない。

## 再起動の共有操作

```mermaid
flowchart TD
  Desktop["DesktopInspector.profile<br/>onRestartのTask"] --> Restart["AppStore.restartConversation(target:)<br/>Core/AppStore.swift:401"]
  Detail["ConversationDetailView.body<br/>onRestartのTask"] --> Restart
  Restart --> Access["authorizeAIUse(target:)<br/>購読・初期guideの確認"]
  Access --> Post["BellAPI.post<br/>POST target.path + /restart・EmptyBody"]
  Post --> Ack["APIAcknowledgement受領<br/>呼出画面へ戻る"]
```

利用権限確認またはPOSTのErrorはそのまま画面へ返す。Desktopは成功時に`errorText=nil`、失敗時に`operationFailureMessage`と`target.path + "/restart"`・POST・`.write`の診断を一回送る。詳細は成功時にdismiss、失敗時に`localizedDescription`だけを表示する。共通操作はUI状態・画面遷移・診断・refresh・再送を持たず、ackを再起動完了とは扱わない。

直接試験は[BillingStoreTestsの再起動5関数](tests.md#billingstoretestsswift)に対応する。Mac実画面用の`profile-terminal-ui-server.mjs`には購読・再起動の503/200応答・要求と診断の記録・resetを追加済み。`DesktopWorkspaceUITests.testMacInspectorRestartFailureReportsOnceAndSuccessKeepsInspector`は失敗文言・診断一回・POST一回、再操作成功時のerror消去・inspector保持とPOST計二回・診断計一回を検査し、[親のMac確認記録](refactor-progress.md#次の作業)で通過している。

## 整理候補

- **A-P1**：`ios/BellBot/BellBot/Views/SettingsView.swift:277`。ProfileEditor.saveがOwner PATCH、規範PUT、共通一覧refresh、エラー表示と診断を一つの関数で持つ。loadはuser-rulesをGETするが診断pathには`/api/owner`を渡す（同:267,272）。
- **A-P2（PR4反映済み）**：`ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift:323`と`ios/BellBot/BellBot/Views/ConversationDetailView.swift:43`。同じBotProfileAISectionの再起動callbackから`AppStore.restartConversation(target:)`を呼ぶ。成功・失敗後の画面処理は各callbackに残す。
- **A-P3**：`ios/BellBot/BellBot/Views/BotProfileComponents.swift:16,22,34`と`ios/BellBot/BellBot/Core/AppStore.swift:86`。variant別の画像選択をBotProfileImageState.pendingSelectionsとAppStore.profileImageDraftsの両方で保持し、loadDrafts/persistImageSelectionsで受け渡す。

## 未調査

- Owner・規範・追加機能の本体保存と反映、画像schemaの本体での生成・migration、AI再起動の内部実行。
- 実UIでの画像選択・前面復帰・切り抜き途中状態、未保存フォームのsheet/window終了、同時保存中の操作。PR4実装時の文書更新ではビルド・試験は未実行だった。後続のMacでの画像保存・再起動の確認結果は[親の確認記録](refactor-progress.md#次の作業)を参照し、その範囲外は未確認。
- AvatarCrop/ProfileTerminal/NetworkLifecycleProbe/BotSave等のXCTest本文・fixture。試験との対応は宣言で確認した範囲。
