# BellTeam for iPhone・iPad・Mac

初回画面の「はじめて使う」から、サーバーの導入ガイドをアプリ内で読める。PCとDockerの準備、配布ファイルの取得・起動、接続先URLの確認を案内し、同じ手順をPCへ共有できる。内容は [サーバーの導入ガイド](../../docs/server-installation.md) を同梱する。

BellTeamの公開APIを使うSwiftUIアプリ。ローカルへ直接接続し、外部接続を設定したチームにはCloudflare Accessでログインする。会話、画像送信、ルームの宛先選択、配送待ち、Bot画面、メンバーとルームの作成・編集、自動実行予定、オーナープロフィールとユーザー規範をiPhone・iPadから扱える。オーナー・メンバー・ルームのアバター画像は、iPhone・iPadでは写真、Macでは通常のフォルダから画像ファイルを選び、位置と拡大率を調整してから保存する。

ルームの会話で「詳細」→「ルームを編集」→「ルームを削除」を選ぶと、確認後にルームの設定・会話履歴・予定を削除し、一覧へ戻る。参加Botと個別の記憶は残る。削除に失敗した時は理由を表示し、ルームと下書きを残す。iPad・Macも同じ編集画面と削除処理を使う。

初回起動時に利用者が自分のBellTeamのURLを入力する。HTTPSのほか、localhost・LANのHTTP URLを使える。接続先はその端末のアプリ設定にだけ保存し、アプリのソースや配布物には埋め込まない。Cloudflare Accessが設定済みの接続先では、ログイン時にアプリ内のWeb画面でCloudflare Accessを開き、得られた `CF_Authorization` cookieを同じ接続先のAPI通信へ渡す。設定画面から接続先を変更できる。

接続後の初回画面でClaude・Codex・Grok・Cursorを一つ選び、公式サイトで認証する。「認証を確認して始める」を押すと案内役との会話を開く。追加機能は設定画面からも編集でき、秘密の値は専用のマスク付き入力欄で登録する。返信者の自動選択が未設定のルームでは、送信前に返信するメンバーを手動で選ぶ。

初期設定の後は、設定の「AIの認証」から、認証が切れたAIや別のアカウントで入り直したいAIを選ぶ。状態を開くだけでは認証をやり直さない。「認証し直す」を押し、公式サイトで承認する。必要な利用者コードや入力欄は同じ画面に出る。今の認証が消える可能性があるAIは、開始前に知らせを表示して確認する。途中でやめた後も、現在の公式認証の状態を確認して表示する。iPhone・iPad・Macで同じ画面を使う。

ローカル接続のOS設定は`project.yml`の`NSAllowsLocalNetworking`、ループバック・private・link-local IPのATS例外、`NSLocalNetworkUsageDescription`を使う。iOS 17以降のIP接続に必要な例外は[AppleのNSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)と[NSExceptionDomains](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)に従う。LANへの初回接続許可はOSが表示する。

