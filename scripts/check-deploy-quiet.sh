#!/bin/sh
# オーナーがquietを条件にした反映用。端末を操作せずqueueとprocess metadataだけを読む。
set -eu
cd "$(dirname "$0")/.."
except=${1:?the permitted Bot ID is required}
case "$except" in bot-*[!a-zA-Z0-9_-]*|*[!a-zA-Z0-9_-]*|'') exit 2;; esac
docker exec -i bellteam /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node --input-type=module - "$except" < scripts/check-deploy-quiet.mjs
