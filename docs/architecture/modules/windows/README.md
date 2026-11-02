# Windowsアプリとの接点

担当：ベル（Windows）。Windowsクライアント。

製品図の正本は[Windowsアーキテクチャ](https://github.com/kitepon/BellTeam/blob/windows-ownership-20261102/docs/windows-architecture.md)。担当ベルのcommit65386e6、PR252/head341を基にした未統合の文書。WPF画面/Core/端末設定・認証/Windows通知と共通入口へ辿る。内部図は製品担当が維持し、ここへ複製しない。

現行の本体接続はHTTP APIとSSE。MCP利用は未確認のため利用契約へ加えない。ベルはlocalチームであり、連絡はトロニーの既call-bridge通話を使う。商用更新通知は共通状態と進行の合意後の設計対象で、新機能の実装や配布は未実施。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
