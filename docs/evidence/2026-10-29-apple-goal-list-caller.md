# Apple版71のGoal一覧失敗と呼出し元の追加記録

版71で`GET /api/goals`の後発が発生し、`88564`はcount11からcount12、`eb392`はcount27となった。指定原本は本番コンテナ内の`reopen-corrected-rule-20261029/88564-count11-current/`の中央記録と診断、`88564-count12-current/`と`eb392-count27-current/`の各source・診断の計6ファイルに限定して読んだ。最新取得時の`88564` count12と`eb392` count27はいずれも`open`で、旧`88564` count10の解決や`eb392` count25の個別Goal原文を流用しない。

原本SHA256は、count11中央source `5d8a3adfe3af7b5550a5dca9f4f72b931e56bd6e40bf92f16b7025a20f0c77f3`・診断 `27695d1fae1d5c2a782f0bcc602b82cba04702ad051f61f83cb2ad2c14036035`、count12 source `1048dc73b63cf1d487d5b6b21ef3c50fddbf775137480ed4b1e8da436cea4287`・診断 `1775569399ec710ea9c582d5ef61871017480eb16ebddcd9fd0de1fbe2b0bc00`、count27 source `4c227259c0dcae5f9d237d501bf1e87d35a3c58d6dacbd8744437c9275df65fc`・診断 `99716056728cec90f38d668ef99906ee592fa0a9b613209f9abffec98b616efc`。

| 発生 | 版71の実測 | 未解明 |
| --- | --- | --- |
| `88564` count11 | 初回・再試行とも`-1005`。壁時計計56,241ms、uptime計47,113ms。初回はactive→background、再試行はbackground→background。 | 原因と実画面回復 |
| `88564` count12 | 初回・再試行とも`-1005`。壁時計計40,347ms、uptime計40,347ms。初回はactive→background、再試行はbackground→inactive。 | 原因と実画面回復 |
| `eb392` count27 | 単一`-1001`。壁時計133,342ms、uptime74,996ms。active→background。 | 原因と実画面回復 |

各試行のmetricsは取得でき、response開始値は無い。差分9,128ms・0ms・58,346msを同じ端末睡眠・アプリ休止・回線原因へまとめない。版72の共通`BellAPI.recordedAttempt`は一覧GETにも、両試行の連続時計、画面状態の変更時刻・連番と要求/session timeoutを記録する。一方、固定版72の`GoalViewModel.loadList`は診断contextを渡さず、個別Goal用の呼出し契機と呼出し時scenePhaseは一覧GETへ付かない。

この差分は一覧の5呼出し元（引き下げ更新・更新ボタン・選択タブの表示task・前面復帰・event）から固定文字列の契機と呼出し時scenePhaseを既存`loadList`へ渡し、失敗時の診断へ付けるだけ。`URLRequest`、再試行、ID、取消、scenePhaseによる発火条件、分類は変更しない。原因・回復を確定した修理ではない。

[人工原文](samples/2026-10-29-apple-goal-list-caller-artificial.txt)はURLProtocolで一覧GETを2回切断し、`BellDiagnostics.report`へ固定の一覧契機を直接渡した標本である。UIから5経路を起動した再現ではない。原文は2試行・metrics・匿名化した経路と追加欄を持ち、秘密queryを含まない。[目録](2026-10-29-apple-goal-list-caller-sample.json)がsource commit、size・SHA、focused1件成功のXCResultを結ぶ。版72の署名済みartifact、配布許可、Mac導入待ちはこの差分では変更しない。
