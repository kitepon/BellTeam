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

このadapterは稼働transportへまだmountしていない。Aiterm本体への公開口・実runtime検証・全変更口の共通受付・期待世代の閉鎖adapterを接続し、停止APIと全体停止から呼ぶ統合受入が残る。call-bridgeの外部経路も、この部品だけで追跡済みとはしない。未対応の稼働版へ新しいtoolを呼んだり、旧closeへfallbackしたりしない。
