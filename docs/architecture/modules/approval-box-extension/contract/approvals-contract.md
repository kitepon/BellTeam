# `/api/approvals/*` app contract (v0.1, fixed 2026-11-15)

Owner: Delta (bot-ae42e3e9). Served by the 決裁箱拡張 module child through the body's web-gateway mount, same-origin Owner session, exactly like `/api/lattice/*` (the Web, Apple, Windows and Linux apps send the session they already have; they never call Approval Box). Additive-only: unknown fields are ignored; unknown enum values draw as 「その他」. Screens and wording: [../screen-spec.md](../screen-spec.md). Design and boundaries: [../README.md](../README.md). Sample data: [fixtures/](fixtures/) (valid ViewDecision / list / summary / error bodies for app tests; no server needed).

Canonical location moves to `docs/architecture/modules/approval-box-extension/` in the BellTeam repo with the first implementation PR (diagrams and code in one diff). Until then this folder is canonical.

Source facts come from Approval Box `docs/api.md` v0.38 and `docs/owner-credential.md` (Nayuta): the module reads `/v1` with the Owner credential `kot_…` and maps each Decision into a **ViewDecision**. Ids exist only in the API, never on screen.

## Calls

| Call | Body → returns |
| --- | --- |
| `GET /api/approvals/summary` | `{schema:"bellteam.approvals-summary.v1", pending, urgent, held, answeredToday, filedToday, byOrigin:{bellteam, external}}`. Counts include every origin; `byOrigin` counts the pending ones. For the menu badge, the ring and the 出どころ chips |
| `GET /api/approvals?status=pending,held` or `?status=answered,cancelled&cursor=<c>` (+ optional `origin=bellteam\|external`; absent = all; `unknown` counts as `external` for the filter) | `{items:[ViewDecision], nextCursor?}` in Approval Box's order (急ぎ, nearer 期限, older first; answered/cancelled by `updatedAt` newest first) |
| `GET /api/approvals/:id` | `ViewDecision` |
| `POST /api/approvals/:id/answer` `{optionId?, text?, version}` + `Idempotency-Key: <uuid>` | updated `ViewDecision`. `optionId` or `text` is required, `version` is required |
| `POST /api/approvals/:id/hold`, `…/unhold` | updated `ViewDecision` |
| `GET /api/approvals/:id/attachments/:aid` | the bytes with Approval Box's `Content-Type` and `ETag`; for request images and answer attachments (read only; BellTeam cannot upload, the Owner credential does not allow it). The sender may not be ours, so every response carries `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` and `Content-Disposition: inline` only for png/jpeg/gif/webp (`attachment` for any other type) |
| `GET /api/approvals/events` (SSE) | `event: summary` (the summary body), `event: decision.created\|updated\|deleted` `data: {id, version}`; `Last-Event-ID` resumes; the app refetches what changed. Heartbeat every 25 s |
| `GET /api/approvals/connection` | `{state: "connected"\|"waiting"\|"denied"\|"not_connected"\|"expired", connectedAt?, expiresAt?}` (no secret ever) |
| `POST /api/approvals/connect` | starts the connect (device-authorization style, no redirect to the user's server) → `{authorizationUrl, expiresAt}`; `authorizationUrl` is Approval Box's hosted consent page with the request code already in it; the app opens it in the browser, the module polls Approval Box in the background (interval and backoff as Approval Box says) until granted, denied or expired; a second call while waiting returns the same request |
| `DELETE /api/approvals/connect` | stops waiting (やめる) → the new `connection` |
| `DELETE /api/approvals/connection` | forgets the session (つなぎを外す) → the new `connection` |
| `GET /api/approvals/by-decision?id=<decisionId>` (a490g) | `{project, plan, task, state: linked\|answered\|closed\|diverged, attached}` or 404; ids and state only, read from the link record, no Approval Box call (works after the content routes close); any failure → the caller draws no badge |
| `GET /api/approvals/by-task?project=<id>&plan=<key>&task=<id>` | `{decisionId, status, title}` or 404 (for Lattice 詳細 「決裁を開く」; any failure → the caller draws no block) |

## ViewDecision

```
{
  id, title, context,                       // context is plain text, never Markdown
  options: [{id, label, recommended}],      // recommended from Approval Box's `recommendation`
  urgency: "low"|"normal"|"high", deadline?: ISO-UTC,
  status: "pending"|"held"|"answered"|"cancelled",
  answer?: {optionId?, text?, attachments:[Attachment], answeredAt},
  delivery?: "waiting"|"delivered"|"unknown"|"fetched",   // only meaningful when answered
  resumePhrase, version, createdAt, updatedAt, cancelReason?,
  amended: {is, fields:[…], note?, at?},    // from history: last kind "amended"
  history: [{at, kind, by, note?, fields?}],
  requestAttachments: [Attachment],         // images the AI attached; draw as thumbnails
  origin: {
    kind: "bellteam"|"external"|"unknown",
    basis: "botId"|"name"|"none",           // how kind was decided (below)
    client: "claude-code"|"codex"|"cursor"|"grok"|"claude.ai"|"chatgpt"|"other",
    tool,                                   // display name: Claude Code / Codex / Cursor / Grok / Claude / ChatGPT / その他 / 出どころ不明
    sessionLabel, workLabel, connectionLabel, via: "connector"|"remote"
  },
  requester: null | {botId, name},          // BellTeam decisions only
  link: null | {                            // null for external decisions with no chart task
    state: "linked"|"answered"|"closed"|"diverged", attached: bool,
    chart: {name, projectId}, task: {title, state: pending|ready|in-progress|blocked|done|retired, lane, cardId},
    previous: [{title, state, cardId}], next: [{title, state, cardId}]   // cardId = "<plan>/<task>", the Lattice snapshot card id form
  }
}
Attachment = {id, name, contentType, size, sha256}
```

`link` and the task states are read at call time from the Lattice facade and the link record; nothing here is stored. `chart.name` follows the Lattice chart-name rule (never the project id). `chart.projectId` and the `cardId`s exist only so the apps can open the chart at that card (工程表で見る, 工程表の工程を開く, 前の工程 / 次の工程); they are API-only and never drawn. An app draws those buttons only when the fields are present (added 2026-11-15 at Admi's request).

### How `origin.kind` is decided (Approval Box v0.38 `source`)

1. `source.requester_bot_id` present and in the BellTeam roster → `bellteam`, `basis: "botId"`, `requester {botId, name from roster}`.
2. Otherwise `source.requester` (the AI's self-reported name) exactly equals a roster member's name → `bellteam`, `basis: "name"` (used for decisions filed before the connector release that sends the bot id; display and chart link only, never authentication).
3. Otherwise there is a `source.client` or `session_label` → `external`, `basis: "none"`, `requester: null`.
4. Nothing usable → `unknown`.
Visibility never depends on `kind`. A decision whose `session_label` names a BellTeam chart task (`Lattice <project> <plan>/<task>`) is attached to that task whatever its kind (README L8/L10) and then has a `link`.

## How the apps draw each shape (details in screen-spec.md)

| Shape | List card | 詳細 | 工程とのつながり panel |
| --- | --- | --- | --- |
| `bellteam` + `link` | face + name from `requester`; badge 回答待ち (急ぎ); note 「工程表「<task.title>」が、この回答を待っています」 | normal | previous / this / next cards from `link`; button 工程表の工程を開く |
| `bellteam`, `link` null (the chart is not readable yet, or the decision just arrived) | face + name; note 「工程表につなげています」 (grey, no error) | normal | the same panel with a muted card 「工程表につなげています」 |
| `external` | grey tool tile + `tool · sessionLabel`; extra grey badge 外部から; note 「工程表とはつながっていません」 (muted) | block 「BellTeamの外から届いた決裁です」 (tile, tool, `via` as リモート接続 / コネクタ, session) | dashed neutral card 「つながっていません」 + one-line explanation; no button |
| `external` + `link` (session names a chart task) | tool tile + 外部から badge; the note of a linked decision | as external + the block | normal panel |
| `unknown` | globe tile + 「出どころ不明」 + 外部から badge | as external | as external |

## Errors

`{error:{code, message, decision?}}`, `message` is Japanese and fit to show.

| HTTP | code | Meaning → the app shows |
| --- | --- | --- |
| 400 | `validation_failed` | the message |
| 403 | `not_entitled` (`state`: none\|expired\|revoked, `validUntil?`; trial and billing-off are entitled, Owner decision (d)) | failure view 1 (none) or 2 (expired / revoked) |
| 409 | `not_connected` | the module holds no usable Approval Box session (never connected, expired, revoked or rejected; `state` says which) → view 4 (決裁箱につなぐ) |
| 409 | `conflict` (`decision` = latest ViewDecision) | the amended banner; replace the screen |
| 409 | `answer_on_device` (a490j) | a decision the hosted daemon holds (filed after PC_OFFER) is listed and read here, but it is answered, held and unheld on a device: show 「この決裁は、決裁箱のアプリで答えてください。」 on the card; no retry |
| 402 | `subscription_expired` | view 2 |
| 404 | `not_found` | drop it from the list; `by-task`: no block |
| 429 | `rate_limited` (`Retry-After`) | wait, same button |
| 503 | `unavailable` | view 3 (reconnecting) |
| 404 on the whole route | module not installed (older body) | view 9 |

The BellTeam session errors (401/403 from the gateway) are the app's own and are not mapped here.

## Auth and delivery of this contract

Same-origin Owner session through the web-gateway mount, like `/api/lattice/*`; Cloudflare Access on the public host. The module child is reached through the body mount that Molly wires (README R5). Nothing in this contract is served yet: until the child exists, tests use [fixtures/](fixtures/) as canned responses.
