# 現行公開サーバーとAppleの互換試験入口

この枝は公開server source `6d4941011a775f04680739a3e472ab53e4a5d167`を親とする試験専用枝で、mainへ統合しない。`src/`を変更せず、PR50のf06db95のhelperをコピーし、初回のprimeだけ旧APIのrooms.messages/store.entriesへ合わせた。

checkoutのHEADは試験ファイル追加分も含む。製品sourceの根拠は上記6dと`git diff 6d4941011a775f04680739a3e472ab53e4a5d167 -- src/`が空であること。CLIで実行しているのは人工transportであり、公開imageのAiterm0.60.1やGrok認証そのものを実行する試験ではない。

```sh
BELLTEAM_INTEGRATION_PORT=18894 node test/helpers/apple-integration-server.mjs
```

Appleの隔離Debug checkoutへ、既存の`-bellbot-preview -bellbot-preview-server http://127.0.0.1:18894 -bellbot-preview-events`を渡す。PR50候補helperは18893、公開旧版は18894と分けられる。保存先はOS一時領域、SIGINT/SIGTERMで終了・削除する。両HTTPサーバーとも127.0.0.1だけへbindする。

人工Botはbot-one/ユキ、bot-two/ハル、bot-three/ナギ、room planning/ideas。GETまたはPOSTの`/test/<場面>`と`/test/scenarios`はPR50 helperと同じ。`/test/proof`には要求/statusと配信frameを記録する。

| 確認項目 | 入口と期待 |
| --- | --- |
| 初期ready | 実製品がready `{}`を返す。Appleは全体照合 |
| 追加API無し | `/api/ai-control`は実製品が404/NOT_FOUND。helperが新APIを偽装しない |
| 新着 | `/test/bot?bot=bot-two`、返答のtextが該当会話に現れる。旧版は宛先無しのmessages `{at}`を通知 |
| peer/過去status/room | `/test/peer`、`/test/status`、`/test/room`。旧通知後に実GETで変更を取得 |
| queue/カード/予定 | `/test/queue?bot=bot-one&room=planning`、`/test/question`、`/test/bot-schedule`。人工状態と実GET/旧通知を照合 |
| 再接続 | `/test/reconnect`でSSE終了、次の接続は実ready `{}` |
| 初期化/証拠 | `/test/reset`は起動前、`/test/clear-proof`は接続/データ保持で記録だけ消去、`/test/proof`で確認 |

ここでのサーバー試験は、旧サーバーが何を返すかの証拠である。Apple側の実build番号・新API404の扱い・旧通知後の画面更新は、Apple担当の実UI試験の結果を別に返却する。実配布build58と未配布受信候補を区別し、source SHA/試験範囲を記録する。端末別の同梱CLI、匿名installer、公開タグの受入はセンチの検証結果を参照する。

サーバーの focused 試験：`node --test test/apple-public-compat.test.mjs`。
