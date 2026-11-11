# Windows版のMac完全再現：画面ごとの差分一覧

担当：アニス（2026-11-11、オーナー指示「Windowsはアニス」。前任はオーナーのWindowsのClaude Code）。参照するMacは常に現行mainの`ios/`で、Mac側の担当はラピ。11-08以後にMacへ入った差分は末尾の「Macの追従（2026-11-11）」に置く。

工程W-MAC。オーナー指示（2026-11-08）：WindowsアプリでMacアプリを完全に再現する。画面・配置・部品・状態の印・操作の流れ・文言をMacと揃え、既存のWPFアプリ（`windows/`）でネイティブに作る。WebViewで包む方式は採らない。OSの違いだけをWindowsの作法に置き換える（⌘→Ctrl、窓の操作ボタン、タイトルバー）。

参照元はmain `f62a4286`（PR #634を取り込んだ版）の`ios/`と、Apple担当ベルの確認用写真（FOX `C:\Users\kite_\Developer\mac-reference-20261108\`、83枚）。比較に使う写真は`assets/windows-mac-gaps/`へ写した。Windows側は現行main（`6d48bf3b`）を、Macと同じ`PreviewFixtures`の人工データで、窓を出さずに描いた（`windows/BellTeam.Tests/fixtures/mac-ui-reference.mjs`）。Macの全画面・ライトとダークの写真がそろったら、この一覧を照らし合わせて直す。

規模の目安：S＝半日、M＝1日、L＝2日（実作業。写真の並べ比べを含む）。

## 1. 外枠とサイドバー — M

対応済み（PR 1）：[Windowsのサイドバー](assets/windows-mac-gaps/windows/pr1-sidebar.png)・[全体](assets/windows-mac-gaps/windows/pr1-workspace.png)。「ゴール」の入口（的のアイコン付き、予定と設定の間）とCtrl+3はPR 7で足した。下部の3つは等幅の3マス（左・中・右）に置き、将来4つ目を足す時は1マス増やすだけで収まる。接続先の変更は設定へ移し、手動の再接続は下部の接続状態の帯へ置いた（Windowsは自動で再接続しないため）。

| Mac | Windows |
| --- | --- |
| [設定表示時の外枠](assets/windows-mac-gaps/mac/mac-profile-after.png)・[一覧の行](assets/windows-mac-gaps/mac/summary-mac-340-natural-after.png) | [現行](assets/windows-mac-gaps/windows/01-workspace.png) |

- サイドバーの幅：Macは最小320・標準340・最大420。Windowsは340固定。
- 見出しの右側：Macは「＋▾」メニュー（「メンバーを追加」「ルームを作成」）。更新がある時だけ紫の↓丸アイコン（UpdateBadge）が出て、押すとUpdateシートが開く。Windowsは「Update · 状態」の文字ボタンが常に出ていて、「＋」から追加メニューを開く。
- 一覧の行：Macはアバター57.6、名前16pt semibold、名前の直後に「⚡ ファスト」。メンバーの2行目は「今の仕事」の要約（`currentWork`：要約／「作業中・要約未設定」／「作業中・要約期限切れ」／「待機中」／「仕事状況を未取得」）を最大2行、11ptで出す。Windowsはアバター48で、最後のメッセージを1行、ファストの印は右寄せ。
- 在席の点：Macは仕事中なら赤く点滅（0.8秒）、待機中はミント、オフラインは灰色。Windowsは点滅しない。
- 下部：Macは「予定」「ゴール」「設定」の3つ（Ctrl+2・Ctrl+3・Ctrl+,）。Windowsは、PR 7で「ゴール」を足した。
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

対応済み（PR 4）：[メンバー](assets/windows-mac-gaps/windows/pr4-conversation-member.png)・[ルーム](assets/windows-mac-gaps/windows/pr4-conversation-room.png)・[配送状態と問い・秘密入力](assets/windows-mac-gaps/windows/pr4-conversation-states.png)・[ルームの処理中と止める](assets/windows-mac-gaps/windows/pr4-conversation-stop-room.png)・[停止結果](assets/windows-mac-gaps/windows/pr4-conversation-stop-notice.png)・[メンバーの停止ボタン](assets/windows-mac-gaps/windows/pr4-conversation-stop-member.png)・[添付](assets/windows-mac-gaps/windows/pr4-conversation-draft.png)・[メンバー間の連絡のシート](assets/windows-mac-gaps/windows/pr4-conversation-peer-sheet.png)・[画像の束](assets/windows-mac-gaps/windows/pr4-conversation-stack.png)・[空](assets/windows-mac-gaps/windows/pr4-conversation-empty.png)・[読込失敗](assets/windows-mac-gaps/windows/pr4-conversation-failed.png)。入力欄のゴールのカプセルはゴールのPR（7）で足す。「受付確認中」「受付済み・反映待ち」はMacが送信中に自分で置く仮の行の状態で、Windowsは仮の行を置かないため、サーバーがその値を返した時だけ出る。ルームの宛先別の配送は、これまで常に空だった表示がMacと同じ最悪の状態（例：失敗が1つでもあれば「配達失敗」）になった。

## 3. 詳細パネル（メンバー・ルーム） — L

Mac：[48の詳細パネル](assets/mac-ui-reference-48/01-workspace.png)／Windows：[現行](assets/windows-mac-gaps/windows/01-workspace.png)

- 上部（BotProfileHero）：正方形の大画像の左上に、白枠付きの小画像（Macでは152pt）を重ねる。どちらも押すと「小画像の操作」「大画像の操作」シートが開く（「画像変更」「画像調整」、保留中の選択の確認・破棄、各状態の文言）。Windowsには大画像が無い。
- 「AIと操作」カード：「ハーネス」「希望モデル」「希望エフォート」（空なら「CLIの既定」）、「Botの画面を見る」「会話セッションを再起動」。Windowsは同じ機能を持つが、並びと見出しが違う。
- 「プロフィール」の5項目と「メンバーを編集」（目立つボタン）。押すと別窓（1120×900）が開く。
- ルーム：アバター76、「この部屋で共有する仕事」「参加メンバー」（30ptの行、押すとそのメンバーの会話へ）、「ルームを編集」。
- 幅：メンバーなら会話と半分ずつ、ルームなら280。Windowsは同じ。

対応済み（PR 5）：[大画像のあるメンバー](assets/windows-mac-gaps/windows/pr5-inspector-member-large.png)・[小画像だけのメンバー](assets/windows-mac-gaps/windows/pr5-inspector-member-small-only.png)・[画像の無いメンバー](assets/windows-mac-gaps/windows/pr5-inspector-member-no-image.png)・[ルーム](assets/windows-mac-gaps/windows/pr5-inspector-room.png)・[小画像のシート](assets/windows-mac-gaps/windows/pr5-inspector-sheet-small.png)・[大画像のシート](assets/windows-mac-gaps/windows/pr5-inspector-sheet-large.png)・[サーバーが独立編集に未対応](assets/windows-mac-gaps/windows/pr5-inspector-sheet-unsupported.png)・[保持中の選択（詳細欄）](assets/windows-mac-gaps/windows/pr5-inspector-pending.png)・[保持中の選択（シート）](assets/windows-mac-gaps/windows/pr5-inspector-pending-sheet.png)・[既定の画面](assets/windows-mac-gaps/windows/pr5-workspace.png)。Macの切り抜きは同じシートの中で行うが、Windowsは既存の切り抜き窓（PR 8で整える）を開く。「使用する」でシートを閉じ、保存の進行と結果は詳細欄に出る。「会話セッションを再起動」の失敗はカード内に出す（Macと同じ）。参加メンバーの行はMacと同じく「名前 役職」（表示名）。

## 4. Botの画面とキーバー — M

| Mac | Windows |
| --- | --- |
| [キー](assets/windows-mac-gaps/mac/screenkeys-keys-820-light.png)・[許可](assets/windows-mac-gaps/mac/screenkeys-approval-820-light.png)・[数字と失敗](assets/windows-mac-gaps/mac/screenkeys-digits-error-820-light.png) | [キー](assets/windows-mac-gaps/windows/pr6-screen-keys.png)・[許可](assets/windows-mac-gaps/windows/pr6-screen-approval.png)・[数字と失敗](assets/windows-mac-gaps/windows/pr6-screen-digits-error.png) |

