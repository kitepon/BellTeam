# Windows版のMac完全再現：画面ごとの差分一覧

工程W-MAC。オーナー指示（2026-11-08）：WindowsアプリでMacアプリを完全に再現する。画面・配置・部品・状態の印・操作の流れ・文言をMacと揃え、既存のWPFアプリ（`windows/`）でネイティブに作る。WebViewで包む方式は採らない。OSの違いだけをWindowsの作法に置き換える（⌘→Ctrl、窓の操作ボタン、タイトルバー）。

参照元はmain `f62a4286`（PR #634を取り込んだ版）の`ios/`と、Apple担当ベルの確認用写真（FOX `C:\Users\kite_\Developer\mac-reference-20261108\`、83枚）。比較に使う写真は`assets/windows-mac-gaps/`へ写した。Windows側は現行main（`6d48bf3b`）を、Macと同じ`PreviewFixtures`の人工データで、窓を出さずに描いた（`windows/BellTeam.Tests/fixtures/mac-ui-reference.mjs`）。Macの全画面・ライトとダークの写真がそろったら、この一覧を照らし合わせて直す。

規模の目安：S＝半日、M＝1日、L＝2日（実作業。写真の並べ比べを含む）。

## 1. 外枠とサイドバー — M

対応済み（PR 1）：[Windowsのサイドバー](assets/windows-mac-gaps/windows/pr1-sidebar.png)・[全体](assets/windows-mac-gaps/windows/pr1-workspace.png)。「ゴール」の入口とCtrl+3はゴールのPR（7）で足す。接続先の変更は設定へ移し、手動の再接続は下部の接続状態の帯へ置いた（Windowsは自動で再接続しないため）。

| Mac | Windows |
| --- | --- |
| [設定表示時の外枠](assets/windows-mac-gaps/mac/mac-profile-after.png)・[一覧の行](assets/windows-mac-gaps/mac/summary-mac-340-natural-after.png) | [現行](assets/windows-mac-gaps/windows/01-workspace.png) |

- サイドバーの幅：Macは最小320・標準340・最大420。Windowsは340固定。
- 見出しの右側：Macは「＋▾」メニュー（「メンバーを追加」「ルームを作成」）。更新がある時だけ紫の↓丸アイコン（UpdateBadge）が出て、押すとUpdateシートが開く。Windowsは「Update · 状態」の文字ボタンが常に出ていて、「＋」から追加メニューを開く。
- 一覧の行：Macはアバター57.6、名前16pt semibold、名前の直後に「⚡ ファスト」。メンバーの2行目は「今の仕事」の要約（`currentWork`：要約／「作業中・要約未設定」／「作業中・要約期限切れ」／「待機中」／「仕事状況を未取得」）を最大2行、11ptで出す。Windowsはアバター48で、最後のメッセージを1行、ファストの印は右寄せ。
- 在席の点：Macは仕事中なら赤く点滅（0.8秒）、待機中はミント、オフラインは灰色。Windowsは点滅しない。
- 下部：Macは「予定」「ゴール」「設定」の3つ（Ctrl+2・Ctrl+3・Ctrl+,）。Windowsは「ゴール」が無く、地球と更新のアイコンが余分にある。
- 何も選んでいない時：Macは「検索  ⌘K」「送信  Return」の案内付き（Windowsでは⌘KをCtrl+Kに置き換える）。
- 接続状態は下部の帯に赤字で出す（「更新の接続が切れました。再接続しています。」など）。

## 2. 会話 — L

Mac：[1.0.1(48)の3ペイン](assets/mac-ui-reference-48/01-workspace.png)（PR #634での見た目の変更は一覧の行と大きさが中心）／Windows：[現行](assets/windows-mac-gaps/windows/01-workspace.png)

