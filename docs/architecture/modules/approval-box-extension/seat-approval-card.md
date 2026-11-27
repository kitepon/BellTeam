# A seat's tool-approval prompt as an Approval Box card (seat-approval-to-abx, Delta 2026-11-24)

Owner 2026-11-24: a seat stopped on a tool-approval prompt should send a card to him, and his answer approves that one prompt once or denies it. He added: only when the Owner has Approval Box connected; otherwise the same prompt is answered inside BellTeam.

Scope of this page: the card (how BellTeam files, reads and closes it). Kiro builds the seat side (watcher, state, the answer back to Aiterm); the in-app answer already exists (`GET/POST /api/bots/:id/screen/approval`, [screen-input.md](../execution/screen-input.md)). The apps only read the card.

## Connection (fifth version, 2026-11-28: no connection of BellTeam's own)

History, so nobody builds the wrong one: #2510 said "hosted daemon only"; #2531/#2532 said "connector token path with a token the Owner creates and pastes" (rejected); #2538 said "a second pairing by `pair --json --v1`"; the 2026-11-26 drawing said "the module's one hosted connector and one pairing, one QR". **All four are gone.** Ruling (Owner through Tronie, 2026-11-28): Approval Box stays standalone and BellTeam's body keeps no connector, no pairing and no QR. The body files a seat's tool-approval card as a plain Approval Box client: the host's own public Approval Box client (`approval-box mcp` stdio: `request_decision` / `get_decision` / `cancel_decision`) that the host already has set up for its seats. That backend is Kiro's (execution); the interface stays the one port of the 決裁箱拡張 module ([decision-port.md](decision-port.md), P1).

Kiro calls `approvals.decisions.file(decision, 'seat-approval')`, `read(id)` and `cancel(id, reason)`; no token, no secret card, no pairing, no path to Approval Box of BellTeam's own.

- No set-up Approval Box client on the host (or it answers 401): `file` answers `UNAVAILABLE` and nothing is filed; the prompt stays answerable inside BellTeam, and the next tick tries again.
- `file` is idempotent per `session_label` and returns `{decisionId, existing}`; `read` marks an answered card fetched; errors are `UNAVAILABLE` / `REFUSED` / `GONE` with the 5 s bound (the P1 contract).

Dedupe: the watcher's own record (botId, digest, firstSeen, decisionId) is the primary key, so a card is read and cancelled by id; P1 `file` adopts an earlier card with the same `session_label`, so a lost answer never files twice.

The first pairing view 「決裁箱につなぐ」 and its routes `/api/approvals/seat-link` are removed with the pairing (nothing draws or calls them; the clients' block was retired on 2026-11-27). The Owner's step for a host's Approval Box is Nayuta's own setup of that product.

## Who builds what

| Who | Builds |
| --- | --- |
| Delta | this page, the P1 interface (`approvals.decisions`) and the removal of the pairing, the daemon and the QR tool |
| Kiro | the seat watcher: files, reads and cancels through P1 (`origin: seat-approval`); the backend of P1 (the host's public Approval Box client); no card while P1 answers `UNAVAILABLE`; the in-app entry stays the fallback |
| Nayuta | the Approval Box product and each host's own connector setup |

## Card shape

| Field | Value |
| --- | --- |
| `title` | 「◯◯が、「<tool>」を1回だけ実行してよいか、決めてください」 (◯◯ = the Bot's name) |
| `context` | Bot name; harness; the exact tool and command, shown literally and cut at 2000 characters with 「（以下省略）」; the harness's reason text; the time the prompt appeared (JST). Run the body's secret masker over the command before filing: a command can hold a token, and the card is stored by Approval Box. |
| `options` | `approve_once` 「1回だけ許可する」 and `deny` 「許可しない」, in this order, none recommended, none preselected. The ids are the values `POST screen/approval` takes. |
| `requester` | the Bot's roster name (the client rule 2, `basis: "name"`; the body's file call sends no `requester_bot_id`) |
| `session_label` | `Seat <botId> <promptDigest first 16 hex> <firstSeen epoch seconds>`. Never `Lattice …`, so no chart link is attached. The first-seen seconds make a later identical command a new occurrence (without it `file()` would adopt the earlier answered card). |
| `urgency` | normal; no deadline |
| free-text answer | counts as `deny` (no text is sent to the seat); the card says nothing about it |

## States and who moves them

```mermaid
stateDiagram-v2
  [*] --> Watching: seat is up
  Watching --> Filed: approval_required seen, file() returned an id (record: botId, digest, firstSeen, decisionId)
  Watching --> InAppOnly: approval_required seen, P1 answers UNAVAILABLE or file() failed
  InAppOnly --> Watching: prompt gone
  Filed --> Applying: read() = answered with approve_once or deny
  Applying --> Done: POST screen/approval {decision, digest} = 200
  Applying --> Stale: 409 SCREEN_APPROVAL_CHANGED (dialog changed or gone)
  Filed --> Cancelled: prompt gone (answered in BellTeam, seat stopped, digest changed): cancel(reason)
  Stale --> Watching: nothing is sent; the new prompt, if any, gets its own card
  Cancelled --> Watching
  Done --> Watching
```

- One card per prompt occurrence. The watcher keeps the record (it survives a body restart: `file()` re-adopts by `session_label`, so a restart never files twice).
- The answer is applied only with the digest stored at filing. A changed or gone dialog never receives the Owner's old answer.
- Answered in BellTeam first: cancel the card with 「BellTeamの画面で答えられました」. Answered on the card first: the in-app prompt disappears by itself; a late tap there gets 409.
- `read()` marks the card fetched, so the Owner's app shows the delivery as delivered once the body has applied it (client-v0.5 screen-spec, Answer outcomes).
- `cancel()` on an already answered card answers 4xx (REFUSED): ignore it.
- Every state leaves by the next watch tick or by a prompt change; none waits for the Owner (a card left unanswered stays in the Owner's list until the prompt goes, then it is cancelled).

## Data flow

```mermaid
flowchart LR
  Seat["seat (Aiterm blocked: tool approval)"] --> Watch["body watcher (Kiro)"]
  Watch -->|"GET screen/approval: digest, choices"| Aiterm["Aiterm claude_approval / agent_approval"]
  Watch -->|"file(): title, masked context, options, session_label"| Door["P1 decision port: the host's public Approval Box client (Kiro's backend)"]
  Door --> Server["Approval Box (the host's own connector)"] --> Phone["Owner's Approval Box / BellTeam 決裁箱"]
  Phone -->|"answer approve_once / deny"| Server --> Door
  Watch -->|"read() every tick; fetched"| Door
  Watch -->|"respond {decision, digest}"| Aiterm
  Watch -->|"prompt gone: cancel()"| Door
```

## What the 決裁箱 screens do with it (client rows follow, Kiro's contract first)

A BellTeam-origin card whose `session_label` does not name a chart task shows no chart line at all (neither 「工程表につなげています」 nor 「この決裁に合う工程は、工程表に見つかっていません」): it was never meant for a chart. Otherwise it is an ordinary BellTeam card (face and name of the Bot, the two buttons, the answer line of screen-spec).
