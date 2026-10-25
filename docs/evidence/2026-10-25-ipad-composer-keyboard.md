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

これは今回のiPad入力欄の隔離受入であり、版61導入後に報告されたiPhone白い吹き出しの半スクロール再発の原因判定ではない。実機操作・実メンバーへの送信・署名・TestFlight配布は行っていない。
