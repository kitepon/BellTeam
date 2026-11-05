# 提出済secretの管理caller

共通所有モリー、業務consumer/閉HTTPはusage所有ミカ。親は固定request009fedc7/tool claude-rabbit9-auth-20261105/requester bot-8bc1fb5dの管理能力のみを構成する。既Owner許可の技術照合assertOwnerAuthorizedと固定consume/createConsumerは管理assemblyからだけ注入、HTTP bodyやinternal trueで生成しない。通常seatRuntime graphは固定owner検証bridgeを構築する。明示的な未注入構成はconsumer口が503で閉じる。実消費と本番反映は別工程である。

```mermaid
flowchart TD
 HTTP[internal consume / 閉challenge2key] --> Seat[既resolveSeatBotId / 固定Centi]
 Seat --> Owned[bot secrets.getの実readとcompletion / owner-tool-submitted]
 Owned --> Owner[管理注入の既Owner許可を検査]
 Owner --> Grant[非serializable WeakMap grant / 元AI admission]
 Grant --> Consumer[usage固定consumer]
 Consumer --> Recheck[同seat / metadata / Owner許可 / admission再検査]
 Recheck --> Metadata[要求毎の新systemContext / metadata read]
 Metadata --> Claim[usage durable一回claim / 固定stdin consume / 閉receipt]
```

実HTTP→usage handler→captureSubmittedSecretContext→同一consumerのexecute。親captureはOwner専用submitによるsubmittedだけで認証consume許可を作らない。usage権限tokenは一回使い切りなので、metadata完了後再利用せず再検査は新bot token、管理readは要求毎新systemContext。元read.completion失敗はcapture失敗。grantはJSON偽造不可、固定request外/別Bot/既許可失効/元admission失効を拒否。秘密やchallengeは親記録へ保存せず固定consume閉包内だけ。取消はremote未作用の証明でなく業務claim/unknownを保持する。

親差分はapplication-services→application-runtime→http-server→createControlApi→usage.createUsageApiへの参照注入。usage handler/consumer/SSH adapterは作者source合成が必要。管理Owner許可の既接続expected/credential未配置を仮callbackで代替しない。runtime UID/reader/OS変更なし。必要正式供給はusage payloadに加えて親image（新common moduleと注入）であり、usage単独更新では成立しない。本番親反映は未解決JとRootの通常更新許可に従う。

## 両原申請の技術検証

`submitted-secret-approval.mjs`は既`createOlrwAuthorization`の検証部だけを使い、OLRW loader/attach/startを呼ばない。元申請時specから固定したK-3JM9PS/version3/start_now/requesterトロニーとK-6782UM/version3/entered_secret/requesterセンチのcontext/options SHAを持つ。現在のdecision応答から期待値を逆生成しない。consumeごとに両方を再検査する。既connectionId/userId/有効期限とreadBearer能力が無ければ構築を拒否する。Root本文/原本hash/Owner提出済み/AI受付可はこれを代替しない。

原期待specはRoot `integrations/background-agent-auth-owner-window-20261105/start-request-original-spec.json` とCenti `integrations/team-background-agent-supply-20261105/claude-auth-once-20261105/approval-spec-K-6782UM.json`。Centiのcontext原文には公式URLがあり、その文面を親source/成果物へ複製せずUTF-8原文hashだけで照合する。

実管理credential/connection参照はRootの独立identity原本へ固定した。`submittedSecretManagement`未注入は503で閉じ、検証済み管理能力が注入された時だけcaller/consumerへ接続する。現sourceのcallbackや合成試験を、現在の管理credential/connectionが技術成立した証明として扱わない。

## 登録credential所有主体での固定検証

Rootが13:09:33の独立connection GET identityを今回の検証先として採用した。既登録configはUID1000/0600のまま使い、管理1001は直接読まない。固定owner検証scriptを既base seat runner→固定Node/固定argvで実行し、両元spec/Owner/connectionを実照合する。tokenは1000内メモリだけ、戻りは閉schema/authorizedの2key。任意script/URL/path/credential入力なし。Owner照合失敗/未知/stdout追加field/stderrは親grantを作らず、opaque grant生成前に拒否する。child実close後だけ親へ戻る。固定回答の専用照合後、live固定検証は両原本照合を終えauthorized=true。これは認可接点までで、秘密消費成功や本番導入成功を表さない。

## 固定開始回答の添え書き

今回専用wrapperはK-3JM9PSの元回答answered_at=2026-11-05T03:12:22.959Zと、UTF-8/無正規化48B/SHA668c51b4b24fa19e654ba6d4ffadc54565620aca4c86f13835713f209b010780を実応答で照合する。成功後だけ既helper向けの応答内textをnullへ射影し、既helperが残る全本人・connection・版・選択・context/optionsを検査する。実応答は65536B上限、記録/外部返却なし。K-6782UMと旧OLRWの空text条件は同一sourceのまま。期待値はRoot start-answer-text-boundary.json（先行保存元回答）由来であり、今回応答から生成しない。
