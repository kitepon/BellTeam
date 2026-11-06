# Owner規範と起動指示

[担当の正本](README.md)。全製品共通テンプレートは[integration](../integration/README.md)、席での実書込みは[runtime](../runtime/README.md)の公開窓口を使う。

```mermaid
flowchart TD
  Http["HTTP認証"] --> Owner["members.owner-http<br/>Owner profile / user-rules"]
  Read["通常MCPの2読取"] --> Member["members.profiles-mcp"]
  Dedicated["登録された専用owner MCP"] --> Rules["mcp-owner-tools<br/>全文update_user_rules"]
  Owner --> Save["OwnerProfile/UserRulesへ保存"]
  Rules --> Save
  Member -->|"読取のみ"| Data["owner/profile.json<br/>owner/user-rules.md"]
  Save --> Data
  Save --> Refresh["refreshGlobalInstructions"]
  Common["integration所有<br/>common-agents.md"] --> Refresh
  Common -->|"主agentの要約記述・呼出義務なし"| Reminder["execution: taskSettingsReminder<br/>SECTION models block"]
  Reminder --> Dispatch["通常dispatch / steer<br/>bellteam_task_settings付記"]
  Data --> Refresh
  Refresh --> Write["Owner情報→個別規範→製品規範<br/>runtime公開writerへ"]
  Write --> Globals["home下5CLIのAGENTS<br/>次の通常指示読込から"]
  Refresh -->|"失敗"| Failure["生成失敗を返す<br/>既保存は残る"]
```

## 本人編集の個別指示と生成AGENTS

```mermaid
flowchart LR
  Profile[プロフィール・短期記憶] --> Render[既renderBotInstructions]
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

## Ownerプロフィールと規範

`OwnerProfile.get/update`が`owner/profile.json`、`UserRules.get/update`が`owner/user-rules.md`を所有する。HTTPの更新と別owner MCPは、保存後に`refreshGlobalInstructions`を呼ぶ。`createGlobalInstructionsRefresher`はOwner情報→ユーザー規範→製品規範の順に生成して、`writeGlobalInstructions`または席proxyに渡す。Bot個別のAGENTS生成とは別責任である。全製品共通テンプレート`config/common-agents.md`は統合担当が所有し、membersは生成経路へ渡された本文を使う。

### 全文と配送付記の有効template

共通規範の正本は`config/common-agents.md`一か所。`taskSettingsReminder` reads the canonical `SECTION models` heading and body through the next blank line on every dispatch.Owner最新指示「メインagentには要約を書かせない」に従い、旧186Bの本人要約記述・`update_work_summary`呼出義務を撤去する。The full global instructions and delivery reminder carry the same canonical models block.別段落やUserRulesに複製して付記の代用にしない。通常Ownerchat/sendmessage/返信対象room/prompt予定は同dispatchへ到達し、setupTestは付記除外、command予定はAI配送なし。背景agentの実行・入力束縛・要約投影はexecution、設定保存はusage、共通組立はintegrationが所有する。その完成を本撤去の条件にせず、既API/handler/DTO/TTLはこの差分では変えない。

供給にはbuiltinの`package-server.mjs`収録config、members artifactの本文生成用config、executionの`EXECUTION_FILES`収録configの有効世代を同じSHAへ合わせる。前者のglobal helperとmembers dispatcherは各配置内のtemplateを読み、後者も自分の配置内のtemplateを読む。stateのUserRules更新だけではこのtemplateは変わらない。採用mainからの通常image又は既公開moduleの反映単位・供給順はintegration/distribution/runtimeの既条件に従う。

全文の正規生成契機はbootstrapのglobal refresher、又は正規Owner/UserRules保存後のmembers `writeGlobal`→`global.writeInstructions`→runtime writer。members initializeのrestore/projection、個別profileやAGENTS.local再生成だけをglobal生成と扱わない。生成した全文は各CLIの次の通常指示読込から、付記は有効template反映後の次dispatchから使う。既配送本文/既読込contextの遡及更新や、nativeによる初回tool順序強制はこの規範変更に含めない。

Webの`createOwnerEditor.save`はprofile PATCH→rules PUTの順であり、一括transactionではない。後段に失敗した時にも前段の保存は残り得る。指示生成失敗も、正本保存の失敗と同じ意味にはしない。[owner-profile.mjs](../../../../src/owner-profile.mjs)、[user-rules.mjs](../../../../src/user-rules.mjs)、[global-instructions.mjs](../../../../src/global-instructions.mjs)を参照。

## 公開handlerと境界

`members/owner-http.mjs:createOwnerApi({ownerProfile,userRules,refreshGlobalInstructions})`はGET/PATCH /api/owner、GET /api/owner/avatar、GET/PUT /api/user-rulesを所有する。createApplicationApiはこの窓口と既conversation assetsを接続する。全経路/status/返却と画像整形を維持する。

通常MCPはprofiles-mcpのget_owner_profile/get_user_rulesによる読取だけ。全文更新は既`mcp-owner-tools.mjs`の専用ownerTools/callOwnerToolへ登録済みの席だけが行い、共通MCPへ新しい更新道具を足さない。登録された席の本人性・公開入口は既設定に従う。本文の型/長さ/余分key検証を保持し、権限を役職の文字列へ置換しない。

どちらの更新も正本保存→指示再生成の順。生成失敗時は元の例外を伝え、保存済みprofile/rulesを消したり成功へ変えたりしない。通常MCPの応答整形、共通認証とエラー変換はintegration。全製品共通テンプレートの変更をmembers内部で行わない。

専用Owner schema/handlerは既に1機能のfileなので移動せずmembersのsource所有を登録した。Ownerの現在値やユーザー規範本文はこの図へ複製しない。global-instructions/ProjectFiles/runtimeの既export・writerを変更せず、直接のOwner/rules/生成/MCP/HTTP試験を確認する。

## 現行の専用owner MCPのwriter

`src/mcp-owner-server.mjs`は独立したstdio入口で、OwnerProfile/UserRulesとglobal refresherを自身で生成する。通常bootstrapとは別実体で同じ正本を書き得る。独立更新では専用権限を保つproxyへ接続してwriterを一本化する必要がある。[契約入力](module-update.md)に初回の変更範囲を記した。現行sourceで既に一本化済みとはしない。

## Common-rules DSL prefix (Owner 2026-11-07)

Function: integration owns the verbatim DSL prefix in config/common-agents.md; taskSettingsReminder selects SECTION models through its next blank line. DFD: unchanged rendered Owner/user prefix + full common template → existing five CLI global writers; canonical models block → existing bellteam_task_settings delivery suffix. members/dispatcher and members/instructions pass the template through without heading parsing. The existing communication-and-later tail remains byte-identical pending Root’s separately delegated content decision. No new endpoint, write location or runtime policy parser is introduced.
