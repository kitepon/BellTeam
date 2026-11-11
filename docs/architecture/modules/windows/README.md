# Windowsアプリとの接点

担当：アニス（`bot-0d7da1c1`）。Windowsクライアント。

製品図の正本は[Windowsアーキテクチャ](../../../windows-architecture.md)。WPF画面/Core/端末設定・認証/Windows通知と共通入口へ辿る。内部図は製品担当が維持し、ここへ複製しない。

本体接続はHTTP APIとSSE。連絡はBellTeamの直接会話を使う。更新センターの表示と操作は共通Update APIを使用し、端末は要求IDと結果を保持する。起動中の通知と終了中の受信は製品図に記載する。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
