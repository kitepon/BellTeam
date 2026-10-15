# BellTeamアプリの通信診断7件

## 対象と判定

トロニー経由のフラジャイルの依頼に基づくアプリ担当の評価。BugHubの原本、累計、重大度、未解決状態は変更しない。10/15の49で起きた2件は、iPhone・背景・公開接続のGETである。診断の受信時刻を端末の失敗時刻とは扱わず、既存記録から通信が止まった区間を決めない。

| 行 | 現行コードで読める利用者影響と対処 | 隔離で確かめたこと | 残条件 |
| --- | --- | --- | --- |
| `522e820f` conversation 500、旧high暫定、16回、最新35 | 会話GETの失敗はエラーを表示し、既存メッセージと下書きを消さない。成功した次の取得でエラーを消す。初回取得失敗で「話しましょう」も出た表示欠陥を修理した。 | HTTP 500の要求診断で実際の会話経路とstatusを記録。iPhone Simulatorの500→「読み込めません」→手動再読込200と作り物の返答、入力保持を実画面で確認。 | 当時の原本に操作・影響がなく、過去の実害と根因は未確定。現行版での500の表示欠陥は修理済みだが、旧行はopenのまま。 |
| `cb3506c0` events 502、旧high暫定、4回、最新35 | 現行コードは再接続中と表示し、1秒から最大30秒の間隔で再接続する。SSE通知後に表示を消し、一覧の再取得を求める。 | 502→SSE通知でAPIの回復、AppStoreの再接続表示→表示消去を模擬確認。iPhoneのBellTabsで再接続文が見えるUI試験も成功。 | 旧35の事象を現行49の欠陥とは扱わない。当時のトンネル断以外の経路・端末時刻は未確定。 |
| `c882af7b` conversation GET -1001、warn、6回 | 会話GETの失敗は既存メッセージを保持し、エラーを表示する。前面での次の取得で復帰できる。背景へ移った後に既に始まった会話GETは専用の取消Taskを持たない。 | -1001の模擬要求で開始状態・開始/失敗時刻・経路・TaskMetricsを診断へ記録。 | 最新49の12:59:16.515は診断受信時刻。要求の実際の段・通信区間・背景移行との前後関係は新しい診断待ち。 |
| `8988b6a2` schedules GET -1001、warn、6回 | 約50件を逐次GETし、1件の失敗で更新全体を止める。既存表示は保持し、エラーを表示する。初回失敗で「予定はありません」も出た表示欠陥を修理した。背景移行では保持したloadTaskを取消す。 | iPhone Simulatorで最初の予定GETを模擬503にすると誤った空表示が出ると再現。修理後は「読み込めません」→手動再読込200で正常な空状態へ変わると実画面で確認。既知予定行を表示したままの背景取消・復帰も隔離実画面で確認。 | 最新49の08:28:06.960も診断受信時刻。逐次取得が個々の時間切れを起こした証拠はない。 |
| `eb39292e` bots GET -1001、warn、3回 | 一覧更新はBot・ルーム・owner・queueを並列に読む。失敗時は既存一覧を保持し、接続エラーを表示する。従来はどのGETが失敗しても`/api/bots`と報告していた。 | 失敗した要求自身の経路を診断へ添える模擬試験に成功。背景移行で前面復帰の保留GETを取消し、古い結果を反映しない試験も成功。 | 個々の過去3件の失敗経路は既存記録から復元できない。 |
| `5e6c5a31` settings GET -1001、warn、2回 | 設定GETの失敗はエラーを出し、既知の設定一覧を保持する。初回に一覧がない場合は設定値を確認できない。 | 共通BellAPIの-1001要求診断を模擬確認。設定Editorの初回GETを503にすると未取得の初期値で保存が有効になる欠陥をiPhone Simulatorで修正前に再現。修正後は保存無効、取得失敗表示、手動再読込後の既知値表示と保存有効を実画面で確認。 | 過去の要求段・通信区間は未確定。修理版の実機操作は未確認。 |
| `95656cbb` conversation POST -1005、warn、2回 | POSTは自動再送しない。結果未確定と表示し、送信前の本文と画像を入力欄へ戻す。 | 模擬-1005でPOSTは1回だけ、診断は結果未確定、本文は診断へ入らない。iPhone Simulatorでも応答前に接続を閉じ、入力欄の文字・既存会話の保持と結果未確定の表示を確認。 | サーバーで保存されたかは過去の記録から判定できない。画像の復元も隔離UI試験で確認済み。過去のPOSTの保存成否は未確定。 |

## 診断の変更

