# BellTeam 記憶基盤 実装計画

## 1. 目的

BellTeamの各Botが、セッションをリセットしても会話の続きを理解し、長期的な事実、関係、思い出、成長、個人知識を保てるようにする。

会話継続にはThroughlineを使い、Project Bellの長期記憶思想と、dotagentsの知識フォルダ構成、Caveatの登録・検索方式を組み合わせる。AIがSkillを呼んだ時だけ動く仕組みにはせず、通常の会話とセッション再起動の経路へ組み込む。

## 2. 成功条件

1. 日々の会話がThroughlineへ自動記録される。
2. セッション再起動時に、直近会話を引き継いで自然に会話を続けられる。
3. 事実、好み、方針、関係、出来事、思い出、成長が長期記憶として残る。
4. 個人RAGと共通RAGへ知識を登録し、必要な時に検索できる。
5. 指定がなければ個人記憶へ保存し、明示指定またはシステム全体の内容だけを共通領域へ保存する。
6. Bot Aの個人記憶がBot Bの検索、要約、引き継ぎ、再起動後コンテキストへ混入しない。
7. Codex、Claude、Grok、Cursorで、表面上は同じ再起動操作を使える。
8. UIとMCPのどちらから行っても同じ記憶状態になる。

## 3. 全体構成

記憶を三種類に分ける。保存場所と用途を混ぜない。

### 3.1 会話継続記憶 — Throughline

- 各ターンのuser、assistant、tool、thinking、画像参照を記録する。
- L2として直近会話を保持する。
- L1として古い会話を要約する。
- L3として詳細を参照できるようにする。
- セッション終了時に引き継ぎを生成する。
- 新セッションへハーネス別に復元する。

Throughlineは日々の会話記録から引き継ぎまでを所有する。Skillは手動検索や状態確認の補助であり、自動記録と自動復元の発動条件にはしない。

### 3.2 長期記憶 — Project Bellの思想を継承

次の種類を持つ。

- `fact`: 事実
- `preference`: 好み
- `policy`: 方針
- `task`: 継続中の仕事
- `config`: 設定
- `incident`: 重要な出来事
- `relationship`: 人やBotとの関係
- `episode`: 人格形成に残す思い出
- `growth`: 経験から得た成長

単なる会話要約ではなく、根拠となった会話や出来事を保持する。現在の自己認識、重要な思い出、成長は通常の事実と区別する。

Project Bellの`raw_events → assertions → evidence`を出発点にする。現行Bellにある全機能を一括移植せず、BellTeamに必要な保存、検索、整理、引き継ぎから順に実装する。

### 3.3 知識検索 — 個人RAGと共通RAG

調査結果、手順書、外部仕様、製品固有知識、再利用する設計判断を扱う。

Markdownを正本とし、SQLite FTSを再構築可能な検索索引にする。登録時にMarkdown保存と索引更新を同時に行う。これはCaveatの「Gitで読める正本 + 即時検索できる派生DB」の方式を使う。

dotagentsからは、`raw/`と整理済み文書の分離、出典、取得日、確度、INDEXという知識寿命の考え方を引き継ぐ。`INDEX.md`と`rg`だけを検索本線にはしない。

## 4. 責務分担

### Throughline

- 会話ターンを自動捕捉する。
- Botの会話セッションを一つの継続系列として扱う。
- L1/L2/L3を保存・検索する。
- 引き継ぎパケットを構築する。
- Codex、Claude、Grok、Cursorへ、それぞれの正規方式で引き継ぎを復元する。
- 外部の長期記憶・RAGから渡された補足コンテキストを、引き継ぎパケットへ構造化して含める。

### BellTeam

- Bot ID、名前、人格、役割、プロジェクト、ハーネスを管理する。
- どのBotの記憶として処理するかを決める。
- セッションをいつ再起動するか決める。
- 長期記憶とRAGの個人領域・共通領域を管理する。
- Throughlineの公開CLIまたはJSON契約だけを使い、Throughline DBを直接操作しない。

### Aiterm

- CLIと永続PTYの起動、停止、入出力を扱う。
- 記憶の選択、要約、保存、検索、復元方法を決めない。

### SkillとMCP

- SkillはAI向けの使い方と判断基準を提供する。
- MCPは記憶とRAGの登録、検索、セッション再起動の機械的な入口を提供する。
- 自動記録と自動復元は、SkillやAIの呼び忘れに依存しない。

## 5. 保存領域

### 5.1 Bot個人領域

各Botプロジェクトの中へ置く。

