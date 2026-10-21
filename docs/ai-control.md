# BellTeam全体停止

全体停止の正本・受付抑止・予定制御はBellTeam本体、表示とON/OFF要求はWebとAppleアプリが持つ。個別停止APIは`POST /api/bots/:id/stop`。連鎖停止の関係記録・寿命・実行はAitermの担当で、この変更では未接続。本番反映の前提を満たした扱いにはしない。

## API

認証済みの`GET /api/ai-control`は`{control}`を返す。`PATCH`の本文は`{"paused":true}`または`{"paused":false}`だけを受け付ける。

```json
{"control":{"paused":false,"state":"enabled","updatedAt":null,"unconfirmedBotIds":[],"commandsConfirmed":null,"error":null}}
```

`enabled`は新しい仕事を受けられる状態。ONは受付を同期的に止め、意図を保存してから登録メンバーと進行中のコマンド予定を停止する。保存成功後に202を返す。`stopping`は処理中、`stopped`は対象全件の閉鎖・コマンド終了を確認できた状態、`unconfirmed`は未確認を含む状態。未確認でもONを保持する。既に停止確認済みなら200、処理中なら202、未確認なら502 `AI_STOP_UNCONFIRMED`で現在の正本を返し、同じONから停止処理を自動再実行しない。

OFFは期限を過ぎた予定を実行せずに消化し、状態保存が成功してから200を返して受付を開く。未実行を実行済みの時刻にはしない。一回予定は無効化、繰返し予定は次の時刻へ進む。会話と予定の定義は削除しない。解除後に新しく登録した依頼は通常どおり扱う。停止前の保存待ち・部屋の順序待ちだった入力は、ON/OFFをまたいでも復活しない。

正本または予定の保存失敗は503 `AI_CONTROL_SAVE_FAILED`で抑止を維持する。書けなかった意図が再起動後にも保存されているとは保証しない。GETは現在の正本を返す。変更通知は既存SSEの`type: "ai-control"`。通信断・502・503ではPATCHを自動再送せずGETで読み直す。GET不能なら古い値を表示せず、操作を止める。

ON中の送信・起動・手動予定実行・再起動は423 `AI_GLOBAL_PAUSED`。閲覧・予定の編集・個別停止は利用できる。既に受理した作業の完了記録は、停止未確認なら観測を続ける。

## 保存と確認範囲

正本は`BELLTEAM_ROOT/shared/ai-control.json`。一時ファイルを0600で作成し、ファイルfsync・rename・親directory fsyncを行う。保存されたONは起動時から受付を抑止するが、以前の停止確認を流用せず再観測する。破損した保存も動作可能には戻さない。

コマンド予定は環境設定の読取と本文を同じprocess groupで実行し、取消時にTERM、必要ならKILL、group消失まで確認する。切り離されたprocess・既に終わった外部操作の取消まで保証しない。Windowsでgroup全体を確認できない場合は未確認とする。登録メンバーからAitermで呼び出した子孫の停止は、別途連鎖停止契約を接続して受け入れる必要がある。

開発検証は合成クライアント・合成プロセスとブラウザfixtureだけで行い、本番のメンバーや全体停止は操作しない。

## 連鎖停止の隔離接続部品

`execution-bridge.mjs`はAitermのローカルwire v1に対する登録・状態照会・終了証拠・root照会・停止のadapter。既存delivery ID、room message IDと実配送先、call event/seq（欠測時は既存delivery ID）を使い、新しいIDや本文queueを作らない。関係の寿命、世代検証、終了fence、退役、実際の閉鎖はAitermが持つ。

`agent_execution`で先に登録した同じ参照をlaunch/sendの`_meta["aiterm/execution"]`へ渡す。成功した作用に追跡の結合失敗が付いても元のreceiptとsteer/interim情報を保持し、再送しない。結果不明のまま次の作用へ進まず、明示的な状態照会だけを可能にする。終了証拠は対応するPoint/Launchを渡し、局所doneやqueue消失だけでbranchを退役させない。親の席が無い場合も`agent_execution_roots`で記録済みの未解決世代を読み、Bot名の全履歴から世代を推測しない。

Bridge本体のstdio起動環境は元HTTP呼出元を表さない。hostからのregisterでは、HTTP受信時に固定したPointを別引数`reserve(input, {sourceContext})`から`_meta["aiterm/execution_source"] = {schema:"aiterm.execution-source.v1",source:Point|null}`へ写す。registerのsource claimやsource_session_idからは補わず、context未指定は明示null。既存wire引数は変えない。値は発行前に複製し、他のmetaを保持する。モデル入力や呼出側のmetaで、このcontextを書き換えさせない。

