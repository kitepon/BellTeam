# Windowsの通知・ログアウトと前面確認

Mac版のログアウトと認証操作へ合わせ、このPCの通知、未選択時のファスト表示、横長での読みやすさ、二重起動時の位置保存を修正した。

| 画面 | 人工データの非表示描画 |
| --- | --- |
| Cloudflare接続のログアウト | [logout.png](assets/windows-notifications-ui/logout.png) |
| このPCの通知 | [notifications.png](assets/windows-notifications-ui/notifications.png) |

## 通知

既定はオフ。設定はこのPCに保存し、起動中のSSE更新による新しい相手の文をWindowsの通知へ送る。初回読込・手動更新・自分の送信・Bot間の連絡・途中の報告では通知しない。開いている会話を前面で読んでいる時も通知を省く。クリックで同じ接続先の会話へ移る。ログアウト・接続先変更・オフ・終了で通知を消し、閉じた後にアプリを起こす登録や常駐は持たない。

通知の表示はメンバー名・ルーム名と固定の案内だけにする。会話本文、入力依頼の説明文、入力された値は含めない。案内は「返信が届きました。」「ルームに新しいメッセージが届きました。」「秘密情報の入力が必要です。」「選んでほしいことがあります。」を使う。

Windows組込のToastNotificationManagerを使う。追加のWindows App SDKやRuntimeの導入は不要。installerが既存のスタートメニューへWindows標準のAppUserModelID付きショートカットを作る。Windowsの通知設定は尊重する。通知要求の同期例外と非同期のFailedは画面へ表示し、その起動中の通知を止める。自動で繰り返さない。

23:41:51〜23:41:55 JSTにトロニーが通常の利用者・非管理者・パッケージ外から非表示の試験を実行し、終了コード0を確認した。試験はポップアップを抑止し、音を消した通知を1件送り、Windows APIで履歴1件を読み、消去と試験用リンク削除を行った。後のBellTeam.exeとBellTeam.UiChecks.exeは0件、AppUserModelIdの鍵は増えていなかった。画面のポップアップとクリックは未確認。

試験用入口は`BellTeam.UiChecks --notification-silent`。製品の実行ファイルへ試験の文を送る入口は加えていない。

## ログアウトと認証操作

Cloudflare接続の設定だけにログアウトを出す。APIとWebView2のCookieを消し、下書きと表示中の会話を破棄する。接続先変更時も同じ処理を行う。未使用のHTTPS接続ではWebView2を起こさず、使用済みプロファイルでRuntimeを開けない場合は日本語の理由を表示する。

同じ接続先を入れ直した時は、ログインと下書きを保持して再接続する。別の接続先へ変えた時だけログアウトを通す。通知本文に会話プレビューが混ざらないことを4種類で確認し、同じ接続先の再入力で下書きが消えないことも非表示の操作確認へ含めた。

入力を含むPOSTだけは値をエラーへ出さない形に包む。AI選択・認証開始・取消・案内役開始のHTTP拒否では、サーバーの日本語の理由を表示する。再認証の確認は「始めない」「今の認証を手放して始める」。

## FOXでの前面確認

0.4.1を23:00:43〜23:15:20 JSTに確認した。マビノギのBot入力を担当者が止めた時間だけ実施し、マビノギとOpenLogicoolの窓には触れなかった。送信・設定保存・予定実行と削除・AI認証開始と入力と取消は押していない。未送信の下書きを最後に消し、送信ボタンが無効になることを確認。終了後のBellTeam.exeとBellTeam.UiChecks.exeは0件で、トロニーも23:16:09に通常の権限から0件を確認した。

確認できたのは、一覧検索、アバターと3ペイン、プロフィール、予定と設定と会話の切替、下書き保持、SSEの新着表示、本文の範囲選択とコピー操作、画像選択ダイアログの表示と取消、書出し保存ダイアログの表示と取消、AI認証一覧とCodexの状態をGETで開いて閉じること、最大化と通常サイズへの復帰。二重起動直後の窓一覧は既存の1窓だった。

未選択時のファストの印、横長の本文、終了時の位置保存エラーを発見した。未表示のWPF窓のRestoreBoundsはEmptyで、JSONへ保存できないInfinityになることを再現した。二重起動の判定をMainWindow作成より前へ移し、第2プロセスでは窓を作らない。ファストの表示は選択状態から必ず真偽値を返し、吹き出しを最大900 DIP、プロフィールを最大760 DIPへ収める。全窓のHWNDを作らない操作確認で表示と横幅を検証した。

通常のsettings.jsonは更新されていなかったが、Codex専用領域のsettings.jsonは23:14:29にwindowの有限な値で更新されていた。通常の利用者の設定とCodex内の設定を混同せず、次の前面確認では通常の利用者から起こした導入exeを使う。

### 通常の利用者から起動した修正版の確認

2026-10-14 00:55:56 JSTにトロニーが通常の利用者・非管理者・パッケージ外からスタートメニューのリンクで0.4.2を起動した。許可された01:04までの時間内に、ベルがWindows用Computer Useで設定ページを操作した。マビノギとOpenLogicoolの窓には触れていない。

- 二重起動前の00:59:26と、トロニーが2つめを起動した後の01:00:17に、同じプロセス11884・同じ窓93261534が1つであることを確認した。設定ページは保たれ、エラー画面は出なかった。
- 「このPCの通知」をオンにし、「アプリが起きている間だけ通知します。」を確認した。トロニーの会話を開かず、01:01:30の本物の知らせが一覧へ届いた。通知のエラーは表示されなかった。
- Computer Useが返す画像はBellTeamの範囲で、窓一覧にも通知のポップアップは返らなかった。ポップアップが表示されたか、固定文だったか、クリックで会話へ移るかは確認できていない。通知の表示失敗と断定しない。
- 通知をオフへ戻し、「通知はオフです。」を画面で確認してから閉じるボタンで通常終了した。01:02:15にBellTeam.exe・BellTeam.UiChecks.exe・Computer Useの補助プロセスはいずれも0件。操作セッションもリセットした。
- 送信・予定操作・AI認証操作・設定の保存は押していない。通知のオンとオフだけを変更した。日本語入力・画像・書き出しは、この後にオーナーが操作する段取りのため触れていない。

