# メンバー・部屋・予定と正本の関係

本branchの実装を説明する。調査起点と確認範囲は[全体図](feature-map.md)を参照。外部入口は[入口索引](entrypoints.md)、native停止/反映の主要図は[制御](control-and-state.md)。ここでは、台帳を変えたことと実行中の席を変えたことを分ける。

## メンバーのデータは三つに分かれる

[メンバー・予定の正本](modules/members/registry.md#メンバーのデータは三つに分かれる)へ移管した。

## 削除は「実行から外す」と「ファイルを消す」を区別する

[削除の受付・再開・完了とCLI同期](modules/members/deletion.md)へ移管した。

## 部屋定義と会話の所有

正本を[会話・履歴module](modules/conversation/rooms.md#部屋定義と会話の所有)へ移した。

## 予定：定義、発行、実行結果は別

[予定の正本](modules/members/registry.md#予定定義発行実行結果は別)へ移管した。

## Ownerプロフィールと規範

[指示生成の正本](modules/members/registry.md#ownerプロフィールと規範)へ移管した。全製品共通テンプレートの所有者は統合担当。
