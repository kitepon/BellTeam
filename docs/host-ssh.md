# メインサーバーへの SSH（コンテナ → ホスト）

BellTeam コンテナ内の Bot からメインサーバー（ホスト）へ接続する構成とホスト側設定の正本。

## 接続経路と権限

- Bot はコンテナ内から `ssh main-server` でホストへ入る。
- 接続先は `host.docker.internal`（`compose.yaml` の `extra_hosts` でホストへ向ける）。
- 接続ユーザーはホストの `bellteam`（`/etc/sudoers.d/bellteam` で `NOPASSWD:ALL`。オーナー裁定 2026-09-03、一度撤回のうえ再度許可）。
- 鍵と既知ホストは `runtime/data/shared/tools/ssh/`（コンテナ内 `/srv/bellteam/shared/tools/ssh/`）、接続設定は `runtime/home/.ssh/config`。

## ホスト側のネットワーク・防御設定

- `ufw` で `192.168.240.0/20` → 22 番を許可する。
- `fail2ban` の `ignoreip` にコンテナのネットワークを追加する（`/etc/fail2ban/jail.d/bellteam.local`）。
  - 経緯（2026-09-03 実被弾）：コンテナが `sshd` に失敗を重ねると `fail2ban` がコンテナネットワークを締め出す事象が発生したため。
