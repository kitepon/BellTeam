# Lattice工程表 (lattice)

Owner: Flora (bot-7e777fe5). Assigned by the Owner through Trony on 2026-11-11; public contract ruled by Trony on 2026-11-11.

This module brings [Lattice](https://github.com/kitepon/Lattice) (Snow White's product: Plan Alice, Store Ludmila, Runtime Tove) into BellTeam. Lattice internals and every change to Lattice itself belong to Snow White (bot-fc291ae4); this module only runs a released Lattice CLI. The module owns:

- **the charts**: one Lattice store per project (Owner 2026-11-11: one chart per project, no edit permissions, no membership, anyone can open; members follow the coordinator's chart and may make their own);
- **the seat tool** `lattice`: every seat on every harness and OS (container and Owner-terminal seats) reads and writes charts through the bellteam MCP, with no install, PATH or env on the seat;
- **the app read surface**: chart list, chart snapshot and SSE, already projected into who waits for what and who is producing it. Each app draws it natively from the [screen spec](screen-spec.md): Apple first (Rapi), Web (Flora, [web/lattice-chart.md](../web/lattice-chart.md)), Windows (Anis).

Connections are in [module.json](module.json). The overall [function map](../../feature-map.md), [data flow](../../data-flow.md) and [ownership](../../module-ownership.md) trace callers and providers.

Startable notices (a18, Lattice 0.90.0): the module delivers them to lane Bots (L10-L12). Skipped on purpose (v1): Lattice's Sensor, independence and runtime (Tove) inside BellTeam; task notes (a separate Lattice chain, not in the display read); edits from the apps (seats edit through Lattice); migrating the coordinator's Markdown process table (needs a ruling).

## Process placement

Same shape as [work-graph](../work-graph/README.md): the module runs as its **own module child**, so every change ships as a module-only exchange without stopping the body. The Lattice package (`@quolu/lattice`, pinned in the module payload lock) is bundled in the signed module, so a Lattice version bump is a module-only exchange too.

| Part | Owner |
| --- | --- |
| `src/lattice-protocol.mjs`, `src/lattice-ipc.mjs` (both ends), `src/lattice-dispatcher.mjs`, `src/lattice-entry.mjs`, `src/lattice/{core,cli,projection}.mjs` (child) | Flora |
| `src/lattice/http-api.mjs` (thin body HTTP/SSE handler), `src/lattice/mcp.mjs` (tool schema + handler) | Flora |
| Lattice facade (subscribers, refresh timer, one call chain), effect handler `members.list`, module process/start binary/locks, HTTP mount and auth, MCP registration in `mcp-tools.mjs`, packaging/catalog/updater, `publish-lattice.yml` | Molly |
| Lattice CLI behaviour, schemas, store format | Snow White |

## Function map

```mermaid
flowchart LR
  Seats["every seat (container + Owner terminals, all harnesses)"]
  Apps["Apple (Rapi) / Web (Flora) / Windows (Anis)"]
  subgraph Body[body process, stable]
    MCP["bellteam MCP: tool lattice<br/>src/lattice/mcp.mjs (Flora)<br/>registered by Molly"]
    API["src/lattice/http-api.mjs (Flora)<br/>GET /api/lattice/charts<br/>GET /api/lattice/charts/:id<br/>GET /api/lattice/charts/:id/events"]
    Facade["lattice facade (Molly)<br/>SSE subscribers per chart,<br/>refresh timer, one call chain"]
    Effects["effect handlers (Molly):<br/>members.list, messages.send"]
    Msg["messenger.sendmessage<br/>(public send path; wakes the seat)"]
    PChan["createLatticeParentChannel (Flora)"]
  end
  subgraph Child[lattice child, module-only exchange]
    CChan["createLatticeChildChannel (Flora)"]
    Disp["lattice-dispatcher (Flora)<br/>charts / chart / refresh / run"]
    Core["core.mjs: per-chart memo, epoch, version,<br/>source token, 30 s ceiling"]
    Cli["cli.mjs: spawn node on bundled lattice bin,<br/>seat-surface allowlist, bounded output"]
    Proj["projection.mjs: cards, edges, waits, producers"]
    Notices["notices.mjs: startable notices<br/>-> lane Bots, ack, re-list"]
    Code["code-chart.mjs: code charts (bellteam) =<br/>depth-1 checkout of the product repo; before a seat run:<br/>fetch, move main forward, sensor init/sync"]
  end
  Store["/srv/bellteam/state/lattice/&lt;project&gt;/.lattice/<br/>(one git repo per chart, Lattice format)"]
  Repo["GitHub kitepon/BellTeam main<br/>(public, https, no credentials)"]
  Reg["members.registry"]
  Seats -->|tools/call lattice| MCP --> Facade
  Apps -->|JSON / SSE| API --> Facade
  Facade -->|root calls| PChan <-->|IPC| CChan --> Disp --> Core
  Core --> Cli -->|lattice CLI, cwd = chart| Store
  Core --> Proj
  Core -->|before a seat run on a code chart| Code -->|git fetch --depth=1 / checkout -B| Repo
  Code -->|lattice sensor init/sync . (module operation, not seat surface)| Store
  CChan -->|effect inside a root call| PChan --> Effects --> Reg
  Effects -->|messages.send| Msg
  Facade -->|"deliver once per child generation (onGeneration)"| PChan
  Core -->|after a release write / on deliver| Notices -->|"todo notice list|ack"| Cli
```

## Data flow

| ID | From -> to | Data | Notes |
| --- | --- | --- | --- |
| L1 | seat -> body MCP | `lattice {project, name?, args, input?}` | `from` = caller Bot id from the seat credential (Kiro: container, account and Owner-terminal seats alike; a fork seat resolves to its parent Bot). Open to forks: charts are outside `/srv/bellteam/bots/*` |
| L2 | MCP handler -> facade -> child | root `run {from, projectId, args, input, name?}` (the facade passes `name` only when given) -> `{exitCode, result, stdout, stderr}` | After a run, the facade refreshes that chart at once |
| L3 | child -> Lattice CLI | `process.execPath <bundled>/@quolu/lattice/bin/lattice.mjs <args>` with cwd = chart dir, env `{PATH, HOME=/srv/bellteam/state/lattice-home, LATTICE_SEAT_ID=from, LATTICE_DASHBOARD_AUTOSTART=0}` | The chart dir is created on the first run (`mkdir`, `git init -q`). Lattice's own lock protects the store; the child also runs root calls one at a time |
| L4 | child -> Lattice CLI (read) | `lattice todo display source --json` (cheap token) and `lattice todo display read --json` -> `lattice.todo_display_read_result.v1` `{state, store, verified_at, source, inconsistency, dropped_members}` | Minimum Lattice version = `@quolu/lattice` 0.85.5 (first release with these two reads). With no store yet, `source` fails (STORE_INCONSISTENT) and `read` returns `state: "unavailable"`; a failed source counts as a probe failure, so a full read follows. Full read on token change, first observation, probe failure, after a run, or 30 s after the last full read |
| L5 | child -> parent effect | `members.list {}` -> `{members:[{id,name,color,avatarVersion,deleting}]}` | Same effect and validator as work-graph. A failed read keeps the last roster (`degraded:['members']`) |
| L6 | apps -> body API -> facade -> child | `charts {}`, `chart {projectId}`; SSE: `refresh {projectIds}` every `nextRefreshMs` while subscribers exist | Snapshot pushed whole on each change |
| L7 | child -> chart dir | `.bellteam-chart.json` `{name?, createdBy?}` merged and written atomically (temp + rename): `createdBy = from` by the `run` that first makes the store (no `.lattice` before, one after), or by a `run` with `name` on a chart that has no recorded creator (claiming an older chart, e.g. Trony renames 「BellTeam開発」 once); `name` by `run` with `name`. Read with every full read; never overwritten once set | Lattice has no project name or creator, so the module keeps both beside the store. A missing or malformed file or field is absent |

| L8 | child -> GitHub -> code chart dir | `git config --unset-all` of `remote.origin.promisor`, `remote.origin.partialclonefilter`, `extensions.partialclone`; `git fetch --depth=1 --no-tags --refmap= origin main` (FETCH_HEAD only); then `git checkout -B main FETCH_HEAD` only when HEAD is unborn or equals the accepted baseline `refs/remotes/origin/main` (else `diverged`); after a move (or HEAD already at the tip) `git update-ref refs/remotes/origin/main FETCH_HEAD`. The baseline advances only on success, so a `diverged` run never moves it | Never a blob-less (promisor) clone: Lattice runs `git rev-list --objects --all` on every store read, and in a promisor repo git fetches each missing history blob one by one (production 2026-11-12: `todo display read` never answered). Depth 1 grafts the tip, so every reachable object is local and the walk is one tree (~6,000 objects, ~0.1 s). Only for code charts (`CODE_CHARTS` in `code-chart.mjs`: `bellteam` -> `https://github.com/kitepon/BellTeam.git` `main`; Trony assignment 2026-11-12). Runs inside the seat `run` on that chart, before the Lattice command, when the last attempt is 120 s or more ago (so a gate adoption is in the checkout at the next use; no timer of its own, no write in flight: runs on one chart are serialized by the per-chart lock) |
| L9 | child -> Lattice CLI (module operation) | `lattice sensor sync . --json`; on Lattice's typed `LATTICE_SENSOR_NOT_INITIALIZED` (cli_error JSON on stderr; never initialized, or an interrupted init left `.lattice/sensor` without a usable index) `lattice sensor init . --json`; cwd = code chart | After a fast-forward or conversion, and whenever this child has no successful sensor run recorded for the current HEAD (in-memory `indexed` id -> HEAD; a child restart re-syncs once, ~1-2 s). A directory's presence is never taken as readiness. `sensor` stays off the seat surface (named protection above); the module runs it itself. Index under `.lattice/sensor/**` (~120 MB for BellTeam) |
| L10 | child (inside root `run`) -> parent effect -> messenger | When a seat's write returns Lattice's `notices` (0.90.0: `done`, `retire`, `unblock`, `phase accept`, `phase close-unaudited`, `dependency disconnect`), for each notice whose `lane` equals a roster Bot id (not deleting): effect `messages.send {from, target: lane, message}` (from = the seat Bot that wrote; <= 4000 chars). Owner ruling 2026-11-12: a notice is information, never an order: the text says the task can start now (prerequisite done), that whether and when to start is the lane's call, the done condition, and Lattice's `next_action` only "for reference, if you start it". Idle-waiting lanes (always wake) wait for Alice's `waiting` mark on notices -> `{delivery, deliveryId, code?}` from `messenger.sendmessage`, the same path as the `sendmessage` tool (Trony ruling 2026-11-12; waking a sleeping seat is the messenger's). A notice whose lane is the writing Bot is not sent (it is in that Bot's own result). Other lanes (`owner`, `main`, names) are never sent and stay unacked in Lattice. A seat's own `todo notice list|ack` is not a release write and is passed through untouched | Delivery never changes the seat's result. At most 50 sends per root call (`NOTICE_SLICE`) |
| L11 | child -> Lattice CLI | `todo notice ack --lane <bot> --notice <id>,...` per lane after the sends: acked on any accepted or unknown delivery and on `refused` (permanent: `SENDER_NOT_FOUND`, `BOT_NOT_FOUND`, `MESSAGE_REQUIRED`; a deleted Bot would otherwise be retried forever); never on `failed`/`stopped` or a thrown effect (old body without `messages.send`: `LATTICE_INVALID`, timeout). Acks live in Lattice's host-local `.lattice/todo/notices/` | Lattice keeps the unacked list; the child keeps only an in-memory set of charts to re-list |
| L12 | parent onGeneration -> facade.deliver() -> child root `deliver {}` | Once per child generation (start, restart, exchange); the root call is held until the child is ready. The child lists `todo notice list --json` (all lanes, unacked) per chart under that chart's run lock and sends as L10/L11, `from` = the trigger's actor when it is a roster Bot, else `scheduler`. Result `{delivered, failed}`. The same re-list runs inside the next `run` on a chart whose earlier sends failed, whose ack failed, whose result had `notices: null`, or that had no roster yet | An old child refuses `deliver` (`LATTICE_INVALID`); the facade swallows it. Recovery covers missed deliveries and CLI writes made outside the seat tool |

### Code charts (Trony assignment 2026-11-12; Owner: Lattice is not a plain table)

A code chart's dir is a checkout of its product repo so that Lattice's conflict check (`todo independence witness scaffold|declare|compile`) and code graph (`todo structure input|compile|realize`) see the real source with a clean worktree:

- `.git/info/exclude` lists `.lattice/`, `.bellteam-chart.json` and `.bellteam-chart.json.*.tmp`, so the store, the sensor index and the sidecar are never tracked and the worktree stays clean.
- **Conversion of an existing chart** (the `bellteam` chart made before this): the first maintenance adds the exclude lines, `origin`, fetches, and checks out `main` into the unborn branch. `.lattice/` and the sidecar are untracked and excluded, so they are not touched; a tracked path that collides with an untracked file makes git refuse, and the chart is left as it was.
- **Clean worktree first**: before fetching, `git status --porcelain --untracked-files=no` must be empty. Tracked modifications (staged or not) mean someone is editing the checkout: the module returns `dirty` (one log line), does not fetch, fast-forward or index, and preserves every local change; the seat command still runs. The next due run checks again, so once the edits are committed or removed elsewhere it catches up. (Untracked files never block; a fast-forward that would overwrite one is refused by git.)
- **Index readiness**: `current` (no work) only when HEAD equals the fetched `main`, the worktree is clean, and this child's last successful sensor run indexed this HEAD. A failed sensor run records nothing, so the next due run retries sync -> init.
- **Depth-1, no promisor**: the checkout holds only the tip (grafted). A chart left as a blob-less clone by the first release is turned into this on its next maintenance: the promisor settings are removed before the fetch (from then on a missing object is an error Lattice reads as "cannot count", never a network fetch), and the depth-1 fetch grafts the tip even when it is already local. Old history objects stay in the pack until a later gc.
- **Named protection** (overwriting existing state, wrong target): the module only fetches and moves `main` from the accepted baseline (`refs/remotes/origin/main`, the tip `main` was last moved to; a `diverged` run leaves it as it was) to the new tip (a grafted tip has no parent, so `merge --ff-only` cannot be used); a `main` with local commits is `diverged` and left alone. It never resets, cleans, forces or rebases; an `origin` that points elsewhere is not changed. **Self-exit**: a refused move (diverged, dirty, network down, timeout 60 s per git step, 120 s for sensor) logs one line with the code, the seat command still runs on the checkout as it is, and the next run 120 s later tries again; once the cause is repaired it catches up by itself (diverged: once `main` is back at the accepted baseline, the next due run moves it to the newest tip, however far upstream moved meanwhile).
- Size: tip only (~25 MB git objects, older pack objects of the first release until gc) + ~25 MB worktree + ~120 MB sensor index under `/srv/bellteam/state/lattice/bellteam/`, inside the nightly backup (Molly/Trony informed).

## Seat tool `lattice` (public contract for seats)

Input schema: `{ project: string, name?: string, args: string[], input?: object }`.

- `project`: chart id, `^[a-z0-9][a-z0-9-]{0,62}$`. Lattice's `project_id` is this directory name. A new id creates a new chart on its first write (Owner ruling 7: anyone may make a chart).
- `name`: the chart's display name for every screen, 1-40 characters, no control characters or surrounding spaces (`LATTICE_NAME_INVALID` otherwise). Give it when making a chart; `args: []` with `name` only renames an existing chart (no Lattice command runs; result `{exitCode:0, result:{name}, stdout:null, stderr:''}`; a project with no chart yet is the tool error `LATTICE_CHART_NOT_FOUND` and nothing is written). To name a new chart, pass `name` with its `plan create`. Screens never show `project`.
- `args`: Lattice CLI arguments after `lattice`, e.g. `["session-context"]`, `["plan","create","--template","--json"]` (prints the `plan create` input template; Lattice refuses `--template` without `--json`), `["todo","start","--plan","p1","--task","t01"]`, `["todo","note","--plan","p1","--task","t01","--message","..."]`, `["todo","dependency","connect","--from-plan",...]`, and (Lattice 0.86.0+, pinned 0.86.1 on 2026-11-12 for Trony's one-task request) `["todo","add","--plan","p1","--task","t23","--title","...","--phase","ph1","--lane","<Bot id>","--after","t10","--design-memo","..."]` to add one task without resending the plan, `["todo","retire","--plan","p1","--task","t23","--reason","..."]` to retire one, and (Lattice 0.87.0, pinned 2026-11-12, Snow White PR #137) `["todo","independence","witness","declare","--plan","p1","--task","t23","--owns","src/a.mjs,src/b.mjs","--reads","docs/x.md"]` to declare only your own task's files for the conflict check (others' rows kept; once every ready task is declared Lattice compiles by itself, otherwise it answers `waiting_for` with the undeclared tasks). The first argument must be one of `plan`, `todo`, `status`, `session-context`, `help`, `--help`, `--version`.
- Design memo (Lattice 0.88.0, Owner ruling 2026-11-12): every task needs a non-blank `design_memo` (`plan create` / `plan revise` input, `todo add --design-memo`); Lattice refuses a missing or blank one with `DESIGN_MEMO_REQUIRED` and never writes `NO_PLAN` itself. `plan create --template` prints blank memos, so a verbatim copy is refused. The module, seat tool, Web and apps never fill or default `design_memo`: `input` and `args` reach Lattice unchanged.
- Enforced plans (Lattice 0.88.0, ADR 0200 in Lattice): `["todo","independence","mode","--plan","p1","--set","enforced","--reason","..."]` passes through like any `todo` command. A Lattice older than 0.88.0 reports the whole store `STORE_CORRUPT` while any plan in it is enforced, and the builtin child (body image) is the fallback reader of the same store, so a plan is set enforced only after both the module asset and the body image carry >= 0.88.0.
- Declare without git (Lattice 0.90.0, pinned 2026-11-12 for Trony's a13): chart dirs are `git init` with no commit, so before 0.90.0 `todo independence witness declare` failed `INDEPENDENCE_OBSERVATION_GIT_FAILED` (resolve_head) and no task of an `enforced` plan could start. Now the row is recorded with `observation: "unavailable"` (not observed, not compiled); the declared task's `todo start` advisory reads `coverage: "declared_unobserved"` (never "safe"), and an undeclared task is still refused `enforced_witness_undeclared`. The code chart (project `bellteam`, a real checkout) is unaffected. The builtin child (body image) is only the fallback reader; while it is older than 0.90.0 a fallback run refuses declare on these charts again, but reads the store unchanged (no store format change).
- Startable notices (Lattice 0.90.0, Alice #147): `done`/`retire`/`unblock`/`phase accept`/`phase close-unaudited`/`dependency disconnect` results carry `notices`; `["todo","notice","list","--lane","<lane>"]` and `["todo","notice","ack","--lane","<lane>","--notice","<id>"]` pass through like any `todo` command. The module itself delivers each notice to its lane's Bot as a direct message (data flow L10-L12); a seat need not list them.
- Newer-writer refusal (Lattice 0.89.0): a reader that meets a value a newer Lattice wrote refuses with `UNSUPPORTED_SCHEMA` / `newer_lattice_value` (not corrupt; upgrade, never repair or delete) instead of `STORE_CORRUPT`; real damage stays `STORE_CORRUPT`. The module passes the code through unchanged. On enforced plans the `todo done` hints carry `--message "<PR URL or merged commit sha>"`.
  Named protection: the child runs as the server uid, so Lattice's host commands (`setup`, `hooks`, `bridge`, `dashboard`, `run`, `sensor`) would write host configuration or launch processes as the server (privilege escalation, overwriting host state). Self-exit: the refusal `LATTICE_COMMAND_NOT_SEAT_SURFACE` returns the allowed list; the seat calls again with a seat command.
- `input`: a JSON object for commands that take a JSON file (`plan create`, `plan revise`, `plan backchain`, `todo independence witness scaffold --input`, `todo structure input|compile --input`, `todo structure realize --input`, and `todo structure realize --realized <file>`). A task's `lane` is its assigned owner: write the member's Bot id there (or `owner`) to show a face (see Owner on screen); Lattice accepts only ASCII identifiers (`[0-9A-Za-z][0-9A-Za-z._-]*`) and refuses a Japanese name with `identifier_invalid`. The child writes it to a private temp file (outside the chart, so the worktree stays clean). If `args` contains the token `@input` (e.g. `["todo","structure","realize","--plan","p","--task","t1","--realized","@input"]`), that token becomes the file path; otherwise `--input <file>` is appended. `args` must then not contain `--input`, and `@input` without `input` is refused (`LATTICE_INPUT_CONFLICT`).
- Result: `{ exitCode, result, stdout, stderr }`. `result` is the parsed stdout JSON (null when stdout is not JSON; then `stdout` carries up to 64 KiB of text). `stderr` carries the last 64 KiB. A Lattice refusal is a normal result with its own `code` / `detail.next_action` inside `result`, never a tool error: refusals Lattice prints on stdout are parsed from there, and its CLI errors (`lattice.cli_error.v2`, e.g. `DESIGN_MEMO_REQUIRED` with `detail.pointer` / `detail.prompt` / `detail.next_action`) are printed on stderr with an empty stdout, so `result` is the parsed stderr then.
- A run whose own `mkdir` created the chart dir (a plain, non-recursive mkdir, so an existing path is never claimed) and that leaves it without a Lattice store (`help`, `--version`, a refused first command) removes that dir again, so no empty, unlisted dirs pile up (Molly 2026-11-12). A dir that existed before the run, with or without `.lattice`, is never removed (Epinel gate 2026-11-12); the older `flora-scratch-check` stays for offline maintenance.
- Named protection (storage boundary, Epinel gate 2026-11-12): a chart dir or sidecar that is a symlink would let the server uid write or run outside the charts root. Every run, read and sidecar write checks with `lstat` that the chart dir is a real directory; a linked chart dir fails `LATTICE_UNAVAILABLE` (detail `ELINK`) before any write, spawn or delete, and a linked sidecar reads as absent and is replaced by rename (never written through; the temp file is created with `wx`, and a save that fails after creating it removes that temp, never one it did not create, so the next save works once the fault is repaired). Self-exit: once the link is replaced by a real directory, the next call works.
- The CLI run is bounded at 60 s (named protection: a hung CLI would hold the one call chain and stop every chart; self-exit: the process is killed, the result says `LATTICE_CLI_TIMEOUT`, the next call runs).
- Tool errors (not Lattice results): `LATTICE_PROJECT_INVALID`, `LATTICE_NAME_INVALID`, `LATTICE_INPUT_CONFLICT`, `LATTICE_COMMAND_NOT_SEAT_SURFACE`, `LATTICE_UNAVAILABLE` (child not serving).

## Public contract (apps)

Common Owner-authenticated `/api`; internal callers 403; no permission checks of its own (Owner rulings 4-5).

### `GET /api/lattice/charts`

```json
{ "schema": "bellteam.lattice-charts.v1", "at": "…",
  "charts": [{ "projectId": "bellteam", "name": "BellTeam開発", "coordinator": true, "createdBy": "bot-7b140b27",
               "counts": { "total": 31, "done": 18, "working": 4, "waiting": 3, "blocked": 1 },
               "activeMembers": ["bot-39be7047"], "updatedAt": "…", "state": "verified" }] }
```

Order: coordinator charts first (`coordinator` = `createdBy` is the coordinator Bot; module default `bot-7b140b27`, Trony ruling 2026-11-11), then newest `updatedAt`. `createdBy` = the chart's recorded creator (sidecar `createdBy`, below); for a chart made before the record existed and not yet claimed, `actor.agent` of the earliest journal event in the read. It never follows a later plan: Lattice's read holds only each plan's active version, so after the coordinator revised a plan, another member's newer plan had the earliest event and took the chart (Trony finding 2026-11-12: 「BellTeam開発」 lost 統括 when Flora added a plan). `updatedAt` = the latest event time. `name` = the seat-given display name or null.

**Display name rule (all apps, list cards, chart switcher and spoken labels):** `name`; if null, 「<createdBy's member name>の工程表」 using the app's own roster name for that Bot; if that is unknown too, 名前のない工程表. `projectId` is an address for API paths only and is never put on screen or in a spoken label (Trony screen ruling: no raw ids).

### `GET /api/lattice/charts/:projectId`

```json
{ "schema": "bellteam.lattice-chart.v1", "epoch": "…", "version": 7, "at": "…",
  "projectId": "bellteam", "name": "BellTeam開発", "createdBy": "bot-7b140b27", "coordinator": true, "state": "verified", "verifiedAt": "…", "degraded": [],
  "members": [{ "botId": "bot-39be7047", "name": "モリー", "color": "mint", "avatarVersion": "…" }],
  "cards": [{ "id": "p1/t03", "plan": "p1", "taskId": "t03", "title": "部品の配置と保存場所",
              "doneCondition": "…", "designMemo": "…", "state": "in-progress", "lane": "molly",
              "producer": "bot-39be7047", "startedAt": "…", "changedAt": "…", "blockedReason": null, "depth": 1,
              "phase": "p1/ph2", "parent": null, "doneAt": null, "archived": false }],
  "phases": [{ "id": "p1/ph2", "title": "部品" }],
  "edges": [{ "from": "p1/t03", "to": "p1/t05", "waiting": true }],
  "waits": [{ "waiter": "bot-7e777fe5", "waitingCard": "p1/t05", "forCard": "p1/t03",
              "producer": "bot-39be7047", "producerState": "in-progress", "since": "…" }] }
```

- `state`: Lattice's display state as is: `verified | unverified | last_verified | unavailable`. `verifiedAt` from Lattice. No codes, reasons, paths or raw ids are sent for display (Trony ruling 2026-11-11: plain sentences only; codes go to the child's diagnostic log).
- `degraded`: `lattice-read` (the last read failed; the previous snapshot is kept), `members` (last roster kept).
- card `doneAt` / `archived` (added 2026-11-12, Owner request: finished work leaves the chart, a 過去ログ keeps it): when the card finished (null while open) and whether the screens hide it from the chart (shown only in 過去ログ). Optional on the wire like `phases`; missing = null / false.
- `phases`, card `phase` / `parent` (added 2026-11-12 for the process tree, Owner request): the plan's phases in plan order (`title` may be null; apps then show 名前のないまとまり), the card's phase id or null, and its parent card id or null. Optional on the wire: a child that predates them sends none, and apps treat missing as `[]` / null.
- `producer` / `waiter` may be the reserved value `"owner"`: the Owner (指揮官). It is never in `members`; apps draw it from the Owner profile they already read (`GET /api/owner` name, `GET /api/owner/avatar`), fallback name 指揮官, no chat button, not in the member rail.
- `members`: only members referenced by `producer`/`waiter`. A Bot id not in the roster is omitted here; apps draw it as 名簿にないメンバー.
- Errors: 404 `LATTICE_CHART_NOT_FOUND`, 503 `LATTICE_UNAVAILABLE`, 405 other methods.

### `GET /api/lattice/charts/:projectId/events` (SSE)

`event: snapshot` with the snapshot on connect and again whenever `version` changes; `: hb` every 15 s; a client treats 35 s of silence as a drop and reconnects; no replay; a new `epoch` means the child restarted.

## Projection rules (`projection.mjs`)

Input: one `lattice.todo_display_read_result.v1`. For `verified` / `last_verified` the store is `lattice.todo_store_read.v1` (members with `plan`, `tasks`, `journal.events`, `plan_scoped.events`); for `unverified` it is raw `{members:[{descriptor, plan, snapshot}]}` and task states come from `snapshot.tasks`. Missing or malformed fields drop only that task or edge.

- **Card** per `plan.tasks[]`: `id = plan_key/task_id`; `title` (fallback task id), `doneCondition`, `designMemo`, `lane`. `state` = Lattice status; `pending` becomes `ready` when every predecessor is `done` or `retired`.
- **Producer**: `actor.agent` of the task's latest `start` event (= the Bot id through `LATTICE_SEAT_ID`); before any start, the authored `lane` when it names a member: equal to a member Bot id, or to a member's name (Latin letters compared case-insensitively); the reserved value `owner` when the lane is `owner` or `指揮官` (the Owner, who has no Bot id; Trony 2026-11-12); otherwise null. Lattice writes its default lane `main` when the author gives none; the projection reads `main` as no lane (`lane: null`), so such a card is 担当なし, not 「main」. A finished card (`done` / `retired`) with a `lane` takes the lane's member (or null) and ignores the starter: Lattice refuses `todo done` on a pending task and a seat can only act under its own Bot id, so a coordinator closing a task that its owner already finished runs `todo start` + `todo done` under the coordinator's name; Lattice keeps that record (who ran each command), and the screen keeps showing the authored owner instead of reassigning the card (Trony question 2026-11-12). The coordinator adds a `todo note` saying who finished it.
- **Owner on screen (all apps; Trony defect 2026-11-12)**: a card's owner is its `producer` (face + name); else its authored `lane` text as written (the plan author's assignment: drawn as text with its initial, its own swimlane after the member lanes, no chat, not in the member rail); else 担当なし. 待ちの流れ and edge chips use the same rule: the waiter is the owner of the waiting card, the producer the owner of the awaited card. Authors who want a face write the member's Bot id in `lane` (the seat tool description says so; Lattice refuses non-ASCII lanes, Snow White 2026-11-12). The projection still resolves an ASCII member name. `startedAt` = that start's `recorded_at`; `changedAt` = the task's latest event time.
- **Tree** (Owner 2026-11-12): `phases` = `plan.phases[]` with a `phase_id` (`id = plan_key/phase_id`, `title`); card `phase` = its `phase_id` when that phase exists, else null; card `parent` = `plan_key/parent_task_id` when that card exists, is not the card itself and does not close a parent cycle, else null.
- **Finished and archived** (Owner 2026-11-12): `doneAt` = Lattice's `done_at` for `done` (else the card's `changedAt`), the card's `changedAt` for `retired`, null otherwise. `archived` = the card is finished and none of its next cards (kept edges `from` it) is still unstarted (`pending` / `ready`); a finished card with no next card is archived at once. Archived cards stay in `cards` (details, 前の工程 links, 過去ログ, counts) and are left out of the tree and lane drawings.
- **Edges**: `plan.hard_dependencies` (`from` -> `to`), `plan.joins` (each `after` -> `before`), and cross-plan `plan_scoped.events` of kind `cross_plan_dependency` minus `cross_plan_dependency_removed` tombstones. An edge with an unknown end, a self edge, or one closing a cycle is dropped. `waiting` = predecessor not finished and successor not finished.
- **Waits**: one per waiting edge whose successor is not `retired`: `waiter` = successor's producer, `producer` = predecessor's producer, `producerState` = predecessor's state, `since` = the later of the predecessor's and the successor's `changedAt`. Sorted oldest `since` first.
- **Depth**: longest path from a root over the kept edges.
- **Counts**: `working` = in-progress, `blocked`, `waiting` = cards with at least one waiting incoming edge, `done` = done + retired.

## Child protocol (`src/lattice-protocol.mjs`)

`LATTICE_PROTOCOL_VERSION = 1`; `LATTICE_STATE_COMPATIBILITY = {state:'none'}`: the child's own memory (memos, epoch, versions) is not carried across a swap; chart repos are Lattice's format, which Lattice versions keep compatible; the optional `.bellteam-chart.json` sidecar is backward-compatible (missing or malformed fields read as absent; older children read only `name`, and an older child's rename writes `{name}` alone, so after a rollback a renamed chart falls back to the earliest-event creator until it is named again), so it needs no state version or migration. Root methods and params:

| Method | Params | Result |
| --- | --- | --- |
| `charts` | `{}` | `bellteam.lattice-charts.v1` |
| `chart` | `{projectId}` | `bellteam.lattice-chart.v1` (or error `LATTICE_CHART_NOT_FOUND`, 404) |
| `refresh` | `{projectIds}` (1-50) | `{snapshots:[chart snapshots whose version changed], nextRefreshMs}` (2000 while any chart is asked) |
| `run` | `{from, projectId, args, input, name?}` (`input` object or null; `name` 1-40 plain characters, `args` may be `[]` only with `name`) | `{exitCode, result, stdout, stderr}` |

Snapshot validation (`validateLatticeResult`, both ends) accepts `phases` and card `phase` / `parent` / `doneAt` / `archived` as optional keys, so a body with this validator takes both older and newer children. A child that sends them needs a body with this validator: they ship together in one body train (the builtin child follows the body image), never as a module-only exchange onto an older body.

Effect: `members.list {}` only, accepted only inside a pending root call. Controls `initialize {generation, mode}`, `quiesce`, `resume`, `exit` and `validateLatticeReady` exactly as work-graph. Root calls run one at a time. Only fixed error codes cross the wire.

## State it owns

| State | Where | Writer | Reader |
| --- | --- | --- | --- |
| Chart stores | `/srv/bellteam/state/lattice/<project>/` (git repo, `.lattice/**`) | Lattice CLI inside the child, only through `run` | child (`todo display read/source`) |
| Code chart checkout and sensor index | the same dir: tracked files of the product repo (`main`), `.lattice/sensor/**` | child `code-chart.mjs` only (depth-1 fetch, move main forward, sensor init/sync) | Lattice CLI (independence, structure) |
| Chart display name and creator | `/srv/bellteam/state/lattice/<project>/.bellteam-chart.json` `{name?, createdBy?}` | child, only through `run` (creator once: the store-making run, or the first naming run of an unclaimed chart) | child, with every full read |
| Lattice HOME | `/srv/bellteam/state/lattice-home/` | Lattice CLI | Lattice CLI |
| Memo, epoch, version, last snapshot and token per chart | child memory | child | child |

`/srv/bellteam/state` is the server uid's persistent state volume (survives image swaps; Molly 2026-11-11). It is inside `/srv/bellteam`, which the nightly backup walks (Trony's runbook `bots/bot-7b140b27/docs/bellteam-backup-20261005.md`). Offline ownership maintenance re-modes it to 700/600 under the server uid; the child relies on no exec bits or git hooks.

## Failure handling

| Failure | What happens | Exit on its own |
| --- | --- | --- |
| Store inconsistent or partly unreadable | Lattice returns `unverified` / `last_verified` / `unavailable`; passed through; apps show a plain sentence and draw what they can | the next full read after repair returns `verified` |
| CLI read or chart-name read fails (spawn error, crash, bad JSON, timeout, I/O error on the name file) | keep the last good snapshot, `degraded:['lattice-read']`, one diagnostic log line with the code | next token change or the 30 s ceiling |
| Charts root not a directory, a chart dir that is a symlink (ELINK), or the root or a chart dir unreadable (any error other than a missing path: ENOTDIR on the root, EACCES, EIO, …) | `charts` and `chart` return 503 `LATTICE_UNAVAILABLE` (the code goes to the error's `detail`), never an empty list or `LATTICE_CHART_NOT_FOUND`; in `refresh` the chart stays in the round and its read reports `degraded:['lattice-read']`. A missing root or dir is the normal "no chart yet" | nothing is cached: the next call (apps retry 1, 2, 4 s; the refresh tick every 2 s) succeeds once the permission or disk is repaired |
| `members.list` fails | keep the last roster, `degraded:['members']` | next read |
| Producer not in the roster | omitted from `members`; apps draw 名簿にないメンバー | appears once the Bot exists |
| Write conflict inside Lattice | Lattice's result says so; the seat calls again | Snow White's release makes writers wait |
| Code chart fetch / fast-forward / sensor fails (network, diverged or dirty worktree, timeout, sensor not initialized or interrupted init) | one diagnostic log line with the code (`dirty`, `diverged`, `sensor-failed`, `origin-elsewhere` or the git/sensor code); the seat command runs on the checkout as it is | the next run on that chart 120 s later retries (sensor: sync, then init on `LATTICE_SENSOR_NOT_INITIALIZED`); never reset, cleaned or forced |
| Child down or exchanging | 503 `LATTICE_UNAVAILABLE`; apps keep the last drawing and reconnect; seat tool error | new child, new epoch, fresh snapshot |
| Older server without the module | 404 on `/api/lattice/*`; apps say the feature is not on this server yet | server update |

## How it updates

- Module code and the bundled Lattice version ship together as a module-only exchange (`publish-lattice.yml` attestation; Epinel adopts catalog rows; Molly exchanges). The body does not stop.
- New Lattice release: Snow White announces it -> Flora bumps the pin in the module lock -> module-only exchange. If a release ever changes the chart repo format incompatibly, `LATTICE_STATE_COMPATIBILITY` changes with it so the updater does not swap it as compatible.
- The MCP tool schema and the HTTP mount live in the body, so changing them rides a body train (Molly).
- Web page ships through the Web gateway (Admi reviews the registration lines; Molly exchanges web-gateway). Apple and Windows pages ship with their apps; Flora accepts them on real screenshots.
