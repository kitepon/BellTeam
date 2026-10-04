# Web UI ベースライン

実行日: 2026-08-31

- BellTeam `main`はclean、remote未設定。
- 既存focused testは6件すべてgreen。
- メインサーバーのBellTeamコンテナはhealthy。
- `bell-grok-a`と`bell-grok-b`のtmuxが稼働中。
- Caddyは`/home/kite/license-server/Caddyfile`を正規設定として使用している。
- Cloudflare Tunnelはremote-managed tokenで稼働している。
- `peertable.kitepon.dev`は名前解決するが、`team.example.com`は着手時点で名前解決しない。
- 既知のCaveatにBellTeam公開経路の該当記録はなかった。
