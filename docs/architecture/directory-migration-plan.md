# `src/`・`test/` ディレクトリ段階移行ブループリント

`src/`（404 ファイル、うち直下フラット 316 ファイル）および `test/`（684 ファイル、うち直下フラット 574 本）の過渡的な肥大化を、**稼働中のモジュール交換・CI・C 起動バイナリ・進行中の Lattice 作業を壊さずに**モジュール境界へ揃えるための段階移行設計書。

関連正本：[全体機能図](feature-map.md)、[機能担当と変更手順](module-ownership.md)、[全体データフロー](data-flow.md)。

---

## 1. なぜ一括 `git mv` を禁止し、段階移行にするか（ハードコード制約）

実測の結果、以下の 4 箇所が `src/`・`test/` 直下のファイルパスを直接参照している。これらを無視した一括移動は CI 破壊と全担当の大規模コンフリクトを引き起こす。

### 1.1 C 起動バイナリ固定エントリ（9 ファイル）
`scripts/*.c` がビルド時に次のパスを固定埋め込みしている（[module-start.c](../../scripts/module-start.c) L76 等）：
- `src/supervisor.mjs`（`scripts/server-start.c`）
- `src/approval-box-extension-entry.mjs`（`scripts/approval-box-extension-start.c`）
- `src/conversation-entry.mjs`（`scripts/conversation-start.c`）
- `src/diagnostics-entry.mjs`（`scripts/diagnostics-start.c`）
- `src/lattice-entry.mjs`（`scripts/lattice-start.c`）
- `src/members-entry.mjs`（`scripts/members-start.c`）
- `src/notifications-entry.mjs`（`scripts/notifications-start.c`）
- `src/usage-entry.mjs`（`scripts/usage-start.c`）
- `src/work-graph-entry.mjs`（`scripts/work-graph-start.c`）

**対策**：これら 9 ファイルは本体イメージ入替を伴わずに安全に移行するため、**`src/<name>-entry.mjs` に 1 行の re-export / 起動シムを残す**（C バイナリ変更は本体イメージ更新のタイミングで別途行う）。

### 1.2 パッケージング選択リスト（`scripts/web_gateway_artifact.py`・`module_artifact_package.py`・`package-server.mjs`）
各モジュール artifact の構成は [scripts/web_gateway_artifact.py](../../scripts/web_gateway_artifact.py) の選択リストで決まる：
- `EXECUTION_FILES`（63 `src/` ファイル）
- `CONVERSATION_FILES`（59 `src/` ファイル）
- `BUSINESS_FILES[usage]`（36 `src/` ファイル）
- `BUSINESS_FILES[lattice]`（17 `src/` ファイル）
- `BUSINESS_FILES[approval-box-extension]`（14 `src/` ファイル）
- `BUSINESS_FILES[diagnostics]`（12 `src/` ファイル）
- `BUSINESS_FILES[work-graph]`（10 `src/` ファイル）
- `MEMORY_FILES`（6 `src/` ファイル）

また [scripts/module_artifact_package.py](../../scripts/module_artifact_package.py) L107 が互換チェック対象ファイル（`src/execution-dispatcher.mjs`, `src/work-graph-protocol.mjs`, `src/lattice-protocol.mjs`, `src/approval-box-extension-protocol.mjs`, `src/diagnostics-protocol.mjs` 等）を直接指定し、[scripts/package-server.mjs](../../scripts/package-server.mjs) が `src/distribution-profile.mjs` を参照している。

**対策**：モジュールごとにファイルを移動する同一 PR 内で、そのモジュールの `web_gateway_artifact.py` 選択リストと `module_artifact_package.py` 参照を同時に更新する（2026-11-08 以降、本体 `validate_manifest` 側の閉集合チェックは撤廃済みのため、モジュール側ソース更新だけで完結できる）。

