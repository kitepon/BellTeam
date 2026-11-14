# Linuxアプリの機能図と作業手順

担当はネオン（`bot-208dcbab`）。この文書をLinux製品内部の機能図とデータの流れ図の正本とする。本体側の接続登録は[Linuxアプリ](architecture/modules/linux/README.md)、担当と変更手順は[機能担当と変更の手順](architecture/module-ownership.md)を参照する。

オーナー裁定（2026-11-12、工程 t24）：見た目はMac、コードはWindows。画面・配置・部品・状態の印・操作の流れ・文言はMac版（`ios/`、Mac Catalyst）に揃える。コードはWindowsアプリの共通部品`windows/BellTeam.Core`（plain `net10.0`）をそのまま参照し、Linuxで新しく作るのは画面の層だけとする。画面の部品はAvalonia（.NET 10）。OSの違いだけをLinuxの作法へ置き換える（⌘→Ctrl、窓の操作はデスクトップ環境の装飾、通知はfreedesktop通知）。Mac版の購入とAPNsの登録は移植しない（Windowsと同じ）。

## 機能図

```mermaid
flowchart LR
  user[利用者] --> ui[Linux画面・操作<br/>linux/BellTeam.Linux<br/>Avalonia]
  ui --> ws[会話の状態・一覧・送信・SSE・再接続・下書き<br/>Workspace&lt;TImage&gt; in BellTeam.Core]
  ui --> core[通信・モデル・工程表・相関図・更新・端末設定<br/>windows/BellTeam.Core]
  ws --> core
  ui -->|IImageCodec&lt;Bitmap&gt;・UIスレッド| ws
  core -->|HTTP API・SSE| integration[BellTeam共通入口<br/>モリー]
  core --> local[このPCの設定・認証情報<br/>~/.local/share/BellTeam]
  ui --> notify[freedesktop通知<br/>org.freedesktop.Notifications]
  ui --> single[1利用者1窓<br/>$XDG_RUNTIME_DIR のUnixソケット]
  release[公開版 linux-app<br/>GitHub Releases・publish-linux-app.yml] -->|tar.gz・SHA256SUMS| install[install-linux.sh]
  install --> files[~/.local/lib/BellTeam・~/.local/bin/bellteam<br/>.desktop・アイコン]
  integration --> server[BellTeam本体の各機能]
```

- `BellTeam.Core`の所有者はアニス。LinuxはそのままProject参照で使い、Coreを変える時は小さなPRでアニスをレビューに入れる。条件はWindowsの挙動を変えないこと、[Windowsアーキテクチャ](windows-architecture.md)のCoreの節を同じ差分で更新すること、実行したBellTeam.Testsの範囲をPRに書くこと（2026-11-12 アニス合意）。
- `Workspace`（会話一覧・会話・送信・SSE・再接続・下書き）はWindowsの`BellTeam.App`からCoreへ移し、画像の型とUIスレッドへの戻りだけを各アプリが渡す。Windowsは`Workspace : Core.Workspace<BitmapSource>`で呼び出し側を変えない。
- 本体の状態は共通入口のHTTP APIとSSEだけで使う。本体の内部状態を直接読み書きしない。

## データの流れ

```mermaid
flowchart TD
  input[キー入力・クリック・貼り付け画像] --> view[Avalonia画面]
  view -->|送信・編集・操作| ws[Workspace / 各Api]
  ws -->|HTTP要求| api[BellApi・ManagementApi ほか]
  api -->|JSON| server[(BellTeam本体)]
  server -->|SSE text/event-stream| sse[SseReader]
  sse --> ws
  ws -->|一覧・会話・状態の更新| view
  api -->|画像のbyte列| codec[IImageCodec&lt;Bitmap&gt;]
  codec --> view
  ws -->|新着| notify[freedesktop通知]
  settings[(settings.json・cookie<br/>~/.local/share/BellTeam)] <--> local[LocalSettings・AccessCookies]
  local --> api
  second[2つ目の起動] -->|Unixソケット| first[起動中の窓を前へ]
```

- 接続先・窓の大きさ・通知の設定・ログイン情報はCoreの`LocalSettings`（`SpecialFolder.LocalApplicationData`＝`$XDG_DATA_HOME`、既定`~/.local/share`）の`BellTeam/`に置く。アプリ本体とは別の場所で、削除しても残す。
- 書き込み（POST・PUT・DELETE）は自動で再送しない。SSEと一覧の読み直しは、Windowsと同じ上限付きバックオフで再試行を続ける（Coreの`ReconnectBackoff`）。