01:02:43 JSTにトロニーが通常の利用者からsettings.jsonを読み、01:02:09の保存内容がleft=3291・top=208・width=1244・height=1011・maximized=falseの有効なJSONで、notificationsEnabled=falseと確認した。BellTeam.exeは0件。二重起動は01:00:02に行われ、01:00:28にも既存の1プロセス・同じ位置の窓が前面にあり、設定の更新時刻は二重起動前の00:59:13のままだった。第2プロセスは設定を上書きしていない。

通知をオフにした後の01:02:25 JSTに、同じ利用者からToastNotifier.Setting=Enabled、通知履歴0件を確認した。Windowsの通知の控えにはBellTeam.Desktopのapp:desktop登録が新着と同じ01:01:30に作られていた。通知要求がWindowsまで届いた証拠として記録し、ポップアップとクリックの確認とは扱わない。

### 画像閲覧版の取り込みと導入

PR #18はトロニーが全差分を読み、Linuxコンテナでサーバー試験434件・失敗0を確認してmainへ取り込んだ。2026-10-14 01:02:55〜01:03:06 JSTに通常の利用者から再導入し、exeの版は0.4.3+880f9f0a46f65e4c932123cc53f6cfb268b43d1a。導入exeの読み取りsmokeは成功し、42メンバー・3ルーム・SSE接続を確認した。01:03からの本人操作はこの版で行う段取りで、結果待ち。

## 残る確認

### 実装の確認と実環境での確認の違い

| 対象 | 得られている根拠 | 実環境で残る確認 |
| --- | --- | --- |
| 一覧・会話・詳細、予定・設定の配置 | Macの5画面と同じ人工データによる比較、FOXでのページ切替・検索・プロフィール表示 | 表示倍率を変えた時と複数モニターでの表示 |
| 送受信・下書き・Markdown | API・Workspace・改行の試験、Coreから本番へ送った指定の1通とSSEの返事、FOXでの下書き保持 | IMEの変換確定、Shift+Enter、コピー先との内容照合 |
| 画像・カード・書き出し | PhaseTwoTests・GalleryTests、人工画像とカードの描画、本番GETによる画像取得・書き出しJSON、FOXでの標準ダイアログ表示と取消 | 添付確定・貼り付け・ドロップ・拡大・ファイルの実保存。カードへの試しのPOSTは本番へ送らない |
| メンバー・ルーム・予定・各種設定 | PhaseThreeTests・PlanningTests・FastModeTestsの模擬保存、編集画面の非表示描画 | 本番の設定を変える操作は試さない。利用中の不具合報告は再現して修理する |
| Access・AI認証・初回設定 | AccessSetupTests・HarnessAuthenticationTests、模擬Cookieの別プロセス保存・復元・消去、公式状態の本番GET | 本人のAccessログイン。AI認証開始と初回設定は本番で試さないため、実際の認証完了は未確認 |
| 起動中の通知 | NotificationTests、通常の利用者からの非表示通知と履歴読取、FOXでのオン・オフ保存、実際の新着によるWindowsへの要求到達 | ポップアップ・固定文の実表示・クリックによる会話の選択 |
| 導入・二重起動・終了 | トロニーの通常権限による導入・smoke、1窓維持、通常終了後の位置保存・通知オフ・プロセス0件 | 接続先を省略した更新とアンインストールの実行は未確認 |

以下は未確認のまま残す。

- 日本語IMEの実変換とShift+Enter。
- コピー先へ貼り付けて内容を照合すること。
- 画像ファイルの確定・ドロップ・貼り付け・拡大。
- 書き出したファイルの実保存。
- 表示倍率の変更と複数モニター。
- 通知の実際のポップアップとクリックによる会話の選択。
- 本人のCloudflare Accessログイン、実際のAI認証と初回設定。

本人操作と通知の再確認は、トロニーを通して調整する。今回の許可時間は終了しており、ベルは画面操作を再開しない。操作ツールが取得できなかったポップアップや、前回の標準ダイアログの操作は成功扱いにしない。

## 0.6.0の導入（2026-11-16）

決裁箱の窓と、左メニュー一番上の「決裁箱」の行（a183、#1663、決裁箱拡張の画面）を入れた0.6.0を、アニスがFOXへ導入した。Coreはネオンの#1658。

- 2026-11-16 07:5x JST、main `0190ff7d`（#1663はmain `54463488`）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.6.0+0190ff7d7a98fa2df63d59df0f7000f715f875f7`。
- 読み取りsmoke（`--smoke-test`、本番）は07:58:04 JSTに成功した。session local・142メンバー・8ルーム・SSE接続を確認した。
- 本番の確認（導入したBellTeam.dll・BellTeam.Core.dllを参照する確認用コンソール、GETだけ・何も押していない）: 本番に決裁箱モジュールは入っており、`/api/approvals/summary`は409（決裁箱につながっていない）。入口の行は「決裁箱」、窓は「決裁箱につながっていません。つなぐと、自動で決裁を読み込みます。」と「決裁箱につなぐ／読み直す／閉じる」を出した（フィードはNoCredential、つなぎの状態はidle）。写真はFOXの`C:\Users\kite_\BellTeam-shots\a183-0.6.0\production-not-connected.png`。
- 見ていない事: 決裁箱への実際のつなぎ（利用者が決裁箱で許可する操作が要る）と、そのあとの一覧・答える・つなぎを外す。画面と動きは固定データの窓（`--render-approvals`、19場面。写真はブランチ`anis/a183-shots`）と窓の試験14件で確かめた。

## 0.5.10の導入（2026-11-16）

工程の詳細の「次の工程」に、取り下げた工程を出さない修正（a185、アドミの報告、#1654）を入れた0.5.10を、アニスがFOXへ導入した。Linuxアプリも同じCoreを使う。前の工程は変えない。