### 1.3 GitHub Actions ワークフロー（30 本）
- `src/` 直接参照（2 箇所）：`.github/workflows/publish-server-image.yml` の `src/distribution-profile.mjs`・`src/aiterm-transport.mjs`。
- `test/` 直接参照：`publish-*.yml`・`verify-*.yml` が `test/*-artifact.test.py`・`test/*-real-boundary.test.py`・`test/business-artifact.test.py`・`test/update-catalog.test.py` および `test/helpers/*` を直接実行している。

**対策**：CI が直接参照する `.test.py`（約 15 本）と `test/helpers/` は Phase 1 では動かさず、まず `.test.mjs`（532 本）からモジュール別フォルダへ移行する。

### 1.4 Lattice `witness` 宣言との競合回避
進行中のタスクは `src/<file>.mjs#fn` 単位で所有宣言しているため、**1 PR ＝ 1 モジュール（担当単位）**で Lattice 工程表へ載せて移動する。

---

## 2. 現状棚卸しと目標ディレクトリ構造

### 2.1 `src/`（全 404 ファイル：既存サブディレクトリ 88 ＋ 直下フラット 316）

| 分類 / 目標ディレクトリ | 担当 | 既存サブ配下 | 直下フラット数 | 主な対象と備考 |
| --- | --- | ---: | ---: | --- |
| `src/shared/`（新設） | モリー | 0 | 18 | 複数モジュール artifact が共有する共通部品（下記 2.2 参照） |
| `src/execution/`（新設） | キロ | 0 | 74 | artifact 47 + 親側 27。`aiterm-transport.mjs`（2,617 行）は別途 6 責務へ分割 |
| `src/conversation/`（既存） | N102 | 14 | 46 | artifact 30 + 親側 16（`durable-message-receipts.mjs` 含む） |
| `src/runtime/`（新設） | モリー | 0 | 39 | `bootstrap`, `lifecycle`, `module-*`, `update-*`, `server-state-*`, `run-*`, `cli-*` |
| `src/integration/`（新設） | モリー | 0 | 33 | `application-*`, `http-*`, `mcp-*`, `direct-receipt-assembly`, `server-*` |
| `src/usage/`（既存） | ミカ | 27 | 27 | `usage-*`, `notifications-*`, `push-*`, `fcm-*`, `cloudflare-*`, `home-login-front` |
| `src/members/`（既存） | ベロータ | 12 | 18 | `members-*`, `bot-registry`, `bots`, `character-sheets`, `project-instructions` |
| `src/approval-box-extension/`（既存） | デルタ | 7 | 12 | `approval-box-*`（親 facade/effects/daemon 含む） |
| `src/diagnostics/`（新設） | シグナル | 0 | 10 | `diagnostics-*`, `bughub-security`, `diagnostic-request-context` |
| `src/lattice/`（既存） | フローラ | 11 | 9 | `lattice-*`（protocol/ipc/dispatcher/facade/process/approval） |
| `src/terminals/`（既存） | クラスト | 10 | 2 | `terminals-mcp.mjs`, `remote-user-tools.mjs` |
| `src/work-graph/`（既存） | ブラック | 3 | 8 | `work-graph-*`（protocol/ipc/dispatcher/facade/process） |
| `src/memory/`（既存） | ビスケット | 3 | 6 | `memory-*`, `throughline-context` |
| `src/web-gateway/`（新設） | アドミ | 0 | 4 | `web-gateway-*`（`http-gateway-*` は integration/web-gateway で合意） |
| `src/vendor/`（既存） | モリー | 1 | 0 | そのまま維持 |
| 直下固定シム（9 件） | モリー | — | (上記に含む) | `supervisor.mjs` + 8 つの `*-entry.mjs`（1 行シム維持） |

