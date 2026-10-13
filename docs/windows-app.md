# BellTeam for Windows

Mac版の`DesktopWorkspaceView`を基準に、WPFと.NETでWindowsの画面を描く。Web UIは表示しない。会話・プロフィールの正本は、Mac版と同じBellTeamのHTTP APIである。通信・JSONモデル・SSE・下書き・設定は`windows/BellTeam.Core`、Windowsの部品・Markdownの描画・窓の制御は`windows/BellTeam.App`へ置く。

LAN接続で一覧・会話・プロフィールを使う1段目に、画像・カード・書き出し・Botの画面の2段目を加えた。Appleの課金とAPNsの登録はWindowsへ移植しない。サーバーの通常会話APIのエラーは理由付きで表示する。現行の`src/supervisor.mjs`はmessenger・room-messenger・transportの`requireAccess`へ購読判定を渡しておらず、通常会話APIを購読状態で拒否する配線は有効になっていない。

## 画面と操作

- 左: メンバー・ルームの検索と一覧。ルームとメンバーの各一覧を新着順に並べる。検索は名前を対象とする。
- 中央: 選択した会話。最新30件から読み、以前のメッセージを追加で読める。SSEで一覧・会話を更新する。最新ページの既存行も更新し、配送状態や確定した本文を反映する。古い会話を読んでいる時は新着で末尾へ移動しない。
- 右: メンバーのプロフィール・AI、またはルームの共有する仕事と参加メンバー。メンバーの会話では中央と等幅、ルームでは280 DIP。詳細パネルは隠せる。
- `Ctrl+K`: 一覧の検索。入力欄の`Enter`: 送信。`Shift+Enter`: 改行。`Ctrl+Shift+I`: 詳細パネルの表示・非表示。
- ルームの「返信するメンバーを選択」で返信先を指定できる。未選択ではサーバーの自動選択へ渡す。自動選択が未設定の場合は、サーバーの拒否理由を表示する。
- 会話ごとに下書きと返信先を保持する。下書きはアプリを開いている間の状態で、終了時には保存しない。接続先の違う会話とは混在させない。
- 送信直後に本文を入力欄から外し、受付を待つ間は「送信中…」を表示する。失敗した本文は、送信中に書いた続きの前へ戻す。通信断など受付結果が不明な時は、再操作前に会話を更新するよう表示する。送信を自動で繰り返さない。
- MarkdownはMarkdigで解析してWPFのFlowDocumentへ描く。見出し、強調、引用、コード、リスト、チェック項目、表、リンクを表示し、本文の範囲選択・コピーができる。リンクは既定のブラウザーへ渡す。HTMLは文字として表示する。未対応の構文要素は、表示できない理由を該当メッセージに出す。
- Bot間の連絡は折り畳み、開くと本文を読める。
- 「画像を添付」、会話へのファイルのドロップ、入力欄への画像・画像ファイルの貼り付けで複数画像を添付できる。選んだだけでは送信しない。候補を取り外せ、画像だけでも送信できる。PNG・JPEG・WebP・GIFの元データを送信し、表示は先頭のフレームを使う。クリップボードのビットマップはPNGへ変換する。画像1枚はサーバーと同じ25MBまで。送信失敗時は画像も元の下書きへ戻し、送信中に追加した画像を残す。
- 会話の画像はBellTeamのAPIから読み、クリックすると別の窓で拡大する。複数画像は「前の画像」「次の画像」で切り替える。読込に失敗した時は理由を表示する。
- 秘密入力のカードでは「安全な入力欄を開く」からマスクされた専用欄を開き、「登録して続ける」または「入力を断る」を選ぶ。値は通常の会話・下書き・設定・診断へ入れず、専用POSTへだけ渡す。送信時、窓を閉じる時、非アクティブになった時に入力欄を消す。失敗時は例外の本文を出さず、結果を最新の状態で確認するよう表示する。登録済み・取消済みと、AIへの通知失敗も表示する。
- オーナーへの問いは、選択肢または許可されている「その他（文章で答える）」から回答する。回答中は重ねて送れない。SSEで同じ問いが更新されても書きかけを残し、回答済みになると答えを表示する。
- 「会話を書き出す」は、選択したメンバーまたはルームの会話をJSONとして、利用者が選んだ場所へ保存する。画像はサーバーが返す取得URLを含む。
- 「Botの画面を見る」は右の詳細欄を画面へ切り替える。表示中は2秒ごとに読み取り、失敗すると停止する。「再読込」で利用者が読み直せる。プロフィールへ戻る、会話を切り替える、詳細を隠す、窓を最小化する、窓を閉じる操作で更新を止める。詳細を隠す・最小化する時はプロフィールへ戻る。