- 2026-11-16 07:3x JST、main `cde7108b`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.10+cde7108b276e9584007dc185a6f2e2bd2c80e17e`。
- 読み取りsmoke（`--smoke-test`、本番）は07:37:09 JSTに成功した。session local・142メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 本番の確認: 導入したBellTeam.Core.dllで本番`bellteam`のsnapshot（701札・598辺）を読み、取り下げた続きを1件持つ札（bellteam-dev/t12-apple）の詳細を作ると、次の工程は0件だった（修正前は1件）。

## 0.5.9の導入（2026-11-15）

工程表の「接続」と「ブロック」（a161、#1618）を入れた0.5.9（#1619）を、アニスがFOXへ導入した。他条件に接続と優先接続は線にせず、上の帯の接続の数・左の列のリンクの印・右の接続の欄・札の「接続 N」に出す。前工程の札は「前工程：◯◯」。止め一覧・止まり・止めた人はブロック一覧・ブロック・ブロックした人に替えた。

- 2026-11-15 22:21 JST、main `6d97928d`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.9+6d97928d2b81bed7951c35eacc85de415206ba46`。
- 読み取りsmoke（`--smoke-test`、本番）は22:21:22 JSTに成功した。session local・142メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 本番の工程表の札には、本体と子（モリー）の切り替えが入るまで`connections`が来ない。接続の欄は空（「接続している工程はありません。」）で、数は0になる。欄の見た目は模擬サーバーの`--render-lattice connections`で確かめ、フローラが画像で承認した（#1618の`docs/evidence/a161-windows-connections-20261115/`）。本番の実データでの確認は、切り替えが入った後に行う。

## 0.5.8の導入（2026-11-15）

0.5.7の後に採用された工程表の3件（0/0の工程表を一覧と切り替えから外すa107-win #1415、進み具合の分数をcountedの工程だけで数えるa96 #1437/#1438、Ownerの工程の詳細に決裁箱拡張の決裁を出すR3 #1578）を入れた0.5.8（#1579）を、アニスがFOXへ導入した。

- 2026-11-15 17:08 JST、main `5726070b`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.8+5726070bc45c9a0e8132e4f6864674d0dcaf8d29`。
- 読み取りsmoke（`--smoke-test`、本番）は17:08:43 JSTに成功した。session local・142メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 本番の`GET /api/approvals/by-task`は404（決裁箱拡張の配備前）で、R3の決裁の欄は出ない状態。欄の見た目は模擬サーバーの`--render-lattice owner`で確かめた。本物の拡張での確認と「決裁を開く」は、DeltaのWindowsの決裁箱の画面ができた時に行う。

## 0.5.7の導入（2026-11-14）

工程表の左上の「すべての工程表」と、メンバーの「AIと操作」の工程表ボタン（Lattice工程 bellteam-dev-added/a87の1・2とa92、#1378。ラピのApple #1368に合わせたもの）を入れた0.5.7を、アニスがFOXへ導入した。

- 2026-11-14 14:40 JST、main `767c6b1b`（#1378の採用、head `cc187ccf`）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.7+767c6b1b1f3ccd4046c749121d1cf528092009eb`。
- 14:41の読み取りsmokeは、本体の入れ替え中で接続を拒否されて失敗した。本体が14:42に戻った後、smoke（`--smoke-test`、本番）は14:42:27 JSTに成功した。139メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 導入exeの`--render-inspector member`で本番を描き、トロニーの「AIと操作」に「工程表「BellTeam開発」を開く」、フローラに作った3つの工程表のボタンが出た。画像はブランチ`anis/a87-a92-shots`の`evidence/anis-a87-a92/prod-0.5.7-member-*.png`とFOXの`C:\Users\kite_\BellTeam-shots\a87-a92-0.5.7\`に置いた。
- 本番の読み取りの時間（a87の3、表示の速さ）：本体の入れ替え前（14:20ごろ）は`GET /api/lattice/charts`が64秒と109秒、工程表`bellteam`の最初のsnapshotが27秒と75秒で、Windowsの30秒の打ち切りを越えていた。入れ替え後（14:43ごろ）は一覧が2.1秒と2.0秒、最初のsnapshotが8.6秒と5.6秒だった。
- 実際のマウスでボタンを押して工程表の窓が開くところは、この席に画面が無いため確かめていない。

## 0.5.6の導入（2026-11-14）

工程表の画面の直し（Lattice工程 bellteam-dev-added/a74、#1354。ラピのa73の4項目をWindowsで確かめたもの）を入れた0.5.6を、アニスがFOXへ導入した。

- 2026-11-14 10:10 JST、main `59bd4eae`（#1354の採用、head `635a3242`）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.6+59bd4eae8f1ef6fae3d12fd2e09cb6564a88ef8c`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は10:11:09 JSTに成功した。140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 導入したBellTeam.dllを参照する確認用の小さなプログラムで、本番の工程表`bellteam`（157件）を描いた。900pxでは上の帯が2行に折れ、輪の中の数は輪に収まり、待ちの流れは右端のつまみ（件数4）に畳まれていた。1360pxでは開いた待ちの流れの見出しに件数と閉じるが出た。画像はブランチ`anis/a74-shots`の`shots/a74/prod-0.5.6-*.png`とFOXの`C:\Users\kite_\BellTeam-shots\a74-0.5.6\`に置いた。
- 同じプログラムで、工程表を開いたままのUIスレッドの入力の待ちは30秒でp95 29 ms・最大51 ms、描き直しは1回30 msだった。
- 実際のマウスでの操作は、この席に画面が無いため確かめていない。つまみと閉じるは試験（`TheWaitFlowStartsFoldedAndTheHandleOpensAndFoldsIt`）で押した。

## 0.5.5の導入（2026-11-13）

設定の「稼働中に数えない処理」（Lattice工程 bellteam-dev-added/a65、#1326。読み取り口はキロのa62、#1323）を入れた0.5.5を、アニスがFOXへ導入した。

- 2026-11-13 23:24 JST、main `0cf44423`（#1326の採用。エピネルの差し戻し1点を直したhead `e68f353f`）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.5+0cf444231fe4b1d60b70c6fbdab407c7af8057a2`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は23:24:56 JSTに成功した。140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 導入exeの`--render-page settings-exclusions`を本番へ向けて描いた。本番の`GET /api/running-exclusions`は`{entries:[],pending:[]}`で、設定の一覧の行は「ありません」、ページは「稼働中に数えない処理はありません。」の一行だった。画像はFOXの`C:\Users\kite_\BellTeam-shots\a65-0.5.5\`に置いた。
- 本番に項目と提案が無いため、項目・提案の行と「外す」は模擬画面（`mac-ui-reference.mjs exclusions`、#1326の画像）でだけ確かめた。外すを本番で押す確認は、本番に項目ができてからになる。

## 0.5.4の導入（2026-11-13）

ほかの工程表の工程を待つ工程の表示（Lattice task a60、フローラの#1318の契約、Windowsは#1320）を入れた0.5.4を、アニスがFOXへ導入した。

- 2026-11-13 21:49 JST、main `e8b19968`（#1320の採用）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.4+e8b1996864ac9b48591e093b725b1039d527a4f5`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は21:50:15 JSTに成功した。141メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 21:5x JST、導入したBellTeam.dllを読む非表示の確認用コンソールで、本番の工程表「試し：よその前工程B」（`flora-xchart-b`、snapshotの`externals[]`に`flora-xchart-a:xa/first`が1件、終わっているので待ちは無い）を開いた。工程`xa/after`の詳細の前の工程に「先に終わらせる工程（試し）」「試し：よその前工程Aの工程表」「フローラ・完了」が出て、ツリーに線は無かった。その前の工程を押すと、工程表「試し：よその前工程A」（`flora-xchart-a`）が開き、工程`xa/first`の詳細が選ばれた。画像はFOXの`C:\Users\kite_\BellTeam-shots\a60-0.5.4\`に置いた。
- 本番に待っている状態の別工程表の工程が無いため、待ちの流れの行（「◯◯の工程表」と「読めていません」）は模擬画面（`--render-lattice external`、#1320の画像）だけで確かめた。

## 0.5.3の導入（2026-11-13）

一覧の「仕事中」を`/api/bots`の`currentWork.state`だけで決める直し（Lattice工程 bellteam-dev-added/a52、#1296）を入れた0.5.3を、アニスがFOXへ導入した。

- 2026-11-13 15:41 JST、main `b9279de3`（#1296の採用）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.3+b9279de3464ee4683991caa98611399981daefa1`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は15:41:55 JSTに成功した。141メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 15:44〜15:47 JST、導入したBellTeam.dllを読む非表示の確認用コンソールで、本番の一覧の判定（`ConversationEntry.Working`・`PresenceLabel`）を、相関図の最初のsnapshot（`/api/work-graph/events`の`nodes[].state`）と配達の列（`/api/queue`）に並べて5回読んだ。一覧の「仕事中」は毎回`currentWork.state == "working"`のメンバーと一致した（6人→5人）。モリー（`bot-39be7047`）は処理中の配達が無いのに一覧で「仕事中」と出た。0.5.2までは「オンライン・待機中」と出ていた形。相関図で作業中のメンバーは、一覧でも全員「仕事中」だった。
- 一致しなかったのはモリーだけで、相関図には節が無かった。相関図の本体側（`src/work-graph-facade.mjs`の`turns.read`）が`transport.currentTurn`を読み、コマンドの結果待ち（`currentWork`ではworking）を数えないため。Windowsの直しの外として、トロニーへ渡した。