### 2.2 複数モジュール共有ファイル（`src/shared/` 候補・18 ファイル）
`web_gateway_artifact.py` の複数 artifact リストに同時収録されている 18 ファイルは、個別モジュールへ入れず `src/shared/` へ集約する：
1. `module-ipc.mjs`（7 モジュール共有）
2. `module-streams.mjs`（6 モジュール共有）
3. `module-locks.mjs`（5 モジュール共有）
4. `json-file.mjs`（4 モジュール共有）
5. `agent-launch-error.mjs`（execution / conversation / diagnostics）
6. `runtime-home.mjs`（execution / conversation / usage）
7. `diagnostic-report-context.mjs`（execution / diagnostics）
8. `execution-bridge.mjs`（execution / conversation）
9. `execution-error.mjs`（execution / conversation）
10. `resume-policy.mjs`（execution / conversation）
11. `retired-harness.mjs`（execution / usage）
12. `returned-mcp-error.mjs`（execution / conversation）
13. `runtime-selection.mjs`（execution / conversation）
14. `seat-command.mjs`（execution / conversation）
15. `seat-process.mjs`（execution / conversation）
16. `server-address.mjs`（conversation / usage）
17. `session-interruption.mjs`（execution / conversation）
18. `timeline-index.mjs`（conversation / usage）

### 2.3 `test/`（全 684 ファイル）
- 直下 `.test.mjs`：**532 本**（モジュール接頭辞別：`conversation` 65、`module` 30、`members` 29、`update` 21、`server` 21、`execution` 21、`seat` 19、`memory` 17、`usage` 16、`aiterm` 16、`notifications` 13、`lattice` 12、`http` 12、`deploy` 10、`remote` 9、`model` 9、`harness` 9、`web` 8、`terminals` 8、`diagnostics` 8、`bot` 8、`runtime` 7 等）
- 直下 `.test.py`：**42 本**（うち CI 直接参照分はワークフローと同時移動または直下維持）
- `test/helpers/`（59 本）・`test/fixtures/`（44 本）：そのまま維持

---

## 3. `src/aiterm-transport.mjs`（2,617 行）の責務分割設計

`src/aiterm-transport.mjs` は単一クラス `AitermTransport` に 6 つの独立責務が同居しており、保守性とコンテキスト効率の最大ボトルネックになっている。公開 export（`AitermTransport`, `createManagedTransport`, `operationLease`, `turnFailureWords`, `cleanScreen`）を保ったまま、内部実装を `src/execution/` 配下の 6 部品へ段階抽出する：

| 抽出先モジュール案 | 担当責務 | 現行メソッド・行範囲（実測） |
| --- | --- | --- |
| `src/execution/transport-seat-lifecycle.mjs` | 席の起動・再開・設定適用・停止・休止 | `ensure`, `wake`/`wakeNow`, `resumePreviouslyActive`, `reconfigure`/`reconfigureNow`, `restart`, `interrupt`/`interruptMany`, `closeIdle`, `stopForConfiguration`, `closeOldSeats`（L425–1104） |
| `src/execution/transport-delivery.mjs` | 配送順序・送信・途中発言追跡・完了待ち・回答読取 | `notify`/`notifyReport`, `dispatchInOrder`, `sendToWokenSession`, `sendToSession`, `followAcceptedDelivery`, `followInterim`, `readInterim`, `readTurnAnswer`, `waitForTurnCompletion`, `waitUntilDone`（L1105–1550, L2025–2279） |
| `src/execution/transport-work-watch.mjs` | 稼働要約・現在ターン・自主ターン監視・キュー投影 | `startWorkSummary`, `startRequestSummary`, `currentWork`/`currentTurn`/`ownWork`, `seatTurns`, `watchTurn`, `shownInSelfTurn`, `queueItems`/`watchQueue`/`emitQueue`（L1553–1910） |
| `src/execution/transport-remote-recovery.mjs` | リモート席のロストルート検知・再接続バックオフ | `resumeLostRoutes`, `routeRetryAt`, `seatClosedAfterTimeout`, `resumeRemoteSeat`（L1656–1775） |
| `src/execution/transport-screen-media.mjs` | 画面読取・キー/承認送信・機械ストリーム・一時画像管理 | `screen`, `screenKey`, `screenApproval`, `resumeMachineStreams`, `streamSend`, `readSeatImage`, `imageFiles`/`imageFile`/`attachmentFile`/`removeTemporaryImages`（L325–424, L2222–2279） |
| `src/execution/transport-accounts.mjs` | Claude 2 アカウント切替・上限/サインアウト検知・境界復帰・CLI 未導入待機 | `claudeAccountBot`, `recordAccountLimit`, `recordAccountSignedOut`, `switchAccount`, `reviewAccounts`/`reviewAccountsNow`, `recoverAccount`/`recoverMember`, `moveAtBoundary`, `requireCli`/`cliChanged`（L2281–2538） |

