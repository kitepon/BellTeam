# focused test 証跡

実行日: 2026-08-31

## `npm test`

結果: green

- `sendmessage` が宛先の起動、配達、JSONL記録を順番に行う。
- 未定義宛先と空本文を明示エラーにする。
- 実tmuxソケットで、存在しないセッションを起動して入力を直接投入する。
- supervisorが停止シグナルを受けるまで生存し、正常終了する。
- MCPの送信元を登録済みBotのプロジェクトパスから解決し、登録外のパスは明示エラーにする。

6 tests / 6 pass / 0 fail。

初回のサーバー起動では、未解決のtop-level awaitだけではNodeのイベントループが維持されず、終了コード13で再起動を繰り返した。常駐タイマーを停止シグナル待機中だけ保持するよう修正し、この再現条件をfocused testへ追加した。

Codexの初回起動では、CLIが任意の親環境変数をMCPへ渡さないため送信元IDを解決できず、MCPの握手が閉じた。MCPの作業ディレクトリとBot台帳のprojectを照合して送信元を解決するよう修正し、未知のパスでは推測せず停止するfocused testを追加した。

## Compose

ローカルのDocker CLIにはComposeプラグインが無く、`docker compose config`は実行不能だった。メインサーバーのCompose 5.3.1では`docker compose config -q`が成功した。

## メインサーバー実通信

結果: green

- `bell-grok-a`だけを先に起動し、`bell-grok-b`のtmuxが存在しない状態から開始した。
- `bell-grok-a`がMCPの`sendmessage`を呼び、ツールが`bell-grok-b`を起動して直接配達した。
- `bell-grok-b`が受信内容に従って同じ`sendmessage`を呼び、`bell-grok-a`へ返信した。
- `direct-messages.jsonl`にA→B、B→Aの`delivered`が2件記録された。
- 両tmux画面で直接メッセージの受信と配達結果を確認した。
- コンテナは`healthy`、再起動なしで稼働した。

往路delivery: `308616e2-0ae0-4611-bbcf-dc0efe83d270`

復路delivery: `26142a4f-1de3-4f98-bc1b-d87ead13fc52`
