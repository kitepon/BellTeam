# 固定c5 imageの単発CI受入案

対象は既公開digest c5a20bd36a8f3ee3fd6e7f23872931125e159a45baf7e01a56185fbb7c5e4c2e/source a8782a84e1e3da900f9dab6f557dc2e2a6218247。再build・tag/push・main更新を行わない。これは受入専用branchの計画で、CI実行結果ではない。mainへmergeしない。

既存publish-server-image.ymlのworkflow_dispatch入口を同branchだけで受入jobへ差し替える。push/pr/schedule triggerなし、独立concurrency group、packages書込権限/login無し。実行時には対象branchの固定headとworkflow内容を確認して一回dispatchし、再試行しない。例: `gh workflow run publish-server-image.yml --repo kitepon/BellTeam --ref ci/centi-c5a20bd3-acceptance-20261026`。この文書とbranchの作成はdispatch許可や実行を表さない。

| 環境・工程 | 固定条件 |
| --- | --- |
| VM | public GitHub-hosted ubuntu-24.04/ubuntu-24.04-arm、native arch、freshVM2台をmax-parallel1 |
| 所要上限 | 各job20分・script900秒、queue時間不明。2job実行時間合計最大40分、auto retry0 |
| 開始 | MemAvailable>=8GiB/Docker filesystem空き>=20GiB/cgroupv2、live値を保存。標準runnerの広告14GB storageだけで20GiB確保とはしない。不足はpull前終了 |
| 稼働中 | 各工程/新Docker前MemAvailable>=4GiB・Docker空き>=8GiB。専用CI VMの暫定余裕でdaemon hard cap/peak保証ではない |
| fixture | 同時1/CPU1/RAM2GiB/MemorySwap同2GiB/PIDs512/read-only/networknone/tmpfs64MiB。実HostConfig/cgroup/max/peak/events/OOM/exitを保存 |
| 処理 | arch単位pull300秒・bytes120秒、amd64だけruntime120秒、cleanup30秒予約 |
| bytes | 固定index/manifest/config/sourceを匿名再取得、全139context、正式21tar41bbの127file/119JS、本体依存3627、既受入6bのCLI/binary/Cursor比較 |
| 人工動作 | amd64実imageのPR1085場面＋Goal順序2testのみ。実Bot/provider/認証/PTY/Goal作用0 |
| 成果物 | 各arch metadata/state/実資源/byte-results、amd647人工結果、失敗・unknown client・自己CID残存。artifact14日、rawtar/HOME/data/資格をuploadしない |

job権限はcontents:read、checkoutはpersist-credentials:false。GHCR/npmは匿名で取得しrepo/production/Apple/npm/providerのsecret入力を使わない。GitHub自身のcheckout/成果物用の短命tokenはActions内部だけで、Docker fixtureへenvやmountで渡さない。fixtureへDocker socketやcheckoutのHOME/dataをmountしない。

比較用JSONは公開sourceと同梱treeのhashだけ、Native tarは公式npmから取得してSHA25641bbf393d3a29c62f014e0282638c627beb1854efe48935116faad37e9dac7fcへ固定。実物へ混ぜるsourceはa878のみで、SEC014別Draft sourceを含まない。

成功時に代替できるのは、同exact artifactの同梱bytesと必要7人工動作の製品受入。main-serverの資源/daemon/kernel/内部mount・実data保持/既認証/quiet/本番切替・実worker/アプリ実機の成功には拡張しない。main-serverの開始14GiB/150GiB条件を変更せず、そのhostのc5-r1は終了保持。Rootの実反映後readonly受渡確認は別に必要。

不足/timeout/相違時は不合格又は未確認を保存する。新imageや条件緩和/自動再走はしない。終了確認できた自己CIDのみrm、running/不明は記録しCI VM終端へ任せ、完了に補完しない。

根拠:
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners （public両Linux4CPU/16GB/広告storage14GB、VM別）
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow （default branchに存在するworkflowとrefによるbranch実行）