- 見出しは「プロフィールに戻る」と「<名前>の画面」。黒地に白の12pt等幅で、1秒ごとに更新。状態行は「1秒ごとに更新」または「停止中」。
- キーバー：1段目は「取消」「Tab」「決定」（紫）「中断」（赤）、2段目は「左」「上」「下」「右」「数字」（0〜9の段を開く）。送信中は回転、成功後1.2秒チェック。API `POST /api/bots/{id}/screen/key`。
- 許可の帯（琥珀色）「許可を求められています」。選択肢ごとのボタン（`approve_once`は緑）。`GET/POST /api/bots/{id}/screen/approval`。
- 注意文：「画面が変わりました。もう一度確認してください」など5種。

対応済み（PR 6）：[キーバー](assets/windows-mac-gaps/windows/pr6-screen-keys.png)・[許可の帯](assets/windows-mac-gaps/windows/pr6-screen-approval.png)・[数字の段と注意文](assets/windows-mac-gaps/windows/pr6-screen-digits-error.png)・[送信後のチェック](assets/windows-mac-gaps/windows/pr6-screen-sent.png)・[空の画面（起動中）](assets/windows-mac-gaps/windows/pr6-screen-empty.png)・[席が停止中](assets/windows-mac-gaps/windows/pr6-screen-offline.png)・[読み取りの失敗](assets/windows-mac-gaps/windows/pr6-screen-read-failed.png)・[既定の画面](assets/windows-mac-gaps/windows/pr6-workspace.png)。更新は表示中だけ1秒ごと。Macと同じく読み取りが失敗すると止まり、状態行に赤い文を出す（「再読込」ボタンはMacに無いため外した。画面を開き直すと再開する）。許可の確認は画面の読み取りが成功するたびに毎回行い、失敗しても続け、503の間はキーバーごと隠して後の200で戻す。想定外の失敗の報告は連続1回だけ。Macの触覚フィードバックと診断の送り先はWindowsに無く、診断は`Trace`へ書く。

## 5. メンバー追加・編集、ルーム、画像の切り抜き — M（対応済み：PR 8）

対応済み（PR 8）：Macの文言と構成どおりにWindows（WPF）で作った。画面：[メンバーを追加（シート）](assets/windows-mac-gaps/windows/pr8-new-member.png)（Macは`39-preview-sheet-new-member-light.png`）・[メンバーを編集（別窓）](assets/windows-mac-gaps/windows/pr8-member-window.png)（Macは`20-member-edit-window-light.png`）・[ルームを編集（シート）](assets/windows-mac-gaps/windows/pr8-room.png)（Macは`21-room-edit-sheet-light.png`）・[ルームを作る](assets/windows-mac-gaps/windows/pr8-new-room.png)・[画像を調整（シート）](assets/windows-mac-gaps/windows/pr8-crop.png)（Macは`38-preview-avatar-crop-light.png`）・[メンバー削除の確認](assets/windows-mac-gaps/windows/pr8-member-delete-alert.png)・[削除を受け付けた状態](assets/windows-mac-gaps/windows/pr8-member-delete-pending.png)・[削除要求の結果が不明な状態](assets/windows-mac-gaps/windows/pr8-member-delete-unconfirmed.png)・[ルーム削除の確認](assets/windows-mac-gaps/windows/pr8-room-delete-alert.png)。

- 「メンバーを追加」は窓内のシート（最小720×540、最大820×680）、「メンバーを編集」は別窓（1120×900、最小600×500）。Macと同じ1列の区分け（メンバー／画像（追加時のみ）／AI／プロフィール／削除（編集時のみ））で、上部に「キャンセル」「保存」を置く。保存や削除を受け付けた後は左が「閉じる」になる。
- 画像（追加時のみ）：「小画像を変更」（80のアバター）、「小画像を再調整」、「大画像を変更」（160のプレビュー）、「大画像を再調整」、「大画像を小画像と同じに戻す」と各注意文。サーバーが独立した大画像を持たない時は「画像の独立編集はサーバー更新後に利用できます。」を出して無効にする。選んだ画像だけを`POST /api/bots`の`avatar`・`avatarSource`・`avatarCrop`（大画像は`avatarLarge…`）に付ける。
- AI：CLI（Codex・Claude・Grok・Cursor・Antigravity）、モデル（CLIの既定・候補・その他と「モデルID」）、エフォート（CLIの既定・候補・「X（現在の設定）」）、「ファストモード」と「オンにすると利用枠を多く使います。」、使えない理由の赤文（読み込み中・候補を読めない・モデルID未入力・候補の失敗・アカウント制限・既定モデルを確認できない・非対応モデル）。読み込み中は「モデル候補を読み込んでいます…」。
- 保存結果の4文言（保存した内容を確認／一致しない／確認できない＋「保存結果を確認」）。保存は変更した欄だけのPATCHを1回、結果が不明な時は読み比べだけを行い、再送しない。
- 削除（メンバー）：「メンバーを削除」→確認文→`DELETE /api/bots/{id}`を1回→「削除を受け付けました。…」と「削除結果を確認」（一覧のGET）。応答が不明な時は「削除要求の結果を確認できませんでした。…」と同じ「削除結果を確認」。一覧から消えたら編集窓を閉じる。
- ルーム：「ルームを作る」「ルームを編集」、写真・ルーム名・この部屋で共有する仕事、メンバーのチェック、「代表Bot」（「代表なし」と選んだメンバーだけ）、「ルームを削除」と確認文・「操作を完了できませんでした」の確認。
- 画像の切り抜き：窓内の「画像を調整」シート（680×520）。指示文、320のプレビューと240幅の「拡大・縮小」、「キャンセル」「使用する」。メンバー・ルーム・オーナーの写真と詳細の画像操作が同じシートを使う。
- 作らなかったもの：Macは未保存の編集内容を窓を閉じるまで保持する（`botEditorDrafts`）が、Windowsは保持しない。Macのルーム保存は全欄を送るが、Windowsは変えた欄だけを送る。編集窓の左上の題と閉じるボタンはWindowsの窓枠を使う。
- 変えたもの（Mac準拠）：メンバー・ルームの編集から「写真を取り外す」を外した（Macに無い。オーナーの設定画面には残す）。ファスト不可の理由文とファスト欄の注意文をMacの文言にした。

## 6. ゴール — L（対応済み：PR 7）

対応済み（PR 7）：Macの文言どおりにWindows（WPF）で作った。画面：[空の一覧](assets/windows-mac-gaps/windows/pr7-goals-empty.png)（Macは`04-goals-list-light.png`）・[状態ごとのカード（Claude進行中＋前のゴール／Codex予算に到達／Grok一時停止）](assets/windows-mac-gaps/windows/pr7-goals-cards.png)・[Codexの進行中／一時停止／利用制限](assets/windows-mac-gaps/windows/pr7-goals-cards-codex.png)・[会話のカプセル（ゴール未設定）](assets/windows-mac-gaps/windows/pr7-goals-pill.png)・[開いたカプセル（未設定）](assets/windows-mac-gaps/windows/pr7-goals-pill-open-unset.png)・[開いたカプセル（進行中）](assets/windows-mac-gaps/windows/pr7-goals-pill-open-active.png)・[編集シート（予算の入力エラー）](assets/windows-mac-gaps/windows/pr7-goals-editor-create-error.png)・[編集シート（項目の切り替え）](assets/windows-mac-gaps/windows/pr7-goals-editor-edit-separate.png)。

- ページ（Ctrl+3）：見出し「ゴール」と「設定済みのゴールと、現在取得できた状態。」、「ゴールを更新」「ゴールを設定」（候補が複数ならメンバー選択のメニュー付き）、読込失敗・現在のゴールを確認できない・空の状態。
- カード：状態（「進行中」「一時停止」「進行できない状態」「利用制限」「予算に到達」「完了」）、目的、使用量、「前のゴール」「取得 <日時>」、操作「設定」「編集」「一時停止」「再開」「取り消す」（確認ダイアログは出さない）。操作の有無は状態と権限で決まる。出せない操作は「今のゴールでは…を操作できません。」と書く。
- 会話のカプセル（メンバーの会話だけ。ルームには出さない）：状態と経過時間。押すと開いてカードと「状態を更新」。
- 編集シート「<名前>のゴール」：「目的」（「n / 4000文字」）、「トークン予算（任意）」（「指定しない」）、CLIが一項目ずつしか受けない時の「変更する項目」、注意文。「保存」はシートの右上。
- API：`GET /api/goals`、`GET /api/bots/{id}/goal`、変更は`POST /api/bots/{id}/goal`の1本だけ（サーバーにPUT・DELETEは無い）。
- 読み直す時：開いた時・「更新」・窓が前面に戻った時・サーバーの通知（Macの`eventRevision`と同じ種類）。周期の読み取りは無い。変更は1回の押下で1回だけ送り、自動では再送しない。応答が不明な時は不明と表示して状態を読み直す。
- Windowsだけの差：Macの診断への記録は無い。日時は日本語の「2026年11月8日 12:00」形式で出す。

