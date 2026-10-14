# 初回購読確認失敗時の案内修理

## 対象と原因

Appleアプリの初回 `GET /api/subscription` が失敗すると、`BillingStore.status` は `nil` のままになる。従来の `requirePaidAccess` は、StoreKitの利用権も無ければ、サーバーの区分が未確認でも「月額購読が必要」と返していた。開発者区分のサーバーでも誤った案内になる。送信画面は権利判定を通ってから入力を消すため、拒否時の下書きは残る。

修理後は未確認と確認済み未購入を分ける。未確認でStoreKitの有効な利用権も無い時は、有料操作を止め、「購読の状態を確認できませんでした」と設定の再確認手段を表示する。購読画面の「再確認」は、区分が未確認ならGETをやり直す。既知の区分は通信失敗後も保持する。API、サーバー、実課金の処理は変更しない。

## 隔離環境の実測

`BillingStoreTests` の模擬 `URLProtocol` は、購読GETへ時間切れまたは指定した区分を返す。実サーバーへの接続・実課金・確認前POSTの再送は行わない。

| 確認 | 結果 |
| --- | --- |
| 修正前再現 | iOS Simulatorで11件を実行し、初回GET失敗時の案内を検査する1件の3つの断言が失敗。「月額購読が必要」が返ることを確認した。ほか10件は成功。 |
| 修正後 | 同じテストクラス15件がすべて成功。初回失敗時は未確認を案内し、下書きは残り、送信POSTは0件。 |
| 再取得後 | 開発者・StoreKit有効購読・確認済み未購入の各経路を模擬して判定。開発者の再取得は購読画面が使う `loadSubscription`、購読2経路は同じGET処理の `refreshFromServer` で確認した。 |
| 既知状態の後のGET失敗 | 開発者・有効購読・確認済み未購入の判定を確認した。 |
| Apple確認の失敗 | サーバー区分も未確認なら未確認案内を返し、有料操作は許可しない。 |
| Mac | 同じSwift共通コードのMac Catalystビルドに成功。Mac実画面での操作は未確認。 |

試験は署名を切ったiOS 26.5のiPhone 17 Pro Simulatorで実行した。前回の別の14件の試験では13件成功、1件は署名を切ったためApp Groupを使えず失敗している。このApp Group失敗は今回の購読案内の失敗や修理結果に含めず、署名条件を揃えた確認も今回行っていない。iPhone実機の通信障害と、修理版の実機表示・入力操作は未確認。

## 3 OS × 4ハーネスの適用

| OS | Claude Code | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| macOS | 共通Apple UIを適用 | 共通Apple UIを適用 | 共通Apple UIを適用 | 共通Apple UIを適用 |
| Linux | 対象外：Apple UIなし | 対象外：Apple UIなし | 対象外：Apple UIなし | 対象外：Apple UIなし |
| Windows | 対象外：Apple UIなし | 対象外：Apple UIなし | 対象外：Apple UIなし | 対象外：Apple UIなし |

macOSの4欄は同じ `BillingStore` と `SubscriptionView` を通る適用範囲を示し、4ハーネスの実画面試験を示すものではない。WindowsアプリとWebにはStoreKit購読UIがなく、LinuxにはAppleアプリがない。共通APIの変更はない。

iOS（iPhone・iPad）も同じSwift実装を使い、ハーネスに依存しない。iPhone 17 Pro Simulatorで購読のfocused test 15件を確認した。iPad固有の画面と4ハーネス別の実機試験は未実施。

## 配布と導入

修理ソース `0c903a4` にビルド番号49の変更を加えた `817da14` をGitHubのmainへpushした。Mac・iPhoneの署名付きアーカイブ、配布用pkg・IPAの書き出し、Appleの事前検証に成功した。両OSの本体と通知拡張は49で揃う。Appleの処理は両方 `VALID`、オーナー向けTestFlight内部配布は `IN_BETA_TESTING`。App Storeの一般公開は行っていない。

MacはTestFlightから `/Applications/BellTeam.app` を49へ更新した。Gatekeeperの出所は `Testflight`、アプリを通常起動し、実行ファイルと通知拡張の49を確認した。別に作り物データを使うDebugアプリで、模擬 `GET /api/subscription` の503後に「購読の状態を確認できませんでした。再確認してください。」が表示されることを画面で確認した。「再確認」を押すとGETを再取得し、200の開発者区分で「開発者として利用中」へ変わった。模擬サーバーとDebugアプリは停止し、通常のTestFlight版49を再起動した。

iPhone版49は内部配布済み。実機はこのMacから `unavailable` のため、本人にTestFlightでの更新・起動を依頼して回答待ち。端末上の導入と画面表示は未確認。