Aitermはtransport context、register claim、source_session_idと現在launchを照合する。Bridgeがmetaを添えたことだけでverifiedに昇格させない。これはローカルhost相関であり、任意HTTP clientや同じOS利用者に対する暗号認証ではない。native境界を取れない入口はnull、元sourceを確定できない入口もnullを保つ。稼働transportへの接続とAiterm実adapterによる照合は後続工程。

4ハーネス設定は`AITERM_AGENT_LAUNCH_ID`を`X-Bellteam-Launch-Id`へ動的に写す。受信時に席名と世代候補を固定し、内部の配送要求からjobへ渡す。モデルの道具引数からは指定させない。欠測/未展開の値はnullで、現在のjobから補完しない。これはruntime claimの輸送であり、ヘッダーだけで検証済みにするものではない。nativeの呼出境界は共通には取れないためnullを保つ。設定生成と合成MCP要求での確認を、4種類の実CLIで受信済みとは扱わない。

CodexのAiterm stdio継承リストには`AITERM_SESSION_ID`、`AITERM_AGENT_SESSION_ID`、`AITERM_AGENT_LAUNCH_ID`、`AITERM_STATE_BASE`と、一時領域の`TMPDIR`、`XDG_RUNTIME_DIR`、`TEMP`、`TMP`を指定する。Cursorも同じ名前をCLI起動時に動的に読む。本体の環境にまだ無い名前を除外しない。Cursor専用の`run-aiterm-mcp.mjs`は、この8名の未展開参照だけを除いてから登録先またはlazy relayを起動し、stdio・終了値・終了signalを引き継ぐ。値の補完や再試行はしない。既存のsource別名不一致もそのままAitermの検証へ渡す。

state/socketの選択は呼出元識別と別で、実値を保つ。これらの継承設定だけで現在launchの照合やstate scope一致、coverage完全を認定しない。

`AitermTransport({executionBridge})`で隔離用の接続を注入できる。既定はnullで、稼働supervisorからはまだ渡さない。注入時はactive表示と送信の前に登録し、既存room message/targetまたはdelivery参照を使う。空席は同じ参照の空launchとsend各1回。生closeや従来の送信再試行へfallbackしない。対応する実行完了とbindingのPointでfinishし、局所doneをtarget fence完了にはしない。

注入した個別停止はrootsを読み、全体停止はroot集合へagent_stopを1回だけ要求する。Aitermが確認した期待launchと一致するjobだけstoppedにする。停止結果より先に返るclosedやdoneは保持し、未確認なら受理済みの結果観測へ戻る。古い世代の結果を同名の新世代へ流用しない。rootsの読取時に境界欠測があっても、その後の閉鎖で解消される場合があるため、最終stopのcoverageを採用する。root自体の欠測や空集合は成功にしない。停止RPCの作用不明は同名再利用を抑止する。

Bridgeのdispatch/wake/変更Promiseには未着手queueやpreflightも含まれるため、これらを停止要求の前に待たない。agent_stopを先に送り、preparingの取消と実native発行済みのdrain・遅着targetはAitermに任せる。停止結果の後に成功receiptが届いても、そのbindingの世代と保存した停止結果を照合する。未送信拒否は確認したsource/期待targetの停止世代に対応する場合だけstoppedへ整理する。無関係な準備は待たず、対象に未接続の旧変更や作用不明が残れば未確認と再利用抑止を保持する。

停止処理中の未結合restart/configure/close/launchは、依頼時のversionと停止barrierを保持して作用前に待つ。対象rootまたは返却された対象sessionへの変更は未発行で取り消し、無関係な席への変更は停止終了後に進める。この準備をagent_stop側が待つことはない。会話jobのない席も、変更依頼時のsession対応を持ち、連鎖が到達した時にversionを進める。結果整理中に旧変更の結果不明が判明した場合も、返却直前にpending/uncertainを読み直して未確認を保持する。Promiseのsettleを作用確定にはしない。

Aiterm本体への公開口・実runtime/全変更口の共通受付・fence・期待世代の閉鎖adapterと復旧を接続した稼働受入は残る。call-bridgeの外部経路とnative self-turnの全追跡も、この注入部品だけで受入済みとはしない。未対応の稼働版へ新しいtoolを呼ばない。
