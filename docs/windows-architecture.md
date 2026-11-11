# Windowsアプリの機能図と作業手順

担当はアニス（`bot-0d7da1c1`）。この文書をWindows製品内部の機能図の正本とする。本体側の接続登録は[Windowsアプリ](architecture/modules/windows/README.md)、担当と変更手順は[機能担当と変更の手順](architecture/module-ownership.md)を参照する。

## 現在の接続と所有

```mermaid
flowchart LR
  user[利用者] --> app[Windows画面・操作<br/>BellTeam.App]
  app --> core[通信・モデル・SSE・下書き・端末設定<br/>BellTeam.Core]
  core -->|HTTP API・SSE| integration[BellTeam共通入口<br/>モリー]
  core --> local[このPCの設定・認証情報]
  app --> toast[Windows通知]
  integration --> server[BellTeam本体の各機能]
```

画面、端末での操作と通知、接続先・窓・通知設定、端末の認証情報はWindowsアプリが扱う。会話、メンバー、予定、利用設定など本体の状態は共通入口を通じて利用する。画面の具体的な機能と端末設定は[Windowsアプリ](windows-app.md)を参照する。接続登録上の本体公開窓口は統合の `HTTP/MCP` で、現行Windows実装が利用するのはHTTP APIとSSEである。本体の内部状態を直接読み書きしない。

会話履歴の `deliveryTracking` は本体が受付の根拠を保存・投影し、Windowsは既知の値だけを表示する。直接会話の受付済み・完了未確認と、部屋の宛先別の完了未確認を区別し、部屋の他の配送失敗や振り分け失敗を優先する。履歴のない値や未知の値は従来の表示を維持する。配送の状態名はMacの7状態に合わせ、ルームの振り分け失敗、メッセージ自身の値、宛先ごとの最悪の値の順で決め、その上へ完了未確認を重ねる。ルームの返信先の自動選択は、`/api/settings`の`routing`が有効な間だけ使える。

## 画面構成（Mac版と同じ構成）

工程W-MAC（オーナー指示 2026-11-08）で、Windowsの画面をMac版（main `f62a4286`の`ios/`、Mac Catalyst）と同じ構成へ作り直す。下の2つの図は作り直し後の構成で、各PRがこの図に沿って画面を置き換える。差分と進み具合は[差分一覧](windows-mac-parity-gaps.md)に置く。OSの違いだけをWindowsの作法へ置き換える（⌘→Ctrl、窓の操作ボタン、タイトルバー）。Mac版の購入とAPNsの登録は移植しない。「利用と課金」は案内とリンクだけ、「通知」は起動中の通知の切替だけを置く（トロニー裁定 2026-11-08）。

```mermaid
flowchart LR
  subgraph Main[主窓 1280×820・最小1100×640]
    Sidebar[サイドバー 幅320〜420<br/>BellTeam・＋▾ メンバーを追加/ルームを作成<br/>Updateバッジ（更新がある時だけ）<br/>検索 Ctrl+K<br/>ルーム・メンバーの行: アバター57.6・2行の今の仕事・在席の点・ファスト<br/>予定 Ctrl+2・ゴール Ctrl+3・相関図 Ctrl+4・設定 Ctrl+,<br/>N人オンライン・利用者名]
    Detail[詳細の領域]
    Status[接続状態の帯]
  end
  Sidebar -->|行を選ぶ| Conversation
  Sidebar -->|予定| Schedules[予定のページ]
  Sidebar -->|ゴール| Goals[ゴールのページ]
  Sidebar -->|設定| Settings
  Sidebar -->|相関図 Ctrl+4| WorkGraphWindow[相関図の別窓 題名「相関図」・最小480×360・1つだけ（2回目は前へ出す）<br/>窓が見えている間だけ新着を受け取る・毎フレームの描画<br/>メンバーのクリック・Tabと矢印で選んでEnter・Spaceで本体の窓を前へ出してその会話を開く<br/>線へのホバーで待っている札・ホイールで箱の中の文を送る<br/>読み上げ: メンバーと依頼の要素]
  Sidebar -->|Updateバッジ| UpdateSheet[Updateシート]
  Detail --> Conversation[会話<br/>帯・吹き出し・受付確認中の仮の吹き出し・配送状態・Bot間の連絡・画像<br/>秘密入力・問い・処理中の帯と止める<br/>返信先・ゴールのカプセル・入力欄]
  Detail --> Inspector[詳細パネル Ctrl+Shift+I<br/>メンバー: 大画像と小画像・AIと操作・プロフィール・メンバーを編集<br/>ルーム: 共有する仕事・参加メンバー・ルームを編集]
  Inspector --> Screen[Botの画面<br/>1秒ごと・キーバー・許可の帯]
  subgraph Settings[設定 項目一覧300＋ページ]
    S1[プロフィール] --- S2[AIの設定<br/>AIの認証・仕事の要約を書くAI] --- S3[追加機能] --- S4[通知<br/>起動中の通知の切替]
    S5[接続] --- S6[表示<br/>会話の開き方]
    S7[利用と課金<br/>案内とリンク] --- S8[アップデート] --- S9[このアプリについて]
    S10[全体停止]
  end
  subgraph Sheets[主窓に重ねるシート 720×540〜820×680]
    MemberSheet[メンバーを追加] --- RoomSheet[ルームを作る・編集] --- GoalSheet[ゴールの編集] --- ScheduleSheet[予定の追加・編集]
    ImageSheet[小画像・大画像の操作] --- Crop[切り抜き 680×520] --- PeerSheet[メンバー間の連絡] --- SecretSheet[秘密の入力]
  end
  Inspector -->|メンバーを編集| MemberWindow[メンバー編集の別窓 1120×900]
  Conversation --> Gallery[画像の閲覧<br/>主窓いっぱいの黒い覆い・×・n / N・‹ ›・64のサムネイル]
  Conversation --> Corner[窓の右上の紫の丸いボタン<br/>詳細パネル・会話を書き出す]
  UpdateSheet -.同じ内容.- S8
```

