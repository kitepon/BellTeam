# Apple購読確認Worker

利用者のサーバーからAppleの署名付き取引を受け取り、Appleの最新状態を照会する。会話本文・AIの認証情報は受け取らない。無料のDurable Objectsで検証を行い、ストレージAPIとアラームは使わない。Cloudflare内部にはSQLiteを伴う。商品・アプリの識別子は`product.json`が正本。

## 照会

`POST /v1/subscriptions/verify`へ次のJSONを送る。

```json
{ "signedTransaction": "Appleの署名付き取引（JWS）" }
```

Sandboxの実応答では`appAppleId`が省略されるため、Sandboxに限り省略を認める。値がある場合は商品設定との一致を確認し、Productionでは必須とする。

Apple公式ライブラリで提出取引を検証し、元の取引IDで`Get All Subscription Statuses`を呼ぶ。最新取引と更新情報も検証する。有効な購読では`entitled: true`と`validUntil`を返す。更新停止は支払済み期間を短縮せず、期限切れ・支払い再試行・返金では`entitled: false`を返す。Appleが示す支払い猶予期間はその期限まで有効にする。

Appleとの通信失敗・設定不足・署名の不一致は、それぞれエラー応答とする。期限切れの応答へ置き換えず、再試行や本番からSandboxへの切替もしない。端末数・サーバー数の台帳は作らない。

Apple公式クライアントの認証・応答解析は維持し、HTTP通信の拡張点だけを標準`fetch`へ置き換える。Workersの`node-fetch`変換では、公式ライブラリのCommonJSの`default`参照が関数にならず、Appleへの通信前に失敗するため。

## 証明書の検証

`apple-roots.json`はApple公式PKIから取得した実サービス用のルート証明書。署名・証明書チェーン・Appleの拡張OID・アプリ・実行環境を確認する。公式ライブラリのオフライン検証を使い、証明書の有効期間は署名日時で確認する。OCSPによる証明書のオンライン失効照会は行わない。購読の失効・返金はAppleの最新購読状態と検証済みの取引から判定する。

公開CPU試験・自動試験の証明書と鍵は、実サービスの信頼ルートに含めない。

## 設定と公開

App Store Connectの管理用キーとは別に、「ユーザとアクセス → 統合 → アプリ内課金」で作成したキーが必要。本文をリポジトリやアプリへ含めない。

```sh
npm ci
npm exec --yes --package wrangler@latest -- wrangler secret put APPLE_KEY_ID --env sandbox
npm exec --yes --package wrangler@latest -- wrangler secret put APPLE_PRIVATE_KEY --env sandbox < /absolute/path/SubscriptionKey_KEYID.p8
```

本番では`--env ""`を使う。Issuer IDと実行環境は`wrangler.jsonc`、キーIDと秘密鍵はCloudflareのsecretに置く。本番とSandboxは別のWorkerとし、各Workerは設定された環境だけを認める。

公開は対象commitが`origin/main`の祖先であることを確認してから行う。

```sh
npm exec --yes --package wrangler@latest -- wrangler deploy --env sandbox
```

入口のWorkerはDurable Objectを呼び出し、検証はDurable Objectの標準CPU上限で実行する。無料プランへ配置できない`limits.cpu_ms`は指定しない。オーナーの承認を得た購入専用キーは本番とSandboxへ登録済み。両環境への配置と不正リクエスト・署名へのエラー応答は確認済み。照会先は`endpoints.json`、配置と検証の状況は`../../docs/subscription-setup.json`が正本。Sandboxの実購入情報を公開WorkerとiPhoneからのサーバー反映で検証済み。端末の復元ボタンの確認とProduction APIの認証確認は未完了。

## 試験

リポジトリ直下で`npm ci`してから、対象だけを実行する。

```sh
node --test test/subscription-worker.test.mjs
```

試験専用に生成した公開証明書・鍵を使い、実際の公式検証器を通す。Apple APIの通信相手だけを試験応答に置き換える。実購入・端末からの復元・Apple APIへの実通信はこの試験の範囲外。
