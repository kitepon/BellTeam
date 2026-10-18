# SEC014 process表の採取時間短縮

10/18 09:03 JST、トロニーの秘密無し診断wrapperで既存Bを1回だけ読んだ。未分類4席のうち3席は、初回表1件・2回目表2件の `/proc/<pid>/stat` ENOENT。いずれも観測CLI本体または初期席候補に対応するPIDではなかった。ただし、その事実だけから無関係なprocessとは証明できない。残り1席は最初の全子孫treeの許可条件不成立、実配送/途中も1席あり、quiet=falseを維持した。夜間の失敗原因まで遡及断定しない。

`readProcTable` は全PIDのstatを逐次読んでいた。最大32件ずつ並行して読むようにし、processが消滅する競合時間を短くする。各batchの全Promiseをsettleしてから、欠測/不正statが1件でもあれば従来どおりthrowし、その席を未分類保留にする。欠測の無視、再試行、許可対象の追加はない。候補全件/初回表が最初observeより前/3回の全子孫/2回observe/最後の席探索/前後queue/配備両gateは維持する。

合成512 PID、旧版/新版の順序を交互にした7回の中央値は旧8.96ms/新2.27ms。本番の速度やquiet成功率の実測ではない。非原子的観測の限界は変わらず、hookの入替や短い実ターンは保留する。ApprovalBox0.1.26公開コードには23時間59分の待受期限、5秒のowner確認/60秒のidentity再確認があるが、今回の完了したhook入りtree照合で入替は観測せず、張り直しを未分類原因や除外理由と確定していない。

対象26件成功。追加3件は複数batchの全件性、後ろのbatchのstat欠測をidle観測前に保留、不正statで部分表を返さないこと。診断wrapper自体は純粋fixture18件で、既存Bと結果/読取回数一致、hook PID/start変化・未知子・別root・読取消滅・最終候補変化の保留と秘密canary非露出を確認した。

完了時の全Linux試験は既存の検査済み全image `bellteam-sec014-stage1:20261018-0030-cc4e5aeb2987` のNode26.12で1回実行し、490/490成功・skip0。新しいgate/testをread-onlyで差し込み、実資格/本番volume無し・試験中network無し、専用dev依存volumeは除去した。CLI/実行imageを再buildした結果ではない。

診断とbenchmarkはトロニーの実測。証拠は担当席の `integrations/sec-014-diagnosis-20261018/`。本番変更/追加の実読取/全imagebuildは行っていない。gate/test/本書は既存Docker除外対象。必要な通常review/main採用と次窓の当時公式配布/候補検査/事前実時刻/同時監査/事後予定/quiet両gateが済むまでは配備しない。
