# 会話履歴取得の互換性能修理

Apple担当ベルからownerの追加指示として、アプリ高速化と並行するサーバー所有部分の修理を受領。baseはmain 9e7cba9。Appleコード、本番、Aiterm製品コードは変更していない。

## 問題と修理

`/api/bots`は各Botの履歴を作るたび、全Bot共通の履歴を再走査していた。ConversationStoreに既存レコードのBot別索引と表示配列を持ち、追記/配送状態変更があった会話だけを無効化する。ファイルは引き続き読取時に確認するため、fs.watch通知の有無だけで新規記録の可視性を決めない。

ルーム履歴はGETのたびにJSONL全行をparseしていた。RoomHistoryが追記分だけを解析し、状態/ルーティング変更を過去の発言へ重ねた表示配列を再利用する。ファイル置換/縮小/同サイズ更新/消失は再読取へ進め、過去に返した配列は後続更新で書き換えない。改行なしの有効JSON末尾と、不正な完全行のエラーも保持する。

HTTP側では同じ履歴とカード内容なら時刻順配列を再利用し、画像URL等の応答整形をページ選択後へ移した。カードの状態変更も署名比較で反映する。初回や対象会話の変更後には、その会話の表示配列再作成とsortが残る。履歴増加時の配列/Mapのcopyも残るので、全処理をO(1)にしたという意味ではない。

`limit/before/after`、既存afterの全差分返却、items/has_more、一覧recent、認証と失敗応答の契約は変更していない。SSEにも変更なし。宛先/種別の追加案は別文書で検討する。

## 回帰と互換確認

- 新規4試験は同じbaseで3fail/1pass、修理後4pass。全Bot読取の無関係履歴走査、変更なしroomの再parse、ページ外画像整形を修正前に検出した。
- 過去delivery/routing、Bot間両端、末尾/追記、ファイル縮小/置換、不正JSON、既存before/after、カード回答変更を確認。
- 関連7ファイルは77pass/0fail/0skip。通常npm testは関所が関連240件へ絞り240pass。全件指定`TESTGATE_FULL=1 npm test`で639pass/0fail/0skip/0cancel。
- 同じ合成データに対する5 endpointとstatus追記後の計6 HTTP応答は、before/afterで実bytes数とSHA-256がすべて一致した。すべての入力についての数学的証明ではなく、回帰と当該fixtureでの互換確認。

## 合成HTTP計測

Node v26.12.1、60 Bot、直接メッセージ30,000件＋配送状態10,000件、5ルーム各500発言。本文は人工文字列のみ。隔離process/一時ディレクトリ/loopbackのHTTP完了までを計測。各endpointの初回後7回の中央値。各endpointは同じ順に実行しているため、2番目以降の初回はprocess全体のcold起動ではない。

| endpoint | before中央値ms | after中央値ms | 応答bytes |
| --- | ---: | ---: | ---: |
| /api/bots?avatar=omit | 133.89 | 3.25 | 47,020 |
| /api/rooms?avatar=omit | 3.91 | 0.85 | 3,676 |
| Bot messages?limit=10 | 1.97 | 0.41 | 5,407 |
| Room messages?limit=10 | 1.17 | 0.63 | 6,047 |
| Bot messages?after=m0&limit=1 | 3.12 | 1.21 | 268,307 |

最後の行は既存afterがlimit=1でも499行を返す契約の維持を含む。過去statusを1行追記した直後の単発は2.84→2.99msで改善を主張しない。/api/botsの初回は186.41→90.08ms。これらは合成サーバー値であり、iPhone実機の速度や本番通信の測定ではない。

追加の同条件/GC明示試行では、読取後の保持heapは53.54→61.35MiB（約7.8MiB増）だった。索引・表示配列を保持する費用がある。総RSSは試行の一時割当/GCに左右されるため、この値から本番メモリ使用量を予測しない。キャッシュはprocess内だけで、正本JSONLから再構築される。新しい永続ファイルや配送キューは作らない。

再現用は`scripts/benchmark-history-http.mjs`。baseと修理版それぞれのcheckoutで依存を導入した後、同じスクリプトに対象repoと出力JSONの絶対パスを渡す。保持heapを見る時は`node --expose-gc`を使う。生成するログは人工履歴のみで終了時に削除する。

当席原本は`integrations/apple-performance-20261022/`のserver-regression-before.log、server-focused-after.log、server-full-explicit-after.log、server-benchmark-{before,after}.json、server-memory-{before,after}.json。

## 独立レビューで判明した改行なし末尾と縮小の組合せ

ベルが、末尾に有効JSONがあり改行だけがない状態を読取後、同じinodeのファイルを縮小し、新しい総sizeが最後の改行offset以上となる場合の欠陥を再現した。初版004226aはoffsetとの比較だけで縮小を判定し、以前のprefixを残した位置から新ファイルの途中をparseしてエラーを繰り返した。従来の単独の縮小試験と単独の末尾試験では、この組合せを検出できていなかった。

同じ比較を使うConversationStoreも確認し、room/直接会話の2回帰を追加して初版で2件とも失敗することを確認。各readerが最後に観測したファイル総sizeをoffsetと別に保持し、総size減少なら正本から全再構築する。同サイズの内容変更判定も観測総sizeとmtimeで行う。不存在時は観測サイズを捨てる。Bot索引/過去statusを含むキャッシュも再構築される。

