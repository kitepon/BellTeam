# Androidアプリの機能図と作業手順

担当はネオン（`bot-208dcbab`）。この文書をAndroid製品内部の機能図とデータの流れ図の正本とする。本体側の接続登録は[Androidアプリ](architecture/modules/android/README.md)、担当と変更手順は[機能担当と変更の手順](architecture/module-ownership.md)を参照する。

オーナー指示（2026-11-17、task a350）：全プラットフォームで仕様は1つ。見た目と操作はMac版（`ios/`）に揃え、BellTeamのAndroid版をGoogle Playの内部テストへ出す。コードは[Linuxアーキテクチャ](linux-architecture.md)と同じ方針で、`windows/BellTeam.Core`（plain `net10.0`、所有はアニス）をProject参照で使い、画面はAvalonia 12（`net10.0-android`）で作る。Androidで新しく書くのは「携帯の形」の殻（`PhoneShell`）とAndroid固有の入口だけとする。

## 機能図

```mermaid
flowchart LR
  user[利用者] --> shell[PhoneShell<br/>1画面ずつ：会話一覧 → 会話<br/>android/BellTeam.Android]
  shell --> views[画面部品<br/>ConversationRow・MessageCard・MarkdownView・起動の各画面ほか<br/>linux/BellTeam.Linux の .cs をリンク]
  views --> ws[会話の状態・一覧・送信・SSE・再接続・下書き<br/>Workspace&lt;TImage&gt; in BellTeam.Core]
  shell --> core[通信・モデル・設定<br/>windows/BellTeam.Core]
  ws --> core
  core -->|HTTP API・SSE| integration[BellTeam共通入口<br/>モリー]
  core --> local[アプリの私有領域の設定<br/>settings.json]
  shell --> account[AccountCard・AccountStore<br/>Google・Appleサインイン・購入・再確認・ほかの端末を止める・サインアウト<br/>a485 契約1.20のA部]
  account --> approve[ApprovePanel（店のパスだけ）<br/>QR読み取り・コード・許可・許可した端末の一覧と止める]
  approve -->|QR| scanner[Googleのコードスキャナー<br/>Play services]
  account -->|サインイン・パス・Play購入| lib[login-billing 0.14.0 android部<br/>Kitepon.LoginBilling.Android]
  approve -->|ApproveAsync・LinkedDevices・StopAsync| lib
  shell --> homelink[本体サーバーへのログイン（a492）<br/>HomeGate・HomeConnectView・AndroidHomeLink・KeystoreHomeStore]
  homelink -->|HomeConnection: connectHome・homeHeader・reproveIfDue・endHomeSession| lib
  homelink -->|GET /api/home/session・/api/home/login/*| homeserver[(ホームサーバー)]
  lib -->|パスは運営のWorkerのoriginだけ| worker[運営のWorker<br/>product.jsonのloginBillingWorkerUrl]
  shell --> access[Accessログイン<br/>WebView・CookieManager]
  access -->|CF_Authorization| core
  shell --> android[Android入口<br/>MainActivity・AvaloniaAndroidApplication<br/>戻る・安全領域・平文http許可]
  release[配布 apk/aab<br/>Google Play 内部テスト] --> device[Android端末]
  integration --> server[BellTeam本体の各機能]
```

- Linux版の画面部品は、`BellTeam.Android.csproj` が `linux/BellTeam.Linux/*.cs`（`Program.cs`・`App.cs`を除く）をそのままコンパイルして使う。画面の直しは1か所（Linux側）で両方へ届く。窓（`Window`）に載る画面は携帯では使えないため、`PhoneShell` が1画面ずつの頁として載せ直す。
- `BellTeam.Core`の所有者はアニス。Coreを変える時は小さなPRでアニスをレビューに入れ、Windowsの挙動を変えない（Linuxと同じ合意）。
- アセンブリ名は `BellTeam`（WindowsとLinuxと同じ）。Coreの`InternalsVisibleTo("BellTeam")`と`avares://BellTeam/`の資源が同じ名前で届くため。
- 本体の状態は共通入口のHTTP APIとSSEだけで使う。本体の内部状態を直接読み書きしない。

## データの流れ

```mermaid
flowchart TD
  input[タップ・文字入力・戻る] --> shell[PhoneShell]
  shell -->|ConnectAsync・SelectAsync・SendAsync・LoadOlderAsync| ws[Workspace]
  ws -->|HTTP要求| api[BellApi ほか]
  api -->|JSON| server[(BellTeam本体)]
  server -->|SSE| sse[SseReader]
  sse --> ws
  ws -->|Entries・Messages・状態の更新| shell
  shell --> rows[ConversationRow・MessageCard]
  settings[(settings.json<br/>アプリの私有領域 BellTeam/)] <--> local[SettingsStore]
  shell --> local
  local --> api
  back[戻るボタン] -->|会話 → 一覧| shell
```

