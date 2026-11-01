# Webの編集・画像・Goal

[会話Web](web-details.md)に加え、各画面が開いた対象と非同期結果をどう持つかを示す。本branchの実装を説明し、最終照合で見つかった不足は[追加修理](web-final-gaps.md)へ分ける。Apple単独UIの設計ではない。

## 編集対象は各画面が持つ

```mermaid
flowchart TD
  Open["編集画面を開く"] --> Target["その画面が対象を保持<br/>フォームとavatarを初期化"]
  Target --> Edit["未保存の入力を編集"]
  Edit --> Submit["保存対象とbody<br/>その時の入力版を固定"]
  Submit --> API["機能固有のAPIへ一回保存"]
  API -->|"成功応答"| Saved["受付を記録<br/>新規作成なら返却IDを保持"]
  Saved --> Refresh["appへ一覧更新を依頼"]
  Refresh --> Current{"同じ画面かつ<br/>入力が変わっていないか"}
  Current -->|"はい"| Show["対象を選択 / 編集画面を閉じる"]
  Current -->|"いいえ"| Keep["新しい画面と入力を保持"]
  Refresh -->|"失敗"| ViewError["保存済みと表示<br/>新しい作成を自動発行しない"]
  API -->|"失敗"| Error["元の画面へエラー"]
```

| 機能 / app側caller | 実装と主な関数 | 所有・保存後の結果 |
| --- | --- | --- |
| Bot作成・編集 / `openBotDialog` | [bot-editor.js](../../web/bot-editor.js) `createBotEditor/open/saveBot` | owner.bot、saving、editRevision、avatar。保存時target/bodyを固定。成功後の一覧GET失敗でも返却Bot IDを保持し次の手動保存はPATCH |
| Botモデル・適用表示 / editor.open | 同上 `renderModelOptions/selectableEfforts/renderEffortOptions/renderBotConfigurationStatus` | models/AbortController。close/reopenで旧読取をabort。保存済み候補外effortは表示に残す。configurationApplicationと希望設定を区別 |
| Bot再起動・削除 / editorのbutton | 同上 `restart/remove` → appの`onRestarted/onDeleted/onStatus` | 操作時Botを固定。再起動202と削除202は背景受付。appが一覧・選択を更新する。削除失敗文の受付/完了表現は追加修理対象 |
| 部屋編集・削除 / `openRoomDialog` | [room-editor.js](../../web/room-editor.js) `open/saveRoom/remove/renderRoomRepresentativeOptions` | owner.room、参加者、代表、avatar。代表は選んだ参加者内。保存対象/bodyと再open後の結果所有を保持 |
| Ownerプロフィール・規範 / `openOwnerDialog` | [owner-editor.js](../../web/owner-editor.js) `open/save/renderOwnerLinkRows/addOwnerLinkRow` | 開いたprofile、入力版、saving、avatar。profile PATCH→rules PUTは別要求。部分成功を表示し自動再発行しない |
| 任意機能・公式認証 / Owner.open | 同上 `refreshFeatures` → 既`renderFeatureSettings/renderHarnessAuth` | openごとの子DOM。closeでpassword欄を空にしauth pollを停止。閉じても公式認証状態そのものを取消さない。設定保存後callbackの所有には追加修理が必要 |
| 記憶・知識 / Bot editor→`onMemory` | [memory-view.js](../../web/memory-view.js) `open/write/search/renderResults` | 対象Bot、form別pending、resource別最新read。bodyとscopeを固定。保存後も新入力を消さず検索は同じ画面の最新結果だけ描く |
| 予定 / `openScheduleDialog` | [schedule-editor.js](../../web/schedule-editor.js) `open/loadSchedules/saveSchedule/editSchedule/resetScheduleForm` | type/id/name/memberIds、editingSchedule、read/edit版。保存後GETと受付を分離。run/removeはrow作成時対象、2.5秒timerは表示だけ |
| 予定の値変換 / editorの読取・保存 | 同上 `scheduleFormValues/scheduleRequest/localDateTimeValue/scheduleDescription` | once/cron/interval/timezoneを維持。roomではcommandを作らず、targetsは開いたmemberIdsから選ぶ |
| 部屋返信者 / appの選択 | app `selectedTargets/renderTargetPicker/renderTargetButton` | room別Setはページ内。退会者を除き、未選択nullと自動選定の可否を区別。投稿は全員へ配送 |
| native画面 / `openScreen/closeScreen` | [bot-read-views.js](../../web/bot-read-views.js) `createScreenView/open/refresh/close/fit` | 対象・最新読取・2秒timer。初回GET待ち中closeからtimerを復活させず、80桁表示を維持 |
| 設定画 / Bot editor→`onSheets` | 同上 `createCharacterSheetView/open/release` | 開いたBotとURL集合。close/reopen後の画像は適用せず、途中失敗で作成済みURLを解放 |

機能ごとにAPI・検証・保存順・完了時点が違うので、汎用CRUDやtransactionにまとめない。共通avatar/表示関数を使い、appから全stateを渡す接続も作らない。

## Ownerは二つの保存結果を区別する

```mermaid
flowchart TD
  Input["プロフィールと規範の入力"] --> Snapshot["操作時の両方のbodyを固定"]
  Snapshot --> Profile["プロフィールPATCH"]
  Profile -->|"成功"| Header["appへ保存したプロフィールを返す"]
  Header --> Rules["規範PUT"]
  Rules -->|"成功"| Current{"同じ画面・同じ入力版か"}
  Current -->|"はい"| Close["閉じる"]
  Current -->|"いいえ"| Keep["新入力を残す"]
  Rules -->|"失敗"| Partial["プロフィールは保存済み<br/>規範の失敗を表示"]
  Profile -->|"失敗"| Failure["保存結果を確認できない<br/>再発行しない"]
```