- 上部の帯：アバター34、名前（18pt）、ファスト、補足（「N人のルーム」または「オンライン」「オフライン」）、書き出しボタン（square.and.arrow.up、「会話を書き出す」）。Windowsは保存アイコンと詳細の切替が並ぶ。
- 空の状態は「<名前>と話しましょう」「最初のメッセージを送ってみてね。」、読込失敗は「会話を読み込めませんでした」「再読み込み」。Windowsは「チームと、同じデスクで。」系の文言。
- 新着ボタンは、未読の新着がある時「新着メッセージ ↓」、無い時「最新へ ↓」。
- 配送状態：「受付確認中」「受付済み・反映待ち」「送信待ち」「処理中」「中断」「配達済み」「配達失敗」。Windowsは文言の一部が欠ける。
- ルームの返信者の表示：「返信者を判定中」「返信者の判定に失敗」「返信: A、B」。
- Bot同士の連絡は「<名前>との連絡 ›」のカプセルにまとめ、押すと「メンバー間の連絡」シートが開く。Windowsはその場で折り畳みを開く。
- 画像は1枚なら最大幅230、複数なら最大3枚を扇状に重ね（230×322）、「画像N枚」を添える。
- 処理中の帯：ルームでは処理中の各メンバーに「止める」ボタンを付け、結果の3文言を出す。
- 入力欄：赤い「今の動作を止める」（処理中・待機中の時だけ）、紫の↑送信ボタン（「送信（Return）」）、ゴールのカプセル（6節）、ルームの返信先は紫のカプセル型メニュー（「返信者を自動選択」「返信するメンバーを選択」「返信: <名前>」「返信: N人」）。添付の縮小画像は60pt。

## 3. 詳細パネル（メンバー・ルーム） — L

Mac：[48の詳細パネル](assets/mac-ui-reference-48/01-workspace.png)／Windows：[現行](assets/windows-mac-gaps/windows/01-workspace.png)

- 上部（BotProfileHero）：正方形の大画像の左上に、白枠付きの小画像（Macでは152pt）を重ねる。どちらも押すと「小画像の操作」「大画像の操作」シートが開く（「画像変更」「画像調整」、保留中の選択の確認・破棄、各状態の文言）。Windowsには大画像が無い。
- 「AIと操作」カード：「ハーネス」「希望モデル」「希望エフォート」（空なら「CLIの既定」）、「Botの画面を見る」「会話セッションを再起動」。Windowsは同じ機能を持つが、並びと見出しが違う。
- 「プロフィール」の5項目と「メンバーを編集」（目立つボタン）。押すと別窓（1120×900）が開く。
- ルーム：アバター76、「この部屋で共有する仕事」「参加メンバー」（30ptの行、押すとそのメンバーの会話へ）、「ルームを編集」。
- 幅：メンバーなら会話と半分ずつ、ルームなら280。Windowsは同じ。

## 4. Botの画面とキーバー — M

| Mac | Windows |
| --- | --- |
| [キー](assets/windows-mac-gaps/mac/screenkeys-keys-820-light.png)・[許可](assets/windows-mac-gaps/mac/screenkeys-approval-820-light.png)・[数字と失敗](assets/windows-mac-gaps/mac/screenkeys-digits-error-820-light.png) | 画面の表示だけ。キーバーは無い |

- 見出しは「プロフィールに戻る」と「<名前>の画面」。黒地に白の12pt等幅で、1秒ごとに更新（Windowsは2秒）。状態行は「1秒ごとに更新」または「停止中」。
- キーバー：1段目は「取消」「Tab」「決定」（紫）「中断」（赤）、2段目は「左」「上」「下」「右」「数字」（0〜9の段を開く）。送信中は回転、成功後1.2秒チェック。API `POST /api/bots/{id}/screen/key`。
- 許可の帯（琥珀色）「許可を求められています」。選択肢ごとのボタン（`approve_once`は緑）。`GET/POST /api/bots/{id}/screen/approval`。
- 注意文：「画面が変わりました。もう一度確認してください」など5種。

## 5. メンバー追加・編集、ルーム、画像の切り抜き — M

| Mac | Windows |
| --- | --- |
| [メンバーを追加](assets/windows-mac-gaps/mac/mac-sheet-new-member-after.png) | [メンバー編集](assets/windows-mac-gaps/windows/02-member-editor.png) |

