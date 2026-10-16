# SEC-014 1段目：Cursor更新を鍵の無い使い捨てコンテナへ移す

オーナーの決裁箱「セシル：SEC-014（席から本体の鍵が見える）を、2段に分けて直してよいか」のstaged_a、2026-10-15 15:11 JSTをget_decisionで確認。実装と隔離を開始した。本番反映はしていない。

- 本体CMDからcursor-agent updateを除去、image内の固定した`/usr/local/bin/node`でsupervisorを直接起動（席のPATHからnodeを探さない）。
- image内にroot所有の固定入口を追加。HOME/PATHだけで公式updaterを実行。
- 本体と独立したcomposeはCursor volumeだけをmount。一時HOME、read-only image、UID1000。環境/認証/データ/SSH/Docker socket/host PIDを渡さない。
- 正規deployと配布installerは更新成功後に本体を起動/入れ替え。public archiveに固定入口と共通更新段を収録。設置先にNode/Pythonを追加要求しない。

対象試験はinstallerの接続先3種と、更新exit37なら本体upを呼ばない事、archiveへの更新段収録。成功。shell構文/diff検査成功。完了時npm test459/459成功。

同じ隔離compose/volumeで公式Cursor更新も成功し、2026.10.14-941492eになった。実本体/実Cursor volumeの変更は0。

main-server上で、現用imageに候補の固定入口とCMDを重ねた試験image、別の使い捨てvolumeを用意して境目を隔離確認した。実Cursor volume/本体home/dataは使用していない。合成のhost側鍵名が更新用へ渡らない事、同コンテナのprocess環境に本体鍵名0、保護対象の保存場所0、固定入口がroot所有/席から書込み不可、update引数だけを渡す事を確認。代替updaterのexit37を保持し、本番containerのID/StartedAtが不変。試験container/network/volume/imageは試験後除去。

これは公式の全ハーネス再ビルドの代替ではない。10/16までに現行版からの全image隔離ビルド、本体の起動/機能、Cursorの実更新、静かな時の最終再確認と反映手順、戻しの実測を完了する。実反映時刻は試験後にセシルへ送る。戻す場合は更新CMDを含む旧imageを鍵付きで起動し直さず、候補の直接CMDを維持して旧imageを使う。状態/会話/予定を古いbackupへ戻さない。Cursor不良なら、鍵の無い更新箱で公式の既知正常な版へ戻す方法を隔離検証してから扱う。

詳細証拠の所有者はトロニー。`/srv/bellteam/bots/bot-7b140b27/integrations/sec-014-proposal-20261015/`。SEC-014全体は開いたまま。鍵の値の読み取り/再発行なし。

## 10/16の全イメージ隔離

公式現行版からキャッシュなしで全イメージをビルドし、本番と別のHOME/data/Cursor volume、network=noneで本体を起動した。4種類の合成BotのsetupはUID1000、本体の鍵名なし。各CLIのバージョン実行、4種類のMCP設定、合成席名札でのget_self、既存の合成設定保持、Codex hookの並び、通常API読取りと更新、GET受付/終了ログとquery非記録が通った。実認証や本番のデータを隔離箱へ持ち込まず、実AIターンの受入とは区別する。

同じ合成データで旧イメージへ戻す時はCMDを固定Nodeへoverrideし、増えた最新状態を保持したまま候補へ戻せた。小規模の合成環境での停止からreadyは約1秒で、全席のsetupを復元する本番の停止時間の保証ではない。Cursorの切戻しは鍵無し箱でbin/agent・bin/cursor-agent・share/cursor-agentだけを控えから復元し、更新で増えた不良releaseを除去、無関係の最新ファイルを保持する方法を隔離確認した。

`BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-7b140b27 sh scripts/deploy.sh` は、build後のCursor更新直前と本体up直前にqueue/process metadataを読み直す。直接の端末操作は行わない。読み取れない物や他BotのCLIが残る時はexit2で保留し、Cursor更新/本体upへ進まない。CLIの作業中/idleをこの道具では断定しないため、idleのCLIも保留する保守的な条件である。初回の本番読み取りは他BotのCLI22席を見つけ保留した。確認失敗の両箇所でupが呼ばれないことを代替Dockerで検証し、合成Docker環境でも他席CLIなしの通過/他席CLIありの拒否を確認した。

本番container ID/StartedAt、実HOME/data/Cursor volumeは未変更。私だけの条件が満たせた反映時刻をセシルへ事前に通知し、ラプラスの同時確認と合わせる。入れた後のstartup0/server_processes≥2/missing無しはセシルv3.1で確認する。専用利用者/鍵file/stateの境目は未達のまま、SEC-014をこの段だけで閉じない。

10/16 21:30の旧判定もidle CLIを含め22席で保留した。その後セシルが「動いている」はターン途中で、待機CLIは除くと確認した。上記の存在だけで止める判定は当時の履歴として残し、現行設計はcurrent-design.mdの読取りターン状態/構造化idle観測と配送queueによる判定へ修正する。欠測をidleと推測せず保留し、他席を閉じて通すことはしない。