## 画面構成

Mac版と同じ構成で、[Windowsアーキテクチャ](windows-architecture.md)の「画面構成」の図と同じ部品・窓・シートを持つ（主窓1280×820・最小1100×640、サイドバー320〜420、詳細パネル、設定の項目一覧、主窓に重ねるシート、工程表と相関図の別窓）。Linuxでの置き換えは次だけとする。

| Mac | Linux |
| --- | --- |
| ⌘K・⌘2・⌘3・⌘4・⌘5・⌘,・⌘⇧I | Ctrl+K・Ctrl+2・Ctrl+3・Ctrl+4・Ctrl+5・Ctrl+,・Ctrl+Shift+I |
| 窓の信号ボタン・タイトルバー | デスクトップ環境の窓装飾 |
| macOS通知・APNs | 起動中だけのfreedesktop通知（既定はオフ） |
| 購入（StoreKit） | 「利用と課金」は案内とリンクだけ |
| Mac版の更新 | 設定の「アップデート」はBellTeam本体の更新（共通Update API）。アプリ自身の更新は導入手順の再実行 |

- 設定の「端末」は、Windowsの「このPCを追加」「このPCを確かめる」（16c）とオプション機能の案内を出さない。Coreの`ThisPc`がWindowsのOpenSSH鍵の置き場を読むためで、Linuxでは`NoThisPc`で自端末を持たない扱いにする。「通知」のスイッチは`DesktopNotifications`（`INotificationSwitch`）を切り替え、`SettingsStore.NotificationsEnabled`へ保存する。配信は`FreedesktopNotificationSink`がD-Bus（`org.freedesktop.Notifications`）で行い、通知を押すとその会話を開く。
- 工程表の窓の待ちの流れは、Mac版と同じく既定で閉じて右端のつまみ（砂時計と件数。止まりの作り手を待つ行があれば件数を赤）にし、つまみで開いてパネルの閉じるで畳む。開閉はアプリを開いている間だけ`LatticeChartPage.WaitsOpen`が覚える（保存しない）。上の帯は「切り替え・ライブ・ツリー/担当/過去ログ N」と「進み具合・数」の2つのまとまりで、1行に入らない幅では後ろのまとまりを2行目へ送る（Owner 2026-11-14、task a75）。進み具合の輪の数は、3桁でも輪の内側に収まる大きさへ縮める。
- 工程表の窓の一番左上は切り替えのボタン（戻る矢印・工程表の名前・下向きの印）で、押すと一覧（すべての工程表）へ1回で移る。一覧は縦に送る1枚の画面で、工程表が何枚でも全部選べる。Mac版の切り替えの小窓（行が440ptを超えると送る）と左上の「すべての工程表」ボタンは、Linuxでは切り替え自体が一覧を開くため足さない（Windowsと同じ。task a88）。
- 会話の右の欄の「AIと操作」には、そのメンバーが作った工程表（一覧の`createdBy`）ごとに「工程表「名前」を開く」のボタンを出し、押すと工程表の窓でその工程表を開く（Mac a91、task a93）。一覧はメンバーを表示するたびに1回だけ読む（`ProfileView.LoadChartsAsync`）。古い本体（404）とログインが必要な時はボタンを出さない。それ以外の失敗は「工程表の一覧を読めませんでした。再試行しています…」と出し、Coreの`ReconnectBackoff`の間隔で読めるか別のメンバーを表示するまで読み直す。
- Cloudflare Accessのブラウザーでのログイン（WindowsはWebView2）はLinuxにまだ無い。ログインが必要な接続先では、その旨と「接続先を変更」を出す。LANのHTTP接続には要らない。

## 導入と更新

導入も更新も、ターミナルで次の1行を実行する（x64・arm64のLinux、通常の利用者、管理者権限・.NET・ソースの取得は不要）。

```sh
curl -fsSL https://github.com/kitepon/BellTeam/releases/download/linux-app/install-linux.sh | sh
```