起動の画面（Mac版RootViewと同じ段階）。接続できなかった時は、失敗の画面を出したまま自動で接続し直す。待ち時間は共通の再接続の段階（すぐ→1→2→4→8→15秒、以後15秒。各±20%）で、認証が必要・画面を離れる・接続先の変更・ログアウト・窓を閉じる時だけ止まる。「もう一度試す」はすぐに1回つなぐ（段階は戻さない）。つながるか認証が必要になれば段階を最初に戻す。

```mermaid
flowchart LR
  Launch[起動] -->|保存した接続先がない| Setup[BellTeamを始める<br/>接続先の入力・導入ガイドのシート]
  Launch -->|ある| Opening[BellTeamを開いています]
  Setup -->|続ける| Opening
  Opening -->|GET /api/session が失敗| Failure[接続できませんでした<br/>もう一度試す・接続先を変更]
  Opening -->|認証が必要| SignIn[ログイン<br/>ログインして始める→ログインのシート]
  Opening -->|GET /api/setup が ready 以外| Onboarding[初期設定<br/>AIの選択・認証・3秒ごとの状態確認]
  Opening -->|GET /api/setup が ready| Workspace[会話の画面]
  Failure -->|もう一度試す：すぐ| Opening
  Failure -->|自動：すぐ→1→2→4→8→15秒| Opening
  Failure -->|接続先を変更| Setup
  SignIn -->|ログインできた| Opening
  Onboarding -->|認証を確認して始める| Workspace
  Onboarding -->|接続先を変更| Setup
  Workspace -->|新着の接続が切れた・つながらない| Banner[下部の帯<br/>自動で再接続（すぐ→1→2→4→8→15秒）<br/>再接続・接続先]
  Banner -->|新着が届いた| Workspace
  Workspace -.いつでもログインが必要になる.-> SignIn
```

```mermaid
flowchart LR
  subgraph App[BellTeam.App 画面]
    A1[サイドバー]
    A2[会話・詳細パネル]
    A3[Botの画面]
    A4[ゴール]
    A5[予定]
    A6[設定の各ページ]
    A7[Update]
    A8[相関図の窓<br/>WorkGraphWindow・WorkGraphCanvas・WorkGraphText<br/>毎フレームの描画・入力・読み上げ。状態は持たない]
  end
  subgraph Core[BellTeam.Core 通信とモデル]
    C1[Workspace・BellApi<br/>一覧・会話・送信・SSE]
    C2[ManagementApi<br/>メンバー・ルーム・画像・書き出し・再起動・停止]
    C3[ScreenInputModel<br/>キー・許可の送信と確認]
    C4[GoalsApi]
    C5[PlanningApi]
    C6[SettingsApi<br/>所有者・規範・追加機能・AIの認証・仕事の要約・全体停止]
    C9[HarnessAccountsApi<br/>Claudeの1st・2ndアカウントの一覧]
    C10[WorkGraphModel・WorkGraphSimulation<br/>相関図の図の状態・シミュレーション・札の置き場所・入れ替え・clearance・当たり判定<br/>永続状態なし。文字の測り方は画面から受け取る]
    C7[UpdateCenter]
    C8[LocalSettings<br/>接続先・窓・通知・会話の開き方・要求ID]
  end
  A1 --> C1
  A2 --> C1
  A2 --> C2
  A3 --> C3
  A4 --> C4
  A5 --> C5
  A6 --> C6
  A6 --> C9
  A6 --> C8
  A7 --> C7
  A8 --> C10
  A8 -->|"アバター（既存の画像キャッシュ）"| C1
  C1 -->|"/api/session・bots・rooms（currentWork）・messages・queue・events"| API[共通入口 HTTP API・SSE]
  C2 -->|"/api/bots・rooms・avatar・avatar-large・export・restart・stop・models"| API
  C3 -->|"/api/bots/{id}/screen・screen/key・screen/approval"| API
  C4 -->|"/api/goals・/api/bots/{id}/goal"| API
  C5 -->|"/api/schedules"| API
  C6 -->|"/api/owner・user-rules・settings・settings/backgroundAgent・harness-auth（Claudeは?slot=2nd）・ai-control"| API
  C7 -->|"/api/updates・plans・operations"| API
  C9 -->|"GET /api/accounts（404は旧本体。上限だけで席のアカウントが決まり、設定する規則は無い）"| API
  C10 -->|"GET /api/work-graph/events（BellApi.WorkGraphEventsAsync。snapshot・changeの名前付きイベント。35秒無音・切断・読めない応答は再接続、404は60秒ごとに確かめ直す、ログインが必要なら止まる）"| API
```