推奨サイズは1280×820 DIP、最小サイズは1100×640 DIP。左の推奨幅は340 DIP。一覧の名前は16、補助文は14、本文・入力欄・プロフィールは18 DIPとする。WPFのベクター描画とPerMonitorV2を使う。窓の大きさ・位置・最大化状態をこのPCへ保存する。通常起動は利用者ごとに1つの窓だけで、再起動すると既存の窓を表示する。

接続先は初回の「接続先」で入力し、このPCの`%LOCALAPPDATA%\BellTeam\settings.json`へ保存する。HTTPS、またはlocalhost・LANのHTTPを受け付ける。判定は`web/server-origin.js`の通信条件と`ios/BellBot/Shared/ServerOrigin.swift`の接続先条件に合わせる。認証情報、パス、クエリー、フラグメント付きの接続先は断る。サーバーの利用者設定は埋め込まない。

SSEの切断・応答形式の異常は画面下部に表示する。「再接続」で利用者が接続し直す。常駐、タスクトレイ、自動起動、自動再試行、通知は入れない。閉じると終了する。

## このPCへの導入

PowerShell 7と.NET SDKがあるWindowsで、通常の利用者としてパッケージの外のPowerShell 7を開き、取り出してあるソースから実行する。導入・削除はCodexなどのパッケージ版アプリの中から実行しない。installerは.NETを同梱したビルドを作る。Gitの取得やブランチ・未commit差分の確認は行わない。配布するCPUは導入するPCのx64またはarm64に合わせる。依存の復元は.NET標準の処理に従い、未取得のNuGetパッケージがある場合はネットワーク接続が必要。

FOXのパッケージ版Codexから導入した時は、設定ファイルが`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\BellTeam\settings.json`に存在し、通常の利用者から読む`%LOCALAPPDATA%\BellTeam`とHKCUのアンインストール登録は存在しなかった。アプリ本体とスタートメニューは通常の利用者からも見えていた。Codex内からは設定と登録を読めたが、レジストリの実際の保存先は未確認。導入後の確認は、通常の利用者からも設定・登録・導入exeを読み、突き合わせる。

```powershell
pwsh -NoProfile -File scripts/install-windows.ps1 -ServerUrl 'http://サーバーのLANアドレス:18891' -NoLaunch
```

管理者権限は不要。`%LOCALAPPDATA%\Programs\BellTeam`へ導入し、スタートメニューとWindowsの「インストールされているアプリ」へ登録する。`-NoLaunch`を外すと導入後に起動する。接続先を省略すると既存の設定を保持し、初回起動時に入力する。

入れ直す時はBellTeamを閉じ、同じコマンドを実行する。設定はアプリ本体とは別の場所に保持する。アプリは現時点では未署名。ソースからビルドする導入方法であり、一般向けinstallerの配布はこの段階に含めない。

削除はWindowsのアプリ一覧、または次の入口から行う。

```powershell
pwsh -NoProfile -File scripts/install-windows.ps1 -Uninstall
```

削除後もこのPCの設定は残す。完全に設定を消す場合は、アプリ終了後に`%LOCALAPPDATA%\BellTeam`を利用者が削除する。

## 開発と確認

```powershell
dotnet test windows/BellTeam.slnx -c Release
dotnet publish windows/BellTeam.App/BellTeam.App.csproj -c Release -r win-x64 --self-contained true -o windows/artifacts/publish-win-x64
```

窓を作らずに通信だけを確認する。読み取り以外の要求は送らない。

```powershell
& './windows/artifacts/publish-win-x64/BellTeam.exe' --smoke-test 'http://サーバーのLANアドレス:18891' "$PWD/windows/artifacts/smoke.json"
```

`/api/session`、メンバーとルームの一覧、1つの会話、SSEの最初のイベントを確認し、成否・件数・失敗理由をJSONへ書く。成功は終了コード0、失敗は1。WinExeをPowerShellで実行して終了を待つ場合は、`Start-Process -WindowStyle Hidden -Wait -PassThru`で終了コードを受け取る。