- 接続先を一緒に保存する時は末尾を`| sh -s -- --server-url http://サーバーのLANアドレス:18891`にする。省略すると既存の設定を保持し、初回起動時に入力する。導入後に起動しない時は`--no-launch`。
- 更新は同じ1行をもう一度実行する（BellTeamを閉じてから）。設定とログイン情報は`~/.local/share/BellTeam`にあり、更新でも削除でも残る。
- 削除は`| sh -s -- --uninstall`。本体・起動用リンク・アプリ一覧の登録だけを消す。

installerは公開版`linux-app`から、このCPUの`BellTeam-linux-<x64|arm64>.tar.gz`（.NET同梱）と`SHA256SUMS`を取り、照合してから`~/.local/lib/BellTeam`へ置き、`~/.local/bin/bellteam`とアプリ一覧の`~/.local/share/applications/bellteam.desktop`を登録する。取得できない・照合が合わない時は何も入れずに理由を出して終わり、もう一度実行すれば取り直す。開発者はソースから`scripts/install-linux.sh --from-source`で同じ導入を行える（.NET 10 SDKが要る）。

導入と削除が置き換え・削除するのは、このinstallerが置いた物だけとする（既存の別の物を上書き・削除しないため）。本体のフォルダは印のファイル`.bellteam-installer`を持つ（印が無い最初の版の配置`BellTeam`と`bellteam.png`も含む）こと、`~/.local/bin/bellteam`は導入した本体へのシンボリックリンクであること、`bellteam.desktop`は導入した本体を`Exec=`で起動することで見分ける。どれかが別の物なら、何も変えずにその場所を名指しして終了する。利用者がその物を別の場所へ移すか不要なら消して、もう一度実行すれば進む。

## 公開

公開は`.github/workflows/publish-linux-app.yml`を既定ブランチで手動実行する（担当はネオン）。Linuxの試験を通してから`scripts/package-linux-app.sh`で2つのCPUの配布物・`SHA256SUMS`・`install-linux.sh`を作り、GitHubの公開版`linux-app`（タグも同名で、公開した版のcommitへ動かす）の中身を置き換える。題名に`linux/BellTeam.Linux`の`Version`を出す。この公開版は「Latest」にしない。「Latest」は本体の更新カタログが使い（`scripts/container-update-host.py`）、カタログの選び方は`updates-`で始まるタグだけを読むため、`linux-app`はカタログに混ざらない。

## まだ無いものと計画

```mermaid
flowchart LR
  subgraph G1[Cloudflare Accessのログイン]
    a1[ログインが必要と判定<br/>StartupRoute.SignIn] --> a2[既定のブラウザーでAccessのログインを開く<br/>xdg-open]
    a2 --> a3[ログイン後のtokenを<br/>127.0.0.1の一時的な待受けで受け取る]
    a3 --> a4[AccessCookiesへCF_Authorizationとして入れる<br/>~/.local/share/BellTeamへ保存]
    a4 --> a5[BellApiのcookieで接続を再開]
  end
  subgraph G2[このPCを追加 16c]
    b1[Core IThisPcにOSごとの実装を足す<br/>アニスのレビュー] --> b2[Linux: /etc/ssh/ssh_host_*_key.pub・sshdの稼働・ネットワークの一覧]
    b2 --> b3[設定の「端末」に「このPCを追加」「このPCを確かめる」を出す]
  end
```

- Cloudflare Accessのログイン：今はログインが必要な接続先でその旨と「接続先を変更」を出すだけで、LANの外からは使えない。WindowsはWebView2の中でログインしてcookieを取り出す。Linuxは埋め込みのブラウザーを持たないため、既定のブラウザーでログインし、Accessがログイン後に渡すtokenを手元の一時的な待受けで受け取る方式を計画する（`cloudflared access login`と同じ受け渡し）。受け取り方はAccess側の実際の動きで確かめてから作る。
- このPCを追加（16c）：Coreの`ThisPcSystem`がWindowsのOpenSSHの鍵の置き場を読むため、Linuxは`NoThisPc`で出していない。Coreの`IThisPc`にLinuxの実装（ホスト鍵の公開鍵・sshdの稼働・インターフェースの一覧）を足すPRをアニスのレビューで出し、Windowsの動きは変えない。

## 開発と確認

```sh
dotnet build linux/BellTeam.Linux.slnx -c Release
dotnet test linux/BellTeam.Linux.slnx -c Release
```

試験は窓を表示しない。実画面での受け入れは、GNOME（Wayland）の実画面で導入手順から起動して行う。
