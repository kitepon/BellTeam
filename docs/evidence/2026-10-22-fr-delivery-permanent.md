# Fr宛て配送障害と本体の恒久修正

2026-10-22、マルチャーナからフラジャイル宛ての直接配送6520c008が送信発行後の結果不明となり、同じ席への後続103e8c7dは予約時点で拒否された。両方の会話履歴はfailedで、最初の入力が無作用だったとは確認できない。稼働版はAiterm0.61.4。

## 本体で確認した原因と変更

一回予定は、配送の受付に成功した場合だけmarkScheduleRunを呼んでいた。配送が拒否されると予定が期限超過のまま残り、15秒ごとのrunDueが同じ本文を新しい配送IDで繰り返した。例外はその回の走査も止めるため、後続Bot/ルームの期限処理も妨げた。実履歴では17:05の一回予定fa8caa2fが17:32まで繰り返しfailedになり、その後受付された。

通常の配送エラーは記録し、その予定の試行時刻・次回時刻を既存の予定保存形式で更新する。一回予定は無効になり、cronは次の指定時刻へ進む。他の期限処理は続ける。全体停止によるAI_GLOBAL_PAUSEDは従来どおり予定を実行済みにしない。手動の『今すぐ実行』の動作は変えていない。

また、配送APIはAitermの型付き実行エラーをINTERNAL_ERRORへ丸め、入力が届いた可能性をBotへ伝えられていなかった。既存のHTTP500・失敗記録・原因ログを保ち、応答本文に既存code/effect/follow_upを返す。possibleは到達未確認と再送しない案内、not_startedは今回の未発行を明記する。原因の生の本文は公開応答へ渡さない。Bot用MCPの既存API中継でも案内文を読める。

永続キュー、slot自動解除、入力自動再送、独自の新しいIDは加えていない。

## 検証

- 新規の予定試験は修正前3失敗・全体停止の既存意味1成功、修正後4成功。実Bot/RoomRegistryの保存と再読込、他Bot/ルームへの継続、cronの次回、全体停止を確認。関連の予定・全体停止統合を含め26件成功。
- 新規の実HTTP→Bot用API中継試験は修正前3失敗、修正後3成功。型付きpossible/not_startedの保持、再送しない案内、要求1回、生の内部理由を公開しないことを確認。HTTP/席MCP/実行Bridgeを含む関連59件成功。
- 全試験は実装完了時に一度実行し、635件成功・失敗/skip/cancel0。実Bot・本番・Apple通信は使っていない。

## 応急復旧の結果と残るAiterm修理

ownerの対象1席/1回の許可で17:32:23 JSTにrestart_sessionを呼んだ。旧Fr launch41edaa1b/native$0の終了、旧unknown枠の解放、元6520c008 record不変を確認した。ただしrestart自体はEXECUTION_UNSUPPORTEDを記録した。17:32:31の既存予定は予約参照付きで新launch b6215787/native$12へlaunch/send acceptedとなり、Frの実応答が戻った。管理restart全体の成功とは報告しない。

Aiterm担当エレグは、BellTeamの参照無しの管理agent_launchがhandler前に拒否されることを新しい修正前失敗試験で確認した。管理起動の正規経路と、初回sendの貼付け→Enter間の共有graph lock競合経路を製品側で修理中。本番の6520c008がこの競合で失敗したと個別確定したものではない。本体のこの変更だけで初回native障害が直ったとはしない。

Frは元の17時本文を送信し直さず、マルチャーナの保存原本を未処理照合後に回収し、本人へ1通返却済み。元2通のfailed・初回作用不明は保持する。旧BugHub2batch/receipt0の解消とは別。

この段階では、本体修正とAiterm修理を配布候補へ接続し、本番再作成は個別承認を待つ状態だった。

## 公開と本番反映

Aitermの修理HEAD `ae2dd904543d502388f1b6450382e5cbd3f22f6d` は、3環境full gate成功後にmainへfast-forwardで統合した。正規releaseで0.61.5を公開し、release commit・tag `v0.61.5` は `637e6a71ede1e461e8333cb03e67930f10e9cc7d` で一致する。公開npm tgzのSHA-256は `b658f02203406efafa03cdd08a222ff87caf7edb553d60220f647879a9e17cab`。npm provenanceは同tagとcommitを指し、Official MCP Registry `io.github.kitepon/aiterm-mcp` の0.61.5登録が成功した。トロニーの隔離環境では、この公開tgzとBellTeam main `c3a5edfa51e65193ae5faee09c2456ae398b1507` の実SDK/tmux/native factory/stdio接続3件が成功した。

オーナーは決裁箱「配送障害の恒久修正版でBellTeam本番を1回作り直してよい？」で、全Botの中断を許容し、対象1回の反映を承認した。回答原本はトロニー席の `integrations/delivery-fragile-20261022/permanent/public-0615/owner-deploy-approved.json`。2026-10-22 18:20 JST、ベルが `sh scripts/deploy.sh` を1回だけ実行した。本番の追跡ファイルは反映前後ともクリーンで、取り込んだHEADは `c3a5edfa51e65193ae5faee09c2456ae398b1507`。反映前の処理待ち3件（bot-0908de17、bot-7b140b27）は `runtime/backups/queue-before-deploy-20261022T1820.json` へ保存された。正規スクリプトのログは `runtime/backups/deploy-20261022T182033.log`、終了は `deploy-exit=0`。

再作成後のhealthzは `{"status":"ok"}`、本番npmは `aiterm-mcp@0.61.5`、60 Bot中1席がonline。新しい本番イメージIDは `sha256:db72d49595675a057af63adedec27b60526fc4a943d549f049ff42328690e199`。直近5分のコンテナログに `EXECUTION_UNCONFIRMED`、`EXECUTION_UNSUPPORTED`、`delivery error`、`scheduler error` は見つからなかった。本番担当からトロニーへの新規通話連絡はBellTeamが受理し、会話履歴では `running` として記録された。これは新規配送の受付確認であり、Botのターン完了や元の2通の作用確認ではない。

旧0.61.4コンテナのイメージID `sha256:d6cd9794f538efd7b5283d4450eeae15ef7d856e7da96a2282f73cbadf282372` は再作成後のDockerに存在しなかった。同一イメージへの即時切戻しは確認できない。旧rollbackタグは0.61.2と0.61.1のみ。追加deploy・個席restart・元の2通の本文再送は行っていない。元2通のfailedと初回作用不明は保持する。
