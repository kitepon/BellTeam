# 待機outcomeと設定適用の契約

所有者：キロ。接続先は[runtimeのseat-process](../runtime/README.md)、[Aitermのnative](../aiterm/README.md)。設定保存と完了観測を含む全体は[制御詳細](../../control-details.md)、[配送詳細](../../delivery-details.md)、[観測詳細](../../observation-details.md)を参照する。

## 席と非席で同じ待機結果を返す

```mermaid
flowchart TD
  Descriptor["nativeが返したwait_process"] --> Caller["runWaitProcess"]
  Caller --> Seat{"seatProject指定あり"}
  Seat -->|"あり"| Runner["SeatProcessRunner<br/>このcallerだけacceptNonzero"]
  Seat -->|"なし"| Spawn["従来のprocess実行"]
  Runner --> JSON["stdout JSONを解釈"]
  Spawn --> JSON
  Runner -->|"起動・取消・出力上限失敗"| Failure["待機失敗を返す"]
  JSON -->|"不正JSON"| Failure
  JSON --> Outcome["waitUntilDoneがoutcomeを解釈"]
  Outcome -->|"timeout / running"| Caller
  Outcome -->|"done"| Complete["ターンの待機完了"]
  Outcome -->|"error / rate_limited / その他"| TurnFailure["既存のターン異常を返す"]
  Failure --> FailedWatch["watchは失敗を記録して追跡終了<br/>native完了は未確認"]
  FailedWatch --> Release
  TurnFailure --> Release
  Complete --> Release["配送 / watchの活動を解放"]
  Release --> Idle["whenIdleの待合せ終了"]
  Idle --> Configure["停止世代等を再確認しagent_configure"]
```

| 境界 | 入力・出力と失敗の責任 |
| --- | --- |
| `runWaitProcess(waitProcess, signal, {seatProject})` | native公開返却のexecutable/argsを実行し、stdoutのJSONをそのまま返す。終了値だけでJSONのoutcomeを捨てない。席での実行方式・環境・UID・取消はruntimeの機構へ委譲する |
| `createSeatProcessRunner` | 既定のnonzero拒否を維持する。wait callerだけが既存のacceptNonzeroを使う。起動・入力・取消・合計出力上限の失敗はJSONへ置換しない |
| `waitUntilDone` | `timeout/running`なら同じreceiptの待機を続ける。`done`でだけ正常完了。`closed/error/rate_limited/not_taken`等は既存の終了異常へ写す |
| `watchTurn` / `SeatActivity.whenIdle` | timeout/runningの待機中はwatchを活動として保持し、設定適用を進めない。正常timeoutを監視の故障へ変換してfinallyで活動を外す不良をcallerで修理した。追跡の実故障では既存finallyが活動を外すため、whenIdle自体をnative完了の証明にしない |
| `BotAdministration` / `reconfigure` | 保存希望値・pending・accepted・failedを区別する。acceptedは設定受付であり新turnの実modelを測った証明ではない |

直接callerはapplication-servicesのseatProject付き注入、AitermTransportの既定値、waitForTurnCompletionとwatchTurn。`aiterm-transport.mjs`からの既存再exportを保持する。callback・会話履歴形式・module間のportに変更はないため、module.jsonと生成される全体接続図は不変。

限定回帰は `test/aiterm-wait-process.test.mjs`。正常/nonzero JSONの両経路、汎用runnerの既定nonzero拒否、不正JSON・起動・取消・出力上限、timeout→running→doneのwatchとconfigure順を確認する。固定の権限entryだけを試験内で置換し、実際のNode子processのstdioと終了・取消を使う。native Aiterm・実席・本番設定は操作しない。

## 修理の適用範囲と別の未実装機能

元の各設定拒否ではwaiterのexitCodeが保存されていない。この不良との一意相関、Cinderella08:40とエレグ08:51の利用復旧を、このsource修理の成功から補完しない。追跡processの実故障や不正JSONでは既存watchが終了し、native完了前にconfigureへ進む可能性が残る。今回の修理は正常nonzero JSONを復元する範囲であり、この異常系の完了判定は別途確定が必要。

現在ターンを自動で区切り、同会話に適用して続きを一回起こす機能は別途設計する。必要な接点はMCP応答完了後の対象ターン限定終了、native完了の観測、通常配送による一回再開と全体停止・並行入力との整合。今回の修理は自動終了・自動再送・再開の仕組みを追加しない。
