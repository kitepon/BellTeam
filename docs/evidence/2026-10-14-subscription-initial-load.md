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

## 配布状態

この記録の試験は修理ソースの隔離検証であり、TestFlight・App Storeへの公開、Mac・iPhone実機への導入、公開後の動作確認は含まない。
