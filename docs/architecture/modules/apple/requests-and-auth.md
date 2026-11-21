# 質問・秘密要求・接続とAI認証

[全体図](overview.md) / [会話](conversation.md) / [状態と同期](state-and-sync.md) / [試験](tests.md)。

調査source：HEAD `afda9477bba4aaa7c8a6905100d3bacf26e47c90`（detached）。静的読取。パスは`ios/BellBot/`から。サーバー内部は対象外。

## 会話内の質問と秘密要求

```mermaid
flowchart TD
  Message["会話履歴のTimelineMessage"] --> Cards["ConversationCardStates<br/>message ID別状態を保持"]
  Cards --> Question["OwnerQuestionCard<br/>選択肢 / その他の文章"]
  Cards --> Secret["SecretRequestCard<br/>入力sheetを会話の根で開く"]
  Message -->|"kind machine_event（a471）"| Machine["MachineEventRow<br/>view別に描く。消す行は無い<br/>fold行はMachineFoldLine（1行・開閉・束ね）<br/>wordsのbubble:trueは普通の受信の吹き出し（MessageRow・全文）"]
  Machine -->|"view question / approval"| MCard["MachineRequestCard<br/>質問ごとの選択肢・複数選択・その他 / 許可・拒否<br/>状態はConversationCardStatesがrequest_id別に保持"]
  MCard --> Access
  Access --> MAnswer["POST /api/seat-requests/:request_id/answer<br/>{answers:[{indexes,other}]} または {decision}"]
  MAnswer --> MResult["返却requestのstatusをカードへ<br/>409 REQUEST_NOT_PENDINGも返却requestで期限切れ表示<br/>共通一覧refresh（行は同じidのまま状態だけ変わる）"]
  Question --> Access["AppStore.authorizeAIUse<br/>要求元Bot宛て"]
  Secret --> Sheet["SecretInputSheet<br/>秘密値・op://参照はsheet内だけ"]
  TerminalKey["TerminalDetailPage 鍵の行<br/>（terminals.md AT07）"] --> Sheet
  TerminalAuthorize["TerminalDetailPage「このMacにこの鍵を入れる」<br/>（terminals.md AT11・AT12）"] --> Sheet
  Sheet --> Source["inputOptions.onePasswordAvailable<br/>1Password参照を先 / 保存値を代替"]
  Sheet -->|"purpose terminal.login（Mika #855）"| Login["パスワード欄1つに貼るだけ<br/>1Passwordの選択肢・参照欄なし（inputOptionsを無視）<br/>文：このMacのログインパスワード（1回だけ使い、保存しません）<br/>題：サーバーのlabel（端末 （ID） のMacのログインパスワード）をそのまま"]
  Source -->|"purpose terminal.ssh / terminal.sudo"| Picker["鍵・パスワードの選択: GET /api/secret-requests/:id/onepassword-items<br/>{items:[{title,vault,reference}]}（旧本体404は貼り付け・入力へ）"]
  Picker --> Rows["OnePasswordKey.choices / countLine<br/>sudoは/passwordで終わる参照だけ・名前か保管庫で絞り込み・「N件から選んでください」"]
  Sheet --> Access
  Access --> Answer["POST /api/owner-questions/:id/answer"]
  Access --> Finish["POST /api/secret-requests/:id/submit または cancel"]
  Answer --> Result["返却されたquestionをカードへ<br/>共通一覧refresh"]
  Finish --> Complete["返却されたrequestをcallbackへ<br/>sheetを閉じる"]
```

