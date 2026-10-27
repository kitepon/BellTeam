# Dex候補のsourceと公開原本の受渡し

配布担当センチが通常のbuild環境・対象arch・registry付き候補tagと公開範囲を決め、トロニーがsourceと製品互換を受け入れる。ここには登録先の既定値を置かない。以下は条件成立後の一回分の手順であり、build・pushや審査用コンテナの変更を今許可するものではない。既存の開始不可・資源・承認条件を保つ。

## commit済みsourceから候補を作る

受入対象のcleanなcheckoutのルートで行う。`DEX_CANDIDATE_TAG` はセンチが選んだ今回のtagを指定する。新しい `runtime/review-dex-ca` へ原本を保存し、既存の控えは再利用しない。親Dex imageから継承したvendor revisionを修理sourceとはせず、[通常buildのlabel](https://docs.docker.com/reference/cli/docker/buildx/build/)へ今回のGit commitを指定する。

```sh
set -eu
: "${DEX_CANDIDATE_TAG:?配布担当が選んだregistry付き候補tagを指定してください}"
evidence=runtime/review-dex-ca
mkdir -p runtime
mkdir "$evidence"
mkdir "$evidence/context"
source=$(git rev-parse HEAD)
printf '%s\n' "$source" > "$evidence/source.txt"
printf '%s\n' "$DEX_CANDIDATE_TAG" > "$evidence/candidate-tag.txt"
git show "$source:distribution/apple-review/sec021/Dockerfile.dex" > "$evidence/Dockerfile.dex"
docker build --pull --no-cache --file "$evidence/Dockerfile.dex" \
  --label 'org.opencontainers.image.source=https://github.com/kitepon/BellTeam' \
  --label "org.opencontainers.image.revision=$source" \
  --tag "$DEX_CANDIDATE_TAG" "$evidence/context" \
  > "$evidence/build.stdout" 2> "$evidence/build.stderr"
docker image inspect "$DEX_CANDIDATE_TAG" > "$evidence/image-built.json"
image_id=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[0].Id' "$evidence/image-built.json")
docker run --pull never --rm --network none --read-only --cap-drop ALL \
  --entrypoint /bin/cat "$image_id" /etc/ssl/certs/ca-certificates.crt \
  > "$evidence/ca-certificates.crt" 2> "$evidence/ca.stderr"
```

現在のDockerfileは `COPY` を使わないので、空のcontextでbuildする。CA原本の採取にも保存したlocal image IDを使い、tagを再解決しない。審査用の設定・資格情報・DB・HOMEを渡さない。失敗や終端不明では出力を残して止め、同手順の再送・imageの自動削除はしない。

センチとトロニーは、Git commitと保存Dockerfile、imageのsource label・arch・user・entrypoint、実bundleのG3/AAA無し・G1保持を照合する。Dexの版、通常TLSと合成configのOIDC動作の結果原本も同候補へ結ぶ。名前やパッケージ版、過去の隔離結果だけでは受け入れない。DexはOS束を確認する対象で、BellTeam本体のNode同梱根の確認を代用しない。

## 受入後に同じ候補をpushする

必要な事前受入と公開範囲の確認が揃った後、同じcheckout・候補tag・保存先を使う。[通常のpush](https://docs.docker.com/reference/cli/docker/image/push/)の終端と出力を保存する。再buildや別tagへの自動代替をしない。

```sh
set -eu
: "${DEX_CANDIDATE_TAG:?今回の候補tagを指定してください}"
evidence=runtime/review-dex-ca
image_id=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[0].Id' "$evidence/image-built.json")
docker image inspect "$DEX_CANDIDATE_TAG" > "$evidence/image-before-push.json"
test "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1]))[0].Id' "$evidence/image-before-push.json")" = "$image_id"
docker push "$DEX_CANDIDATE_TAG" > "$evidence/push.stdout" 2> "$evidence/push.stderr"
docker image inspect "$image_id" > "$evidence/image-published.json"
```

pushが成功した出力のdigestと同じrepositoryの参照をセンチが照合し、`DEX_PUBLISHED_REF` に `repository@sha256:...` を指定する。local IDや古いcache tagから値を作らない。RepoDigests文字列だけでも公開済みとはしない。

```sh
set -eu
: "${DEX_PUBLISHED_REF:?今回のpush結果に一致するrepository@sha256参照を指定してください}"
evidence=runtime/review-dex-ca
printf '%s\n' "$DEX_PUBLISHED_REF" > "$evidence/published-ref.txt"
docker buildx imagetools inspect --raw "$DEX_PUBLISHED_REF" > "$evidence/manifest.json" 2> "$evidence/manifest.stderr"
docker buildx imagetools inspect --format '{{json .Image}}' "$DEX_PUBLISHED_REF" > "$evidence/registry-image.json" 2> "$evidence/registry-image.stderr"
```

registryの[manifestとimage情報](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)を、push結果・arch・config・source label・CA採取元のimageへ結ぶ。indexなら対象platformのmanifest/configも対応を確認する。Dockerが返すlocal ID、OCIのindex/manifest/config digest、保存ファイルのSHAは区別し、照合のために原本値を補正しない。

これらは各CLIの出力原本で、HTTP wire bytesとは呼ばない。センチとトロニーは結果と各原本のSHAを自席へ保存し、対応が確認できた同じimmutable参照だけを `BELLTEAM_REVIEW_DEX_IMAGE` へ渡す。原本欠測・push失敗・結果不明のときは空欄を維持する。審査用の現在設定・最新DB保持・戻し・通常接続と対象別再作成許可は別工程で、公開候補の受入だけでは対象を対応済みにしない。