`onOwner`はプロフィール保存応答を一覧ヘッダへ返す。後段の規範失敗をプロフィール未保存へ戻さない。HTTP応答が失われた場合は、サーバーに何も保存されていないとは断定しない。

**現時点の不足**：open時の規範GETを待たずsaveが可能なため、未読の空欄をPUTできる。また任意機能の保存後に全フォームを描き直し、別機能や開き直した画面の新入力を消す。図は二段階保存の実装済み部分を示し、読取完了条件と任意機能の結果所有は[追加設計](web-final-gaps.md)で修理する。

## 画像の所有者がURLを片付ける

```mermaid
flowchart TD
  File["選んだ画像"] --> Avatar["各avatar editor<br/>decode世代・crop・JPEG"]
  Avatar --> Profile["profile APIへ値を渡す"]
  File --> Draft["composerの下書きURL"]
  Draft --> Flight["送信中snapshot"]
  Flight -->|"失敗"| Recover["元下書き / 回収欄へ所有を移す"]
  Flight -->|"受付"| Release["入力URLを解放<br/>data画像を履歴cacheへ"]
  Stored["履歴の画像URL"] --> Cache["messageImages<br/>同ID取得を共有・所有URLを保持"]
  Sheets["設定画の一覧"] --> SheetView["設定画viewがURLを所有"]
  Cache --> Viewer["viewerは表示だけ<br/>借りたURLを解放しない"]
  SheetView --> Viewer
  Cache --> Exit["ページ終了で解放<br/>BFCache時は保持"]
  SheetView --> End["close・reopen・失敗で解放"]
```

| 部品 | 実関数と責任 |
| --- | --- |
| [avatar-editor.js](../../web/avatar-editor.js) | `createAvatarEditor/reset/value/changed/cancelRead`。各3editorの別instance。`readFile`はdecodeの世代を確認しURLをfinallyで解放。`zoomImage/startDrag/moveImage/endDrag/clamp/draw/syncPreview`はcropだけを更新 |
| composer | `addImages/paint/send/renderRecovery`。FileとURLは下書き→送信→回収へ移す。受付・破棄・添付削除で解放。失敗した旧画像と新入力の画像を混ぜない |
| messageImages | `remember/read/load/close`。同IDのfetchを共有し、複数画像の途中失敗も全完了を集めて不要URLを解放。旧fetchは新data previewを上書きしない |
| timeline | `loadStoredMessageImages/rerenderItem`。cacheを読むだけ、同tokenのDOMだけ更新。`avatarColor/rgbToHsl`は局所の色cacheで、台帳を更新しない |
| [image-gallery.js](../../web/image-gallery.js) | `renderImageStack/openImageViewer/stepIndex`。URL配列と現在index、矢印/swipe/alt。closeでsrcを外すがURLの生成者ではない |
| [rich-text.js](../../web/rich-text.js) | `richTextHtml/renderBlocks/renderList/renderTable/inlineHtml`。本文をescapeし対応Markdownと既linkifyだけをHTML化 |
| [view-format.js](../../web/view-format.js) | `applyAvatar/dayLabel/initials/memberDisplay/formatTime/formatDateTime/escapeClass/escapeHtml`。表示値の変換を共通化。台帳・選択・APIを読まない |

cacheの差替え前URLはviewerが使い得るためページ終了まで保持する。pagehideのpersisted=trueではBFCache復帰を妨げない。これは永続画像保存や全端末のcache管理ではない。

## Goal画面はnativeの観測を表示する

```mermaid
flowchart TD
  Get["一覧取得 / 選択Bot取得"] --> Revision["Botごとの観測revisionを進める"]
  Revision --> Read["GETでsnapshotを取得"]
  Read --> Current{"まだ新しい観測か"}
  Current -->|"はい"| Render["capabilityとbindingから表示"]
  Current -->|"いいえ"| Ignore["古い返却を適用しない"]
  Render --> Draft["編集文と元bindingを保持"]
  Draft --> Post["同じBotの変更は一件だけPOST"]
  Post -->|"confirmed"| Clear["そのdraftを除く"]
  Post -->|"不明 / 通信異常"| Observe["再POSTせずGETで現在を確認"]
  Observe --> Render
```

[goals.js](../../web/goals.js)の`goalsView`がsnapshots/pending/drafts/observationsを閉包に持つ。一覧revisionとBot別revisionは違う用途で、他Botの新しい変更結果を古い一覧で消さない。`refreshSelected/select/refreshOnEvent`がappの窓口。

`mutate`はBotとbindingを固定し、失敗時は一回GETだけ。finallyも同bindingの場合だけ照合し、別thread/unknownを古い結果で置換しない。combined=falseなら目的と予算を別々に編集し、空予算を消去へ変換しない。Goal・秘密・質問・認証は既存専用部品をそのまま使う。

確認先：editor-ownership、web-bot-avatar-list、bot-profile-ui、schedule-list/intervals、memory-view、bot-read-views、goals各試験。実dialog DOM＋人工APIで保存中の再open/部分成功も確認した。一方、一覧・未読規範・任意機能の追加反例は未修理。局所の成功を全体の完成へ広げない。