## 0.5.2の導入（2026-11-13）

工程表の止め一覧（Lattice工程 lattice-blockers-20261112/blockers-windows、#1259）を入れた0.5.2（#1267）を、アニスがFOXへ導入した。

- 2026-11-13 08:46 JST、main `44db30a1`（#1267の採用）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.2+44db30a15b577184534718897bac1fedba750733`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は08:47:23 JSTに成功した。140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 08:50 JST、本番で止め一覧を確かめた。導入したBellTeam.dllを読む非表示の確認用コンソール（`BellTeam.UiChecks`）で、一覧の「止め一覧」ボタンから開くと、全部の工程表の止め6件（BellTeam開発4件・キロ実行制御1件・確かめ用1件）が新しい順に出た。確かめ用の工程表「止め一覧の試し（Windows）」に置いた止め1件で、本物の「外す」→「この止めを外しますか？」→「外す」を押した。行は消え、読み直しても戻らず、工程は作業中へ戻った。ほかの人の止めには触れていない。写真はFOXの`C:\Users\kite_\BellTeam-shots\stops-0.5.2\`（公開repoへは上げない）。終了後のBellTeam.exeは0件。
- 指揮官様は外出中のため自分では押せず、アニスの試験でOKとした（2026-11-13 08:51 JST）。指揮官様の分として置いた止めは、置いてから約1分で誰かに外されていた。その工程は取り下げた。

## 0.5.1の導入（2026-11-13）

0.5.0の受け入れの写真でトロニーが見つけた直し（工程t26、#1246）を入れた0.5.1を、アニスがFOXへ導入した。

- 2026-11-13 02:26 JST、main `bba26e6c`（#1246の採用）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった。導入exeの版は`0.5.1+bba26e6c7cd25319a089b90ccad9b55e79839d6d`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番）は02:26:18 JSTに成功した。140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 本番のデータで、予定のページのルームの写真（8部屋とも本物）、メンバー編集のファストモード（設定と同じスイッチと「このアカウントではファストモードを使えません。」の一文）、1Passwordの「1Passwordと連携する」のスイッチを描いた。写真はFOXの`C:\Users\kite_\BellTeam-shots\t08-0.5.1\`（公開repoへは上げない）。終了後のBellTeam.exeは0件。
- 詳細パネルの在席の「オフライン」は、サーバーの`/api/bots`が外の端末の席（`terminalId`あり）を全員`online:false`で返すためで、アプリの変更はない（トロニーが割り振る）。

## 0.5.0の導入（2026-11-13）

Macの作り直しに合わせた画面（工程t08：#1228 設定、#1235 詳細パネルのAIカード、#1237 設定のサブページ、#1239 ゴール、#1240 プロフィールとルーム編集、#1243 接続できない画面・質問と秘密のカード・予定・導入ガイド・最新へ戻る帯）を入れた0.5.0（#1244）を、アニスがFOXへ導入した。

