# BugHub未解決事象のアプリ側修理（2026-10-18）

対象はトロニーの通話seq101で指定されたアプリ側の会話GET、予定GET、一覧GET、GET/POST切断、POST 500、events 502、購読GET、旧会話500/502。過去の発生原本と当時の画面操作は、既存の[`2026-10-15-bughub-seven-app.md`](2026-10-15-bughub-seven-app.md)と登録側の棚卸しを区別する。今回の合成試験が過去の通信原因を証明したとは扱わない。

## 今回再現して修理した3点

| 条件と修正前の実測 | 修理 | 修正後の実測 |
| --- | --- | --- |
| 会話GETを保留中にiPhoneアプリを背景へ移すと、1秒後も模擬サーバー側の接続が開いたまま。既知会話は表示されたまま。`runtime/bughub-conversation-red2.xcresult`の対象UI試験がこの条件で失敗。 | 会話画面の読取Taskを保持し、背景・画面離脱で取消す。読取完了時にも取消を確認して古い結果を反映しない。送信POSTは取消対象にしない。 | 同じ模擬サーバーとiPhone Simulatorで、保留GETの閉鎖、既知会話保持、前面復帰時の再取得を確認。`runtime/bughub-conversation-fixed.xcresult`の対象UI試験1件成功。 |
| 送信POSTにHTTP 500を返すと、診断は結果未確定だが、画面用文言には再操作前の状態確認が無かった。`runtime/bughub-http500-red.xcresult`の対象試験が案内文2条件で失敗。 | HTTP 5xxの操作失敗文に、現在の状態を更新して確認する案内を加える。POSTは自動再送せず、既存の入力・画像復元を維持。 | `runtime/bughub-http500-fixed.xcresult`の対象試験1件成功。POSTは1回、診断は`result_unconfirmed`。 |
| 既知の有効なApple購読がある状態で購読画面の`GET /api/subscription`が時間切れになると、画面状態が`unavailable`へ落ちた。`runtime/bughub-billing-red.xcresult`の対象試験が`active`期待で失敗。 | 有効期限内のApple権利を表示判定で優先し、GET失敗のエラー表示は保持。初回未確認や権利が無い状態を利用可能にしない。 | `runtime/bughub-billing-fixed.xcresult`の対象試験1件成功。既知の有効権利表示、失敗表示、GET 2回を確認。 |

## 指紋ごとの判定

| 指紋 | 今回のアプリ側結果と残条件 |
| --- | --- |
| `c882af7b` 会話GET時間切れ | 背景中に会話GETが残るアプリ欠陥を隔離再現して修理。過去の各-1001の通信根因や実画面での復帰は未確定。 |
| `8988b6a2` 予定GET時間切れ | 背景取消、既知予定保持、手動再取得、初回取得失敗表示は既存試験で確認済み。今回の個別GET時間切れの根因は未確定で、追加の値丸め・再試行はしない。 |
| `eb39292e` 一覧GET時間切れ | 既存一覧保持、GET成功後の古いエラー消去、背景移行時の前面復帰GET取消は既存試験済み。今回のGET時間切れの根因と実画面は未確定。 |
| `95656cbb` 会話GET/POST切断 | 10/16の5件目はGET・背景・attempt2。10/17の6件目（最新、累計6）はiPhone版52の会話POST・active・attempt1で、`-1005`／`result_unconfirmed`。GETの1回取り直しとPOSTの自動再送禁止・入力保持はコードと既存隔離試験で確認済み。6件目の本体受付・保存・配送、実画面での保持と復帰、根因は未確定。 |
| `b8386a56` 会話POST 500 | アプリはHTTP 500時の結果確認案内を今回修理。サーバーでの受付・処理結果と根因はサーバー担当の確認待ち。旧発生の一括解決根拠にはしない。 |
| `cb3506c0` events 502 | SSEの再接続表示・再接続後の通知と表示消去は既存隔離試験済み。旧事象の利用者影響・復帰とトンネル外の根因は未確定。 |
| `5e6c5a31` 購読GET時間切れ | 保存診断の`subscription_error_shown`はBillingStoreの購読状態GETを指す。一般設定Editorの別欠陥と分ける。初回未確認の案内は既に修理済みで、今回、既知の有効なApple権利表示が後続GET失敗で消える欠陥を修理。 |
| `522e820f` 旧会話500 | 保存済み版41のPOST 500と版40のGET 502を区別する。今回のPOST 500案内は前者の現行UI経路に適用。初回GET失敗の空表示は既存修理済み。全16件の原因・影響・修理成功は認定しない。 |

`95656cbb`の6件目は中央受信10/17 09:38:58.689 JST。根拠はトロニー席の`docs/bughub-sixth-95656cbb-20261017.md`と`integrations/bughub-sixth-95656cbb-20261017/assessment.json`。5件目GETの条件を6件目POSTへ流用しない。

修理コードはまだ配布済みのMac/iPhone版52へ入っていない。App Store Connectの両platform 1.0.1（52）は審査待ちで、提出・TestFlight導入・本人端末操作は今回変更していない。既存BugHub原本の指紋・累計・状態・重大度も変更していない。

最終の会話背景取消UI試験は`runtime/bughub-conversation-final.xcresult`で再確認した。iOS Simulatorの修正3条件はそれぞれ成功し、Mac Catalystのアプリ本体ビルドも成功した。`TESTGATE_FULL=1 npm test`は終了コード0。新しい実機通信障害を起こす試験、版52の差し替え、本番反映は行っていない。

## 配布候補53

修理commit `cf38bf2`の後、アプリ本体と通知拡張のビルド番号だけを`c7dcc5ee94fe2c298340a9cf3bf26b28675b336b`で53に揃えた。両platformのマーケティング版は1.0.1のまま。`runtime/apple/bughub-app-53/`へiPhone archive・IPAとMac Catalyst archive・pkgを作成した。

| 成果物 | SHA-256 | 確認 |
| --- | --- | --- |
| `ios-export/BellTeam.ipa` | `5a72d0c60818a25e1a64d720c2386be6a22e100fe182c067b85864450afe5301` | 展開した本体・通知拡張が53。配布署名を`codesign --verify --deep --strict`で確認。 |
| `mac-export/BellTeam.pkg` | `9f68b89806a13d0b39c771e0e8b5b429848bc699a8fc21e9ba1ee16b86917650` | archiveの本体・通知拡張が53。アプリ署名とpkg署名を確認。 |

Appleの公式`altool`事前検証はIPA・pkgとも`No errors validating archive`。事前検証だけの時点では送信・Appleでの処理・内部配布の成功を意味しないため、両platformの内部TestFlight送信を次の承認対象として分けた。一般公開用のApp Store提出は別工程とする。

10/18、決裁箱「修理版53をMac・iPhoneの内部TestFlightへ送信してよい？」のGOを受け、検査値とmain祖先を再確認して両成果物をApple公式`altool`で送信した。iOS build `dfd08fe7-56c7-4a8f-b5c5-410479fadf81`、macOS build `1f9a2940-db00-4cee-bf1a-61a825054ef6`は共に`VALID`。オーナー用内部グループ`58133050-1c39-4915-b6da-aac18b95921b`へ追加した後、それぞれ`IN_BETA_TESTING`をAPIで再読取した。端末での版53導入・起動は未確認。App Store審査対象の52はiOS `WAITING_FOR_REVIEW`、macOS `IN_REVIEW`で、こちらから差し替えていない。現行配布状態の構造化記録は`docs/subscription-setup.json`の`integration.bugHubAppRepair53`を参照。
