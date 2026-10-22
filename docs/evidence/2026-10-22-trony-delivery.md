# トロニー宛て配送の停止と応急復旧

2026-10-22 11:02 JST、`POST /api/bots/bot-7b140b27/messages` が2回ともHTTP 500で、トロニーへのユーザー発言を配送できなかった。BellTeamコンテナ自体は10:54から稼働し、Dockerのhealthは正常だった。予定配送も `EXECUTION_UNCONFIRMED` を繰り返していた。

実測した原因はAiterm 0.61.1の冷間起動判定である。本番のtmuxソケット `/tmp/claude-tmux-sockets/claude.sock` は未作成で、tmuxは `error connecting to ... (No such file or directory)` を返した。Aitermの `observeExecutionNativeSessions` はこれを正常な空状態と扱う一方、`observeExecutionNativeCreationScope` は不明と扱い、新しい席の実行登録を拒否した。トロニーの席は不在で、登録の診断呼出しも `EXECUTION_UNCONFIRMED` を返した。ソケット欠落以外の状態を原因とする証拠は無い。

Aitermの正規リポジトリで、両観測が同じ厳密なソケット欠落判定を使うよう修理した（修正commit `381f53d`、release commit `98f9dc1`、tag `v0.61.2`）。修正前に再現試験が失敗し、修正後は対象47件と実行作成13件が成功した。同じ修正commitの製品CIはmacOS、Linux、Windowsで成功した。Windows CI初回だけ無関係のCodex TUI試験が失敗したが、その試験はWindows端末で単独成功し、失敗ジョブ1回の再実行で全試験が成功した。

11:28 JST頃、応急復旧としてAitermの公開 `pty_open` で一時端末 `bellteam_recovery_20261022` を開いた。tmuxの起動後、Aitermの実行登録診断が `reserved → retired` で成功し、予定からBotの席が起動した。以後10分のBellTeamログで同じ配送エラーは再発していない。トロニーへの新しい実チャット送信はまだ観測していない。失敗済みの2通を自動再送した証拠は無い。

## 未完了

- npmへの0.61.2公開。GitHub Releaseは作成済みだが、tag起点の初回publishはnpm registryのHTTP 503で失敗した。同じtagの公式ジョブを再実行中。registryからの版取得と公開package smokeを確認する。
- 本番コンテナの再作成。`AGENTS.md`に従い、件名「BellTeam本番コンテナを再作成してAiterm 0.61.2を導入する」でオーナー決裁を申請済み。許可とnpm公開確認の両方が揃ってから、`scripts/deploy.sh` を一回実行する。旧イメージは現在 `sha256:9cb23dd9ccf303a218ae69db91cbf31a2494062667ca00aee4c676a96bab7da8`。実行前に保持する。
- 反映後にAitermの版、ソケット未作成からの実行登録、BellTeamの配送を確認し、一時端末をAitermの公開 `pty_close` で閉じる。閉じた後も冷間起動が成功することを確認する。

本番コンテナの再起動や再作成は、この記録時点では行っていない。