- 2026-11-13 02:08 JST、main `7e45e8cf`（#1244の採用）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった（オーナーのアプリは閉じていない）。
- 導入exeの版は`0.5.0+7e45e8cfe8f7efce60d0d7fa69cc4d8f5b9e7a52`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は02:08:40〜02:08:42 JSTに成功した。session local・140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 受け入れ用に、変えた画面を本番のデータで1枚ずつ描いた（導入したexeの`--render-*`と、ログインのページ・会話のカードは導入した`BellTeam.dll`を使う作業場の小さな描画用プログラムから。GETだけ）。写真は本番の内容が写るので公開repoへは上げず、FOXの`C:\Users\kite_\BellTeam-shots\t08-0.5.0\`に置いた（一覧は同じ場所の`index.md`）。終了後のBellTeam.exeは0件。
- ゴールの失敗の一文は、本番に読めないゴールが無い（休止中128・ゴール無し12）ため、本番のデータでは出していない。画面の本人操作はしていない。

## 0.4.9の導入（2026-11-12）

工程表の窓の直し（#1122 担当の決め方とカード本文、#1131 ツリー表示・単独で読める待ちの流れ・一覧から戻る、#1135 終わった工程の過去ログ、#1145 指揮官が担当の工程）を入れた0.4.9（#1159）を、アニスがFOXへ導入した。

- 2026-11-12 09:06 JST、main `649cfeee`（採用の`9e0aba82`以降、`windows/`の差分なし）から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった（オーナーのアプリは閉じていない）。
- 導入exeの版は`0.4.9+649cfeeeec8384373ecd994ee182d27ae47c86cc`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した。session local・140メンバー・1ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 本番の工程表「BellTeam開発」を、導入した`BellTeam.dll`の工程表の窓で読み取りだけで描いた（作業場の小さな描画用プログラムから。GETだけ）。ツリー（まとまり→工程、終わった工程は描かない、13/33）、過去ログ 13（今日の見出し・担当・時刻）、待ちの流れ（単独で読める行）、本物のアバターを確認した。描画用プログラムにはアプリのStyleが無いため、ボタンは素の見た目で写る。
- 本番では担当`owner`の工程が過去ログに「owner」の文字で出る。サーバーが担当の文字`owner`／`指揮官`を予約値へ直すのは#1142のサーバー側で、配備後はOwnerのプロフィールの名前と顔になる（Webも同じ規則）。統括の印が付かないのも#1142のサーバー側の修正待ち。画面の本人操作はしていない。

## 0.4.8の導入（2026-11-12）

ゴール読取りの`reason`（#1107。サーバー側は#1106）を入れた0.4.8を、アニスがFOXへ導入した。`unavailable`で`reason: "seat_idle"`の時、会話のカプセルは「休止中」、カードはサーバーの文を出す。`reason`が無い・`read_failed`の時は従来の取得失敗の表示のまま。

- 2026-11-12 04:41 JST、main `f2cd5ff1`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった（オーナーのアプリは閉じていない）。
- 導入exeの版は`0.4.8+f2cd5ff112571751d8e8da9b2f7e0d4324f787d5`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した。session local・140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 04:43 JSTの本番`GET /api/goals`は140件すべて`reason`無し（#1106の配備前）。0.4.8は従来どおり取得失敗の表示で、配備後に「休止中」になる。画面の本人操作はしていない。

## 0.4.7の導入（2026-11-12）

工程表（Lattice）の窓（#1092）を入れた0.4.7を、トロニーの指示でアニスがFOXへ導入した。工程表の部品は本番にまだ無く、配備後にトロニーの連絡を受けて本物の部品での確認を行う。

- 2026-11-12 00:01 JST、main `71de0423`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった（オーナーのアプリは閉じていない）。
- 導入exeの版は`0.4.7+71de042359c80c567143382d1950b57f27937fac`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した。session local・140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 本番の`GET /api/lattice/charts`は404（部品の配備前）。工程表の窓は「このサーバーではまだ工程表を使えません。」「サーバーが更新されると使えるようになります。」を出す状態。画面の本人操作はしていない。

## 0.4.6の導入（2026-11-11）

W-MACの追従13〜19（相関図、秘密の入力カード、1Password連携、端末、メンバーの端末とフォルダ、このPCを追加・確かめる、メンバーの状態の行、アップデートの言い方、Claudeの2アカウント）を入れた0.4.6を、アニスがFOXへ導入した。

- 2026-11-11 18:32 JST、main `2a824d51`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch`で導入した。導入前にBellTeam.exeは起動していなかった（オーナーのアプリは閉じていない）。
- 導入exeの版は`0.4.6+2a824d5160efea775e741f482ce24af4abe3c6d4`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した。session local・140メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 「このPCを確かめる」の本番（本体が信用を書く）は、クラストとセンチが0.4.6で確かめる。画面の本人操作はしていない。

## 0.6.2の導入（2026-11-19）

AI CLIの導入画面（a451、#1942）をMacの実装に合わせた0.6.2（#1970）を、アニスがFOXへ導入した。サーバー側（Z120）は本番で稼働し、4つのAIとも導入済みだった。

- 2026-11-19 20:42 JST、main `031cddaf`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch -SkipShareTarget`で導入した。導入前にBellTeam.exeは起動していなかった。
- 導入exeの版は`0.6.2+031cddafdb493eb2cad1a56ff43e5fa911b10fd1`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した（`ok: true`）。session local・144メンバー・8ルーム・会話の読み取り・SSE接続を確認した。
- 導入exeの`--render-page settings-ai`と`--render-editor authentication claude`を本番へ向けて撮った（FOXの`C:\Users\kite_\BellTeam-shots\a451-windows-0.6.2-installed\`）。導入済みの状態（サーバーの一文・「最新版を入れる」）を確認した。
- 未確認：導入していない・失敗・導入中・初回設定の画面は本番では出せない。列車2の検証環境（a451-fresh-install-test）で撮る。実際の「最新版を入れる」の押下は本番では行っていない（a451-prod-installの作業）。

## 0.6.1の導入（2026-11-18）

購読の管理・解約ボタン（a390、#1862）、プライバシー方針とサポートのリンクをkitepon.devへ（a398d、#1870）、「Web版は無料です。」の説明文（#1870）を入れた0.6.1を、アニスがFOXへ導入した。サーバー側（Z95）は本番で稼働している。

- 2026-11-18 09:04 JST、main `5c2a6f9a`から`pwsh -NoProfile -File scripts/install-windows.ps1 -NoLaunch -SkipShareTarget`で導入した。導入前にBellTeam.exeは起動していなかった。
- 導入exeの版は`0.6.1+5c2a6f9a7065cd08ea9eafd543bf3ddd1df05b77`。
- 導入exeの読み取りsmoke（`--smoke-test`、本番 `http://192.168.1.2:18891/`）は成功した（`ok: true`）。session local・142メンバー・8ルーム・会話の読み取り・SSE接続を確認した。終了後のBellTeam.exeは0件。
- 本番の`GET /api/subscription`は`accessMode: developer`・`billingSources: []`・`canPurchase: false`。導入exeの`--render-page settings-billing`は、新しい説明文を出し、購入の入口と管理ボタンを出さない（開発者サーバーの仕様どおり）。
- 管理ボタンと解約済みの行は、人工データの描画（購入可・購読中・解約済みの3状態）と試験（購読の8件）で確かめた。実際のStripeの管理ページの操作は未確認。