通常のURLSession要求に要求単位のdelegateを付け、失敗した要求の経路、メソッド、端末での開始・失敗時刻、開始時の画面状態、試行回数、取得できたTaskMetricsの接続・要求・応答時刻と接続再利用を、既存`diagnostic_log`へ添える。製品が生成する既存のBot・ルームIDは要求の照合に使うため経路へ残し、任意のIDは`:id`へ置き換える。URL query、host、名前、本文、認証情報は記録しない。TaskMetricsが無い時は`task_metrics_available=false`とする。-1005の既存GET再取得以外の再送、ID体系、キューは加えない。Appleの[一次資料と解釈](../../rag/apple-networking/task-metrics.md)を参照。

本体の指紋は`code:module:severity`を使うため、同じ3値なら診断ログの項目追加だけでは指紋を変えない。ただし50は失敗した実経路からmoduleを選ぶ。49でbotsやmessagesへ固定していた報告の実GETがrooms・owner・queue等なら、将来はmoduleが変わり別指紋になり得る。旧7件の原本・累計・openは移動・統合しない。

模擬通信では-1001、HTTP 500、events 502、POST -1005の診断に要求経路と時刻が付いた。-1001とHTTP 500ではTaskMetricsも収集できた。events 502では`bytes(for:)`が応答ヘッダーを返した時点で判定するため、その瞬間のTaskMetrics取得は保証できず、模擬試験では未取得と記録された。events 502後のSSE復帰と、前面復帰GETの背景移行時取消もfocused testで確認した。署名を切ったNetworkRecoveryTests全体の1件はApp Group権限不足で失敗しており、この通信修理の試験失敗とは分ける。

focused testの実測: `NetworkRecoveryTests`の-1001・500・502・POST -1005は各成功、502から再接続中表示・通知受信後の消去も成功、`ForegroundRefreshTests`の背景取消2件は成功、`BellDiagnosticsTests`の既存5件と生成済みの不透明IDだけを残す1件は成功。作り物データの`ConnectionErrorUITests`は、iPhoneの再接続文を表示する既存動作を1件成功で確認した。Mac Catalystビルド成功。サーバー担当の変更を取り込んだリポジトリの`npm test`は459件成功。

画面試験の模擬APIはMacの127.0.0.1だけで起動し、iPhone SimulatorのDebugプレビューが読む。会話初回GETを500、次を200とし、予定の最初のGETを503、再読込後を200とした。会話では失敗時の誤った「話しましょう」を修正前に再現し、修正後の「会話を読み込めませんでした」とボタンからの復帰を確認。予定では失敗時の誤った「予定はありません」を修正前に再現し、修正後の「予定を読み込めませんでした」とボタンからの復帰を確認した。会話の入力は再読込の前後で同じ文字列、模擬APIへのPOSTは0件。模擬サーバーとアプリを停止し、Simulatorも終了した。

別の隔離試験では模擬GETで開発者区分を返した後、会話POSTの要求本文を受け取って応答前に接続を閉じた。模擬サーバーが受けた会話POSTは1件。iPhone画面に結果未確定の案内が出て、送信前の入力欄の文字列と既存会話が保持された。診断用POSTも模擬サーバー宛てであり、本番へは送っていない。試験後にアプリ、模擬サーバー、Simulatorを停止した。

## 進行状態

この文書は隔離検証とコード読取りの現在地。7件を解決済みへ変更する根拠ではない。Mac Catalystのビルドは画面変更まで成功。iPhone実機での故障試験・本番通信断・実課金・確認前POST再送の試験は行わない。配布候補 `1.0.1(50)` のIPAとpkgは署名・Apple事前検証済みだが、後から見つけた設定Editorの修理を含まないためアップロードしない。旧候補の配布申請は取り下げた。修理を含む `1.0.1(51)` はGitHub main `420bf45`からiPhone IPAとMac pkgを書き出し、本体・通知拡張51、署名、Apple事前検証エラーなしまで確認した。オーナーの配布承認を受けて両方をAppleへ送信し、AppleでVALID、オーナー向け内部配布は`IN_BETA_TESTING`。MacはTestFlightから51へ更新し、本体・拡張の版番号、配布署名、通常起動を確認した。iPhoneはオーナーからTestFlightで51へ更新して起動したとの回答を受けた。iPhoneの版番号はこのMacから読み取っておらず、本人報告として区別する。実機での通信故障や修理UIの再現試験も行っていない。

## 10/15 16:09受信のMac inactive 2件

