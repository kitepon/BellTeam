# Appleの実ファイル・型・関数索引

[全体図](overview.md) / [状態と同期](state-and-sync.md) / [一覧・編集](members-and-rooms.md) / [設定・プロフィール](settings-and-profile.md) / [既存の予定一覧図](schedule-list.md)。

固定source：`refactor/apple-feature-map-20261103`、HEAD `4e01fadcb5edcaa74c010436a47be9cb26eabeec`。以下の行番号はこの版に対するもの。`Core/Models.swift`・`AppStore.swift`・`BellAPI.swift`と、今回の詳細図が対象とする6つのViewファイルは明示関数・initializer・表示body・主要な算出値まで掲載する。それ以外はファイル単位。synthesized initializerやDecodable生成処理を独立関数として挙げない。

PR2で移した6型の所在と行番号は、実装の固定source `e82f12aa53678534645946e64e56626b25bc2a84` からの配置変更を反映している。

PR3の入力・添付・会話画像と会話ファイルに残る定義の所在は、固定source `8ca67462304a059f1ee7a335b9d939a19ec6870e` からの配置変更を反映している。

PR4の再起動操作と二つのcallback、直接試験は、固定source `22d56bfeb20263ee2e51ca0830a213ae6cb6aedf` からの変更を反映している。PR4実装時の文書更新ではビルド・試験は未実行だった。後続の実行結果は[親の確認記録](refactor-progress.md#モデルの適用記録)を参照。

## Core/Models.swift

ファイル：[Models.swift](../../../../ios/BellBot/BellBot/Core/Models.swift)。値の所有と適用先は[状態図](state-and-sync.md)。

| 型・関数・算出値 | 機能 |
| --- | --- |
| [Bot](../../../../ios/BellBot/BellBot/Core/Models.swift#L3)、[Room](../../../../ios/BellBot/BellBot/Core/Models.swift#L25)、[Owner](../../../../ios/BellBot/BellBot/Core/Models.swift#L36) | 名簿・OwnerのHTTP応答素材。画像版とBotのdeletingも保持 |
| [OwnerLink.id](../../../../ios/BellBot/BellBot/Core/Models.swift#L49)、[Member.title](../../../../ios/BellBot/BellBot/Core/Models.swift#L58) | リンクの識別と返信者表示名 |
| [Delivery](../../../../ios/BellBot/BellBot/Core/Models.swift#L61)、[RoomRouting](../../../../ios/BellBot/BellBot/Core/Models.swift#L115) | 配送とルームの返信者判定結果 |
| [RecentMessage.preview](../../../../ios/BellBot/BellBot/Core/Models.swift#L74) | 一覧の副題用本文・画像表示 |
| [TimelineMessage.isOutgoing / isPeer / displayedImageURLs / status](../../../../ios/BellBot/BellBot/Core/Models.swift#L100) | 発言の向き・種別・画像参照・配送状態の集約 |
| [QueueItem.displayItems](../../../../ios/BellBot/BellBot/Core/Models.swift#L128) | Bot IDとstatus単位で表示queueをまとめる。`steered:true`（実行中ターンへの差し込み）はrunningとして数え、Botの実行中ターンごとに「処理中」1行にする。steeredの無い旧形式はfalse扱い。botId無しは別項目 |
| [Schedule.title](../../../../ios/BellBot/BellBot/Core/Models.swift#L159) | 予定の表示名 |
| [ChatTarget.id / isRoom / path](../../../../ios/BellBot/BellBot/Core/Models.swift#L166) | 宛先と`/api/bots/:id`・`/api/rooms/:id` |
| [ConversationPage](../../../../ios/BellBot/BellBot/Core/Models.swift#L177)、[ListResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L183) | 履歴ページと古い残件情報 |
| [BotsResponse / RoomsResponse / RoomResponse / OwnerResponse / QueueResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L190) | 共通状態・保存応答の入れ物 |
| [BotStopResponse.outcome](../../../../ios/BellBot/BellBot/Core/Models.swift#L203) | 個別停止の受付と中断確認の照合 |
| [AIControlResponse / AIControlUpdate / AIControl](../../../../ios/BellBot/BellBot/Core/Models.swift#L213) | 全体停止状態と更新body |
| [SchedulesResponse / AllSchedulesResponse.Source.target](../../../../ios/BellBot/BellBot/Core/Models.swift#L226) | Bot/room予定の応答を宛先へ対応 |
| [AllSchedulesResponse.schedules](../../../../ios/BellBot/BellBot/Core/Models.swift#L243) | 重複・未知kind・期待対象の欠落を検査 |
| [ScheduleListIncomplete.errorDescription / diagnosticContext](../../../../ios/BellBot/BellBot/Core/Models.swift#L265) | 不足件数だけの診断 |
| [ScheduleSource.listed](../../../../ios/BellBot/BellBot/Core/Models.swift#L276)、[ScheduleResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L281) | deleting以外のBotと全Roomを予定対象へ、予定保存応答 |
| [SessionResponse / HarnessOption / OfficialAuthenticationStatus / SetupAuthentication](../../../../ios/BellBot/BellBot/Core/Models.swift#L282) | 接続認証・公式AI認証の状態 |
| [AuthenticationBinding.init(from:)](../../../../ios/BellBot/BellBot/Core/Models.swift#L317) | 認証対象bindingの読取 |
| [AuthenticationBinding.encode(to:)](../../../../ios/BellBot/BellBot/Core/Models.swift#L330) | 同bindingをsnake_caseキーへ送信 |
| [AuthenticationUI.officialURL](../../../../ios/BellBot/BellBot/Core/Models.swift#L364)、[canRespond](../../../../ios/BellBot/BellBot/Core/Models.swift#L369) | 公式HTTPS URLと段階別の応答可否 |
| [AuthenticationUI.reply](../../../../ios/BellBot/BellBot/Core/Models.swift#L378) | authorizationCode/choiceとbinding/digestを要求へ |
| [AuthenticationReply.Response.encode](../../../../ios/BellBot/BellBot/Core/Models.swift#L395)、[AuthenticationReply](../../../../ios/BellBot/BellBot/Core/Models.swift#L390) | 入力種別と値・選択IDのencode |
| [SetupResponse / HarnessSelection / SetupEmptyBody](../../../../ios/BellBot/BellBot/Core/Models.swift#L414) | 初回利用の応答・AI選択要求 |
| [HarnessAuthenticationOption.init](../../../../ios/BellBot/BellBot/Core/Models.swift#L431)、[usageText](../../../../ios/BellBot/BellBot/Core/Models.swift#L439) | 利用AIの選択情報と人数表示 |
| [HarnessAuthenticationOption.canStart](../../../../ios/BellBot/BellBot/Core/Models.swift#L441) | 再認証非対応と初回認証の可否 |
| [HarnessAuthenticationOption.needsStartConfirmation](../../../../ios/BellBot/BellBot/Core/Models.swift#L445) | 警告を伴う開始確認の要否 |
| [HarnessAuthenticationsResponse / HarnessAuthenticationResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L449) | AI再認証一覧・個別状態 |
| [FeatureField.id](../../../../ios/BellBot/BellBot/Core/Models.swift#L460)、[FeatureSettingError](../../../../ios/BellBot/BellBot/Core/Models.swift#L462)、[FeatureSetting.statusText](../../../../ios/BellBot/BellBot/Core/Models.swift#L470) | 追加機能の項目・反映エラー・表示 |
| `FeatureSetting.guide` / `connection`、`FeatureGuide`（`openableLink`はhttpsだけ）、`OnePasswordConnection`、`OnePasswordState`（バッジ・接続の一行・`tokenProblem`）、`OnePasswordKey` / `OnePasswordKeysResponse` / `OnePasswordKeyList`（`after(_:)`は404を未対応、他を失敗）（`Core/Models.swift`） | 1Password連携の案内・接続・状態・`ops_`検査と、SSH鍵の選択一覧（[図](settings-and-profile.md#1password連携onepasswordusage-838)）。`guide`・`connection`は読めなければnil |
| [FeatureSettingsResponse / FeatureSettingResponse / FeatureSettingUpdate / APIAcknowledgement](../../../../ios/BellBot/BellBot/Core/Models.swift#L475) | 追加機能HTTPと内容を持たないack |
| [MessageSendAcknowledgement.messageID](../../../../ios/BellBot/BellBot/Core/Models.swift#L484) | BotのdeliveryIdとRoomのidを選ぶ |
| [ImagePayload / SendMessageBody](../../../../ios/BellBot/BellBot/Core/Models.swift#L492) | 本文・画像・ルーム宛先の送信body |
| [SecretRequest / SecretRequestResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L503) | 秘密入力要求の状態と結果。`botId`はnil可（端末の鍵）、`purpose`・`inputOptions`は省略可。同じ箇所の`SecretInputOptions`（1Passwordを先に開くか）と`SecretSubmission`（保存値 / 1Password参照のbody） |
| [OwnerQuestion / OwnerAnswerBody / OwnerQuestionResponse](../../../../ios/BellBot/BellBot/Core/Models.swift#L516) | 選択質問・回答要求・結果 |
| [EmptyBody](../../../../ios/BellBot/BellBot/Core/Models.swift#L533) | AppStore.restartConversationの再起動要求の空JSON値 |

## Core/AppStore.swift

ファイル：[AppStore.swift](../../../../ios/BellBot/BellBot/Core/AppStore.swift)。全体の遷移は[状態図](state-and-sync.md)、編集への接点は[一覧・編集](members-and-rooms.md)。

| 型・関数 | 機能 |
| --- | --- |
| [EventResource / MemberListReadOrigin](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L8) | 再取得資源と名簿呼出理由 |
| [MemberListReadCallContext.capture / log](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L24) | 名簿読取時の時計・状態を診断へ |
| [AppStore.Phase / Publishedと辞書](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L42) | アプリ共通状態。routingEnabled/notificationsEnabledは設定statusから算出 |
| [draft(for:)](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L118) | 宛先ごとの下書き参照を取得・生成 |
| [removeDraft(for:)](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L125) | 参照先をclearして辞書から除去 |
| [init](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L129) | 保存URL読取、API/billing/通知callbackの接続 |
| [remember](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L158) | 世代が同じ履歴ページだけ保持 |
| [clearConversationPages](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L163) | 世代更新とページ削除 |
| [setServerAddress](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L168) | URL検査・保存・接続先変更・bootstrap |
| [changeServer](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L185) | signOut後に接続先と共通状態を消去 |
| [bootstrap](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L206) | cookie同期・session確認・初期状態読取 |
| [completeWebLogin](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L222) | Web cookieとsession確認後に初期読取 |
| [loadInitialState](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L242) | settings/setup取得、onboardingまたは会話へ |
| [refreshSettings](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L249) | 追加機能状態GETと適用 |
| [refreshAIControl](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L254) | 全体停止読取、更新中は後続予約 |
| [setAIControlPaused](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L262) | 全体停止PATCH、失敗時GETと文言 |
| [readAIControl](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L303) | epoch/sequenceを照合してGET適用 |
| [resetAIControl](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L327) | 世代を更新して停止状態を消す |
| [refreshSetup](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L337) | 初回認証GET、古い応答と明示更新待ちの扱い |
| [chooseHarness](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L355) | 初回AI選択POST |
| [submitAuthResponse](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L362) | typed認証入力、失敗後の明示更新要求 |
| [startGuide](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L373) | 初回開始POST、ready確認 |
| [enterConversations](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L382) | 一覧取得・ready・SSE/購読/通知接続 |
| [authorizeAIUse](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L394) | 初期guideと購読によるAI利用照会 |
| [restartConversation(target:)](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L401) | authorizeAIUse後にEmptyBodyをPOSTしてAPIAcknowledgementを受領。DesktopInspector.profileとConversationDetailView.bodyのonRestartが呼び、成功・失敗の画面処理は各callerに残す |
| [activateNotifications](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L406) | APIと署名取引を通知singletonへ |
| [refresh](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L410) | 4資源と画像の取得・一括適用 |
| [withResolvedBotAvatars](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L429) | Bot名簿の画像解決要求を作る |
| [withResolvedRoomAvatars](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L442) | Room名簿の画像解決要求を作る |
| [withResolvedOwnerAvatar](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L455) | Ownerの画像解決 |
| [applyFetchedQueue](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L464) | runningのBot ID集合を適用 |
| [storeBotAvatarsIfChanged](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L469) | 通知用共有cacheの差分保存 |
| [resolveAvatars](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L488) | 画像要求を並列解決 |
| [immediateAvatar](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L503) | inline・空version・前回値の利用 |
| [avatar](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L512) | Botディスクcacheまたは画像GET |
| [requestRefreshFromEvent()](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L520) | 全資源の更新要求 |
| [requestRefreshFromEvent(resources:)](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L524) | 資源集合をまとめ、現在取得後にも処理 |
| [applySavedRoom](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L539) | 保存応答を一覧へ、recentは前値保持 |
| [requestBotDeletion](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L548) | DELETE受付とpending ID |
| [confirmBotDeletion](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L553) | 成功した一覧読取で消失確認 |
| [applyFetchedBots](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L560) | 名簿適用・削除済みの選択とdraft整理 |
| [deleteRoom](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L576) | DELETE成功後にApple状態を削除 |
| [applyDeletedRoom](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L581) | ルーム一覧・選択・draftを削除 |
| [refreshFromView](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L587) | 表示用の取得・エラー・購読確認 |
| [getForEvent](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L605) | 必要な資源だけGET |
| [refreshResourcesFromEvent](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L611) | 対象資源取得・画像解決・適用 |
| [updateConnectionError](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L645) | SSE、読取、通知の順にエラーを選ぶ |
| [sceneChanged](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L650) | foregroundの読取・再接続、background停止 |
| [startEvents](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L683) | SSE分岐、再接続、失敗の表示と診断 |
| [applyTargetedEvent](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L756) | topic/IDから画面通知と再取得資源へ |
| [stopEvents](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L779) | SSEと更新task・保留集合を破棄 |
| [requireLogin()](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L787) | 通信停止・状態整理・認証画面へ |
| [requireLogin(for:)](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L799) | Cloudflare判定と自動ログイン表示 |
| [signOut](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L805) | draft/ページ/cookie/購読/通知の後始末 |
| [openConversation](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L942) | 会話を開く経路（会話タブ・chatPath・eventRevision）。呼出元は通知のタップと相関図のメンバーのタップ。returningToを渡すと戻った時にそのタブへ帰る |
| [returnFromConversation](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L952) | 相関図から開いた会話を戻った時に帰り先のタブへ移る。呼出元はchatPathが空になった時（iPhone）と、縮んだiPadで一覧の列へ戻った時（DesktopWorkspaceView） |
| [openPendingNotification](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L959) | server照合・openConversationで会話移動・秘密要求読取 |
| [syncCookies](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L848) | 対象serverのCF_Authorizationを同期 |
| [cookieBelongsToServer](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L860) | cookie domain照合 |
| [HTTPCookie.isExpired](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L868) | cookie期限判定 |
| [WKHTTPCookieStore.allCookies](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L872) | callback読取をasyncへ |
| [WKHTTPCookieStore.deleteCookie](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L878) | callback削除をasyncへ |

## Core/BellAPI.swift

ファイル：[BellAPI.swift](../../../../ios/BellBot/BellBot/Core/BellAPI.swift)。別ファイルのextensionは後のBellAPI+BotSettings行を参照。

| 型・関数 | 機能 |
| --- | --- |
| [BellAPIError.isAuthenticationError](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L9) | 認証要求へ渡す失敗の分類 |
| [operationResultUnconfirmed](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L25) | 書込結果の未確認分類 |
| [operationFailureMessage](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L35)、[errorDescription](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L42) | 状態確認を促す文言とエラー表示 |
| [BellEventTopic / BellEvent.Scope](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L57)、[BellEvent.init](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L70) | SSE type/topic/IDの検査とall/targeted |
| [BellAPI.init](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L109) | URLSession・cookie・diagnosticsを保持 |
| [resetConnections](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L118) | cookieを保ったsession.flush |
| [finishSecretRequest](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L133) | 秘密値・1Password参照（`SecretSubmission`）のsubmit、nilはcancel。保護通信 |
| `onePasswordKeys(requestId:)` | `GET /api/secret-requests/:id/onepassword-items`の`items`。旧本体は404 |
| [updateSetting](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L142) | 追加機能の保護PATCH |
| [submitAuthenticationInput](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L146) | 初回認証の保護POST |
| [submitHarnessAuthenticationInput](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L150) | 再認証入力の保護POST |
| [protectedJSON](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L154) | 保護JSON送信・応答検査・session終了 |
| [protectedTrace](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L175) | 保護通信の最小診断参照 |
| [makeProtectedSession](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L182) | ephemeral・cookieStorage無し・redirect拒否 |
| [get](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L189) | GETとstatus付きdecode |
| [post](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L194) | POST・encode/decode |
| [sendMessage](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L200) | 背景実行時間付きPOST |
| [patch](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L207) | PATCH・encode/decode |
| [put](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L212) | PUT・encode/decode |
| [delete](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L217) | DELETE・応答検査 |
| [stopBot](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L221) | 停止HTTP statusとbodyの照合 |
| [exportConversation](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L229) | 書き出しDataの取得 |
| [image](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L233) | 認証画像Data |
| [avatar](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L237) | 画像をdata URLへ。AVATAR_NOT_FOUNDの404は空画像 |
| [imageResponse](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L246) | 画像MIME・HTTP検査 |
| [events](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L261) | byte列からSSE callback |
| [data](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L287) | status無しData窓口 |
| [dataWithStatus](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L292) | body設定、HTTP/JSON MIME検査、取消伝播 |
| [load](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L315) | 通信計測・接続喪失GETの一回再取得 |
| [load内recordedAttempt](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L325) | 壁時計・単調時計・連続時計とアプリ状態の記録 |
| [traced](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L396) | URLError/HTTPエラーにtraceを付ける |
| [decode](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L408) | DecodingErrorへroute/statusを付ける |
| [request](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L416) | baseURL相対URL・method・cookie |
| [validate](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L428) | Cloudflare redirect・origin・認証・2xx検査 |
| [SecretRedirectDelegate.urlSession](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L448) | 保護POSTのredirect拒否 |
| [BellTaskMetricsCollector.urlSession](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L460)、[snapshot](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L464) | 通信metricsの収集と読取 |
| [SSEParser.feed](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L477) | event/data行、CRLF、コメント、空行でJSON確定 |

## Views/HomeView.swift

ファイル：[HomeView.swift](../../../../ios/BellBot/BellBot/Views/HomeView.swift)。[一覧の詳細](members-and-rooms.md#一覧の素材と検索語の所有)。

| 型・関数・算出値 | 機能 |
| --- | --- |
| [HomeView.bots / rooms](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L9) | 画面のsearchで名前を抽出 |
| [recentFirst](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L19) | 日時順・元順によるソート |
| [body](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L30) | NavigationStack、pull更新、追加sheet |
| [searchField](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L64) | 検索入力・消去 |
| [header](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L83) | 追加メニューとOwner画像 |
| [introduction](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L112) | Owner名・オンライン数・部屋数 |
| [roomsSection](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L135) | RoomCardと会話へのリンク |
| [botsSection](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L154) | BotRowと会話へのリンク |
| [sectionTitle](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L174) | 一覧見出し |
| [RoomCard.body](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L190) | ルームの名前・副題・人数 |
| [BotRow.body](../../../../ios/BellBot/BellBot/Views/HomeView.swift#L226) | Botの名前・副題・日時・稼働丸 |

## Views/DesktopWorkspaceView.swift

ファイル：[DesktopWorkspaceView.swift](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift)。[一覧・編集](members-and-rooms.md)、[共通プロフィール](settings-and-profile.md)。

| 型・関数・算出値 | 機能 |
| --- | --- |
| [selection / visibleBots / visibleRooms](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L15) | 選択と名前検索・recent文字列順 |
| [body](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L25) | iPad/Macの列・詳細・sheet・エラー帯 |
| [sidebar](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L114) | 検索focus、行素材、予定/goal/設定への移動 |
| [sectionTitle](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L191) | 種別と件数 |
| [row](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L196) | 選択操作・subtitle表示・稼働丸 |
| [rowAvatarSize / rowVerticalPadding](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L224) | platform別の行寸法 |
| [welcome](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L240) | 未選択時の案内 |
| [DesktopInspector.bot / room](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L266) | target.idで共通一覧を参照 |
| [DesktopInspector.body](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L269) | 端末画面/プロフィール切替と画像sheet |
| [profileSmallImageSize](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L289) | platform別のプロフィール画像寸法 |
| [profile](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L297) | 参加者、画像・本文、編集を接続。onRestartはAppStore.restartConversationを呼び、成功時error消去、失敗時operationFailureMessageと/restart・POST・.write診断 |
| [heading](../../../../ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift#L358) | プロフィール見出し |

## Views/ManagementView.swift

ファイル：[ManagementView.swift](../../../../ios/BellBot/BellBot/Views/ManagementView.swift)。[メンバー・ルーム編集図](members-and-rooms.md)。

| 型・関数・算出値 | 機能 |
| --- | --- |
| [ModelsResponse / HarnessModels / ModelCatalogFailure / ModelChoice](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L3) | モデル候補と利用可否。ModelChoice.labelは`display_name`（任意）か、無ければidを表示名にする |
| [HarnessModels.fastModeUnavailableReason](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L11) | fastの不可理由 |
| [BotEditor.init](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L79) | initialからdraftの初期値を設定 |
| [modelChoices / effortChoices / fastModeUnavailableReason](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L98) | 候補と現在値、fast表示条件 |
| [deletionPending / largeAvatarPreview / canEditVariantImages](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L115) | 編集制御・画像プレビュー |
| [BotEditor.body](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L124) | メンバー・AI・プロフィール・削除・保存結果のフォーム |
| [profileField](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L335) | 複数行プロフィール入力 |
| [load](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L342) | draft復元・モデル候補GET |
| [reopenCrop](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L382) | 画像variantの再調整 |
| [persistDraft](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L394) | 既存Bot draftをAppStoreへ |
| [save](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L401) | メンバー保存・結果表示・一覧refresh |
| [deleteMember](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L436) | 削除要求と結果不明表示 |
| [confirmDeletion](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L453) | GETによる削除結果確認 |
| [settings / hasSavedResult](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L469) | BotSettings構築と結果の文言選択 |
| [confirmSave](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L486) | 保存内容のGET照合 |
| [close](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L499) | draft削除・sheet/windowを閉じる |
| [RoomRequest](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L506) | ルーム編集body |
| [RoomEditor.body](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L528) | メンバーSet選択・代表Picker・画像・削除・エラー |
| [populate](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L606) | initialからルームdraftへ |
| [save](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L615) | POST/PATCH・RoomResponse適用 |
| [deleteRoom](../../../../ios/BellBot/BellBot/Views/ManagementView.swift#L647) | 削除・dismissと失敗保持 |

## Views/SettingsView.swift

ファイル：[SettingsView.swift](../../../../ios/BellBot/BellBot/Views/SettingsView.swift)。[設定・Owner図](settings-and-profile.md)。

| 型・関数 | 機能 |
| --- | --- |
| [SettingsView.body](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L9) | Owner、停止、開き方、認証、追加機能、購読、通知、接続先/logout |
| [AIControlCard.body](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L111) | 共通状態の停止Toggleと読込・更新UI |
| [AIControlCard.status](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L154) | 4状態の表示文言 |
| [UserRulesResponse / UserRulesRequest / OwnerRequest / OwnerLinkRequest / LinkDraft](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L164) | Owner・規範の入出力とリンクdraft |
| [ProfileEditor.body](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L198) | Owner・リンク・規範・画像の編集 |
| [ProfileEditor.load](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L259) | Owner複製と規範GET |
| [ProfileEditor.save](../../../../ios/BellBot/BellBot/Views/SettingsView.swift#L277) | Owner PATCH → 規範PUT → 一覧refresh |

## Views/FeatureSettingsView.swift

ファイル：[FeatureSettingsView.swift](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift)。[追加機能図](settings-and-profile.md#追加機能のdraft秘密値保存)。

| 型・関数 | 機能 |
| --- | --- |
| [FeatureSettingsList.body](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L7) | 一覧GET・状態/反映errorと編集への遷移 |
| `FeatureSettingsList`の1Password行・`FeatureSettingDestination`・`OnePasswordBadge` | 行のバッジとplainなerror文、editorの振り分け。DEBUG `-bellbot-preview-feature <id>`でそのeditorを開く |
| `OnePasswordSettingEditor`（`load`・`save`） | 1Password連携のヘッダ・案内・token欄・主ボタン。`ops_`検査→PATCH→一覧再取得 |
| [FeatureSettingEditor.currentSetting](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L51) | 共通状態の現在値を選ぶ |
| [FeatureSettingEditor.body](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L53) | 初回読取後の編集・再読込、secret消去タイミング |
| [value(for:)](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L99) | key別の入力Binding |
| [clearSecrets](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L103) | secret fieldだけ空にする |
| [loadSettings](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L105) | GET成功後のdraft生成 |
| [save](../../../../ios/BellBot/BellBot/Views/FeatureSettingsView.swift#L123) | 空secret除外・PATCH・認証mode/設定再取得 |

## Views/BotProfileComponents.swift

ファイル：[BotProfileComponents.swift](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift)。[メンバー画像図](settings-and-profile.md#メンバー画像の共通部品)。

| 型・関数・算出値 | 機能 |
| --- | --- |
| [BotProfileImageState.usesSmallImage](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L18) | 大画像版から小画像共用を判定 |
| [loadDrafts](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L22) | AppStoreからID別画像draftを復元 |
| [openImageActions](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L26) | variant選択とシート状態初期化 |
| [persistImageSelections](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L34) | variant別選択をAppStoreへ |
| [discardImageSelection](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L39) | 対象variantを破棄 |
| [saveImage](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L47) | draft保持・PATCH結果・refresh・エラー |
| [confirmImageSave](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L87) | 保持中選択をGET照合 |
| [View.botProfileImageActions](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L122) | 共通modifierの取付け |
| [BotProfileImageActionsModifier.body](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L132) | 根のsheetと同じ画像状態を接続 |
| [BotProfileHero.usesSmallImage / backgroundImage](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L160) | 表示する画像素材 |
| [BotProfileHero.body](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L165) | 画像操作・大画像GET・結果表示 |
| [BotProfileAvatarActions.body](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L274) | 変更/調整・選択・確認/破棄・切り抜き画面 |
| [cancelOperations](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L358) | lifetime無効化・task取消 |
| [avatarPreview](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L364) | variantと未確認選択のプレビュー |
| [loadSettings](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L389) | Bot画像情報GET・schema/lifetime検査 |
| [adjust](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L426) | 元画像または保持中選択から再調整 |
| [adjustmentImage](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L444) | variantのrender/source/cropを選ぶ |
| [BotProfileAISection.body](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L461) | AI設定表示・画面/再起動callback |
| [BotProfileDetails.body](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L484) | 役職・背景・性格・口調・仕事 |
| [BotProfileDetails.detail](../../../../ios/BellBot/BellBot/Views/BotProfileComponents.swift#L495) | 共通本文表示・空値は未設定 |

## Update画面

追加時点の行番号（上の固定sourceの表には含まれない）。契約と流れは[Update画面](update.md)。

| 型・関数 | 機能 |
| --- | --- |
| [NullableField](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L5) | 必須だがnull可の項目。キー欠落をnullにせず応答不正にする |
| [UpdateInventory](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L15)、[UpdateComponent](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L50)、[UpdatePlan](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L86)、[UpdateOperation](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L112) | `bellteam.updates.v1`のClosed Codable。列挙の未知の値はdecode失敗。`isCompleted`・`isSettled`が確定の判定 |
| [UpdatePlanRequest / UpdateOperationRequest](../../../../ios/BellBot/BellBot/Core/UpdateModels.swift#L135) | `POST /api/updates/plans`・`/operations`のbody |
| [UpdateStore.refresh](../../../../ios/BellBot/BellBot/Core/UpdateStore.swift#L48) | inventoryと保存requestIdの結果をGET。失敗は成功に補わず確認中 |
| [UpdateStore.makePlan](../../../../ios/BellBot/BellBot/Core/UpdateStore.swift#L76) | 全体またはcomponentの計画をPOST |
| [UpdateStore.execute](../../../../ios/BellBot/BellBot/Core/UpdateStore.swift#L96) | 要求IDを保存してからPOST。4xxは確定、その他は受付不明で再送しない |
| [UpdateStore.reset](../../../../ios/BellBot/BellBot/Core/UpdateStore.swift#L35) / [apply](../../../../ios/BellBot/BellBot/Core/UpdateStore.swift#L127) | 接続先変更時の表示破棄 / 照会結果の適用と確定時の保存ID消去 |
| [UpdateBadge](../../../../ios/BellBot/BellBot/Views/UpdateView.swift#L4) | ロゴ右の印。`update_available`がある時だけ |
| [UpdateView](../../../../ios/BellBot/BellBot/Views/UpdateView.swift#L24)、[componentCard](../../../../ios/BellBot/BellBot/Views/UpdateView.swift#L79) / [operationCard](../../../../ios/BellBot/BellBot/Views/UpdateView.swift#L104) / [planCard](../../../../ios/BellBot/BellBot/Views/UpdateView.swift#L118) | Update画面の表示と、対象選択・計画・実行の操作 |
| [BellUpdateRoute](../../../../ios/BellBot/BellBot/Core/BellNotifications.swift#L28) | push `kind=update`の3key完全一致の解析と接続先照合 |
| [AppStore.openPendingUpdateNotification](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L889) | ready後に接続先一致の時だけUpdate画面を開きGET。`startEvents`の`updates`分岐は[AppStore.swift](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L736) |

## 端末の登録とメンバーの端末・フォルダ

追加時点のファイル。契約と流れは[端末](terminals.md)。

| ファイル・型 | 機能 |
| --- | --- |
| [Core/Terminals.swift](../../../../ios/BellBot/BellBot/Core/Terminals.swift) | `Terminal`・`TerminalCheck`・`TerminalMaintenance`（新しい項目は省略可で読む）、`TerminalDraft`（登録の検査とPUT body）、`MemberBinding`（組の規則とフォルダ）、`HostKeyFingerprint`、`TerminalKeyKind`・`TerminalKeyState`・`Terminal.key(_:)`（鍵の行の状態と鍵の出どころの文）、`TerminalKeyRequestResponse`、`TerminalErrorText`（`trace.serverErrorCode`から文、端末・鍵の入口の未対応の判定） |
| [Core/AppStore+Terminals.swift](../../../../ios/BellBot/BellBot/Core/AppStore+Terminals.swift) | `TerminalDirectory`と`refreshTerminals`・`saveTerminal`・`confirmHostKey`・`removeTerminal`・`checkTerminal`・`requestTerminalKey`・`removeTerminalKey`。`AppStore.terminals`はサインアウトと接続先変更で空に戻す |
| [Views/TerminalsView.swift](../../../../ios/BellBot/BellBot/Views/TerminalsView.swift) | `TerminalListPage`・`TerminalDetailPage`・`TerminalEditor`・`HostKeyConfirmSheet`・`MemberTerminalSection`・`TerminalsCalmLine`、鍵の行`TerminalKeyRow`と秘密入力sheetの起動・外す確認。DEBUGの`-bellbot-preview-terminal`で状態を開く |
| [Bot.terminalId / projectRoot](../../../../ios/BellBot/BellBot/Core/Models.swift)、[BotSettings.withBinding](../../../../ios/BellBot/BellBot/Core/BotSettings.swift) | メンバーの2項目（nilは旧本体）。nilはencodeせず、照合ではサーバー値を採る |
| [BotEditor](../../../../ios/BellBot/BellBot/Views/ManagementView.swift) | 「端末とフォルダ」節、保存前の組の規則、members符号の文 |
| [SettingsPage.terminals](../../../../ios/BellBot/BellBot/Views/SettingsView.swift) | 設定の項目「端末」。`SettingsIconTile`と`SettingsBanner`をこの画面と共有 |

## その他の製品Swift：ファイル単位

パスは`ios/BellBot/`から。上の9ファイルを除く43ファイル。型・関数名は到達先の目印で、この表では関数ごとの全分岐を列挙していない。

| ファイル | 主な型・機能・接続先 |
| --- | --- |
| [BellBot/App/BellBotApp.swift](../../../../ios/BellBot/BellBot/App/BellBotApp.swift) | BellBotApp/RootView/BellTabs、Mac MemberEditorWindowとgeometry、phase・platform配置・起動 |
| [BellBot/Core/AppleSubscriptionAccess.swift](../../../../ios/BellBot/BellBot/Core/AppleSubscriptionAccess.swift) | AppleSubscriptionEntitlement、期限/猶予/初期guide/開発者のAI利用判定 |
| [BellBot/Core/AvatarImage.swift](../../../../ios/BellBot/BellBot/Core/AvatarImage.swift) | crop型、AvatarActionLifetime、AvatarImageの読取・寸法・切抜き・JPEG・復元 |
| [BellBot/Core/BackgroundMessageSend.swift](../../../../ios/BellBot/BellBot/Core/BackgroundMessageSend.swift) | 背景実行時間確保、期限とcaller取消、終了 |
| [BellBot/Core/BellAPI+BotSettings.swift](../../../../ios/BellBot/BellBot/Core/BellAPI+BotSettings.swift) | BellAPI extensionの[saveBotAvatarSelection](../../../../ios/BellBot/BellBot/Core/BellAPI+BotSettings.swift#L4) / [confirmBotAvatarSelection](../../../../ios/BellBot/BellBot/Core/BellAPI+BotSettings.swift#L24) / [saveBotSettings](../../../../ios/BellBot/BellBot/Core/BellAPI+BotSettings.swift#L43) / [confirmBotSettings](../../../../ios/BellBot/BellBot/Core/BellAPI+BotSettings.swift#L64) |
| [BellBot/Core/BellDiagnostics.swift](../../../../ios/BellBot/BellBot/Core/BellDiagnostics.swift) | DecodingError.located、BellRequestTrace、BellDiagnosticObservation、BellDiagnostics。通信記録・影響・MetricKit・POST /api/diagnostics |
| [BellBot/Core/BellNotifications.swift](../../../../ios/BellBot/BellBot/Core/BellNotifications.swift) | BellNotificationRoute、BellUpdateRoute、BellNotifications、UIApplication delegate。push登録・解除・表示抑制・移動 |
| [BellBot/Core/BillingStore.swift](../../../../ios/BellBot/BellBot/Core/BillingStore.swift) | 購読status/entitlement/product、本人権利照会、purchase/restore/recheck、verify/finish |
| [BellBot/Core/BotSettings.swift](../../../../ios/BellBot/BellBot/Core/BotSettings.swift) | BotProfileResponse、BotSettings.normalized/withSmallAvatar/withLargeAvatar/withAvatarSelection、BotEditorDraft、AvatarSelectionDrafts、BotSettingsRequest.encode、BotSaveResult |
| [BellBot/Core/ConversationDocument.swift](../../../../ios/BellBot/BellBot/Core/ConversationDocument.swift) | JSON FileDocumentの読込・書出し |
| [BellBot/Core/ConversationDraft.swift](../../../../ios/BellBot/BellBot/Core/ConversationDraft.swift) | [ConversationDraft](../../../../ios/BellBot/BellBot/Core/ConversationDraft.swift#L6)の入力本文・画像・選択宛先、UIKitからの変更と外部clear/restore。[PendingImage](../../../../ios/BellBot/BellBot/Core/ConversationDraft.swift#L51)の[init(data:)](../../../../ios/BellBot/BellBot/Core/ConversationDraft.swift#L56) / [init(fileURL:)](../../../../ios/BellBot/BellBot/Core/ConversationDraft.swift#L63)で添付画像の検査・JPEG化 |
| [BellBot/Core/ConversationTimelineState.swift](../../../../ios/BellBot/BellBot/Core/ConversationTimelineState.swift) | 受信履歴とpending送信、受付ID照合、refresh併合・過去追加 |
| [BellBot/Core/GoalModels.swift](../../../../ios/BellBot/BellBot/Core/GoalModels.swift) | internalの値型16個。GoalAvailability/GoalStatus/GoalCapabilities/GoalFields/GoalFieldCapabilities/GoalBinding、CodexGoal/ClaudeGoalStatus/ClaudeGoalPhase/GrokGoalNative、[GrokCurrentStatus](../../../../ios/BellBot/BellBot/Core/GoalModels.swift#L64)、GoalHistoryKind/GoalTerminal、[NativeGoal](../../../../ios/BellBot/BellBot/Core/GoalModels.swift#L145)、GoalNativeHistory/[GoalSnapshot](../../../../ios/BellBot/BellBot/Core/GoalModels.swift#L236)。各harnessのdecodeと表示用算出値 |
| [BellBot/Core/GoalViewModel.swift](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift) | internalの[GoalLoadCallContext](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L4) / [GoalForegroundLoad](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L28) / [GoalViewModel](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L89)。[loadList](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L102) / [loadDetail](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L106) / [load](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L111) / [replace](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L145) / [run](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L153) / [change](../../../../ios/BellBot/BellBot/Core/GoalViewModel.swift#L159)がGET/POSTと取得・変更状態を扱う。GoalsResponse/GoalDetailResponse/GoalChangeResponse/GoalChangeOutcome/GoalChangeRequest/GoalViewErrorは同ファイル内のprivate型 |
| [BellBot/Core/HarnessAuthenticationFlow.swift](../../../../ios/BellBot/BellBot/Core/HarnessAuthenticationFlow.swift) | 公式AI再認証refresh/poll/start/respond/cancel、requestSequence |
| [BellBot/Core/PreviewFixtures.swift](../../../../ios/BellBot/BellBot/Core/PreviewFixtures.swift) | Debug専用AppStore.preparePreview、会話/質問/秘密/通知/画像fixture |
| [BellBot/Design/AvatarTone.swift](../../../../ios/BellBot/BellBot/Design/AvatarTone.swift) | Bot画像の代表色から吹き出し色を算出・cache |
| [BellBot/Design/BellTheme.swift](../../../../ios/BellBot/BellBot/Design/BellTheme.swift) | platform別文字サイズ、BellBackground、AvatarView/AvatarPortraitCache、BellDate、bellCard |
| [BellBot/Design/BotPresenceDot.swift](../../../../ios/BellBot/BellBot/Design/BotPresenceDot.swift) | 稼働・online/offlineの丸、ファストbadge |
| [BellBot/Views/AuthenticationInstructions.swift](../../../../ios/BellBot/BellBot/Views/AuthenticationInstructions.swift) | typed段階/URL/コード/選択肢表示。認証操作をcallbackへ |
| [BellBot/Views/AvatarCropEditor.swift](../../../../ios/BellBot/BellBot/Views/AvatarCropEditor.swift) | 切抜きdraft、drag/zoom/useImage、Mac sheet寸法 |
| [BellBot/Views/AvatarImagePicker.swift](../../../../ios/BellBot/BellBot/Views/AvatarImagePicker.swift) | 写真/Macファイル、prepare/取消/lifetime、onSelect/onFailure |
| [BellBot/Views/BotScreenView.swift](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift) | privateの[ScreenResponse](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L4) / [BotTerminalView](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L9)、internalの[BotTerminalTextView.show](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L33) / [BotScreenView](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L47)。[body](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L58) / [screenContent](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L86) / [refreshScreen](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L106)で端末snapshot取得・置換・読書位置保持 |
| [BellBot/Views/ConversationDetailView.swift](../../../../ios/BellBot/BellBot/Views/ConversationDetailView.swift) | internalの[ConversationDetailView](../../../../ios/BellBot/BellBot/Views/ConversationDetailView.swift#L4)。[bot / room](../../../../ios/BellBot/BellBot/Views/ConversationDetailView.swift#L13)を共通一覧から選び、[body](../../../../ios/BellBot/BellBot/Views/ConversationDetailView.swift#L16)がプロフィール・再起動・編集/端末sheet・画像のStateObjectを所有。onRestartはAppStore.restartConversationを呼び、成功時dismiss、失敗時localizedDescriptionを表示 |
| [BellBot/Views/ConversationImages.swift](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift) | internalの[ConversationGallery](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L5) / [MessageImages](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L11) / [MessageImageGallery](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L59)、privateの[AuthenticatedImage](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L146) / [conversationImageOrigin](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L186) / [ConversationImageCache](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L198)。[image](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L210) / [decode](../../../../ios/BellBot/BellBot/Views/ConversationImages.swift#L246)で認証取得・共有・縮小復号 |
| [BellBot/Views/ConversationInput.swift](../../../../ios/BellBot/BellBot/Views/ConversationInput.swift) | internalの[ConversationInput](../../../../ios/BellBot/BellBot/Views/ConversationInput.swift#L5)、privateの[MessageInput](../../../../ios/BellBot/BellBot/Views/ConversationInput.swift#L69)と[Coordinator](../../../../ios/BellBot/BellBot/Views/ConversationInput.swift#L123)、internalの[MessageTextView](../../../../ios/BellBot/BellBot/Views/ConversationInput.swift#L135)。入力同期・最大5行の寸法・Return/修飾キー・画像貼付け |
| [BellBot/Views/ConversationList.swift](../../../../ios/BellBot/BellBot/Views/ConversationList.swift) | UITableView/DiffableDataSource/UIHostingConfiguration、Markdown先読み、過去取得要求、末尾/読書位置、rise/fade、Mac WheelScrollSmoother |
| [BellBot/Views/ConversationView.swift](../../../../ios/BellBot/BellBot/Views/ConversationView.swift) | ConversationContentの初回/差分/過去/送信/停止/JSON出力、ReadCoordinator/ConversationCardStates/ConversationSheet/ConversationHistoryPage、MessageRow/PeerMessageSheet、送信失敗の観測型。ConversationInput、ConversationGallery/MessageImages/MessageImageGallery、詳細sheetのConversationDetailViewを呼ぶ |
| [BellBot/Views/GoalsView.swift](../../../../ios/BellBot/BellBot/Views/GoalsView.swift) | [GoalEditorSelection](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L3)、[GoalsView](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L11) / [ChatGoalBar](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L149)、[GoalCardPresentation](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L261) / [GoalCard](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L262) / [GoalEditField](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L384) / [GoalEditor](../../../../ios/BellBot/BellBot/Views/GoalsView.swift#L386)。各画面が独立したGoalViewModelとGoalForegroundLoadを生成し、一覧・会話bar・カード・editorを表示 |
| [BellBot/Views/HarnessAuthenticationView.swift](../../../../ios/BellBot/BellBot/Views/HarnessAuthenticationView.swift) | AI一覧・Row状態・再認証画面、3秒poll・開始警告・明示更新 |
| [BellBot/Views/LoginView.swift](../../../../ios/BellBot/BellBot/Views/LoginView.swift) | ServerSetupView、LoginView、WKWebViewのCloudflareLoginView。URL入力・Web完了通知 |
| [BellBot/Views/MessageText.swift](../../../../ios/BellBot/BellBot/Views/MessageText.swift) | EnrichedMarkdown本文、prerender、theme、部分選択、リンク、末尾余白 |
| [BellBot/Views/OnboardingView.swift](../../../../ios/BellBot/BellBot/Views/OnboardingView.swift) | 初回AI選択・typed認証・guide開始・3秒poll |
| [BellBot/Views/OwnerQuestionView.swift](../../../../ios/BellBot/BellBot/Views/OwnerQuestionView.swift) | OwnerQuestionCardState/Card、回答、FlowButtons/FlowLayout |
| [BellBot/Views/SchedulesView.swift](../../../../ios/BellBot/BellBot/Views/SchedulesView.swift) | ScheduleRefreshState、一覧・対象差分・CRUD/run、ScheduleEditorの頻度/宛先。既存[予定一覧図](schedule-list.md)を再利用 |
| [BellBot/Views/SecretRequestView.swift](../../../../ios/BellBot/BellBot/Views/SecretRequestView.swift) | 秘密要求カード状態、SecretInputSheetの入力方法（1Password参照が先・保存値が代替。SSH鍵は1Passwordの鍵の一覧から選ぶ・旧本体は貼り付けへ）・submit/cancel・値と参照の消去 |
| [BellBot/Views/SelectableText.swift](../../../../ios/BellBot/BellBot/Views/SelectableText.swift) | 選択可能UITextView、MeasuredTextViewの幅別寸法cache |
| [BellBot/Views/ServerInstallationGuide.swift](../../../../ios/BellBot/BellBot/Views/ServerInstallationGuide.swift) | 同梱Markdown、依頼文のコピー/共有、導入ガイドへのLink |
| [BellBot/Views/SubscriptionView.swift](../../../../ios/BellBot/BellBot/Views/SubscriptionView.swift) | SubscriptionCard/Content、価格・権利・購入/復元/再確認・リンク |
| [Shared/BotAvatarCache.swift](../../../../ios/BellBot/Shared/BotAvatarCache.swift) | App Groupのorigin別画像・versionファイル、保存と除去、actor窓口 |
| [Shared/CommunicationNotification.swift](../../../../ios/BellBot/Shared/CommunicationNotification.swift) | payloadの送り主・roomからINSendMessageIntentを作る |
| [Shared/ServerOrigin.swift](../../../../ios/BellBot/Shared/ServerOrigin.swift) | HTTPSまたはlocal HTTPの接続先URLとorigin正規化 |
| [NotificationService/BellNotificationService.swift](../../../../ios/BellBot/NotificationService/BellNotificationService.swift) | 通知拡張、App Group画像・Intentの寄付・元通知を返す失敗/期限経路 |

## 試験の対応表

`BellBotTests`26本と`BellBotUITests`19本はファイル内の全`func test...`宣言を抽出して確認した。以下は**試験名で確認できる対象**で、assertion/fixture本文の読了や合格を意味しない。`Tests`2本は本文まで読んだ。全て未実行。

### BellBotTests

| ファイル | 宣言で確認した対象 |
| --- | --- |
| [UpdateCenterTests.swift](../../../../ios/BellBot/BellBotTests/UpdateCenterTests.swift) | サーバー有限例13種のdecode、Closed検査、保存requestId・409・断線、SSE `updates`、push kind=updateの3key、タップ（[対応](tests.md#updatecentertestsswift)） |
| [AIControlTests.swift](../../../../ios/BellBot/BellBotTests/AIControlTests.swift) | stopping/停止確認、PATCH結果不明のGET、停止解除失敗 |
| [AuthSetupOrderingTests.swift](../../../../ios/BellBot/BellBotTests/AuthSetupOrderingTests.swift) | 古い認証応答・失敗、明示更新待ち、setup/harnessの順序 |
| [AuthenticationRecoveryTests.swift](../../../../ios/BellBot/BellBotTests/AuthenticationRecoveryTests.swift) | Access期限とdraft保持、local拒否、認証失敗分類 |
| [AvatarImageTests.swift](../../../../ios/BellBot/BellBotTests/AvatarImageTests.swift) | lifetime、variant表示、ファイル読取、JPEG切抜き、旧crop復元 |
| [BackgroundMessageSendTests.swift](../../../../ios/BellBot/BellBotTests/BackgroundMessageSendTests.swift) | 実行時間、成功/失敗/期限/拒否/caller取消と終了 |
| [BellDiagnosticsTests.swift](../../../../ios/BellBot/BellBotTests/BellDiagnosticsTests.swift) | 状態時計、診断参照、匿名化・route・復号context、予定不足、SSEParser/対象範囲、flushとcookie |
| [BillingStoreTests.swift](../../../../ios/BellBot/BellBotTests/BillingStoreTests.swift) | 初回未確認・再確認、developer/本人権利、失敗・古い照会・restore重複。[restartConversation直接試験5関数](tests.md#billingstoretestsswift)は権限拒否・空JSON一回・POST失敗3種のError保持と非再送・初期guideのsetup再照会を検査 |
| [BotSaveTests.swift](../../../../ios/BellBot/BellBotTests/BotSaveTests.swift) | variant選択保持、画像だけの要求、保存GET照合（復号失敗のunconfirmedとcoding path保持を含む）、認証、fast、編集draft |
| [BotStopTests.swift](../../../../ios/BellBot/BellBotTests/BotStopTests.swift) | 202/200の照合と未確認時の非再送 |
| [BotTerminalTextViewTests.swift](../../../../ios/BellBot/BellBotTests/BotTerminalTextViewTests.swift) | 端末画面置換と読書位置・末尾追従 |
| [CommunicationNotificationTests.swift](../../../../ios/BellBot/BellBotTests/CommunicationNotificationTests.swift) | 送り主/room、Intent、画像cache、元body/route |
| [ConversationAppearanceTests.swift](../../../../ios/BellBot/BellBotTests/ConversationAppearanceTests.swift) | Markdown余白/コピー/リンク/表、画像URL、色、ホイール、予定応答とページ世代 |
| [ConversationDraftTests.swift](../../../../ios/BellBot/BellBotTests/ConversationDraftTests.swift) | 文字入力通知、宛先共有、logoutのdraft/cookie |
| [ConversationTimelineStateTests.swift](../../../../ios/BellBot/BellBotTests/ConversationTimelineStateTests.swift) | 同文送信のID照合、配送更新とcursor追加 |
| [EventStreamLiveTests.swift](../../../../ios/BellBot/BellBotTests/EventStreamLiveTests.swift) | 要求timeoutを超えるSSE接続 |
| [ForegroundRefreshTests.swift](../../../../ios/BellBot/BellBotTests/ForegroundRefreshTests.swift) | 更新要求併合、background取消、古いGETとforeground |
| [HarnessAuthenticationTests.swift](../../../../ios/BellBot/BellBotTests/HarnessAuthenticationTests.swift) | 開始確認、再認証非対応、初回開始、参照と変更の分離、poll/取消/明示更新 |
| [MemberActivityTests.swift](../../../../ios/BellBot/BellBotTests/MemberActivityTests.swift) | queue表示重複、stopped、workingBotIDs |
| [MemberDeletionTests.swift](../../../../ios/BellBot/BellBotTests/MemberDeletionTests.swift) | 削除受付と一覧消失、拒否・応答喪失時の保持 |
| [MessageInputTests.swift](../../../../ios/BellBot/BellBotTests/MessageInputTests.swift) | iPadのReturn/修飾改行、iPhone標準動作 |
| [NetworkRecoveryTests.swift](../../../../ios/BellBot/BellBotTests/NetworkRecoveryTests.swift) | GET一回再取得、POST非再送、Access、診断時計・route、goal取消、SSE復帰/対象更新、画像再利用 |
| [NotificationTests.swift](../../../../ios/BellBot/BellBotTests/NotificationTests.swift) | 通知から会話置換、秘密/質問/roomのroute、未知通知 |
| [OnboardingTests.swift](../../../../ios/BellBot/BellBotTests/OnboardingTests.swift) | origin、初回認証decode、binding/digest、session、保護通信、反映エラー |
| [RoomDeletionTests.swift](../../../../ios/BellBot/BellBotTests/RoomDeletionTests.swift) | 削除対象の選択/draftだけ整理、失敗時保持 |
| [SecretTransportTests.swift](../../../../ios/BellBot/BellBotTests/SecretTransportTests.swift) | public HTTP拒否と秘密POST redirect拒否 |
| [TerminalsTests.swift](../../../../ios/BellBot/BellBotTests/TerminalsTests.swift) | 端末・メンバー項目の新旧応答、鍵の項目と行の状態、鍵の秘密入力要求の解読と送信body、組の規則、フォルダ、指紋、確認結果の文、符号の文、未対応状態 |
| [SelectableTextLayoutTests.swift](../../../../ios/BellBot/BellBotTests/SelectableTextLayoutTests.swift) | UITextView寸法・本文変更・幅変更のcache |

### BellBotUITests

| ファイル | 宣言で確認した対象 |
| --- | --- |
| [AuthTypedUITests.swift](../../../../ios/BellBot/BellBotUITests/AuthTypedUITests.swift) | typed認証URL/コード、複数harness、iPadモデルreadback |
| [AvatarCropUITests.swift](../../../../ios/BellBot/BellBotUITests/AvatarCropUITests.swift) | Owner写真・前面復帰、保存前の再調整 |
| [BotStopUITests.swift](../../../../ios/BellBot/BellBotUITests/BotStopUITests.swift) | 個別会話とroomの停止UI、draft保持 |
| [ConnectionErrorUITests.swift](../../../../ios/BellBot/BellBotUITests/ConnectionErrorUITests.swift) | iPhoneの再接続表示 |
| [ConversationAppearanceUITests.swift](../../../../ios/BellBot/BellBotUITests/ConversationAppearanceUITests.swift) | 画像・旧形式・部分コピー・入力高さ・失敗後の添付復元・質問・リンク |
| [ConversationFreezeUITests.swift](../../../../ios/BellBot/BellBotUITests/ConversationFreezeUITests.swift) | 更新/スクロール中の操作、質問draft、秘密sheet |
| [ConversationScrollUITests.swift](../../../../ios/BellBot/BellBotUITests/ConversationScrollUITests.swift) | Markdown後の位置、過去取得と失敗、新着、対象更新、最古到達・iPad回転 |
| [DesktopWorkspaceUITests.swift](../../../../ios/BellBot/BellBotUITests/DesktopWorkspaceUITests.swift) | Mac長文/ホイール/過去、inspector、モデル待ち保存、Return、端末画面・編集window、draft |
| [GoalsUITests.swift](../../../../ios/BellBot/BellBotUITests/GoalsUITests.swift) | 一覧/チャットgoal、capability/binding、編集・未確認・再取得、Claude/Grok型、失敗後表示 |
| [HarnessAuthenticationUITests.swift](../../../../ios/BellBot/BellBotUITests/HarnessAuthenticationUITests.swift) | Antigravityの開始可否、一覧状態、開始確認・取消・通信失敗 |
| [InstalledConversationUITests.swift](../../../../ios/BellBot/BellBotUITests/InstalledConversationUITests.swift) | 既存メンバー保存中断準備、pull/通知、スクロール/キーボード/詳細 |
| [MemberDeletionUITests.swift](../../../../ios/BellBot/BellBotUITests/MemberDeletionUITests.swift) | 削除範囲確認と失敗保持 |
| [NetworkLifecycleProbeUITests.swift](../../../../ios/BellBot/BellBotUITests/NetworkLifecycleProbeUITests.swift) | 追加設定初回/後続読取、予定/会話背景とtimeout、SSE、送信復元/受付、停止不明、診断参照、実サーバー対象更新 |
| [NotificationNavigationUITests.swift](../../../../ios/BellBot/BellBotUITests/NotificationNavigationUITests.swift) | 通知から表示会話置換 |
| [ProfileTerminalUITests.swift](../../../../ios/BellBot/BellBotUITests/ProfileTerminalUITests.swift) | 検索・プロフィール・端末照会、長履歴は1万行fixtureでhistory=1要求と画面取得（本文の行数・最終行は未照合）、旧schema、写真/切抜き/更新中保持、小大独立保存、iPad詳細 |
| [RoomDeletionUITests.swift](../../../../ios/BellBot/BellBotUITests/RoomDeletionUITests.swift) | 取消/失敗の保持、成功時一覧復帰とメンバー保持 |
| [SecretInputUITests.swift](../../../../ios/BellBot/BellBotUITests/SecretInputUITests.swift) | 登録表示・値と入力欄の非表示・再起動後の表示。通常会話へのPOST件数は確認しない |
| [ServerSetupUITests.swift](../../../../ios/BellBot/BellBotUITests/ServerSetupUITests.swift) | 接続後AI選択、未接続の導入ガイドとURL入力保持 |
| [TerminalsUITests.swift](../../../../ios/BellBot/BellBotUITests/TerminalsUITests.swift) | iPhoneの端末一覧・追加・確認・ホスト鍵・削除、鍵の設定（秘密入力カード・1Password参照が先）と外す、メンバー編集の端末とフォルダ、旧本体の一行表示 |
| [TabletWorkspaceUITests.swift](../../../../ios/BellBot/BellBotUITests/TabletWorkspaceUITests.swift) | iPad画像寸法、列/回転/draft、キーボード、共通編集sheet |

### Testsと構成

| ファイル | 本文で確認した対象・構成 |
| --- | --- |
| [Tests/AppleSubscriptionAccessChecks.swift](../../../../ios/BellBot/Tests/AppleSubscriptionAccessChecks.swift) | @main、precondition12件。本人権利/期限/猶予、developer、初回guideの境界 |
| [Tests/BotStopContractChecks.swift](../../../../ios/BellBot/Tests/BotStopContractChecks.swift) | @main、HTTP/status/Bot ID/sessionPreservedの6組照合と欠損decodeの1件 |
| [project.yml](../../../../ios/BellBot/project.yml) | 4target、resource、Swift package、通知拡張embed、App Group、Mac Catalyst、scheme |
| [BellTeam.xcscheme](../../../../ios/BellBot/BellBot.xcodeproj/xcshareddata/xcschemes/BellTeam.xcscheme) | Debugの2試験target・preview起動引数 |
| [Package.resolved](../../../../ios/BellBot/BellBot.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved) | EnrichedMarkdownの解決済みsource参照 |
| [scripts/install-mac.sh](../../../../scripts/install-mac.sh) | Mac用build/署名確認/既存backup/入替/起動確認の手順。未実行 |

## 読取範囲と本文未読のSwiftファイル

固定HEAD `3df013d09eac6a7f83dc91d14a79a2984bbf82ad` の`ios/BellBot/`のSwiftは99本（製品52本、BellBotTests26本・BellBotUITests19本、Tests2本）。`rg --files ios/BellBot`の`.swift`ファイルを数えた。初回source `4e01fadcb5edcaa74c010436a47be9cb26eabeec` の92本から新規7本（BellAPI+BotSettings、GoalModels、GoalViewModel、BotScreenView、ConversationDetailView、ConversationImages、ConversationInput）が増え、上の対応表にも掲載済み。

初回source `4e01fadcb5edcaa74c010436a47be9cb26eabeec` の読了実績は**全文読了47本**（製品45本とTests2本）、**宣言のみ確認45本**（BellBotTests26本・BellBotUITests19本）、完全に未参照のSwiftファイルは0本。試験宣言だけの読取を本文読了に含めない。

初回sourceで本文未読だった全45本は上の「BellBotTests」「BellBotUITests」の対応表に1ファイル1行で全て列挙している。当時の未読範囲はそれらの試験実装・assertion・fixture・補助型で、製品コードの未読ファイルは無かった。試験本文の後続調査は[試験の対応表](tests.md#読取目録と試験の区分)を参照。

## 整理候補

新規の候補はここには追加しない。各図の事実記録は**計7件**：overviewのA-O1が1件、state-and-syncのA-S1/A-S2が2件、members-and-roomsのA-M1が1件、settings-and-profileのA-P1/A-P2/A-P3が3件。既存schedule-list.mdの記述は今回の件数に含めない。

## 未調査

- 初回sourceで未読だった上記45本の試験本文は[後続調査](tests.md#読取目録と試験の区分)で読了済み。生成Xcode projectの全登録と構成の一致、packされたアプリ・拡張の実物は未調査。
- 初回sourceの調査ではXcodeビルド・Swiftチェック・XCTest・UI試験・pack・installは全て未実行。後続の実行結果は[親の確認記録](refactor-progress.md#次の作業)を参照し、そこにない実行時の挙動・各試験の現在の合否は未確認。
- 本体`src/`・`web/`の実装。索引はAppleのcallerを示し、本体処理の責任や完了を推測しない。
