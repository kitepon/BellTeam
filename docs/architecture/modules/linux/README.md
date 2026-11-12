# Linuxアプリとの接点

担当：ネオン（`bot-208dcbab`）。Linuxクライアント。

製品図の正本は[Linuxアーキテクチャ](../../../linux-architecture.md)。Avalonia画面/共通部品`windows/BellTeam.Core`（所有はアニス）/端末設定・認証/freedesktop通知と共通入口へ辿る。内部図は製品担当が維持し、ここへ複製しない。

本体接続はHTTP APIとSSE。連絡はBellTeamの直接会話を使う。見た目はMac版、コードはWindows版の共通部品を使う（2026-11-12 オーナー裁定）。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
