# Apple共通ゴール画面の人工API確認

オーナーの「誰がどのゴールを持ち、状況は何かを一覧で見て、設定・編集・一時停止・再開・取消を操作したい」という依頼に対し、iPhoneのタブとiPad・Macのサイドバーから同じSwiftUIのゴール一覧を開く。状態の正本はBellTeam本体から読むnative goalで、Appleアプリに別のゴール台帳を置かない。

本体のDraft PR #79で定義された`GET /api/goals`、`GET/POST /api/bots/:id/goal`のsnapshot/binding/capabilities/fieldCapabilitiesへ合わせた。取得不能・未対応・ゴールなしを分ける。利用可能な操作だけを表示し、目的と予算を同時に変更できない場合は変更項目を選ばせ、一つのPOSTだけを送る。結果不明の変更POSTは自動再送せず、現在状態を一度読み直して理由を表示する。編集画面は現在のsnapshotから能力を読み、会話bindingが変われば保存を無効にする。能力変更中の画面遷移は後続で実測する。

iPhone 16 Pro Max / iOS 26.5 Simulatorの隔離プレビューと人工`test/helpers/goals-ui-server.mjs`で、未対応の設定・編集を表示せず、ゴールの一時停止→再開→取消を実行するfocused画面試験が1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-35-10-503Z_pid8412_2333ef58.xcresult`。人工APIが項目別編集を許す条件では、目的だけで設定→予算だけ編集を行うfocused画面試験が1件成功・失敗0。サーバーの記録は1回目が`objective=true, tokenBudget=false`、2回目が`objective=false, tokenBudget=true`で混合POSTは無い。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-32-18-531Z_pid8412_b5941d80.xcresult`。

編集中に同じbindingのまま能力を「目的・予算別々」から「目的のみ」に変える人工条件でも、予算入力画面から目的入力画面へ切り替わり、未保存の目的文を保持した。保存POSTは目的だけで予算を含まない。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-48-21-241Z_pid8412_c58d7995.xcresult`。

人工APIが停止変更へ`outcome=unconfirmed`を返す条件では、ゴール画面が結果不明を表示して次の操作を無効にし、利用者が更新を押すと現在状態を読み直して操作を再開した。サーバー記録の変更POSTは1回だけ。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-52-22-811Z_pid8412_1cb75fcd.xcresult`。通信が切れて応答そのものが無い場合の画面は別条件であり、この結果で確認済みとは扱わない。

変更POSTの応答を人工サーバーが切断した条件でも、画面は同じBotの現在状態をGETで1回読み直し、実際に一時停止となった状態と応答断の案内を表示した。サーバー記録は変更POST1回・Botの詳細GET1回で自動再送なし。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-55-32-526Z_pid8412_8c0decb7.xcresult`。読戻しまで失敗する場合は別条件として未確認。

独立レビューで、編集シートを開いたまま古い一覧GETが進むと、変更POSTまたは結果不明の状態を後から上書きできる順序が見つかった。`GoalsView`は一覧更新中の保存を画面と変更処理の両方で止める。人工一覧GETを保留したiPhone画面では保存ボタンが無効・POST0、旧GETを返してから保存すると未送信の目的文を保持し、目的だけのPOSTが1回出た。focused1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T11-51-42-974Z_pid8412_80e2c5aa.xcresult`。結果不明の自動更新を使って状態を上書きする経路は作っていない。

本体PR #79のv2契約に合わせ、Codexの`kind=codex-cli/native`とClaudeの`kind=claude-code/phase/native`を別型で読む。人工Claudeの状態文、存在する使用トークン・実行時間・反復数・CLI表示ターン数と、v2 Codexの目的を画面で確認した。Claudeには未対応のpause/editを出さず、clear後の`nativeHistory.terminal=cleared`を「前のゴール：取消」と表示し、達成にしなかった。focused画面試験1件成功・失敗0、人工サーバーの変更はclear POST1回。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T12-01-10-169Z_pid8412_31b9efeb.xcresult`。使用量の無いClaude状態へ0を補う表示はしない。これは型付き人工データであり、実Claude workerの操作ではない。

v2型の追加後も、v1のCodex平坦形式を使うiPhone一覧・pause/resume/clearのfocused画面試験1件が成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T12-07-13-746Z_pid8412_b9cc4598.xcresult`。

隔離Mac Catalyst Debugビルドは成功。通常アプリとは別識別子`dev.kitepon.bellbot.goalprobe`で人工APIのゴール一覧を開き、3状態と操作ボタンを画面・アクセシビリティで確認した。[Macの人工一覧](images/2026-10-25-goals-mac-list.png)。試験後は隔離アプリとサーバーを通常終了し、PIDと待受の消失を確認した。

iPad Pro 11インチ（M5）/ iOS 27.0 Simulatorでも同じ人工APIの3状態を一覧で確認し、focused画面試験1件成功・失敗0。初回画面ではサイドバー下部の「ゴール」が2行に折り返したため、下部ボタンの横余白を詰めた。修正後のfocused1件成功・失敗0、[iPadの人工一覧](images/2026-10-25-goals-ipad-list.png)では予定・ゴール・設定が1行で読める。修正後XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T11-03-41-762Z_pid8412_53ab0184.xcresult`。SimulatorはShutdownを確認した。

