# トロニー宛て配送停止と冷間起動の修理

2026-10-22 11:02 JST、`POST /api/bots/bot-7b140b27/messages` が2回ともHTTP 500で、トロニーへのユーザー発言を配送できなかった。BellTeamコンテナ自体は10:54から稼働し、Dockerのhealthは正常だった。予定配送も `EXECUTION_UNCONFIRMED` を繰り返していた。

実測した原因はAiterm 0.61.1の冷間起動判定である。本番のtmuxソケット `/tmp/claude-tmux-sockets/claude.sock` は未作成で、tmuxは `error connecting to ... (No such file or directory)` を返した。Aitermの `observeExecutionNativeSessions` はこれを正常な空状態と扱う一方、`observeExecutionNativeCreationScope` は不明と扱い、新しい席の実行登録を拒否した。トロニーの席は不在で、登録の診断呼出しも `EXECUTION_UNCONFIRMED` を返した。ソケット欠落以外の状態を原因とする証拠は無い。

Aitermの正規リポジトリで、両観測が同じ厳密なソケット欠落判定を使うよう修理した（修正commit `381f53d`、release commit `98f9dc1`、tag `v0.61.2`）。修正前に再現試験が失敗し、修正後は対象47件と実行作成13件が成功した。同じ修正commitの製品CIはmacOS、Linux、Windowsで成功した。Windows CI初回だけ無関係のCodex TUI試験が失敗したが、その試験はWindows端末で単独成功し、失敗ジョブ1回の再実行で全試験が成功した。

11:28 JST頃、応急復旧としてAitermの公開 `pty_open` で一時端末 `bellteam_recovery_20261022` を開いた。tmuxの起動後、Aitermの実行登録診断が `reserved → retired` で成功し、予定からBotの席が起動した。以後10分のBellTeamログで同じ配送エラーは再発していない。応急復旧時点ではトロニーへの新しい実チャット送信を観測していなかった。失敗済みの2通を自動再送した証拠は無い。

クオ君の依頼による障害報告を、トロニーの直接会話へ1通送った（配送ID `ad3e2f72-420b-4159-97d7-46d4f2bba2ea`）。HTTP 200・`steered` で受け付けられ、会話の配送状態が `delivered` になったことを読み戻した。報告には原因、影響、応急措置、修理と未反映の区別、トロニー宛て発言と予定の影響範囲を読み取りで点検する依頼を含めた。

公式npm publishは最初の2試行でregistryのHTTP 503を受けたが、同じtagの3回目で成功した。`npm view aiterm-mcp@0.61.2` が0.61.2を返し、公開packageを隔離導入した冷間観測は `{state:"known",sessions:[],server:null}` を返した。Official MCP Registryの登録ジョブも再実行で成功した。

オーナーの個別許可を受け、13:17 JSTにBellTeam `71ecf08` を正規の`scripts/deploy.sh`一回で本番反映した。旧イメージ`sha256:9cb23dd9ccf303a218ae69db91cbf31a2494062667ca00aee4c676a96bab7da8`は`bellteam-rollback:20261022-aiterm0611`として保持した。新イメージは`sha256:ca0ef95397e3a25660644bf82352cdf69d2893e2a8d8696c17b2d019b5c5d94a`。healthは正常でAiterm 0.61.2が入ったが、ソケット未作成からの予定配送は`EXECUTION_UNSUPPORTED`で失敗した。実行登録の空観測は成功した一方、Aitermの`prepareCreation`が最初の`agent_launch`でも既存tmux serverのownerを要求していた。0.61.2の修理は冷間起動の一段目までで、完了と判断したのは誤りだった。

公開Aitermの`pty_open`で新コンテナに一時端末`bellteam_recovery_20261022_after0612`を開くと、新しいBot席が起動し、直近の配送エラーは止まった。恒久修理はAiterm側で、最初の`new-session`の実receiptに含まれるnative session IDとserver PIDを、作成後のprocess開始識別子と照合して結び付ける。補助sessionや自動再送は足さない。修正前に冷間作成の回帰試験が失敗し、修正後に合成の実行作成・実tmuxの冷間作成・終了後の空状態、関連試験が成功した。Aiterm 0.61.3の並行修理を統合した0.61.4の製品CIはmacOS、Linux、Windowsで成功し、実tmuxの冷間作成試験はmacOSとLinuxで実行されて成功した。npmとOfficial MCP Registryへ公開され、公開npm packageの冷間作成も実走で成功した。

二度目の個別許可を受け、14:08 JSTにBellTeam `9b404c5` を`scripts/deploy.sh`一回で反映し、Aiterm 0.61.4を導入した。旧0.61.2イメージ`sha256:ca0ef95397e3a25660644bf82352cdf69d2893e2a8d8696c17b2d019b5c5d94a`は`bellteam-rollback:20261022-aiterm0612`として保持した。新イメージは`sha256:d6cd9794f538efd7b5283d4450eeae15ef7d856e7da96a2282f73cbadf282372`。healthは正常。旧一時端末は存在せず、新コンテナの空ソケット状態からtmux server（PID 1801、開始識別子 `Thu Oct 22 05:09:31 2026`）とBot席`bot-a855525f`・`bot-47fad91c`が作成された。直近ログに`EXECUTION_UNSUPPORTED`・`EXECUTION_UNCONFIRMED`・配送エラーは無い。

オーナーの指示に従い、最終報告と「ふざけんな」をトロニー（配送ID`6e1ceea3-9045-4906-8a58-48f6fa9228bd`）とエレグ（配送ID`a632bcf2-ede7-4018-b404-b8160474b43f`）へそれぞれ1通送った。どちらも直接チャットAPIはHTTP 200で受け付けた。エレグの配送状態は`delivered`、トロニーは確認時点で`running`。重複送信はしていない。

## 残確認

- トロニーへ送った最終報告の配送状態が`delivered`になるまで確認する。

現在の本番はAiterm 0.61.4で、冷間起動に一時端末を使っていない。