トロニーが原本を確認し、`c882af7b`は6→7、`eb39292e`は3→4になった。両方とも版49、Mac、inactive、公開接続、GET、`NSURLErrorDomain -1001`、warn/open、`feature_unavailable`・`error_shown_data_retained`・`manual_retry_available`である。16:09:14.636/.637 JSTは診断の受信時刻であり、要求の失敗時刻ではない。原本に要求path・開始/失敗時刻・開始時のapp状態・TaskMetricsは無い。特に49の一覧診断の`/api/bots`は報告側の固定値なので、実際に失敗したGETを証明しない。

会話側も49の`ConversationView.loadInitial`と`refresh`はmessagesとqueueを並列GETし、どちらが失敗してもmessagesのpathを診断へ渡す。したがって中央の`conversation` moduleから実GETをmessagesと確定できない。50では失敗した要求自身の経路を使う。

トロニーのホスト原本照合では、15:59〜16:19に本体例外0、16:09:14.635/.636の診断POSTは202（2ms/1ms）。16:08:13にcloudflaredはGET owner/rooms/bots/queueと`bot-57403a80/messages`の`context canceled`を記録し、別にevents取消2件・schedules取消1件があった。CaddyのBellTeam warnはevents2件（UA BellTeam/49）、再接続ログ0。要求の実失敗時刻と個別の相関が無いため、このGET群を16:09の2診断そのものとは断定しない。本体`c35e382`にはGET受付/終了ログがまだ本番反映されておらず、到達と完了の欠測が残る。本体例外0や取消ログの数から、端末要求の未到達を推定しない。

版49と候補50の会話・一覧の状態遷移をコードで比較した。`.inactive`移行ではAppStoreは保留GETを取り消さず、`.background`移行では前面復帰TaskとSSEを取り消す。再び`.active`になると接続プールをflushし、一覧を読み直してSSEを張り直す。会話の更新は開始時にactiveかを確認するが、始まった後のGETをinactiveで専用取消しない。失敗時は既存会話・下書きを保持し、一覧は4種類の取得が揃ってからまとめて反映する。候補50は要求単位の診断と初回取得失敗時の空表示だけを変え、取消・再送・復帰の条件は変えていない。

今回の2行だけでは、そのGETがactiveで始まりinactiveになったのか、inactive中に始まったのか、どの通信段で止まったのか分からない。既存データ喪失や復帰失敗は観測されていない。取消条件を増やす追加修理は行わず、次の版50診断と、本体のGETログが反映された後の記録で照合する。Mac inactiveの実機故障試験は行わない。

## 10/15 17時台の追加3条件

- 設定Editor: 作り物の設定一覧GETを成功させ、Editorの初回GETだけ503にした。修正前のiPhone Simulator実画面では未取得の`enabled=false`・空fieldsのまま「保存」が有効だった。修正後は取得前のToggleとfieldsを表示せず、保存を無効にし、「設定を読み込めませんでした」と「再読み込み」を表示する。再GET成功後にサーバーが返した`enabled=true`と「保持する値」を表示し、保存を有効にした。失敗までPATCHは0件。既知の一覧は`refreshSettings()`が成功時だけ更新するため、Editor取得失敗で消えない。修正前は`runtime/settings-initial-before-real.xcresult`で期待どおり失敗、修正後は`runtime/bughub-three-focused.xcresult`で成功。Mac Catalystビルドも成功。
- 予定: 既存の`testExpectedScheduleCancellationDoesNotRegisterFailure`を新しい隔離サーバー状態で実行し成功（`runtime/bughub-schedule-isolated.xcresult`）。進行中の予定GETの接続が閉じ、後続の逐次GETを始めず、診断も登録せず、前面復帰後に再取得して「予定はありません」へ到達した。`fetchEntries()`は全件取得成功後だけ`entries`を置き換えるため、取消時の既知行は保持される。既知行を表示した追加画面試験は、保留したrefreshableのアイドル待ちから進まず中止した。既知行保持と手動プル更新の組合せは実画面で未確認とする。`.inactive`の取消条件は増やしていない。
- 画像付きPOST: Debugプレビューで作った青い画像1枚と試験文を入力し、模擬サーバーがPOST本文を受け取ってから応答前に接続を閉じた。iPhone Simulator実画面で結果未確定を表示し、試験文・画像の削除ボタン・既存会話を保持した。受信した会話POSTは1件、画像payloadも1件（`runtime/bughub-three-focused.xcresult`）。画像そのものや本文は診断記録へ入れていない。

この追加分のリポジトリ全試験は459件成功（`runtime/bughub-three-npm-test.log`）。隔離サーバーと試験アプリは終了済み。本番通信断、実課金、実機での故障注入、旧原本の変更は行っていない。