- 状態の所有：会話・メンバー・予定・ゴール・追加機能・全体停止など本体の状態は、共通入口のAPIだけで読み書きする。Windowsが持つのは、このPCの設定（接続先・窓・起動中の通知・会話の開き方・Updateの要求ID）とログイン情報だけ。
- 新しいCoreの窓口（`ScreenInputApi`・`GoalsApi`・`SettingsApi`の追加分）は、Mac版が使う同じAPIを呼ぶ。サーバーの変更は要らない。
- 相関図の窓はWindowsの状態を何も保存しない。描画中の図はWorkGraphModelだけが持ち、窓を閉じたら捨てる。窓を閉じるか最小化している間は新着を受け取らず、開き直すと新しいsnapshotを今の図と突き合わせて動かす。接続が替わる（ログインし直し・接続先の変更）と、その接続の新着へ取り直す。窓は描いている図の接続先（`WorkGraphWindow.Origin`）を持つ。同じ接続先へのつなぎ直しは図を残して新しいsnapshotと突き合わせ、別の接続先になったら図を捨てて空の図から始め、その接続先の最初のsnapshotで埋まる。接続先の違う図のメンバーを押しても会話は開かず、その時点で図を捨てて今の接続先の新着へ取り直す。
- メンバーを開くと`MainWindow.OpenFromWorkGraphAsync`が、通知と同じ会話の開き方（`OpenConversationAsync`）で本体の窓の会話を開く。相関図の窓は残る。
### Macの追従で足す部分（2026-11-11、作る前の図）

[差分一覧](windows-mac-parity-gaps.md)の「Macの追従」14〜19の置き場所。各PRがこの図に沿って足し、作り終えたら上の図へ移す。

```mermaid
flowchart LR
  subgraph AppNew[BellTeam.App]
    N2[秘密の入力カード 14<br/>1Passwordから選ぶ・読み出す / ここに入力する・貼り付ける<br/>一回だけの値・検索欄]
    N3[設定 追加機能 1Password連携 15]
    N4[設定 端末 16a<br/>一覧・詳細・編集・ホスト鍵・鍵の行・理由の文・鍵の導入]
    N5[メンバー編集 端末とフォルダ 16b<br/>フォルダ選びのシート]
    N6[このPCを追加 16c<br/>S1・S2のWindows版。細部はクラストと決める]
    N7[状態の行 17<br/>起動できない理由・設定の適用・表示名・再起動の待ち・分身]
  end
  subgraph CoreNew[BellTeam.Core]
    W2[SecretRequestApi 14<br/>onepassword-items・submit]
    W3[TerminalsApi 16<br/>端末・確かめ・鍵・フォルダ]
  end
  N2 --> W2
  N3 --> C6x[SettingsApi]
  N4 --> W3
  N4 --> N2
  N5 --> W3
  N6 --> W3
  N7 --> C1x[Workspace・ManagementApi]
  W2 -->|"GET /api/secret-requests/{id}/onepassword-items・POST …/submit"| APIx
  W3 -->|"/api/terminals*（ingress RS09/RS12：一覧・登録・確かめ・trust・keys/{ssh,sudo}・keys/ssh/authorize・folders・folder）"| APIx
  C6x -->|"PATCH /api/settings/onePassword"| APIx
  C1x -->|"/api/bots（seatLaunch・configurationApplication）・/api/models（display_name）・restart（180秒）・messages（seat）"| APIx
```