### 0.6.3 の導入（a471: 古いページで画面を埋める・答えの吹き出し・ツールの畳み）

2026-11-21 07:10 JST、main c166543f（#2051・#2055・#2056・バージョン#2061）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（BellTeam.exeは動いておらず、共有先の登録は管理者の確認が要るため触っていない）。導入後の`BellTeam.exe`は0.6.3+c166543f。

- スモーク（`--smoke-test` 本番 http://192.168.1.2:18891/）: 07:10:16に成功。authenticated=true、bots=144、rooms=9、最初の会話は10件でhasMore=true、SSE接続あり。
- 本番の試験席 bot-f1a21da1 を `--render-conversation`（GETのみ）で描いた。最新30件は畳まれた行が多く、「background ×5」「background ×10」の1行にまとまり、時間順のまま並ぶ。画面は6:47の長い返答の吹き出しまで読み込まれて埋まり、先頭に「以前のメッセージを読む」が出る。
- 確認できていない: 6:35のターンの考えた要約と道具の行（画面の上、スクロールの先にあり、描いた画像には入っていない）。`bubble: true`と`fold_count`の行は、本番の本体がまだ付けておらず（#2049・#2054の列車待ち）、実データでは見ていない。この2つは試験（MachineEventTests・UiChecks）で確かめた。

### 0.6.5 の導入（a471: 返信・転送・コピー、過去ログ100/500と先読み、thinkingを全文で描く）

2026-11-21 11:06 JST、main 73ea2810（#2090・#2093・#2095・バージョン#2097）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は管理者の確認が要るため触っていない）。導入後の`BellTeam.exe`は0.6.5+73ea2810。

- スモーク（`--smoke-test` 本番 http://192.168.1.2:18891/）: 11:07:11に成功。authenticated=true、bots=144、rooms=9、最初の会話は10件でhasMore=true、SSE接続あり。
- 本番の自席 bot-0d7da1c1 を `--render-conversation member|default|scrolled`（GETのみ）で描いた。考えた行（thinking）が行数の制限なしに全文で折り返されて出て、先頭に「以前のメッセージを読む」が出る。
- 確認できていない: 返信・転送・コピーのアイコンと、スクロールでの先読みの実際の動き（試験とUiChecksで確かめた。本番の画面での操作は未確認）。
- 見つけた不具合: `--render-conversation`はPNGを書いたあとに終了時に落ちた（例外コード0xE0434352、ObjectDisposedException。描画モードが`Workspace.Dispose`したあとに、待っていたスクロールの先読みが破棄済みの選択を読んだ）。通常の起動では`Dispose`は走らないため利用者の画面には出ない。修理は #2100（試験つき、版は上げない）。

### 0.6.6 の導入（a471: 会話の上の「以前のメッセージを読む」ボタンを外す）

2026-11-21 11:19 JST、main 2fb5c080（#2104 = 37af4a5aを含む）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.6+2fb5c080。

- スモーク（`--smoke-test` 本番）: 11:19:29に成功。authenticated=true、bots=144、rooms=9、SSE接続あり。
- 本番の自席 bot-0d7da1c1 を `--render-conversation member`（GETのみ）で描いた。終了コードは0（0.6.5で出ていた終了時の落ち、#2100、が直っている）。HasMoreが真の会話で、行の上に「以前のメッセージを読む」は出ない。
- 確認できていない: 実際にスクロールして先読みが働く動き（試験とUiChecksで確かめた。本番の画面での操作は未確認）。LinuxとAndroidには同じボタンが残っている（担当はそれぞれの席）。

### 0.6.7 の導入（a471-fill-drawn: 最初の画面と先読みの幅を描いた中身で埋める）

2026-11-21 11:56 JST、main f5f1607c（#2116）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.7+f5f1607c。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 本番の忙しい機械の席 bot-7b140b27（トロニー）を `--render-conversation member`（GETのみ）で描いた。終了コード0。最初の画面は返答の吹き出し・考えた行（全文）・畳んだ「background ×54」「tools ×5」と作業中の行でいっぱいで、スクロールバーのつまみは小さく下に寄り、上に読み込み済みの分が十分ある。
- 確認できていない: 実際に上へスクロールして、先読みが3画面分を保って続く動き（試験とUiChecksで確かめた。本番の画面での操作は未確認）。LinuxとAndroidは旧5引数の転送で新しい規則が効いている（Linuxの新形式への移行はa471-fill-drawn-linux）。

### 0.6.8 の導入（a471: 思考の行を吹き出しで描く）

2026-11-21 12:06 JST、main a3edcaaa（#2124）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.8+a3edcaaa。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 導入後の実物で本番の自席 bot-0d7da1c1 を `--render-conversation scrolled`（GETのみ）で描いた。終了コード0。thinking の行が、回答と同じ受信の吹き出しに薄く斜めの文字で全文出て、時刻とコピーのアイコンだけが付く（返信・転送は出ない）。
- 確認できていない: 実際の会話で返信・転送の入口が出ないことを手で押して見ること、コピーで全文がクリップボードに入ること（試験とUiChecksで確かめた範囲）。LinuxとAndroidの吹き出しは担当の席。

### 0.6.9 の導入（a471-scroll-jump: 古い頁が届いても見ている場所が飛ばない）

