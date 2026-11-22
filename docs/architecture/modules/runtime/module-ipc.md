# 共通の有限IPCとstream

所有モリー（runtime/module.json）。既membersの低層endpointを`src/module-ipc.mjs`へ移し、業務context/DTO/actor/readyは各module固有adapterが注入する。membersは従来status集合・エラーprefixとstream無しを維持し、read pinを含む公開意味を変えない。

`createModuleEndpoint(endpoint,{validateResult,onRequest,onDisconnect,afterResponse,afterResult?,streamed=false,errorPrefix='MODULE',statusCodes?})`はcall/pending/counts/running/send/fail/reaped/close/snapshotを返す。call(kind,method,params,context,{timeout=60000,beforeSend})のPromiseは実終端`.completion`を持つ。kind別root/effect/callback64（共通MODULE_CONCURRENCY）、projection1、その他16、body16MiB/envelope64KiB/業務buffer64MiB/control1MiB、ACK5秒、caller deadline60秒を保持する。期限/断線はpending completionを解放しない。reapedはOS/pipeと親effectの実終端を確認したcontrollerだけが呼ぶ。

`afterResult(task,value)`がPromiseを返すとmetadataをcallerへ返した後も、そのPromiseが終わるまでroot credit/実completionを保持する。大list/private snapshotの実読取・反映ACKをここへ結び、metadata ACKだけで次世代へ移らない。taskはid/kind/method/context、beforeSendで同期に登録できる。afterResponse(message,value)は返信の送信後で、exit→disconnectはここから行う。

`drainIncoming()`は受信済parent effect/callbackとafterResultの実commitを待つ。子のOS/pipe終了後も親保存が残る場合があるため、固有parent channelはこの関数を公開し、controllerはその終端後だけreapedを呼ぶ。切断後にreapedを待つoutgoing credit自体は含めず、循環を作らない。

streamed:trueのendpointは既open/data/credit/end/closed/abort/rejected/controlを同channelのstream機構へ渡し、`createModuleStreams(...,{rpcFrames:true})`はcall/accepted/resultをRPCへ渡す。未知frameは拒否する。`module-streams.mjs`は既conversation実装の共通移管で、256KiB/4credit/8stream（4はcallback/continuation予約）、履歴は同snapshot AsyncIterableの逐次JSON。既conversation-streamsは再exportだけにし同じ契約を参照する。履歴laneの総量制限無しは既意味を保ち、他body96MiB+64KiBを緩和しない。 失敗または`close()`でstreamsを閉じても`message`listenerは外さない（`disconnect`だけ外し、`dead`で以後のframeを捨てる）。同じreadに未処理frameが残る間にlistenerが0になりchannelが閉じると、Node 26のchild_processがchannel null参照の未捕捉TypeErrorで本体processを落とす（2026-11-20試験環境で1回、再現は最小scriptと`test/module-streams-close.test.mjs`）。

新moduleの固定error code/outcome/statusだけをwireへ出し、statusは整数400..599。自由message/stackを送らない。legacy membersだけstatusCodes=[400,403,404,409,503]を明示し既型を保持する。Root再採否や既業務成功群の再走は加えず、新stream共存/実body終端/status保持と変更したmembers低層の境界だけを検証する。

root呼び出しは同時64を超えると、拒否せず種類別root専用のFIFO待ち列で空きを待つ（BugHub ef83d4ee: 一覧画面のavatar約123件が同時に来て67件が503になった）。待ちの期限は呼び出した時刻から数えるcaller deadline（既定60秒）で、期限切れは未送信のまま`MODULE_IPC_TIMEOUT`/`not_accepted`で列を抜ける。断線・fail()は待ち全件を`MODULE_IPC_DISCONNECTED`/`not_accepted`で返す（これが待ちから抜ける道）。空きは実completion（`finish`）とissue失敗の全出口で返し、期限切れで呼び手へは失敗を返したin-flightも、実resultが来た時点で次の待ちへ空きを渡す。次の発行は1ターン後で、相手が同じ空きを解放してから送る。effect/callback/projection/control等は従来どおり上限で即拒否する（root実行中の入れ子で、待たせると同じ上限を待って詰まるため）。受け側の上限確認と業務buffer64MiBの確認は変えない。

