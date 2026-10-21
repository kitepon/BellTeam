# Macのメンバー削除入口と配布差（2026-10-22）

オーナーの「Macアプリにボット削除機能がない」を、実機アプリ・共通ソース・配布物で照合した。実メンバーの削除要求は送っていない。

## 原因

このMacの`/Applications/BellTeam.app`はTestFlight署名の1.0.1（52）。実際に「メンバーを編集」の別窓を開くと削除入口は無かった。現行mainのDebug Mac Catalystアプリを`-bellbot-preview`で別起動すると、接続先はnil、メンバーは合成データとなる。その編集別窓を下までスクロールして「メンバーを削除」を確認し、押すと確認ダイアログが開いた。キャンセルしてプレビューアプリだけを終了した。画面の証拠は`runtime/apple/mac-delete-54/mac-debug-delete-visible.png`。

共通`BotEditor`の削除入口と`AppStore.requestBotDeletion`・`confirmBotDeletion`にはMac除外が無い。Macの`DesktopWorkspaceView`は`member-editor`窓へ開き、その窓も同じ`BotEditor`を使う。DELETEの202は受付で、成功した一覧再読取から対象が消えた時だけ画面と下書きを整理する。Mac固有の実装欠落は確認されず、端末の配布版との差と判定した。旧サーバーの`DELETE /api/bots/:id`は202後に席停止・ルーム参照除去・メンバー除去を行うコードがあり、10/20の担当者による隔離試験も成功済み。今回は再実行していない。

## 最近の機能の段階

| 項目 | 共通コードとMac候補 | Apple配布と端末確認 |
| --- | --- | --- |
| 修理53 | iPhone・Macのコードと署名済み成果物あり | 両OSの53は内部TestFlightで有効。Macの導入済み本体は52で、53の端末導入は未確認。 |
| メンバー削除54 | 共通コードにあり、Mac Debug画面で確認。54のMac署名成果物は当初無かった | iPhone54は内部TestFlightと本人の導入・ボタン確認済み。AppleにMac54 buildは無い。Mac端末は52。 |
| 個別停止の旧55 | 共通コード入りのiPhone IPA・Mac pkgが署名・事前検証済み | Appleへの55送信・端末導入なし。旧成果物はセッション終了方式で配布しない。 |
| 全体トグル・会話維持型中断 | 現行共通コードとMac Debugビルドにある。旧55成果物には入らない | 新方式の署名済み成果物とApple配布なし。Aitermの実runtime受入前なので配布対象にしない。 |

通知登録と通知拡張はMac Catalystにも共通のコードがある。iPhoneで観測した通知登録時間切れは、その端末の診断でありMac機能欠落の証拠ではない。Macの別窓やファイル選択はUI基盤に合わせた差として維持する。

## 削除だけのMac候補

配布候補の元ソースは`00af6866523b8f4dd3a9d5523464f322e9c94c16`（1.0.2、54）。53の修理と共通削除は祖先にあり、旧個別停止・全体トグル・会話維持型中断はまだ含まない。`origin/main`の祖先でもある。専用作業ツリーからMac Catalyst archiveとpkgを作り、署名とApple事前検証を終えてから成果物単位の決裁箱GOを求める。Mac1.0.1（52）の審査を変更せず、実メンバーDELETEもしない。TestFlight送信後の正規導入とボタン表示・確認キャンセルは別の受入工程とする。

候補は`runtime/apple/mac-delete-54/mac-54.xcarchive`と`runtime/apple/mac-delete-54/mac-export/BellTeam.pkg`。archive内の本体・通知拡張はいずれも1.0.2（54）で、アプリの`codesign --verify --deep --strict`が成功した。pkgもApple発行のInstaller証明書による署名を確認した。pkgのSHA-256は`d1b83e652cd61b3bc92416c057eb61ad7d16c429bfc0f6ef55e0c884ea1bed1b`。Apple公式`altool`事前検証は`No errors validating archive`で成功した。事前検証はAppleへの送信や配布成立を意味しない。AppleへのMac54のアップロードはまだ行っていない。
