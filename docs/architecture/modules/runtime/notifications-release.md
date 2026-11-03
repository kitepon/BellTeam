# 通知の固定資材・起動・writer排他 v1

runtime所有：エピネル。基準03c952bf。Rootの固定契約 `/srv/bellteam/bots/bot-7b140b27/docs/notification-update-contract-20261103.md` に従う。[全体図](../../feature-map.md)→[runtime](README.md)、通知内部は[usage](../usage/README.md)、組立ては[integration](../integration/README.md)、署名供給は[distribution](../distribution/README.md)。同UID1001の協調writerと寿命を分ける。別UIDのOS隔離は残る。

```mermaid
flowchart TD
  Install[既installer: --install-notifications / 承認済SHA・source・signer] --> Root[roothelper: private SH + 配置EX / 公式verifier]
  Root --> Store[notifications/releases/SHA / root immutable]
  Store --> Reader[prepareNotificationsRelease / protocol1・stateSchema1]
  Reader --> Controller[通知controller: prepare / quiesce / ready / adoption]
  Controller --> C[固定非特権C entry / UID1001]
  C --> Lock[子自身: private SH FD4 / notifications.lock EX FD5]
  Lock --> Child[通知子 / state・provider・inflight・saving]
  Facade[Mika facade / 既IDと名前だけ / 未送信buffer256件1MiB] <-->|匿名Node IPC FD3 / 閉じたschema| Child
  Controller -->|quiesce60秒・未完はresume| Child
  Controller -->|quiesced後だけexit5秒・ready45秒| Child
  Controller --> Adoption[親: notifications-release.json atomic]
  Child --> State[既push-devices.json / schema1据置]
  Child -->|診断・ACK / drain中も有効| Diag[親の唯一Diagnostics writer]
```

## 公開sourceと所有

- `src/notifications-process.mjs:createNotificationsProcess({root,configuration,onDiagnostic,onState,prepareRelease})`。start/close/request/replace/snapshot/reserve、同一controllerをassembly/facade/更新HTTPへ注入。reserveは202 finish後start/cancel、二重更新・configure進行中409。phaseとexchanging/availableをonStateへ返しMikaのunsent bufferを接続。
- `src/notifications-ipc.mjs`は専用channelのschema/相関/accepted/期限。業務5methodだけ、UTF8 JSON64KiB/未終端64、status/device30秒・configure90秒。送信試行後の期限/断線はunknown、未送信/明示拒否だけnot_accepted。再送しない。
- 同moduleのchild factoryはvalidateRequest/dispatch/control/disconnectを通知内部へ接続。controlはinitialize/quiesce/resume/exit。readyは固定version/protocol/stateSchemaとstatus/applyError。診断専用相関5秒、親writerの失敗を送信retryにしない。
- `scripts/notifications-start.c`はimage固定`/usr/local/libexec/bellteam-notifications-start`。builtin又はSHA64だけ、Node固定、最小env、親のlock FD非継承。IPC3は新channel、lock4/5は子自身で開く。Node側`src/notifications-locks.mjs:verifyNotificationsLocks`がFD/inode/metadata/kernel flockを確認してから通知のstateへ触れる。
- `src/notifications-release.mjs:prepareNotificationsRelease(id,{signal})`→`{versionId,appRoot,protocolVersion:1,stateSchema:1}`。既Web readerの固定2component内部検査を共用、Web schemaは不変。
- `scripts/install-notifications-release.py`は固定3引数。Web roothelperの安全処理を固定通知policyで共用。`src/notifications-install-plan.mjs`と既install.sh専用modeはnormalの停止0・CID/image/mount厳密確認・既private volumeだけRW。verifier/packager/Dockerfile収録はCenti。

現callerはapplication-services生成/初期化、conversation-servicesのdirect/room、SecretRequests/OwnerQuestionsのonRequest、usage HTTP status/register/unregister、application-features configure、application-runtime close。通知内部/facade/handler awaitはMika、共通組立て/HTTP/診断はMolly。親内PushNotificationsを生成し続ける互換fallbackは置かない。設定と診断writerは親、端末Mapとsave・APNS_UNREGISTEREDも子だけ。

## 排他・保存と交換

固定資材は既private root/notifications/releases/SHA、normalからreadonly `/run/bellteam-maintenance/notifications/releases/SHA/payload`。root0555/0444、公式receipt確認後installation最後・NOREPLACE公開。配置EXは業務writer EXと別。manifest runtimeはlinux/native arch/Node26/parentProtocol1/stateSchema1、entry固定payload/src/notifications-entry.mjs。全file inventoryと信頼・互換を旧子稼働中に検査する。

専用writer lockは既state/notifications.lock、1001/0600/通常file/NOFOLLOW/nlink1/inode一致、unlink禁止。子のprivate SHは親死亡後も保守EXと競合。既親server-startのstate全体EXは親に残し子で再取得しない。全体の新親は旧子lockが残れば新writerを作れない。

採用recordは親のstate/notifications-release.json、1001/0600、schema bellteam.notifications.adoption.v1/currentVersionId/previousVersionId。record無しだけbuiltin。破損/未知recordは黙ってfallbackしない。current/previousをstartupで検証。stateは既配列形式のまま、保存snapshotへ巻き戻さない。

prepare→新受付停止→quiesce60秒。未終端なら旧子を殺さずresume ACK後同旧子へ戻す。resume不明は通知unavailableを返し新子を起こさない。quiesced後のみexit→5秒で対象子KILL可→OSclose/stdio回収→新版。新版はlock/state/configure後ready45秒、readyとadoption保存後に受付を開く。失敗は新子回収・旧資材再検証・同じ現stateで旧版戻し。新旧writerを重ねない。disabled/provider未設定/relay利用不能は構造readyと通知statusを分ける。state/鍵/lock破損はready失敗。

親closeは交換abort・新起動/rollback抑止・有限回収。親消失はIPC切断で子新受付停止、最大60秒で終了。未終端はunknown、再送しない。診断の親ACKを待つ場合もdrain中は診断窓口を残す。子だけの終了やWeb受付交換から業務親/会話/AI/transport.closeへ伝播しない。

## 直接確認

実C/人工Node子で新旧lock競合、子自身private SH、親死亡と有限終了、quiesce期限超過/resume、quiesced後5秒回収、ready/adoption失敗と旧版戻し、同state保持を確認する。IPCで64KiB/64要求、ACK前後の切断/期限unknown、拒否not_accepted、診断5秒と無再送を確認。reader/rootwriterは通知/Web取り違え・stateSchema拒否・完全集合・immutable/lock/NOREPLACE/失敗cleanup。実root/1001/署名/Host/実配送の成立は各実物結果で区別する。全成功群の定型再走はしない。

親消失の60秒期限は子Nodeのevent loopが進むことを前提とする。同期JS/nativeの永久停止を外部watchdogで回収する機構は今回追加していない。OS終了/IPC切断/所有pipe closeが全て揃うことを回収条件とし、親からIPCを切断した時のNode26のcloseイベント欠測経路も同じbarrierで回収する。

Root初回受入追補：reserve/replaceはSHA64のほか固定literal builtinだけを許し内部nullへ正規化する。currentVersionId:nullの採用recordも明示builtinとして読み、previousは直前SHA/null。snapshotのcurrentTargetとbuiltinSourceCommitは、固定/app/distribution.jsonのroot-owned通常file/size/schema/source確認とimage固定C入口に束縛する。任意path/metadataをAPI入力にしない。初回builtin A→同source署名B→builtin Aで受入し、異source互換の証明にはしない。