2026-11-21 12:35 JST、main 87a40db4（#2130）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.9+87a40db4。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 実画面（指揮官のPC、本番の自席 bot-0d7da1c1、UI Automationで192pxずつ上へスクロールし、見えている全要素の上端をRuntimeIdで追った。マウスは使っていない）：修理前（0.6.8）は古い頁が届いた5回で見ている行の動きが160・32・16・-48・80px（段は192px、最大240pxのずれ）。修理後はビルド版で192×5、導入した0.6.9で192×4、ずれは0。
- 確認できていない: 本物のマウスホイールやトラックパッドの勢いのあるスクロール（行スクロールのみ）。

### 0.6.10 の導入（a471-scroll-jump: 上の行が伸びる・遅れた行が足されても見ている行が飛ばない）

2026-11-21 12:46 JST、main b71fa8ba（#2134）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.10+b71fa8ba。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 実画面（指揮官のPC、本番の自席、導入した実物、UI Automationで192pxずつ上へスクロール。見えている全要素の上端をRuntimeIdで追った）：スクロールしない30秒の間に実際の新しい行が2回下に届いても見ている行は0px、古い頁が届いた4回はいずれも192px（ずれ0）。測定の起動に初めの2回失敗した（会話が空のまま。原因は未確認で、起動の待ち時間を伸ばした再実行で成功。同じ版の描画と窓の診断では会話は読み込めていた）。
- 確認できていない: 実際に上の行が伸びる場面（Windowsの実画面では約400回の記録で起きていない。試験の場面だけで確かめた）、本物のマウスホイールやトラックパッドの勢いのあるスクロール。

### 0.6.11 の導入（a471-scroll-smooth: 下に届いた行を滑らかに追う）

2026-11-21 13:11 JST、main 047cfb78（#2143）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.11+047cfb78。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 実画面（指揮官のPC、本番の自席、導入した実物、UI Automationで下にいる状態の位置を約25msごとに読む。マウスは使っていない）：修理前（0.6.10）は行が届いた8回とも、行が増えたのと同じ標本で位置が行の高さ分動いた（瞬時）。0.6.11では届いた7回とも瞬時に動いたものは0回で、末尾までの残りが約0.8秒、10標本ほどで150→34→19→…→0と滑らかに減った。
- 確認できていない: 本物のホイール・タッチで追従が止まること（試験でホイールのイベントを送って確かめた）、Windowsのアニメーション効果を切った時に即時になること（この端末は効果が入っていて、試験は切れている時は確認を省く）。

### 0.6.12 の導入（a471-scroll-reconnect: 再接続しても読んでいる場所を保つ）

2026-11-21 13:27 JST、main c6b3e0fb（#2147）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.12+c6b3e0fb。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 確認できていない: 実画面での再接続（再接続ボタンは接続エラーの時にしか出ず、本番サーバーを止めずに起こせない。設定画面から同じ接続先へつなぎ直す経路は、UI Automationで見た限り設定の画面には無かった）。確かめたのはUiChecks.ReconnectChecks（再接続ボタンの経路 MainWindow.ConnectAsync を通す。開いた会話・持っている行が残り、新しい3行が足され、見ている行は0px）と、Windowsの試験全体811件の成功まで。

### 0.6.13 の導入（a471: 最初のページも古いページも1回で1000件読む）

2026-11-21 13:46 JST、main 243ff6a9（#2154）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.13+243ff6a9。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9。
- 本番の忙しい席 bot-7b140b27（トロニー）の最初のページ `limit=1000` を指揮官のPCから読むと、530KB・0.32秒（以前の `limit=100` は53KB・0.44秒）。同じ席を `--render-conversation member` で描いて終了コード0、窓の起動から描画の完了まで約10秒。最初の画面は回答の吹き出し・thinking・畳んだ行でいっぱいで、スクロールバーのつまみは小さく下に寄り、上に読み込み済みの分が十分ある。
- 確認できていない: 指揮官の手元での体感（遅い回線での最初の画面の出るまでの時間。N102の測定では1000件で約0.6MB）、本物のスクロールでの先読みの動き。

### 0.6.14 の導入（a471-open-newest-windows: 会話の一覧を最新の端に錨を打って下から並べる）

2026-11-21 15:31 JST、main 49227e92（#2161）から `scripts/install-windows.ps1 -NoLaunch -SkipShareTarget` で導入した（共有先の登録は触っていない）。導入後の`BellTeam.exe`は0.6.14+49227e92。

- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、SSE接続あり。
- 長い会話（本番の自席 bot-0d7da1c1、最初のページ1000件、`has_more`あり）を `--render-conversation member` で描いて終了コード0。最初に描いた画面が最新の行（処理中の行）で終わっていて、「最新へ」の帯は出ていない。
- 仕組みの確認はUiChecks（開く・古いページ・読み返し中の新着・送信・追従）で済み、錨を外すと失敗することも確かめた（PR #2161）。
- 確認できていない: 指揮官の手元での実ホイール操作、実際のSSEが新着を運ぶ流れ。

## Windows 0.6.17 の導入（a486、2026-11-22 00:22〜00:23 JST、アニス）

- 導入元: main `f3adc69e`（#2229 ブラウザー版の文言をアプリから外す・#2233 第二の手の要求画面と「アプリを追加」の削除・#2241 版 0.6.17）。`scripts/install-windows.ps1 -NoLaunch -SkipShareTarget`。導入したexeの版は `0.6.17+f3adc69e88f08c6891c8c34e715c338e928c948a`。
- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、会話10件（`hasMore`あり）、SSE接続あり。終了後のBellTeam.exeは0件。
- `--render-conversation member`（本番の自席）: 終了コード0、描けた。
- 確認できていない: 本番サーバーの `entitlementState` が `none` ではないため、購読の壁の新しい文は本番では出ていない（UiChecksの `PaywallView` の試験で文と「ブラウザーで開く」が無いことを確認）。新しいサインイン入口（`SignInView`）は未接続で、アプリの起動では出ない。

## Windows 0.7.0 の導入（a540 段階2：ローカル形式、2026-11-23 20:09〜20:10 JST、アニス）