## 7. 予定 — S

| Mac | Windows |
| --- | --- |
| [48の予定](assets/mac-ui-reference-48/03-schedules.png) | [現行](assets/windows-mac-gaps/windows/03-schedules.png) |

- 右上は紫の丸い「＋」だけ。Windowsは「再読込」と「予定を追加」の2つ。
- カードの右上に種類のアイコン（一回なら予定表、繰り返しなら矢印）。日時は「次回 10月14日(水) 9:00」（時計アイコン付き）。Windowsは「10/14 (水) 09:00」。削除はごみ箱アイコン、ボタンは薄い面付き。
- 空の状態「予定はありません」「右上の＋から追加できます。」。編集シートの繰り返し名「毎週」（Windowsは「曜日」）。
対応済み（PR 9）：Macの文言と構成どおりにWindows（WPF）で作った。画面：[一覧](assets/windows-mac-gaps/windows/pr9-schedules-list.png)（Macは`03-schedules-list-light.png`）・[既定の模擬](assets/windows-mac-gaps/windows/pr9-schedules.png)・[空](assets/windows-mac-gaps/windows/pr9-schedules-empty.png)・[読込失敗](assets/windows-mac-gaps/windows/pr9-schedules-failed.png)・[削除の確認](assets/windows-mac-gaps/windows/pr9-schedules-delete.png)・[追加（メンバー）](assets/windows-mac-gaps/windows/pr9-schedules-editor-member.png)・[追加（ルーム、返信するメンバー）](assets/windows-mac-gaps/windows/pr9-schedules-editor-room.png)・[毎週の入力エラー](assets/windows-mac-gaps/windows/pr9-schedules-editor-weekly-error.png)・[数時間おき](assets/windows-mac-gaps/windows/pr9-schedules-editor-interval.png)。
- 右上は紫の丸い「＋」だけ（再読込と文字の追加ボタンは無くした。開いた時とサーバーの通知で読み直す）。34ptの見出し「予定」と説明、カード（種類のアイコン・時計つきの「次回 10月14日(水) 9:00」・薄い面の「今すぐ実行」「編集」・ごみ箱）、削除の確認、空と読込失敗の表示はMacのとおり。
- 編集は主窓の中のシート。担当・実行内容・タイミングの3区画、繰り返しの名前は「毎週」、各繰り返しの入力欄とMacの入力エラー（「実行内容を入力してください。」「曜日を選んでください。」）もMacのとおり。
- サーバーとの通信は変えていない（更新はPUTで全内容、新規はPOST、削除はDELETE、今すぐ実行はPOST。cron式とタイムゾーンは保持）。保存・実行・削除は1回の操作で1回だけ送り、結果が不明な時は表示して一覧を読み直す。
- Windowsだけの差：編集を開いた時、cron式は毎時・毎日・毎週にそのまま当てはまる時だけ該当の繰り返しで開く（Macは範囲「1-5」も毎週として開き曜日が空になる）。既存の予定の返信するメンバーは編集を開いても消さない。日付の入力欄はWindowsの日付選択と、時・分の2つのリスト。

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

対応済み（PR 10）：Mac版のRootViewと同じ段階を主窓の中へ置いた。[起動中](assets/windows-mac-gaps/windows/pr10-opening.png)・[接続できませんでした](assets/windows-mac-gaps/windows/pr10-failure.png)・[接続先の入力](assets/windows-mac-gaps/windows/pr10-server-setup.png)（Macは`36-preview-login-server-setup-light.png`）・[導入ガイドのシート](assets/windows-mac-gaps/windows/pr10-guide.png)・[ログイン](assets/windows-mac-gaps/windows/pr10-login.png)・[初期設定：AIの選択](assets/windows-mac-gaps/windows/pr10-onboarding-choose.png)・[初期設定：認証待ち](assets/windows-mac-gaps/windows/pr10-onboarding-waiting.png)・[接続状態の帯](assets/windows-mac-gaps/windows/pr10-banner.png)（Macは`37-preview-error-connection-banner-light.png`、同じく下部の帯）。
Macと違う点：(1) 帯に「再接続」「接続先」のボタンが付く（自動再接続はMac・Webと同じ段階で動くので、ボタンは止まった時と今すぐ試す時の入口）。(2) 接続先を変える時、入力欄に今の接続先が入っている（Macは空）。保存済みの接続先は、新しい接続先を入れるまで消さない。(3) 導入ガイドのMac共有ボタンは、Windowsに共有シートがないため「GitHubをブラウザーで開く」と「この手順のURLをコピー」にした。(4) 失敗の画面に「接続先を変更」を足した。(5) 初期設定の読み取り（3秒ごと）は、失敗しても止めず、失敗を表示して次の成功で消す。(6) 「BellTeam」の文字間（tracking −2.5）は再現していない（WPFにない）。(7) 窓の題名・左上の信号ボタンはOSの標準。

- 起動中は「BellTeamを開いています」、失敗時は「接続できませんでした」と「もう一度試す」。
- 再接続（トロニー裁定 11-08）：失敗の画面と新着のSSEは、Mac・Webと同じ段階（すぐ→1→2→4→8→15秒、各±20%、以後15秒）で自動に再接続する。「自動再試行は入れない」は取り下げ、常駐・タスクトレイ・自動起動は入れないまま。「もう一度試す」と帯の「再接続」はすぐ試す入口として残す。
- 接続先の入力（ServerSetupView）：106の肖像画、「BellTeamを始める」、「はじめて使う」カード（導入ガイドのシート）、「BellTeamの接続先URL」「続ける」。
- ログイン（LoginView）：182の肖像画、「BellTeam」（48pt）、「いつでも、あなたのチームと。」、「ログインして始める」。
- 初期設定（OnboardingView）：AIのカード選択、認証の案内、「認証を確認して始める」「使うAIを変更」「接続先を変更」。Windowsは同じ機能を別の画面構成で持つ。

## 11. 共通部品とキー操作 — S（対応済み：PR 11a。ダーク表示は対象外）

ダーク表示：対象外（トロニー裁定 2026-11-08）。Mac版（とiPhone版）はライト固定で、`ios/BellBot/project.yml`の`UIUserInterfaceStyle: Light`と`ios/BellBot/BellBot/Info.plist`の同じ項目が、最初の履歴（`f0529291`、2026-10-04）から入っている。Mac 113の「-dark」写真（30〜49）はライトとほぼ同じで、Windowsもシステムの外観にかかわらずライト固定とする。Windowsの外観に追従するダーク表示の実装は、全プラットフォームでダーク表示を決める日のために、ブランチ`claude/windows-mac-dark`（`ec59751a`）へマージせず残す。

PR 4の確認でトロニーが仕上げへ回した項目（例外にせず再現する）：「安全な入力欄を開く」をMacと同じ灰色のボタンにする。送信直後に、Macと同じ「受付確認中」の仮の吹き出しを出す。画像の閲覧を別の窓ではなく、主窓の中で開く。
PR 5の確認で追加：Macの実物（113の01・02・07）は、会話の上にアバターと名前の帯を持たず、窓の題名が「BellTeam」で、詳細パネルの切替と書き出しを窓の右上に紫の丸いボタン2つで置く。#634のソースと実物を照らし、実物に合わせる。

