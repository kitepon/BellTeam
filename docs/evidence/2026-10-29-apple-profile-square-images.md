# Appleプロフィール画像の正方形化

オーナーはMac・iPhoneのBotプロフィール大画像を、設定時から縦横同寸で使い、iPhoneで重ねる小画像を従来の半分にするよう指定した。大画像はMac・iPhone・iPadで同じ画像と切り抜きデータを使うため、共通の`1024×1024`切り抜きと正方形表示にした。iPhoneの小画像は`176pt→88pt`、Macの`152pt`とiPadの`176pt`は維持した。Webの表示と画像APIは変更していない。

既存の横長`1024×512`切り抜きは保存済み画像を変更せず、正方形の表示領域で中央を表示する。元画像が残っていれば、再調整時に旧切り抜きの中心を保って正方形の編集枠を開く。元画像が無い既存画像は、従来どおり切り抜き外側を復元できない。

## 実測

- `AvatarImageTests` focused 5件成功・失敗0。旧横長cropの中心を正方形へ復元する試験を含む。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-02-01-991Z_pid49890_85f6a108.xcresult`。
- iPhoneの人工プロフィールUI試験は1件成功・失敗0。[表示](images/2026-10-29-apple-square-profile-iphone.png)で大画像が正方形、小画像が88ptと確認。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-03-41-023Z_pid49890_711cbd59.xcresult`。
- iPhoneの人工大画像編集UI試験は1件成功・失敗0。[編集画面](images/2026-10-29-apple-square-crop-iphone.png)で切り抜き枠が正方形と確認。大画像のrender/source/cropだけをPATCH 1回で送り、正方形cropを保存し、小画像を変更しない。XCResult: `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T23-06-06-022Z_pid49890_1ff9ee28.xcresult`。
- Mac Catalyst Debugを隔離bundle `dev.kitepon.bellbot.squareprobe`でビルド・起動。[人工プロフィール](images/2026-10-29-apple-square-profile-mac.png)で大画像が正方形と確認。隔離アプリと人工serverは終了し、iPhone Simulatorも停止を確認した。

この差分の署名・TestFlight配布・実Bot画像の変更はまだ行っていない。
