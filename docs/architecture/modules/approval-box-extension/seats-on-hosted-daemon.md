# One port to Approval Box: the 決裁箱拡張 module (abx-one-port-redesign; Delta 2026-11-26)

Owner of this page: Delta (決裁箱拡張). Ruling (Owner, through Tronie, 2026-11-26): module connections go through contracted ports; a spaghetti diagram is a wrong design. BellTeam has exactly **one** port to Approval Box: this module. It owns the BellTeam-side Approval Box connection: the hosted connector, its one pairing to the Owner's Approval Box, and one published interface for filing and reading decisions. Every other BellTeam module uses only that interface and does none of this module's steps; this module reaches Approval Box only through Approval Box's published connector commands. Result for the Owner: **one pairing, one QR**.

This page replaces the first drawing of the Owner's sitting (#2626/#2627). Other pages stay canonical for their own boxes: [runtime/approval-box-daemon.md](../runtime/approval-box-daemon.md) (transport: the container door), [terminals README, Approval Box door](../terminals/README.md) (transport: the host doors), [seat-approval-card.md](seat-approval-card.md) (the card Kiro files), [child-join.md](child-join.md) (the 決裁箱 window as a child device, unrelated to this port). Chart: `bellteam-dev-added/abx-one-port-redesign`; the owners' changes follow this page.

## 1. The ports (who calls what)

| Port | Published by | Caller | Operations | Notes |
| --- | --- | --- | --- | --- |
| **P1 Decision port** (typed, in the body, same shape as `lattice-owner-task`) | this module | Flora (Lattice decisions), Kiro (seat tool-approval cards, running exclusions) | `file(decision, origin)` -> id, `read(id)`, `cancel(id, reason)`, `capabilities()`, `connection()` -> linked / not linked | `origin` is a label (`lattice`, `seat-approval`, `running-exclusions`) that goes into the card's requester and `session_label`; no caller holds a credential, a secret card or a token |
| **P2 Seat line port** (the connector's own NDJSON line protocol, one line in, one line out) | this module, at the module's seat socket | transport only: the container door and the body route (Molly), the host doors (Krust) | the lines the seat's Approval Box runtime sends after `use-hosted` (requests, uploads, `GET /deliveries`, `POST /deliveries/:id`) | the doors parse nothing and keep nothing; a door that cannot reach it answers `503 APPROVAL_BOX_DAEMON_UNAVAILABLE` |
| **P3 Pairing port** (Owner-session HTTP, same origin as `/api/approvals`) | this module | the clients' pairing view (Rapi, Anis, Neon) | `GET` the state, `POST start`, `POST stop` (state none / waiting / linked / failed / removed, `code`, `qrText`, `expiresAt`, `reason`) | the existing `/api/approvals/seat-link` routes keep their path and shape so no client re-routes; they now mean the one pairing (the screen's heading moves to 「決裁箱につなぐ」 in screen-spec, Delta) |
| **P4 Supervision port** | Molly (body, runtime) | this module | the body starts, stops and watches the module's child process like any module; the module supervises the connector daemon it runs | the module.json hosting contract that exists today (`approval-box-parent-*`) |
| **P5 Seat entry contract** (`bellteam.harness-entries.v1`, E1) | this module | Molly's harness-entries (E2 item `approval-box`) | the MCP and hook entry the seats need, naming the installed runtime | content = what the connector's `harness-entries --json` prints; the E2 item points at the module's E1 once it exists; until then it keeps running the connector binary (same content) |
| **P6 Connector commands** | Nayuta (Approval Box) | this module only | `pair`, `install-runtime`, `use-hosted --socket` / `--off`, `harness-entries --json`, `connection export --json`, daemon run, `version --json` | nobody else calls them |
| **P7 Credential custody** | Mika (usage, `secrets`) | this module | the one connection's secret is kept through the existing usage `secrets` port | usage no longer calls Approval Box itself |

## 2. Function diagram

```mermaid
flowchart LR
  subgraph CALLERS["Other BellTeam modules (each keeps its own part)"]
    FL["Flora: Lattice decisions"]
    KI["Kiro: seat cards, running exclusions"]
    CL["Rapi / Anis / Neon: pairing view"]
    SEAT["seats' Approval Box runtime (use-hosted)"]
  end
  subgraph TRANSPORT["Transport only (parses nothing, keeps nothing)"]
    CD["container door (Molly)"]
    HD["host doors rabbit / Mac / fox (Krust)<br/>+ body route (Molly)"]
  end
  subgraph MOD["決裁箱拡張 (Delta): the one port"]
    P1["P1 Decision port"]
    P2["P2 Seat line port (module's seat socket)"]
    P3["P3 Pairing port"]
    PAIR["pairing manager<br/>none / waiting / linked / failed / removed"]
    DAE["hosted connector daemon (supervised)"]
    P5["P5 seat entry (E1)"]
    SW["seat switch + first request check (runbook)"]
    EXT["existing: link rules, link record, /api/approvals/*, client /v1"]
  end
  subgraph BODY["Body (Molly)"]
    SUP["P4 supervision of the module"]
    REG["harness-entries registration (E2)"]
  end
  subgraph USG["usage (Mika)"]
    SEC["secrets"]
  end
  subgraph AB["Approval Box (Nayuta)"]
    CMD["P6 connector commands"]
    SRV["server + peer-channel"]
  end
  FL --> P1
  KI --> P1
  CL --> P3 --> PAIR
  SEAT --> CD --> P2
  SEAT --> HD --> P2
  P1 --> DAE
  P2 --> DAE
  PAIR --> CMD
  DAE --> CMD
  SW --> CMD
  CMD --> SRV
  PAIR --> SEC
  P5 --> REG
  SUP --> MOD
```

