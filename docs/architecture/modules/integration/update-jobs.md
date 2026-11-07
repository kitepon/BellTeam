# Common update jobs: HTTP, SSE and activation

Runtime source contract: [runtime/update-jobs.md](../runtime/update-jobs.md). Owner: Molly for common projection, parent activation reports and normal main. Runtime owns the on-disk records/client/probes/restart observation; Signal owns diagnostic validation/storage/projection; Admi owns Web. Source and diagrams ship together. This contract is written before the corresponding code.

## Public API

| Existing update surface | Contract |
| --- | --- |
| POST /api/updates/plans | Existing preview only; no job is admitted |
| POST /api/updates/operations | Existing body plus optional idempotencyKey (1..128 printable ASCII); returns202 `{operation}` only after EVERY step's runtime admitJob receipt has been saved in the existing parent ledger |
| GET /api/updates/operations/:requestId | `{operation}` with optional `jobs:[record,...]` for new operations; records are freshly read from updater storage. Legacy operations have no invented job |
| GET /api/updates | Existing inventory plus `jobs:[record,...]`, newest16 across both updater clients; existing operation/previousOperation each retain their own jobs[]. `kind:"runtime"` jobs, runtime rows and runtime plans/operations appear only with `?runtime=1` ([runtime-updates.md slice D](../runtime/runtime-updates.md#inventory-plan-and-start-slice-d)); without it the body is the pre-Z-b2 shape |
| GET /api/updates/jobs/:kind/:jobId | `{job:record}` read directly from the corresponding updater client; kind is module or container, UUID is validated |
| GET /api/updates/jobs | `{jobs:[record,...]}`; same bounded stored records as inventory/SSE; runtime jobs only with `?runtime=1` |
| Existing messages SSE, type=updates | `at`, `topics:["updates"]`, `botIds:[]`, `roomIds:[]`, `all:false`, plus `jobs:[record,...]` (runtime jobs always removed: SSE has no opt-in and released apps share it) on success or `error:{code,message,path?,reason?}` on read failure; no fabricated state on error. Published only when the jobs/error body differs from the previously published one (fingerprint in http-events); never `all:true`, so clients refresh only the update screen. The parent ledger notifies on saved state change and on operation completion only; read-side refreshes (inventory snapshot host/install readback) never notify (2026-11-07 flood fix) |
| Unreadable record | HTTP503 `{error:"UNREADABLE",message:reason,path,reason}`; missing job retains runtime404 |

The job and problem projection remains Owner-only: existing internal update HTTP403 is retained, and the internal SSE server does not attach the Owner update watcher. Other internal SSE topics keep their existing behavior.

A record is the runtime's complete `bellteam.update-job.v1` record. `jobId/state/reason`, target and nanosecond decimal strings are forwarded unchanged. Six states only: queued/downloading/verifying/swapping/ready/failed. The common operation has no aggregate job state. Existing legacy parent phase/execution fields remain historical compatibility fields; screens use stored jobs and reader errors.

The caller idempotency key defaults to parent requestId. Same retained key + same plan reuses the parent operation and all step receipts; a different plan/key binding conflicts. Per-step backend keys are SHA256(JSON.stringify([parentKey,componentId])), ensuring the exact same bounded key is reused after a partial admission failure. Each step uses its persisted backend request UUID as jobId. Container uses the parent requestId; an installer-backed module reuses that same per-step UUID for startModuleInstall. No new aggregate ID exists. Partial admission produces no202; persisted successful receipts are retained and reused when the same parent key is retried. A partially admitted parent operation has `admission:"pending"` in GET/inventory until all receipts are saved. This is acceptance metadata, not a seventh job state; each admitted job still exposes only its stored six-state value.

A runtime step (single-target plan only) is admitted with `kind:"runtime"` and started through startModuleInstall; the worker completes it and the parent only projects the stored ready/failed record onto the operation, like a Host-completed container step. Installed/builtin steps call admitJob without an installer launch, then downloading/verifying around existing prepare, swapping before replace, and ready only after the runtime replace Promise includes a real candidate public probe. Failures persist a fixed failed reason. If an earlier module aborts, the parent reports failed for an admitted queued/unclaimed container step through the container client; runtime rejects this after an operation/claim exists. No container worker or activation is issued to close that record. Installer-backed steps use their preadmitted jobId/key with the signed installer plan. Historical operations are not replayed or rewritten. Parent restart reconciliation records concrete parent interruption for admitted parent-owned module jobs; it never guesses successful completion.

## Close-only function and data-flow delta

This accepted B delta changes the common executor contract for `close_without_activation`; the public DTOs, v1 persisted envelopes and existing routes remain unchanged. Runtime A ships in the same source diff; [its canonical function/DFD](../runtime/module-installer.md#current-bound-successor-of-an-immutable-termination-record) owns the original worker, storage, predecessor/successor validation and durable fence. An explicit authorized inspect alone can publish the immutable current-bound successor; finalize/read only consume an existing one. A and B require a matched formal source/image S for subsequent adoption; source completion deploys neither body nor companion, whose production baseline remains ecfc until a separate operational decision.

| Function / connection | Scoped contract and state transition |
| --- | --- |
| Close entry and local owner | The executor acquires its local ledger/exchange owner only with no active original work. Before a new claim it checks the exact original and plan, install unknown and apply not issued, other-step/host guards, claim identity, fresh Owner authorization, current and catalog bindings. Busy or invalid state refuses without changing normal Bot reception. No application-global mutex, native drain or conversation/writer drain is added. |
| All mutating read reconciliation | `publicJobs`, terminal-report flush and interrupted-job read reconciliation acquire the same local owner before their first await and hold it through every shared-ledger save. Already-owned callers use a private owned path; read-only projections need no extra writer. A close facing a prior owner refuses busy; operation finish releases ownership. Closed or ledger-faulted executors keep saved read-only projection available and perform no reconciliation writes. |
| New close claim | The local owner saves one existing-v1 decision/claim, invokes the runtime boundary, validates its matching fence and saves common completion. Assertions and fresh bindings remain checked around awaits. Uncertain outcomes preserve the same claim and original unknown; timeout is not cancellation or proof that work was unissued. |
| Retained close intent | Matching retained intent, including partial admission, is a no-admit/no-work/no-read-reconciliation barrier for the original. A later explicit authorized request takes the same owner and only reads the same claim's fence; it never creates a new claim or calls finalize again. Matching fence plus durable common completion converges the claim; otherwise the original remains unknown and intent retained. |
| Guard exit and ownership | Active work or a mutating reader exits by actual operation finish and owner release; a competing request receives busy and can make a new explicit request. A retained uncertain claim exits through matching-claim fence convergence and saved completion. No periodic retry, old-worker replay or inferred success is introduced. |

```mermaid
flowchart LR
  Request[Explicit authorized same-ID close] --> Owner[Executor-local ledger / exchange owner; no active original work]
  MutatingRead[publicJobs / flush / interrupted-read ledger mutation] -->|same owner or busy refusal| Owner
  Owner -->|new exact claim; fresh auth / current / catalog| Claim[Durable common claim]
  Claim --> Runtime[Runtime-owned worker / storage / predecessor-successor checks and fence]
  Runtime -->|matching fence| Complete[Durable common completion]
  Retained[Retained exact claim] -->|new explicit request under same owner| ReadFence[Read matching fence only]
  ReadFence --> Complete
  Owner -->|actual operation finishes| Released[Local owner released]
  Normal[Unrelated Bot reception] --> Existing[Existing normal reception and lifecycle]
```

## Functions and data flow

| Function | Input | Output and owner |
| --- | --- | --- |
| Common start | Validated plan, requestId, optional caller key | Existing parent binding saved -> runtime admitJob for each step -> saved receipts ->202 |
| Common read | Operation bindings or bounded recent lookup | Runtime body-client job/jobs -> closed schema -> unchanged record |
| Activation | Admitted module job + existing adapter | Persist swapping -> replace/probe completion -> ready or failed |
| SSE | Existing update notification | Stored recent jobs or explicit reader error; coalesce concurrent reads and retain a final pending invalidation. After active module work clears and releases its exchange reservation, an internal operationCompleted notification invalidates once even when jobs/error are unchanged, so clients re-read idle capability/notice. Ordinary identical bodies remain suppressed; scope = topic updates only (all:false) |
| Terminal report reconciliation | Saved ready/failed report intent in existing parent ledger | Retry only idempotent updateJob ACK; never replay controller/business work |
| Restart visibility | Runtime active/clear DTO | Existing reporter -> Signal writer -> closed problems projection -> existing update screen |

```mermaid
flowchart LR
  HTTP[Authenticated existing update HTTP] --> Center[Common update center]
  Center --> Executor[Existing parent step ledger]
  Executor --> Admit[Runtime admitJob per step]
  Admit --> Receipt[All durable receipts saved before202]
  Executor --> Reports[Saved terminal report intents / ACK reconciliation]
  Reports --> Report
  Executor --> Adapter[Existing controller replace]
  Adapter --> Probe[Runtime actual candidate read]
  Probe --> Report[Runtime updateJob ready or failed]
  Center --> Reader[Runtime job and jobs client reads]
  Reader --> Projection[Closed unchanged record projection]
  Projection --> HTTP
  Projection --> SSE[Existing update messages SSE]
  Executor -->|active work settles; active cleared and reservation released| Completion[Internal operationCompleted notification]
  Completion -->|application-services forwards to updateCenter.watch; preserve through pending read| SSE
```

```mermaid
flowchart LR
  Caller[Caller plan/request/key] --> Common[Common validation and bindings]
  Common -->|Persisted UUID/key/target| Admit[Runtime admission]
  Admit -->|Atomic fsync record| Disk[(Updater state jobs)]
  Disk -->|Stored receipt or explicit read error| Reader[Runtime body client]
  Reader -->|Exact record| Common
  Common -->|All step receipts before202| Caller
  Common -->|swapping then actual probe result| Runtime[Runtime updateJob]
  Runtime -->|Durable transition| Disk
  Reader -->|Exact recent records or reader error| View[HTTP / existing SSE consumers]
  Detector[Runtime actual restart/clear DTO] --> Reporter[Existing parent reporter]
  Reporter --> Writer[Signal recordModuleRestartLimit]
  Writer --> Diagnostics[(Existing diagnostics state)]
  Diagnostics --> Problems[Signal closed problem/resolved projection]
  Problems --> View
```

`GET /api/updates` also includes `problems[]` from Signal's `moduleRestartLimitProblems(await diagnostics.list('all',1000))`. Each row has exactly fingerprint/status/kind/moduleId/count/windowSeconds/lastExit{code,signal}/lastReason. Status is open or resolved; resolved retains the last active evidence. The reporter's acknowledged write invalidates existing update SSE so Web refetches the inventory. Usage/conversation candidate probes capture the documented trusted actor and matching current generation lease, call the candidate channel directly, track actual completion, and release authority only at that completion. The separate BugHub-key /api/admin/logs server and raw diagnostic_log/investigation are not exposed to Web. No new diagnostics writer, timer, restart policy, privilege policy, rollback, replay or production operation is added.

## Completion invalidation contact

`createModuleUpdateExecutor.start` owns the actual active Promise; its existing finally clears active and releases the exchange reservation before notifying `{operationCompleted:true}`. `application-services` and `updateCenter.notify/watch` forward this internal hint unchanged. The updates-only branch of `createMessageEvents` consumes it without adding a public SSE field: bypass identical jobs/error suppression for the completed invalidation, including when a jobs read is already in flight. Ordinary notify/read traffic remains deduplicated and never performs an inventory read in the event publisher. Web and Apple keep the existing updates event -> GET inventory flow. Failure completion invalidates too, without implying successful update or changing persisted job/operation semantics.

No new guard, lock, timeout, retry, queue, or public field is introduced. The existing one-read/pending coalescing is retained; the extra boolean retains completion until the next existing read. Source membership stays integration/application-services, update-center and update-module-executor; conversation/module.json continues to list http-events, whose common updates bridge alone changes. HTTP SSE and common executor run in the body, so a signed conversation/Web asset alone does not activate this repair.

N102 confirmed this existing updates-only contact scope; conversation retains the file ownership. The four changed body files are absent from the members/conversation/execution `*_FILES` archive inventories in `scripts/web_gateway_artifact.py`; those already-dispatched signed assets are unaffected by this source change. `http-server` imports `http-events` in the body. Keep the fixed signer source rather than republishing those assets for this repair.