対応済み（PR 11a）：上の仕上げ項目5件。Macの実物と並べた写真は`docs/assets/windows-mac-gaps/windows/pr11a-*.png`。
- 「安全な入力欄を開く」：Macの灰色の枠付きボタン（問いの選択肢と同じ灰色）にした（`pr11a-secret.png`、Mac 33と比較）。
- 受付確認中：送信直後に仮の吹き出しを出し、「受付確認中」→受付済み（「受付済み・反映待ち」）→履歴の行へ置き換える。照合はMacと同じく応答のIDだけ（メンバーは`deliveryId`、ルームは`id`）。失敗・結果不明は仮の吹き出しを消して本文を戻す。自動の再送はしない（`pr11a-echo.png`）。
- 画像の閲覧：主窓いっぱいの黒い覆いにした。「×」、「n / N」、前の画像・次の画像（←→）、64のサムネイルの帯、Esc（`pr11a-gallery.png`）。
- 会話の見出しと右上のボタン：アバターと名前の帯をやめ、詳細パネルの切替と書き出しを窓の右上の紫の丸いボタン2つにした。実物（01・02・07）では左が詳細パネル、右が書き出し（`pr11a-member.png`・`pr11a-room.png`、Mac 07・02と比較）。
- シートの見出しのボタン：キャンセル・閉じる・保存・使用するをMacの枠線付きカプセルにした（`pr11a-sheet.png`、Mac 39と比較）。
- 画像の閲覧：「n / N」、64の縮小画像の帯、Esc・←・→は上の主窓内の閲覧で確かめた。
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
| 11 | 共通部品の仕上げ（11a）。ダーク表示は対象外（11節） | S |
| 12 | Claudeの2アカウント（オーナー機能、担当キロ。契約は`docs/architecture/modules/execution/harness-accounts.md`）：AIの認証の1st・2nd、両方上限の帯、メンバーの席のアカウント表示。Apple版に合わせる。状態：対応済み（Apple版の到着後に照合）。写真：[2行・通常](assets/windows-mac-gaps/windows/pr12-accounts-normal.png)・[片方が上限](assets/windows-mac-gaps/windows/pr12-accounts-one-limited.png)・[両方上限の帯](assets/windows-mac-gaps/windows/pr12-accounts-both-limited.png)・[2ndが未ログイン](assets/windows-mac-gaps/windows/pr12-accounts-unlogged.png)・[旧本体の1行](assets/windows-mac-gaps/windows/pr12-accounts-old-server.png)・[メンバーの席のアカウント](assets/windows-mac-gaps/windows/pr12-accounts-member-card.png) | M |

合計でおよそ14〜16日分（S＝0.5、M＝1、L＝2で数えた実作業）。各PRの採用と導入を待つ時間は含まない。Macの全写真が届いたら、ダーク表示の差と、写真の無い画面（起動・ログイン・初期設定・シート類）を照らし合わせて、規模を見直す。

## 完了（2026-11-08）

W-MACは、0〜10、11a、再接続の裁定、12がすべてmainに採用された（#635・#636・#637・#638・#639・#640・#643・#647・#653・#660・#672・#677・#683・#685・#687）。ダーク表示は対象外。残る追加作業は、Apple版のClaudeの2アカウントが入った時の照合だけ。

Claudeの2アカウントの改訂（2026-11-09、オーナー裁定・契約PR #711）：上限だけで席のアカウントが決まるため、Windowsから「Fableを2ndアカウントで使う」の切替と`/api/accounts/rules`・`account.preferredSlot`の利用を外した。各アカウントの名前・ログイン状態・モデルごとの上限（日本時間の解除時刻）・席の数は残す。

## Macの追従（2026-11-11、参照main `165a4d1e`）

11-08の参照（`f62a4286`）から`165a4d1e`までに、Macの`ios/`へ入った利用者に見える差分。Windowsのmain（`b0789bc6`までのWindows変更）はどれも持っていない。11-08以前の行（1〜12）はすべてmainに入っており、起動（PR 10、#672）と仕上げ（PR 11a、#677・#683）も含めて残りは無い。Macの比較写真は、新しい画面のぶんをラピが撮った（ブランチ`rapi/mac-reference-shots`の`docs/assets/windows-mac-gaps/mac/`、名前は`<組>--<画面>.png`。第1便`21494469`は11-10の実機ビルドで、11-10の言い方のまま）。各PRでは使う写真だけを自分のブランチへ写して並べる。写真の無い状態は仕様とMacのソースで作り、届いたら並べて直す。

### 13. 相関図 — L＋L（Windowsに無い）

契約と動きの仕様は[work-graph](architecture/modules/work-graph/README.md)・[behavior-spec](architecture/modules/work-graph/behavior-spec.md)（担当ブラック）、参照実装は`layout-sim.mjs`、Macの部品は[apple/work-graph](architecture/modules/apple/work-graph.md)。数値は仕様から写し、ここへ複製しない。

- 入口：サイドバー下部に「相関図」（Ctrl+4）。Macは「予定」「ゴール」「相関図」「設定」の4つ。Macと同じく別の窓（最小480×360、題名「相関図」）で開き、2回目は既存の窓を前へ出す。
- 通信：窓が見えている間だけ`GET /api/work-graph/events`（SSE）。最初の`snapshot`で置き換え、`change`はepochが同じで版が1つ進んだ時だけ適用し、それ以外は取り直す。旧本体（404）は60秒ごとに確かめ直し、読めない応答も再接続を続ける。
- 描画：力学のシミュレーション、入退場、点滅、流れの点。名前に3ptの縁取り。関係ないメンバーを線と札から押し出す（clearance）。30コマごとの交差を減らす入れ替え（700msの移動。Windowsの「アニメーション効果」がオフなら100msで消えて100msで出る）。
- 札：最大幅180pt・行の高さ16ptで折り返し、切らない、重ねない（85の置き場所）。`label`がnullなら札を出さず、読み上げは「<from>から<to>へ依頼」。描画範囲に収まらない札は箱の中でホイールで送る。
- 分身の線：破線（6/4）と「分身：」の前置き。未知のキーは無視する。
- 操作：メンバーをクリックすると本体の窓を前へ出してその会話を開く（相関図の窓は残す）。線にポインタを乗せると待っている札を見せる。押下は10pt未満・500ms未満だけをクリックとする。
- 分け方：13a＝モデル（図の状態・シミュレーション・札の置き場所・入れ替え・clearance。仕様の数値と`layout-sim.mjs`に対する試験）、13b＝窓・描画・操作・読み上げ・サイドバーの入口。
- 13a 対応済み：`windows/BellTeam.Core/WorkGraphModel.cs`・`WorkGraphSimulation.cs`と、SSEの名前付きイベントを読む`BellApi.WorkGraphEventsAsync`。MacのWorkGraphModelTestsのうちモデルの試験を移した（`WorkGraphModelTests.cs`）。画面が要る2つ（文字の実測の`testLongLabelWrapsAtSixteenPointLines`・`testChipTextColumnIsTheSameWhenMeasuredAndDrawn`）は13bの`WorkGraphViewTests.cs`で試す。Macとの違い：(1) 文字の大きさは画面から測り方を受け取る（Coreは描画の部品に頼らない）。(2) 札の最大幅（180ptと描画範囲−8ptの小さい方）はCoreが持つ。(3) 名前の文字は16pt（Macの一覧の名前と同じ）、メンバーの大きさの基準は画面が64を渡す（Macの画面と同じ）。
- 13b 対応済み：窓・描画・操作・読み上げ・サイドバーの入口（`WorkGraphWindow.cs`・`WorkGraphView.cs`・`WorkGraphText.cs`、`MainWindow`の「相関図」とCtrl+4）。入口は予定・ゴール・相関図・設定の4つで、Macと同じく2つ目を開くと既存の窓を前へ出す。窓が見えている間だけ新着を受け取り（閉じる・最小化で止め、開き直すか接続が替わると取り直す）、描画は`CompositionTarget.Rendering`で1秒30回。メンバーのクリック（またはTab・矢印で選んでEnter・Space）は本体の窓を前へ出し、通知と同じ会話の開き方で開く。試験は`WorkGraphViewTests.cs`（文字の実測2つ・窓が1つだけ・読み上げと押下・描画）と`BellTeam.UiChecks`（入口の並び・窓が1つだけ）。写真（Windows ← Mac）：[相関図の窓](assets/windows-mac-gaps/windows/pr13b-graph.png) ← [分身の線（Mac）](assets/windows-mac-gaps/mac/wg-fork-edges-20261110--mac-graph-window-fork.png)・[labelがnullの線（Mac。札なし）](assets/windows-mac-gaps/mac/b2-16-work-graph-null-label-edge.png)／[混み合った図](assets/windows-mac-gaps/windows/pr13b-crowded.png) ← [Mac](assets/windows-mac-gaps/mac/wg-on-screen-20261110--mac-1-crowded-chips-inside.png)／[サイドバーの入口](assets/windows-mac-gaps/windows/pr13b-sidebar.png) ← [Mac](assets/windows-mac-gaps/mac/wg-fork-edges-20261110--mac-main-window-fork.png)／[空の状態](assets/windows-mac-gaps/windows/pr13b-empty.png)。
- 13b のMacとの残りの違い：(1) 切断中の「彩度を40%へ」は、Windowsの描画に彩度の絞りが無いため、色を灰色へ寄せて近づけた（写真のアバターは灰色の薄い覆い）。(2) 空の状態の淡い円はぼかしでなく放射状の濃淡。(3) 読み上げはUI Automationの要素（メンバーは呼び出し可能）。キーボードはTab・Shift+Tab・矢印でメンバーを巡り、Enter・Spaceで開く（仕様の「keyboard Enter/Space on Web, Windows」）。選んだメンバーはシステムの強調色の枠で示す。(4) 切断・読めない応答の帯の言い方はMacの実装（「相関図の応答を読めませんでした。再接続しています…」）に合わせた。仕様の言い方は「データを読み込めませんでした。再接続中…」。(5) アバターの読み込みに失敗した時は頭文字でなく「!」（会話一覧の丸と同じ）。(6) 会話を開けない時は「相関図のメンバーの会話が見つかりません。…」（通知とは別の言い方）。(7) 札は白地・矢じりは11ptで、Macの実装に合わせた（仕様は札の地をcanvasの0.92、矢じり10pt、流れは点）。(8) サイドバーの入口は、4つが幅320ptに収まるよう等分の3マスをやめ、両端と間の余白で並べた（既存の3つのボタンの左右の余白も詰めた）。