```text
/srv/bellteam/bots/<bot-id>/
├── bot.json
├── memory/
│   └── memory.db
└── rag/
    ├── INDEX.md
    ├── raw/
    ├── notes/
    └── index.db
```

- `memory.db`は長期記憶の正本。
- `rag/**/*.md`はRAG文書の正本。
- `rag/index.db`はMarkdownから再構築できる検索索引。
- Throughlineの会話DBはThroughline自身が所有し、BellTeamのBotフォルダへ複製しない。

### 5.2 共通領域

```text
/srv/bellteam/shared/
├── memory/
│   └── memory.db
└── rag/
    ├── INDEX.md
    ├── raw/
    ├── notes/
    └── index.db
```

個人領域と共通領域は別DB、別RAGとして扱う。一つのレコードを両方へ重複保存しない。

### 5.3 保存先の既定

- 指定なし: 呼び出したBotの個人領域
- `scope=shared`の明示指定: 共通領域
- システム全体の規範・構成・全Bot共通の知識: AIが共通領域を選べる
- 判断できない場合: 個人領域

個人検索から共通検索へ暗黙に範囲を広げない。両方必要な処理は、呼び出し側が個人と共通を明示して二つの結果を受け取る。

## 6. Bot間・プロジェクト間の分離

### 6.1 確認する現行Throughline契約

Throughlineは一つのグローバルSQLiteへ複数プロジェクトを保存し、`sessions.project_path`、`session_id`、`origin_session_id`で所有関係を表している。次の全経路が同じ分離境界を守るか、実装前に確認する。

- セッション作成とhost capture
- 最新セッションの選択
- L1要約対象の選択
- L2 recall
- L3 detail
- Claude batonとpending handoff
- `handoff-context`
- Codex resumeと新thread handoff
- Grok continue
- Cursor `additional_context`

### 6.2 分離のfocused test

同じ一時Throughline DBへ、Bot A用プロジェクトとBot B用プロジェクトを登録する。

- Aだけに固有文字列`A_PRIVATE_MEMORY`を記録する。
- Bだけに固有文字列`B_PRIVATE_MEMORY`を記録する。
- 同じ単語、同じ時刻帯、同じハーネスの通常会話も両方へ記録する。
- AのL1/L2/L3、recall、detail、handoff、再起動コンテキストに`B_PRIVATE_MEMORY`が無いことを確認する。
- Bについて逆方向も確認する。
- 共通領域へ明示保存した`SHARED_MEMORY`だけが、共通検索を指定した時に取得できることを確認する。

保存場所だけでなく、検索結果と最終注入文字列まで検査する。

### 6.3 分離方法の決定条件

既存`project_path`境界が全経路で成立すれば、その仕組みを維持する。成立しない経路だけを根治する。

プロジェクト移動、同一パス再利用、host sessionの誤関連により所有者が曖昧になることが実測された場合だけ、Throughlineへ安定した`scope_id`を追加する。必要性を確認せず新しい識別層を増やさない。

## 7. セッション再起動

再起動は次の一連の処理として扱う。

1. BellTeamが対象Botを再起動待ちにする。
2. 現在ターンの確定回答までThroughlineへ記録する。
3. Throughlineが直近会話の引き継ぎを生成する。
4. 長期記憶から現在の自己認識、重要な関係、未完了タスク、固定された思い出を選ぶ。
5. 必要な個人RAGと共通RAGを検索する。
6. Throughlineが会話継続、長期記憶、RAG参照を一つの引き継ぎパケットへまとめる。
7. Aitermが旧セッションを閉じ、新セッションを起動する。
8. Throughlineがハーネス固有の方法でパケットを復元する。
9. 新セッションをBellTeamの同じBotへ関連付ける。

再起動時に毎回すべての長期記憶を投入しない。現在の人格、重要な思い出、直近の仕事、今回の会話に関係する記憶だけを選ぶ。

自動再起動は、毎日03:00（Asia/Tokyo）にBellTeam schedulerが全Botを確認し、Throughline公開Observerが現在セッションに20完了ターン以上を返した休止中のBotだけへ行う。処理中、待機中、停止中のBotはその夜の対象から外す。20はThroughlineが完全な本文を保持する直近窓と同じ境界であり、四ハーネスの本番セッションでは2完了ターン時点の引き継ぎ文が1,827〜7,037文字に収まることを確認した。

## 8. 長期記憶の整理

### 第一段階

- 完了した会話ターンを`raw_events`として参照できる。
- AIが明示的に記憶を登録できる。
- `assertions`と`evidence`を保存・検索できる。
- `episode`と`growth`を通常事実と分けて保存できる。

