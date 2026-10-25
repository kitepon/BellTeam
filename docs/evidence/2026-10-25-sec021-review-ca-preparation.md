# SEC021 審査用本体・Dexの隔離準備

対象は `bellteam-review-bellteam-1` と `bellteam-review-login-dex-1` の2つ。稼働コンテナの停止・再作成、設定・資格情報・永続volumeの読出しやコピーは行っていない。別製品のcall-bridgeと本番 `bellteam` は対象外。

## 現状とsource

| 対象 | 稼働image ID | 隔離した現imageでの観測 |
| --- | --- | --- |
| 審査用本体 | `sha256:e20c9281b3117cddd687a84b640fb95b74d9b6596f9f18e8f18cf500183d91a5` | 配布source `6193e3d42633f375b57920ad087899dc671fa54d`、Debian 13、`ca-certificates 20250419`、Node `v26.10.0` の同梱根に `emSign ECC Root CA - G3`。 |
| Dex | `sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462` | Alpine 3.23.3、`ca-certificates-bundle 20251003-r0`。 |

審査用本体は公開配布image `ghcr.io/quolu/bellteam-server:preview` を参照する。配布sourceも現mainの[Dockerfile](../../Dockerfile)も `node:current-trixie` から始まり、Debianの公式repositoryから `ca-certificates` を導入する。image ID・source commit・公開tagは別の識別子として保持する。審査用本体を修理する正規経路は、受入対象sourceを固定して通常配布imageを再構築する工程である。

## 審査用本体の公式基底image

2026-10-25に `node:current-trixie` を取得し、digest `sha256:a98e6fda54fdbb22d4238054cca9a2a113bcd1191c09193a535aae22f400aa8e` の使い捨てコンテナで測定した。Nodeは `v26.12.1`、DebianのCAは `20250419+deb13u1`。OS bundleとNode同梱根の両方で対象G3とAAAは見つからず、`emSign Root CA - G1` は残った。Node `fetch` とOS `curl` は `https://www.debian.org/` へ通常の証明書検証で成功し、NodeはHTTP 200を返した。[Debianの修正版](../../rag/sec021/raw/debian-ca-20261025.md)と[Nodeの更新](../../rag/sec021/raw/node-ca-20261025.md)にも一致する。

これは**基底imageの確認**であり、BellTeam製品imageの再構築・CLI互換・審査用API接続・現行設定での動作は未確認。現review imageへCA層だけを重ねた物を正規配布候補にはしない。Tronyと配布担当が通常のsource・image受入を行う必要がある。

## Dexの隔離候補

現Dex imageをdigestで固定した[候補Dockerfile](../../distribution/apple-review/sec021/Dockerfile.dex)を、認証設定・資格情報・volumeを渡さずに構築した。最初の `apk upgrade --no-cache ca-certificates-bundle` は `20261020-r0` を導入したが、元imageの保護対象bundleが変更済みだったため、公式の新しいファイルは `.apk-new` に置かれた。稼働に使う旧bundle SHA-256 `657ca6ba4bc43138f89de75fb63794cbfaa897e0e110b069fd1367bd66a5bb6c` にはG3が残った。パッケージ版だけでは更新を判定できない。[Alpineの公式資料](../../rag/sec021/raw/alpine-ca-20261025.md)も、変更済みの保護ファイルを `.apk-new` へ残す挙動を記す。

候補sourceは、この場合に限り `test -s` で公式更新ファイルの存在を確かめ、実bundleへ移す。最終imageは `sha256:ebc163d5f5851ca0e42cd4c9b687014de5baca19be1851df4d2e76e2a9409bec`。Alpine 3.23.3、bundle `20261020-r0`、実bundle SHA-256 `5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b`。対象G3/AAAなし、G1ありを実bundleから確認した。実行user `dex:dex` と公式entrypointを保持し、`dex version` は `v2.45.1`。合成のmemory storage・空のpassword connectorだけでDexを起動し、loopbackのOIDC discovery GETに成功した。さらに、候補内の `wget` から `https://www.debian.org/` へ証明書検証付きで到達した。

初回の不合格imageタグは削除済み。合格した隔離候補タグ `bellteam-sec021-review-dex:ca-20261025-fixed` はmain-server上で受渡しのため保持する。専用の一時Dexコンテナは `--rm` で解放した。

## 反映前に残る条件

1. 審査用本体の正規配布imageを確定sourceから構築し、実imageのOS bundleとNode同梱根、CLI・API互換、人工configでのTLSを照合する。今回確認した基底digestを製品imageのdigestと混同しない。
2. Dex候補を審査用Composeのimage選択へ組み込む工程は未実施。Tronyがsource・候補imageを受け入れ、元のreview用connector・DBと設定を維持する差分と戻し方を照合する。
3. センチの必要事前試験、quiet、審査用2対象それぞれの現在image/source・復旧条件、オーナーの再作成許可を揃える。古いimageへの切戻しは古い信頼根も戻すため、SEC021解消とは扱わない。監査合否はAvistaへ渡す。

上記が揃うまで本番・審査用の稼働コンテナは変更しない。実Auth flow・Apple審査・購読・実Botの操作も今回の隔離試験には含めない。
