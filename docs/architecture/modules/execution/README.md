# AI実行制御

責任者：キロ。

起動・配送実行・完了観測、モデル適用と再開、停止・session・Goal。Aiterm内部は担当外。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図と移管工程

- [会話effectの親固定adapterとauthority実終端](conversation-effects.md)

- [host内の実engine factoryと交換](host-factory.md)

- [待機outcomeと設定適用の契約](wait-contract.md)
- [会話交換のcallback・実終端参照](conversation-lifetimes.md)
- [capacityと利用上限からの新しい継続](capacity-continuation.md)
- [本人要約と現在turnの投影](current-work.md)
- [members交換中の親admission・lease](members-admission.md)
- [原要求を保持する設定適用・照合](configuration-requests.md)
- [設定不明と通常配送を分離する契約](configuration-delivery.md)
- [control-details.md](../../control-details.md)
- [delivery-details.md](../../delivery-details.md)
- [observation-details.md](../../observation-details.md)

上の既存詳細図は現行実装の読取資料。複数担当が含まれる章は最初の分離で当moduleへ移し、元の章を参照リンクへ置換する。内容を二つの現行図へ複製しない。図とコードの分離完了はまだ宣言していない。

## 最初の成果

公開入出力、所有データ、実装・全caller・関連試験、他担当との接点を図で確定する。自分の内部変更が他担当の内部コードや保存データの直接変更を要求しない形へ分離する。共有入口は登録/呼出だけにして、業務処理を自分のmoduleへ移す。変更した図とコード・限定検証結果を一つの差分にする。
