# BellTeam ドキュメント索引

BellTeam リポジトリ内ドキュメントの正本マップ。**現行仕様（State）**と**変更履歴・過去資料（History / Archive）**を分離して管理する。

## 1. まず読む正本（開発・運用ルール＆全体設計）

| ファイル | 役割 |
| --- | --- |
| [../README.md](../README.md) | 製品概要、クライアント構成、MCP 一覧、起動・本番反映の入口 |
| [../AGENTS.md](../AGENTS.md) | このリポジトリで開発・保守する AI 向けの固有規範 |
| [../config/common-agents.md](../config/common-agents.md) | 常駐 Bot 全員へ配布される製品共通規範（`RULES bellteam.common v1`） |
| [current-design.md](current-design.md) | BellTeam の現行設計の正本（現在有効な製品契約のみ） |
| [current-status.md](current-status.md) | 設置先ごとの現在状況ファイルの案内（実測値は Git 外 `runtime/current-status.md`） |
| [architecture/feature-map.md](architecture/feature-map.md) | 全体機能図（`module.json` から自動生成） |
| [architecture/data-flow.md](architecture/data-flow.md) | 全体データフロー・状態所有・外部製品接続契約の正本 |
| [architecture/module-ownership.md](architecture/module-ownership.md) | 機能担当とコード変更手順の正本 |

## 2. 導入・運用・課金・機能別仕様

| カテゴリ | ドキュメント |
| --- | --- |
| 導入・初期設定 | [server-installation.md](server-installation.md)、[onboarding.md](onboarding.md)、[../distribution/server/README.md](../distribution/server/README.md) |
| 商用配布・本番反映 | [commercial-release.md](commercial-release.md)、[deploy-commercial.md](deploy-commercial.md)、[server-distribution.md](server-distribution.md)、[host-ssh.md](host-ssh.md) |
| 課金・購読 | [subscription.md](subscription.md)、[billing-client-contract.md](billing-client-contract.md)、[subscription-setup.json](subscription-setup.json) |
| 機能別契約 | [ai-control.md](ai-control.md)、[secret-input.md](secret-input.md)、[push-notifications.md](push-notifications.md)、[communication-notifications.md](communication-notifications.md)、[bot-environment.md](bot-environment.md)、[delivery-recovery.md](delivery-recovery.md)、[memory-boundary.md](memory-boundary.md)、[profile-avatars.md](profile-avatars.md)、[terminal-history.md](terminal-history.md) |
| 診断・セキュリティ | [bughub-report-context.md](bughub-report-context.md)、[diagnostic-operation-context.md](diagnostic-operation-context.md)、[sec-014-stage2.md](sec-014-stage2.md)、[sec014-offline-caller.md](sec014-offline-caller.md) |

## 3. クライアント別設計書

- **Apple（iPhone / iPad / Mac）**：[../ios/BellBot/README.md](../ios/BellBot/README.md)、[ipad-app.md](ipad-app.md)、[mac-app.md](mac-app.md)、[architecture/modules/apple/README.md](architecture/modules/apple/README.md)
- **Windows**：[windows-app.md](windows-app.md)、[windows-architecture.md](windows-architecture.md)、[windows-mac-parity-gaps.md](windows-mac-parity-gaps.md)
- **Linux**：[linux-architecture.md](linux-architecture.md)
- **Android**：[android-architecture.md](android-architecture.md)

## 4. アーキテクチャ・モジュール別正本

- `docs/architecture/modules/<機能>/README.md` と `module.json`（全 27 モジュール／アプリ／外部製品の接続窓口と詳細図）。

## 5. 履歴・記録・画像資産

| ディレクトリ | 内容 |
| --- | --- |
| `docs/adr/` | アーキテクチャ意思決定記録（ADR） |
| `docs/archive/` | 現行正本から退避した過去仕様・移管履歴・廃止機能記録（[current-design-history-202611.md](archive/current-design-history-202611.md)、[module-ownership-history-202611.md](archive/module-ownership-history-202611.md)、[subscription-worker-history.md](archive/subscription-worker-history.md)、`archive/web-ui/`、`archive/plans/`、`archive/notes/`） |
| `docs/evidence/` | 実測・検証・審査時の証跡ログ |
| `docs/assets/` | UI 比較画像・画面スクリーンショット（`assets/screenshots/{android,linux,windows}/` 等） |