抽出後、`src/aiterm-transport.mjs` はこれら 6 部品を束ねる薄いファサード（300〜400 行規模）となり、既存の全 caller と `publish-server-image.yml` からの import 互換を完全に維持する。

---

## 4. 安全な 5 フェーズ実行手順（Lattice 工程表テンプレート）

### Phase 0：テスト受け皿の開放（本 PR で実施）
- `package.json` の `"test"` を `node --test "test/**/*.test.mjs"` へ変更（Node 24/26 ネイティブ再帰グロブ、既存直下 532 本と新規サブディレクトリ配下の両方を検出）。
- 既存ファイルの移動はゼロのため、進行中ブランチとの競合なし。

### Phase 1：`.test.mjs` のモジュール別サブディレクトリ整理（各担当が並列実行可）
- 対象：`test/<module>/*.test.mjs`（例：`test/work-graph/`, `test/lattice/`, `test/diagnostics/`, `test/terminals/`, `test/memory/`, `test/members/`, `test/usage/`, `test/conversation/`, `test/execution/`, `test/runtime/`）。
- 変更点：移動するテストファイル内の `../src/` → `../../src/`、`./helpers/` → `../helpers/`、`./fixtures/` → `../fixtures/` の相対 import 調整のみ。
- 検証：`node --test test/<module>/*.test.mjs` が全 PASS すること。

### Phase 2：小規模・独立モジュールから `src/` パイロット移行（推奨順）
1. **`work-graph`**（ブラック：直下 8 ファイル → `src/work-graph/`、`src/work-graph-entry.mjs` は 1 行シム維持）
2. **`diagnostics`**（シグナル：直下 10 ファイル → `src/diagnostics/`、`src/diagnostics-entry.mjs` は 1 行シム維持）
3. **`lattice`**（フローラ：直下 9 ファイル → `src/lattice/`、`src/lattice-entry.mjs` は 1 行シム維持）
4. **`approval-box-extension`**（デルタ：直下 12 ファイル → `src/approval-box-extension/`）
5. **`terminals`**（クラスト：直下 2 ファイル → `src/terminals/`）
6. **`memory`**（ビスケット：直下 6 ファイル → `src/memory/`）

各 PR の完了条件（共通チェックリスト）：
- [ ] `src/<module>-entry.mjs` の 1 行シムを残し、`scripts/*-start.c` との互換を保つ
- [ ] `scripts/web_gateway_artifact.py`（および必要な場合 `scripts/module_artifact_package.py`）のファイルパス一覧を同一 PR で更新
- [ ] 当該モジュールの単体テスト + `python3 test/business-artifact.test.py`（または該当 artifact テスト）が PASS

### Phase 3：`src/shared/` 切り出し ＋ 大規模モジュール整理
1. モリーが共通 18 ファイルを `src/shared/` へ移行（移行期間中は必要に応じて旧パスに 1 行 re-export シムを置き、全モジュール追従後に削除）。
2. `members`（ベロータ）、`usage`（ミカ）、`conversation`（N102）、`execution`（キロ）、`integration` / `runtime`（モリー）、`web-gateway`（アドミ）を 1 モジュール 1 PR で移行。

### Phase 4：`src/aiterm-transport.mjs` の 6 責務分割（キロ）
- 上記 3 節の 6 部品を 1 責務 1 PR で抽出（まずは独立性が最も高い `transport-accounts.mjs` → `transport-screen-media.mjs` → `transport-remote-recovery.mjs` から開始するとリスク最小）。
- 各抽出ごとに `test/execution/` 配下の該当契約テストのみを実行して確認する。
