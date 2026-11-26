# Owner規範と起動指示

[担当の正本](README.md)。全製品共通テンプレートは[integration](../integration/README.md)、席での実書込みは[runtime](../runtime/README.md)の公開窓口を使う。

```mermaid
flowchart TD
  Http["HTTP認証"] --> Owner["members.owner-http<br/>Owner profile / user-rules"]
  Read["通常MCPの2読取"] --> Member["members.profiles-mcp"]
  BotWrite["通常MCP update_user_rules<br/>text"] --> BotSave["profiles-mcp: before=現在値, after=正規化text<br/>→ members rules.botUpdate actor=bot, before固定<br/>（instructionは呼出Botの直接会話の最新Owner発言、有れば）"]
  BotSave -->|"現在値≠before"| Changed["USER_RULES_CHANGED 409<br/>読み直して出し直す"]
  Dedicated["登録された専用owner MCP"] --> Rules["mcp-owner-tools<br/>全文update_user_rules"]
  Owner --> Save["OwnerProfile/UserRulesへ保存<br/>rules.update actor=owner"]
  Rules --> Save
  BotSave --> Save
  Member -->|"読取のみ"| Data["owner/profile.json<br/>owner/user-rules.md"]
  Save -->|"本文が変わった時だけ先に追記"| History["owner/user-rules-history.jsonl<br/>at/actor/instruction/before/after"]
  Save --> Data
  History --> HistoryApi["GET /api/user-rules/history<br/>rules.history 新しい順50件"]
  BotSave -->|"保存後"| Notice["呼出Botからユーザーへの直接会話に<br/>自動記録: 誰/時刻/根拠/差分"]
  Save --> Refresh["refreshGlobalInstructions"]
  Generation["新members世代の初回owner.read<br/>候補の準備確認、利用可能の公開前"] --> Refresh
  Common["integration所有<br/>common-agents.md"] --> Refresh
  Data --> Refresh
  Refresh --> Write["Owner情報→個別規範→製品規範<br/>members global.writeInstructions（唯一のwriter、bd14 E4）"]
  Write --> Globals["home下4CLI（.claude/.codex/.grok/.cursor）のAGENTS<br/>全文そのまま。次の通常指示読込から"]
  Refresh -->|"失敗"| Failure["生成失敗を返す<br/>既保存は残る"]
  Refresh -->|"世代起動時の失敗"| Diagnostic["初回だけdiagnostic MEMBERS_GLOBAL_INSTRUCTIONS_FAILED<br/>owner.readは成功、次のowner.readで再試行"]
```

## 本人編集の個別指示と生成AGENTS

```mermaid
flowchart LR
  Profile[プロフィール・短期記憶] --> Render[既renderBotInstructions]
  Position["profile.position に「統括」を含む"] -->|"含む席だけ"| Coord["役割節の直後に統括節1つ<br/>assign-owner/SKILL.md に従う1行"]
  Coord --> Render
  Local["各席 AGENTS.local.md<br/>本人編集の永続正本"] --> Compose[席writerで読取・合成]
  Render --> Compose
  Compose --> Agents[生成AGENTS.md]
  Agents --> CLI[各CLIの既project指示読込]
  Claude["CLAUDE.md = @AGENTS.md"] --> Agents
```

正本は `/srv/bellteam/bots/<bot-id>/AGENTS.local.md`。これは全席が任意に使える個別指示で、生成処理が作成・編集するファイルではない。本人と正規の設置担当はこのファイルを保存し、次の起動準備又は既プロフィール更新から再生成する。roleへ本文を入れず、生成AGENTS/CLAUDEを直接編集しない。

保存直後の再生成には既MCP `update_self({})`、設置担当は `update_bot({botId})` を使える。これはプロフィールへの追加fieldや新権限ではなく、既プロフィール保存から指示生成を呼ぶ操作である。正本の保存だけでは実行中CLIの既読込済みcontextを変更しない。CLIが次に起動指示を読む時から反映される。生成本文には正本の内容を短期記憶より前に置き、短期記憶を更新しても正本を削除しない。

`ProjectFiles.writeInstructions` と `operateMembersProject` のwriteInstructions/prepareStartupContextが、既プロフィール・短期記憶の生成本文に個別正本を合成する。正本無し/空は既本文を維持、改定は次の再生成で読む。プロフィール変更・harness変更・短期記憶更新も正本を書き換えず、CLAUDEは既参照一行を維持する。固定pathの通常ファイルだけを読み、symlink/所有者不一致/読取中変化等は生成AGENTSを書き換える前に拒否する。失敗を個別指示無しの成功へ丸めない。

