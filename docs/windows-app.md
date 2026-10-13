# BellTeam for Windows

Mac版の`DesktopWorkspaceView`を基準に、WPFと.NETでWindowsの画面を描く。Web UIは表示しない。会話・プロフィールの正本は、Mac版と同じBellTeamのHTTP APIである。通信・JSONモデル・SSE・下書き・設定は`windows/BellTeam.Core`、Windowsの部品・Markdownの描画・窓の制御は`windows/BellTeam.App`へ置く。

この版はLAN接続で会話する1段目。Appleの課金とAPNsの登録はWindowsへ移植しない。サーバーの通常会話APIのエラーは理由付きで表示する。現行の`src/supervisor.mjs`はmessenger・room-messenger・transportの`requireAccess`へ購読判定を渡しておらず、通常会話APIを購読状態で拒否する配線は有効になっていない。

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

推奨サイズは1280×820 DIP、最小サイズは1100×640 DIP。左の推奨幅は340 DIP。一覧の名前は16、補助文は14、本文・入力欄・プロフィールは18 DIPとする。WPFのベクター描画とPerMonitorV2を使う。窓の大きさ・位置・最大化状態をこのPCへ保存する。通常起動は利用者ごとに1つの窓だけで、再起動すると既存の窓を表示する。

接続先は初回の「接続先」で入力し、このPCの`%LOCALAPPDATA%\BellTeam\settings.json`へ保存する。HTTPS、またはlocalhost・LANのHTTPを受け付ける。判定は`web/server-origin.js`の通信条件と`ios/BellBot/Shared/ServerOrigin.swift`の接続先条件に合わせる。認証情報、パス、クエリー、フラグメント付きの接続先は断る。サーバーの利用者設定は埋め込まない。

SSEの切断・応答形式の異常は画面下部に表示する。「再接続」で利用者が接続し直す。常駐、タスクトレイ、自動起動、自動再試行、通知は入れない。閉じると終了する。

## このPCへの導入

PowerShell 7と.NET SDKがあるWindowsで、取り出してあるソースから実行する。installerは.NETを同梱したビルドを作る。Gitの取得やブランチ・未commit差分の確認は行わない。配布するCPUは導入するPCのx64またはarm64に合わせる。依存の復元は.NET標準の処理に従い、未取得のNuGetパッケージがある場合はネットワーク接続が必要。

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

### 確かめた事

FOXでReleaseビルドと.NET同梱ビルドが成功。URL、設定の保存、実際のAPIと同じJSON、HTTPの拒否・認証・JSON不正、SSEのUTF-8・複数行・切断、下書き、返信先、会話切替の競合、配送状態の更新、Markdownの単体試験が成功した。試験は窓を表示しない。`<pasted_content>`を含む行と行頭から始まるHTML風の塊は、タグ・中身・前後の段落を文字として読めることを追加試験で確認した。

FOXからLANの本番サーバーへの読み取りsmokeで、local認証、メンバーとルームの一覧、会話履歴、SSEの接続を確認した。人工データと実データのPNGで、3ペイン、日本語本文、プロフィール、Markdownの見出し・強調・引用・コード・表の配置を確認した。本番へ試しの文は送っていない。

Windows nativeの`npm test`は426件中397件成功・29件失敗。例えば`test/bot-environment.test.mjs`とサーバーinstaller試験は`spawn sh ENOENT`、配布archive試験は`docs/onboarding.md`の収録確認で失敗した。サーバーの試験はLinuxコンテナで確認する。PRの初版はトロニーがLinuxコンテナで426件すべての成功を確認した。Windows版の変更は`src/`・`test/`・`web/`・`config/`を含まない。

### 見ていない事と次の確認

- 前面に表示した実際の窓での操作、IMEの変換確定、範囲選択・コピー、複数モニター・表示倍率を変えた時の表示、二重起動時の既存窓の表示は未確認。FOXでは別のBotが画面を操作しているため、担当者と時刻を合わせて確認する。
- 実際の送信と返答によるSSE更新は未確認。PR後にトロニーの席へ1通だけ送り、受付と返答を確認する。
- 実際の導入・入れ直し・アンインストールは未確認。mainへの取り込み後に担当者と時刻を合わせて行う。導入前にinstallerのPowerShell構文を確認した。
- arm64のビルドと端末上の動作は未確認。
- Cloudflare Access、画像、カード、管理、通知は後続の段階。現段階でそれらを使う画面は提供しない。

## 後続の段階

1段目をmainへ取り込み、FOXで導入・送信・実画面を確認した後に続ける。

1. 画像の添付と表示、秘密の入力、オーナーへの問い、会話の書き出し、Botの画面。
2. メンバー編集、AI設定、アバターの切り抜き、ルームの作成・編集・削除、予定、機能設定、利用者の決まり、オーナーのプロフィール。
3. Cloudflare Access、AIの認証、初回設定、アプリが起きている間のWindows通知。通知は既定でオフ。

## 資料

- [Mac版の画面・操作](mac-app.md)
- [WPFのFlowDocument](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/advanced/flow-document-overview)
- [JSONの必須プロパティ](https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/required-properties)
- [Markdig](https://github.com/xoofx/markdig)
