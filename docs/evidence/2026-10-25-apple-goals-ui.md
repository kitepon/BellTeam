# Apple共通ゴール画面の人工API確認

オーナーの「誰がどのゴールを持ち、状況は何かを一覧で見て、設定・編集・一時停止・再開・取消を操作したい」という依頼に対し、iPhoneのタブとiPad・Macのサイドバーから同じSwiftUIのゴール一覧を開く。状態の正本はBellTeam本体から読むnative goalで、Appleアプリに別のゴール台帳を置かない。

本体のDraft PR #79で定義された`GET /api/goals`、`GET/POST /api/bots/:id/goal`のsnapshot/binding/capabilities/fieldCapabilitiesへ合わせた。取得不能・未対応・ゴールなしを分ける。利用可能な操作だけを表示し、目的と予算を同時に変更できない場合は変更項目を選ばせ、一つのPOSTだけを送る。結果不明の変更POSTは自動再送せず、現在状態を一度読み直して理由を表示する。編集画面は現在のsnapshotから能力を読み、会話bindingが変われば保存を無効にする。能力変更中の画面遷移は後続で実測する。

iPhone 16 Pro Max / iOS 26.5 Simulatorの隔離プレビューと人工`test/helpers/goals-ui-server.mjs`で、未対応の設定・編集を表示せず、ゴールの一時停止→再開→取消を実行するfocused画面試験が1件成功・失敗0。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-35-10-503Z_pid8412_2333ef58.xcresult`。人工APIが項目別編集を許す条件では、目的だけで設定→予算だけ編集を行うfocused画面試験が1件成功・失敗0。サーバーの記録は1回目が`objective=true, tokenBudget=false`、2回目が`objective=false, tokenBudget=true`で混合POSTは無い。XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-32-18-531Z_pid8412_b5941d80.xcresult`。

編集中に同じbindingのまま能力を「目的・予算別々」から「目的のみ」に変える人工条件でも、予算入力画面から目的入力画面へ切り替わり、未保存の目的文を保持した。保存POSTは目的だけで予算を含まない。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-48-21-241Z_pid8412_c58d7995.xcresult`。

人工APIが停止変更へ`outcome=unconfirmed`を返す条件では、ゴール画面が結果不明を表示して次の操作を無効にし、利用者が更新を押すと現在状態を読み直して操作を再開した。サーバー記録の変更POSTは1回だけ。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-52-22-811Z_pid8412_1cb75fcd.xcresult`。通信が切れて応答そのものが無い場合の画面は別条件であり、この結果で確認済みとは扱わない。

変更POSTの応答を人工サーバーが切断した条件でも、画面は同じBotの現在状態をGETで1回読み直し、実際に一時停止となった状態と応答断の案内を表示した。サーバー記録は変更POST1回・Botの詳細GET1回で自動再送なし。focused画面試験1件成功・失敗0、XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T10-55-32-526Z_pid8412_8c0decb7.xcresult`。読戻しまで失敗する場合は別条件として未確認。

隔離Mac Catalyst Debugビルドは成功。通常アプリとは別識別子`dev.kitepon.bellbot.goalprobe`で人工APIのゴール一覧を開き、3状態と操作ボタンを画面・アクセシビリティで確認した。[Macの人工一覧](images/2026-10-25-goals-mac-list.png)。試験後は隔離アプリとサーバーを通常終了し、PIDと待受の消失を確認した。

iPad Pro 11インチ（M5）/ iOS 27.0 Simulatorでも同じ人工APIの3状態を一覧で確認し、focused画面試験1件成功・失敗0。初回画面ではサイドバー下部の「ゴール」が2行に折り返したため、下部ボタンの横余白を詰めた。修正後のfocused1件成功・失敗0、[iPadの人工一覧](images/2026-10-25-goals-ipad-list.png)では予定・ゴール・設定が1行で読める。修正後XCResultは`~/Library/Developer/XcodeBuildMCP/workspaces/BellTeam-bf30729c2d6d/result-bundles/test_sim_2026-10-25T11-03-41-762Z_pid8412_53ab0184.xcresult`。SimulatorはShutdownを確認した。

初回の画面試験は「設定」タブをゴールの設定操作と取り違え、次回は人工APIの状態をリセットせず前回の取消結果を引き継いだ。操作の識別子と人工APIの初期化を直した後の結果を採用した。変更POSTと読戻しがともに失敗する場合、実native CLIとの結合は未確認。本体PR #79は通常CLIの設定・他CLI/OS・正式上流公開を残すDraftであり、このApple画面を実Botで使える成果とは扱わない。実Bot操作、通常アプリ、署名、TestFlight、本番コンテナ停止は0。
