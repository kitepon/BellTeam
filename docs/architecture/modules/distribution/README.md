# 商用配布

責任者：センチ。

配布構成・候補build・image/source受入・公開版発行とpromotion。設置/移行の実装はエピネル、本番実行はトロニー。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図と移管工程

- [distribution-details.md](../../distribution-details.md)
- [H1 offline保存更新の配布入力](h1-offline.md)
- [Web受付の固定artifactと公式認証](web-gateway-artifact.md)
- [通知の固定artifactと公式認証](notifications-artifact.md)
- [正式Update catalogの信頼境界](update-catalog.md)

上の既存詳細図は現行実装の読取資料。複数担当が含まれる章は最初の分離で当moduleへ移し、元の章を参照リンクへ置換する。内容を二つの現行図へ複製しない。図とコードの分離完了はまだ宣言していない。

## 最初の成果

公開入出力、所有データ、実装・全caller・関連試験、他担当との接点を図で確定する。自分の内部変更が他担当の内部コードや保存データの直接変更を要求しない形へ分離する。共有入口は登録/呼出だけにして、業務処理を自分のmoduleへ移す。変更した図とコード・限定検証結果を一つの差分にする。

正式Aiterm0.63.6/source258b8aefをDockerfileで明示固定し、diagnostics v2と原要求tracked apply/reconcileのconsumerを同じ通常source/immutable imageへ結合する。既0.63.5 pinは別の履歴で修理入りとは呼ばない。受入は承認済package/version/必要runtime/同native entryの能力と既Web A-B差分接点に限定し、143runtime/旧成功群を全面再走しない。既image構成/同梱CLI契約内の版固定で図接続は不変。CLI argvから通常core scope生成を推測せず、実接続/UID/base/stdioとRootの別世代・認証条件を維持する。