- 接続先は`SettingsStore`の`ServerUrl`（`SpecialFolder.LocalApplicationData`＝アプリの私有領域）に保存する。起動時に保存があれば`StartupRoute`に従って自動で接続し、無ければ接続先の入力画面（Mac版と同じ）を出す。
- 画面の部品が窓に頼る3つ（転送のシート・メンバー間の連絡のシート・画像ギャラリー）は、Linux側の`IMessageHost`（`ISheetHost`を含む）に分けた。カードは見た目の祖先から`IMessageHost`を探して頼み、Linuxでは`MainWindow`、Androidでは`PhoneShell`が答える（シートは頁の上に重ね、ヘッダー右の「転送」などの保存ボタンは`ISheetSave`に従う。ギャラリーは全面）。返信の帯（`Workspace.Quote`）は入力欄の上に出す。戻るボタンはギャラリー → シート → 頁の順に閉じる。
- 窓の画面を頁にする：Avalonia `Window`はAndroidで作れない（`NotSupportedException`）ため、Androidプロジェクトは`namespace BellTeam.Linux`の中に携帯用の`Window`（`WindowShim.cs`。`ContentControl`）を置く。同じ名前空間の型が`Avalonia.Controls`の取り込みより優先されるので、リンクしたLinuxの`EditorWindow`・`ApprovalsWindow`・`LatticeWindow`・`WorkGraphWindow`などは変更なしに頁として使える。`Show()`で`PhoneShell`の頁の積み重ねへ載り、`Close()`で外れる。コントロールから窓を探す所は`OwnerWindow.Of`（Linuxは`TopLevel`、Androidは視覚の祖先）に一か所化した。`MainWindow`・`Launcher`・描画確認（`*Render`・`*Fixture`）・`SingleInstance`はAndroidへリンクしない。頁の戻るは`IPageBack`（決裁箱の詳細→一覧）を先に聞く。
- 狭い画面向けの並べ方（`Compact`）：決裁箱は一覧と詳細を1列ずつ切り替え（詳細は上の集計を外し、つながりを詳細の下へ）、工程表の一覧は幅いっぱいのカードを縦に並べる。Linuxの並べ方（3列・折り返し）は変えない。一覧画面の入口は「決裁箱（件数）」「工程表」。相関図（`WorkGraphWindow`）の頁も同じ仕組みで開く。エミュレーターで、作業中のメンバーの顔写真・輪・名前・依頼の線と吹き出しまで描かれる。AndroidのSkiaは、角丸の矩形へ`ImageBrush`で顔写真を描くと細い切れ端しか出さない（途中で相関図が空白に見えた原因と考えられる）ため、顔写真は角丸のクリップの中へ`DrawImage`で描く（Linuxも同じ描き方）。
- 通知（閉じている間のFCM。契約は[FCM通知](architecture/modules/usage/fcm-push.md)、サーバー側はミカ）：アプリは起動のたびと`onNewToken`でFCMの端末トークンを`POST /api/notifications/android/devices {token, server, previousToken?}`で今つないでいるサーバーへ登録し、ログアウトとつなぎ先の変更の前に`POST …/android/unregister {token}`で外す（`PushRegistration`。3秒で打ち切り、つながらなくても切り替えを止めない）。サーバーがFirebaseの鍵を持たない間の503・拒否の400は静かに記録するだけで、再試行は次の起動に任せる。`google-services.json`（Firebaseの設定、シエロのa379）が無いと`FirebaseApp`が無く、登録は動かない（ビルドと起動は通る）。通知チャンネル`bellteam_messages`（重要度high）を起動時に作る。アプリが閉じている間はシステムが題名と本文を出し、タップで`MainActivity`が`data`を引数に起動する。`PushRouter`がそれを受け、つながり次第`kind`/`roomId`/`botId`の会話を開く（別のサーバーのものは捨てる。iOSと同じ）。アプリが開いている間は`BellPushService.OnMessageReceived`が自分で通知を出すが、いま見ている会話のものは出さない。更新通知（`kind: update`、サーバー側はミカのa381）は題名「BellTeam」・本文「更新があります。Updateで確認してください。」で届き、タップすると設定の「アップデート」の頁を開く（今つないでいるサーバーのものだけ。自動では更新しない。端末登録に`proof`は送らない）。送り主の顔写真はv1では送られない。
- 設定：Androidの設定の頁（`PhoneSettingsPage`）は接続・利用と課金（Linuxと同じ`PurchaseEntry`）・アプリの版をAndroid用に描く。その上の「AI・端末・追加機能などの設定」は、Linuxの`SettingsWindow`を携帯の形（`compactHidden`：頁の一覧 → 選んだ1頁。戻るは`IPageBack`）で開く。Linux版が自分で描く接続・利用と課金（Stripeの行）・アプリの版・通知（freedesktop）は一覧から外す。AIのCLIの導入（a451。AIの設定の「最新版を入れる」・要対応の帯・初期設定・Botの編集）は、このLinuxの画面を共通部分としてそのまま使い、[Linuxアーキテクチャ](linux-architecture.md)に従う。
- メンバー編集：メンバーとの会話の見出し右の歯車で、Linuxの`MemberEditorWindow`（名前・テーマ色・AI・端末とフォルダ・予定など）を頁として開く。キャンセル／保存はその画面のもの。
- リンク：メッセージ・案内文のリンクと設定のリンクは`ExternalLink.Launch`で開く。Linuxは.NETのシェル実行（xdg-open）、Androidは起動時に`ExternalLink.Opener`へ`ACTION_VIEW`のIntentを入れる（シェルが無いため）。失敗は呼び出し側が平易な文で示す。
- 画像の添付：入力欄左のクリップでシステムのファイル選択（`StorageProvider`）を開く。選ばれた画像は内容URIなので、アプリのキャッシュへ写してから`Workspace.AttachFilesAsync`へ渡す。入力欄の上に縮小画像と取り消しを並べる。
- サーバーのログイン（a485。[linux-architecture.md](linux-architecture.md)のログインの項と同じ`ConnectView`、`kind`は`android`）：サーバーが`login.enforced`なら起動画面は`ConnectView`になり、鍵は`KeystoreSessionTokenStore`が持つ。`login`キーが無いサーバーは下のAccessの流れのまま。
- Cloudflare Access（HTTPSの外部接続）のログイン（Windowsの`DesktopAccess`・`AccessLoginView`と同じ流れ）：`Workspace`が「ログインが要る」（`NeedsLogin`）と判定すると、起動画面がAndroidの`WebView`のログイン頁（`AccessLoginPage`）に替わる。WebViewの`CookieManager`が`CF_Authorization`を次の起動まで保つ。頁を読み終えるたびにそのクッキーをCoreの`AccessCookies.Replace`で`AccessSession.Cookies`（`BellApi`が送る`CookieContainer`）へ写し、`GET /api/session`が`authenticated`を返したら接続し直す。接続の前（`prepareConnection`）にも前回のログインを写す。設定の「サインアウト」（Accessの接続先だけ）は`CookieManager`とコンテナを空にして`Workspace.SignOut`を呼ぶ。HTTPSでない接続先にはログインを出さない。
- LAN上のサーバーは平文のhttpなので、Androidの`UsesCleartextTraffic`を有効にする（接続先の検査は`ServerOrigin`が行い、httpsかlocalhost・LANのhttpだけを通す）。
- 書き込み（POST・PUT・DELETE）は自動で再送しない。SSEと一覧の読み直しは、Coreの上限付きバックオフ（`ReconnectBackoff`）で再試行を続ける。起動の失敗画面は同じ間隔で自動再試行し、回数の上限で打ち切らない。