| 所有者・操作 | 入出力・成功・失敗 |
| --- | --- |
| OwnerQuestionCardState | result/other/sending/error。ConversationCardStatesがID別に保持し、行の再利用をまたぐ。currentはresult優先。表示本文と選択肢は引数question |
| 選択回答 | choice、その他はtextをOwnerAnswerBodyへ。その他はtrim後が空ならボタン無効。送信中はボタン/入力を無効化。authorizeAIUse後にPOSTしresultへ応答question、error消去→refreshFromView。受付応答からBotの回答処理完了を判定しない |
| 回答失敗 | 認証はrequireLogin。他はoperationFailureMessageとwrite診断、otherは残す。deferでsending解除。自動POST再送・個別質問GETによる照合はこのカードにはない |
| MachineEvent（Core/MachineEvent.swift） | 機械席（machine seat）のstream-jsonをconversationが解釈した行（`kind:"machine_event"`、契約は[conversation/machine-stream.md](../conversation/machine-stream.md)）。アプリは`view`だけで描き、生の行は読まない。読めない形でも履歴全体のdecodeを壊さず`unknown`として出す |
| MachineEventRow | `words`で`bubble: true`（machine-stream.md「Turn answer bubble」）の行は、`ConversationView.timelineRow`が`MachineEventRow`でなく普通の受信の吹き出し（`MessageRow`、`message`を全文`text`に替える）で描く。アプリは「最後」を決めず`bubble`だけを読む。`display`が`fold`でなければ`show`として描く（`hide`は無い。オーナー裁定「畳むのはオッケー、消すのはダメ」で、どの種類の行も必ず履歴にあり、アプリも消さない）。`words`と`thinking`は`machine_event.text`の全文（`message`でも行数制限でもない。`thinking`は薄い斜体で選択できる。`isThinking`は`view == "thinking"`、古い`words`＋title `thinking`は別名。machine-stream.md「Thinking is always shown whole」）、`tool_use`は1行、`rate_limit`・エラー結果などの`show`は`message`の短い1行。`fold`はMachineFoldLineで描く（下）。カードのviewはその下 |
| 畳み行の組立（`[TimelineMessage].machineFolded`） | 履歴の行を順に読み、連続する`fold`行は`fold_group`（無ければ`view`）が同じ間だけ先頭の行へ束ね、別のgroup・`show`の行・機械席以外の行で切る。束ねた行は先頭行の`MachineEvent.attached`に持たせ、行の等価比較に入れて、後から結果が着いても一覧が再描画される。行は時系列の位置から動かさない（`tool_result`を`tool_use`の下へ引き上げない。オーナー裁定「時系列をくずすな」）。ConversationViewの`messages`がこの結果を使う |
| MachineFoldLine | 畳み行は常に1行（chevronと題）で、既定は閉じる。題は、`fold_count`（無ければ1）の合計nで決める：n>1は「group ×n」（tools ×2、background ×9）、n==1は道具1件の`message`（仲間が複数なら`fold_count`1の仲間）、n==0は「group ×仲間の数」。タップで本文が開き、もう一度で閉じる。仲間が複数なら、仲間を時系列の順に閉じた1行ずつ並べ、押した行の本文（`tool_use`は`tool.summary`、他は`text`。選択・コピー可）が開く。`truncated`の行は「全文を読み込む」で`GET /api/bots/:id/machine-events/:seq`（`{seq,line}`）の保存済みの行をそのまま出す。開閉（束ねた行の中の仲間ごとの開閉を含む）と全文は`MachineFoldState`で、ConversationCardStatesが行id別に保持する（保存しない） |
| MachineRequestCardState | result（返却status/answers）/選択/その他の文/sending/error。ConversationCardStatesがrequest_id別に保持し、行の再利用をまたぐ。currentはresult優先で、無ければ行の`request` |
| 機械席の質問カード | `request.questions`を質問ごとに描く（`header`・本文・選択肢の`label`と`description`）。`multiSelect`はチェック、それ以外は1つ。その他は文章欄（trim後が空なら無効）。質問が1つで単一選択なら選択肢を押した時点で送り、それ以外は全質問に答えがそろったら「送る」を有効にする。bodyは質問と同じ順の`answers`（`indexes`と`other`）。`pending`のあいだだけ操作でき、`answered`は選んだ答え、`expired`は「席はもう待っていません」を出す |
| 機械席の許可カード | `view:"approval"`。`tool`の名前と要約を出し、`pending`のあいだ「許可」「拒否」。bodyは`{decision}` |
| 機械席の回答の成否 | authorizeAIUse後にPOST。200は返却statusをカードへ。409 `REQUEST_NOT_PENDING`は返却requestがexpiredなのでそのまま期限切れ表示。他の失敗はoperationFailureMessageとwrite診断で`pending`のまま残し、選択は残す（Owner自身がやり直せる。自動再送なし）。認証はrequireLogin。成功・409のあとは共通一覧refresh |
| SecretRequestCardState | 応答requestだけ保持。pendingなら入力を開く、それ以外はsubmitted=登録済み、その他=取消。notification=failedならAIへの通知失敗の案内を表示 |
| SecretInputSheet | requestとonCompleteを受け、value/reference/useOnePassword/sending/errorを所有。`inputOptions.onePasswordAvailable`の時だけ入力方法を出し、1Passwordの参照を上・既定（`preferred:'stored'`の時は保存値を既定）、保存値を代替にする。欠落（旧本体）は保存値だけ。`purpose:'terminal.ssh'`は改行を保つ複数行欄、他はSecureField。すべてprivacySensitive。`purpose:'terminal.login'`（Mac上のSSHへ1回だけ使うログインパスワード、保存しない）は、`inputOptions`が何を言っても1Passwordの選択肢も参照欄も出さず、SecureField1つ（題は呼び出し側が渡したサーバーのlabel。無ければ「ログインパスワード」）と上の文、ボタン「パスワードを渡す」。判定は`SecretRequest.isLoginPassword`・`onePasswordOffered`。`oneTime:true`（usage #1025、1回だけ使い保存しない値）も1Passwordの選択肢を出さず、文は「1回だけ使い、使い終わったら消します。保存せず、会話にも送られません。」、ボタンは「渡して続ける」（判定は`SecretRequest.isOneTime`）。SSH鍵（`terminal.ssh`）とsudo（`terminal.sudo`）で1Password接続済みの時は、選択肢をSSH鍵なら「1Passwordから選ぶ」/「ここに貼り付ける」、sudoなら「1Passwordから選ぶ」/「ここに入力する」とし（一覧の無い`op://`参照欄は「1Passwordから読み出す」/「ここに入力する」。どちらも値の出どころを言い、保存するかどうかは下の文だけが言う）、前者は`onePasswordKeys`（`GET /api/secret-requests/:id/onepassword-items`、同じ`{items:[{title,vault,reference}]}`を1つの復号器で読む）の`title`と`vault`の一覧から選ぶ（参照は送信まで画面に出さない・提出は従来どおり`{source:'onepassword',reference}`）。sudoは`/password`で終わる参照だけを残す（旧本体はどの用途にもSSH鍵を返すので、SSH鍵の参照がsudoKeyRefにならない）。一覧の上に検索欄「名前や保管庫で絞り込む」と1行「N件から選んでください」（合うものが無ければ「「…」に合うパスワードがありません」/「…鍵がありません」）を出し、名前か保管庫に入力を含むものへ大文字小文字を区別せず絞る。絞り込みで見えなくなった選択は外す。検索語は秘密でなく送らない。sudoの貼り付け側はSecureField1つ。一覧が404（旧本体）なら選択肢を隠して貼り付け（sudoは入力）だけにし静かな一行を出す。他の失敗は「読めませんでした」と再読込、貼り付けの選択は残る。未接続の貼り付けにはWebと同じ短い案内（設定の「1Password連携」で一覧から選べる）。入力方法を替えると両方の欄を消す。通常会話draftに渡さない。閉じる操作はdismissだけでcancel POSTを呼ばない |
| 秘密の送信body | 保存値`{value}`、1Password`{source:'onepassword', reference}`（`op://`で始まらなければ送らず案内）、拒否`{}`。形の最終検査はサーバー（`SECRET_REFERENCE_INVALID`） |
| 秘密登録/拒否 | Botの依頼（`botId`あり）はauthorizeAIUse成功後、端末の鍵（`botId:null`）はAI利用でないので許可判定なしで、submitなら`SecretSubmission`・拒否ならnilを退避し画面の欄を消す。nilはcancel、それ以外はsubmitへ。応答requestをonCompleteしてdismiss。AIへの通知成否はrequest.notificationの別項目 |
| 秘密の失敗 | 許可判定失敗はerrorでreturn（この時点ではvalue消去前）。POSTの認証失敗はdismiss→requireLogin。他失敗は登録結果未確認の案内とsecretWrite診断、valueを復元しない。deferでsending解除 |
| 終了と背景 | 秘密sheetは送信中の閉じる/interactiveDismissを無効化。非active/終了でvalueを消す。専用のHTTP取消task・自動再送はない |
| 通知から開く秘密 | AppStoreが個別GETしpendingだけnotificationSecretへ。BellTabs/DesktopWorkspaceViewのsheet callbackはeventRevisionを増加。会話カードから開く経路は対応カードのresultを更新 |

