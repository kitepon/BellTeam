# AppleのGoal一覧と個別会話の表示

専用のゴール画面は、`GET /api/goals`で実際にゴールがあるメンバーだけをカードに並べる。取得不能・未対応のメンバーはカードへ混ぜず、理由を別枠で示す。未設定のメンバーを設定する入口は上部に残した。

個別Bot会話は既存の`GET /api/bots/:id/goal`を使い、入力欄直上の中央に現在状態と実際に取得した経過時間の小ピルを置く。時間が届かなければ「時間未取得」と表示し、0秒や端末時計で補わない。ピルは目的文を出さず、タップした時だけ目的全文・取得時刻・Nativeが許す編集、一時停止または再開、取消を持つカードを上に出す。短い目的は自然な高さ、長い目的は180pt以内のスクロール領域で全文へ届く。[iPhoneの人工カード](images/2026-10-26-goal-chat-card.png)と[Macの人工カード](images/2026-10-26-goal-chat-mac.png)。これらは人工API画面であり、オーナーが渡したprivate参考画像はrepoへ収めていない。

両画面は同じGoal型、能力判定、編集シート、結果不明時のPOST自動再送なし・同Bot一回読戻しを使う。`availability=unavailable`と`unsupported`は「ゴール未設定」や「進行中」へ変えず、理由を示す。操作能力がない設定済みゴールにも、その旨を表示する。新しいAPI、ID、端末側の経過時計、Nativeにない操作は追加していない。

## 人工検証

- iPhoneのchatピルから目的全文と編集・一時停止→再開→取消を開き、能力どおり3つの変更POSTが各1回だった。カードのアクセシビリティIDが子ボタンを覆い、目的文の高さが0になった初回欠陥を、子ID保持と実測テキスト高さによる配置へ修理した。最終focused試験1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-42-53-097Z_pid85321_954752c9.xcresult`。
- chatの取得不能と未対応はそれぞれ理由を表示し、Goalなし・activeへ補完しなかった。focused1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-33-21-620Z_pid85321_38387ed5.xcresult`。長い目的の全文と入力欄・操作の共存も1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-46-18-779Z_pid85321_dda7fb1b.xcresult`。
- 専用一覧は未設定カードを出さず、取得不能の理由と設定済みゴールの状態・操作を維持した。iPhone focused1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-35-56-979Z_pid85321_237c8def.xcresult`。設定・目的だけ保存・予算だけ編集も1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-47-09-375Z_pid85321_13ed8662.xcresult`。
- 古い一覧GETが編集を上書きしない条件と、結果不明で自動POSTを再送しない条件は計2件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-53-06-318Z_pid85321_e368b43b.xcresult`。chatから目的だけを編集する1件も成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-58-52-594Z_pid85321_345bbe99.xcresult`。
- iPad Pro 11インチ（M5）/ iOS 27.0の専用一覧は1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T03-48-08-964Z_pid85321_b28a19a1.xcresult`。Mac Catalyst Debugの隔離bundle `dev.kitepon.bellbot.goalrefprobe`はビルド成功後、人工会話でピル・全文カード・編集/一時停止/取消と更新を画面・アクセシビリティで確認し、通常終了してPID消失を確認した。人工Grokの操作不能理由もiPhone focused1件成功・失敗0、XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-26T04-02-22-768Z_pid85321_75a51ac4.xcresult`。

実Owner Goal/provider操作、実Bot送信、署名・TestFlight、本体反映は行っていない。iPadの個別chat展開、複数メンバーからの設定選択、長文の実IME変換は未確認。Nativeのpause等の能力が無い対象へ、Appleだけの代替操作は出さない。