## 現在の範囲と順序

1. 済：接続先の入力・起動の各画面（Mac版と同じ。キーボードの上に持ち上げ、入力欄を表示位置へ送る）・会話一覧（アバター・在席・要約）・会話（履歴・返信/転送/コピーの印・送信）・戻る・設定の頁（接続・利用と課金・アプリの版）。エミュレーター（API 36）で本番サーバーに接続して確認。
1b. 本体サーバーへのログイン（a492、login-billing 0.16.0のHomeConnection。開発版で何も出荷しない。Linuxと同じ`HomeGate`・`HomeConnectView`を使う。詳細は[Linuxアーキテクチャ](linux-architecture.md)の同名の項）：Android固有は、ホームの記録をKeystoreのAES-GCM鍵で封じる`KeystoreHomeStore`、ライブラリのandroid部を`IHomeLink`へ写す`AndroidHomeLink`（kind `android`）、サインアウトで`endHomeSession`を先に呼ぶこと、FCMトークンが変わったら`reproveIfDue(ticketFor = トークンのSHA-256のbase64url)`を呼ぶこと。
1c. 決裁箱用の2つ目のログイン部品（a515n、login-billing 0.18.0・契約1.24。開発版で何も出荷しない）：`ApprovalBoxAccount`が、BellTeamのものとは別の`LoginBilling`を1つ持つ（接続先は`product.json`の`approvalBoxAuthUrl`＝`https://approval-box.kitepon.dev/auth/v1`、保管は`storageName`＝`approvalbox`で、フォルダもKeystoreの鍵の別名もBellTeamと別。ウェブのサインインだけで、ネイティブのGoogle・購入・領収書は使わない）。2つは何も共有せず、片方をサインアウトしてももう片方は残る。ウェブの戻りは各部品が自分のAuth Tabの起動口を`MainActivity.OnCreate`で登録し、検証済みリンクの`Intent`は先にBellTeam側、受けなければ決裁箱側へ渡す。戻りのアドレス（`approvalBoxWebReturn`）は決裁箱の運営側が一覧に載せるセッションスキーム`approvalbox-websignin`で、正確な文字列は`approvalbox-websignin://return`（ナユタ 2026-11-22。サーバーはスキームだけを見る。httpsの`/app/websignin`は決裁箱自身のアプリ用で、BellTeamは使わない）。画面と`/pc/v1`への接続は、デルタの設計（peer-channel-signin.md）とアニスのピアチャネル部品に従って別工程（a520）で作る。
2. 課金（a485、契約1.20。**0.9.1は開発版で、これで作ったものは出荷しない**。専用ブランチ`neon/a485-lb-android-090`で、ミントの受け入れ後にmainへ入れる）：設定の頁に`AccountCard`を足し、Googleサインイン・購入（`ProductDetailsAsync`→`PurchaseAsync`）・再確認・ほかの端末を止める・サインアウト・別のアカウントで買った印を出す。`AccountStore`が`LoginBilling`を1つ持ち、起動時と前面に戻るたびに`StartAsync`を呼ぶ。接続先（運営のWorker）は`product.json`の`loginBillingWorkerUrl`で、無い間は店の画面は動かさない（Appleの設計と同じ）。パスは表示・ログ・送信をしない。パッケージは`android/fetch-login-billing.sh`が版とsha256を確かめて`android/packages-local`へ置く。ウェブサインインの戻り先（`webReturn`）は検証済みのApp Link（試験Workerでは`https://bellteam-login-test.kitepon.dev/auth/return/android`、`MainActivity`の`IntentFilter`はautoVerify）で、`OnCreate`で`RegisterWebReturn`、`OnNewIntent`で`OnWebReturn`を呼ぶ（ライブラリの義務）。ウェブでサインインした端末（`PassKind.Signed`）だけ、`StartLoginAsync`を1回呼び、nullなら「すでに使えます。」、そうでなければ7fのQR画面（QRは`QrView`がQRCoderで描く。コード・確認番号・待機）を出し、`WaitForPassAsync`で待つ。ネイティブGoogleサインイン（Store）では出さない（ミント裁定B）。0.14.0に上げ（`android/fetch-login-billing.sh`がsha256を確かめる）、サインインできていない端末に「Appleでサインイン」（`SignInWebAsync(activity, "apple")`。結果はウェブのパスで、QR引き継ぎは上と同じ）を足した。店のパス（Googleサインイン）の端末だけ`ApprovePanel`を出す（ライブラリが端末の一覧を店の端末にだけ持つため）：「QRを読み取る」（Googleのコードスキャナー。こちらはカメラの権限を持たない）か、コードを入れて`ApproveAsync`を呼び、ライブラリが聞く確認（端末名と確認番号、「自分で始めたログインだけ許可してください。」）に「許可」「許可しない」で答える。結果は許可した・許可しなかった・その端末はすでに使えます（失敗にしない）。「許可した端末」の一覧は`LinkedDevices`、「止める」は`StopAsync(passId)`。ウェブのパスの端末は「ほかの端末をすべて止める」を、使ったほうのGoogle／Appleで選んでサインインし直す形（`SignInWebAsync(stopOthers: true)`）にした。実機でこれらを通した確認はまだ無い（Googleサインインのデバッグ署名が未登録・実際のApple設定待ち）。実機（試験Worker）でGoogleのウェブサインイン→`prove/start`→`prove/take`→`ticket/check`まで通した（2026-11-22）。契約の残り（AndroidでのAppleサインイン、承認する側のQR画面とApproveAsync、承認した端末の一覧、サーバーへの所有証明のワイヤ）はt3hとAppleの設定を待って配線する。旧記述：このリリースでAndroid自身のGoogle Play購入と購入トークンの送信は無い（a485。Workerが受領書での確認をやめる）。「利用と課金」はLinuxと同じ`PurchaseEntry`が契約の状態と「iPhone・iPad・Macで購入し、このサーバーをログインさせてください。」を出す。購入はライブラリのandroid部（Kotlin）を.NETから使う次の段階（ミント裁定待ち）。
3. 次：通知（サーバー側のpush＝FCMの対応が要る）。Avaloniaの`Window`はAndroidで作れない（`NotSupportedException`）ため、それらの画面は窓の継承を外した頁に分けてから載せる。
4. 配布：署名鍵・AABのbuild・Google Play Consoleの内部テストへのアップロード（Play Consoleの操作はオーナーのアカウントが要るため、トロニー経由で申請する）。