CLI固有のAGENTS.overrideやCLAUDE.localに依存しない。個別指示は生成AGENTS本文として届き、各CLIの既読込経路と制限に従う。教本等の内容・改訂判断・責任境界を生成機構が決定しない。個別正本を削除又は空にした後の再生成で追加本文を除去できる。

### 統括席の担当割り当て節（Owner 2026-11-26「やってみて。君のおすすめで」）

`renderBotInstructions`は、`profile.position`に「統括」を含む席の生成AGENTSにだけ、自分の`## 役割`節の直後（`# 作業手順`の前）へ短い節`# 統括の担当割り当て`を1つ入れる。内容は1行: 仕事や裁定の担当（誰の工程か）を割り当てる・割り当て直す前に`/srv/bellteam/shared/tools/assign-owner/SKILL.md`に従う。統括でない席の生成本文は従来とバイト単位で同じ。判定は生成の都度のprofile.positionだけで、新しい統括席にも自動で付く。入力・保存場所・公開窓口・失敗契約は変えない（純関数の本文だけ）。手順本文の中身（SKILL.md）はassign-ownerの所有で、ここへ複製しない。`composeProjectInstructions`（`src/project-instructions.mjs`、`AGENTS.local.md`の合成）はこの経路の合成段で、2026-11-26からmembersのsource一覧に載せる。

## Ownerプロフィールと規範

`OwnerProfile.get/update`が`owner/profile.json`、`UserRules.get/update/history`が`owner/user-rules.md`と`owner/user-rules-history.jsonl`を所有する。HTTPの更新、通常MCPのBot更新と別owner MCPは、保存後に`refreshGlobalInstructions`を呼ぶ。`createGlobalInstructionsRefresher`はOwner情報→ユーザー規範→製品規範の順に生成して、`writeGlobalInstructions`または席proxyに渡す。Bot個別のAGENTS生成とは別責任である。全製品共通テンプレート`config/common-agents.md`は統合担当が所有し、membersは生成経路へ渡された本文を使う。

### 全文共通指示の有効template

共通規範の正本は`config/common-agents.md`一か所。全文を`renderGlobalInstructions`が各CLIのglobal指示へ組み立て、membersの`global.writeInstructions`（`members-project-files.mjs`）だけが既存4つの指示ファイルへ保存する。Antigravityは2026-11-17のa353でハーネスから外し、`.gemini`は書かない（24,000 B分割は削除。コードは`archive/antigravity-harness-20261117`）。4CLIは全文を1ファイルのまま書く。どれも0600、同じwriter（O_NOFOLLOW・所有者・単一リンクの確認）。本体の旧writer（`global-instructions.mjs`のrefresher、bootstrap起動時の書込み、席の`global-instructions`操作）は2026-11-14 bd14 E4で削除した（Belota合意）。モデル運用の規範（旧`SECTION models`）はユーザー規範が持ち（2026-11-15 オーナー裁定）、共通規範には置かない。通常dispatch/steer本文へ規範を再付記しない。通常配送は元の入力本文を維持する。別段落やUserRulesに規範を複製しない。背景agentの実行・入力束縛・要約投影はexecution、設定保存はusage、共通組立はintegrationが所有する。既API/handler/DTO/TTLはこの差分では変えない。

供給にはbuiltinの`package-server.mjs`収録config、members artifactの本文生成用config、executionの`EXECUTION_FILES`収録configを従来どおり同じSHAへ揃える。前者のglobal helperとmembers dispatcherは各配置内のtemplateを読み、execution artifactは既署名版との互換性のためassetを保持するが、新しいdispatchでは読み込まない。stateのUserRules更新だけではこのtemplateは変わらない。module導入で配置のtemplateが変わった時は、新世代の初回owner.readでglobal指示へ反映する。採用mainからの通常image又は既公開moduleの反映単位・供給順はintegration/distribution/runtimeの既条件に従う。

