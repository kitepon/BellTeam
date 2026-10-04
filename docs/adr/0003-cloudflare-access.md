# ADR 0003: 公開認証をCloudflare Accessに任せる

## 状態

採用

## 決定

`team.example.com`全体をCloudflare Accessの自己ホスト型アプリで保護し、オーナー本人のメールだけを許可する。BellTeamの公開HTTP入口はAccess JWTの署名、発行元、audience、期限を検証する。BellTeam独自のWebアクセスキーとブラウザへのキー保存は廃止する。

Bot用MCPはコンテナ内loopbackのHTTP入口を使う。本番反映スクリプトもコンテナ内からhealthとBot状態を読む。公開入口の`/healthz`は内部監視用に認証なしで返すが、公開URLへのアクセスはAccessが保護する。

## 理由

本人認証をCloudflareの既存の仕組みに揃え、BellTeam独自キーの入力と管理をなくす。公開ポートへの直接接続ではCloudflareのログイン画面を経由しないため、BellTeamでも署名付きJWTを検証する。

## 受入判断

未認証の公開URLはAccessログインへ移り、公開ポートへの直接接続は401を返す。オーナーのAccess認証後はWeb UIとAPIを利用でき、旧アクセスキーを入力する画面は現れない。