- Macは1列の区分けしたフォーム（メンバー／画像（追加時のみ）／AI／プロフィール／削除）。上部に「キャンセル」「保存」がある。Windowsは2列の配置で、保存とキャンセルが右下。
- 「画像」の区分：「小画像を再調整」「大画像を変更」「大画像を再調整」「大画像を小画像と同じに戻す」と各注意文。Windowsには無い。
- AI：CLIの候補（Codex・Claude・Grok・Cursor・Antigravity）はWindowsも同じ。モデルに「その他」（「モデルID」欄）、エフォートに「X（現在の設定）」があるかは、作業時に照合する。ファストを使えない時の理由文は5種。
- 削除：「メンバーを削除」と、確認文・結果文（「削除を受け付けました。…」「削除結果を確認」）。Windowsには削除が無い。
- 保存結果の4文言を揃える。
- ルーム：「ルームを作る」「ルームを編集」、「代表Bot」（「代表なし」）、削除の文言。
- 画像の切り抜き：680×520、指示文、320のプレビューと「拡大・縮小」の240幅パネル、「キャンセル」「使用する」。

## 6. ゴール — L（Windowsに無い）

- ページ（Ctrl+3）：見出し「ゴール」と「設定済みのゴールと、現在取得できた状態。」、「ゴールを更新」「ゴールを設定」（メンバー選択のメニュー付き）、読込失敗と空の状態。
- カード：状態（「進行中」「一時停止」「進行できない状態」「利用制限」「予算に到達」「完了」）、目的、使用量、「前のゴール」「取得 <日時>」、操作「設定」「編集」「一時停止」「再開」「取り消す」。
- 会話のカプセル：状態と経過時間。押すと開いて「状態を更新」。
- 編集シート「<名前>のゴール」：「目的」（4000文字まで）、「トークン予算（任意）」、注意文。
- API：`GET /api/goals`、`/api/bots/{id}/goal`。

## 7. 予定 — S

| Mac | Windows |
| --- | --- |
| [48の予定](assets/mac-ui-reference-48/03-schedules.png) | [現行](assets/windows-mac-gaps/windows/03-schedules.png) |

- 右上は紫の丸い「＋」だけ。Windowsは「再読込」と「予定を追加」の2つ。
- カードの右上に種類のアイコン（一回なら予定表、繰り返しなら矢印）。日時は「次回 10月14日(水) 9:00」（時計アイコン付き）。Windowsは「10/14 (水) 09:00」。削除はごみ箱アイコン、ボタンは薄い面付き。
- 空の状態「予定はありません」「右上の＋から追加できます。」。編集シートの繰り返し名「毎週」（Windowsは「曜日」）。

## 8. 設定 — L（作り直し）

対応済み（PR 3の追加修正）：選んだ項目の行はMacと同じく紫の角丸で、題名と説明が白。ページの本文は最大幅720で中央に置く。「利用と課金」の説明は一覧と見出しの両方で「料金と、サーバーとAIの契約」。画像は`pr2-settings-*.png`を差し替えた。

対応済み（PR 2）：Windowsの全10ページ（`assets/windows-mac-gaps/windows/pr2-settings-*.png`）。一覧の行の要約はMacと同じ3種類の文で、幅320と340で2行に収まることを確かめた（`pr2-summary-rows-320.png`・`pr2-summary-rows-340.png`）。AIの認証の行を押すと、今は従来の認証の窓を開く。ページ上部にMacの題名の帯は無い。「利用と課金」の説明は、Windowsに購入が無いため「料金と、サーバーとAIの契約」とした。利用規約のリンクは、自前の規約URLが無いため置いていない。

| Mac | Windows |
| --- | --- |
| [プロフィール](assets/windows-mac-gaps/mac/mac-profile-after.png)・[AI](assets/windows-mac-gaps/mac/mac-ai-after.png)・[追加機能](assets/windows-mac-gaps/mac/mac-features-after.png)・[通知](assets/windows-mac-gaps/mac/mac-notifications-after.png)・[接続](assets/windows-mac-gaps/mac/mac-connection-after.png)・[表示](assets/windows-mac-gaps/mac/mac-display-after.png)・[課金](assets/windows-mac-gaps/mac/mac-billing-after.png)・[Update](assets/windows-mac-gaps/mac/mac-update-after.png)・[このアプリ](assets/windows-mac-gaps/mac/mac-about-after.png)・[全体停止](assets/windows-mac-gaps/mac/mac-stop-after.png) | [上部](assets/windows-mac-gaps/windows/04-settings.png)・[下部](assets/windows-mac-gaps/windows/08-settings-lower.png) |