### 第二段階

- Throughlineの直近窓から外れた会話を対象に、長期記憶候補を抽出する。
- 既存記憶との重複、更新、矛盾を整理する。
- 重要なepisodeを固定し、それ以外をgrowthへ統合する。
- セッション再起動前に、必要な場合だけ整理を実行する。

### 第三段階

- 現在の自己認識を更新する。
- 長期間の出来事から人格形成に必要な思い出を維持する。
- Bot自身が自分の記憶を検索、訂正、整理できるMCPを提供する。

第一段階の成立前に自動Reflectionを入れない。保存と検索が実測できてから整理を自動化する。

## 9. RAG

### 登録

RAG登録は次を一回の処理で行う。

1. scopeを個人または共通に決める。
2. Markdownへ本文とメタデータを保存する。
3. `INDEX.md`を更新する。
4. 同じ文書をSQLite FTSへ即時反映する。

最低限のメタデータは、ID、タイトル、出典、取得日または作成日、確度、tags、本文とする。

### 検索

- 個人RAG検索と共通RAG検索を別の引数で行う。
- 文字列検索を最初の本線にする。
- 日本語の短い語でも検索できることをfocused testで確認する。
- ベクトル検索やrerankerは、文字列検索で実在する不足が確認された後に追加する。
- 検索結果には文書ID、タイトル、該当箇所、scopeを返す。

## 10. MCP

コンテナ内へグローバル設定するBellTeam MCPに、最小限次の操作を追加する。

```text
remember(content, kind?, scope?)
recall_memory(query, scope?)
list_memory_candidates(limit?)
organize_memory_candidate(candidateId, memories)
dismiss_memory_candidate(candidateId)
revise_memory(id, content, kind?, scope?)
pin_memory(id, pinned?, scope?)
consolidate_growth(memoryIds, content, scope?)
record_knowledge(title, content, source?, tags?, confidence?, scope?)
search_knowledge(query, scope?)
restart_session(botId?)
```

- `botId`省略時は呼び出したBot自身。
- `scope`省略時は個人。
- `scope=shared`だけが共通領域を扱う。
- MCP引数で保存者を偽装させず、呼び出し元BotはBellTeamが確定する。
- UIからの記憶操作も同じ内部サービスを呼び、MCPだけ別実装にしない。

## 11. ハーネス別復元

復元方法の差はThroughlineのhost adapterへ閉じ込める。

- Claude: 既存の二相handoffと初回`UserPromptSubmit`注入を維持する。
- Codex: 既存threadを破壊せず、新threadのdeveloper memoryとして復元する。
- Grok: `chat_history.jsonl` captureと`grok-continue`の正規経路を使う。
- Cursor: sessionStartの`additional_context`を使う。

BellTeamはハーネス名を渡すだけで、注入手段を選ばない。あるhostの対応のために、別hostの既存契約を置き換えない。

## 12. 実装工程

### Phase 1 — 分離の実証

- [x] Throughlineの保存・検索・handoff SQLを確認する。
- [x] Bot A/B分離のcharacterization testを追加する。
- [x] 現在混入する経路がないことを確認する。
- [x] 分離境界は既存の`project_path`を維持すると決定する。

完了条件: 現行または修正後のThroughlineで、個人記憶の相互混入が全検査経路でゼロ。

### Phase 2 — Throughlineの常時経路

- [x] container内の各CLIへThroughline hookを正規installする。
- [x] BellTeam BotとThroughline host sessionの関連を公開JSONで取得できるようにする。
- [x] Skillなしでcaptureされることを確認する。
- [x] 引き継ぎ生成とhost別復元を一回の公開入口へまとめる。

完了条件: 通常会話だけで記録が増え、公開入口一回で同じBotの新セッションへ続きが復元される。

### Phase 3 — 長期記憶の最小実装

- [x] 個人・共通`memory.db`を作る。
- [x] `raw_events`、`assertions`、`evidence`と記憶kindを実装する。
- [x] `remember`と`recall_memory`を実装する。
- [x] episode、growth、relationshipが通常事実と区別されることを確認する。

完了条件: Botが個人記憶を保存・検索でき、明示共有した記憶だけが共通領域に存在する。

### Phase 4 — RAGの最小実装

- [x] 個人・共通RAGフォルダを作る。
- [x] Markdown保存、INDEX更新、FTS即時反映を実装する。
- [x] `record_knowledge`と`search_knowledge`を実装する。
- [x] 派生indexの再構築を実装する。

完了条件: Markdownだけから検索DBを再構築でき、登録直後から個人・共通を分けて検索できる。