隔離サーバーの再現用fixtureは`test/fixtures/bughub-ui-probe.mjs`。Macのloopback `127.0.0.1:18896`で起動し、UI試験runnerへ`BELLTEAM_REPORTING_PROBE_URL=http://127.0.0.1:18896`を渡す。初回設定GET失敗、保留予定GET、画像付きPOSTの切断をすべて作り物のデータで返す。

## 10/15 17:40の追加2組合せ

- 取得済み設定の後続GET失敗: 一覧とEditorの設定GETを成功させ、Editorで保存PATCHを1件受けた後の3回目のGETだけ503にした。iPhone Simulator実画面では編集欄の「保持する値」と有効スイッチが残り、一覧へ戻っても「有効」のままだった。GETは3件、PATCHは1件。`runtime/settings-known-later-failure.xcresult`で試験成功。送信結果が未確定になる本番の挙動を再送した試験ではない。
- 既知予定行の背景取消: 最初の取得で「隔離予定」を表示し、背景→前面で次のGETを保留した。その間も既知行が画面に残ることをスクリーンショットで確認。再び背景へ移すと保留GETが閉じ、後続の逐次GETは増えない。前面復帰後は既知行を表示し、次の正常な空結果で「予定はありません」へ更新した。`runtime/schedule-known-background.xcresult`と添付画像を確認した。前のrefreshableを使うXCTest試行はアイドル待ちで中止し、この試験ではscenePhaseによる既存の再取得経路を使った。手動プル操作そのものはこの追加試験の対象外。

2組合せとも候補51のアプリコードに追加修理は無い。追加したのは隔離fixtureとUI試験だけなので、署名済み51との差分による再署名・Apple事前検証は不要。App Store Connect接続ツールのRESTアップロードは属性名不足でAppleに拒否されたため、同じツールのApple公式`altool`方式で両成果物を送信し、いずれも受領された。署名済みバイナリの変更はない。

## 10/16 00:53のMac版51・同時刻の時間切れ2件

トロニーの保存原本を本番コンテナ内から読み取った。`c882af7b`は7→8で`/api/bots/bot-57403a80/messages`、`eb39292e`は4→5で`/api/bots`。どちらもMac版51・public・GET・`-1001`で、要求開始`00:52:11.808`、失敗`00:53:12.807` JST、開始時`inactive`、アプリの試行回数1。TaskMetricsは利用可能で2トランザクション。診断に記録される**最後のトランザクションだけ**の`fetchStartDate`と`requestStartDate`は`00:52:11.817`、`isReusedConnection=true`。`requestEndDate`と`responseStartDate`は記録されていない。診断の受信は`00:53:12.870/.871`で、要求の失敗時刻と区別する。両者の開始・失敗時刻が同じでも、同一接続・同一原因とは判定しない。

`request_attempts=1`は`BellAPI.load`が数えるアプリの`session.data(for:)`呼出し回数であり、GETの`networkConnectionLost`を捕捉した時だけ2になる。`transaction_count=2`はAppleが1つのURLSessionTask内で記録した要求・応答トランザクション数で、アプリの再送2回を意味しない。最初のトランザクションの段・redirectCount・接続識別子はこの診断にない。最後の接続再利用だけから二つの要求が同一接続だったとも、本体到達や取消との相関とも言えない。60.999秒はAppleの既定60秒の追加データ待ち時間と整合するが、どの区間で待ったかは特定できない。[Appleの原文](../../rag/apple-networking/raw/urlsession-task-metrics.md)を参照。

アプリは既存会話のGET失敗でメッセージと下書きを消さずエラーを表示する。一覧のBot・ルーム・owner・queueは全部揃ってから反映するため、失敗時は既存一覧を残す。原本の`error_shown_data_retained`は、報告時に既存データが空でなかったことを渡すコード上の分類で、利用者がその後の復帰を確認した証拠ではない。`manual_retry_available`も分類値で、手動操作や成功の観測ではない。次のactiveでは接続をflushして一覧を読み直し、会話はactive時やSSE通知で再取得する。今回の実要求が成功した後続記録、画面表示、利用者操作は原本に無く、実環境での復帰は未確認。

トロニーのホスト保存記録では、この要求窓の本体GET受付・終了ログは無く、稼働コンテナにもその計測コードがまだ入っていない。本体例外0と診断POST各202は、元GETが届かなかった証拠ではない。cloudflaredの近い`/api/bots`取消とevents取消は相関IDが無く、今回の失敗要求との対応を決めない。container再起動0、journal抽出異常0、直前のsar標本も個々の要求の原因を証明しない。原因・本体到達・回復時刻は欠測のまま。

