# 四種類の認証画面と専用入力

Claudeの再認証で公式リンクがなく、用途不明の入力欄とEnter/Up/Down/Tabだけを表示していた。設定と初期設定の双方を、Nativeが特定した公式認証の段階を表示する共通画面へ変更する。

- Claude: 公式ログインのリンクと手順、公式ページから戻る認証コードだけのpassword欄。公式CLIのテーマ/ログイン方法は意味の分かる選択ボタンを表示する。
- Codex/Grok: 公式ログインへのリンクと、その公式ページへ入力するdevice code。BellTeamへdevice codeを貼る欄は作らない。
- Cursor: 公式ログインへのリンクと完了待ち。観測していないコード入力を推測しない。
- 案内欠測/不明はその状態を表示し、汎用入力や端末キーを出さない。開始前のCodex資格置換警告は保持する。

既存HTTPの入力をNative専用agent_auth/respondへ置換。auth_ui.v1の既存native binding（legacy launch_id:nullを含む）とprompt_digestをそのまま照合し、expected_binding/expected_prompt_digestへ渡す。Rootが識別子/キー列を生成しない。汎用pty_send/pty_key経路は使わない。isErrorのnot_issued/unknownをHTTPでも保持し、入力失敗後は明示的な状態更新まで再入力を出さない。古いstatus応答が後発入力完了を上書きしないよう観測世代を保つ。席からの認証開始/コード入力は受け付けず、既案内会話の開始/完了は保持する。

## 検証

Root対象61件、さらに初期設定HTTPを加えた対象群と最終全756件が成功。初回全体754pass/1failは、内部APIの認証開始/入力が旧200期待のままだった試験を403契約へ更新し、外側Owner通常入口200と内部の案内会話完了を別確認した。元logを消していない。

実Chromium＋通常static配信/実HTTP/HarnessAuth＋人工Nativeで、4画面の公式案内・必要入力だけの表示・明示操作後の完了表示、console pageerror0を確認。通常CSSを使用した人工画面であり、実providerへの認証やOwner操作成功ではない。

実HTTP→AitermClient/SDK→通常Native MCP→自己人工CLIで、採用済みメニュー修理source7bd9eae6/tar ef72019f/110JS候補へ接続。コード受信digest一致、専用respond1回/汎用PTY呼出0、旧binding/旧prompt拒否、通常fixture fileとHTTP logへ本文無し、公式status相当の人工CLI応答、自己fixture終了を確認。旧6d proofと新7bd結果は別原本。最初の人工URLは公式URL識別条件不足、その後の人工CLIはlogin後の初期案内完了を実装していなかったためfixtureを修正し、元失敗logを保持した。実コード/現Ownerflowの操作は0。

原本はトロニーのintegrations/auth-flow-ux-20261025/（focused/full/browser-result/native-http-result等）、Native候補とruntime照合はintegrations/cecil-delivery-20261025/native-auth-7bd9eae/。NativeのCURRENT-MENU-1は独立Anchor受入で解消。旧6d fullを7bd全OS合格へ代用しない。

## 残条件

本PRは本体/Web source段階で、Nativeの正式版番号/tar供給・必要OS・Apple同契約・最終候補image・4種類の通常画面から公式認証完了までの結合とOwner受入が残る。未公開.17基点候補を正式.17として同梱しない。現Ownerの認証flowを失う本体再作成、新start/cancel、旧generic入力への案内は行っていない。

## 独立レビュー PR94-CENTI-1 の修理

設定と初期設定のpollAを保留→画面をhidden/visibleにしてpollB開始→Bの認証完了が先着→Aの旧コード入力または旧エラーが後着、という実モジュール人工DOMの反例を再現した。以前はperformだけが観測世代を進めていたため、read同士を順序付けできなかった。

両画面でpoll開始時にも同じ観測世代を進め、各readの成功/失敗は自分が最新観測である間だけ適用する。新しいstatusや変更、結果不明の表示を古いreadが巻き戻さない。コード入力後の明示更新待ち/専用respond/POST一回/旧poll対変更の修理は保持する。

新4反例は未修理headで4fail→修理後4pass、既必要境界を含む対象15pass、明示全体760pass/failcancelSkip0。元全756ログ/Native専用入力/4人工画面の成功原本は保存し、同じ成功群や実Native workerを再実行していない。製品増分は両Webmoduleのpoll観測番号だけ。現Ownerflow/実コード/本番作用0、Draftと正式Native/OS/Apple/最終image/公式完了の残条件を維持。
