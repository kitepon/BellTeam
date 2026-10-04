# BellTeam for Mac

Mac Catalystを使い、iPhone版と通信・会話・編集・秘密入力・通知を共有する。Mac用の画面は`DesktopWorkspaceView`に置く。Webページを包まず、SwiftUIで描画する。

本文の範囲選択とコピーはiPhone・Mac共通の`SelectableText`で行う。会話の本文状態は共通の`ConversationView`が宛先ごとに持ち、通知から会話を切り替えた時に別の宛先の本文を残さない。仕様は [現行設計](current-design.md) に従う。

## 画面と操作

- 左: メンバー・ルームの検索と一覧。新着順で並べ、予定・設定・追加操作もここに置く。
- 中央: 選択した会話。SSEで新着を受け取り、入力中の文章は会話ごとに保持する。
- 右: プロフィール、AIの設定、ルームの共有する仕事・参加者。メンバーの会話中は中央のチャット欄と等幅にし、Botの画面は右ペイン内でプロフィールと切り替える。詳細パネルは隠せる。
- `⌘K`: 一覧の検索。入力欄の`Return`: メッセージ送信。`Shift+Return`と`Option+Return`: 入力欄で改行。`⌘⇧I`: 詳細パネル切り替え。`⌘,`: 設定。`⌘2`: 予定。
- 画像はファイル選択または会話へのドロップで添付する。選択直後には送信しない。
- プロフィール・メンバー・ルームのアバターは、Mac標準のファイル選択画面でフォルダから画像を選ぶ。iPhone・iPadと共通の切り抜き画面で調整して保存する。
- 推奨サイズは1280×820、最小サイズは1100×640。初期ウィンドウはmacOSの復元状態と画面配置に従う。ウインドウを広げると会話領域とキャラクター表示が等しく広がる。iPhoneは従来の画面構成を使う。
- 「メンバーを編集」は独立したウィンドウで開き、初期の目安は1120×900。端から自由に拡大縮小でき、最小サイズは600×500。プロフィールの各欄は入力後も見出しを表示する。
- ルームの詳細パネルで「ルームを編集」→「ルームを削除」を選び、確認後に削除する。会話上部の「詳細」からも同じ編集画面を開ける。削除後は一覧と会話の選択から外れ、そのルームの下書きも消える。参加Botと個別の記憶は残る。

Macの読む文字は、一覧の名前16pt、説明・補助文14pt、会話本文・入力欄・プロフィール本文18ptを基準とする。共通の文字指定は`BellTheme`へ置く。一覧は最小320pt・推奨340ptとし、文字に合わせて行の高さを確保する。iPhone・iPadの文字指定は従来の値を使う。

接続先URL、Cloudflare Accessのログイン、通知許可はこのMacに保存する。サーバーのユーザー設定をアプリへ埋め込まない。

### ウィンドウのサイズ指定

推奨サイズはルートビューの`frame`の`idealWidth`・`idealHeight`、最小サイズは`minWidth`・`minHeight`で指定し、シーンは`contentMinSize`を使う。Mac Catalystでは`defaultSize`を使わない。上限を後から書き換える処理は置かない。

macOS 27・Xcode 27のMac Catalystで、単色ビューだけの検証アプリでも`defaultSize(width: 1280, height: 820)`が`sizeRestrictions.maximumSize`を1280×852へ制限した。同じアプリからその指定だけを外すと、最大サイズは両軸とも`CGFloat.greatestFiniteMagnitude`となった。ルートの推奨サイズを`frame`へ指定しても上限は付かなかった。Appleの文書では`defaultSize`は初期値、`contentMinSize`は最大サイズなしとされているため、この環境での実動作との差として記録する。

修正後の署名付きRelease版をこのMacへ導入し、Mac標準の「ウインドウを拡大」で従来の上限を超えて画面全体へ広がることを実画面で確認した。

## このMacへの導入

XcodeにApple Developerアカウントを登録し、Bundle IDとTeam IDを渡す。秘密鍵をこのスクリプトへ渡す必要はない。

```sh
BELLTEAM_APP_ID=自分のBundleID BELLTEAM_TEAM_ID=自分のTeamID scripts/install-mac.sh
```

