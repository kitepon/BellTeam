# BellTeam Web UI 計画

## 目的

`https://team.example.com`に、ユーザーがBotを一覧し、1体を選んで直接会話できるモバイル優先のWeb UIを公開する。

## 受入条件

- 一覧画面に登録済みBot、稼働状態、直近活動が表示される。
- 個別画面ではユーザーと選択Botの発言だけを通常の吹き出しで表示する。
- Bot間の送受信は全文を通常表示せず、1行の活動記録として表示する。
- Bot間の活動記録はタップすると宛先・送信元・本文・時刻を展開できる。
- UIから送った本文が対象Botのtmuxへ届き、Botが`sendmessage(target="user", message)`で返した内容がUIへ反映される。
- 公開APIはBellTeam専用アクセストークンなしでは利用できない。
- メインサーバーのコンテナがhealthyで、公開URLをスマホ幅とデスクトップ幅の両方で確認できる。

## 非目標

- Peertableの円卓・着席UIは作らない。
- Bot間メッセージをユーザーとの会話へ全文複製しない。
- 音声入力、添付、検索、新規Bot作成はまだ実装しない。
- Codex認証は扱わない。

## 実装範囲

- BellTeam supervisorのHTTP APIと静的UI配信。
- ユーザー宛を予約先として扱う`sendmessage`拡張。
- JSONLから個別タイムラインを構成する会話ストア。
- SSEによる更新通知。
- `team.example.com`のCaddy公開経路。

## 既知の罠

- 公開UIからalways-approveのBotを無認証操作させない。
- Bot間メッセージとユーザー会話を同じ吹き出し表現にしない。
- CLIごとのtmux入力差をWeb側へ漏らさない。
- DNSが未作成なら、Caddy設定だけで公開成功と扱わない。

## 検証

- `npm test`
- HTTP APIの認証・一覧・送信・タイムラインfocused test
- 390px幅とデスクトップ幅の視覚確認
- メインサーバーでUI→Bot→UIの実通信
- 公開URLのHTTPS smoke

## 並列化判断

UI、API、公開設定は同一repoの契約と受入が密結合するため親が直列に実装する。別writerは起動しない。