iPadの[人工編集画面](images/2026-10-25-goals-ipad-editor.png)では目的だけの設定と予算だけの編集を行い、人工サーバーは`create objective=true/tokenBudget=false`と`edit objective=false/tokenBudget=true`の2POSTを記録。focused画面試験の最終XCResult `~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T11-30-12-000Z_pid8412_dca1c92f.xcresult`を直接読み、1件成功・失敗0と確認した。XcodeBuildMCPの呼出しは300秒で時間切れになったが、XCTest本体は正常終了まで続いた。最初の2回はシート内の日本語入力後に短い待ち時間で編集ボタンを探して失敗し、POSTがまだ出ていなかった。最終実行では保存処理が`canSave=true`で呼ばれ、POSTが2件出て両編集に成功した。XCTestが各操作後にアニメーション終了通知を最大60秒ずつ待つため、実行に923秒かかった。確認用の一時Debugログは結果を読んだ後に削除した。人工試験は実際の利用者による日本語IME変換操作の受入にはしない。

初回のiPhone画面試験は「設定」タブをゴールの設定操作と取り違え、次回は人工APIの状態をリセットせず前回の取消結果を引き継いだ。操作の識別子と人工APIの初期化を直した後の結果を採用した。変更POSTと読戻しがともに失敗する場合、実native CLIとの結合は未確認。本体PR #79は通常CLIの設定・他CLI/OS・正式上流公開を残すDraftであり、このApple画面を実Botで使える成果とは扱わない。実Bot操作、通常アプリ、署名、TestFlight、本番コンテナ停止は0。

## Grokの現在状態（追加の人工検証）

Native `128d000`のGrokゴール読取とRoot HTTPで固定された`kind=grok-cli`、`native`、`current_status`を別型で受ける。現在の状態・phase・使用トークン・経過時間は`current_status`だけを表示し、保存された`native.phase`、累積high-water、`elapsed_ms`を現在値に代入しない。人工データでは保存値を`active/Executing/19,000/910,000ms`、現在値を`UserPaused/Idle/4,906/14s`と食い違わせ、画面が「一時停止 · 待機」「使用トークン 4,906 · 経過 14s」と表示した。能力はinspectだけを有効とし、変更ボタンも変更POSTも0。別Botのbusyは`availability=unavailable`・goal省略としてエラーを表示し、「ゴールなし」へ変換しなかった。iPhone Simulatorのfocused画面試験1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-25T19-30-43-159Z_pid85321_4e3d2854.xcresult`。この人工fixtureは実Grok workerへの接続ではない。Nativeのbusy-active、同workerのpause/clear、他OS、正式Goal供給は未受入で、PR #91をDraftに保つ。

独立source確認で、`current_status.tokens_used`は符号付きsafeIntegerであり、初回実装の非負guardがHTTPの正当な`-1`を拒否すると分かった。非負guardだけを除き、人工`-1`を0へ補正せず「使用トークン -1 · 経過 14s」と表示した。focused画面試験1件成功・失敗0、変更POST0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-25T19-43-40-590Z_pid85321_82590557.xcresult`。これは固定schemaの境界確認であり、実CLIで負の値が発生した観測ではない。

Native `d56b0d7`で`current_status.source=goal detail`が追加された。`status`はActive/Paused、`phase`と`tokens_used`はnullで、表示用に`status_display`・nullを許す`phase_display`・`budget_display`・`elapsed_display`が届く。Appleは従来の`/goal status`型と分けて読み、detailの表示文字列を原文のまま使う。人工の`Active ⸬ · Planning`、`Planning`、`4.9k / 1 tokens (100%)`、`26s`を表示し、`phase_display=null`へ変えた後はその欄だけを省いた。保存`native.phase=Idle`・累積トークンでは補っていない。focused iPhone画面試験1件成功・失敗0、POST0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-7078e2c59646/result-bundles/test_sim_2026-10-25T20-11-42-184Z_pid85321_e2da580b.xcresult`。実Grok workerへの操作ではない。

旧`/goal status`画面の再確認は、同じSimulatorで2回と別のiPhone Simulatorで1回、テストランナーが`Busy`で起動を拒否したため試験本体へ到達できなかった。旧headのfocused合格は保持するが、この新headでの旧variant画面再走を成功と数えない。新しいdetail試験は上記のとおり成功し、型分岐のコンパイルも通った。
