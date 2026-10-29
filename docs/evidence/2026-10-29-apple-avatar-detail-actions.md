# Appleプロフィール詳細からの画像変更・調整

オーナーは、既存メンバーの大画像・小画像を各表示領域のタップ/クリックから変更し、両方で同じ「画像変更」「画像調整」を選ぶよう指定した。新規メンバーは詳細画面がまだ無いため、作成フォームの画像入口を残す。既存メンバーの編集フォームから画像入口を外した。

共有`BotProfileHero`の大画像と左上の小画像は別ボタンで、アクセシビリティIDを`profile-large-avatar`/`profile-small-avatar`とした。各ボタンから同じ操作シートを開く。変更は既存`AvatarImagePicker`から既存`AvatarCropEditor`へ進み、調整は対象の保存済みsource/cropを取得して同editorへ進む。大画像が小画像に追従中なら、現在の小画像を大画像の調整元に使い、保存時に独立した大画像を作る。元画像が無ければ現在のrenderを調整し、切り抜き外側を復元できない旨を表示する。GET失敗・旧schema・画像の復号失敗は画面に表示する。

保存は既存`BotSettingsRequest`の選択画像tripletだけをPATCHする。応答喪失時はGETで対象画像の3項目を確認し、未確認なら選択結果を保持して手動確認を示す。別画像とプロフィール文面は送らない。編集・調整の取消は保存呼出しへ進まない構成とした。新しいHTTP APIや別の切り抜きeditorは追加しない。

## 実測と未確認

- iOS Simulator Debug buildは終了0。`BotSaveTests`の関連15件は成功・失敗0。大小のimage-only encoder、各対象の応答喪失後GET確認、反対画像を保持する試験を含む。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T03-02-04-298Z_pid49890_56f98333.xcresult`。
- 人工iPhoneプロフィールから小画像の調整・保存UI試験1件成功。PATCHは小画像のrender/source/cropだけ1回で、大画像は不変。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T03-03-18-382Z_pid49890_5822e9f8.xcresult`。
- 人工iPhoneプロフィールから大画像の調整・保存UI試験1件成功。PATCHは大画像のrender/source/cropだけ1回で、小画像は不変。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-29T03-04-14-262Z_pid49890_89c5a20e.xcresult`。
- 取消と重なりを合わせたiPhone UI試験は、製品の処理前にSimulatorがXCTest runnerの起動を`SBMainWorkspace Busy (Application failed preflight checks)`で拒否した。元Simulatorで2回、別の同iOS版iPhoneで1回同じ拒否。試験本体は未実行で、取消UIとiPad/Macの実画面は未確認。iOS・Mac Catalyst Debug buildは終了0。人工serverとSimulatorは終了を確認した。
- 完了時のNode全試験は`TESTGATE_FULL=1 testgate run -- npm test`で1回実行して終了0。SwiftUIの取消UI未実行をこの結果で代用しない。

この差分は版73の署名済みsource・TestFlight配布へ含めていない。実Owner画像、実Bot、認証、本体コンテナは操作していない。