全文の正規生成契機はbootstrapのglobal refresher、正規Owner/UserRules保存後のmembers `writeGlobal`、又は新members世代の初回`owner.read`。どれも`global.writeInstructions`→runtime writerへ渡す。initialize/resumeはleaseを持たずeffectを出せないため、世代起動の生成は親が全世代へ必ず送る準備確認`owner.read`（lease付き）の中で世代ごとに1回だけ行う。これでmembers module導入時に、その配置のtemplateで5CLIのglobal指示が本体交換なしに更新され、本体再起動時もbootstrapのbuiltin版の後に採用版templateが上書きする。生成失敗でもowner.readは成功させ、membersを止めない。成功するまで同世代の次のowner.readで再試行し、diagnosticは世代ごと最初の1件だけ出す。各owner.readは自分のcontextで生成を1回ずつ直列に試み、成功済みの世代では書かない。read pinのowner.readが準備確認より先や同時に来た時、親がそのeffectを拒否する（MEMBERS_EFFECT_UNSUPPORTED）のは異常として報告せず、待っているlease付き読取は他の試行の結果を流用せず自分のleaseで生成する。Owner/UserRules保存も従来どおり再生成する。members initializeのrestore/projection、個別profileやAGENTS.local再生成だけをglobal生成と扱わない。生成した全文は各CLIの次の通常指示読込から使う。配送本文は呼出元の原文を維持し、既配送本文/既読込contextの遡及更新や、nativeによる初回tool順序強制は行わない。

### Candidate probe and rollback ordering

The active members assembly uses `src/members-process.mjs` (`members-assembly.mjs`), not the generic module controller. Its replacement flow exits the old child, launches the candidate, saves the adoption record, then resumes the candidate and probes `owner.read`. The generation render therefore runs before the caller receives successful replacement/availability ACK, but after durable candidate selection. A render failure alone still returns a successful `owner.read` and retries on a later read.

```mermaid
flowchart TD
  Old[Old child quiesced] --> Exit[Exit old OS process]
  Exit --> New[Launch candidate and receive READY]
  New --> Adopt[Save candidate adoption record]
  Adopt --> Probe[Resume and probe owner.read]
  Probe --> Render[Render candidate template for five CLIs]
  Render --> Available[Publish availability and successful replacement ACK]
  Probe -->|Probe failure| Recover[Keep candidate selected; lifecycle recovery]
  New -->|Other replacement failure| Restart[Launch fresh old-version child]
  Adopt -->|Other replacement failure| Restart
  Restart --> OldProbe[Old child resumes and probes owner.read]
```

A failed probe takes lifecycle recovery without old-version rollback. Other rollback errors after old-process exit launch a fresh old-version child; they never reuse the previously rendered child. That fresh child renders its own template on its first probe if its version includes this refresh hook. Restoring a pre-hook version cannot promise automatic refresh: candidate global files may remain until an Owner/UserRules save, another generation with the hook, or body bootstrap refreshes them. Only drain/preparation failure before candidate launch reuses the same old child, and then no candidate render has occurred. Sources: `members-process.mjs` replacement/resume and `members/dispatcher.mjs` generation refresh. The parent continues to issue only the documented `owner.read`; no parent change is needed (Molly, 2026-11-08).

Webの`createOwnerEditor.save`はprofile PATCH→rules PUTの順であり、一括transactionではない。後段に失敗した時にも前段の保存は残り得る。指示生成失敗も、正本保存の失敗と同じ意味にはしない。[owner-profile.mjs](../../../../src/owner-profile.mjs)、[user-rules.mjs](../../../../src/user-rules.mjs)、[global-instructions.mjs](../../../../src/global-instructions.mjs)を参照。

## 公開handlerと境界

`members/owner-http.mjs:createOwnerApi({ownerProfile,userRules})`（保存後の指示の作り直しはmembers側の保存が行う）はGET/PATCH /api/owner、GET /api/owner/avatar、GET/PUT /api/user-rules、GET /api/user-rules/historyを所有する。createApplicationApiはこの窓口と既conversation assetsを接続する。全経路/status/返却と画像整形を維持する。

通常MCPはprofiles-mcpのget_owner_profile/get_user_rulesの読取と、ユーザーの明示指示がある時だけの`update_user_rules`（Owner 2026-11-10、Trony経由）。専用`mcp-owner-tools.mjs`のownerTools/callOwnerToolは従来どおり残す。本文の型/長さ/余分key検証を保持し、権限を役職の文字列へ置換しない。

### Botによるユーザー規範の更新（呼出しで即保存）

