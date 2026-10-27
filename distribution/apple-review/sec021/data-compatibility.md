# 審査用の設定・最新データと戻し

image選択の追加ファイルは設定やmountを変えないが、起動する製品の初期化処理は永続先を書き換える。受入imageを選ぶ前に新旧sourceの対応を確定し、現在の設定・データと戻し先の互換性を確認する。以下は保存済み審査用source `6193e3d42633f375b57920ad087899dc671fa54d` と通常製品source `ed5300ccb6f45730b5bacfc9982710c2c4655509` の比較結果で、後者を審査用候補として選定した記録ではない。

## 本体で確認した差

| 入口・保存先 | sourceで確認した動作 | 反映前に必要な対応 |
| --- | --- | --- |
| `supervisor.mjs` → `bootstrap.mjs` | 新sourceは設定を読む前に同梱Aitermのnative実行入口・scope/providerを解決する。設定読込み後にBot初期化、席の環境・CLI設定と説明書の更新へ進む。 | 新候補に必要な同梱入口があり、実行user・HOME・root・設定pathが現在の審査環境へ対応すること。旧imageのCLI構成を候補へ推定しない。 |
| `BotRegistry.initialize` → `migrateProfiles` → `writeProfile` | 旧sourceの保存形式は `bellteam.bot.v7`、新sourceは `v8` と `fastMode` を保存する。旧sourceへ戻すと起動時の移行でv8をv7へ書き直し、`fastMode` を落とす。旧 `readProfile` 単体もv8を拒否する。 | 元imageへの単純な戻しを採用しない。最新プロフィールを失わず扱える戻し先source/imageの確認が必要。元の控えへ置き換えて最新設定を巻き戻さない。 |
| プロフィールのmodelと予定 | 新sourceのmodel構文は角括弧を許すが旧sourceは拒否する。予定schemaは同名でも、新sourceはrevisionを追加し更新時の照合へ使う。 | 最新の実model・effort・fastMode・予定の意味が戻し先で保たれること。schema名が同じというだけで互換としない。角括弧の人工例は構文差の確認だけで実modelの存在を示さない。 |
| `createApplicationServices` → `BellTeamMemory.initialize` | 記憶・RAGの保存先は既存root配下。新sourceには検索用の `memory_index`、`sections`、`section_index`、`index_state` の作成処理がある。SQLiteはWALを使う。 | 実DBとWALを整合して保存・復旧できる通常手順と、候補・戻し先での最新データの読み書き確認が必要。稼働DBの本体fileだけをコピーした物を復旧点にしない。 |
| `Onboarding` と通常起動 | onboarding保存先は既存root配下を保つが、認証応答の扱いは変更されている。通常起動は初期化後にHTTP、予定、自己開始・席の監視を開始する。 | 生きている認証flowと審査用途を調整し、同梱Aitermとの通常接続・認証を確認する。importや起動確認を実データで先行実行しない。 |

`FeatureSettings`、`OwnerProfile`、`UserRules`、`Subscriptions` の4sourceはこの2commit間で同bytesである。これは実設定・資格情報・保存先の同一性や候補全体の互換性を保証しない。全startupの実行、DBの往復、実UID/ACL/mount、通常TLSは今回確認していない。

## Dexと実反映へ渡す条件

Dexの修理は既存 `Dockerfile.dex` のCA束に限定し、vendorの版・user・entrypointを維持する。現在の審査用Dex設定、DB backend・schema・保存先と最新内容は未読で、過去の合成memory storageによるOIDC結果では代替しない。選定した候補の版・原本と実設定・通常TLS/OIDC、最新DBの保持・戻しを対象別に確認する。

配布担当は受入source/imageと公開参照の原本を渡し、トロニーは現在の設定・最新データと戻し、通常接続・対象別反映を持つ。実整合復旧点、最新データの確認方法、互換な戻し先、用途調整・対象別許可・開始条件が揃うまでは更新しない。新しい移行器や専用host補助は追加せず、元の設定やDBを初期化して不足を埋めない。
