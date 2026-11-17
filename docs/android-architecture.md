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
- LAN上のサーバーは平文のhttpなので、Androidの`UsesCleartextTraffic`を有効にする（接続先の検査は`ServerOrigin`が行い、httpsかlocalhost・LANのhttpだけを通す）。
- 書き込み（POST・PUT・DELETE）は自動で再送しない。SSEと一覧の読み直しは、Coreの上限付きバックオフ（`ReconnectBackoff`）で再試行を続ける。起動の失敗画面は同じ間隔で自動再試行し、回数の上限で打ち切らない。

## 現在の範囲と順序

1. 済：接続先の入力・起動の各画面（Mac版と同じ）・会話一覧（アバター・在席・要約）・会話（履歴・返信/転送/コピーの印・送信）・戻る。エミュレーター（API 36）で本番サーバーに接続して確認。
2. 次：設定（頁）・画像ビューア・添付・通知・工程表と相関図と決裁箱の頁・購読（Google Play Billing。a157はBready）。
3. 配布：署名鍵・applicationId `dev.kitepon.bellteam`・AABのbuild・Google Play Consoleの内部テストへのアップロード（Play Consoleの操作はオーナーのアカウントが要るため、トロニー経由で申請する）。

## 開発の手順

- .NET 10 SDK（`~/.dotnet`）、`dotnet workload install android`、JDK 17、Android SDK（`~/Android/Sdk`）が要る。`dotnet build -c Debug -t:Install -p:AndroidSdkDirectory=$ANDROID_HOME -p:JavaSdkDirectory=$JAVA_HOME` で接続中の端末またはエミュレーターへ導入する。
- 画面の確認は端末で行う（`adb exec-out screencap -p`）。本番のサーバーへつなぐ時は、送信など書き込みを伴う操作をしない。