- 端末と鍵の値はこのPCに置かない。鍵・パスワードは秘密の入力カードから本体へ送るだけで、一般の欄やログへ書かない。

- 失敗の扱い：理由を表示する。接続の失敗（起動の失敗の画面と新着のSSE）は、Mac・Webと同じ段階で自動に再接続する。新着は、切れた時（「更新の接続が切れました。再接続しています。」）と、つながらない・429・5xx（「更新へ接続できません。再接続しています。」）で続け、30秒を超えて保てた接続の後は段階を最初に戻す。止めるのは認証が必要・取り消し・ログアウトの時だけで、形式の異常など想定外の失敗も理由を添えて再接続を続ける。その他の操作の失敗（送信など）は自動で繰り返さない。例外はMac版と同じ定期の読み取り（Botの画面と許可の確認は1秒ごと、AIの認証待ちは3秒ごと）で、表示している間だけ動かす。

## 変更時の手順

変更前に[全体図](architecture/feature-map.md)からこの図、呼出元と接続先の図へ辿り、機能・入出力・状態所有・接続・失敗の扱いを確認して図の変更要否を決める。全caller、データ、test、fixture、設定、exportまで影響範囲を確認する。必要な図と接続情報はコードと同じ差分で更新し、図を変えない場合は既存図に収まる理由を変更説明に記す。全体図の生成と直接境界の検証は[共通手順](architecture/module-ownership.md)に従う。

## 更新センター

入口は、一覧の見出しのUpdateバッジ（更新がある時だけ。押すとUpdateシート）と、設定の「アップデート」ページ。Mac版と同じ内容を両方に出す。Updateシートはメイン窓の中の重ね表示（暗い背景、中央のカード、最小720x540・標準820x680、窓に収まる大きさ）で、題名「アップデート」と「閉じる」を持ち、Escでも閉じ、開くたびに読み直す。新しい最上位窓は作らない。シートと設定のページは同じ部品（`UpdateContent`）を使い、状態と文言の対応は`BellTeam.Core`の`UpdateScreen`に置く。状態は、確認中・確認できない・更新中・結果確認中・失敗・更新済み・更新あり・すべて最新・待ち・不明の10種で（待ち＝Macの`Status.waiting`：すべての機能が確認済みの公開版と一致か`incompatible`で、`incompatible`が1つ以上。「更新できるものはすべて最新です」と、合う版がまだ無い機能の名前を出す。`incompatible`の機能の状態バッジは「使えない版」）、上段のカード、確認が必要な機能の帯、機能の一覧（版と状態バッジ）、更新内容、ジョブの状態（旧サーバーだけ）、機能の問題、閉じた「詳細」の順に出す。更新中は主ボタンを出さず、同じ要求IDを5秒ごとにGETで読む。更新センターは更新の有無、提供された変更内容、現在必要な操作を先に示し、対象ごとの状態と診断情報は利用者が開く詳細に置く。状態・計画・影響・実行結果の正本は[共通入口](architecture/modules/integration/README.md)のUpdate API。Windowsは計画の内容を見せ、明示操作で固定planを実行し、requestIdを保持して同じ要求を照会する。結果が不明な操作を成功へ変えず、自動再送しない。

更新対象が複数ある場合は利用者が対象を選び、単独または共通APIの全体計画を取得する。計画の対象と影響を確認してから実行する。処理中・結果不明・失敗・検証済み完了を区別し、結果不明の要求は同じIDで照会する。通常画面では内部識別子や版のハッシュを表示せず、提供された分かりやすい公開版だけを示す。変更内容がなければ欄を出さない。

人工データを使う非表示の実画面previewは[設定のページ（混在）](assets/windows-update-page/update.png)、[すべて最新](assets/windows-update-page/update-current.png)、[Updateシート](assets/windows-update-page/update-sheet.png)、[最小幅](assets/windows-update-page/update-narrow.png)、[最小幅の詳細](assets/windows-update-page/update-detail-narrow.png)。画面は固定fixtureを表示し、実環境の更新を示さない。

起動中の更新通知は共通inventoryの `notificationCandidates` だけを使用し、同じ接続先と機能の最新digestを端末に保持して重複を抑止する。既存のWindows通知設定とToastを使い、押すと同じ接続先の更新センターを開く。受信による更新POSTはしない。アプリを閉じている間の通知は扱わない（オーナー判断 2026-11-08）。

```mermaid
flowchart LR
  Logo[ロゴ右のUpdate状態] --> Center[Windows更新センター]
  Center -->|一覧・計画・実行・同ID照会| API[共通Update API]
  API -->|updatesイベント| Center
  Center --> IDs[このPCの接続先ごとの要求ID]
```