署名付きReleaseビルドを作成し、`~/Applications/BellTeam.app`へコピーして起動する。既存アプリがある場合は`runtime/backups/`へ退避し、実行中なら終了させてから入れ替え、新しいプロセスの起動まで確認する。`BELLTEAM_MAC_APP_DIR`で導入先、`BELLTEAM_MAC_BUILD_DIR`でビルド先を指定できる。接続先が分かっていれば`BELLTEAM_SERVER_URL`を渡して、このMacの設定へ保存できる。これはApple Development署名による登録済みMacへの導入であり、他のMacへの一般配布には別途Developer ID署名・公証またはTestFlight配布を行う。

Mac向けは`project.yml`のアプリ本体と通知拡張それぞれへ`TARGETED_DEVICE_FAMILY[sdk=macosx*]=6`（Optimize for Mac）を指定し、iPhone・iPad向けは`1,2`を使う。プロジェクト全体にだけ置くと、ターゲットの`1,2`に上書きされ、Macの配布版がiPad向け画面の77%表示になった。導入スクリプトの引数指定に加え、ターゲットの設定を正として配布archiveにも適用する。同じBundle IDを使うので、APNsのTopicは共通になる。通知拡張の Bundle ID はアプリの Bundle ID に `.NotificationService` を付けたもので、Mac でも iPhone と同じ App ID を使う。ローカル導入は開発署名のため、通知環境を`BELLTEAM_PUSH_ENVIRONMENT=development`としてビルドする。通常のApp Store/TestFlightのReleaseビルドはproduction、Debugはdevelopmentとなる。コンテナに対応するAPNsキーを設定する手順は [通知](push-notifications.md) にある。

App Store向けのMacビルドは、Mac専用のentitlementsでAppleが要求するApp Sandboxを有効にする。既存機能に必要な外向きの通信と、利用者が選んだ画像の読み込み・会話ファイルの保存を許可する。Hardened RuntimeもMacのビルドで有効にする。購入商品はiPhoneと共通で、設定画面から購入・復元する。

## 確認

`DesktopWorkspaceUITests`は会話切り替え、下書き保持、詳細パネルとルーム情報を確認する。MacのUIテストではアプリとテストランナーへのコード署名が必要。`CODE_SIGNING_ALLOWED=NO`を使ったランナーは起動時に失敗する。

本文の幅と高さは`MeasuredTextView`が本文・提案幅・表示倍率ごとに保持する。実際の枠幅が変わる時は、制約なし・自然幅・新しい枠幅の計測だけを残す。本文変更時は破棄する。これによりSwiftUIの最小幅・最大幅・配置幅の問い合わせで、同じ本文を繰り返し組版しない。

通常の起動では接続・認証・会話の読込・SSE更新・送信・秘密入力を本番のAPIで確認する。人工データの画面はDebugの`-bellbot-preview`でのみ表示できる。

## Appleの資料