### 14. 秘密の入力カード — M（対応済み：PR 14）

対応済み（PR 14）：下の4件をWindows（WPF）に入れた。画面（Windows ← Mac。Macの写真は900px幅で、11-10の実機ビルドの古い言い方のまま）：[SSH鍵：検索「infra」](assets/windows-mac-gaps/windows/pr14-secret-ssh-search.png) ← [Mac](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-ssh-card-search.png)／[sudo：一覧](assets/windows-mac-gaps/windows/pr14-secret-sudo-list.png) ← [Mac](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-sudo-card-picker-list.png)／[sudo：保管庫「team」で検索](assets/windows-mac-gaps/windows/pr14-secret-sudo-vault.png) ← [Mac](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-sudo-card-search-by-vault.png)／[`op://`の参照欄](assets/windows-mac-gaps/windows/pr14-secret-reference.png)・[1回だけの値](assets/windows-mac-gaps/windows/pr14-secret-onetime.png)・[`terminal.login`](assets/windows-mac-gaps/windows/pr14-secret-login.png) ← [Mac](assets/windows-mac-gaps/mac/b2-10-terminal-login-card-one-hidden-field.png)・[旧本体（一覧が404）](assets/windows-mac-gaps/windows/pr14-secret-old.png)（Macの写真なし）。
- 置き場所：状態と文言は`SecretInputModel`・`SecretSubmission`・`OnePasswordKey`（`BellTeam.Core/SecretInput.cs`）、通信は`SecretRequestApi.KeysAsync`と`BellApi.FinishSecretAsync`、窓は`SecretInputWindow`（`RequestCards.cs`）。`inputOptions`・`oneTime`は型違いを「無し」として読む（`MemberState.cs`の読み方と同じ）。試験は`SecretInputTests.cs`。写真の再生成は`mac-ui-reference.mjs <exe> <out> secret`（GETだけのモック）。
- Macとの残りの違い：(1) Mac本体の`SecretInputSheet`は今日の`96069a23`で同じ言い方（「1Passwordから選ぶ」「ここに貼り付ける」「ここに入力する」「1Passwordから読み出す」）になっており、並べたMacの写真だけが古い（「1Passwordの鍵から選ぶ」「鍵を貼り付けて保存する」）。文は#1024のWeb・Macのソースに合わせた。(2) `terminal.login`の送信ボタンはMacと同じ「パスワードを渡す」（Webは「渡して続ける」）。`oneTime`は「渡して続ける」。(3) Macはシート、Windowsは会話のカードから開く幅720のモーダル窓（既存のまま）。選択の行はMacのチェック付きの行を、ラジオ行（Tabと矢印で動かせる）で作った。(4) 旧本体の一行「この版のサーバーには1Passwordの鍵の一覧がありません。鍵を貼り付けて保存してください。」はMacのソースのまま（「保存」を含む。言い方の規則は選択肢の名前だけに掛かる）。(5) `inputOptions`は`onePasswordAvailable`が真なら足りる（Webと同じ。Macは`preferred`も要る）。(6) `SecretRequest.BotId`は16aで省略可にした（Botの無い端末の鍵の依頼`botId:null`を同じ窓で開く）。写真の端末の鍵は`botId`付きの人工データ。(7) 送信で認証が切れた時は、Windowsの既存の動きのまま「登録結果を確認できませんでした」で、Macのようにログインへ戻さない（14の範囲外）。

[secret-input](secret-input.md)と[usage secret-credentials](architecture/modules/usage/secret-credentials.md)が正本。Web #1024（`28d5bfbb`、アドミ経由のオーナー指摘）の言い方を入れた（Macのソースは着手時の`96069a23`で同じ言い方へ追従済みで、Macは未反映ではなくなった）。

- `inputOptions.onePasswordAvailable`の時だけ入力方法を出す。1Password側が上・既定（`preferred:'stored'`なら入力側が既定）。欠落（旧本体）は入力欄だけ。
- 言い方：1Password側は選択式なら「1Passwordから選ぶ」、`op://`の参照欄なら「1Passwordから読み出す」。入力側は「ここに入力する」（`terminal.ssh`は「ここに貼り付ける」）。保存するかどうかは下の注意文だけが言う。
- 一回だけの値（`purpose: terminal.login`、または`oneTime: true`）：1Passwordの選択肢を出さず、「保存」「登録」を言わない。`oneTime`の注意文は「1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。」、送信は「渡して続ける」（`terminal.login`はMacと同じ「パスワードを渡す」）。それ以外は「登録して続ける」。
- `terminal.ssh`・`terminal.sudo`：`GET /api/secret-requests/:id/onepassword-items`の一覧から選ぶ（sudoは`/password`で終わる参照だけ）。上に検索欄「名前や保管庫で絞り込む」（題名か保管庫名、大文字小文字を区別しない）。`terminal.ssh`は改行を保つ複数行の欄。旧本体の404は入力欄へ。
- 送信の本文：入力は`{value}`、1Passwordは`{source:'onepassword', reference}`（`op://`で始まらなければ送らず案内する）。

### 15. 1Password連携の設定 — M

Macの[settings-and-profile「1Password連携」](architecture/modules/apple/settings-and-profile.md)とWebの`web/onboarding.js`と同じ文・状態。

- 追加機能の一覧の`onePassword`行：状態のバッジ（連携中＝緑・未連携＝灰・失敗＝赤）と平易な失敗の文。項目が無い旧本体には行を足さない。
- 編集のページ：バッジ、連携中なら読める保管庫と鍵の数の一行、案内の手順（未連携は開く、連携中は「作り方を見る」の中。リンクはhttpsだけ開く）、tokenの欄（`ops_`で始まらなければ送らない。保存後も画面に戻さない）、「保存して連携を確かめる」（待つ間は「連携を確かめています…」）。
- 結果の一行（主ボタンの上）：「連携できました。」＋保管庫の一行（緑）／「連携できませんでした。」＋理由（赤）／「連携を解除しました。」。読み直しだけ失敗したら「保存しました。表示を更新できませんでした」。

対応済み（PR 15）：Windows（WPF）に入れた。画面：[連携していない（案内つき）](assets/windows-mac-gaps/windows/pr15-1password-not-linked.png)・[確かめている](assets/windows-mac-gaps/windows/pr15-1password-checking.png)・[連携できた](assets/windows-mac-gaps/windows/pr15-1password-success.png)・[連携できなかった](assets/windows-mac-gaps/windows/pr15-1password-failure.png)。Macの写真（900px幅）：[連携していない](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-1password-not-linked.png)・[確かめている](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-1password-checking.png)・[連携できた](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-1password-success.png)・[連携できなかった](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-1password-failure.png)。