Owner PR319により親子root/effect/callback（会話event含む）はMODULE_CONCURRENCY=64を共有する。親admissionのleaseは件数を数えない（a505b）。projection1/control・diagnostic16とstream通常4/全8は別の予約予算。業務buffer64MiBは未送信・dispatch待ちframeの予算であり、稼働中64処理の総RSS上限ではない。

## Records between halves that ship apart (2026-11-18, a399)

The body image and every module payload carry their own copy of the same validator files and are swapped one at a time, so at any moment one half may be older than the other. Three trains failed on this (Z89, Z91, Z94): a closed check in the older copy refused a record of the newer half, and one refused record stopped the whole module. This section is the canonical rule for every body<->module record; module pages point here.

| Kind of message | Who reads it | Rule |
|---|---|---|
| Data record: a child's result, a projection row, the body's effect result | the half that only uses the data | Check the fields this side uses (presence, type). An unknown field is not a reason to refuse. A field a newer writer adds is optional for the reader until every shipped writer sends it. |
| Ask: a request, an effect request, a control call | the half that acts on it | Stays closed (method table, parameter names, actor). An unknown ask is refused for that one call (`not_accepted`); it never stops startup. |
| Value set (harness names, providers, states) | both | Widen the reader first, ship it, then let a writer send the new value. To drop a value: stop writing it, ship, and only then stop reading it. Stored data counts as an old writer. |
| Envelope (type, kind, id, lanes, stream frames) | both | Exact. A broken envelope means the two ends are out of step: the channel is cut and the child restarts. |

Where a refusal ends (`createModuleEndpoint`):

| Refused thing | Result | Leaves it by |
|---|---|---|
| a result value `validateResult` cannot read | that call rejects with `<PREFIX>_RESULT_INVALID` (or the validator's own code), outcome `unknown`, status 503; pending calls and the channel are untouched | the caller's own error path; the next call proceeds |
| an incoming ask `onRequest` refuses | error reply for that call | same |
| a broken envelope, size or sequence | `protocolFailure`: channel cut, child reaped | the controller's restart (module-process.md) |

Refusals that stay, and what each protects (guards.named-protection):
- secret values never enter a public record: a settings field marked secret carries an empty value, a `secret` row carries no `value` (secret exposure);
- actor and authority checks on asks (privilege escalation);
- size, count and sequence limits (the body's memory, wrong peer);
- `stateCompatibility` at install, adoption and `ready` (overwriting stored state in another format).

- a closed key list on a row the body serves as stored when a secret sits next to it (secret exposure). In usage these are the `secret`, `question`, `settings` and `credential` rows and the credential DTO results (Mika's ruling 2026-11-18): the list is the only thing between a child bug and an HTTP body. A field added to one of them needs a body that knows it, so that train carries a container row and the body goes first.

A closed key set on any other data record is none of these. It protected nothing the checks above do not, and it made a one-field addition fatal, so it is removed where this rule is applied. Applied so far (usage): the `subscription`, `onboarding`, `auth`, `event` and `credentialRecovery` rows and every result that is one of those rows (`usage/projection.mjs`), and the effect results `members.read`, `onboarding.ensureGuide`, `rooms.read` on both sides (`usage/channel-protocol.mjs`; `usage/registry-ports.mjs` keeps only the fields it uses). The other modules keep their checks until their owner next changes a record; they follow this table then.

Effect on trains: a body that has this rule reads a newer module's data records, so a module row may ship alone after it. A body older than this rule cannot be changed; a train whose changed files are in the body's import closure carries a container row and the body goes first. `test/mixed-version-start.test.mjs` starts the usage child of the published catalog row under the current body, which is that order.