- [Mac Catalystのインターフェース最適化](https://developer.apple.com/documentation/uikit/optimizing-your-ipad-app-for-mac)
- [NavigationSplitView](https://developer.apple.com/documentation/SwiftUI/NavigationSplitView)
- [Build settings reference](https://developer.apple.com/documentation/xcode/build-settings-reference): `TARGETED_DEVICE_FAMILY`の1がiPhone、6がMac向けの表示。

## 導入時の確認状況

Macの署名付きビルド、人工データでの一覧・会話・詳細欄の表示は確認済み。共通処理のiOS単体試験は9件成功、HTTPS試験サーバーを要する1件は未実行。サーバー試験は189件成功した。

ルーム削除はiPhone Simulatorで、確認のキャンセル、失敗理由の表示、成功後の一覧への復帰と参加Botの保持を確認した。試験用ルームの設定・会話履歴・予定を含む保存領域が消えることも確認した。削除後の会話選択と下書き、失敗時の保持を確かめる共通処理の2試験は、iPhoneとMacの両方で成功した。Macの画面試験は、UI Automationの有効化がタイムアウトし、ランナーを初期化できなかった。署名付きRelease版をこのMacへ導入し、起動を確認した。オーナーがMacの実画面でルームを削除し、成功したことを確認した。

このMacへ署名付きRelease版を導入し、Cloudflare Accessでの本番ログイン、メンバー一覧・会話・詳細情報の表示、新着による一覧の更新を確認した。未送信の入力が会話切り替え後に保持され、別の会話には混ざらないことも確認した。画像ファイルを選択し、添付候補にしてから送信せず取り外す操作も確認済み。確認用の下書きと画像は残していない。

MacのUIテストは、開発署名とmacOSのUI Automation本人認証を済ませた後、プレビューでプロフィールの小見出し、Bot画面の右ペイン内表示、編集ウィンドウの表示と初期サイズを確認した。署名付きRelease版はこのMacへ導入し、新しいプロセスの起動を確認した。編集ウィンドウの手動リサイズはオーナーが実画面で確認した。Jevによる画面読み取りは`TIMEOUT`となり、今回のRelease版での他の実画面操作は未確認。Macからのメッセージ送信、画像のドロップ、通知到達もまだ未確認。通知はMacの設定画面で登録してから確認する。

2026-09-30の範囲選択・通知切替の修正では、iPhone Simulatorで部分コピーして入力欄へ貼り付ける操作、通知からBot・ルームの本文へ切り替える操作、リンクを開く操作を確認した。Macで本文の部分コピーと通知の宛先・同一宛先の再更新を含む共通処理の試験8件が成功した。Macの画面試験は、UI Automationの本人認証がキャンセルされ、試験ランナーが初期化できなかったため未確認。本人認証後に`ConversationAppearanceUITests/testPartOfMessageCopiesIntoComposer`と`NotificationNavigationUITests`だけをMac Catalystで実行して確認する。

2026-09-30、Macのメンバー編集で、Opus 5.5（`claude-opus-5-5`）を保存済みのBotのモデル欄が「CLIの既定」と表示された（オーナーの指摘）。サーバーの`bot.json`・`/api/bots`・`/api/models`は正しく、Web版とiPhone Simulatorでは保存済みのモデルが表示された。編集画面はiPhoneとMacで共通の`BotEditor`で、モデル候補を読み終える前に選択欄を作っていた。候補を読み終えてから選択欄を作るように直した。候補を読めなかった時も、保存済みのモデルは「その他」と手入力欄に出す。iPhone Simulatorで、候補を0.8秒遅らせるHTTPS試験サーバーを使い、保存済みのモデルが表示されることを確認した。Mac Catalystのビルドも成功した。Macの画面では、オーナーが新しいビルドを起動し、保存済みのモデルが表示されることを確認した。

2026-09-30、チャットの入力欄を直した（オーナーの指摘）。送信した本文と画像は、APIの返事（Aitermの受付。止まっているBotの起動を含む）を待たずに入力欄から外し、拒否された時だけ戻す。画像は1回の送信に何枚でも付けられる。iPhoneとMacの入力欄は共通の`UITextView`にし、コピーした画像や画像ファイルを貼り付けると添付になる。添付の並びは入力欄の真上に重ねる。入力欄の中に置くと、キーボード表示中に入力欄が伸びた分の半分がキーボードの下へはみ出した（iPhone 17 Pro Simulator。送信エラーの一行が出た時も、変更前から同じくずれる）。iPhone Simulatorで、画像2枚の貼り付け、送信拒否で本文と2枚が戻ること、1枚を外せること、本文の部分コピー、会話更新中の操作の画面試験が成功した。共通処理の単体試験は、`ConversationAppearanceTests/testSelectedPartCopiesWithoutTheRestOfTheMessage`が複製した新しいSimulatorでは変更前のコードでも終わらないため外し、残りが成功した。Mac Catalystのビルドは成功した。Macの画面での貼り付けとドロップは、UI Automationの本人認証がsshからは通らないため未確認。

2026-10-01、Botがオーナーへ選択を求めるカード（`OwnerQuestionView.swift`）を足した。iPhone Simulatorで、カードの選択肢が出ること、接続先の無い試験用の起動では答えが送れず理由が出てボタンが押せるまま戻ることを確認した。Mac Catalystのビルドは成功した。答えが届くまでの流れはWeb版とサーバーの試験で確認した。

## アプリ担当への引き継ぎと残っている確認

Mac・iPhone・iPadアプリは同じCodexスレッドで担当し、サーバーのAPIと本番反映はトロニーが担当する。入力欄の複数画像対応と選択肢カードを引き継ぎ、トロニーから本番コンテナのソースとWebファイルが対象commitに一致するとの確認を受けた。配布・導入・試験の現在値は [配布記録](subscription-setup.json) に置く。

iPhone 17（iOS 27）とiPad Pro 13-inch（iPadOS 26.5）で、カードの表示と送信失敗時の理由表示を確認した。このMacでは署名付きRelease版の導入と起動に成功した。画面試験はmacOSの本人認証でランナーの初期化に失敗したが、Mac向け表示設定を明示したビルドではJevで画面を操作できた。

Jevで本番のトロニーの会話を開き、確認用カードの選択肢を押した。アプリの回答済み表示、本番の回答記録、トロニーがオーナーからのメッセージとして受信したことを確認した。Macで画像2枚の貼り付け、Finderでコピーした画像ファイルの貼り付け、添付から外す操作も確認した。試験前のクリップボードは内容を表示せず退避し、終了後に戻した。

本番へ送った2枚の画像は、トロニーが両方を開き、同じ試験画像であることを確認した。ただし一緒に入れた試験用の本文は空で届いた。Jevは本文の入力にAXの`set-value`を使っていたため、表示だけ変わり下書きのバインディングへ反映されなかった可能性がある。通常のキーボード操作による再試験は、`agent-desktop`のクリップボード補助機能が無いエラーと画面取得の失敗で進められなかった。原因は未確定で、アプリの本文処理は変更していない。

残る確認は、Macのトロニーの会話で通常のキー入力による本文と画像2枚を一緒に送り、トロニーに本文と枚数を確認してもらうこと、画像ファイルをFinderからドロップして添付になること。使用したGUI操作ツールはネイティブの別アプリからのドラッグセッションを開始できないため、実操作での確認が必要。Macの画面試験を自動で再実行する場合は、オーナーがUI Automation本人認証を済ませてから、`ConversationAppearanceUITests/testPastedImagesBecomeAttachmentsAndReturnAfterFailedSend`と`testOwnerQuestionCardShowsOptionsAndReportsSendFailure`をMac Catalystで実行する。

## 会話画像の表示

オーナーが直接会話とルームへ送った画像も、APIの`image_urls`から全枚を表示する。2枚以上は本文の吹き出しの外へ置き、先頭1枚と、横と下へ傾けてずらした奥の最大2枚の扇状のカード束にし、押すと黒い全画面で開く。下のサムネイル、左右スワイプ、左右ボタンと矢印キーで切り替え、上のボタンまたはEscapeで閉じる。1枚は従来の単独表示から同じ全画面へ進み、サムネイルを出さない。この表示と認証付き取得はiPhone・iPad・Macで同じ`ConversationView.swift`を使う。古いAPIの`image_url`だけの発言も読める。保存されていない過去の画像は「画像」や枚数の表示を保ち、復元はできない。

共通表示の初期試験で、iPhoneとiPadのSimulatorの個別会話・ルームのカード束、画像本体の表示、サムネイル切替、スワイプ、閉じる操作、旧形式の1枚画像と未保存画像を確認した。オーナーの参考写真に合わせた扇状の表示では、iPadの3枚の個別会話と2枚のルームの試験が成功し、画面の写真でも重なりと全画面の配置を確認した。iPhoneはルーム用の起動待ちで自動試験が一度タイムアウトしたが、Simulatorを再起動し、対象の個別会話・ルームの試験が成功した。1枚画像と未保存画像の試験は初回に成功した。参考に合わせた重なりと全画面の配置は、iPhoneの画面の写真でも確認した。Macの共通モデル試験2件も成功した。署名付きRelease版はこのMacへ導入し、起動を確認した。本番の対象発言はJevの自動操作で画面内へ移動できなかったため、Macの全画面表示はオーナーへ実画面確認を依頼した。試験と配布の現在値は[配布記録](subscription-setup.json)を参照する。

試験用画像で確認した表示: [iPhoneのカード束](assets/conversation-images/iphone-stack.png)・[全画面表示](assets/conversation-images/iphone-gallery.png)。

参考写真に合わせた版はiPhone・iPad用とMac用の両方をAppleへ送り、処理完了後にTestFlightのOwnerグループで配布されていることをAPIで確認した。配布したビルド、対象端末と配布元commitは[配布記録](subscription-setup.json)を参照する。Macの本番での束・全画面・切替の実操作は確認待ちのため、確認済みには含めない。