別のアプリ表示欠陥を隔離で確認した。模擬-1001で一覧更新に失敗した後、SSE通知なしで同じ一覧GETを成功させると、Bot一覧は新しい値へ更新されても古い`connectionError`が残った。`runtime/bughub-stale-banner-isolated.xcresult`のfocused testはこの期待で失敗し、再現用patchを`runtime/bughub-stale-banner-isolated.patch`へ保存した。最初の試行は署名なしApp Groupのアバター取得で止まり、fixtureの版付きアバターだけを外して切り分けた。この表示欠陥が今回のMac実機2件で発生した証拠はない。`connectionError`はSSEの再接続警告にも使うため、成功GETで単純に消す修理はしない。通常GETとSSEのエラー状態を区別する最小設計、focused test、Mac/iOSの配布が残工程。版51のバイナリは未変更で、BugHub原本の状態・重大度・指紋も変更していない。

適用範囲: Mac Catalystは今回の実診断と同じSwift実装。iOSも同じBellAPI・会話・一覧のコードを使うが、この事象の実機再現はしていない。Windows nativeは別の`HttpClient`実装でURLSessionTaskMetricsを使わず、この二件をそのまま適用・検証した扱いにしない。Linuxは本体とログの設置であり、このSwiftUIクライアントの修理対象ではない。Claude Code・Codex・Grok・Cursorのどの席かに応じた分岐はこのGET経路にない。Bot IDだけではハーネス別の発生・不発生を判定しない。

## 一覧GETとSSEの表示状態を分ける修理

隔離の修正前試験では、一覧GETを一度-1001にした後、SSE通知を発生させず次の一覧GETを成功させた。Bot一覧は更新されたが、`connectionError`は古い-1001のまま残った（`runtime/bughub-stale-banner-isolated.xcresult`）。最初の署名なし試行はApp Groupのアバター取得で失敗したため、再現fixtureだけ版付きアバターを外して切り分けた。再現patchは`runtime/bughub-stale-banner-isolated.patch`に保存した。この表示欠陥は今回のMac実機2件で観測されたと扱わない。

`AppStore`の通常一覧GET、SSE、通知のエラーを別々に保持し、画面へ見せる`connectionError`だけを合成する。通常GET成功時はGETのエラーだけ消し、SSE警告が未回復なら表示を維持する。SSE通知時はSSEの警告だけ消し、GETが失敗したままならそのエラーを残す。再認証時はすべて消す。inactive取消・GETの再試行条件・診断指紋・BugHub状態には変更を加えない。

修正後のiOS Simulator focused testは、GET失敗→成功時の旧エラー消去と既知一覧・下書き保持、SSE未回復中のGET成功で再接続警告維持、SSE回復とGET失敗が重なる時のGETエラー維持の3件が成功（`runtime/bughub-stale-banner-fixed.xcresult`）。既存のSSE 502復帰・GET失敗診断・認証復帰の3件も成功（`runtime/bughub-stale-banner-regression.xcresult`）。Mac Catalystビルド成功、リポジトリ全459試験成功。実環境での新修理の表示は未確認。Apple配布は版52の署名候補を別に作り、51の配布承認を流用しない。

版52はmain `1cdd7d9`からiPhone IPAとMac pkgを署名付きで書き出した。本体・通知拡張とも52で、IPA内の版番号とMacアーカイブの署名を照合した。両成果物のApple事前検証はエラーなし。検査値と配布待ちの状態は`docs/subscription-setup.json`に保存する。TestFlightへのアップロードと端末導入は新しい決裁の対象とする。

オーナーの版52配布承認を受け、Mac・iPhone版はAppleで両方VALID、オーナー向け内部グループで`IN_BETA_TESTING`になった。MacのTestFlightは52を表示するが、更新後しばらく「ダウンロード中」のままで、`/Applications/BellTeam.app`はまだ51。TestFlightの停止・再開と通常の再起動後も同じ表示で、インストール52の完了と起動は未確認。iPhone本人のTestFlight更新・起動は決裁箱で依頼中で、こちらから端末操作・照会はしない。配布の受領と端末導入を区別して記録する。

Macのダウンロード表示は開始から十数分後も続き、表示メニューの更新でも変わらなかった。空き容量は十分で、TestFlight画面に認証やインストールのエラー表示は無い。原因は未特定。Macの51を保持し、TestFlightのダウンロードが完了した後に本体・通知拡張52、配布署名と通常起動を確認する。配布用pkgを別経路で直接導入してTestFlight導入済みとは扱わない。