- 構成：Macは幅300の項目一覧、区切り線、選んだページの順に並ぶ。項目は、プロフィール行（36のアバター、名前、「プロフィールとあなたの決まり」）の下に、［AIの設定・追加機能・通知］［接続・表示］［利用と課金・アップデート・このアプリについて］［全体停止（赤）］の4群。各行に30の色付きアイコン、題名と説明、右側の状態（通知「未設定」、課金、停止「動作中」「停止中」「確認できません」）。各ページの頭に56のアイコンと題名と説明を置く。Windowsは縦1列のカードで、プロフィールは別の編集画面になっている。
- プロフィール：その場で編集する（写真、名前、プロフィール、リンク（X・GitHub・任意の名前とURL、「リンクを追加」）、あなたの決まり）。保存は右上。
- AIの設定：「AIの認証」（行ごとに状態と紫の操作カプセル、行を押すと詳細ページ）と「仕事の要約を書くAI」（`/api/settings/backgroundAgent`。Windowsに無い）。
- 追加機能：一覧の行の右に状態（「有効」「無効」「未設定」「反映エラー」）。
- 通知：OSの違い。Macは端末の通知登録だが、Windowsでは閉じている間の通知を取りやめた（オーナー判断、2026-11-08）。同じページの位置に、Windowsの起動中の通知の切替を置く。文言の対応はページ作成時に決める。
- 接続：「いまの接続」（サーバー、ログイン方法）、「別のサーバーにつなぎ直す」と注意文、「ログアウト」（Cloudflareの時だけ）。
- 表示（Windowsに無い）：「会話の開き方」（「下から順に浮き上がる」「フェードインだけ」）。
- 利用と課金：Appleの購読だけで、Windowsに対応する購入は無い。扱いの裁定が要る（10節）。
- アップデート：9節と同じ内容をこのページに置く。
- このアプリについて（Windowsに無い）：「アプリの版」「接続先」。
- 全体停止（Windowsに無い）：赤いスイッチ「全員のAIを止める」と状態文4種、確かめられなかった人数、「状態を更新」、注意文。確認の画面は出さない。API `/api/ai-control`。

## 9. アップデート — M

| Mac | Windows |
| --- | --- |
| [混在](assets/windows-mac-gaps/mac/update-mixed-820-light.png)・[最新](assets/windows-mac-gaps/mac/update-current-820-light.png)・[設定内](assets/windows-mac-gaps/mac/mac-update-after.png) | [設定のページ（混在）](assets/windows-update-page/update.png)・[すべて最新](assets/windows-update-page/update-current.png)・[Updateシート](assets/windows-update-page/update-sheet.png) |

対応済み（PR 3）：設定の「アップデート」ページと、一覧の見出しのバッジから開くメイン窓内のUpdateシートが、同じ部品でMacの9状態・帯・選択・確認カード・機能の一覧・更新内容・ジョブの状態・機能の問題・閉じた詳細を出す。パンくずと「いつものチームを、より快適に。」は無い。実画面：`assets/windows-update-page/update.png`（混在）、`update-current.png`（すべて最新）、`update-sheet.png`（シート）、`update-narrow.png`（最小幅）、`update-detail-narrow.png`（詳細を開いた最小幅）。Windowsの更新状態は`UpdateScreen`が、同じinventoryと操作の値からMacの規則で決める。Macの「まとめて更新」は元からMacに無く、Windowsの旧画面にあった全体計画の入口は置かない（APIは変えていない）。暗い外観はWindowsに無いため、暗色の画像との照合は色の確認だけに留めた。

- 表示する場所：設定のページと、一覧の見出しのバッジから開く大きいシートの2か所（どちらも対応済み）。
- 上段のカード：52の丸いアイコン、題名、説明、主ボタン。状態は9種（「確認しています」「更新しています」「更新しました」「Xを更新できます」「すべて最新です」など）。
- 「確認が必要な機能があります」の赤い帯、「どれを更新しますか」、確認カード（「更新の前に」「会話と処理が一時止まることを確認しました」のスイッチ）。
- 「機能」の一覧：34のアイコン、名前、版の説明、状態バッジ（「最新」「更新あり」「更新中」「失敗」「確認できません」）。
- 「更新内容」（きらめきアイコンの箇条書き）と、開閉できる「詳細」（等幅の技術情報）。