- 作り：状態・結果の一行・`ops_`の検査・https限定のリンクはCoreの`OnePassword.cs`（Macの`OnePasswordState`・`OnePasswordResult`と同じ規則）、画面は`OnePasswordView.cs`、一覧の行は`SettingsPages.cs`。`guide`・`connection`は型の違う値を「無し」として読む（`FeatureSetting.Read`）。保存は`PlanningApi.SaveFeatureAsync`で1回だけ`PATCH`し、再送しない。結果の一行は応答の`setting`で決め、成功後に`/api/settings`を読み直してバッジを更新する。
- Macとの違い：(1) 印は`Segoe Fluent Icons`（鍵・チェック・警告・外部リンク・矢印）で、失敗の三角は塗りでなく線。切替は`CheckBox`の標準の見た目。(2) 主ボタンはアプリの紫のカプセル（Macの写真は灰色）。(3) 要求が拒否された時のフォームの文は、既存の`SaveFeatureAsync`が秘密を守るためにサーバーの文を捨てるので、固定の「設定の保存・反映結果を確認できませんでした。閉じて最新の状態を確認してください。」になる（Macはサーバーの文）。(4) 確かめている間は、設定の窓を閉じることも、主窓の別の画面へ替えることもできない（設定の中で項目を替えても要求は続き、結果はその画面には出ない）。(5) Windowsの写真は設定の窓全体（項目一覧つき）で、Macの写真はサイドバーと詳細。(6) 写真の「確かめている」「連携できた」は、GETだけのモックが`PATCH`を返せないので描画用の入口で状態を置いた。

### 16. 端末 — L＋M＋M（Windowsに無い）

契約は[terminals](architecture/modules/terminals/README.md)（担当クラスト）、Macの部品は[apple/terminals](architecture/modules/apple/terminals.md)。「Screen rules (Admi Web, Ziz Apple; Windows later)」のWindows版にあたる。

