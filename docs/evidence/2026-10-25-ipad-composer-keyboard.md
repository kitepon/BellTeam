# iPad横画面で入力欄がキーボードに隠れる問題

オーナーの画像`owner-ipad-composer-hidden.jpg`（SHA-256 `baabe6d99859db309852fc9900a05ad0c8a6d768ae42318c2b75c23472edc089`）では、iPad横画面の左一覧・中央会話・右プロフィールを開いたまま英字キーボードを出すと、中央の入力欄自体が隠れていた。画像だけでは導入版を読めない。修理の基準ソースは`d9be38823eef46ff226bf05e67cba9cec652be29`で、Apple製品ファイルは版61のソースから変更されていなかった。

## 原因と修理

専用iPad Pro 11-inch (M5) / iOS 26.5 Simulatorで、実際の`DesktopWorkspaceView`の3列と右のinspectorを使って未修理状態を再現した。キーボード表示後、入力欄は`(355, 428, 482, 19.5)`pt、送信ボタンは`(849, 418.5, 38, 38)`ptで、両方とも`isHittable=false`。詳細を閉じても同じ高さ・判定だった。キーボードのXCTest frameは461ptから始まるが、その上の灰色の入力補助領域が約407ptから覆うため、frameだけを比べる旧式の判定では見落とす。

`ConversationView`では、`ignoresSafeArea()`を持つ`BellBackground`を会話と並ぶ`ZStack`の子にしていた。このiPad構造では背景の安全領域拡張が会話と入力欄にも及んでいた。背景を`ZStack`の子から外して`.background { BellBackground() }`へ移すと、装飾だけが安全領域へ広がり、入力欄は64.5pt上がって`y=363.5`、送信ボタンは`y=354`になった。詳細あり・なしの両方で`isHittable=true`となり、画像でも入力欄全体をキーボード上に確認した。製品コードの変更はこの配置1か所だけ。

## 隔離検証

- 新しいfocused UI試験`TabletWorkspaceUITests/testLandscapeInspectorKeepsComposerAboveKeyboard`: 英語（日本）QWERTYで入力し、詳細を閉じ、キーボードを閉じて入力を再開し、詳細を再度開いた。各状態で入力欄と送信ボタンが操作可能、末尾行が入力欄の上、下書きが保持されることを確認して1件成功。XCResult: `test_sim_2026-10-25T00-24-28-362Z_pid49454_f87e4851.xcresult`。
- 既存のiPad横→縦回転と下書き保持1件成功: `test_sim_2026-10-25T00-19-11-721Z_pid49454_4c244b5c.xcresult`。
- iPhoneでの送信直後の仮行・受付後の正本可視性1件成功: `test_sim_2026-10-25T00-20-15-881Z_pid49454_36b30325.xcresult`。人工loopbackだけを使用した。
- Mac Catalystの署名無しDebugビルド成功。`git diff --check`成功。

未修理の再現XCResultは`test_sim_2026-10-24T23-59-34-948Z_pid49454_60c8d00c.xcresult`、配置だけを変えた初回成功は`test_sim_2026-10-25T00-01-20-796Z_pid49454_ae6981cd.xcresult`。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-463b47e4d06f/result-bundles/`にある。スクリーンショットは作業treeの`runtime/apple/ipad-composer-keyboard/`に書き出した。

これは今回のiPad入力欄の隔離受入であり、版61導入後に報告されたiPhone白い吹き出しの半スクロール再発の原因判定ではない。隔離試験で実機や実メンバーへの送信は行っていない。

## 版62の内部配布

修理PR #70は`d939f048c9ffdfc9e82b99f3ea84c8dab3fabfd8`、本体と通知拡張の番号を62へ揃えたPR #71は`f16b2aaba220e91ebb66461a2f9c86e86fcf5ea3`としてGitHub `main`へ通常統合した。配布担当センチの事前受入と、決裁箱「BellTeam版62を署名してオーナー内部TestFlightへ配布する」の許可を確認した。

`f16b2aa`の同じソースからiOSとMac Catalystの署名付きReleaseアーカイブを書き出した。本体と通知拡張は両方`1.0.3 (62)`。アーカイブの厳格な署名検査、Mac pkgのInstaller署名、Apple公式の両成果物の事前検証が成功した。Mac本体はarm64とx86_64を含む。

| 成果物 | SHA-256 | Apple build ID | 読戻した状態 |
| --- | --- | --- | --- |
| iPhone/iPad用`runtime/apple/build62/ios-export/BellTeam.ipa` | `75fdd80889f89b91864afca7c2634a93d6d41c362a1eebfaf66d06747f3da07c` | `ad818960-16d1-4179-9178-55f8f3828fd5` | `VALID`、オーナー内部グループで`IN_BETA_TESTING` |
| Mac用`runtime/apple/build62/mac-export/BellTeam.pkg` | `0fceff56e33a24080ae231d8b8a712487799688a3f6739f1c71ab44745df6309` | `75165479-c013-4b7a-84c3-959612ee0730` | `VALID`、同グループで`IN_BETA_TESTING` |

MacのTestFlightは版62の「アップデート」から「開く」へ変わり、`/Applications/BellTeam.app`の本体・通知拡張は62だった。厳格な署名検査とGatekeeperの`source=Testflight`を確認し、新しいプロセスでメンバー一覧と初期会話案内が表示された。確認用に起動したプロセスは正規終了した。Macからの実メッセージ送信はしていない。iPad実機で入力欄がキーボード上に出るかは、オーナーの次の通常使用の判定待ち。一般App Store公開とBellTeam本番コンテナ更新は行っていない。
