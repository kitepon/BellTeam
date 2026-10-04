# Web UI 統合確認

実行日: 2026-08-31

## メインサーバー

- BellTeam commit `a458f61` を `/home/kite/BellTeam` へfast-forwardで反映。
- `docker compose config --quiet` 成功。
- BellTeam imageを再構築し、コンテナはhealthy。
- `http://192.168.1.2:18891/healthz` は200。
- 無認証 `/api/bots` は401、正規token付きは200。

## 実Bot通信

- Web APIから `bell-grok-a` のtmuxへユーザーメッセージを配達。
- `bell-grok-a` が `sendmessage(target="user")` で返答し、タイムラインへ `message/incoming` として反映。
- `bell-grok-a` から `bell-grok-b` へ送り、`bell-grok-b` から `bell-grok-a` へ返答する一往復を実施。
- Aのタイムラインではそれぞれ `peer/sent` と `peer/received` になり、通常の会話吹き出しと分離された。

## 公開経路

- Caddyへ `team.example.com -> 192.168.1.2:18891` を追加。
- 変更前Caddyfileは `.caddyfile-backups/Caddyfile.pre-bellteam-20260831T142918` に退避。
- Caddy validate成功。Caddy再作成後、BellTeam経路と既存Peertable経路はいずれも200。
- Cloudflare Tunnel `home-server` へ `team.example.com -> https://caddy:443` を追加。
- TLS設定は既存Peertableと同じく `noTLSVerify` と `matchSNItoHost` を有効化。
- CloudflareがDNSレコード作成成功を表示。
- 外部 `https://team.example.com/healthz` は200、UIは200、無認証APIは401、正規token付きAPIは200。
- 公開URLを390x844で描画し、アクセスキー画面を確認。
