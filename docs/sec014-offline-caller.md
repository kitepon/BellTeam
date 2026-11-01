# SEC-014 共通installerの保守口

公開のcompose.yamlとinstall.sh、選択imageが全資材。HostへNode/Python/補助daemonを追加せず、内部adapterも同installerへ接続する。設計正本はRootのFable確定v3（2026-11-01）、Mac fakeowner bindの実反例と原子交換の修正を含む。

保守serviceはruntime bindと単一external server-state volumeだけを持つ。rootfs readonly/network none/cap CHOWN,DAC_OVERRIDE,FOWNER、環境env -i。prepare/to-server/to-legacyはvolume rootのEX、通常本体は同inodeのSH FD3とstateのEX FD4。席の固定入口は両FDを閉じる。SCE固定副命令headers/endpointだけはPython自身が同controlのSHを生涯保持し、EX中はstdin前に75で拒否する。Hostにroot用Python copyや特権入口を追加しない。

初回の実アクセス拒否probeでPOSIX bindならruntime/server-only/state-dataをvolume実体へ、効かないDesktop等はEngine内nativevolumeへする。保存世代へvolume名とmodelを固定し、foreign/missing/未知metadataを停止前に拒否する。nativevolumeのVM内部MountpointにHost realpathを要求せず、volume名/subpath/RWとbind/deviceのcanonical観測を分ける。

移行は現在の6領域と文書をcopy/fsync/bytes照合して公開し、原本をretiredへ退避する。空宛先を到着済みとしない。HOME stagingは同runtime bindのserver-only/.new-homeで所有権を完成してからrenameし、既HOMEは触らない。本体volumeのtransaction記録を先に置きC入口を拒否し、data dirと墓標fileをGNU mv --exchange -T --no-copyで原子的に交換する。存在しない瞬間を作る二rename fallbackは使わない。成功後は交換を戻し墓標を消してから最後にrecordを消す。失敗時は元bytesとrecordを保持し、要求方向を変えても現在値から収束させる。

旧imageはlockを知らないので、保存normal/rawimage/profileとexact CID停止・restart無効化/rmを先行してからwriter検査する。explicit recoveryは保存世代/旧rawimage/HOME/現在volumeを使い、昔のbackupで上書きしない。通信断時は実体を読み戻して安全に続け、根因修理を再送で代用しない。管理sudo/SSHを事故境界へ拡張せず、旧actor/token/6phase/毎回backup/quiet gateを再導入しない。

実FSのcopy中断/方向変更/衝突/増分保持、公開shellの合成配線、実imageのUID/FD/record/両復旧を分けて検証する。Mac finiteprobeではnativevolumeの直接/subpathUID拒否、SH/EXとbind交換まで成立、製品の全移行/復旧受入へ代用しない。実装/実CI/本番/商用/公開とfinal受入が揃うまでDraft/NOTDEPLOYABLE、flags false。
