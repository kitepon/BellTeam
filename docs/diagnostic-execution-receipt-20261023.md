# HTTP失敗診断に既存の実行receiptを残す

配送時の型付き`EXECUTION_BUSY`は、`not_started`と`possible`のどちらでも返り得る。HTTP応答は既にcode/effect/follow_upを返すが、サーバー診断では従来のネットワーク用コード一覧から外れるため、元の受付情報を後から読めなかった。

`diagnosticRequestContext`は既存の`returnedExecutionError`を使い、検証できたreceiptの`execution_code`、`execution_effect`、`execution_follow_up`だけを診断ログへ加える。コード名や例外文から未送信・配送成功を推測しない。受付、配送、HTTP応答、再送の扱いは変えない。本文、任意のerror文字列、ID、追加属性は保存しない。

既存の診断分類・fingerprint・重大度・状態・回数の集約方法は変えず、古い診断への補完や移行もしない。この変更で過去のb648のeffectや具体的な受付段階を確定したとは扱わない。

関連試験は実HTTPの型付き拒否2表現と両effectで応答を保持し、診断への3項目、既存の集約キー、本文非保存を確認する。不正・欠落したreceiptは新しい事実を作らず、追加属性も記録しない。実Bot・実席・native作用を使わない。