回帰は、同inode/有効な改行なし末尾/総sizeが旧offsetを下回らない縮小、同サイズ書換え、繰返し読取、縮小後の通常追記と配送状態更新、以前の応答保持を確認。関連4ファイル52件成功、追補後の`TESTGATE_FULL=1 npm test`は641pass/0fail/skip/cancel。初版の性能表は004226a時点の計測で、この追補で性能再計測は行っていない。この時点では本番反映とmain統合は未実施だった。

## ログ画面とAitermの境界（調査結果）

現行BotScreenViewは開いている間`GET /api/bots/{id}/screen`完了→2秒sleepを反復する。AppleからisRunningを別HTTP呼出ししているコードではない。サーバーのAitermTransport.screenはisRunning→runningBots([bot])→pty_listを1回、onlineならpty_read(screen:true,raw:true,timeout:0,lines:40)を1回。停止席ならlist1/read0。別の`GET /api/bots`も自身のrunningBots(all)でpty_listを1回行うため、画面pollとSSE由来の一覧GETが重なれば複数listが生じ得る。

このコード上の呼出し数を実機遅延の原因確定とはしない。pty_read単独の停止席/世代変更応答を未確認のままlistを省く修理や、席状態のTTLキャッシュは行っていない。Aiterm所有APIの意味を変えない。今回の互換履歴修理を先行する。

## 反映と戻し方

この段階では実装/隔離検証のみで、本番再作成、通常deploy、実Bot操作、本文再送は0だった。反映はownerの個別許可後に正規scripts/deploy.shを1回行い、全Botが中断して次のメッセージで起動する影響を事前に伝える条件とした。

互換修理は保存形式/APIを変えないので、コード上はこの修理commitのrevertで旧方式へ戻せる。ただし本番rollbackも再作成を伴うため別の許可が必要。過去の旧0.61.4 imageが消えている制約があり、同一旧imageへの即時復帰を約束しない。実行前に現image IDと保存経路を本番担当が具体的に確認し、未確認ならその制約をownerへ示す。この文書作成時点では本番の状態を照会していなかった。

## 2026-10-23 本番反映の実測

PR49はmain `59df581b6c7cd391891d14c64245b37b8f6b9aa8` に統合された。オーナーが決裁箱「サーバー高速化修理をBellTeam本番へ1回反映してよい？」に `deploy_once` で回答した。最初の実行前照合では共有checkoutにApple担当の未commit差分15 pathと別HEADがあり、ベルはdeployを実行せずトロニーへ返した。Apple担当が差分を専用branch `apple-performance-58` のcommit `13996c7c6874be4018873c4012dc19f2b0286866` に保全した後、ベルはbranch/main、HEAD、origin/main、GitHub remote mainが承認対象と一致し、差分が空であることを再確認した。

反映前の本番はHEAD `c3a5edfa51e65193ae5faee09c2456ae398b1507`、tracked clean、health正常。稼働イメージID `sha256:db72d49595675a057af63adedec27b60526fc4a943d549f049ff42328690e199` は保全タグ `bellteam-rollback:20261022-before-pr49` と一致し、競合するdeploy processは無かった。ベルが `sh scripts/deploy.sh` を1回だけ実行し、本番HEADは `59df581b6c7cd391891d14c64245b37b8f6b9aa8`、tracked cleanとなった。処理待ち6件（bot-a855525f、bot-7b140b27、bot-47fad91c）は `runtime/backups/queue-before-deploy-20261023T0442.json` に保存された。正規スクリプトのログは `runtime/backups/deploy-20261023T044238.log`、末尾は `deploy-exit=0`。

新コンテナIDは `1cde4781af369e64f8739ca8bca49a44f2524cea98fa6c252846e470ae86f887`、イメージIDは `sha256:1044f0a494517403a71279817e132e515c516030cc915b4e9accdf46e38ff0a1`。稼働状態とDocker healthは正常、内部healthzは `{"status":"ok"}`。CLIはNode v26.12.1、Codex CLI 0.163.0、Claude Code 2.1.308、Grok 1.0.67、Cursor 2026.10.22-27dcf5f、GitHub CLI 2.103.0、Aiterm 0.61.5、Throughline 0.16.41。60 Bot中0席onlineで、実Botへの新規送信は行っていない。旧イメージの保全タグは旧IDのまま保持した。

同じ内部読取APIへの各1回の所要時間は次のとおり。外部ネットワークとアプリ画面の時間を含まず、各1回なので性能改善の統計的判定には用いない。

| endpoint | 反映前HTTP/秒 | 反映後HTTP/秒 |
| --- | ---: | ---: |
| `/api/bots?avatar=omit` | 200 / 0.649695 | 200 / 0.041462 |
| `/api/rooms?avatar=omit` | 200 / 0.024912 | 200 / 0.021506 |
| Bot履歴 `?limit=10` | 200 / 0.036412 | 200 / 0.019761 |
| Room履歴 `?limit=10` | 200 / 0.019551 | 200 / 0.017077 |

再作成後の10分範囲のコンテナログでは `EXECUTION_UNCONFIRMED`、`EXECUTION_UNSUPPORTED`、`delivery error`、`scheduler error`、`SERVER_HTTP_500` は検出0。これは読取APIの疎通と起動後ログの確認であり、実Bot配送・iPhone画面・すべての履歴条件の本番受入ではない。追加deploy、個席restart、未知POST、旧failed本文の再送、rollbackは行っていない。rollbackの再作成には別の個別許可が必要。