画面の配置は、HWNDを作らずにWPFの部品を画像へ描いて確認できる。`Show`・`Activate`を呼ばず、設定も変更しない。

```powershell
& './windows/artifacts/publish-win-x64/BellTeam.exe' --render-preview "$PWD/windows/artifacts/preview.png"
& './windows/artifacts/publish-win-x64/BellTeam.exe' --render-url 'http://サーバーのLANアドレス:18891' "$PWD/windows/artifacts/live.png"
```

`--render-preview`は人工データ、`--render-url`は実サーバーの読み取り結果を使う。画像とsmoke結果には会話・プロフィールが含まれ得るため、生成物はgit管理外とする。`--configure <URL>`は窓を出さず、このPCの接続先だけを保存する導入用の入口。

画像の読み込みにはWindows標準の`Windows.Graphics.Imaging.BitmapDecoder`を使い、WPFへ描く。SDKの参照はWindowsの版を付けたTargetFrameworkから.NETが取得する。追加のWindows App SDK runtimeは使わない。`--render-preview`は画像とカードを含む人工データを1280×1200で描く。

### 確かめた事

FOXでReleaseビルドと.NET同梱ビルドが成功。URL、設定の保存、実際のAPIと同じJSON、HTTPの拒否・認証・JSON不正、SSEのUTF-8・複数行・切断、下書き、返信先、会話切替の競合、配送状態の更新、Markdownの単体試験が成功した。試験は窓を表示しない。`<pasted_content>`を含む行と行頭から始まるHTML風の塊は、タグ・中身・前後の段落を文字として読めることを追加試験で確認した。

FOXのパッケージ版Codex内から起動した確認用プロセスで、LANの本番サーバーへの読み取りsmokeが成功し、local認証、メンバーとルームの一覧、会話履歴、SSEの接続を確認した。同じ実行環境で人工データと実データをPNGへ描き、3ペイン、日本語本文、プロフィール、Markdownの見出し・強調・引用・コード・表の配置を確認した。

2026-10-13 10:56 JST、Codex内からmainの`d817648`を`-NoLaunch`で導入した。Codex内では設定とアンインストール登録を読めたが、11:03〜11:05 JSTにトロニーが通常の利用者と管理者から読むと、通常の設定先とHKCUの登録は存在しなかった。このため、Codex内だけの確認を利用者への導入確認として扱わない。10:57 JSTにCodex内から起動した導入exeのsmokeは成功した。

11:07:52〜11:08:04 JST、トロニーがFOXの通常の利用者`kite_`・非管理者・パッケージ外・窓なしで、同じinstallerを`-NoLaunch`付きで実行した。ソースは`windows-install-evidence`の`0890c11`で、mainの`d817648`との差はこの文書だけ。`GetCurrentPackageFullName`の結果は15700だった。11:08:25 JSTに同じ利用者から次を確認した。