表示はライトモードに固定する。端末のダークモード設定や時間帯による切り替えに追従しない。アプリ全体への指定には、Appleの[UIUserInterfaceStyle](https://developer.apple.com/documentation/bundleresources/information-property-list/uiuserinterfacestyle)を使う。

会話本文は[EnrichedMarkdown](https://github.com/software-mansion-labs/enriched-markdown-ios)の標準スタイルで見出し・表・箇条書き・引用・コードを表示し、範囲選択とコピーに対応する。メンバー一覧の丸は、待機中が緑、仕事中が赤の点滅、オフラインが灰色になる。iPhone・iPad・Macで共通の表示部品を使う。

吹き出しの最後に追加された段落区切りと外余白は、描画ライブラリの公開themeインターフェースで省く。段落間隔とコード枠の内側のpadding、元の本文とコピー機能は保つ。描画ソースの参照先と修正commitは `Package.resolved` を参照。

iPadではMacと同じ`DesktopWorkspaceView.swift`を参照し、一覧・会話・詳細を並べる。狭いウィンドウでは一覧と会話を切り替え、詳細はシートで開く。縦横の回転とウィンドウのサイズ変更に対応する。詳しくは [iPad版](../../docs/ipad-app.md) を参照。

## ビルド

Xcode 27、iOS 17以降。`project.yml` がXcodeプロジェクトの設定正本で、生成済みの `BellBot.xcodeproj` もリポジトリへ含める。設定を変えたら `xcodegen generate --spec ios/BellBot/project.yml` で再生成する。

```sh
xcodebuild -project ios/BellBot/BellBot.xcodeproj -scheme BellTeam \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

購読商品のアプリ・商品IDは [product.json](../../services/subscriptions/product.json) が正本。公開版はそのアプリIDで署名する。実機とTestFlightへの配布時は、配布者のApple Developerアカウントで署名し、`DEVELOPMENT_TEAM`を指定する。

## TestFlight

Xcodeでアカウント登録後、自分のApp IDとApp Store Connectのアプリを作成し、署名付きアーカイブをアップロードする。TestFlightで内部テスターを追加する。ビルド処理が完了すると、iPhone・iPadのTestFlightアプリからネットワーク越しにインストールできる。

アーカイブの生成例:

```sh
xcodebuild -project ios/BellBot/BellBot.xcodeproj -scheme BellTeam \
  -destination 'generic/platform=iOS' -archivePath /tmp/BellTeam.xcarchive \
  BELLTEAM_APP_BUNDLE_IDENTIFIER=自分のアプリID DEVELOPMENT_TEAM=自分のチームID \
  -allowProvisioningUpdates archive
```

`BELLTEAM_APP_BUNDLE_IDENTIFIER` がアプリの Bundle ID になる。通知拡張はその値に `.NotificationService` を付けた ID、共有の App Group は `group.` を付けた ID になる。`PRODUCT_BUNDLE_IDENTIFIER` をコマンドラインで上書きすると拡張まで同じ ID になり、署名できない。

返信の通知は、メンバー一覧を読み込んだ時に保存したアバターと名前を Communication Notification として表示する。手順は [iPhoneへの通知](../../docs/push-notifications.md) を参照。

`-bellbot-preview` はDebugビルド専用の画面確認用起動引数。既定では通信・ログインを行わない。`-bellbot-preview-server URL` を併用した試験だけ、指定した試験サーバーへ通信する。Releaseには含めない。

## 会話の配置とフリーズ回帰試験

下書きは`AppStore`が宛先ごとの`ConversationDraft`を保持し、入力欄だけがその本文変更を観測する。同じ宛先のウィンドウでは下書きを共有し、会話切り替えで保持する。ルーム削除とログアウトでは、表示中の入力欄が保持する下書きも消す。文字入力の変更をアプリ共通の更新通知に載せない。

会話一覧は、取得済みのページを`VStack`で配置する。初回10件、追加20件のページ取得は維持する。開いた時は最新位置を表示し、上端へスクロールすると過去のページを自動取得する。取得した本文の描画で高さが変わる間も、取得前の読み位置を保つ。長さの違うメッセージの更新と`scrollTo`が重なると、この画面の`LazyVStack`では配置計算が終わらず、メインスレッドが占有される現象を実機とシミュレーターで確認した。

`ConversationFreezeUITests`は、人工の長文・短文10件を繰り返し更新して自動スクロールしながら、手動スクロール・キーボード表示・詳細画面の操作ができることを確認する。`-bellbot-preview-updating-chat`で同じ状態を再現できる。個人の会話データは試験に含めない。

読み込んだ全行を配置するため、過去のページを大量に追加した場合の表示コストは増える。大量の履歴を扱う方式を変える場合も、この回帰試験で応答を確認する。

秘密情報の入力カードとマスク付き入力画面は [秘密情報の入力](../../docs/secret-input.md) を参照。

## 購読と会話の書き出し

設定画面でサーバーの購読状態とAppleの価格を表示する。AIの動作確認が完了するまでは購入ボタンを表示しない。購入・復元・取引の更新で得たAppleの署名付き情報を利用者のサーバーへ送る。サーバーが利用可能と判定した後に取引を完了する。別のサーバーも同じ購読を復元できる。

会話上部の共有ボタンから、選択したメンバー・ルームの履歴全件をJSONで保存できる。添付画像はサーバー内の参照URLを含み、画像本体は含まない。購読の有効性を問わず利用できる。

返信・秘密情報の入力要求のプッシュ通知は [iPhoneへの通知](../../docs/push-notifications.md) を参照。
