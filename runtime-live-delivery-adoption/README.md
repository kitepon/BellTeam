# 421dの新規配送3拒否だけを同instanceへ採用する

所有エピネル。Root docs/message-receipt-contract-20261106.md の承認済み実装単位。親682e513の耐久受領は別単位。設計/状態所有/初回到達の正本は ../docs/message-repair-live-activation-contact-20261106.md。

## 機能とデータフロー（実装前固定）

|担当・ファイル|入出力/状態所有|失敗|
|---|---|---|
|Molly profile/|421dに対する98f5cd20の2sourceをbyte exact保存。source.jsonは旧2file SHAと7method指紋を固定|現mainの50file/newmethodで補完しない|
|package.py|同main Sの固定7asset→旧cached421dへのliteral import投影→manifest付きsidecar tar.gz|任意branch/path/追加asset無し、通常execution inventoryは変更しない|
|Centi既publish-execution|同main Sの別subjectとしてOIDC署名/公式verify/upload|既repo/workflow/main/SLSA/trusted rootsを維持、source=signer=S|
|verify.py|検証実行者所有archive/bundle→既公式signature verifier＋閉sidecar inventory/投影照合→verification JSON|署名検証とarchive検査を省かず、展開/採用はしない|
|src/adopter.mjs|固定root-owned operation/manifest/verification＋実PID/start/boot/parent421d・元class指紋→同prototypeの7descriptorだけ同期採用→同UUID intent/receipt|constructor/fields/SDK/native/job/Map/Promise/callback/selector/generation変更0。claim後は再採用せず同UUIDread、receipt保存失敗も再発行0|
|src/client.mjs|同namespace実PID/start/boot、既9229不在→一回SIGUSR1→loopback Runtime.evaluate固定adopter→結果保存|既Inspectorを奪用しない。Debugger pause/heap query/全体quiet0。応答不明はinspect、別signal/同作用再発行0|

DFD：同main固定profile/source/adopter→package→既OIDC sidecar署名→公式verify→Root別具体作用でprivate固定dirへ配置＋operation→短命client→現Node Inspector→既class public method同期採用→同UUID耐久receipt→client解放/今回Inspectorだけ終了。進行中処理は旧instance上で実settleし、新規this.submitだけが修理版へ進む。

## 固定供給インターフェース

リポジトリ固定rootは `runtime-live-delivery-adoption/`。CLI：

```
python3 runtime-live-delivery-adoption/package.py --source "$SOURCE" --arch "$ARCH" --output "runtime/execution/live-delivery-$SOURCE-linux-$ARCH.tar.gz"
python3 runtime-live-delivery-adoption/package.py --check "runtime/execution/live-delivery-$SOURCE-linux-$ARCH.tar.gz" --source "$SOURCE" --arch "$ARCH"
python3 runtime-live-delivery-adoption/verify.py <archive> <archive.sigstore.json> --source <S> --signer <S> --arch <amd64|arm64>
```

別subject名は `live-delivery-S-linux-ARCH.tar.gz`、bundleは同名`.sigstore.json`。生成manifestはarchive直下 `manifest.json`、検証出力は `live-delivery-verified.json`。既execution asset同様Linux/Node26、CI archは既matrixのamd64/arm64。sidecarはJSだけだがarchを勝手に同一へ丸めない。一般execution catalogや47/48/50 inventoryへ登録しない。

mainに追加する固定profileは `profile/aiterm-transport.mjs`、`profile/bot-session-state.mjs`、`profile/source.json`。最初の2fileはMolly98f5cd20のsrc/原本と同bytes、source.jsonがbase421d/backport98f5/旧fileSHA/7methodを閉じる。正式archiveにはsource2file＋policy2file（literal importsだけ既file:///app/src/へ投影）＋src/adopter.mjs＋src/client.mjs＋profile.jsonを含める。差替えcodeの動作内容を変える投影は禁止。policy側private methodを採用しない。

署名期待：repository kitepon/BellTeam、repositoryId1404510084、signer-workflow kitepon/BellTeam/.github/workflows/publish-execution.yml、source-ref refs/heads/main、predicate-type https://slsa.dev/provenance/v1、source-digest=signer-digest=同main S、deny-self-hosted-runners、config/web-gateway-trusted-root.jsonl。新workflow/signing key/任意branch署名無し。

verify.pyはCI通常userでも同CLIで動く。archive/bundle/既policy/trusted-rootを実euid本人所有・no-follow/nlink1・group/other書込不可で固定FDへ開く。Root実配置用の検証ではeuid0なのでroot所有だけを受ける。CIのverification JSON自体に本番権限は無く、adopterはRoot段階の検証済root所有verification.jsonと別のRoot operation SHAを要求する。owner緩和flagや署名skipは無い。

literal参照の投影はstatic importだけでなくstatic `export ... from`も同じ元cached URLへ束縛する。実transport採用fixtureの初回は再exportが相対のまま残り、policy側の不存在aiterm-client.mjsで変更前に拒否されたため、この接点を明示して修理した。dynamic importは許可せず、7method本文は変更しない。

## Root実測を受けたstage接続

