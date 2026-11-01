# SEC-014 共通installerの保守口

公開の`compose.yaml`と`install.sh`、選択imageが全資材。HostへNode/Python/補助daemonを追加しない。内部adapterも公開installerへ接続する。設計正本はRootのFable確定v2（2026-11-01）。

保守serviceはimage内固定Nodeの`server-state-transfer.mjs prepare|to-server|to-legacy`だけをrootで実行する。rootfs readonly、network none、capはCHOWN/DAC_OVERRIDE/FOWNERのみ。環境はenv -i、単一runtime bind。HOME/CLI認証・席project本文には触れない。privileged環境の用途を席の意図的sudo防御まで拡張しない。

`runtime/server-only/state-data`自身のEXと新通常本体のSHで本体と保守を排他にする。新本体はstate directoryのEXも保持して二重本体の書込みを防ぐ。FD3/FD4は固定C入口が開き、席の固定入口は両方閉じる。

data rootをroot:root/0700へsealし、root専用transactionを記録してからrename/no-clobber link+unlinkで移す。各単位は少なくとも片側に残る。再開時は両側を読み、同inodeのlink済み対を収束させ、別内容はCONFLICTで保持する。逆方向も同じ入力から選べる。ownership完了後にtransactionを消し、最後にdata rootを通常owner/modeへ戻す。transaction削除後に止まってもsealed metadataから収束する。

旧imageはlockを知らないためexact CID停止とwriter確認を先行する。旧layout復旧ではそのcontainerをrestart無効化・削除してからinverseし、保存旧normal/raw image/profile/HOME/volumeで起動する。current dataを昔のbackupで上書きしない。再実行を根因修理の代用にせず、通信断などから状態を確かめて安全に再開する。

writer検査はruntimeと交差する祖先/自身/子のRWbind、およびCursor volumeやその実backingを照合する。欠測や未知のmount/driverは停止する。snapshotを後発の特権的手動mount防止まで証明したものとはしない。

検証は実FSの中断/方向変更/衝突/増分保持、模擬Dockerの公開shell配線、正式imageでのUID/lock/seal/移行/両復旧を分ける。模擬DockerやUID代替fixtureをkernel実受入へ代用しない。反映・独立受入が揃うまでwhole Draft NOTDEPLOYABLE、flags false。
