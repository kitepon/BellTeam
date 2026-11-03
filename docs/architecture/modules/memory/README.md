# 記憶・知識

責任者：ビスケット。

短期/長期記憶・知識の内容、保存形式、検索と索引、業務factory/dispatcherを持つ。席proxy・起動停止・版交換はエピネル、親の安定facadeとassemblyはモリー。保存先とbackup運用の既存責任は変えない。

接続の正本は[module.json](module.json)。全体の[機能図](../../feature-map.md)と[担当・変更手順](../../module-ownership.md)から、呼出元と依存先を辿る。

## 現行図の正本

- [保存・検索・索引](details.md)
- [単体更新の業務factoryと処理完了](update.md)

業務factory/dispatcherはmemoryの公開source。既SeatRuntime/短命runnerと親assemblyを新窓口へ接続する工程、固定版の配布/起動/交換と実物受入はruntime/integration/distributionが持ち、このsource供給だけで全体の単体更新完了とは扱わない。
