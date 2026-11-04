# 背景復帰・通知・購読・端末別配置

[全体図](overview.md) / [状態と同期](state-and-sync.md) / [会話](conversation.md) / [認証](requests-and-auth.md) / [試験](tests.md)。

調査source：HEAD `afda9477bba4aaa7c8a6905100d3bacf26e47c90`（detached）。静的読取。パスは`ios/BellBot/`から。共通一覧の適用、SSEのtopic振分け、保存物の全表は[状態と同期](state-and-sync.md)を参照し、ここでは再掲しない。

## scene遷移とSSE再接続

```mermaid
flowchart TD
  Root["RootView.onChange scenePhase"] --> Scene["AppStore.sceneChanged<br/>sceneと診断状態を更新"]
  Scene --> Active["activeかつready<br/>前のforegroundTaskをcancel"]
  Active --> Flush["BellAPI.resetConnections<br/>専用session.flush・cookie保持"]
  Flush --> Refresh["refreshFromView<br/>共通一覧→本体購読状態"]
  Refresh --> Control["AI全体停止状態GET"]
  Control --> Apple["StoreKit本人権利確認"]
  Apple --> Start["activeかつreadyなら<br/>SSE開始・必要なら通知登録"]
  Scene --> Background["background<br/>foregroundTaskとSSE/資源再取得を取消"]
  Scene --> Inactive["inactive<br/>AppStoreでは停止分岐なし"]
```

