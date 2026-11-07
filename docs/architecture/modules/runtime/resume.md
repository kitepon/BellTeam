# Aiterm H1 offline保存と起動前復元

runtime接続候補。製品6658c67の未公開CLI/stream契約を使用する。正式0.63.2や現961の能力ではない。製品最新f3f30feは最終レビュー通過とRootから返却され、H1三moduleは試験対象6658と同bytes。これは製品全体の実供給やruntimeの実Docker/UID/mount・本番の受入を示さない。製品内部は[Aiterm正本](../aiterm/README.md)、mount/bin/contextは[配布の正本](../distribution/h1-offline.md)へ辿る。

## 初回と保存更新を分ける

H1対応imageの初回は、固定base `/srv/bellteam-aiterm` に専用external local volumeを配置し、空・local/optionsなし・project/role labelを確認して1000:1000/0700へ準備する。旧/tmpや未提供CLIの初回から保持できるとはしない。通常の既許可リセット更新は保存要求無しで行え、保持必須ならH1未対応を停止前に拒否する。

通常installerは`BELLTEAM_AITERM_STATE_VOLUME`の解決済み名をprefixとし、既保存世代を末尾へ付けて毎回新しいvolume名を生成し、固定normalへ保存する。未指定の通常reset更新も同じ入口を通り、利用者の手動volume指定や保持要求は不要。旧normalは書き換えずsource名を保持する。`--recover`も旧normalの復帰先volumeをwriter検査に含め、保存済み名へ戻し、新volumeの作成/初期化を行わない。同名/同backingの旧sourceと新destinationへ保存更新しない。例外は同梱updaterの本体交換（`BELLTEAM_CONTAINER_UPDATE_WORKER=1`かつ対象指定無し）だけで、旧本体の実mountと同一のvolumeを名前・実体・単独参照・同一aiterm-mcp readerで照合して新世代名を作らず使い続け、空初期化を行わない。照合不一致は停止前に拒否し、resetへ落とさない。[箱同梱の本体更新 slice 3](container-update-bundled.md#same-backing-aiterm-state-on-a-bundled-body-swap-z-c-slice-3-2026-11-08)を参照。rootのdev/inode/prefixは製品が永続Codex rolloutについて検証し、runtimeがbundleを加工して通さない。

## 停止・保存・採用の順序

```mermaid
flowchart TD
  Model[normal/旧normal・image・対象集合] --> Select[既保存世代から新volume名を生成<br/>新normalだけへ固定]
  Select --> New[新volumeの本人性を確認]
  New --> Stop[exact旧CIDをstop・restart no<br/>PID0 / false false / imageを再確認]
  Stop --> Proof[停止CID/image/sourceを保存<br/>rm後も証跡を保持]
  Proof --> Writers[旧新state/HOMEのwriter検査<br/>再起動可能writer・aliasも対象]
  Writers --> Initialize[新volumeが空であることを確認<br/>1000:1000/0700を準備]
  Initialize --> Prepare[既maintenance prepare]
  Prepare --> Lock[1001受取processが既control flockを保持<br/>READY後だけsource読取を開始]
  Lock --> Product[1000 helper: 旧state/HOME readonly<br/>公開checkpoint CLI]
  Product --> Pipe[raw bundleは1001 privateへ<br/>safe receiptは別512B制限]
  Pipe --> Complete[両exit/対象/LF込みSHAを検証<br/>fsync・完成generation公開]
  Complete --> Migration[既状態移行 / Cursor更新]
  Migration --> Boot[新本体の既FD3/4 lock検証]
  Boot --> Restore[bootstrap import前<br/>1001が完成入力を開き1000へstdin restore]
  Restore --> Adopt[同generation/destination/digestを採用]
  Adopt --> Normal[通常bootstrap・設定・native開始]
  Product --> Fail[失敗/不明は原本保持<br/>完成採用・通常起動をしない]
  Restore --> Fail
```

installerへの保存対象入力`BELLTEAM_RESUME_TARGETS_FILE`は、固定した製品session/launchのJSON配列（各`session_id,launch_id`のみ、64KiB以内、一意）。Bot名から現在launchを推測しない。入力無しは保持更新を要求しない。元sourceのCLI能力/normalがなければ保持要求を拒否する。新しい配送IDやqueueは作らない。

`resume-install-plan`は旧新model/元CID/image/対象を束縛し、新normalへ既保存世代名`BELLTEAM_RESUME_GENERATION`と解決済みvolume名を付ける。checkpoint helperは共通`/app/compose.aiterm-checkpoint.yaml`、installer helperは`/app/install-resume-state.sh`。公開/内部の分岐で別実装へfallbackしない。

writer-planは新旧resume volumeをactive container無しでも保持し、local driver/backing/Host aliasを検証する。既`stoppedContainer`のunless-stopped例外と、rm済みCIDの歴史証跡を混同しない。snapshot検査だけで将来の管理外writerを止めたとは言わない。供給管理下の停止/再起動防止と、保存stream中の既control lockを組み合わせる。管理外Host直接書込まで検証済みとはしない。

## byte protocolと非公開保存

checkpointはstdout bundle/stderr receipt、restoreはstdin bundle/stdout receipt。bundleは末尾LFを含む16MiBまで、safe six-field receiptはLF込み512Bまで。署名対象は受信raw bytesで、JSONをparse/stringifyしてbundleを再生成しない。汎用runnerの合算上限は変更しない。

1001は`state/resume-checkpoints/<既保存世代>`を0700、fileを0600で作る。原子的な非上書き公開とfsync/親directory syncを使い、別bytes・symlink・hardlink・不正mode/ownerを拒否する。checkpoint CLIのsavedと、こちらの永続保存完了は別。stageは未採用、製品/受取の両exitとreceipt/digest確認後だけtargetを完成公開し、全対象完了後にgenerationを公開する。完成後のpending copyは除く。生bundleや資格を通常logへ出さない。

受取processは既maintenance modelをUID1001・固定flock/Node入口で呼び、既caps/NNPの構成を変更しない。checkpoint helperは別UID1000でstate/HOMEのみreadonly、Config.Envやprivate stateを渡さない。installerは子PIDを保持して取消時に回収する。実Dockerのsignal/UID/mount動的受入は別工程。

## 固定baseとbootの一回性

本体の信頼済み固定baseを、C入口のclearenv/UID変更後に明示する。configured経路ではenv.sh後にも固定値を検証し、別値/unsetでMCPやtarget launchを始めない。製品scopeを解決する前に適用し、登録のstate-root/socketは製品から得る。harness登録はrelay有無を含め固定baseを持ち、Codex/Cursorの任意継承と区別する。他のsession/launch/temp値とH1非対象の既契約は保持する。任意shell全体の隔離を保証するものではない。

supervisorは既起動lockを保持したままrestoreをawaitする。H1中のsignalは子へ取消を送りstdio終了まで親を残す。復元対象/volume/生成計画SHAのstarted記録を先に公開し、全restore成功後だけadoptedを公開する。採用後は通常stateが変化していても旧bundleを再投入しない。採用記録の不一致・喪失/未完は停止し、unless-stoppedを再実行の許可と見なさない。同digestの明示再開は既startup admission下の`adoptResumeGeneration(...,{retry:true})`でのみ行う。これはvalidな保存原本での再開で、runtime公開のlink直後crashでhardlinkが残った場合はfail closedにし、private保存の修復前に再開しない。専用の復旧操作UIは今回追加しない。

## sourceと直接確認

正式供給後の実物境界は `scripts/verify-resume-runtime.py IMAGE OUTPUT` で検査する。配布担当の既native両arch CIが、build済みimmutable imageを渡す。固有prefixの合成HOME・旧新state・private volumeだけを作り、実helper/1001受取/1000 CLI/本体C入口とsupervisorを通す。bootstrapの先頭だけを読取専用の停止標識へ差し替え、復元・採用より後のimport到達を観測する。実vendorや資格を使わず、製品runtimeは差し替えない。終了時は今回のcontainer/volumeだけを除去し、safe結果を保存する。既fixture成功数や本番受入へ加算しない。

検査の`network none`実行には固有hostnameと127.0.0.1のhosts対応を渡す。外部通信を許可せずsudoの自己hostname解決を満たし、席UID検査でstderr空を確認する。初回41529449686のrestore失敗は未受入のまま保持する。診断41530989746は両archでsudoのhostname解決警告を再現し、`/run` tmpfs有無による差は無かった。byte protocolのstderr拒否は変更しない。これは既検査構成の修理で、機能・公開窓口・データ所有・全体図の接続は変わらない。

失敗箇所の再確認は`--restore-only`で、新しい合成source/checkpointを準備して起動前restore・採用・再起動時非再投入・不正入力拒否だけを判定する。前回成功したreadonly・UID・signal・privateの観測は再走しない。結果のscopeをrestore-onlyとし、このacceptedだけを全runtime合格に数えない。

実装は`resume-policy/pipe/storage/boot/install-plan/runtime-resume/run-resume-store`、既seat-command/run-seat-command/bot-environment/harness-config、writer-planとinstaller。追加の私有Aiterm metadata writer、online seal、keeperはない。

直接fixtureは`resume-runtime`、`resume-install`、固定製品distを渡す`resume-cli-integration`。境界は既server-state-writers/installer-unified、seat/環境/登録、application-runtime、配布archive/context。新製品6658c67との隔離CLI接続と製品crash/strict反例を確認するが、旧c688の有限成功を新安全性へ流用しない。製品最終レビュー通過はRootの原本へ帰属し、このfixtureの範囲へ加算しない。実vendor・実Docker/1001動的受入・本番/公開は未確認/保留。