Every arrow into this module lands on P1, P2, P3 or P5; every arrow out lands on P6 or P7. No other module reads or writes this module's files, state or the connector's home.

## 3. Data flow

```mermaid
flowchart TD
  K["Kiro: a seat stopped on a tool prompt"] -->|"P1 file(decision, seat-approval)"| DAE["hosted connector daemon (module)"]
  F["Flora: a Lattice decision"] -->|"P1 file(decision, lattice)"| DAE
  AI["AI in a seat: request_decision (runtime pc.5)"] -->|"hosted.json: every tool call"| T["transport: container door or host door + body route"]
  T -->|"P2 one NDJSON line, one reply line"| DAE
  DAE -->|"peer-channel"| IPH["Owner's iPhone: one card per request"]
  IPH -->|"answer"| DAE
  DAE -->|"P1 read(id)"| K
  DAE -->|"deliveries: seat connector daemon polls GET /deliveries through P2"| AI
  PV["pairing view"] -->|"P3 start"| PAIR["pairing manager"] -->|"P6 pair"| IPH
```

Data ownership: decision content lives only in the hosted connector's store (this module); the seat keeps no token and no keys; the doors keep nothing (a host door holds a seat bearer in memory only, Krust); callers keep ids (Kiro's record of botId, digest, first-seen, id) and nothing of the connection.

## 4. States

```mermaid
stateDiagram-v2
  [*] --> NotLinked
  NotLinked --> Waiting: P3 start (pair command, waiting line read within 20 s)
  Waiting --> Waiting: start again (same line)
  Waiting --> Linked: Owner reads the one QR and confirms
  Waiting --> Failed: rejected | expired (5 min) | run ended | no waiting line in 20 s
  Waiting --> NotLinked: P3 stop
  Failed --> Waiting: start
  Linked --> Removed: a call answers 401
  Removed --> Waiting: start
```

Every state leaves by the Owner's tap, the run ending or a bounded wait; none waits for an operator. P1 `file` in any state but Linked answers `UNAVAILABLE` and the caller keeps its own fallback (Kiro's in-app entry stays); P2 in any state but Linked answers `503 not_paired`.

```mermaid
stateDiagram-v2
  [*] --> OwnPath: seat host today (own connector, /mcp path)
  OwnPath --> RuntimeReady: install-runtime pc.5 (no hosted.json yet, OwnPath still answers)
  RuntimeReady --> Registered: registration pass writes the new runtime into the seat's entries
  Registered --> Hosted: module Linked; use-hosted --socket <door> writes hosted.json
  Hosted --> OwnPath: use-hosted --off (a failed check, or the Owner says stop)
  note right of Hosted: a seat reads the new entries at its next normal start; nobody force-restarts a seat (Tronie 2026-11-26)
```

## 5. The seven connections today, and where each ends up

Source: `node /srv/bellteam/shared/tools/assign-owner/who-owns.mjs --uses approval-box` (Tronie).

