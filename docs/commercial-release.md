# 商用 image の候補作成と安定版反映

配布コード・image 定義の担当は **モリー**、製品試験・事前受入の担当は **センチ**、本番実行判断は **トロニー**（2026-11-08 オーナー裁定）。内部で先に使い、その結果を外部配布へ返す。image は公式現行基盤から一度 build し、内部受入と安定版で同じ digest を使う（AI CLI 本体は image 非同梱、a451）。

`publish-server-image.yml` は既存の両 arch native 試験をすべて通してから source SHA の候補 tag を作る。`latest` / `preview` は変更しない。候補も公開 registry から取得できるため、候補 tag と一般利用者向け安定 tag を区別する。実行 summary から index digest / source を取得し、arch 別 digest・基盤 CLI 実版と事前試験結果をセンチが記録する。

内部への反映は、センチの事前受入、本体互換、既存の本番停止許可・quiet・バックアップ/戻し条件を確認してから正規 deploy 経路（[deploy-commercial.md](deploy-commercial.md)）で行う。候補作成 workflow の成功だけで本番の許可を得たとは扱わない。内部 overlay / deploy 入口の変更は別 PR で管理する。

内部実使用の結果が揃ったら、`promote-server-image.yml` を手動実行し、受入済み index digest、40 文字 source、センチの試験と内部結果の記録先を指定する。処理は両 arch の source と `main` 祖先性を照合して、同じ index を `latest` / `preview` へ向けるだけで再 build しない。反映後に各 tag の raw manifest hash が受入 digest と同一か照合する。

この workflow は内部受入の判断を自動で代行しない。タグ反映後は、センチが匿名取得・初回導入・更新・設定保持を同 digest で確認して結果を報告する。不合格時は記録済み旧 digest を同じ手順で指定し、既存のデータ/volume 復旧条件を維持する。
