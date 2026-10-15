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