| Today | Owner | After | What the owner changes |
| --- | --- | --- | --- |
| approval-box-extension: client `/v1` (read, answer) + connector pairing | Delta | stays inside this module; pairing becomes P3 | Delta |
| execution: `connector /v1` (seat cards via the seat-link token, running exclusions via their own secret pair) | Kiro | P1 `file/read/cancel` with `origin`; the seat-link token source and the secret pairs retire; no second pairing | Kiro swaps `createApprovalDecisions` for the P1 client |
| execution: `version --json (capabilities)` | Kiro | P1 `capabilities()` | Kiro |
| lattice: `connector /v1` (`createLatticeDecisions`, own secret pair) | Flora | P1 `file/read/cancel` with `origin: lattice`; the secret pair retires | Flora |
| integration: `connector /v1` (`approval-box-parent-facade`) | Molly | it is the hosting of this module (P4); no direct connector call remains | Molly |
| runtime: `harness-entries (approval-box)` | Molly | stays a seat-registration contract, now fed by P5 | Molly points the E2 item at the module's E1 when it exists |
| usage: `connection export --json` | Mika | the module calls the export itself and keeps the result through P7 (Nayuta confirmed 2026-11-26: it returns `{schema approval-box.connection.v1, server, token}`, the /v1 connection bearer; the module uses it for the connection's identity and server only, never to file or read decision content, because the /v1 content routes close on 2026-12-12) | Mika drops the direct call |

## 6. Files, claimed by exactly one module

| File | Module after this page | Why |
| --- | --- | --- |
| `src/approval-box-daemon.mjs`, `src/approval-box-daemon-mcp.mjs` | **approval-box-extension** (today in no module.json source list) | the hosted connector and its pairing are this module's |
| `src/lattice-approval.mjs` (`createApprovalDecisions`) | **approval-box-extension** (the P1 client); Lattice keeps only its own `createLatticeDecisions` call site | one factory, one owner |
| `src/approval-box-seats-socket.mjs`, `src/approval-box-door-route.mjs` | integration (Molly): transport to P2 | the body's side of the doors; parses nothing |
| `src/terminals/approval-door*.mjs` | terminals (Krust): transport | the host doors |
| `src/approval-box-parent-*.mjs` | runtime/integration (Molly): P4 | hosting of this module |
| `src/seat-approvals.mjs`, `src/http-seat-approvals-api.mjs` | execution (Kiro) | the seat side; calls P1 only |

The claim is made here first (diagrams first). `module.json` `source` and `provides` follow in the code step with the test that pins the list today to the `approval-box-extension*` files (`test/approval-box-extension-child.test.mjs`); Flora's `module.json` drops `src/lattice-approval.mjs` in the same step.

## 7. The sitting, in order (no restart step)

| Step | Who | Done when |
| --- | --- | --- |
| 0 | Delta, Molly, Kiro, Flora, Mika | the module takes the daemon files and publishes P1, P2, P3, P5; each owner moves only their own side (section 5). **Kiro's seat cards are on P1 and the `pair --json --v1` link (#2545) is retired before step 1**: once `PC_OFFER` is on the apps stop showing /v1 decisions, so a card filed through the old link would not be seen (Nayuta) |
| 1 | Nayuta | open /v1 decisions cleared, `PC_OFFER` on (never before step 0 is done for the seat cards) |
| 2 | Owner | one QR on his iPhone through P3 (the pairing view) until the state reads **Linked** |
| 3 | Delta | container seats: `install-runtime` pc.5, `use-hosted --socket /srv/bellteam/state/approval-box-hosted.sock`; then rabbit and Mac on each host's door (a door exists only while a seat runs there) |
| 4 | Molly | after Delta's message "install done": one on-demand registration pass (her script backs up the seat files first; only approval-box lines are expected) |
| 5 | Delta | fox and any Windows seat: the same on the pipe, runtime pc.5, only after Krust's `door-pipe-owner-check` is done (a Windows door could hand a seat bearer to a pipe squatted by another local account) |
| 6 | Delta | first real request from one seat that **starts after step 4**: the card is on the iPhone, his answer returns to the seat, `list_my_decisions` reads it answered; one result to Tronie |

Before Linked, a switched host answers 503 `not_paired`, so no host is switched before step 2. A seat that started before step 4 keeps its old entries until its own next normal start; nobody restarts it.

## 8. Failure handling and protections

| Case | What happens | Who leaves it |
| --- | --- | --- |
| Not linked when a caller files | `UNAVAILABLE`; the caller keeps its fallback (Kiro's in-app entry) | the Owner links (P3) |
| 401 from Approval Box | state Removed; the caller's `file` answers `UNAVAILABLE`; no retry storm (one call per tick) | the Owner links again |
| No host door (no seat on that host) | the connector answers `door_unavailable` and retries | the next launch or resume registers the door (Krust) |
| Request filed, no card | the check fails; `use-hosted --off` on the host; the cause goes to the owner of the failing box | Delta reports, the owner repairs |
| Another local user opens the Windows pipe | read-only clients cannot write a request line and are closed at 30 s; no DACL change (Tronie 2026-11-26) | Krust's door |
| Another local account owns the pipe name first | the Windows step does not run until `door-pipe-owner-check` is done | Krust |

Protected: the seat bearer and decision content (never copied by a caller), the wrong target (a host is switched only to the door named for its class). No other guard is added.

## 9. Open points for the owners (Delta asks, each answers in one message)

- Nayuta: **confirmed 2026-11-26**. The connector's `pair` (8-character code + QR) makes the one connection the hosted daemon uses; with `PC_OFFER` on, the daemon files every decision over the peer channel, Kiro's seat cards included; no second token and no `pair --v1` link remain (`--v1` exists only for a server without peer_channel). The /v1 content routes close on 2026-12-12 (approval-box k12), so the seat-card link must be moved onto P1 before `PC_OFFER` goes on and then retired.
- Mika: confirm the `connection export` call can sit inside this module with the result kept through the `secrets` port.
- Kiro, Flora: confirm the P1 shape (`file(decision, origin)`, `read`, `cancel`, `capabilities`, `connection`) covers what you call today; say what is missing before it is built.
- Molly: confirm the P4 split (body supervises the module; the module supervises the connector daemon) and the E1 hand-over.
