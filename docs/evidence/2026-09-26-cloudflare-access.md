# 2026-09-26 Cloudflare Accessへの移行

## 変更

オーナーの依頼で、BellTeam独自のWebアクセスキーをCloudflare Accessによる本人認証に置き換えた。`team.example.com`全体に自己ホスト型Accessアプリを作り、オーナーのメール完全一致のAllow policyだけを設定した。BellTeamの公開HTTP入口では`Cf-Access-Jwt-Assertion`の署名・発行元・audience・期限を検証する。ブラウザのキー入力画面とBearer送信を削除した。

コンテナ内のMCPは従来どおりloopbackの内部APIを使う。本番反映スクリプトの待ち行列保存、health確認、Bot状態確認もコンテナ内の入口に揃えた。旧Webキーは新コンテナへ渡されず、成功確認後に本番の`runtime/web.env`を削除した。

## 実測

- 変更に関係する個別試験と全170試験が成功。
- `scripts/deploy.sh`の正規入口で反映し、コンテナhealthと内部APIを確認。
- 未認証の公開`/`はCloudflare Accessログインへ302で移動した。
- 公開ポートへの直接接続は、未認証の`/`・`/api/session`とも401。旧アクセスキーを送った`/api/session`も401。
- Cloudflareで短命の試験用サービス資格と許可policyを作り、公開`/api/session`が200・`authenticated: true`を返すことを確認した。試験後はpolicyと資格を削除し、BellTeamアプリに本人メールのAllow policyだけが残ることをAPIで確認した。
- オーナー本人のブラウザでのメール認証は、本人のログイン操作が必要なため未観測。

## 参照した仕様

- [Cloudflare公式: 自己ホスト型アプリの公開](../../rag/cloudflare-access/raw/self-hosted-public-app.md)
- [Cloudflare公式: Access JWTの検証](../../rag/cloudflare-access/raw/validate-jwts.md)
