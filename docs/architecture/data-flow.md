# BellTeam overall data flow

## Version, scope and canonical diagrams

This composition keeps body source **`1731cc273cd997f60d3822c1b23a393b2ed7be28`** and the separately deployed updater companions **`ecfc1dd6`** as its production baseline, as identified by Root. This diff composes the accepted **B close-only common ownership** and **A current-bound termination successor** source changes into the same upcoming formal source/image **S**. A's author source is `58eaf4217643b74bf82eb6e4c2ab628b779b806f`; its [runtime function/DFD](modules/runtime/module-installer.md#current-bound-successor-of-an-immutable-termination-record) owns the private predecessor/current evidence. Implementation and inherited checks do not claim S is deployed. This composition replaces the initial-review `9fcc` composition without relabeling that historical audit; the [1731 snapshot](https://github.com/kitepon/BellTeam/blob/1731cc273cd997f60d3822c1b23a393b2ed7be28/docs/architecture/data-flow.md) retains its amendments.

The [overall function map](feature-map.md), generated from each `module.json`, is the canonical dependency/ownership index. **This file is the single overall data-flow composition.** Each module README and its linked diagrams remain the sole authority for its internal functions, public I/O, state writers and failure handling. The tables below compose those contracts; they do not duplicate their implementations or assert that every module internal has been audited. Overall contract rulings belong to Root; Molly maintains this composition and normal-main adoption. Other owners keep their module scope in [module-ownership](module-ownership.md).

Covered changes since the initial review: durable per-target direct delivery and the parent direct writer; cold active-reference resume and shared child recovery; durable updater jobs, inspection/close and restart problems; scoped update events; deferred settings versus new input; and target-only screen reads. Existing members, usage, memory, diagnostics, Room, attachment, Bridge and distribution connections are retained through their public contracts. Native/CLI, Throughline, external providers and client internals are linked, not redrawn. A body version does not advance a selected release or a companion binary. Source/diagram completion does not prove a production update, successful old-operation reconciliation, runtime timing or an Owner-device outcome.

Opaque authorization, leases, callbacks, SDK request context and actual-completion Promises stay within their owning process. They are not serialized as synthetic proof. Every arrow below names data or an explicit public request/result; returned acceptance, saved output, change notification and actual completion remain separate.

## Context

The product boundary includes the body and its separately versioned updater companions; the diagram labels their distinct ownership below. Requests and responses are separate from SSE invalidation and provider/native outcomes.

```mermaid
flowchart LR
  E1[Owner clients and authenticated seat MCP]
  B[Body 1731: HTTP/MCP and composed module interfaces]
  R[Runtime updater companions ecfc]
  E2[Aiterm / native / CLI]
  E3[Publication / authentication / notification providers]
  E4[Throughline]
  E1 -->|C1 validated input / queries / explicit management| B
  B -->|C2 acceptance / saved views / operation results or errors| E1
  B -->|C3 scoped change notices| E1
  B -->|C4 target input / configuration / observation / resume| E2
  E2 -->|C5 acceptance / output / execution and read results| B
  B -->|C6 bound updater requests| R
  R -->|C7 stored jobs / receipts / fences or errors| B
  B -->|C8 catalog and provider requests| E3
  E3 -->|C9 published assets / authentication / notification results| B
  B -->|C10 context query| E4
  E4 -->|C11 recorded context| B
```

## Processes, public contracts and failure ownership

Process IDs identify responsibilities, not execution order. Host composition can implement part of a module's interface without acquiring that module's business-state ownership.

