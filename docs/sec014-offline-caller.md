# 段2の停止中移行の呼出し

Draft PR42 の途中工程。利用者分離全体はまだ NOTDEPLOYABLE であり、この変更だけを main や本番へ出さない。

公開 installer は Compose の停止成功、全 writer の停止確認、既存の root ディレクトリ準備の後に、image 内の `/usr/local/bin/node /app/src/server-state-transfer.mjs to-server` を UID/GID 0:0 で呼ぶ。通常の server entry は引数を受け取らず UID1001 で起動するため、保守ではこの固定 Node entry を明示する。

移行先は既存 component と同じ `/srv/bellteam`。引数は `to-server` または `to-legacy` 一つだけで、外部 path・code・設定を指定できない。実 UID/GID と実効 UID/GID は root を要求する。エラーは code だけを出し、文書本文・headers・path を出さない。移行が失敗したら installer は終了し、Cursor 更新と新旧本体の起動を行わない。途中ファイルや marker は既存 component の再開契約に従う。

逆方向も現在の正本から移す。昔の backup を戻して予定・AI停止状態・Bot 増減を巻き戻す処理は加えていない。installer の自動逆移行も行わない。

移行後の同じ root 保守口で、本体5状態と APNs 親を UID/GID1001 へ準備する。上位は0711、内部 dir0700/file0600、call-bridge と socket の親は0711。data/bots/shared/tools の席側祖先は1000:1000/0711を保つ。HOME・CLI資格・Bot文書・memory/RAG・外側BugHubは再帰対象にしない。全対象のリンク/特殊ファイルを先に拒否し、metadata変更はNOFOLLOWで開いた同一inodeへ行う。逆方向は現在の内容を変えずUID1000へ戻す。

逆移行で旧側へ戻った初期化印・台帳・予定・画像・共有文書もUID1000へ戻す。Bot project は戻った固定の metadata と画像だけを扱い、文書やmemoryを再帰しない。固定の文書pathにdirectoryが置かれた場合も拒否する。実 filesystem の順逆移行を結合し、最新のBot増減・予定・AI停止状態が残ることを確認する。

検証は人工 Docker の installer 呼出し順序・移行失敗の終了 code と後続未実行、実 filesystem 上の component の順逆移行・最新状態・故障時の保持、CLI の不正引数・非 root identity 拒否。所有準備の人工filesystem試験ではchownだけを記録に置き換え、mode変更・範囲除外・link拒否・inode交代・handle回収は実 filesystem で確認した。root CLI と実UID変更のcontainer実行、独立 bind mount、制限された backup、fresh install supervisor、PGID receipt、4 CLI と停止時間は別の未完工程。これらを揃えてから段2全体を受け入れる。

## 制限された移行前控え

固定root入口は内容移行より前に /srv/bellteam-maintenance-backups のroot専用親を要求する。5状態と旧Bot台帳/予定/画像/初期化印・4共有文書だけを各方向の before-to-server / before-to-legacy へ新規保存する。HOME/CLI資格・席docs/memory/RAG・外部BugHub・APNs鍵本文は控えに含めない。APNs原本はその場に保ち、既所有準備の対象のまま。root専用親の祖先/ACL/排他/独立bindはhost担当と別途確認する。

親0700/実行者UIDGID一致、内部dir0700/file0600、symlink/hardlink/special拒否、容量不足と書込み/sync/元更新は移行前に終了する。全FDを閉じ、コピーと親directoryのsync後にのみprivate complete.jsonを確定する。失敗した控えは消して再作成せず不完全のまま保持し、既存complete/partialの同方向控えも自動上書きしない。再開は残った正本・控えと停止状況を担当が判断する。戻しは常に最新stateのto-legacyであり、この控えの自動restoreではない。控えの秘密本文/長さ/hashは通常結果へ出さない。

現在のinstallerは専用backup bindをまだ持たず、固定入口はその不足を読書き前に拒否する。通常serviceへbackup bindやroot資格を渡す追加はしていない。専用保守Composeとfreshcreate/独立bind/実root受入/容量・保持期間・回収担当の確定が残るので、Draft NOTDEPLOYABLEを維持する。