## 10. 起動・接続・ログイン・初期設定 — M

| Mac | Windows |
| --- | --- |
| （全写真で追加） | [初期設定](assets/windows-mac-gaps/windows/05-setup.png)・[AI認証](assets/windows-mac-gaps/windows/06-authentication.png) |

- 起動中は「BellTeamを開いています」、失敗時は「接続できませんでした」と「もう一度試す」。
- 接続先の入力（ServerSetupView）：106の肖像画、「BellTeamを始める」、「はじめて使う」カード（導入ガイドのシート）、「BellTeamの接続先URL」「続ける」。Windowsは小さい接続先ダイアログ。
- ログイン（LoginView）：182の肖像画、「BellTeam」（48pt）、「いつでも、あなたのチームと。」、「ログインして始める」。
- 初期設定（OnboardingView）：AIのカード選択、認証の案内、「認証を確認して始める」「使うAIを変更」「接続先を変更」。Windowsは同じ機能を別の画面構成で持つ。

## 11. 共通部品とキー操作 — S

- 画像の閲覧：Windowsにほぼある。「n / N」、64の縮小画像の帯、Esc・←・→を確かめる。
- 文字の大きさ：本文18、入力18、一覧の名前16・補助14、ボタン16、プロフィールの題20、区分の見出し13 semibold。カードの角丸24。
- シートの大きさ：最小720×540、標準820×680。WPFでは主窓の上に重ねるモーダル（暗くした背景）で再現する。
- キー：Ctrl+K、Ctrl+2、Ctrl+3（新規）、Ctrl+,、Ctrl+Shift+I、Enter（送信）とShift+Enter（改行）。

## サーバーと裁定

- サーバーの変更は不要。PR #634のMacが使うAPI（`/api/goals`、`/api/bots/{id}/goal`、`/api/ai-control`、`/api/bots/{id}/screen/key|approval`、`/api/bots/{id}/avatar-large`、`/api/settings/backgroundAgent`、書き出し、`currentWork`）は、どれも現行の`src/`にある。
- 裁定が要るのは1件：「利用と課金」ページ。Appleの購読はWindowsで購入できない。案は、(a) ページを置かない、(b) 同じ位置に「Web版とWindows版は無料。AIはご自身の契約で利用します」と、規約・プライバシー方針・サポートへのリンクだけを置く。
- 通知ページは、オーナー判断で起動中の通知だけを扱う（8節）。

## 進め方と見積もり

図を先に更新し（[Windowsの機能図](windows-architecture.md)をMacの画面構成へ合わせる）、その後は画面ごとにPRを出す。各PRに、Macと Windowsの写真を並べて付ける。

| 順 | PR | 規模 |
| --- | --- | --- |
| 0 | 機能図をMacの構成へ更新 | S |
| 1 | 外枠・サイドバー（行の2行要約、在席の点滅、＋▾、Updateバッジ、ゴールの入口） | M |
| 2 | 設定の作り直し（2列、全10ページ。全体停止・表示・このアプリ・仕事の要約AIを追加） | L |
| 3 | アップデート（設定のページとシート） | M |
| 4 | 会話（帯、状態の文言、Bot間の連絡シート、画像の重ね表示、止める、入力欄） | L |
| 5 | 詳細パネル（大画像と小画像、画像の操作シート、AIと操作） | L |
| 6 | Botの画面とキーバー・許可の帯 | M |
| 7 | ゴール（ページ・カード・カプセル・編集シート） | L |
| 8 | メンバー・ルームの編集シート、削除、切り抜き | M |
| 9 | 予定の見た目と文言 | S |
| 10 | 起動・接続・ログイン・初期設定 | M |
| 11 | 共通部品の仕上げとダーク表示 | S |

合計でおよそ14〜16日分（S＝0.5、M＝1、L＝2で数えた実作業）。各PRの採用と導入を待つ時間は含まない。Macの全写真が届いたら、ダーク表示の差と、写真の無い画面（起動・ログイン・初期設定・シート類）を照らし合わせて、規模を見直す。