アプリID（`applicationId`）は`dev.kitepon.bellbot`。Appleの`bundleId`と`services/subscriptions/product.json`の名前に揃える。Google Playは公開後にアプリIDを変えられない。

## 開発の手順

- .NET 10 SDK（`~/.dotnet`）、`dotnet workload install android`、JDK 17、Android SDK（`~/Android/Sdk`）が要る。`dotnet build -c Debug -t:Install -p:AndroidSdkDirectory=$ANDROID_HOME -p:JavaSdkDirectory=$JAVA_HOME` で接続中の端末またはエミュレーターへ導入する。
- 画面の確認は端末で行う（`adb exec-out screencap -p`）。本番のサーバーへつなぐ時は、送信など書き込みを伴う操作をしない。
- 会話の過去ログ（a471-linux-android-older-button。契約は[machine-stream.md](architecture/modules/conversation/machine-stream.md)「History pages of a long stream」、仕様は全クライアント共通）：会話の上に「以前のメッセージを読む」ボタンは置かない。古い分はLinuxの窓と同じ`HistoryPaging.NeedsOlderPage`で、スクロールの動き・表示の大きさの変化・最初の描画のあとに`PhoneShell.PrefetchOlderAsync`が読む（位置は読む前後で保つ。読むかどうかは描いた高さで決め、最初の頁を読んだあとにもう一度確かめる〔a471-fill-drawn-linux〕。読みに失敗したら次のスクロールでまた読む）。
- 見ている行が動かないこと（a471-scroll-jump-linux）：古い頁を上に足す読み込み（`PhoneShell.LoadOlderPreservingPositionAsync`）は位置を手で戻さず、`MessageCard`が登録するスクロール固定に任せる。読んでいる間にスクロールを続けても、上の行の高さが変わっても、見ている行は動かない（Linuxの窓と同じ。測定と試験はLinux側、`ScrollJumpTests`）。
- 通知の小アイコン（a471-android-push-icon-crash）：アプリ自身のアイコンを持たないので、`ApplicationInfo.Icon`は0で、アプリが開いている間に届くプッシュは`Notification.Builder`の「小アイコンが無い」例外でアプリを落としていた。`Resources/drawable/ic_stat_bell.xml`（白い鐘のベクター）を足し、`BellPushService`はそれを小アイコンに使う。エミュレーターで本番のプッシュを受け、落ちずに通知が1件出ることを確かめた。
- 会話は最新行を錨にして並ぶ（a471-open-newest-android。Linuxの窓と同じ契約と同じ`NewestColumn`（`linux/BellTeam.Linux/NewestColumn.cs`をAndroidが取り込む）を`PhoneShell`が持つ）：開く・送る・新着・取り直しにスクロール命令も追いつきの動きも要らず、最新行が最初の枠から下にある。読み戻している間は何も動かない。33px刻みの`BottomFollower`は廃止した。古いページは、表示の上の描いた高さが`max(1画面, 上向きの速度の2秒分)`に満たない間だけ読み、開いた直後は描いた行が1画面に満たない間だけ読む（`HistoryPaging.NeedsOlderPage`・`NeedsFirstScreen`、`PhoneShell.NeedsOlder`。最初の表示後の背景の読み込みは廃止）。
- 「最新へ ↓」／「新着メッセージ ↓」のボタン（a471-latest-button-android。Linuxの窓と同じ動き）：`PhoneShell`が会話の下に重ねて持つ。最新から80px以上離れて読んでいる間に出て、読んでいる間に下へ行が届くと「新着メッセージ ↓」に変わり（見ている行は動かさない）、押すと`NewestColumn.FollowNewest`で最新へ戻って追従に戻る。最新の近くへ戻ると消える。