| ID / owner | Public input -> output | State and failure boundary / canonical detail |
| --- | --- | --- |
| P1 integration / Molly | Authenticated HTTP/MCP -> same composed services; acceptance, saved views, closed error DTOs and SSE | Authentication, caller context, parent assembly and projection. [Integration](modules/integration/README.md), [entrypoints](entrypoints.md). Internal updates remain forbidden; an internal seat or JSON actor is not Owner authority |
| P2 conversation / N102, parent assembly / Molly | Direct/Bridge input -> durable receipt; target-lane dispatch -> saved callbacks; history/Room operations -> pages and changes | One parent direct writer, separate existing Room ownership. Receipt fsync precedes queued acceptance; unknown input is not replayed. [Durable receipt](modules/conversation/durable-receipt.md), [parent receipt connection](modules/integration/message-receipt.md), [conversation](modules/conversation/README.md) |
| P3 execution / Kiro; native / Elegg | Bound target input/configuration/resume/observation -> native acceptance, callbacks, tracked completion or read result | Dispatch ordering, desired settings and real execution references. Deferred settings do not block running-turn input. Screen failure is this tick's display availability, not proof of absence. [Configuration/delivery](modules/execution/configuration-delivery.md), [screen](modules/execution/screen-observation.md), [host factory](modules/execution/host-factory.md) |
| P4 members / Belorta | Profile, schedule, instruction, membership and Owner-data requests -> registry projections and saved results | Members owns registry/project writes. A copied profile is not a second authoritative registry. [Members](modules/members/README.md) |
| P5 usage / Mica; parent AI admission / execution | Settings/authentication/cards/notification requests -> stored settings, cards and provider results | Secrets remain with their consumers; only authorized display/card projections cross to P1. [Usage](modules/usage/README.md) |
| P6 memory / Biscuit | Scoped remember/search/knowledge requests -> saved records or search results | Personal/shared scope and DB writers remain memory-owned; no startup bulk-copy into another module. [Memory](modules/memory/README.md) |
| P7a common updates / Molly | Owner plan/start/read/inspection requests -> bound parent operation and runtime projections | Parent plan/step/inspection ledger is distinct from runtime job storage and adopted release selections. [Common updater jobs](modules/integration/update-jobs.md), [inspection/close](modules/integration/README.md#同install-idのinspectionと明示close入口) |
| P7b runtime / Epinel, distribution / Centi | Fixed release/plan/UUID/key -> installation, stored jobs, candidate readiness, receipts and fences | Companions, installer, shared child controller and recovery retain their own versions and writers. [Runtime jobs](modules/runtime/update-jobs.md), [installer](modules/runtime/module-installer.md), [shared child lifecycle](modules/runtime/module-process.md), [distribution](modules/distribution/README.md) |
| P8 diagnostics / Signal | Allowlisted caller/restart observations -> serialized diagnostic records and closed problem projections | No inference of missing historical evidence; read/write failures remain explicit. [Diagnostics](modules/diagnostics/README.md), [restart problems](modules/diagnostics/module-restart-limit.md) |

## Delivery, history and display composition

```mermaid
flowchart TB
  E1[Authenticated client / seat / Bridge]
  P1[P1 HTTP/MCP and display projection]
  P2[P2 stable direct receipt and target lanes]
  Child[P2 conversation child / Room and history interfaces]
  P3[P3 execution and native connection]
  P4[P4 registry]
  P5[P5 settings / AI admission / cards]
  D1[(D1 direct JSONL and attachments: sole parent writer)]
  D2[(D2 Room definitions and history: existing Room writers)]
  E2[Aiterm / native]
  E1 -->|F01 actor / target / body and asset references| P1
  P1 -->|F02 validated direct intake| P2
  P2 -->|F03 fresh profile query| P4
  P4 -->|F04 profile projection or rejection| P2
  P2 -->|F05 queued receipt and asset fsync| D1
  P2 -->|F06 saved delivery ID / queued acceptance| P1
  P1 -->|F06 receipt, not AI completion| E1
  P2 -->|F07 normal ready / per-target saved-ID dispatch| P3
  P5 -->|F08 explicit AI admission result| P3
  P3 -->|F09 bound target input| E2
  E2 -->|F10 acceptance / output / actual completion| P3
  P3 -->|F11 same-ID status / words / answer callbacks| P2
  P2 -->|F12 serialized callback append| D1
  Child -->|F13 registered direct.log.append| P2
  P2 -->|F14 saved append ACK| Child
  Child -->|F15 Room save| D2
  D2 -->|F16 saved Room rows| Child
  P1 -->|F17 history query and parent card positions| Child
  D1 -->|F18 saved direct rows via existing reader| Child
  P5 -->|F19 card snapshot kept by parent| P1
  Child -->|F20 page / source-index references| P1
  P1 -->|F21 saved timeline and matching card view| E1
  P2 -->|F22 parent store change| P1
  Child -->|F23 existing child change| P1
  P1 -->|F24 topic / target IDs, not timeline body| E1
```

| Connection | Current composition and limits |
| --- | --- |
| F02-F07 receipt and execution | The parent owns one `DurableMessageReceipts` instance. A validated direct record and assets become queued only after persistence; current execution/child admission is not a prerequisite for saving that receipt. Existing onPending, available execution/conversation and explicit AI-enable events request drain; there is no new polling/retry service |
| F07 target lanes | One lane per target preserves that target's saved order and picks up later queued records. Lanes run concurrently; another target's native acceptance cannot hold all targets. The parent request cycle kicks lanes without waiting for their acceptance; close still waits the cycle, lanes, actual completions and append queue. Saved dispatching/unknown/accepted inputs are not replayed; only the existing exact not-started contract permits queued continuation |
| F11-F14 direct writer | All direct records, including child-originated records, use the sole parent writer. The child forwards append through the registered effect and receives its saved ACK; it does not create a fallback direct JSONL writer. The existing child emit and parent store watch preserve notification ownership without double-publishing the same child append. Room writers remain separate |
| F17-F21 history | The parent keeps one request's card body snapshot, sends only card id/at positions with the user's page query, then resolves returned references against that same snapshot. The current parent direct reader also serves public display where composed; it reads the same D1, not a copied ledger. See [history](modules/conversation/flow.md) and [parent page composition](modules/integration/README.md) for their distinct callers |
| F22-F24 events | Timeline notices prompt a history GET; publication and append timestamps are not proof of client rendering. The existing coalescing window is not an end-to-end latency bound. Update events use the separate scoped flow below; they do not request an all-resource timeline refresh |
| Configuration and screen | P1 also calls P3 directly for its authorized management/observation interfaces. Same-harness deferred settings stay tracked but ordinary input skips that deferred barrier; the eventual apply joins the same per-Bot acceptance chain. A screen GET performs one target `pty_read`, without `pty_list`; success, including empty success, yields online, while a call failure logs the original server error and returns offline/empty for that tick. This does not prove that the session is missing |

Direct entrypoints and error framing: [HTTP conversation](../../src/http-conversation-api.mjs), [stable receipt assembly](../../src/direct-receipt-assembly.mjs), [durable receipts](../../src/durable-message-receipts.mjs), [HTTP screen caller](../../src/http-bot-api.mjs). These links locate composition points, not a second copy of their contracts.

## Startup, restart/resume and child loss

| Flow | Source of state -> public action/result | Failure and ownership |
| --- | --- | --- |
| Cold body startup | Adopted release selections and same business stores -> existing parent assembly -> controller start -> ready producers | Runtime launches the selected code; initialized source and persisted selection are distinct. [Runtime module start](modules/runtime/module-start.md), [integration](modules/integration/README.md) |
| Actual prior-active reference | P3 accepted/observed native work -> D9 execution-owned active-only reference -> cold startup consumes once -> supported promptless `require_existing_resume` -> existing conversation and one authorized gap-summary path | No saved task body replay, fresh fallback or launch for idle/missing/unsupported references. Corrupt activity prevents automatic reconnect, not ordinary application startup. Hot handoff carries references and does not repeat cold resume. [Restart/resume](modules/execution/restart-resume.md), [distribution contract](modules/distribution/restart-resume.md) |
| Child loss and replacement | Current child's pending calls -> recorded unknown outcomes; observed writer death -> shared selected-source recovery -> current child | Old native/completion references remain facts, not a new-operation or recovery lock. Planned exchange still ends the actual writer before replacement. Shared cancellable backoff resumes a retained generation or restores selected code; it never replays the failed business request. [Current lifecycle](modules/runtime/module-process.md), [conversation process](modules/conversation/process.md) |
| Configuration after readiness | Saved desired settings and configuration epochs -> same execution controller -> actual apply/receipt; available events -> existing direct pending drain | Desired save, actual apply, ready, dispatch acceptance and business completion remain different results. Repeated lifecycle resume ACK may acknowledge the same already-running engine without restarting producers. [Configuration/delivery](modules/execution/configuration-delivery.md), [host factory](modules/execution/host-factory.md) |
| Repeated child restarts | Actual runtime attempt/window observations -> P8 diagnostic writer -> open/resolved problem -> P7a inventory -> P1 update view | Problems expose stored evidence, not a stop/restart policy. An unavailable/read failure cannot be fabricated as a healthy record. [Restart limit](modules/diagnostics/module-restart-limit.md) |

## Update jobs, inspection and scoped update events

```mermaid
flowchart LR
  E1[Owner update UI / authenticated public request]
  P1[P1 authorized update API / projection]
  P7a[P7a common plan and operation executor]
  D7b[(D7b parent plan / step / inspection ledger)]
  P7b[P7b runtime companion public client]
  D7c[(D7c runtime jobs / install receipts / fences)]
  Controller[Owning module controller / real candidate probe]
  P8[P8 diagnostic problem projection]
  E1 -->|U01 plan / start / explicit inspect or close| P1
  P1 -->|U02 bound action / UUID / idempotency key| P7a
  P7a -->|U03 parent bindings / receipts / terminal report intents| D7b
  D7b -->|U04 saved operation and inspection| P7a
  P7a -->|U05 admit each step / install / job read / bound reconciliation| P7b
  P7b -->|U06 atomic runtime records| D7c
  D7c -->|U07 stored job / receipt / fence or read error| P7b
  P7b -->|U08 same-ID runtime result| P7a
  P7a -->|U09 prepared target / activate| Controller
  Controller -->|U10 actual public-interface readiness or failure| P7a
  P7a -->|U11 swapping / ready / failed report| P7b
  P7a -->|U12 saved operation / jobs or explicit read error| P1
  P8 -->|U13 closed open/resolved restart problems| P1
  P1 -->|U14 GET inventory / operation / saved reconciliation| E1
  P7a -->|U15 saved change or operation completion| P1
  P1 -->|U16 changed jobs/error or settled operation, topics updates, all false| E1
```

| Connection | Public boundary, persistence and failure |
| --- | --- |
| U01-U08 admission | A plan preview admits no job. Start returns 202 only after every step's runtime admission and parent receipt are saved. Partial admission is `admission:pending`, not a seventh job state. Same bound key/plan retains its IDs. Six stored states are queued/downloading/verifying/swapping/ready/failed; legacy unknown operations retain their historical representation |
| U09-U12 activation/readiness | The owning controller prepares/activates and completes its real public-interface probe before ready. Runtime stores its job; common stores parent bindings/report intent. A stored terminal report may be acknowledged idempotently without repeating activation. Reader errors remain explicit; no synthetic success or job state fills missing storage |
| Inspection versus saved read | Reconciliation GET returns only the saved parent inspection/resolution. Explicit inspect POST calls runtime inspection and persists its receipt in D7c and D7b: it is effectful. Current body exposes the existing public Owner route; an internal seat, schedule, actor JSON or historic decision is not an Owner grant. [Common inspection/close](modules/integration/README.md#同install-idのinspectionと明示close入口), [runtime inspection](modules/runtime/module-installer.md#元install-idの追補照合明示解決) |
| Explicit close (A+B delta) | The executor-local ledger/exchange owner excludes active original work and checks the exact original, apply-not-issued, claim, fresh Owner authorization, current and catalog bindings before a new durable claim. Runtime owns the actual original worker, storage, predecessor/successor and fence checks; a matching fence and parent completion converge the same claim. Retained intent uses readFence only, with no new finalize, admit, work or read reconciliation. No global application mutex or native/writer drain is added; normal Bot reception remains available. [Common close contract](modules/integration/update-jobs.md#close-only-function-and-data-flow-delta) |
| U13 restart problem | Runtime owns attempt/healthy-window observation; diagnostics owns serialized problem state. Common forwards the closed `problems[]` projection. Missing save/read evidence is not invented; diagnostic/private log storage is not exposed as an arbitrary update API |
| U15-U16 update events | Only saved changes and operation completion invalidate the update view. Read-only inventory refresh does not notify. The existing publisher coalesces reads, retains a pending invalidation and drops identical jobs/error bodies except for actual module-work settlement after active is cleared and the exchange reservation is released. That internal completion hint forces one inventory invalidation without changing the public event shape. Events are scoped to updates with `all:false`, not a global refresh. Web/Apple re-read the inventory; Apple runs that side refresh independently of receiving timeline events. [Common jobs/events](modules/integration/update-jobs.md), [Web updates](modules/web/README.md), [Apple sync](modules/apple/state-and-sync.md) |

## State ownership and physical write boundaries

State IDs below identify existing stores; they introduce no new persistence. Relative `root` is the existing composed data root, not a guessed host mount. A controller's memory state and its durable adoption ACK are not interchangeable.

| Store | Authoritative owner / physical writer | Readers and public return path |
| --- | --- | --- |
| D1 direct messages, delivery status, interim output and asset references | Conversation/N102 business contract; **single parent DurableMessageReceipts writer**, with child `direct.log.append` forwarded into that queue. Attachment fsync uses existing Assets | Same ConversationStore reader, direct receipt drain, current history/display composition; callbacks stay bound to original IDs |
| D2 Room definitions/history | Existing RoomRegistry/RoomMessenger writers under conversation ownership | Room access/history and members membership cleanup use their public interfaces; no parent-direct-writer ownership is inferred for Room internals |
| D3a configuration intent/receipt audit | Execution's ConfigurationIntents and request handling | Per-Bot execution/configuration read; desired profile is D4 and receipt is not an admission lock |
| D3b adopted release selections | Each controller's existing durable adoption callback/store; execution uses `state/execution-release.json` | Parent startup/controller selection and current/previous display. No selection file is copied into the update ledger or changed by merely loading a newer body |
| D4 Bot/profile/schedule/project instructions | Members registry and ProjectFiles | Fresh member/profile projection to conversation, execution and public views; schedule claim/dispatch uses the members/scheduler contract |
| D5 settings, questions, secret requests and AI-control state | Owning usage services; parent AI-control writer remains separately owned | Authorized settings/auth/card consumers; P1 gets only appropriate display projections, never an invented credential grant |
| D6 memory/knowledge | Memory's existing scoped DB and knowledge writers | Scoped public read/search through its facade; runtime process/proxy does not acquire memory business ownership |
| D7a verified release assets | Existing runtime/distribution installation paths | Owning release loaders/controllers validate manifest, selected code and compatibility; material availability is not adoption or runtime readiness |
| D7b common update ledger | `createModuleUpdateExecutor` serialized atomic save in `state/update-ledger/ledger.json`; all mutating publicJobs, report flush and interrupted-read reconciliation saves share the executor-local owner with close | Common plan/operation/inspection/readback and terminal-report reconciliation; no direct mutation of runtime jobs |
| D7c runtime jobs and install receipts/fences | Updater companion's own atomic storage/installer writer | Existing body clients -> common projection; saved companion source/binding and actual disk error remain visible, separate from parent code version |
| D8 diagnostics and restart-limit problem records | Diagnostics/Signal serialized writer | Closed diagnostic/problem projection; historical missing fields are not reconstructed |
| D9 active-only restart references | Execution writer, `state/execution-activity.json` | Cold resume selection and hot handoff; consumed references are not a new queued-input store |

## 親execution境界の詳細対応

This existing anchor is retained for its callers. The overall boundaries are P1/P3 for authenticated management, P3/P2 for delivery-anchor/history reads, P3/E2 for native control/receipt and P3/D3a-D3b for intent/adoption state. Their single detailed contracts remain [integration model handoff](modules/integration/model-handoff.md), [execution consumer](modules/execution/model-handoff.md) and [host factory](modules/execution/host-factory.md). The named `9fcc` case in those documents is a historical compatibility explanation, not a declaration that all native handoff stages or every selected module have completed.

## MH04–MH06 read-window修理のデータ寿命

This existing anchor is retained for catalog/consumer references. A caller's deadline stops its own wait and rejects late preparation; the original read's authorization and actual completion remain tracked until real termination. Parent card/history context, native lease identity and opaque host callbacks are not replaced by serialized promises. See the [execution wait/completion contract](modules/execution/model-handoff.md) and [integration binding](modules/integration/model-handoff.md) for the exact supported fields and remaining limits; this overall composition introduces no cancellation RPC or new handoff schema.

## Coverage, inherited verification and concrete limits

The composed owner contracts above cover the requested post-9fcc connections at body1731 plus the accepted A+B close-only delta in this diff. Existing author verification for per-target receipts, restart/resume/shared lifecycle, job/inspection/reporting, scoped updates, deferred input and target-only screen read is inherited; no internal source audit or successful test group was repeated for this documentation. The generated function map and module descriptors remain unchanged. This revision checks its own links and flow/store ownership, not runtime success.

One concrete operational mismatch remains **Q-1**, owned by runtime/Epinel and Root's separate decision: the saved original install's worker-termination receipt binds source421d, while the selected installer companion configuration binds ecfc. If that bridge remains current, a new inspection can persist `HOST_MODULE_INSPECTION_UNCONFIRMED`; the saved inspection's old runtime-current binding is not a fresh proof. The new body, a saved GET, this diagram and an inherited successful lab update cannot resolve that source-bound receipt or authorize a new close. Runtime A now implements a separately published immutable current-bound successor, minted only by an explicit authorized inspection; finalize and read paths only validate an existing successor. Common B retains the same original-ID claim and public authentication/receipt connection. Matching body and installer source S still require a separate operational decision and supported image-only body plus generated companion adoption; full install.sh/Switch compatibility is not claimed. Production module-only updating is therefore still incomplete. No general old-operation/J/Host work or reconciliation is authorized by this revision.

External/native/provider internals, every endpoint's internal algorithm, arbitrary selected-release compatibility and every Room/image path are outside this overall-level reconciliation. Their owner links are the coverage boundary, not unresolved ownership. The overall composition adds no runtime layer or store. The A+B source changes and two scoped author checks ship in this diff; A verification is inherited without rerun. Natural image creation and Centi supply follow normal main. No production inspection/close/replacement, extra product gate or claim that all internals are verified follows from source completion.
