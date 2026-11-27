# Seat tool-approval prompts reach the Owner (seat-approval-to-abx, Owner 2026-11-24)

Owner: Kiro (execution). Card contract: Delta, [seat-approval-card.md](../approval-box-extension/seat-approval-card.md). Owner words: 「決裁箱に飛んでくればいいだけなんだけどな。」 and 「決裁箱が使えるユーザーならね。」 A seat that stopped on a tool-approval prompt (Bready sat 3.5 h on Claude Code's "Dangerous rm operation") must reach the Owner: as an Approval Box card when he has Approval Box connected, otherwise as the same entry inside BellTeam, the same on every client. His answer approves that one prompt once or denies it, and goes back to that same prompt.

## Function diagram

```mermaid
flowchart LR
  Seat["seat blocked on a tool approval<br/>Claude machine seat: pending can_use_tool<br/>Codex / TUI Claude: dialog on screen"] -->|"Aiterm claude_approval / agent_approval"| Insp["transport.screenApproval inspect<br/>digest, choices, prompt facts"]
  Tick["SeatApprovals.tick (working Claude/Codex Bots)"] --> Insp
  Insp --> Rec["one record per prompt occurrence<br/>state/seat-approvals.json"]
  Stream["machineStream.pendingApprovals(bot)<br/>tool, command"] -->|facts of a machine seat| Rec
  Rec -->|"GET /api/seat-approvals + SSE topic seat_approvals + push (no card)"| Apps["every client: same entry, same two buttons"]
  Rec -->|"P1 file() / read(id) / cancel(id, reason)"| Card["Approval Box card (Delta)"]
  Apps -->|"POST /api/seat-approvals/:id/answer"| Ans["SeatApprovals.answer"]
  Card -->|"answered: read()"| Ans
  Ans -->|"screenApproval respond {decision, stored digest}"| Insp2["Aiterm re-checks the dialog (digest-bound)"] --> Seat
  Ans -->|"cancel() the card when answered elsewhere"| Card
```

## Data flow and state (one record = one prompt occurrence)

`id = sa-<botId>-<digest first 16 hex>-<firstSeen seconds>`; fields: `botId, harness, digest, firstSeen, facts{tool, command, reason}, status open|answered|gone, answeredBy app|card|elsewhere, decisionId|null`. The file survives a body restart; Delta's `file()` re-adopts the card by its `session_label`, so a restart files nothing twice.

```mermaid
stateDiagram-v2
  [*] --> Open: inspect = approval_required (new digest)
  Open --> Answered: answer (app or card) and respond = submitted
  Open --> Gone: inspect = none, or another digest (answered in the chat card, seat stopped)
  Open --> Gone: respond = 409 SCREEN_APPROVAL_CHANGED (stale, nothing was sent)
  Answered --> [*]
  Gone --> [*]
```

Every state leaves by the next tick or by a prompt change; nothing waits for the Owner. A card still unanswered when the prompt is gone is cancelled.

## Server contract (the clients' rows follow this; Owner session only, the internal Bot port gets 403 `SEAT_APPROVAL_OWNER_REQUIRED`)

| Route | Answer |
| --- | --- |
| `GET /api/seat-approvals` | `{"approvals":[{"id","botId","botName","harness","tool","command","reason","since","choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"none"\|"filed"}]}`: the open entries, oldest first. `command` is secret-masked and cut at 2000 characters; for a TUI Claude seat Aiterm gives no text, so `tool` and `command` are `null` and the client says "see the Bot's screen". `card: "filed"` = an Approval Box card exists for it (the in-app entry stays; no push was sent). |
| `POST /api/seat-approvals/:id/answer` `{"decision":"approve_once"\|"deny"}` | `200 {"id","status":"answered","decision"}`. `400 SEAT_APPROVAL_INVALID`, `404 SEAT_APPROVAL_NOT_FOUND`, `409 SEAT_APPROVAL_CLOSED` (answered by another front, stale, or the prompt is gone: the first answer wins), `502 SCREEN_INPUT_FAILED`. |
| SSE `/api/events` | topic `seat_approvals` with the `botIds` of the changed entries: a client re-reads the list. |
| Push | One push per new entry only when no card was filed (the card brings its own push). The existing `owner_question` push (title = the Bot's name, the same generic body as a machine seat's question); tapping it opens the Bot, where the entry is. |

The Bot screen keeps `GET/POST /api/bots/:id/screen/approval` ([screen-input.md](screen-input.md)) and Claude machine seats keep the chat `approval` row (conversation machine-stream.md): all fronts end in the same Aiterm respond with the same digest, so the first answer wins and the others see the prompt gone.

## Rules

- Detection: every tick, for each Bot of harness claude or codex whose current work is `working`, or whose machine stream lists a pending approval (a machine seat stopped at a tool approval reads `unknown` within seconds, Centi's lab 11/24; `unknown` itself is not watched: every Bot without a running seat reads it and each inspect starts tmux): `screenApproval inspect`. Claude machine seats cost no tmux read (Aiterm reads the stream files). Grok, Cursor and Antigravity have no Aiterm approval tool: no detection until Aiterm offers one (asked of Elegg).
- Facts: machine seat = the Bot's first pending `approval` row of the machine stream (tool name, command); Codex = `agent_approval`'s `prompt` and `kind` (cut at 2000); the harness's reason is a fixed sentence per harness plus, for a Claude machine seat, Claude Code's own `decision_reason` of the `can_use_tool` request (measured on Bready's seat 11/24: `Dangerous rm operation on working directory or its ancestor: <path>`, `classifier_approvable: false`; the request line also carries `decision_reason_type` and `description`). Secrets in the command (tokens, keys, `*=…` of secret-looking names, private key blocks) are masked before the record or the card holds the text.
- Card: through P1 of the 決裁箱拡張 module (`approvals.decisions`, [decision-port.md](../approval-box-extension/decision-port.md), one port to Approval Box, Tronie ruling 2026-11-26): `file({title, context, options, requester, session_label, origin: 'seat-approval'})` (idempotent per `session_label`), `read(id)`, `cancel(id, reason)`. No token, secret card or pairing here (Tronie ruling 2026-11-28 b: the body is a plain Approval Box client). The backend is the host's public client, see "Backend" below. When the client cannot be run or refuses (`UNAVAILABLE`) the entry stays in-app only, one push is sent, and the next tick tries the card again.
- Answer: always `screenApproval respond` with the digest stored at filing; a changed or gone dialog never receives an old answer. A free-text answer on the card counts as deny.
- No new guard: nothing is refused or held; a failed tick is retried by the next one.

## Backend of `approvals.decisions`: the host's public Approval Box client (seat-approval-to-abx, Tronie ruling 2026-11-28 b)

The interface stays as Delta kept it (file / read / cancel, typed errors `UNAVAILABLE` / `REFUSED` / `GONE`, idempotent per `session_label`, origins `seat-approval` / `running-exclusions` / `lattice`). Its backend is no longer the body's hosted connector: it is `approval-box mcp` (stdio MCP, the same client every AI uses), already set up for the seat user on the host. Approval Box and the host's settings stay untouched. Implementation: `src/approval-box-client.mjs` (`createApprovalBoxClientPort({ seatRun })`), wired in `application-services` as the one `decisions` object (running exclusions, seat approvals, approvals facade, Lattice adapter). Delta removes the daemon, pairing, QR tool and door in a separate change.

```mermaid
flowchart LR
  Callers["SeatApprovals / RunningExclusions / Lattice decisions adapter"] --> Port["approvals.decisions: file / read / cancel"]
  Port --> Run["seatRun (seat user, 15 s)&lt;br/&gt;~/.approval-box/bin/approval-box mcp&lt;br/&gt;stdin: initialize, initialized, tools/call"]
  Run --> MCP["Approval Box MCP: list_my_decisions / request_decision / get_decision / cancel_decision"]
  MCP --> Box["Approval Box (the Owner's one connection of this host)"]
```

| Port call | Client calls | Result and errors |
| --- | --- | --- |
| `file` | `list_my_decisions`; an item with this `session_label` and status pending/held is adopted (`existing: true`). Else `request_decision {title, context, options, requester_name, session_label}`; the first answer is `confirm_required` + `check_token` (the list is the one just read), the second call carries the token. `duplicate_suspected` with an open card of this label is adopted | `{decisionId, existing}`. A cancelled or answered card of the same label is not adopted: a new prompt files a new card. Unknown origin or empty label: `REFUSED` before anything runs |
| `read(id)` | `get_decision` | `{status, answer?: {optionId, text}}`; `text` only from the answer's own text (the client's `answer_text` is its wake-up message to an AI and is never used). `not_found` = `GONE` |
| `cancel(id, reason)` | `cancel_decision` | `{status: 'cancelled'}`. An answered or cancelled card: `REFUSED`; `not_found`: `GONE` |
| any | process cannot run, timeout 15 s, no MCP answer, no seat runner (dev, tests) | `UNAVAILABLE` (ends the caller's tick; the next tick tries again) |

Data: no stored state in this backend. The card id lives in the seat-approvals record (`decisionId`); a restart re-adopts an open card by `session_label`. Protects: no second card for one prompt (adopt by label) and no old answer for a new prompt (digest-bound respond above). Self-exit: every failure is `UNAVAILABLE`/`REFUSED`/`GONE` for one call; nothing waits or holds. Cost: one short process per call, only while a prompt (or a Lattice/exclusions card) is open.
