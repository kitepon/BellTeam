# testgateとの接点

担当：シラツル。試験選択とhook公開仕様。

## BellTeamへ約束する入口（2026-11-14 Owner：製品の間は契約された入口だけ、a105）

`registration v1 (item in RTK harness-entries.json)`。正本は製品repoの `docs/registration-contract.md`（registration entry v1、0.3.32）。各harnessのPreToolUseに `node <R>/current/bin/testgate.mjs hook <H>` を一つだけ入れる。項目はドリリーが公開するRTKの `harness-entries.json` に載り、BellTeamはCLIファイルの唯一のwriterとしてそれを書く（runtime、エピネル、bd13）。本体がtestgateのパスを自分で探って項目を組み立てることはやめる。版の切替は `current` の張り替えだけで、再登録もCodexの再信頼も要らない。

これはBellTeamとの接続登録。製品内部の機能図は製品担当の正本を参照し、ここへ複製しない。担当へ正本URL/実ファイルと公開入出力・変更通知先の回答を依頼中。独立製品の分離完了を意味しない。

[接続情報](module.json) / [共通の変更手順](../../module-ownership.md)
