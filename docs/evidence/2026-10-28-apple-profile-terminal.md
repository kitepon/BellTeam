# AppleプロフィールとBOT画面の改善候補

Mac・iPhone・iPadのプロフィールに、横幅いっぱいの大画像と左上の小画像を置いた。未設定の大画像は現在の小画像を表示する。ハーネス・希望モデル・希望エフォートとBOT画面・会話セッション操作を役職より上にまとめ、iPhoneの既存sheetとiPadの既存inspectorは維持した。各一覧の検索欄には、入力中だけ右端に全消去ボタンを出す。[Macの人工画面](images/2026-10-28-apple-profile-mac-preview.png)、[iPhoneの人工画面](images/2026-10-28-apple-profile-iphone-preview.png)、[iPadの人工画面](images/2026-10-28-apple-profile-ipad-preview.png)。オーナーの私有参考画像はrepoへ収めていない。

小画像の既存`avatar`は維持し、大画像`avatarLarge`と、それぞれの未切抜き`avatarSource`・`avatarLargeSource`、画像座標の正規化矩形`avatarCrop`・`avatarLargeCrop`を独立編集する。新しい画像はrender/source/cropを同じPATCHへ入れる。変更していない画像fieldはPATCHに含めず、別端末の更新を上書きしない。既存の元画像が無い場合は切り抜き外側を復元できない旨を表示する。既存サーバーで新fieldが確認できない間は新画像編集を無効にし、通常の文面保存は続ける。画像のHTTP契約はRootの`docs/profile-avatars.md`を正とする。

BOT画面は黒背景・白の等幅文字とし、表示中の対象だけ1秒ごとに取得する。対象切替、画面を閉じる、アプリが非アクティブになる時にtaskを止める。同じsnapshotは追記せず、取得した本文へ置換する。末尾を見ていれば追従し、過去を読んでいればスクロール位置を保つ。[Macの人工BOT画面](images/2026-10-28-apple-terminal-mac-preview.png)。現本体の直近25行snapshotは履歴全体の根拠ではない。Aitermの実scrollbackとlive paneをRootが供給する契約の確認待ちであり、存在しない過去ログは合成しない。

## 人工検証

- 小・大の正規化crop矩形をそれぞれ復元でき、別端末で変わった画像を文面保存が上書きしないfocused unit2件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T12-53-28-892Z_pid49890_d6d0307b.xcresult`。
- 変更した画像・保存・terminal表示の関連unitは最終確認17件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T13-33-07-794Z_pid49890_601c36ea.xcresult`。
- iPhoneは検索消去、既存詳細sheetのAI・役職表示、BOT画面の1秒更新・同snapshot非重複・close後poll停止を人工APIで1件成功・失敗0。スクロール位置の単体確認も1件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T13-28-35-712Z_pid49890_cc343564.xcresult`。
- iPad Pro 11インチ/iOS 27.0は検索消去後、既存inspectorを開いて大小画像・AI操作・役職を実画面全体とAXで確認した。画面添付には別表示面のinspectorも写す`XCUIScreen.main.screenshot()`を使った。最終focused1件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T13-25-29-210Z_pid49890_3a923776.xcresult`。
- Mac Catalyst Debugの隔離bundle `dev.kitepon.bellbot.profileprobe`はビルド・起動成功。人工Botプロフィールの幅広い大画像・左上小画像・AIの位置を実画面で確認。大画像cropのsliderを物理操作で0から0.5へ変え、PATCH1回が大render/source/cropだけを含み小renderを送らないこと、再度編集してslider0.5が戻ることを確認した。隔離アプリは通常終了しPID消失を確認した。
- 隔離MacのBOT画面は黒背景・白文字でヘッダー下からペイン下端まで表示した。人工APIの画面GETは表示中に1秒間隔で増え、プロフィールへ戻った後は29→29、対象切替後は39→39と停止した。隔離アプリは通常終了しPID消失を確認した。
- 旧schemaの人工サーバーでは新画像編集を無効にし、通常の文面保存ボタンを有効に保つiPhone focused1件成功・失敗0。XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf5fe1dd20e1/result-bundles/test_sim_2026-10-28T13-31-29-641Z_pid49890_b13dde7a.xcresult`。

実Botの再起動・試験送信、実Owner画像操作、本体反映、Apple署名・TestFlight配布はこの候補で行っていない。Aiterm実scrollbackの保持上限とCLI固有の全過去履歴は未確認。既版69の配布結果は保持する。
