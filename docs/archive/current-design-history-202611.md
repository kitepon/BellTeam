# BellTeam 現行設計からの退避履歴（2026-11）

[docs/current-design.md](../current-design.md) を「今現在の製品契約だけ」が読める正本へ整理するにあたり、すでに退役・移行完了・方針転換された詳細な経緯と旧仕様をここへ退避した（元本文の事実を失わず、正本からの参照で辿れる状態を保つ）。

---

## 1. Antigravity ハーネス取り外しと新旧モジュール混在移行の経緯（a353–a399 / 2026-11-17）

- **撤去判断（a353、2026-11-17）**：BellTeam が Antigravity を包む使い方は規約に反しアカウント停止リスクがあるため、選択可能なハーネスから外した。コードは GitHub の `archive/antigravity-harness-20261117`（main `f17aa773`）に保存。
- **入れ替え順と IPC 互換の変遷（a368 / a374 / a394f / a399）**：
  - 本体と子部品は個別に更新されるため、値を外すときは読む側が旧値を受け入れ続け、選ぶ側だけ断る方針を採った（旧 usage からの `members.read` / `onboarding.ensureGuide` / `auth.call(harness: antigravity-cli)` は本体側で安全に受領または `status: failed` 応答）。
  - a399 でデータ記録（部品結果・投影行・effect 結果）の読み取りを「使う項目の有無と型だけ検査し、未知項目を断らない」形へ改めた（`secret`・`question`・`settings`・`credential` および依頼系は閉じたまま）。詳細は [module-ipc.md](../architecture/modules/runtime/module-ipc.md)。
  - a394f で `billingSources`・`canPurchase` を任意項目として追加。`test/retired-harness-existing-data.test.mjs`・`test/mixed-version-start.test.mjs`（Z89・Z91 再現）・`test/usage-process.test.mjs` で混在起動を検証。
- **旧 `native_launch`（a366 / Z92）**：Antigravity の `vendor_action_required` を 409 分類し失敗行へ `native_launch` を記録していた書き手（`agent-launch-error.mjs` の `unpromptedLaunchActionRequired`・`launchFailureDetails` 等）と受信検証を外した。保存済みログと旧実行部品互換のため項目自体は受領して中身を見ずに破棄する。

---

## 2. SEC-014 先行段の旧 Cursor 更新フロー（2026-10-15〜a451）

- 2026-10-15 の段階実装承認により、`cursor-agent update` を本体 CMD から外し、鍵や `runtime/home`・`runtime/data` を渡さない使い捨てコンテナ（`compose.cursor-update.yaml`、`/usr/local/bin/bellteam-update-cursor`、read-only rootfs、UID/GID 1000、tmpfs HOME）で Cursor の named volume のみを更新する段を導入した。
- **a451（2026-11-19、オーナー裁定）** で AI CLI 全般（Claude Code・Codex・Grok・Cursor）をサーバー image に同梱しない方針へ移行したため、以後の `bellteam-update-cursor` は何も実行しない空の互換入口となり、段の形だけが installer に残っている。

---

## 3. 旧 RTK 直接書込・testgate 切替ロジック（bd14 以前）

- bd14（2026-11-14）以前は、`src/rtk-hooks.mjs` が `throughline install` の後に各 CLI 設定（`~/.claude/settings.json`、`~/.codex/hooks.json`、`~/.cursor/hooks.json`、`~/.grok/hooks/rtk.json`）へ直接 `rtk hook` を書き、`/srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs` の有無に応じて同じ位置の command を書き換えていた。
- bd14 以降は、RTK / testgate / Throughline / Aiterm / Approval Box の公開契約 E1（`harness-entries`）を `src/harness-entries.mjs` が単一 writer として適用する方式へ移行し、BellTeam 自身の旧 RTK writer と実体有無による直接切替は退役した（正本：[cli-registration.md](../architecture/modules/runtime/cli-registration.md)）。

---

## 4. 旧 Throughline DB の bind mount 構成（2026-10-05〜bd08）

- 2026-10-05 時点の本番 `compose.yaml` は `./runtime/data/shared/throughline` をコンテナ内 `/home/bell/.throughline` へ bind mount（`create_host_path: false`）し、配布用 compose とは配置が異なっていた。
- 現在は `Dockerfile` で `THROUGHLINE_HOME=/srv/bellteam/shared/throughline` を明示指定し、Throughline 0.20.0 の公開契約（`THROUGHLINE_HOME`、`throughline storage locate/export`）へ移行している（[data-flow.md](../architecture/data-flow.md) X12）。

---

## 5. 旧 `mcp-lazy` 版固定（2026-10-05〜2026-11-08）

- 2026-10-05 導入時は `kitepon/mcp-lazy` の受入コミット（0.3.2、`ba0f443`）へ固定していた。
- 2026-11-08 のオーナー裁定（「同梱物は固定しない」）により、`Dockerfile` では公開リポジトリの最新 `main` からビルドする形へ変更された。

---

## 6. 旧 `taskSettingsReminder` 配送時追記（廃止済み）

- かつて `config/common-agents.md` に「作業設定の見直し」節を置き、各配送・差し込み時に短いリマインダー文を AI 入力へ添えていた。
- 現在はモデル運用方針をユーザー規範側へ移管し、`config/common-agents.md` から `SECTION models` を廃止、配送時の追記も行わない（`globalInstructions.taskSettingsReminder()` は空文字を返す：`test/task-settings-reminder.test.mjs` で検証）。

---

## 7. ブラウザ版 Web UI（2026-11-22 終了）

- ブラウザ版 Web UI は 2026-11-22 のオーナー判断により終了した。画面コード・画面資材表・静的ファイル配信は削除され、`web-gateway` はネイティブアプリ向け HTTP/SSE 入口のみを担当する（履歴：[archive/web-ui/README.md](web-ui/README.md)、現行正本：[modules/web/README.md](../architecture/modules/web/README.md)）。