- 導入先: `%LOCALAPPDATA%\Programs\BellTeam`、404ファイル、`uninstall-windows.ps1`あり。11:08時点のソースは文書の枝。スタートメニューの`BellTeam.lnk`は11:08:04 JSTに登録。
- 設定: `%LOCALAPPDATA%\BellTeam\settings.json`が11:08:02 JSTに保存され、内容は`{"serverUrl":"http://192.168.1.2:18891/","window":null}`。
- 登録: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BellTeam`。DisplayNameはBellTeam、DisplayVersionは0.1.0、Publisherはkitepon。InstallLocationは導入先、UninstallStringとQuietUninstallStringはPowerShell 7から導入先の`uninstall-windows.ps1`を呼ぶ。NoModifyとNoRepairは1。
- 導入exeのsmoke: 11:08:05 JSTに通常の利用者から実行し、終了コード0・ok=true。local認証、36メンバー、3ルーム、会話10件と以前の履歴の存在、SSE接続を確認。終了後のBellTeam.exeは0件で、マビノギとOpenLogicool.Hostは動いたまま。

11:14:02〜11:14:10 JST、トロニーが同じ利用者・非管理者・パッケージ外・窓なしでmainの`e96c9a7`から再導入した。exeの版は`0.1.0+e96c9a7fc42f21d480362f4ebbaea90fb8c45e50`。接続先の設定とアンインストール登録は入れ直し前後で同じ。11:14:12 JSTの導入exeのsmokeも終了コード0・ok=trueで、同じ一覧・履歴・SSEの接続を確認し、終了後のBellTeam.exeは0件だった。

アプリ共通のCoreを使った送受信は、出荷exeへ送信専用の入口を足さず、Codex内から起動したgit管理外の確認用の道具で試した。10:57 JSTの初回は、送信の受付と指定文の履歴への記録、トロニーの席への到達を確認した。トロニーのサーバー確認では、通話で始まった番への差し込みと重なり、返答が会話へ記録されなかった。確認用の道具も、引用中の「受け取った」を別の報告文から拾っていたため、その結果を返答の確認とは扱わなかった。

トロニーの指示で、11:01 JSTに待ち行列が0件であることを確認し、前置きの通話を入れずに2回目を1通だけ送った。SSEの新着からincomingの本文「受け取った」を完全一致で確認した。初回・2回目とも送信の自動再試行はしていない。アプリと確認用のプロセスはすべて終了している。

Windows nativeの`npm test`は426件中397件成功・29件失敗。例えば`test/bot-environment.test.mjs`とサーバーinstaller試験は`spawn sh ENOENT`、配布archive試験は`docs/onboarding.md`の収録確認で失敗した。サーバーの試験はLinuxコンテナで確認する。PRの初版はトロニーがLinuxコンテナで426件すべての成功を確認した。Windows版の変更は`src/`・`test/`・`web/`・`config/`を含まない。

2段目は、Codex内で模擬HTTP応答とローカルHTTPサーバーを使って、画像付き・画像だけの送信、送信中の画像追加と失敗時の復元、画像・カードのJSON、回答と書き出し、PNG・JPEG・WebP・GIFのデコードを確認した。秘密入力はダミーの値だけで、専用のPOST、307を追わないこと、例外・画面のエラー・標準出力に値を出さないこと、入力欄の送信失敗・非アクティブ化・終了時の消去を確認した。Bot画面の更新がプロフィールへ戻る操作で停止すること、問いの更新で書きかけが残ることも確認した。

11:38 JSTに、Codex内の確認用の道具から本番を読むだけで、Bot画面、122件を含む会話のJSON書き出し、PNG画像の取得と1295×855でのデコードを確認した。36席の直近30件までの会話を読み、オーナーへの問い4件のJSONも読み取れた。秘密入力の登録・取消、問いへの回答、画像送信などの試しのPOSTは本番へ送っていない。人工データのPNGでは画像・秘密入力カード・問いの選択肢と入力欄を確認した。

### 見ていない事と次の確認

- 前面に表示した実際の窓での操作、IMEの変換確定、範囲選択・コピー、複数モニター・表示倍率を変えた時の表示、二重起動時の既存窓の表示は未確認。FOXでは別のBotが画面を操作しているため、担当者と時刻を合わせて確認する。
- 同じ接続先を指定した入れ直しはトロニーが実行済み。接続先を省略した更新での設定保持とアンインストールの実行は未確認。導入前にinstaller・uninstallerのPowerShell構文を確認し、通常の利用者から削除の入口が登録されたことを確認した。
- arm64のビルドと端末上の動作は未確認。
- 2段目の利用者による実画面操作（画像のファイル選択・ドロップ・貼り付け・拡大、保存ダイアログ、カードの操作、Bot画面の表示）と、2段目の導入は未確認。秘密入力は本番の依頼を使って試さず、模擬応答で確認する。mainへの取り込み後の導入と、通常の利用者からの確認はトロニーが行う。
- Cloudflare Access、管理、通知は後続の段階。現段階でそれらを使う画面は提供しない。

## 後続の段階

2段目をmainへ取り込み、通常の利用者から導入と必要な実画面の確認を行った後に続ける。

1. 3段目: メンバー編集、AI設定、アバターの切り抜き、ルームの作成・編集・削除、予定、機能設定、利用者の決まり、オーナーのプロフィール。
2. 4段目: Cloudflare Access、AIの認証、初回設定、アプリが起きている間のWindows通知。通知は既定でオフ。

## 資料

- [Mac版の画面・操作](mac-app.md)
- [WPFのFlowDocument](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/advanced/flow-document-overview)
- [JSONの必須プロパティ](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties)
- [Markdig](https://github.com/xoofx/markdig)
- [デスクトップアプリでのWindows Runtime API](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-apis-desktop-apps)
