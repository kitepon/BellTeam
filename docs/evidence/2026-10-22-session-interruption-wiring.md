# 会話を残す処理中断へのBridge/API/Web配線

2026-10-22 00:15工程。オーナーが指定した通常のEsc相当の中断へ、個別停止・連鎖停止・全体ONを接続する変更。本番未反映、Draft PR45。

- HTTP停止API→AitermTransport→ExecutionBridge.interrupt→agent_stop v2/mode interruptへ接続。旧interruptのpty_closeとBridgeの旧v1 stop送信口を除去した。連鎖口が無い環境は502で返し、close/kill/キー直送へ戻らない。管理用終了・設定変更・再起動は別の機能として保持。
- 個別200は `{botId,status:"interrupted",sessionPreserved:true}`。online:falseを成功条件から外した。会話維持欠測・旧close結果・不正IDはHTTP/Webとも未確認。全体stateの文字列は維持し、stoppedの意味を「全対象の中断/実行なし・会話維持とcommand終了を確認」へ変更。
- 配送stoppedにするのは、受理済みbinding Pointと結果runが完全一致し、run中断とsession維持が確認された場合だけ。同launchの別run/局所idleは元のjobを消さない。runに対応しないself watcher/retained imageをBot IDだけで全消去しない。
- 受理receipt/done後着を保持。停止結果待ち中のdoneを先にfinishせず、中断未確認なら通常の回答観測へ戻す。新中断から旧finish(kind=interrupted、launch閉鎖証拠)を送らない。新runへの旧parent return抑止・関係更新はAitermの責任。
- キー受付/結果不明だけで同launchを永久禁止しない。別途未確定な旧close/configureの状態は保持。Bridgeが未発行と確認できる準備は取消すが、発行済みRPCをabortしただけで未送信にしない。

検査：関連6ファイルの最初の合成検査72成功。その後、新しい別run/idle/キー受付のみ・同launch新依頼/done競合/HTTP旧結果拒否を追加し、変更した2ファイル38成功。完了時npm testは **618/618**、skip/cancel/failなし。旧642とは試験集合が異なり、セッション閉鎖を正とした旧試験群を除去・置換したため件数が減った。618を実中断の受入件数とはしない。全作用は合成クライアント/一時ファイル/ローカルHTTPだけで、実Aiterm席・本番メンバー・全体ONを操作していない。

ログ正本は担当席の `integrations/ai-control-20261021/interrupt-wiring-{focused,new-cases,full}.log`。既存13c7e61の実SDK constructor4/結果読取8は受領済みの版別証拠であり、今回再実行や新版のnative中断受入へ付替えはしていない。

残り：Aiterm agent_stop v2は受領619cdc5でread-only/unsupported-not_sent。private Codex/Claude Esc部品はまだ公開stopへ未接続。元run中断/同一harness・会話endpoint維持/一時受付fence/旧parent return抑止・同launch新依頼再開、実4CLI/安全mountは未受入。supervisor executionBridge注入も未実施。Apple UIは新契約への修正を別担当へ渡す。古い55は送信しない。

本体/審査用/段2の本番反映は新方式受入後だけ。quiet許可だけで旧mainを配備しない。合成成功から公開・反映可能とは判定しない。次はAiterm所有者02:00の新成果へ接続し、Bridge側02:15に差分/不足を返す。