根拠：[OwnerQuestionView.swift](../../../../ios/BellBot/BellBot/Views/OwnerQuestionView.swift#L3)、[SecretRequestView.swift](../../../../ios/BellBot/BellBot/Views/SecretRequestView.swift#L45)。秘密POSTは[BellAPI.finishSecretRequest](../../../../ios/BellBot/BellBot/Core/BellAPI.swift#L133)が保護sessionを生成し、redirect拒否・ephemeral・session cookie storage無し・no-cacheを設定する。要求cookieはBellAPIのrequestから付与。終了はdeferのinvalidateAndCancel。通常メッセージ送信へ値を渡す経路はない。

## 接続先とWeb認証

```mermaid
flowchart TD
  Setup["ServerSetupView<br/>address / error / guide表示状態"] --> Origin["ServerOrigin.url<br/>URLの受理・正規化"]
  Origin --> Store["AppStore.setServerAddress<br/>保存・baseURL設定"]
  Store --> Bootstrap["bootstrap<br/>WK cookie同期 → GET /api/session"]
  Bootstrap --> Initial["settings → setup<br/>readyなら共通一覧取得"]
  Bootstrap --> Login["Access認証要求<br/>LoginViewのWeb sheet"]
  Login --> Web["WKWebView<br/>接続先 api/sessionを開く"]
  Web --> Finish["didFinish → completeWebLogin<br/>サーバー所属の有効CF cookieを確認"]
  Finish --> Session["cookie同期 → GET /api/session<br/>authenticatedを確認して初期状態へ"]
```

[LoginView.swift](../../../../ios/BellBot/BellBot/Views/LoginView.swift#L4)にはServerSetupViewも定義される。addressは画面内、導入ガイドsheetを閉じても同じaddressを保持。導入ガイドは同梱文書の表示・コピー/共有であり、接続処理は行わない。setServerAddressは接続先が変わると編集draft・会話page・画像draft・削除待ち・AI停止状態を整理し、UserDefaultsへURLを書いてbootstrapする。bootstrap内部の接続失敗はphase.failureへ入り、入力画面へthrowで返す検証エラーと区別される。

| 境界 | 確認した契約 |
| --- | --- |
| ServerOrigin | trim、scheme/host小文字化、空path化。HTTPS、またはlocal HTTPのみ。userinfo/password/query/fragmentとルート以外のpathを拒否 |
| local判定 | localhost、.local、単一ホスト名（数字だけを除く）、IPv4の10/127/192.168/172.16〜31/169.254、IPv6のloopback・fc/fd・fe8〜febをコードの条件で受理 |
| LoginView | showingLoginを所有。openLoginAutomaticallyを一度消費してsheet表示。閉じる操作はsheetを閉じるだけ。WKWebViewはAppStore.webDataStoreを使い、navigation didFinishごとにcompleteWebLogin |
| completeWebLogin | checkingLoginで重複を抑止。期限内CF_Authorizationが接続先domainに属する時だけHTTP cookieへ同期。session未認証/認証エラーならreturn、その他はfailureと診断。Webの読み込み完了そのものはログイン成功ではない |
| requireLogin | CloudflareならsignInと自動sheet、local拒否なら設定失敗表示。draftは保持。SSE/foreground停止等は[共通図](state-and-sync.md#送信停止取消途中失敗)参照 |

ServerOriginの定義は[Shared/ServerOrigin.swift](../../../../ios/BellBot/Shared/ServerOrigin.swift#L4)。サーバー到達性・TLS/Accessの外部設定をこの静的図では判定しない。

## 初回利用とtyped認証操作

| 所有者 | 状態・受渡し |
| --- | --- |
| AppStore | setup、setupAuthNeedsRefresh、revision/readSequence/updating。GETの旧応答・旧失敗を採用しない。画面はsetupを読む |
| OnboardingView | input/busy/error。select_harnessはAI選択ボタン、以降はAuthenticationInstructionsと開始・明示更新・AI変更を表示 |
| AuthenticationInstructions | authUiのschema/stage/inputを読む。CLIの表示文字列から種別を推測しない。公式HTTPS URLをLink、userCodeは選択可能テキスト、authorizationCodeはSecureField、choiceはID付きボタン |
| AuthenticationUI.reply | bindingと空でないpromptDigest、対応するstage/input、HTTPS公式URLまたはchoicesを確認。空コードや候補外choiceはreplyを作らない |
| AuthenticationReply | binding、prompt_digest、responseをencode。bindingはsession/launch/metadata/native/paneとprocess情報を送る |

```mermaid
flowchart TD
  Choose["POST /api/setup/harness<br/>harness選択"] --> Setup["応答setupをAppStoreへ"]
  Setup --> Instructions["認証案内・公式URL・code/choice"]
  Instructions --> Reply["現在のauthUi一致とreply生成を確認"]
  Reply --> Input["POST /api/setup/auth/input<br/>保護session"]
  Input -->|"成功"| Setup
  Input -->|"失敗"| Hold["setupAuthNeedsRefresh=true<br/>自動GETと再入力を止める"]
  Hold --> Explicit["明示GET /api/setup<br/>成功でneedsRefresh解除"]
  Setup --> Poll["waiting中3秒ごと<br/>active・非busy時GET /api/setup"]
  Poll --> Setup
  Setup --> Start["authenticatedで開始ボタン<br/>POST /api/setup/start"]
  Start --> Ready["phase=ready応答を確認<br/>名簿取得→会話・guideへ→SSE/購読/通知"]
```

入力は送信callback前、scene非active、auth変更で消す。busyはdeferで解除。performの認証失敗はrequireLogin、それ以外は画面errorとGETならread/変更ならsecretWrite診断。poll失敗はエラーを表示しloop終了。pollは非activeでもsleepのloopを続けるがGETは開始しない。startGuideはsetup応答がreadyでない場合throwし、続く共通一覧取得の失敗でも会話への移動を完了しない。HTTP受付と初回利用ready、案内役の処理完了は別段階。

## 初回設定後のAI再認証

```mermaid
flowchart TD
  Settings["設定のHarnessAuthenticationList"] --> List["GET /api/harness-auth"]
  Settings --> Accounts["GET /api/accounts<br/>404は旧本体で従来の1行<br/>失敗は理由を出し2〜60秒で読み直す"]
  List --> Row["各RowがGET /api/harness-auth/:harness<br/>checking / unavailable / known"]
  Accounts --> Claude["ClaudeAccountsCard<br/>1つ目/2つ目のアカウントの行（呼び名はWebと共通）：認証の札（AuthenticationProgress）・メール（この画面だけ、Root裁定）<br/>モデルごとの上限と解除時刻（日本時間）・使用中のメンバー<br/>allLimitedの帯（使い分けの切替は無い）"]
  Claude --> SlotView["HarnessAuthenticationView(slot)<br/>2ndは .../claude?slot=2nd"]
  SlotView --> View
  Row --> View["HarnessAuthenticationView<br/>StateObject HarnessAuthenticationFlow"]
  View --> Read["明示refresh / waitingの3秒poll"]
  View --> Start["必要時に警告確認→POST .../start"]
  View --> Respond["現行UI照合→POST .../input"]
  View --> Cancel["startedならやめる<br/>POST .../cancel → GET現在値"]
  Read --> Auth["flow.authへ適用<br/>authenticatedならstarted=false"]
  Start --> Auth
  Respond --> Auth
  Cancel --> Auth
```

[HarnessAuthenticationFlow](../../../../ios/BellBot/BellBot/Core/HarnessAuthenticationFlow.swift#L6)がauth/started/busy/needsRefresh/requestSequenceを所有する。Claudeの2ndアカウントはflowの`slot`で、GET・start・input・cancelのすべてに`?slot=2nd`を付ける（1stは付けず従来どおり）。アカウントの形・文言は[harness-accounts](../execution/harness-accounts.md)が正本で、表示は`Core/HarnessAccounts.swift`の`AccountText`（上限中 (HH:MMに解除)／Fableのみ上限中 (23:00に解除)／解除時刻不明、日本時間・今日以外は日付付き）。使い分けの規則・切替は無い（Owner裁定 2026-11-09）：1stが上限のモデルだけ2ndで動き、解除か上限でないモデルで1stへ戻るのは本体が決め、アプリは表示だけ。`rules`と`preferredSlot`は読まない。SSEの変化（eventRevision）でアカウントを読み直す。404は旧本体で従来の1行、それ以外の失敗は前に読めた行を残して理由を出し、2・4・8…秒（上限60秒）で読み直し続ける（「一覧を更新」は待たずに読む）。行の下に使用中のメンバーを名簿の名前で出す。メンバーのプロフィールのAI欄は、Bot項目に`account`がある時だけ「アカウント」行（いま動いているアカウント）を出す。Rowの失敗はunavailable（未認証とは表示しない）、認証失敗はrequireLogin。開始可否と警告はHarnessAuthenticationOptionのreloginSupported/startWarningと現在statusから決める。

- refreshはbusyならthrow。sequenceを進め、成功でneedsRefreshを消す。pollはbusy/needsRefresh中はreturnし、GET後に取消とsequenceを確認。古い成功/失敗は採用しない。
- start/respond/cancelはperformがbusyを立て、mutationでsequenceを進める。start応答でstartedを決定。respondは失敗でneedsRefreshを立て、明示更新まで操作を止める。
- cancelはPOST応答をauthへ直接適用せず、started=falseにした後GETをperformの戻り値にする。GETが失敗すると画面errorとなる。
- viewのpollingはactive・進行中の段階（`AuthenticationProgress.inProgress`：waitingSite/waitingCode/confirming。status=waitingでもstage=failedは失敗で読み直さない）・error無し・非busyだけ。view task/scene変更でpoll taskが取消され、inputはscene非active/auth変更/終了/run開始で消える。画面を閉じるだけではcancel POSTを呼ばない。
- 変更の結果不明はoperationFailureMessage。自動POST再送はない。公式のauthenticatedは取得応答の状態であり、AppleがCLIの認証を自ら判定した値ではない。

### 表示する認証の段階（状態機械）

一覧の行（`HarnessAuthenticationRow`・`ClaudeAccountsCard`の各slot行）と認証画面の状態文は、すべて`AuthenticationProgress`（`Core/AuthenticationProgress.swift`）1か所で決める。入力はサーバーの`GET /api/harness-auth/:harness[?slot=2nd]`の`auth`（`status`・`auth_ui.stage`・`session_id`・`message`）、Claudeのslotは`/api/accounts`の`signedOutAt`、画面ではコード送信中のローカル状態だけ。`/api/accounts`の`loggedIn`は段階の判定に使わない（期限切れの旧資格情報で真を返した実例 2026-11-11 20:0x JST：サーバーは`paste_code`で待っているのに行が「認証済み」）。

```mermaid
stateDiagram-v2
  [*] --> checking: 行・画面を開く（GET）
  checking --> unknown: GET失敗 / auth無し
  checking --> done: status=authenticated かつ signedOutAt無し
  checking --> needsLogin: status=blocked で公式認証が開いていない（session_id・auth_ui.binding とも無し）、または signedOutAt あり
  checking --> failed: status=failed、または stage=failed
  checking --> waitingSite: status=waiting（または開いているblocked）、stage=open_url / device_code / select
  checking --> waitingCode: status=waiting（または開いているblocked）、stage=paste_code
  checking --> confirming: status=waiting（または開いているblocked）、上以外のstage（waiting・complete・unavailable）
  needsLogin --> waitingCode: 「認証する」POST start
  done --> waitingCode: 「認証し直す」POST start
  failed --> waitingCode: 「認証し直す」POST start
  waitingSite --> waitingCode: 公式サイトで承認（3秒poll）
  waitingCode --> sendingCode: 「認証コードを送る」POST input（画面だけ）
  sendingCode --> confirming: 応答 status=waiting
  sendingCode --> done: 応答 status=authenticated
  sendingCode --> failed: 応答 status=failed
  sendingCode --> waitingCode: POST失敗（理由を表示、needsRefresh）
  confirming --> done: poll
  confirming --> failed: poll
  waitingSite --> checking: 「やめる」POST cancel → GET
  waitingCode --> checking: 「やめる」POST cancel → GET
```

未ログインのslot（Claudeの2つ目など）では、公式認証が進行中でもサーバーは`status=blocked`のまま`auth_ui`を返す。Web（`web/auth-flow.js`）と同じく、`session_id`か`auth_ui.binding`があるblockedは進行中として`auth_ui.stage`で段階を決める。

| 段階 | 行の札 | 行のボタン | 画面の状態文（`detail`） |
| --- | --- | --- | --- |
| checking | 確認中 | なし | 公式の状態を確認しています。 |
| unknown | 確認できません | なし（行を押すと画面で読み直す） | 状態を確認できませんでした。「状態を更新」で読み直してください。 |
| waitingSite | 認証の途中 | 続ける | まだ終わっていません。「公式サイトを開く」から公式サイトで認証してください。 |
| waitingCode | コード待ち | 続ける | まだ終わっていません。公式サイトに表示された認証コードを下に貼り付けて「認証コードを送る」を押してください。 |
| sendingCode | （画面のみ） | — | 認証コードを送っています。 |
| confirming | 確認中 | なし | 公式の応答を待っています。終わるまでこの画面で待ってください。 |
| done | 認証済み | なし（矢印だけ。入り直しは画面の中） | 認証済みです。画面では続けて「（N人が使用。）メンバーが認証の誤りで止まった時や、別のアカウントに替える時に認証し直します。」と控えめな「認証し直す」 |
| failed | 失敗 | 認証し直す | 認証できませんでした。理由：サーバーの`message`（無ければ「理由は返されませんでした。」） |
| needsLogin | ログインが必要 | 認証する | ログインし直してください。「認証する」から公式サイトで認証します。 |

- 行の主ボタン（紫の丸）は利用者の操作が要る段階（needsLogin・failed・waitingSite・waitingCode）だけ（Root review 2026-11-11 A）。Claudeの行はログインの札と別に、上限を1行（`AccountText.limitLine`：「上限中・11/13 17:00に戻ります（いまは2ndで動いています）」）、使用中は人数だけ。数はBot項目の`account`（本体の`transport.seatAccount`）で、そのslotで今動いているメンバーを数える（`AccountText.slotUsers`：「いま51人がこのアカウントで動いています」）。見出しの「N人が使用」（そのAIのメンバー）と1つ目・2つ目の和が一致する（Root 2026-11-12）。`/api/accounts`の`seats`は最後に起動した記録で、今は別のAIのメンバーも含むため数に使わない（どのBotにも`account`が無い旧本体だけ従来の「N人が使用」）。
- 札の色：done=緑、waitingSite/waitingCode/confirming=紫（進行中）、needsLogin/failed/unknown=橙、checking=灰。完了の見た目（緑・「認証済み」）は`done`だけ。
- 進行中の行（waitingSite/waitingCode/confirming）は、行も認証画面も同じ`inProgress`で、画面がactiveの間3秒ごとに読み直す。SSEの`eventRevision`でも読み直す。
- 認証画面：サーバーの`session_id`がある時は「やめる」を出し（ローカルの`started`と論理和。旧本体は`started`のみ）、開始ボタンの文を「最初からやり直す」にする。`session_id`が無く`stage=unavailable`の時（状態を見ただけ）はAitermの案内（`auth_ui`のtitle/message）を出さず、サーバーの`message`だけを出す。

### AIの本体（CLI）の入れる・入っていない状態（a451）

正本は[usage/harness-cli.md](../usage/harness-cli.md)。Appleは本体の言葉をそのまま出し、入っているかをクライアントで判定しない。`GET /api/harness-auth`の各項目の`install`（`state`・`version`・`source`・`busy`・`lastError`・`message`・`action`・`label`）を`CLIInstall`（`Core/CLIInstall.swift`）が読む。旧本体・読めない形は`install`なし（nil）として扱い、何も出さず何も読まない。

```mermaid
flowchart TD
  List["GET /api/harness-auth<br/>各AIのinstall"] --> Row["Row / Claudeカード<br/>HarnessInstallFlow"]
  Row --> Sec["CLIInstallSection<br/>message そのまま・actionがinstallなら「最新版を入れる」"]
  Sec -->|押す| Post["POST /api/harness-auth/:id/install<br/>空body、本体が{harness, install}を返す"]
  Post --> Poll["busy / checking の間 3秒ごと GET .../install"]
  Row --> Badge["Badge: install.isMissing なら認証GETを送らない<br/>札は未インストール / 入れています / 入れられません"]
  Poll -->|installed| Auth["認証画面を読む（GET /api/harness-auth/:id）"]
  Home["設定ホーム loadAI"] -->|isMissing| Attn["要対応に数える（not_installed・failed）<br/>Claudeは1件にまとめる"]
  Setup["初回 /api/setup<br/>install（選んだAI）"] -->|isMissing or busy| SetupBtn["本体の文と「最新版を入れる」<br/>POST /api/setup/install → setup応答を3秒poll"]
  Editor["Botエディタ AI欄"] -->|GET /api/harness-auth| Notice["isMissing の時 install.message（保存は止めない）"]
```

- `state`は`checking | installed | not_installed | installing | failed`。`isMissing`は`not_installed | installing | failed`で、本体はこの間`start`/`status`を409 `HARNESS_NOT_INSTALLED`で断る。Appleは断られる前にログインを読まず、段階は`AuthenticationProgress.notInstalled(CLIInstall)`（札・状態文は`install.message`）で出す。`installed`の更新中（`busy`）や`lastError`は段階を変えず、行の文と「最新版を入れる」だけが変わる。
- 行・Claudeカード（1回だけ）・各AIの画面（セクション「インストール」）に同じ`CLIInstallSection`を出す。未インストールの画面は、ログインの節の代わりにこのセクションだけを出す。押した結果の失敗は押したボタンの下に出す。押下は自動再送しない。
- 要対応：`not_installed`と`failed`を数え（行は「<AI>がまだ入っていません」「<AI>を入れられませんでした」、押すとそのAIの画面）、`installing`は数えない。入っていないClaudeはslotごとでなく1件。
- 初回：`GET /api/setup`の`install`が`isMissing`か`busy`の間、認証の文・入力欄の代わりに本体の文とボタンを出す。`POST /api/setup/install`の応答（setup全体）をそのまま採り、`needsPolling`の間3秒ごとに`GET /api/setup`を読む（ログインは本体が始める）。
- Botエディタ：`GET /api/harness-auth`の`install`が`isMissing`の時だけ、選んだAIの下にその文と「設定の「AIの認証」で入れられます。」を出す。保存は止めない。読めなくても診断に送るだけで画面は変えない。

## 整理候補

- **A-R1**：`ios/BellBot/BellBot/Views/SecretRequestView.swift:97,98,105`。AI利用許可判定のcatchはerror表示とreturnで、後続の秘密POSTのcatchだけがrequireLoginへ接続する。
- **A-R2**：`ios/BellBot/BellBot/Core/AppStore.swift:337,363`と`ios/BellBot/BellBot/Core/HarnessAuthenticationFlow.swift:29,55`。初回認証と再認証は、それぞれ読取順序・変更中状態・入力失敗後の明示更新待ちを保持している。

## 未調査

- route受信後の質問配送、秘密保存/AI通知、Access、初回案内、公式認証端末の内部。
- Web認証の実遷移、scene/閉じる/通信中操作の実行時挙動。ビルド・試験未実行。
- Mermaidの描画結果。
