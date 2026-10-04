# 2026-09-25 BellTeamクリーン再設置

## 依頼と初期状態

オーナーは以前のBot・会話の復元を求めず、クリーンな再設置を指定した。本番の `/home/kite/BellTeam`、コンテナ、永続データ、公開DNSレコードは存在しなかった。手元の未追跡ファイルには触れていない。

## 再設置

- 手元の追跡ファイルを本番の既定パスへ配置し、本番独立Git履歴を初期化した。
- 本番の `config/bots.json` はBot空配列とした。手元の古いseedを本番へ流用していない。
- `scripts/seed-auth.sh` でCodex・Grokの既存認証ファイルとWebアクセストークンを投入した。値は出力・記録していない。
- `docker compose up -d --build` で新しいコンテナとvolumeを作成した。
- CaddyのBellTeamルートを戻し、Cloudflare Tunnelのingressへ同一のCaddy originを追加した。Tunnel構成はversion 37から38。Cloudflare DNSへproxied CNAMEを作成した。Caddy変更前のtarは本番の `/home/kite/backups/license-server-pre-bellteam-20260925.tar.gz`、Tunnel設定変更前のJSONは `/home/kite/backups/cloudflare-tunnel-pre-bellteam-20260925.json` に保持した。Tunnel更新の仕様は [Cloudflare公式API資料](../../rag/cloudflare-tunnel/raw/update-configuration.md) を参照する。

## 初回Bot配送で見つかった欠陥と修理

Codexの一時Botを作り、ユーザーメッセージを送ると、CLIの「Hooks need review」で初回起動が止まり、Aitermは入力受付待ちの失敗を返した。BellTeamはBotプロジェクトを自身で作り、Codex・Claudeの設定上は信頼済みにするが、Aitermの `agent_launch` へ `trust_project` を渡していなかった。所有するBotプロジェクトの起動で `trust_project: true` を渡すよう修理した。Aitermはこの意図を受けてCodexの既知の初回確認を進める。

新規DNSに対する手元Macの名前解決が一時的に失敗し、従来の `scripts/deploy.sh` では公開healthの確認に進めなかった。公開URLは本番サーバーから正常に解決できたため、反映スクリプトのhealth確認元を本番サーバーに揃えた。

## 検証

- 変更に直結する21試験と全169試験が成功。
- 修正版を `scripts/deploy.sh` の正規入口で本番へ反映。コンテナhealthは `healthy`。
- Cloudflareを通した `/healthz` はHTTP 200と `{"status":"ok"}`、Web UIの `/` はHTTP 200。
- 更新後のTunnel構成からBellTeamのingressを除くと、変更前の32ルールと一致した。CaddyfileもBellTeamの追加ブロックを除くとバックアップと一致した。
- 公開 `/api/session` は未認証でHTTP 401、アクセスキー付きでHTTP 200。
- Codexの一時Botへユーザーメッセージを送り、画面と会話APIの双方で「接続確認できました」を確認。Throughline Observerは同Botの完了ターン1件を返した。
- Grokの公式ログイン後、一時Botへユーザーメッセージを送り、会話APIで「Grok接続確認できました」を確認。
- 一時BotとAitermセッションを削除した。新規環境で作った試験会話だけを消去し、Bot 0体、ルーム0件、待機0件、会話ログ0件へ戻した。
- CodexとGrokはログイン済み。Claude・Cursorは公式CLIのログイン画面でオーナーの認証を待っている。