- 16a 対応済み（PR 16a）：設定の一覧に「端末」（「AIの設定」の次。水色のモニターの印。説明は「メンバーの席を動かす端末と、その鍵」で、Macの「Macと」をOSに依らない言い方にした）。画面（Windows ← Mac。Macの写真は900px幅）：[一覧](assets/windows-mac-gaps/windows/pr16a-terminal-list.png) ← [Mac](assets/windows-mac-gaps/mac/b2-01-terminal-list.png)／[詳細：`AUTH_FAILED`と「この鍵を入れる」](assets/windows-mac-gaps/windows/pr16a-terminal-detail-auth-failed.png) ← [Mac](assets/windows-mac-gaps/mac/b2-02-terminal-detail-auth-failed-put-key.png)／[詳細：ホスト鍵の理由と「ほかの方法」](assets/windows-mac-gaps/windows/pr16a-terminal-detail-hostkey-other-ways.png) ← [Mac](assets/windows-mac-gaps/mac/b2-03-terminal-detail-hostkey-other-ways-open.png)／[追加：macOS](assets/windows-mac-gaps/windows/pr16a-terminal-editor-os-macos.png) ← [Mac](assets/windows-mac-gaps/mac/b2-04-terminal-editor-os-macos.png)・[Windows](assets/windows-mac-gaps/windows/pr16a-terminal-editor-os-windows.png) ← [Mac](assets/windows-mac-gaps/mac/b2-05-terminal-editor-os-windows.png)・[Linux](assets/windows-mac-gaps/windows/pr16a-terminal-editor-os-linux.png) ← [Mac](assets/windows-mac-gaps/mac/b2-06-terminal-editor-os-linux.png)／[ホスト鍵の指紋シート](assets/windows-mac-gaps/windows/pr16a-hostkey-sheet.png) ← [Mac](assets/windows-mac-gaps/mac/b2-07-hostkey-fingerprint-sheet.png)／[鍵：設定済み・未設定](assets/windows-mac-gaps/windows/pr16a-terminal-keys-set-and-unset.png) ← [Mac](assets/windows-mac-gaps/mac/b2-08-terminal-keys-set-and-unset.png)／[鍵：設定待ち・未設定](assets/windows-mac-gaps/windows/pr16a-terminal-keys-pending-and-unset.png) ← [Mac](assets/windows-mac-gaps/mac/b2-09-terminal-keys-pending-and-unset.png)。Macの写真が無い状態：[鍵を入れている待ち](assets/windows-mac-gaps/windows/pr16a-terminal-detail-authorizing.png)・[Windows PCの`CONNECTION_REFUSED`（sudo鍵の行なし）](assets/windows-mac-gaps/windows/pr16a-terminal-detail-windows-refused.png)・[旧本体の一行](assets/windows-mac-gaps/windows/pr16a-terminal-list-old-server.png)・[503 `TERMINALS_UNAVAILABLE`](assets/windows-mac-gaps/windows/pr16a-terminal-list-unavailable.png)。`terminal.login`のカードは14の[Windows](assets/windows-mac-gaps/windows/pr14-secret-login.png) ← [Mac](assets/windows-mac-gaps/mac/b2-10-terminal-login-card-one-hidden-field.png)。
- 置き場所：状態・文言・検査・通信は`BellTeam.Core/Terminals.cs`（`Terminal`の寛容な読み、`TerminalKeyState`、`TerminalCheck`の理由とOSごとの文、`TerminalDraft`、`HostKeyFingerprint`、`TerminalAuthorize`、`TerminalErrorText`、`TerminalsApi`、一覧・確かめ結果・鍵の導入の待ちを持つ`TerminalsModel`。`Workspace.Terminals`が接続ごとに持つ）。画面は`TerminalsView.cs`（一覧・詳細・追加/編集のシート・ホスト鍵のシート）と`SettingsTerminals.cs`（設定のページ）。追加/編集とホスト鍵はMacのシートと同じ主窓の中のシート、詳細は設定の中の下位ページ（戻るは「‹ 端末」）。鍵の設定と「鍵を入れる」は14の`SecretInputWindow`を、返った依頼（`botId:null`）で開く。`SecretRequest`は鍵の入口の最小の本文（`id`・`label`・`inputOptions`）を読めるよう`BotId`を省略可にし、`ToolId`・`Message`・`Status`に既定を置いた（Macと同じ。Botの依頼の読みは変わらない。14の違い(6)はこれで解消）。試験は`TerminalsTests.cs`。写真の再生成は`mac-ui-reference.mjs <exe> <out> terminals`（GETだけのモック。確かめ結果・待ちの状態は描画の窓口で入れ、送らない）。
- 16aのMacとの残りの違い：(1) ホスト鍵の手入力はMacの手入力のシートと同じ`PUT /api/terminals/:id {confirmHostKey}`で送る。`POST …/trust`は契約のS2（そのPCのアプリが自分のホスト鍵を読んで送る）で、16cで入れる。(2) 一覧の読み直しが旧本体の形（404・405）で失敗した時、Macのコードは読めていた一覧を消して「未対応」へ戻すが、Macの設計書（状態図）と同じく、読めていた一覧は残して「最新の一覧を読み込めませんでした」を足す（最初の読みだけ「未対応」）。(3) ホスト鍵の節：「このMacを確かめる」と「このMacでBellTeamアプリを開くと、自動で確かめます」はS2なので16c。「ほかの方法」の説明はOSの名詞を使う（Macは「Mac」のまま）。指紋を読むコマンドはWindowsの端末だけ`C:\ProgramData\ssh\ssh_host_ed25519_key.pub`（契約S2。Macの画面はどのOSでもPOSIXの1つ）。(4) 追加画面は「このMacを追加」（16c）を置かず、Macのこの端末以外の画面と同じ前提の一行（OSごと）をいつも出す。「共有設定を開く」「オプション機能を開く」の操作も16c。(5) 鍵の入力欄の題はサーバーの`label`（Macは「<端末>の<鍵の種類>」で上書き。サーバーの題は同じ形）。(6) 予期しないエラー符号の文はWindowsの共通の形（「BellTeam: <符号>」）で、Macの`guidance(status)`にあたる文は持たない。結果が分からない書き込みの文だけMacと同じ。(7) 「エラーの詳細」の折りたたみ（Macの`SettingsBanner`の「詳細」）は、読み直しの失敗の理由を折りたたまず2行目に出す。(8) 確認した時刻はWindowsの短い時刻（今日は`H:mm`）で、Macのロケールの形ではない。(9) 状態はWindowsではつなぎ直しでも空に戻る（Macは接続先の変更とサインアウトだけ）。(10) 一覧の行・「つながるか確かめる」などのアイコン行はTabで巡りEnter・Spaceで押せる（Windowsの既存の行はポインタだけ。端末の画面で足した）。
- 16cが使うもの（16bの`GET …/folders`・`POST …/folder`・`MemberFolder`・`MemberBinding`・`TerminalFolderPicker`は下の16bで作った）：`TerminalsApi.TrustAsync`（`POST …/trust {fingerprint}`）、`TerminalsModel`へ`Attesting`・`TrustNotes`・`Attested`（Macの`TerminalDirectory`）と`RefreshAsync`の後の自動の確かめ、詳細のホスト鍵の節（`TerminalDetailView.HostKeyGroup`の状態の行と「ほかの方法」の間）と`CONNECTION_REFUSED`の行（`ReachabilityGroup`）へ「このPCを確かめる」「オプション機能を開く」、追加のシート（`TerminalEditorView`の最初の前提の一行の隣）へ「このPCを追加」。`TerminalOS.Machine`が「Windows PC」を返すので、契約の「このPC」の言い方は16cで`windows`の端末が自分の時だけ使う。
- 16b 対応済み（PR 16b）：メンバー編集の「端末とフォルダ」（「動かす場所」＝「このBellTeam」／登録した端末、フォルダは読み取り専用の表示と「フォルダを選ぶ」、文字入力は畳んだ「ほかの方法 > パスを入力」の中、保存の`FOLDER_*`拒否の文と`FOLDER_MISSING`だけの「このフォルダを作って保存」）とフォルダ選びのシートを、Macと同じ規則で入れた。画面（Windows ← Mac。Macの写真は900px幅）：[追加：端末を選んでフォルダを埋めた状態（macOS）](assets/windows-mac-gaps/windows/pr16b-member-editor-terminal-folder.png) ← [Mac](assets/windows-mac-gaps/mac/b2-12-member-editor-terminal-folder-section.png)・[Mac（並べた写真）](assets/windows-mac-gaps/mac/apple-folder-picker-20261110--mac-20-member-editor-terminal-folder.png)／[`FOLDER_MISSING`と「このフォルダを作って保存」](assets/windows-mac-gaps/windows/pr16b-member-editor-folder-missing-offer-create.png) ← [Mac](assets/windows-mac-gaps/mac/b2-11-member-editor-folder-missing-offer-create.png)／[フォルダ選び：ホーム](assets/windows-mac-gaps/windows/pr16b-folder-picker-home.png) ← [Mac](assets/windows-mac-gaps/mac/apple-folder-picker-20261110--mac-40-folder-picker-home.png)／[サブフォルダ](assets/windows-mac-gaps/windows/pr16b-folder-picker-subfolder.png) ← [Mac](assets/windows-mac-gaps/mac/apple-folder-picker-20261110--mac-41-folder-picker-subfolder.png)／[作ったフォルダを開いた状態](assets/windows-mac-gaps/windows/pr16b-folder-picker-created.png) ← [Mac](assets/windows-mac-gaps/mac/apple-folder-picker-20261110--mac-42-folder-picker-created.png)／[届かない](assets/windows-mac-gaps/windows/pr16b-folder-picker-offline.png) ← [Mac](assets/windows-mac-gaps/mac/apple-folder-picker-20261110--mac-44-folder-picker-offline.png)。Macの写真が無い状態：[Windows PCを選んだ時（`C:\Users\<user>\BellTeam\<slug>`）](assets/windows-mac-gaps/windows/pr16b-member-editor-terminal-folder-windows.png)・[Windows PCのフォルダ選び](assets/windows-mac-gaps/windows/pr16b-folder-picker-windows.png)・[旧本体のフォルダ選び](assets/windows-mac-gaps/windows/pr16b-folder-picker-unsupported.png)・[旧本体で文字入力が最初から出た状態](assets/windows-mac-gaps/windows/pr16b-member-editor-typed-path.png)・[端末の一覧が無い旧本体の一行](assets/windows-mac-gaps/windows/pr16b-member-editor-old-server.png)。写真の再生成は`mac-ui-reference.mjs <exe> <out> memberfolder`（GETだけのモック。端末の選択・シートの場所・拒否された保存の状態は描画の窓口で入れ、送らない。Windowsの日本語フォントは`\`を`¥`の形で描く。値は`\`のまま）。
- 置き場所：状態・文言・検査は`BellTeam.Core/MemberFolders.cs`（`MemberFolder`＝既定のフォルダ・OSごとのprefill・`FOLDER_*`の文と「作って保存」の可否、`MemberBinding`＝組の規則とOSごとの絶対パスの検査、`TerminalFolderPicker`＝名前の規則・パスの結合・一文・問い合わせの符号化、`TerminalFolderPickerModel`＝読み込み中・一覧・失敗・旧本体と新しいフォルダ）、通信は`TerminalsApi.FoldersAsync`・`CreateFolderAsync`と`TerminalsModel`（`FoldersUnsupported`）、保存の本文は`BotSettings.TerminalId`・`ProjectRoot`（`null`＝応答に無い本体で送らない）と`ManagementApi.SaveBotAsync`・`CreateBotAsync`の`createFolder`（その保存の本文だけ。照合の`changes`に入れず、保存済みの設定にも入れない）。画面は`MemberFolderView.cs`（`MemberTerminalSection`＝端末の選択・フォルダ・畳んだ「ほかの方法」・組の問題・脚注、`FolderPickerView`＝シート）と`MemberEditorView`（保存前の検査、拒否の文、「このフォルダを作って保存」）。シートは主窓のシートでなく、編集の窓（または追加のシート）の中に重ねる。試験は`MemberFolderTests.cs`。
- 16bのMacとの残りの違い：(1) 「端末を管理」の行はMacと同じ位置に置くが、Macのように編集の中で端末の一覧へ進むのでなく、主窓で設定の「端末」を開いて主窓を前へ出す（Windowsのメンバー編集は別窓で、窓の中に戻れる遷移先が無いため）。(2) 既存メンバーの保存は、Windowsの編集が従来から変えた項目だけを送る形なので、端末・フォルダを変えた時だけ`terminalId`・`projectRoot`が本文に入る（Macは毎回すべてを送る）。組の規則の検査は毎回の保存で行う。新規は両方を送る（このBellTeamは両方空）。(3) シートは窓の中に重ねる幅560のカードで、Macのように編集画面と別のシートではない。閉じるのは「閉じる」と「このフォルダにする」で、Escキーは割り当てていない。(4) 端末の一覧を読み込み中の行に回転表示は付けず文字だけ（「端末の一覧を読み込んでいます…」）。(5) フォルダの一覧の経路が無い本体の判定（`FoldersUnsupported`）は`Workspace.Terminals`が持ち、つなぎ直しで空に戻る（Macは`AppStore`の端末の状態）。(6) 「作る」の名前欄でEnterは何もしない（Macの欄も送信しない）。(7) 保存結果の`folderCheck.checked === false`（端末につながらず未確認）は出さない（Macも出さない）。Macの写真にある「作ったフォルダを開いた状態」は、作成のPOSTをモックが受けないので、作成後に開く場所を描画の窓口で直接開いた状態である（作成後の動作は試験で確かめた）。
- 16cで要るもの：「このPCを追加」と「このPCを確かめる」・自分のホスト鍵の確かめ（ループバック）・`POST …/trust`・`windows`の端末が自分の時の「このPC」の言い方・自分のPCのためのネイティブのフォルダ選び（Windowsのフォルダの窓）は入れていない。UIも空の入口も置かず、16cで、上の16cの決め事（クラストと細部を決め、図を先に直す）に従って作る。
- 16c 「このPCを追加」と自分のホスト鍵の確かめ（MacのS1・S2のWindows版）：Windowsのアプリが動くPCを、OpenSSHサーバーの22番とループバックのホスト鍵で登録・信用する。入れる（トロニー裁定 2026-11-11：Macの再現に含まれる）。契約はMacのアプリだけを書いているので、トロニーがクラストへWindowsのアプリを契約に書くよう頼み、Windows版のS1・S2の細部はクラストと直接決めて、図を先に直してから作る。

### 17. メンバーの状態の行 — M

対応済み（PR 17）：5件ともWindows（WPF）に入れた。画面：[設定の適用：保留](assets/windows-mac-gaps/windows/pr17-member-editor-configuration-pending.png)・[受付済み](assets/windows-mac-gaps/windows/pr17-member-editor-configuration-accepted.png)・[失敗](assets/windows-mac-gaps/windows/pr17-member-editor-configuration-failed.png)、[再起動：待ち](assets/windows-mac-gaps/windows/pr17-restart-in-progress.png)・[成功](assets/windows-mac-gaps/windows/pr17-restart-success.png)、[分身の行](assets/windows-mac-gaps/windows/pr17-fork-badge.png)、[起動できない理由：action付き](assets/windows-mac-gaps/windows/pr17-seat-launch.png) ← [Mac](assets/windows-mac-gaps/mac/b2-14-sidebar-and-header-seat-launch-with-action.png)・[codeだけ](assets/windows-mac-gaps/windows/pr17-seat-launch-code.png) ← [Mac](assets/windows-mac-gaps/mac/b2-15-sidebar-and-header-seat-launch-code-only.png)（Macはサイドバーの2行目を省略記号で切る。Windowsは2行に収まる文なので同じ見え方）。モデルの表示名のMac：[「Opus 5.5」](assets/windows-mac-gaps/mac/b2-13-member-editor-ai-model-display-name.png)（Windowsは開いた一覧を窓の外で描けないので写真なし。表示名は試験で確かめた）。Macの並べた写真（900px幅）：[保留](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-member-editor-configuration-pending.png)・[受付済み](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-member-editor-configuration-accepted.png)・[失敗](assets/windows-mac-gaps/mac/apple-parity-batch2-20261110--mac-member-editor-configuration-failed.png)、[再起動：待ち](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-restart-in-progress.png)・[成功](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-restart-success.png)、[分身](assets/windows-mac-gaps/mac/apple-fork-label-20261110--mac-fork.png)。Macの「起動できない理由」の写真は参照用の枝に無いので、並べていない（文言はMacのPreviewFixturesの値と同じ）。

- 読み方：`seatLaunch`・`configurationApplication`・メッセージの`seat`は、型の違う値を「無し」として読む専用のコンバーター（`MemberState.cs`）で、名簿・履歴を壊さない。表示の置き場所は`ConversationEntry.SeatLaunchLine`（サイドバーの行）と`Selected.SeatLaunchLine`（会話の上端）、`ModelPicker.ShowConfiguration`（編集の「AI」の最後。開いた時のBotでなく名簿の今の項目を読み、保存後の再取得で書き換わる）、`MessageCard`の時刻の行。
- 再起動の待ち180秒は`ManagementApi.RestartTimeout`で、`BellApi.PostAsync`の`limit`として渡す（他の要求は従来の30秒）。再起動の状態は、起動したメンバーのものとして`ProfileView`が持つ。
- Macとの違い：(1) 状態の印は、SF Symbolsでなく`Segoe Fluent Icons`の時計・チェック付き丸・警告（Macの写真は印の追加前に撮られたので、Windowsの写真にだけ印がある）。(2) 分身の印の枝のマークは`arrow.triangle.branch`でなく、描いたY字の線。(3) 会話の上端の行は、Macのナビゲーションバー直下に当たる、上端の帯（高さ52）の直下に置き、背景は半透明の白（Macは`regularMaterial`）。(4) 再起動が時間切れになった時の文は従来の失敗表示のまま（HttpClientの取り消しの文。Macは`localizedDescription`）。

- 起動できない理由（`seatLaunch`）：サイドバーの行の2行目と、会話の上端に赤い1行「端末で起動できません：<action>」（`action`が空なら`code`、両方空なら「端末で起動できません。」。会話の上端は最大3行で折り返す）。`null`・欠落・不正な値は出さず、名簿の読込を壊さない。
- 設定の適用状態（`configurationApplication`）：既存メンバーの編集の「AI」の最後に、状態の印（時計・チェック・警告）付きの1行。Webの`renderBotConfigurationStatus`と同じ文。
- モデルの表示名：メンバー編集と「仕事の要約を書くAI」の候補に`display_name`（空ならID）。選ぶ値・保存する値はID。
- 会話セッションの再起動：押すと「再起動しています…」で無効にし、成功で「会話を再起動しました。」の一行。要求の待ちは180秒（本体は新しい席が立ってから答える）。
- 分身の行：Botの直接会話で、`seat.kind == fork`の行の時刻の前に紫のカプセル「分身」。`seat`が無い・型が違う・未知のkindは従来の行。

### 18. アップデートの言い方 — S

- 全部が公開版と一致か`incompatible`で、`incompatible`が1つ以上：「更新できるものはすべて最新です」と「<名前>は、いまの本体に合う版がまだありません。合う版が出ると、ここで更新できます。」。他に確かめられない機能があれば従来の「更新を確認できませんでした」。
- 機能の印：`incompatible`は「使えない版」（Windowsは今「互換性を確認できません」）。
- phase failedは、executionの値に関わらず確定として扱い、「更新できませんでした」と本体の理由を出す。
- 18 対応済み：`UpdateScreen`に待ちの状態（`UpdateKind.Waiting`、ミントの印）と`UpdateBadge.Incompatible`（「使えない版」）を足した。phase failedの確定は、Windowsが前から`Failure`で同じ扱いをしていた。「詳細」の比較の文（「互換性を確認できません」）はMacと同じなので変えない。写真（Windows ← Mac）：[待ちの状態](assets/windows-mac-gaps/windows/pr18-update-waiting.png) ← [Mac](assets/windows-mac-gaps/mac/apple-parity-batch1-20261110--mac-update-waiting.png)。設定の一覧の「端末」の行は16aで足す。

### 19. Claudeの2アカウントの照合 — S

12のWindowsを、届いたApple版（`cadc40c0`・`f37b05a4`：アカウントごとの「認証済み」の札、共通のボタンの言い方）と並べて照合し、違いを直す。
- 19 対応済み：Appleの`f37b05a4`に合わせ、1st・2ndの行の札とボタンを他のAIの行と同じ言い方にした（認証済み／未認証／確認できません、認証し直す／認証する／確認する。`HarnessRowState.FromSlot`）。「アカウント」の行は、本体がアカウント名を返した時だけ出す（PR #1045）。Macの写真（ラピ、`16636730`）と並べて残りの違いも直した：灰色の箱をやめて平らな行にし、見出し「Claude」の右に使用人数、アカウント名は見出しなし、上限は1件ずつオレンジの行、「使用中: <メンバー名>」（使う席が無ければ出さない）、「状態」と人数の行はやめた。カード内の両方上限の帯はMacの「1stアカウントと2ndアカウントがどちらも…です（…）」。メンバー一覧の上の帯はWebと同じ文のまま（キロの回答）。会話の履歴が分かれている時の注記は、契約がオーナーに見せると決めているので残す（Macには無い）。写真（Windows ← Mac）：[両方とも認証済み](assets/windows-mac-gaps/windows/pr19-accounts-normal.png) ← [Mac](assets/windows-mac-gaps/mac/b3-01-claude-accounts-both-authenticated.png)・[2ndが未認証](assets/windows-mac-gaps/windows/pr19-accounts-unlogged.png) ← [Mac](assets/windows-mac-gaps/mac/b3-02-claude-accounts-second-unauthenticated.png)。12の写真（`pr12-accounts-*`）も今の画面で撮り直した。

### 追従の順と見積もり

| 順 | PR | 規模 |
| --- | --- | --- |
| 13a | 相関図のモデル（状態・シミュレーション・札・入れ替え・clearance、仕様に対する試験） | L |
| 13b | 相関図の窓・描画・操作・読み上げ・サイドバーの入口 | L |
| 17 | メンバーの状態の行（起動できない理由・設定の適用・表示名・再起動・分身） | M |
| 18 | アップデートの言い方 | S |
| 19 | Claudeの2アカウントの照合 | S |
| 14 | 秘密の入力カード（#1024の言い方を含む） | M |
| 15 | 1Password連携の設定 | M |
| 16a | 端末のページ | L |
| 16b | メンバーの端末とフォルダ・フォルダ選び | M |
| 16c | このPCを追加（細部はクラストと決める） | M |

10本、実作業でおよそ12日分（S＝0.5、M＝1、L＝2）。16は14の秘密カードを使うので後ろに置く。Macは動き続けるので、各PRの着手時にその時点のmainの`ios/`と照らし、増えた差分はこの節へ行を足す。
