# Androidアプリとの接点

担当：ネオン（`bot-208dcbab`）。Androidクライアント（task a350）。

製品図の正本は[Androidアーキテクチャ](../../../android-architecture.md)。Avalonia画面（Linux版の画面部品をリンクして共用）/共通部品`windows/BellTeam.Core`（所有はアニス）/端末設定・認証と共通入口へ辿る。内部図は製品担当が維持し、ここへ複製しない。

本体接続はHTTP APIとSSE。連絡はBellTeamの直接会話を使う。画面・文言・操作の流れはMac版に揃える（Owner 2026-11-17、全プラットフォーム同一仕様）。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