Root配置契約は旧maintenanceの別RO volumeを使わず、既RW `/run` tmpfs直下の `/run/bellteam-live-delivery-adoptions/<UUID>/` を使用する。新規root0:1001 dir0750/file0640、元ReadonlyRootfs/既mount/既dir権限は変更しない。機能/DFDはRoot固定operation→新stage→同client/loadOperationのROOTと `/run` 祖先確認→既UID1001 state intent/receipt。7method/schema/元owner/別subjectは不変。この共有配置pathだけを通常統合で合わせ、adopter業務ロジックは作者b899のまま継承する。

## 実作用の固定入力

Rootが別に確定するoperationのpathは `/run/bellteam-live-delivery-adoptions/<UUID>/operation.json`。同dirに検証済archive内容とroot-owned `verification.json` を置く。root0・group/other書込不可・regular/no-follow/nlink1を検証し、operation全bytes SHAはclient引数へpinする。parentはUID1001、PID/start/boot、/app/distribution.jsonの421dと元2fileSHA/7method指紋を検証する。未採取selectorを読まず変更せず、Rootのfresh公開builtin projectionとcached指紋を入力根拠にする。

operationはschema/operationId/target/policyだけ。targetはcontainerId（外側actor束縛）、namespace pid/startTicks/bootId/pidNamespace/networkNamespace。policyはsourceCommit/backportSourceCommit/archiveSha256/manifestSha256/verificationSha256/adopterSha256だけ。同UID1001専用 `/srv/bellteam/state/runtime-adoptions/<UUID>/` にclient-intent/intent/receiptを書く。普通入力を止めず、書込不明は同UUID照合へ。再発行・selector変更・旧53d操作・historical原文入力0。

Inspectorは同container loopbackの他processからも到達可能な強い実行権限。Rootは短命窓の隔離/actorと終了を具体作用に含める。本実装からそのOS作用を発行しない。code load/fsync/同期commitの遅延はあり、ゼロ遅延ではない。Debugger pauseやadmission closeは発行しない。

作者の26case/13.6ms backportケースは継承し再走しない。新確認はこの採用器の全7descriptor指紋、変更前拒否、同UUID非再実行、実transportの旧owner保持と一回入力、短命clientの同identity bootstrapだけ。

adopter内のcommitPreparedPolicyは、上表のintent fsync→同期descriptor commit→receiptという既契約だけを分離する。実file書込後失敗でも旧ownerや採用済み関数を後から戻さず、intentが同UUID再実行を拒否する接点を小さいfault fixtureで検証するためで、新しい公開入力/許可口ではない。

## Rootへ渡す実行形と確認結果

Rootは正式署名Sと対象CID/imageを別作用で固定し、検証後に同UUIDディレクトリへ全8archive member、`verification.json`、`operation.json`をroot0所有・UID1001読取可で配置する。`verification.json`はRootが同CLIで検証した出力であり、CI JSONを無検証で本番権限へ昇格しない。rootだけが配置し、他UIDから変更できるancestor/symlinkを使わない。manifestが束縛するclient bytesもRootが照合してから実行する。

同container・同pid/net namespaceでUID/GID1001として実行する固定CLIは次の形。`OP_SHA`はRoot固定operation全bytesのSHA256、`UUID`は同作用のUUIDv4である。Rootの具体actor/隔離/一回signal許可と実行直前本人照合が成立するまで実行しない。

```
/usr/local/bin/node /run/bellteam-live-delivery-adoptions/UUID/src/client.mjs apply /run/bellteam-live-delivery-adoptions/UUID/operation.json OP_SHA
/usr/local/bin/node /run/bellteam-live-delivery-adoptions/UUID/src/client.mjs inspect /run/bellteam-live-delivery-adoptions/UUID/operation.json OP_SHA
```

`inspect`は同UUID記録があれば歴史receiptとして返し、receipt未保存時に既Inspectorが残っていれば読み取り照合する。新signalや採用は発行しない。閉じたInspectorを勝手に再起動しない。通信喪失時は実適用が進行/完了している可能性があり、exit非0だけを根拠に別UUIDを発行しない。今回listenerの終了確認はRootの短命窓受入にも残す。

作者確認：実421d transport/SessionStateへの全7descriptor採用、旧unknown job/Map/Promise/callback/native所有維持、新native入力一回、元指紋不一致時変更0。耐久intentの重複・リンク・改変拒否とreceipt保存失敗時の非再実行も確認した。別の既起動Node26 fixtureでSIGUSR1/loopback/同PID/private brand/heartbeat/旧callback一回と今回Inspector終了を確認した。製品内部26caseは継承し再走していない。

package検査は固定inventory・arch拒否・ハッシュまで再計算された不正投影拒否を確認した。verifierのCI通常user/同FD/既verifier呼出配線は署名関数だけmockした接点確認で、暗号学的署名成功を主張しない。実署名はCentiの同main S runとRootの再検証が必要。本番root配置/実Inspector/AIメッセージによる反映結果は未実行。

独立Room採用候補82f218a8はMollyの別source/profile。Inspector制御と耐久receiptを当席責任として接続可能だが、Rootの別UUID/閉対象/具体作用が必要。この最初の7method profile/署名subjectへ混ぜない。親682e513の唯一writer組立も別単位。