- 導入元: main `f0a82ba5`（#2436。段階1は#2428）。`scripts/install-windows.ps1 -NoLaunch -SkipShareTarget -GoogleDesktopOAuthRef op://…`（Desktop Googleクライアントの秘密はホストの保管庫からビルドの環境変数へ、値は表示もコミットもしていない）。導入したexeの版は `0.7.0+f0a82ba509a81c441a23f834ffd45a65107b4dfd`。ライブラリは Kitepon.LoginBilling.Desktop 0.20.1（sha256 `edb12fb5a5809869d78d0dba3cc2d892d6cd067a640d42a77e5b13b3dfa53ffd`、**開発版**：アイリの監査t10dとミントの受け入れt10cまで本番へ出さない）。導入したBellTeam.dllのアセンブリのメタデータに秘密が35文字入っていることを確認した。
- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、会話10件、SSE接続あり。
- `--render-page settings-billing`（本番）: 終了コード0。設定の「利用と課金」に、サインインしていない端末の「アカウントと購読」（Googleでサインイン・アカウントを削除・プライバシー方針・サポート）が出て、購入の入口は無い。「このアプリについて」は0.7.0。
- 確認できていない（実機が要る）: Googleのサインイン（ブラウザー）→QR→購読しているスマホの返事→「いつまで」の流れ全体、Windowsのファイアウォールの最初の確認、シークレット付きのGoogleトークン交換（Googleの設定が効くまで数分〜数時間）。確かめたのはxunit（AppLoginTests・LocalFormTests ほか58件）、UiChecks（削除の場面を含む）終了コード0、ダミーの秘密でのメタデータ注入まで。

## Windows 0.7.1 の導入（a540：ライブラリ0.20.2・ラピの表の文言、2026-11-23 20:53 JST、アニス）

- 導入元: main `c3e2be6c`（#2443。ネオンの文言 #2441 と私の #2440 を含む）。`scripts/install-windows.ps1 -NoLaunch -SkipShareTarget -GoogleDesktopOAuthRef op://…`。導入したexeの版は `0.7.1+c3e2be6cc8b3285c804f12a182404d593a5e8f15`。ライブラリは Kitepon.LoginBilling.Desktop 0.20.2（sha256 `de8e3d7c93bb21ec14fcc3153e0815807c602cb5d7c7eeef656a6f3031f48934`、ミント受け入れ済み：t10c）。導入したBellTeam.dllにGoogle Desktopクライアントの秘密が35文字、アセンブリのメタデータとして入っている（値は表示していない）。
- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、SSE接続あり。
- `--render-page settings-billing`（本番）: 終了コード0。「BellTeamの購読」「購読はまだありません。」「購読しているスマホで確認する」「QRを出す（Google）」とラピの表の文が出て、サインアウト・アカウントを削除・購入の入口なしは変わらず。「このアプリについて」は0.7.1。
- 受け入れるaudience: BellTeamのGoogleクライアントID 7つとAppleのアプリIDの計8つ（`LocalFormTests`が固定）。Appleの根はライブラリの組み込み。
- 確認できていない（実機が要る）: Googleのサインイン→QR→購読しているスマホの返事→「いつまで」の流れ全体、Windowsのファイアウォールの最初の確認、シークレット付きのGoogleトークン交換。

## Windows 0.7.2 の導入（a540：ライブラリ0.20.3、2026-11-23 21:04 JST、アニス）

- 導入元: main `d8147bbb`（#2448）。`scripts/install-windows.ps1 -NoLaunch -SkipShareTarget -GoogleDesktopOAuthRef op://…`。導入したexeの版は `0.7.2+d8147bbb4f8ad1f5a8e0f7ea36f89c1ee4080b5e`。ライブラリは Kitepon.LoginBilling.Desktop 0.20.3（sha256 `d62de5e3a9233157152796a8083ba11cad5801187588101daccdaa70133bf5d3`、ミント受け入れ済み。契約1.40：サインインが残っていない端末では`PaidUntil()`は「なし」）。導入した`Kitepon.LoginBilling.Desktop.dll`は0.20.3、`BellTeam.dll`にGoogle Desktopクライアントの秘密が35文字（メタデータ。値は表示していない）。0.7.1の導入記録の上に、この版で入れ直した。
- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、SSE接続あり。
- `--render-page settings-billing`（本番）: 終了コード0。ラピの表の文（「BellTeamの購読」「購読はまだありません。」「購読しているスマホで確認する」「QRを出す（Google）」）が出て、「このアプリについて」は0.7.2。
- 確認できていない（実機が要る）: Googleのサインイン→QR→購読しているスマホの返事→「いつまで」の流れ全体、Windowsのファイアウォールの最初の確認、シークレット付きのGoogleトークン交換。

## Windows 0.8.0 の導入（abx-client-v1：決裁箱はApproval Boxのクライアント、2026-11-24 05:10 JST、アニス）

- 導入元: main `674aa438`（#2466。契約 client-v0.5、デルタ・トロニーの2026-11-24の裁定）。`scripts/install-windows.ps1 -NoLaunch -SkipShareTarget -GoogleDesktopOAuthRef op://…`。導入したexeの版は `0.8.0+674aa4386a453f20b8a3dbfba35f2203f0d461c1`。ライブラリは Desktop 0.20.3（変更なし）。`BellTeam.dll`にGoogle Desktopクライアントの秘密が35文字（メタデータ。値は表示していない）。
- スモーク（`--smoke-test` 本番）: 成功。ok=true、bots=144、rooms=9、SSE接続あり。
- 本番のApproval Box（`GET https://approval-box.kitepon.dev/v1/auth/config`）は `peer_channel:false`。使い捨ての試験で、本物の `V1ApprovalSource` を本番へ向けて数秒動かした（決裁の中身は読まず件数と状態だけ記録）。fox に残っていた前のApproval Boxの通行証で `/v1` を読むと401（通行証は無効）で、状態は `SignedOut/pass_ended`、通行証は捨てた（契約の「401 = 通行証を捨ててサインインの画面を出す」どおり）。つまり今のfoxの決裁箱は「Approval Boxにサインインします」の画面で、サインインはあなたの操作（「Approval Boxにサインイン」のブラウザー、または「QRでサインイン」のハンドオフ）が要る。
- 確認できていない（実機とあなたの操作が要る）: サインイン後に `/v1` の一覧が出ること、決裁を1件答えて版・Idempotency-Keyつきの答えが通ること。UI Automationでの画面描画は模擬のApproval Boxの試験（xunit 897件・UiChecks 0）まで。