根拠：[AppStore.sceneChanged](../../../../ios/BellBot/BellBot/Core/AppStore.swift#L650)。各待機後にTask.isCancelledを検査する。refreshFromViewは失敗をthrowせずエラー表示へ返すため、次の停止状態/本人権利照会は取消されていなければ進む。RootViewのDebug preview引数ではsceneChangedの呼出しを省く。各画面のtask取消は別にあり、会話は非activeでreader/過去取得を止める。

```mermaid
flowchart TD
  Events["startEvents<br/>前のSSEと資源taskを止めて開始"] --> Get["GET /api/events"]
  Get --> Apply["受信イベント<br/>エラー消去→共通同期へ"]
  Get --> End["正常終端 / URLError / 429・5xx"]
  End --> Notice["再接続中をconnectionErrorへ"]
  Notice --> Delay["1秒から倍増・最大30秒<br/>30秒超の接続で遅延/連続数を戻す"]
  Delay --> Get
  Get --> Auth["認証失敗<br/>requireLogin・loop終了"]
  Get --> Bad["その他の応答/形式等の失敗<br/>エラーと診断・loop終了"]
```

URLError連続5回目で診断し、429/5xxは各回診断する。取消は終了、stopEventsはeventsTask/eventRefreshTaskをcancelして保留資源集合も消す。接続が切れたことと再接続、イベント後のHTTP再取得、画面の再取得完了は別段階。[詳細](state-and-sync.md#sseの適用)へ接続する。

## push登録・受信・画面移動

| 所有者 | 入出力・副作用・失敗 |
| --- | --- |
| BellNotificationAppDelegate | 起動時にUNUserNotificationCenter.delegateをsingletonへ。APNs token/登録失敗をBellNotificationsへ返す |
| BellNotifications.shared | api/token/署名取引/attached/activating/registrationTask/pendingRoute/visibleConversation、statusText/errorTextを所有 |
| activate | `GET /api/notifications`でconfigured/environment照合→OS権限確認/初回要求→APNs登録。attachedを途中で確認。未設定/権限拒否は状態文言、例外はerrorとstage別診断。API呼出しの成功だけでは端末登録済みにしない |
| registerToken | tokenを16進化し、server/環境/previousToken/署名取引と`POST /api/notifications/devices`。応答後UserDefaultsへtoken、成功文言。失敗は保持状態にerror/診断。署名取引更新時もattachedなら登録 |
| 前面通知 | payloadをrouteへ変換、接続先一致かつattachedだけ表示対象。表示中会話と同じなら抑止、別ならbanner/list/sound |
| タップ | routeをonOpenへ。callback未設置ならpendingRouteに保持し、設置時に一度配送。AppStoreはreadyまで保留、server照合後selectedTab=0/chatPath置換/eventRevision増加 |
| 秘密通知 | `GET /api/secret-requests/:id`のpendingだけsheetへ。認証失敗はrouteを戻してrequireLogin、その他はconnectionErrorへ。秘密の登録処理は[要求図](requests-and-auth.md) |
| detach | attached=false、APNs解除・配信済み通知削除→registrationTask終了待ち→保存tokenで`POST /api/notifications/unregister`。成功時だけ保存token削除、失敗は診断。api/token/署名/route/表示会話を消しstatusを未設定へ |

`kind=update`は別の`BellUpdateRoute`（[BellNotifications.swift](../../../../ios/BellBot/BellBot/Core/BellNotifications.swift#L28)）が、`bellteam`の`server`・`kind`・`messageId`の3key完全一致の時だけ受け、`onOpenUpdate`→`AppStore.openPendingUpdateNotification`でUpdate画面を開く。既存3種の解析・移動は変えない。詳細は[Update画面](update.md)。

根拠：[BellNotifications.swift](../../../../ios/BellBot/BellBot/Core/BellNotifications.swift#L28)。routeはServerOriginを通したserver、reply/secret_request/owner_questionと空でないbotIdが必要。roomIdがあればルーム、秘密だけrequestIdを持つ。通知タップは現在の会話へpush追加せずchatPathを置換する。

```mermaid
flowchart LR
  APNs["APNs payload"] --> Ext["BellNotificationService<br/>元contentとhandlerを保持"]
  Ext --> Intent["CommunicationNotification.intent<br/>sender・body・画像を検査"]
  Cache["App Group BotAvatarCache<br/>保存済みBot画像"] --> Intent
  Intent --> Donate["incoming INInteractionをdonate"]
  Donate --> Update["original.updating from intent<br/>handlerへ1回返す"]
  Ext --> Original["情報不足・画像読取失敗・期限切れ<br/>元contentを返す"]
  Donate -->|"失敗"| Original
  Update -->|"書換え失敗"| Original
```

[通知拡張](../../../../ios/BellBot/NotificationService/BellNotificationService.swift#L5)はNSLockでhandlerを取り出してnilにし、多重返却を抑える。途中失敗と期限切れはログを残して元の通知へ戻す。ネットワーク取得・SSE・診断POSTは行わない。

[CommunicationNotification](../../../../ios/BellBot/Shared/CommunicationNotification.swift#L5)はsender ID/name、server、空白除去後の非空body、画像復号成功を要求。Bot IDまたはroom IDからorigin込みconversationIdentifierを作り、ルーム名があればgroup名と送り主画像を設定する。ルーム名だけありID無しなら`origin/rooms`。通知の開く先はbellteam payloadのrouteを使う。

## 通知アバターcache

[BotAvatarCache](../../../../ios/BellBot/Shared/BotAvatarCache.swift#L6)はApp Groupの`avatars/<percent-encoded origin>/`へID別画像とversions.jsonを保存する。AppStoreの名簿適用後にBotAvatarCacheAccess actorへ渡し、変化したserver/entriesだけ保存する。成功前は保存済みentriesを更新せず、失敗は診断へ。

| 処理 | 成功・失敗・後始末 |
| --- | --- |
| storeVersioned | 同version・既存file・image data URLなら再書込しない。画像はatomic write、無効画像は既存file削除。今回保持しない有効IDのfileを整理し、version辞書変更時だけatomic保存 |
| dataURL | serverの正規化、version一致、画像読取/復号、MIME取得後にdata URLを返す。version不一致や未保存はnil |
| imageData | 不正ID/未保存はnil、読取失敗/不正画像はthrow。IDは1〜64文字、先頭ハイフン不可、小文字英数字とハイフンだけ |
| 途中失敗 | 複数fileとversionsを一括rollbackする処理はない。呼出元は失敗を受ける。通知拡張はその時の読取結果で元通知へ戻す |

## 購読・復元とAI利用

```mermaid
flowchart TD
  Store["AppStore所有BillingStore"] --> Server["GET /api/subscription<br/>本体状態・developer判定"]
  Server --> Apple["StoreKit currentEntitlements<br/>本人の購入・失効・更新状態確認"]
  Apple --> Access["entitlement / currentTransaction<br/>UIとAI利用判定・push署名へ"]
  Buy["SubscriptionView購入<br/>商品取得・setup完了を確認"] --> Transaction["StoreKit purchase / Transaction.updates"]
  Restore["復元<br/>AppStore.sync → 本人権利確認"] --> Transaction
  Transaction --> Verify["verified・対象商品<br/>権利再確認→POST /api/subscription/verify"]
  Verify --> Finish["応答statusを適用→transaction.finish<br/>応答errorはその後検査"]
```

根拠：[BillingStore](../../../../ios/BellBot/BellBot/Core/BillingStore.swift#L54)、[AppleSubscriptionAccess](../../../../ios/BellBot/BellBot/Core/AppleSubscriptionAccess.swift#L3)、[SubscriptionContent](../../../../ios/BellBot/BellBot/Views/SubscriptionView.swift#L12)。

| 操作・状態 | 契約 |
| --- | --- |
| 状態所有 | statusは本体、entitlement/currentTransactionはStoreKit本人権利、productは商品。operationとentitlementCheckは別。checking/active/inactive/unavailableを区別する |
| connect | 前の取引監視をcancel、status取得。developerは権利/取引/商品を消して通知callback。通常はupdates監視→本人権利取得→既存取引deliver。失敗はfailed/error/診断、監視中のdeliver失敗は監視を終了 |
| 権利取得 | 同時照会はentitlementTaskへ合流。verifiedで対象商品・purchased・非取消・非upgrade・有効期限/購読groupが必要。group status/renewalの署名を確認しsubscribed/graceだけ採用。失敗は権利/取引を消しfailed。取消後は値を適用しない |
| 有効判定 | grace期限があればそちら、無ければexpires。期限は現在より後だけ有効。developer/初期guide/本人有効権利のいずれかでpermitsAI。サーバーのentitledだけで本人の購入権利を作らない |
| AI利用の呼出し | AppStore.authorizeAIUseがBot ID・guide ID・setup.completeを判定。通常は本人権利を再取得してから許可。状態未確認は未確認エラー、権利無しは購読案内 |
| purchase | checking中は開始しない。商品・非developerを確認、status再読取、setup未完なら案内callback。successはdeliver後の権利で文言、pendingはApple承認待ち、userCancelledは追加文言なし |
| restore | 非developer・非checkingでsyncPurchases→権利→取引ありならdeliver。取引無しは有効購読無しの文言。deferでoperation解除。失敗はerror/診断 |
| recheck | `POST /api/subscription/refresh`→status適用→権利確認→本体error検査。自動POST再送はない |
| 通知との接続 | 権利の署名変化/失敗時にonEntitlementChange、AppStoreからBellNotifications.updateSignedTransactionへ。有効権利の時だけJWSを渡す |
| stop/logout | entitlementTask/updatesTaskをcancelし参照・status/権利/取引/商品/error/messageを消す。Appleの購入取消を行う処理ではない |

SubscriptionViewはloadSubscriptionで本体/商品/権利を確認し、購入/復元/再確認、購読管理Linkを接続する。価格はProduct.displayPrice。期限/猶予/自動更新停止、初期設定未完・未確認・失効を分ける。取引受付、verify応答、finish、本人権利の画面表示を同じ完了として扱わない。

## 端末保存とlogout

[保存物の表](state-and-sync.md#端末保存と後始末)を正本として参照する。今回確認した実コードでも、signOutはdraft参照をclearして辞書削除、会話page世代更新、編集/画像draft・削除待ち・通知要求/route・HTTP/WK cookieを削除する。接続先URL、conversationOpening、App Group画像、static画像cacheを全消去する呼出しはsignOutにない。changeServerはsignOut後にURL/baseURL・名簿/Owner/setup/settings等を消す。requireLoginは再認証のためdraftを残す。

## iPhone・iPad・Mac配置

| 入口・所有 | 配置・受渡し・後始末 |
| --- | --- |
| BellBotApp | App単位のStateObject AppStoreを全画面へ注入。Macは主WindowGroupとmember-editor WindowGroupで共有。RootViewはphaseからsetup/login/onboarding/ready/failureを選択 |
| iPhone BellTabs / HomeView | 会話/予定/goal/設定。会話はNavigationStack(path: chatPath)→ConversationView。プロフィールは[Views/ConversationDetailView.swift](../../../../ios/BellBot/BellBot/Views/ConversationDetailView.swift#L4)、端末は[Views/BotScreenView.swift](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L47)のsheet。接続errorは上部。通知秘密sheetはtabsの根 |
| iPad DesktopWorkspaceView | NavigationSplitViewの一覧/詳細＋inspector。compactColumnは選択とtabで変わり、compact幅でinspectorを閉じる。bot選択時に端末表示を戻す。編集は共通sheet |
| Mac DesktopWorkspaceView | 同じ選択・画面部品。Bot会話は会話/inspectorを等幅、roomはinspector固定280。主window最小1100×640。Bot編集は別window、roomはsheet |
| DesktopInspector | showingScreenは親のBinding、画像状態はStateObject。端末表示をembedded [BotScreenView（Views/BotScreenView.swift）](../../../../ios/BellBot/BellBot/Views/BotScreenView.swift#L47)へ切替え、戻るとプロフィール。ルーム参加者からchatPathを書き換える |
| MemberEditorWindow | Botを共有名簿から解決してBotEditor、見つからなければ不存在表示。geometry要求失敗は上部error。close callbackはdismissWindow |
| TabletWorkspace | このHEADで同名の製品Swift型/ファイルは無い。iPad配置はDesktopWorkspaceViewが持ち、TabletWorkspaceUITestsがその契約を確認する |

一覧の検索・並び・作成編集への接続は[メンバーとルーム](members-and-rooms.md)、詳細画像は[プロフィール](settings-and-profile.md)を参照。

## 整理候補

- **A-L1**：`ios/BellBot/BellBot/Views/ConversationImages.swift:186`の`conversationImageOrigin`と`ios/BellBot/Shared/BotAvatarCache.swift:94`。会話画像cacheは専用のorigin正規化、通知画像cacheはServerOrigin.urlを経由したorigin正規化を持つ。
- **A-L2**：`ios/BellBot/BellBot/App/BellBotApp.swift:201`と`ios/BellBot/BellBot/Views/DesktopWorkspaceView.swift:92`。通知秘密sheetと完了時eventRevision増加をtabsとworkspaceがそれぞれ接続している。

## 未調査

- APNs送付、通知登録台帳、購読verify/refreshとAI権限のサーバー内部。
- 実端末のSSE背景復帰・通知拡張期限・StoreKit購入/復元・複数window・App Group保存の動作と署名の実効値。ビルド・試験未実行。
- Mermaid描画結果。