- 入力: `update_user_rules({text})`。textは全文置換（20,000字まで）。Botはユーザーが直接会話で自分の言葉で頼んだ時だけ呼ぶ（common-agents RULE owner.rules-write）。
- 承認の手順は無い（2026-11-15 Owner命令 a150: 「規範変更を承認 097FB429 とか言わないと直してくれない…障害」）。承認の言葉・確認コード・24時間の窓・承認依頼の通知・Owner発言が無い時の拒否は全部撤去した。Ownerは保存ごとの自動記録（差分付き）と履歴で見て、戻したければHTTP/Botで戻す。
- 引用: 呼出元`from`（ingressが決めたBot ID）の直接会話timelineで最新の`kind=message, direction=outgoing`発言（空でない、`messageAuthor`が無いか`kind=user`）があれば、履歴の`instruction`と自動記録に載せる。無ければ載せずに保存する。`direction=outgoing`はconversationの`from=user`行で、Botには書けない（conversation/authority.mjs、mcp-schema.mjs）。
- 拒否: 読んだ後に本文が変わった保存（`USER_RULES_CHANGED`、既存状態の上書き防止。self-exit: 読み直して出し直す）と、20,000字超（`USER_RULES_INVALID`）だけ。
- 保存: members `rules.botUpdate {text, before, botId, instruction?:{messageId,at,quote}}`（ownerWrite不要）→ Owner保存と同じ直列化の中で、現在値が`before`と違えば`USER_RULES_CHANGED`(409)で書かない → 保存・`refreshGlobalInstructions`。結果は`{text, changed: true, ownerNotice}`。
- Ownerへの見え方: 本文が変わった保存は、Owner/Botどちらも`owner/user-rules-history.jsonl`に`{schema:'bellteam.user-rules-change.v1', at, actor:{kind:'owner'}|{kind:'bot',botId}, instruction?, before, after}`を追記し、`GET /api/user-rules/history`（members `rules.history`、lease付き読取）が新しい順50件を`{changes}`で返す。Botの保存後は、そのBotからユーザーへの直接会話に、Bot名・JST時刻・直前のOwner発言（有れば）・行差分の自動記録を送る。Web/Apple/Windowsはクライアント変更なしで会話として見える。通知の失敗は保存を取り消さず、結果の`ownerNotice.delivered=false`で返す。
- 差分の計算（`userRulesDiff`）: 共通の先頭・末尾行を除き、残りの行数の積が100万以下の時だけLCS（Uint16、最大2MB）を使う。超える時は残りの旧行を全部`- `、新行を全部`+ `で並べる。どちらも変更の全体を示し、時間とメモリは入力20,000字に比例して収まる。

どちらの更新も正本保存→指示再生成の順。生成失敗時は元の例外を伝え、保存済みprofile/rulesを消したり成功へ変えたりしない。通常MCPの応答整形、共通認証とエラー変換はintegration。全製品共通テンプレートの変更をmembers内部で行わない。

専用Owner schema/handlerは既に1機能のfileなので移動せずmembersのsource所有を登録した。Ownerの現在値やユーザー規範本文はこの図へ複製しない。global-instructions/ProjectFiles/runtimeの既export・writerを変更せず、直接のOwner/rules/生成/MCP/HTTP試験を確認する。

## 現行の専用owner MCPのwriter

`src/mcp-owner-server.mjs`は独立したstdio入口で、OwnerProfile/UserRulesとglobal refresherを自身で生成する。通常bootstrapとは別実体で同じ正本を書き得る。独立更新では専用権限を保つproxyへ接続してwriterを一本化する必要がある。[契約入力](module-update.md)に初回の変更範囲を記した。現行sourceで既に一本化済みとはしない。

## Common-rules DSL prefix (Owner 2026-11-07)

Function: integration owns the verbatim DSL prefix in config/common-agents.md. DFD: unchanged rendered Owner/user prefix + full common template → existing five CLI global writers. Model usage lives in the user rules (Owner ruling 2026-11-15), so the common template has no `SECTION models`; execution forwards the caller's original message text without a `bellteam_task_settings` suffix. members/dispatcher and members/instructions pass the template through without heading parsing. Root’s fixed communication-through-Japanese-preamble DSL is copied verbatim; the original English Ponytail body remains byte-identical. No endpoint, write location or runtime policy parser is introduced.

Root final content decision supersedes the initial prefix-only constraint: the two canonical fenced DSL blocks form the common policy, followed by the original English Ponytail text. Both fenced blocks and the pass-through renderer/writers are unchanged; only execution's duplicate per-delivery suffix is removed.