### Phase 5 — 引き継ぎ統合

- [x] Throughlineの直近会話へ、選択した長期記憶とRAG参照を追加する公開契約を作る。
- [x] Botプロフィール、共通聖典、現在の自己、重要な思い出、未完了タスク、関連知識を新セッションへ渡す。
- [x] 情報を入れすぎず、直近会話の自然な続きが最優先になる順序を固定する。

完了条件: セッション再起動後のBotが、自分の人格、直前の会話、必要な長期記憶を同時に理解する。

### Phase 6 — BellTeam接続

- [x] BellTeamの`restart_session`をThroughlineの正規入口へ接続する。
- [x] UIの再起動ボタンとMCPが同じ処理を呼ぶようにする。
- [x] Bot作成時からThroughline captureが有効になるようにする。
- [x] 停止中、待機中、処理中の各状態で再起動順序を確認する。

完了条件: UIまたはMCPから再起動し、会話の欠落や他Bot混入なく同じBotとして続行できる。

### Phase 7 — 自動整理

- [x] Throughlineの完了会話を長期記憶候補へし、整理後は会話本文の複製を残さない。
- [x] 完全一致は機械的に統合し、意味上の更新・矛盾はAIが`revise_memory`で整理する。
- [x] episodeの固定とgrowthへの統合を実装する。
- [x] 長すぎるセッションは毎日03:00（Asia/Tokyo）に休止中の場合だけ自動リセットする。

完了条件: セッションを繰り返しリセットしても、記憶量だけ増えて人格や現在地が崩れない。

## 13. 検証順序

1. 各機能のfocused test
2. Throughlineのhost別関連test
3. 長期記憶の個人／共通分離test
4. RAGの個人／共通分離test
5. BellTeam再起動の統合test
6. 最後にThroughlineとBellTeamの関連gate
7. release後、コンテナへ導入して公開面でsmoke

通し試験で原因調査をしない。失敗した機能を最小再現へ戻して直す。

## 14. やらないこと

- Aitermへ記憶管理を追加しない。
- BellTeamからThroughlineのSQLiteを直接操作しない。
- Skillの呼び忘れを注意文や再試行で補わない。
- 個人記憶から共通領域へ暗黙fallbackしない。
- 同じ記憶を個人DB、共通DB、RAG、Throughlineへ重複して正本化しない。
- 分離を実証する前にBellTeamとの接続実装へ進まない。
- 最初からvector DB、reranker、複雑な自動Reflectionを導入しない。
- あるハーネスの都合で他のハーネスの既存継続経路を置き換えない。

## 15. 現在地

- Throughline 0.10.12でBot A/Bのproject分離、公開Observer、Codex 0.151の会話捕捉、project束縛済み補足JSONを実装・release済み。
- Aiterm 0.29.20で補足JSONを解釈せず4ハーネスへ透過搬送し、BellTeamの共通待ち行列と再起動を実行する。
- BellTeamの4ハーネスへThroughline hookを公式installし、同じBot projectの直近セッションと補足記憶を再起動時に渡す。停止中・待機中・処理中の順序を実測済み。
- Project Bellの`raw_events → assertions → evidence`と9種類の記憶kindを最小実装した。個人／共通は別DBで、明示したscopeだけを検索する。
- CaveatのMarkdown正本＋即時FTSと、dotagentsの`INDEX.md`・`raw/`・`notes/`配置を組み合わせた個人／共通RAGを実装した。
- MCPとWeb APIは同じ`BellTeamMemory`サービスを呼ぶ。
- Botプロフィール、個人／共通長期記憶、個人／共通RAGをproject束縛済み補足JSONへ分けて書き、Throughlineが直近会話と一つの引き継ぎへまとめる。
- Throughline公開ObserverからBot別の完了会話候補を取り込み、AIが記憶・更新・破棄を判断する共通MCPを実装した。候補本文は整理後に消し、採用した根拠だけを長期記憶へ残す。
- 完全一致の根拠追加、記憶の改訂、episode固定、growth統合を実装し、個人／共通分離をfocused testで確認した。
- 本番のCodex、Claude、Grok、Cursorで、再起動後に各Botが自分の固有文字列を復元し、他Botの固有文字列は一件も混入しないことを確認した。UIとMCPの候補一覧も同じ状態を返した。
- Throughline公開Observerの20完了ターンを境界に、毎日03:00（Asia/Tokyo）に休止中のBotだけをAiterm再起動して記憶復元する日次メンテナンスを実装した。処理中、待機中、停止中のBotはその夜の対象から外す。
