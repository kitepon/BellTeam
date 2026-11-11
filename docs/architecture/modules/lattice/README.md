# Lattice工程表 (lattice)

Owner: Flora (bot-7e777fe5). Assigned by the Owner through Trony on 2026-11-11; public contract ruled by Trony on 2026-11-11.

This module brings [Lattice](https://github.com/kitepon/Lattice) (Snow White's product: Plan Alice, Store Ludmila, Runtime Tove) into BellTeam. Lattice internals and every change to Lattice itself belong to Snow White (bot-fc291ae4); this module only runs a released Lattice CLI. The module owns:

- **the charts**: one Lattice store per project (Owner 2026-11-11: one chart per project, no edit permissions, no membership, anyone can open; members follow the coordinator's chart and may make their own);
- **the seat tool** `lattice`: every seat on every harness and OS (container and Owner-terminal seats) reads and writes charts through the bellteam MCP, with no install, PATH or env on the seat;
- **the app read surface**: chart list, chart snapshot and SSE, already projected into who waits for what and who is producing it. Each app draws it natively from the [screen spec](screen-spec.md): Apple first (Rapi), Web (Flora, [web/lattice-chart.md](../web/lattice-chart.md)), Windows (Anis).

Connections are in [module.json](module.json). The overall [function map](../../feature-map.md), [data flow](../../data-flow.md) and [ownership](../../module-ownership.md) trace callers and providers.

Skipped on purpose (v1): Lattice's Sensor, independence and runtime (Tove) inside BellTeam; task notes (a separate Lattice chain, not in the display read); edits from the apps (seats edit through Lattice); migrating the coordinator's Markdown process table (needs a ruling).

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
    Effects["effect handler members.list (Molly)"]
    PChan["createLatticeParentChannel (Flora)"]
  end
  subgraph Child[lattice child, module-only exchange]
    CChan["createLatticeChildChannel (Flora)"]
    Disp["lattice-dispatcher (Flora)<br/>charts / chart / refresh / run"]
    Core["core.mjs: per-chart memo, epoch, version,<br/>source token, 30 s ceiling"]
    Cli["cli.mjs: spawn node on bundled lattice bin,<br/>seat-surface allowlist, bounded output"]
    Proj["projection.mjs: cards, edges, waits, producers"]
  end
  Store["/srv/bellteam/state/lattice/&lt;project&gt;/.lattice/<br/>(one git repo per chart, Lattice format)"]
  Reg["members.registry"]
  Seats -->|tools/call lattice| MCP --> Facade
  Apps -->|JSON / SSE| API --> Facade
  Facade -->|root calls| PChan <-->|IPC| CChan --> Disp --> Core
  Core --> Cli -->|lattice CLI, cwd = chart| Store
  Core --> Proj
  CChan -->|effect inside a root call| PChan --> Effects --> Reg
```

## Data flow

| ID | From -> to | Data | Notes |
| --- | --- | --- | --- |
| L1 | seat -> body MCP | `lattice {project, args, input?}` | `from` = caller Bot id from the seat credential (Kiro: container, account and Owner-terminal seats alike; a fork seat resolves to its parent Bot). Open to forks: charts are outside `/srv/bellteam/bots/*` |
| L2 | MCP handler -> facade -> child | root `run {from, projectId, args, input}` -> `{exitCode, result, stdout, stderr}` | After a run, the facade refreshes that chart at once |
| L3 | child -> Lattice CLI | `process.execPath <bundled>/@quolu/lattice/bin/lattice.mjs <args>` with cwd = chart dir, env `{PATH, HOME=/srv/bellteam/state/lattice-home, LATTICE_SEAT_ID=from, LATTICE_DASHBOARD_AUTOSTART=0}` | The chart dir is created on the first run (`mkdir`, `git init -q`). Lattice's own lock protects the store; the child also runs root calls one at a time |
| L4 | child -> Lattice CLI (read) | `lattice todo display source --json` (cheap token) and `lattice todo display read --json` -> `lattice.todo_display_read_result.v1` `{state, store, verified_at, source, inconsistency, dropped_members}` | Minimum Lattice version = Snow White's release with these two reads. Full read on token change, first observation, probe failure, after a run, or 30 s after the last full read |
| L5 | child -> parent effect | `members.list {}` -> `{members:[{id,name,color,avatarVersion,deleting}]}` | Same effect and validator as work-graph. A failed read keeps the last roster (`degraded:['members']`) |
| L6 | apps -> body API -> facade -> child | `charts {}`, `chart {projectId}`; SSE: `refresh {projectIds}` every `nextRefreshMs` while subscribers exist | Snapshot pushed whole on each change |

## Seat tool `lattice` (public contract for seats)

Input schema: `{ project: string, args: string[], input?: object }`.

- `project`: chart id, `^[a-z0-9][a-z0-9-]{0,62}$`. Lattice's `project_id` is this directory name. A new id creates a new chart on its first write (Owner ruling 7: anyone may make a chart).
- `args`: Lattice CLI arguments after `lattice`, e.g. `["session-context"]`, `["plan","create","--template"]`, `["todo","start","--plan","p1","--task","t01"]`, `["todo","note","--plan","p1","--task","t01","--message","..."]`, `["todo","dependency","connect","--from-plan",...]`. The first argument must be one of `plan`, `todo`, `status`, `session-context`, `help`, `--help`, `--version`.
  Named protection: the child runs as the server uid, so Lattice's host commands (`setup`, `hooks`, `bridge`, `dashboard`, `run`, `sensor`) would write host configuration or launch processes as the server (privilege escalation, overwriting host state). Self-exit: the refusal `LATTICE_COMMAND_NOT_SEAT_SURFACE` returns the allowed list; the seat calls again with a seat command.
- `input`: a JSON object for commands that take `--input <file>` (`plan create`, `plan revise`, `plan backchain`). The child writes it to a private temp file and appends `--input <file>`; `args` must then not contain `--input`.
- Result: `{ exitCode, result, stdout, stderr }`. `result` is the parsed stdout JSON (null when stdout is not JSON; then `stdout` carries up to 64 KiB of text). `stderr` carries the last 4 KiB. A Lattice refusal is a normal result with its own `code` / `detail.next_action` inside `result`, never a tool error.
- The CLI run is bounded at 60 s (named protection: a hung CLI would hold the one call chain and stop every chart; self-exit: the process is killed, the result says `LATTICE_CLI_TIMEOUT`, the next call runs).
- Tool errors (not Lattice results): `LATTICE_PROJECT_INVALID`, `LATTICE_INPUT_CONFLICT`, `LATTICE_COMMAND_NOT_SEAT_SURFACE`, `LATTICE_UNAVAILABLE` (child not serving).

## Public contract (apps)

Common Owner-authenticated `/api`; internal callers 403; no permission checks of its own (Owner rulings 4-5).

### `GET /api/lattice/charts`

```json
{ "schema": "bellteam.lattice-charts.v1", "at": "…",
  "charts": [{ "projectId": "bellteam", "coordinator": true, "createdBy": "bot-7b140b27",
               "counts": { "total": 31, "done": 18, "working": 4, "waiting": 3, "blocked": 1 },
               "activeMembers": ["bot-39be7047"], "updatedAt": "…", "state": "verified" }] }
```

Order: coordinator charts first (`coordinator` = `createdBy` is the coordinator Bot; module default `bot-7b140b27`, Trony ruling 2026-11-11), then newest `updatedAt`. `createdBy` = `actor.agent` of the earliest journal event; `updatedAt` = the latest event time.

### `GET /api/lattice/charts/:projectId`

```json
{ "schema": "bellteam.lattice-chart.v1", "epoch": "…", "version": 7, "at": "…",
  "projectId": "bellteam", "coordinator": true, "state": "verified", "verifiedAt": "…", "degraded": [],
  "members": [{ "botId": "bot-39be7047", "name": "モリー", "color": "mint", "avatarVersion": "…" }],
  "cards": [{ "id": "p1/t03", "plan": "p1", "taskId": "t03", "title": "部品の配置と保存場所",
              "doneCondition": "…", "designMemo": "…", "state": "in-progress", "lane": "molly",
              "producer": "bot-39be7047", "startedAt": "…", "changedAt": "…", "blockedReason": null, "depth": 1 }],
  "edges": [{ "from": "p1/t03", "to": "p1/t05", "waiting": true }],
  "waits": [{ "waiter": "bot-7e777fe5", "waitingCard": "p1/t05", "forCard": "p1/t03",
              "producer": "bot-39be7047", "producerState": "in-progress", "since": "…" }] }
```

- `state`: Lattice's display state as is: `verified | unverified | last_verified | unavailable`. `verifiedAt` from Lattice. No codes, reasons, paths or raw ids are sent for display (Trony ruling 2026-11-11: plain sentences only; codes go to the child's diagnostic log).
- `degraded`: `lattice-read` (the last read failed; the previous snapshot is kept), `members` (last roster kept).
- `members`: only members referenced by `producer`/`waiter`. A Bot id not in the roster is omitted here; apps draw it as 名簿にないメンバー.
- Errors: 404 `LATTICE_CHART_NOT_FOUND`, 503 `LATTICE_UNAVAILABLE`, 405 other methods.

### `GET /api/lattice/charts/:projectId/events` (SSE)

`event: snapshot` with the snapshot on connect and again whenever `version` changes; `: hb` every 15 s; a client treats 35 s of silence as a drop and reconnects; no replay; a new `epoch` means the child restarted.

## Projection rules (`projection.mjs`)

Input: one `lattice.todo_display_read_result.v1`. For `verified` / `last_verified` the store is `lattice.todo_store_read.v1` (members with `plan`, `tasks`, `journal.events`, `plan_scoped.events`); for `unverified` it is raw `{members:[{descriptor, plan, snapshot}]}` and task states come from `snapshot.tasks`. Missing or malformed fields drop only that task or edge.

- **Card** per `plan.tasks[]`: `id = plan_key/task_id`; `title` (fallback task id), `doneCondition`, `designMemo`, `lane`. `state` = Lattice status; `pending` becomes `ready` when every predecessor is `done` or `retired`.
- **Producer**: `actor.agent` of the task's latest `start` event (= the Bot id through `LATTICE_SEAT_ID`); before any start, the authored `lane` when it equals a member Bot id; otherwise null. `startedAt` = that start's `recorded_at`; `changedAt` = the task's latest event time.
- **Edges**: `plan.hard_dependencies` (`from` -> `to`), `plan.joins` (each `after` -> `before`), and cross-plan `plan_scoped.events` of kind `cross_plan_dependency` minus `cross_plan_dependency_removed` tombstones. An edge with an unknown end, a self edge, or one closing a cycle is dropped. `waiting` = predecessor not finished and successor not finished.
- **Waits**: one per waiting edge whose successor is not `retired`: `waiter` = successor's producer, `producer` = predecessor's producer, `producerState` = predecessor's state, `since` = the later of the predecessor's and the successor's `changedAt`. Sorted oldest `since` first.
- **Depth**: longest path from a root over the kept edges.
- **Counts**: `working` = in-progress, `blocked`, `waiting` = cards with at least one waiting incoming edge, `done` = done + retired.

## Child protocol (`src/lattice-protocol.mjs`)

`LATTICE_PROTOCOL_VERSION = 1`; `LATTICE_STATE_COMPATIBILITY = {state:'none'}` (the child keeps memory only; chart repos are Lattice's format, which Lattice versions keep compatible). Root methods and params:

| Method | Params | Result |
| --- | --- | --- |
| `charts` | `{}` | `bellteam.lattice-charts.v1` |
| `chart` | `{projectId}` | `bellteam.lattice-chart.v1` (or error `LATTICE_CHART_NOT_FOUND`, 404) |
| `refresh` | `{projectIds}` (1-50) | `{snapshots:[chart snapshots whose version changed], nextRefreshMs}` (2000 while any chart is asked) |
| `run` | `{from, projectId, args, input}` (`input` object or null) | `{exitCode, result, stdout, stderr}` |

Effect: `members.list {}` only, accepted only inside a pending root call. Controls `initialize {generation, mode}`, `quiesce`, `resume`, `exit` and `validateLatticeReady` exactly as work-graph. Root calls run one at a time. Only fixed error codes cross the wire.

## State it owns

| State | Where | Writer | Reader |
| --- | --- | --- | --- |
| Chart stores | `/srv/bellteam/state/lattice/<project>/` (git repo, `.lattice/**`) | Lattice CLI inside the child, only through `run` | child (`todo display read/source`) |
| Lattice HOME | `/srv/bellteam/state/lattice-home/` | Lattice CLI | Lattice CLI |
| Memo, epoch, version, last snapshot and token per chart | child memory | child | child |

`/srv/bellteam/state` is the server uid's persistent state volume (survives image swaps; Molly 2026-11-11). It is inside `/srv/bellteam`, which the nightly backup walks (Trony's runbook `bots/bot-7b140b27/docs/bellteam-backup-20261005.md`). Offline ownership maintenance re-modes it to 700/600 under the server uid; the child relies on no exec bits or git hooks.

## Failure handling

| Failure | What happens | Exit on its own |
| --- | --- | --- |
| Store inconsistent or partly unreadable | Lattice returns `unverified` / `last_verified` / `unavailable`; passed through; apps show a plain sentence and draw what they can | the next full read after repair returns `verified` |
| CLI read fails (spawn error, crash, bad JSON, timeout) | keep the last good snapshot, `degraded:['lattice-read']`, one diagnostic log line with the code | next token change or the 30 s ceiling |
| `members.list` fails | keep the last roster, `degraded:['members']` | next read |
| Producer not in the roster | omitted from `members`; apps draw 名簿にないメンバー | appears once the Bot exists |
| Write conflict inside Lattice | Lattice's result says so; the seat calls again | Snow White's release makes writers wait |
| Child down or exchanging | 503 `LATTICE_UNAVAILABLE`; apps keep the last drawing and reconnect; seat tool error | new child, new epoch, fresh snapshot |
| Older server without the module | 404 on `/api/lattice/*`; apps say the feature is not on this server yet | server update |

## How it updates

- Module code and the bundled Lattice version ship together as a module-only exchange (`publish-lattice.yml` attestation; Epinel adopts catalog rows; Molly exchanges). The body does not stop.
- New Lattice release: Snow White announces it -> Flora bumps the pin in the module lock -> module-only exchange. If a release ever changes the chart repo format incompatibly, `LATTICE_STATE_COMPATIBILITY` changes with it so the updater does not swap it as compatible.
- The MCP tool schema and the HTTP mount live in the body, so changing them rides a body train (Molly).
- Web page ships through the Web gateway (Admi reviews the registration lines; Molly exchanges web-gateway). Apple and Windows pages ship with their apps; Flora accepts them on real screenshots.
