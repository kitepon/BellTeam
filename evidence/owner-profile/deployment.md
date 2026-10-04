# オーナープロフィール本番反映

反映日: 2026-09-01

## 反映

- ローカル反映元: `f18325e`
- 本番サーバーcommit: `478f1d6`
- 本番パス: `/home/kite/BellTeam`
- `docker compose up -d --build`で再ビルド・再起動した。
- 既存の`runtime/data`を維持し、オーナー正本がない場合だけ既定値で初期化した。

## 公開後smoke

- コンテナ: running / healthy / failing streak 0。
- `https://team.example.com/`: HTTP 200。
- `https://team.example.com/healthz`: HTTP 200、`status=ok`。
- 認証済み`GET /api/owner`: HTTP 200、`bellteam.owner-profile.v1`を返した。
- 公開HTML: `owner-profile-button`を含む。
- `/srv/bellteam/owner/profile.json`に対応するhost保存ファイル: mode 600。
- 起動後10分のerror / exception / fatal: 0件。
- ローカルと稼働コンテナの製品ファイル30件は一致した。
- 製品ファイルmanifest: `d679d8ba62b3e8222d1d71dbc4b471f786ae51f25ce40b3dd7ae352400382782`。

## 現在の制約

本番の登録Botは0体である。実Botを新規作成して配送smokeは行わず、セッション起動、通常配送、直接連絡、ルーム、予定を覆うfocused testを受入根拠とした。
