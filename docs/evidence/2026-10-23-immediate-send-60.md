# 送信した本文の即時表示 — Apple版60

出典: オーナーのiPhone画面とトロニーの通話92〜94、`ConversationView.send`、隔離HTTP fixtureのiPhone Simulator試験。取得日: 2026-10-23。確度: コードと人工通信で再現した表示経路は確認済み。配布後の実機体感は別途確認する。

## 原因と修理

送信前のコードは入力欄を空にしてからHTTP応答を待ち、続く履歴GETで初めて本人の本文を会話へ置いた。トロニーの本番ログでは3件のPOSTが1,544〜1,950msで返る一方、最初の2件の履歴記録は開始から56/64msで終わっていた。本文はサーバーへ記録済みでも、その間iPhone画面へ出なかった。隔離fixtureでPOSTの応答を保留すると、修理前のUI試験は本文未表示で失敗した。

修理後は送信を押した時点で本文と画像枚数を会話末尾に「受付確認中」として表示する。サーバー履歴の通知がHTTP応答より先着しても仮行を二重に並べず、直接会話の`delivery_id`またはルーム発言の`id`を応答から受けた後、該当する正本の行へ置き換える。履歴取得が一時的に失敗した時は仮行を「受付済み・反映待ち」として残す。受付を確認できない失敗では仮行を外し、送信中に書き足した下書きを保ちながら元の本文・画像を入力欄へ戻す。本文の自動再送はしない。

変更ファイル: 会話の表示・突合は`ios/BellBot/BellBot/Views/ConversationView.swift`、応答IDの読取は`ios/BellBot/BellBot/Core/BellAPI.swift`と`Models.swift`。試験は`ios/BellBot/BellBotTests/NetworkRecoveryTests.swift`、`ios/BellBot/BellBotUITests/NetworkLifecycleProbeUITests.swift`、`test/fixtures/bughub-ui-probe.mjs`、`test/helpers/network-lifecycle-server.mjs`。版番号は`ios/BellBot/project.yml`、本体と通知拡張の`Info.plist`を更新した。

## 確認

- 修理前: 人工POST保留時、送信した本文が会話へ出ず、専用UI試験が失敗。
- 修理後: 同じ試験で、HTTP応答とSSE通知の順序を入れ替えても「受付確認中」の本文を一件だけ表示。待機中の追加入力、応答後の既存IDへの置換、下書き保持を確認。
- 失敗時の本文・画像復元と結果不明の案内を既存UI試験2件で確認。直接会話とルームの応答IDを単体試験で確認。20秒保留する背景送信試験1件が成功。
- Mac Catalyst Debugビルド成功。Nodeの全686試験が成功。版60のiPhone Simulator最終UI試験2件も成功。

Appleの共通コードと試験fixtureだけを変更した。サーバー本体と本番コンテナには変更していない。実機でのフレーム停止時間は計測していないため、約1秒の体感がどれだけ短くなったかは配布後の確認で判断する。

## 配布と導入後確認

修理と版60のソースは`c433151f0481f41705562a94ea327c41a2fb7e9c`でGitHub `main`へ通常pushした。アーカイブ時にAppleソースの未commit差分は無く、同commitは`origin/main`の祖先だった。本体と通知拡張の両方が`1.0.3 (60)`で、iOS・Macアーカイブの厳格な署名検証に成功した。IPAとpkgのApple公式事前検証はそれぞれ成功した。

| 成果物 | SHA-256 | Apple build ID | 状態 |
| --- | --- | --- | --- |
| iPhone・iPad用`runtime/apple/send-immediate/ios-export/BellTeam.ipa` | `e89cb3c033a548fcd48e06c9d907b61f0539f2264fabe3c6db330294cb3101ad` | `5fbaf201-1bb5-40f4-96f6-5ecd5c1111a9` | `VALID`、オーナー用内部グループで`IN_BETA_TESTING` |
| Mac用`runtime/apple/send-immediate/mac-export/BellTeam.pkg` | `9f5c92ae9d143697a683bbe6dc4dc73b9556334faf68190ca93ece42dde4d2b8` | `d3a30685-5aa3-4aa8-9721-7e9cfb170fae` | `VALID`、同グループで`IN_BETA_TESTING` |

MacではTestFlightが版60と「アップデート」を表示したことを確認して導入した。`/Applications/BellTeam.app`本体と通知拡張は60で、厳格な署名検証とGatekeeperの`source=Testflight`判定が成功した。通常起動してトロニーの直接会話を開き、入力欄へ試験文字を物理入力すると送信ボタンが有効になり、全消去で無効に戻った。試験文字は送信していない。確認のために起動したアプリと専用Simulator・隔離HTTP fixtureは終了した。iPhone実機の表示速度と操作感はオーナーの確認待ち。
