# Reply to a chosen message (`reply_to`)

Owner of this page: N102 (conversation). [Module contract](README.md) / [function map](../../feature-map.md) / [delivery](delivery.md) / [rooms](rooms.md) / [history display](flow.md).

Status: contract and diagrams for chart tasks `a264-n102-reply-contract` (whole-message reply, merged #1713) and `a273-n102-quote-range-contract` (reply to a selected part, section [Quoting a selected part](#quoting-a-selected-part)). Source is written by `a265-n102-reply-impl` from this page; clients (`a269`–`a272`) and the lab/ship tasks start from it. Nothing below is implemented yet.

Origin: Owner 2026-11-16 JST (21:2x; the selected-part addition 21:4x: 「テキストを範囲選択して。その範囲の文章に対する返信みたいな感じ。」「ではそれも実装してください」) (「そうだそれだ。計画立てて実装してくれ。」): pick one message in a conversation and reply to it, like LINE or Slack. The sent reply shows the original as a small quote, tapping the quote jumps to the original, and the Bot is told which message the reply is about, so it cannot mistake the topic after the conversation has moved on.

Base read: `main` a1a98ae9 — `src/messenger.mjs` (`prepareUserTurn`, `userEnvelope`, `directEnvelope`, `record`), `src/durable-message-receipts.mjs` (`receive`, `enqueueUserTurn`), `src/direct-receipt-assembly.mjs` (`dispatch`), `src/room-messenger.mjs` (`sendRoomMessageInOrder`, `roomEnvelope`), `src/conversation-store.mjs` (`messageItem`, `interimItem`), `src/room-history.mjs` (`project`), `src/conversation/{requests,dispatcher}.mjs`, `src/conversation-facade.mjs`, `src/http-conversation-api.mjs`, `src/http-room-api.mjs`, `src/direct-log-record.mjs`.

## Scope

- In: the Owner's direct conversation with a Bot, and rooms. One reply names exactly one earlier message of the same conversation.
- Also in: a reply may name a selected part of the original's text ([Quoting a selected part](#quoting-a-selected-part)). A reply without a selection is exactly the whole-message reply below.
- Out (v1, additive later): a Bot replying to a message through `sendmessage` / `sendroommessage` (those tools keep their closed input); replying to a Bot↔Bot `peer` row, a secret/question card, or a call row; quote chains (a quote never shows the original's own quote); editing or deleting a sent reply; an `around=<id>` page query (see [Jump](#jump-to-the-original)).
- The prompt text is assembled here (`userEnvelope`, `directEnvelope`, `roomEnvelope`) and handed to execution as one opaque string. Execution (`transport.turn` / `notify`) and the queue items are unchanged, so no agreement with Kiro is needed. The queue item `message` stays the reply's own text.

## Names (do not mix)

| Name | Meaning | Change |
| --- | --- | --- |
| `reply_to` | NEW. The message this one replies to. Request body, saved record, history item. | added |
| `in_reply_to` | Direct record only: a fork answer relayed for an `ask_readonly` delivery ([fork-inquiry](fork-inquiry.md)). Never projected to clients. | none |
| `responseTo` | Room post only: the idempotency key of a responder's `respond_to_room` answer ([rooms](rooms.md)). | none |
| `reply_id` (result of a turn) | The id of the Bot's saved final answer. | none |

## Contract

### Request

`POST /api/bots/{botId}/messages` and `POST /api/rooms/{roomId}/messages` accept one optional field next to `message` / `images` / `targets`:

```json
{ "message": "それは違います", "reply_to": "<id of the original item>" }
```

- `reply_to` is the `id` of an item the client received from `GET .../messages` of the same conversation (direct: `delivery_id` / interim id; room: message `id`).
- Valid: a non-empty string of at most 200 characters without NUL. Anything else (number, array, empty string, too long) → HTTP 400 `REPLY_TO_INVALID`, nothing saved, nothing delivered.
- An id that is valid but cannot be used is **not** an error: see [Original not available](#original-not-available).
- The response is the existing acceptance object; it gains no field. A client shows its own pending quote until the history item arrives.
- Only the Owner's posts carry it. `sendmessage`, `sendroommessage`, `ask_readonly`, call bridge and scheduler posts neither accept nor save it.

### What can be quoted

| Conversation | Quotable originals | Not quotable |
| --- | --- | --- |
| Direct (Owner ↔ Bot) | rows shown as `kind: "message"` (the Owner's sends, the Bot's sends to the Owner, a saved final answer) and `kind: "interim"` (the Bot's in-turn words) | `peer` rows, secret/question cards |
| Room | any room message of that room (`bellteam.room-message.v1`, kind `message` or `schedule`) | status/routing rows, cards |

A row of another conversation, an unknown id and a quotable id whose row cannot be read all count as [not available](#original-not-available).

### Saved record (additive)

`reply_to` is saved once, on the new row, as a snapshot taken when the reply is accepted. It is never rewritten, so the quote and the prompt always agree and survive a restart or a held/requeued delivery.

```text
reply_to := { id, available: true,  sender: {id, name}, at, text, truncated?, image? }
          | { id, available: false }
```

| Field | Rule |
| --- | --- |
| `id` | the requested id, unchanged |
| `available` | `true` only when the original was found in this conversation at acceptance |
| `sender` | `{id, name}` of the original's sender (`user` for the Owner; the Bot or room member otherwise) |
| `at` | the original's own timestamp (ISO, as saved) |
| `text` | the original's text, CRLF→LF, cut to at most 300 Unicode code points |
| `truncated` | `true` only when `text` was cut (clients add the ellipsis) |
| `image` | `true` when the original carried images (an image-only original has `text: ""`) |

- Direct rows: `bellteam.direct-message.v1` gains optional `reply_to` (`validateDirectLogRecord` allows it). Room rows: `bellteam.room-message.v1` gains optional `reply_to`. A row without the field is exactly today's row.
- `bellteam.delivery-status.v1`, interim words and routing/delivery status rows never carry it.

### History (read)

Every place that projects the saved row to a client returns the field unchanged and untouched by later events: the history page (`GET /api/bots/{id}/messages`, `GET /api/rooms/{id}/messages`) and the export built from the same projection. SSE payloads stay topic + target ids only.

- Direct: `messageItem` (`kind: "message"`, direction `outgoing`) adds `reply_to`. Rows that cannot carry it (`interim`, `peer`, answers) are unchanged.
- Room: `RoomHistory.project` already returns the saved row, so `reply_to` passes through.
- An item without `reply_to` has no key. Clients treat a missing key as "not a reply".

### Original not available

The reply is accepted and delivered like any message; only the quote degrades.

| Cause | Saved | Client shows | Bot is told |
| --- | --- | --- | --- |
| id unknown, other conversation, not quotable, or the read failed | `{ id, available: false }` | 「元のメッセージを表示できません」, not tappable | it is a reply to an earlier message that could not be found (with the id) |

Nothing about the other conversation (existence, text, sender) is returned or saved.

### The quote is served as plain text (a471-quote-plain-server)

Tronie's ruling 2026-11-21 11:0x JST: the quote line shows raw Markdown marks (`**` and the like) on all five clients, because each draws `reply_to.text` as it is. The server now serves `reply_to.text` as plain readable text on every read (`webMessage`, `plainQuoteText`), so old replies are fixed too and no client changes. Removed: emphasis (`**`, `__`, `*`, `_`, `~~`), inline code backticks and the fence lines of code blocks (the code stays), heading `#`, blockquote `>`, list markers (`-`, `*`, `+`, `1.`, `1)`), links `[t](u)` to `t` and images `![alt](u)` to `alt`. Line breaks stay. Snake_case words, a lone `*` and `2*3*4` stay as they are. What is saved is unchanged: the snapshot on the row, `range` (it refers to the original's own text), what the Bot reads (`replyNotice`), and copy and forward of the original message, which keep the original text.

```mermaid
flowchart LR
  Saved["saved row: reply_to.text as selected (raw)"] --> Serve["webMessage: plainQuoteText"]
  Serve --> Apps["five clients draw reply_to.text as served"]
  Saved --> Bot["replyNotice: Bot reads the saved text"]
```

### Jump to the original

The quote carries `id`. A client scrolls to the item with that `id` when it is loaded; otherwise it loads older items with the existing `before` cursor until the id appears or `has_more` is false, and then shows 「元のメッセージは見つかりません」. shortcut: no server-side jump query in v1, upgrade to `around=<id>&limit=N` when long conversations make the paging visible.

### What the Bot reads

Existing text is unchanged when `reply_to` is absent. When present, this block is inserted between the "from" line and the message text, in both envelopes.

Direct (`userEnvelope` → `directEnvelope`):

```text
「オーナー」からあなたへ次のメッセージが届いています。

これは次の発言への返信です。
返信先: 「N102」 2026-11-16 21:20 JST（メッセージID: <id>）
> 元の発言の1行目
> 2行目…

<message>
```

Room (`roomEnvelope`, same block after the `「sender」からあなたへ…` line; the `silent` suffix is unchanged):

```text
メッセージID: <this message id>
「オーナー」からあなたへ次のメッセージが届いています。

これは次の発言への返信です。
返信先: 「<sender>」 <JST time>（メッセージID: <id>）
> <quoted text>

<message>
```

- Time is JST `YYYY-MM-DD HH:mm JST` (the helper `jst` already in `messenger.mjs`). The Owner is written 「オーナー」 like the existing envelopes.
- Every quoted line starts with `> `; when `truncated`, the last line ends with `…`; an empty text with `image: true` is `> （画像）`.
- Not available: `これは過去の発言への返信ですが、元の発言は見つかりませんでした（メッセージID: <id>）。` and no quote.
- The block is built only from the saved snapshot, never from a fresh read, so a re-dispatch after a restart or `BOT_UPDATE_HOLD` sends the same text.

### Compatibility

- Additive. Released clients ignore the unknown key and show the reply as a normal message. A new client against an older server sends a field the server ignores; the history never gains `reply_to`, so the client shows no quote.
- No existing field, status, schema string or error changes. Rows written before this change have no `reply_to`.
- Release order (for a266/a268). The conversation child appends direct rows through the parent effect `direct.log.append`, and the parent checks every row with `validateDirectLogRecord` (`src/conversation/effects.mjs`), which refuses unknown keys. A child that writes `reply_to` against a parent without the new validator would have its Owner send refused (`DIRECT_LOG_RECORD_INVALID`). So the BODY carrying the validator must be live in the same train as, or before, the CONVERSATION module and the client change. Rolling the BODY back after rows with `reply_to` exist makes the old validator refuse only new appends of such rows; reads of saved rows are unaffected (`ConversationStore` and `RoomHistory` accept unknown keys).

## Quoting a selected part

The Owner selects part of a message's text and chooses 「引用して返信」. The reply quotes only that part; tapping the quote jumps to the original and highlights the part. Everything above holds for the whole-message reply; this section only adds to it, and a reply without `reply_quote` is saved, shown and delivered exactly as before.

### Request

```json
{ "message": "その点は賛成です", "reply_to": "<id>", "reply_quote": { "text": "選んだ部分の文章", "start": 12 } }
```

| Field | Rule |
| --- | --- |
| `reply_quote.text` | the selected text as the client has it; a string of 1..10000 characters with at least one non-whitespace character |
| `reply_quote.start` | optional hint: offset of the selection in the original's text, counted in Unicode code points (an astral character counts once). Send it only when the client knows the raw offset (a plain-text bubble); a client that renders markup omits it |
| presence | `reply_quote` without `reply_to`, a non-object, a missing/invalid `text` or a negative or non-integer `start` → HTTP 400 `REPLY_QUOTE_INVALID`, nothing saved |

The server never trusts the hint: it checks it against the original (below). The same two fields apply to `POST /api/bots/{id}/messages` and `POST /api/rooms/{id}/messages`.

### Saved record (additive to `reply_to`)

`reply_to.text` is the quoted part when a selection was sent, so a client that draws `reply_to.text` needs no other change. New optional fields:

```text
reply_to := { id, available, sender?, at?, text, truncated?, image?, part: true, range?: { start, end } }
```

| Field | Rule |
| --- | --- |
| `part` | `true` only when a selection was sent; the whole-message reply has no `part` |
| `text` | the selected text (CRLF→LF), cut to at most 300 code points; `truncated` as for the whole message |
| `range` | `{start, end}`: code points of the original's saved `message`, half-open, covering the whole sent selection (also when `text` was cut); present only when the part was found in the original |

Locating the part (once, at acceptance, only when the original is available and has text), in this order:

1. `start` is given and the original's code points `[start, start+n)` equal `reply_quote.text` exactly → `range = {start, start+n}`.
2. else the first occurrence of `reply_quote.text` in the original → its range.
3. else no `range`: the reply is still `available: true, part: true` with the selected text; the client jumps to the original without a highlight.

Original not available: the reply is saved as `{ id, available: false, part: true, text, truncated? }`. The excerpt is the Owner's own selection; nothing about the original is added or revealed.

### What the client draws

| State | Quote shows | Tap |
| --- | --- | --- |
| `available`, `range` | `text` (the part) | jump to the original, highlight `range` |
| `available`, no `range` | `text` | jump, no highlight |
| `available: false`, `part` | `text`, plus the fixed line 「元のメッセージを表示できません」 | none |
| `available: false`, no `part` | the fixed line only (whole-message rule above) | none |

`range` counts code points of the raw saved text. A client that shows rendered markup cannot map it and highlights by searching `reply_to.text` in the shown text instead; where the text occurs more than once it highlights the first hit at or after `range.start` when `range` exists.

### What the Bot reads

The block says which message and which part; the part is the same bounded `text`.

```text
これは次の発言の一部への返信です。
返信先: 「N102」 2026-11-16 21:20 JST（メッセージID: <id>）
引用した部分:
> 選んだ部分の文章
```

Original not available: `これは過去の発言の一部への返信ですが、元の発言は見つかりませんでした（メッセージID: <id>）。\n引用した部分（選択された文章そのまま）:\n> …`. Quoted lines, truncation (`…`) and JST time follow the whole-message block. Without `part` the whole-message block above is used unchanged.

### Compatibility and failures

- Additive: a client built on the whole-message shape shows the part as the quote (it draws `text`) and simply never highlights. A server that does not know `reply_quote` ignores the field and saves a whole-message reply; the client then sees no `part` in history and draws the original's start as for any whole-message reply.
- The direct-record validator (parent) learns `part` and `range` with `reply_to`, in the same BODY train as in [Compatibility](#compatibility).
- Failures: malformed `reply_quote` → 400 `REPLY_QUOTE_INVALID` before anything is saved; a selection that is not found in the original, an unreadable original or another conversation's id never refuse the post.
- shortcut: matching is exact on the raw text (no CRLF, width or markup normalization), upgrade to normalized matching if clients report selections that never locate.

```mermaid
flowchart LR
  Select["Owner selects text, 引用して返信"] --> Send["POST {message, reply_to, reply_quote{text, start?}}"]
  Send --> Check["HTTP: shape check, 400 REPLY_QUOTE_INVALID"]
  Check --> Resolve["Messenger / RoomMessenger: original row of the same conversation"]
  Resolve --> Locate["locateQuote: hint, then first occurrence"]
  Locate --> Snap["snapshotReply: text<=300, part:true, range?"]
  Resolve -->|"not usable"| Snap
  Snap --> Row["row.reply_to"]
  Row --> Notice["replyNotice: part block"]
  Row --> History["history item reply_to: draw text, jump, highlight range"]
```

## Function map

New/changed items are marked. Everything else is today's code.

```mermaid
flowchart TD
  subgraph Clients["Web / Apple / Windows / Linux (a269-a272)"]
    Pick["pick an item, send {message, reply_to}"]
    Draw["draw quote from item.reply_to, tap = jump by id"]
  end
  subgraph Http["http-conversation-api / http-room-api"]
    Val["CHANGED validate reply_to (string, 1..200, no NUL) -> 400 REPLY_TO_INVALID<br/>and reply_quote {text, start?} -> 400 REPLY_QUOTE_INVALID"]
  end
  subgraph Ipc["conversation facade / child"]
    Fac["CHANGED conversation-facade user() and room post pick reply_to"]
    Req["CHANGED requests.mjs: user.post, user.turn, room.post allow optional reply_to (id)"]
    Disp["dispatcher passes params unchanged"]
  end
  subgraph Direct["direct path"]
    Recv["CHANGED DurableMessageReceipts.receive: allowed key reply_to,<br/>resolve snapshot before saveReceipt"]
    Prep["CHANGED Messenger.prepareUserTurn (legacy/onboarding path): same resolve"]
    Rec["CHANGED Messenger.record: optional reply_to field"]
    Env["CHANGED userEnvelope / directEnvelope: replyNotice(record.reply_to)"]
    Dsp["direct-receipt-assembly dispatch: passes record.reply_to to userEnvelope"]
  end
  subgraph Room["room path"]
    RM["CHANGED RoomMessenger.sendRoomMessageInOrder: resolve snapshot, save in record"]
    REnv["CHANGED roomEnvelope: replyNotice(record.reply_to)"]
  end
  subgraph Reply["NEW src/reply-reference.mjs"]
    Valid["validReplyTo(value)"]
    Snap["snapshotReply(id, source, quote) -> reply_to snapshot (300 cp, part, range)"]
    Locate["locateQuote(originalText, quote) -> range | none"]
    Notice["replyNotice(reply_to) -> prompt block"]
  end
  subgraph Lookup["lookup of the original (read only)"]
    SQ["NEW ConversationStore.quoteSource(botId, id)"]
    RQ["NEW RoomRegistry.quoteSource(roomId, id) via RoomHistory.byId"]
  end
  subgraph Read["history projection"]
    MI["CHANGED conversation-store messageItem: reply_to"]
    RP["RoomHistory.project: passes saved row (no change)"]
    WM["webMessage: unchanged, copies keys"]
  end
  Pick --> Val --> Fac --> Req --> Disp
  Disp --> Recv & Prep & RM
  Val --> Valid
  Recv & Prep --> SQ --> Snap
  Snap --> Locate
  RM --> RQ --> Snap
  Snap --> Rec
  Snap --> RM
  Rec --> Env
  Dsp --> Env --> Notice
  RM --> REnv --> Notice
  Rec --> MI --> WM --> Draw
  RM --> RP --> WM
```

Public surface after the change: the two HTTP POST bodies gain `reply_to`; history items gain `reply_to`; the module exports `reply-reference` helpers. No MCP tool, SSE event, queue item, status or execution port changes.

## Data flow

```mermaid
flowchart LR
  Owner["Owner client"] -->|"POST {message, reply_to}"| HTTP["HTTP handler: shape check only"]
  HTTP -->|"reply_to id"| Child["conversation child: Messenger / RoomMessenger"]
  Child -->|"read by id, same conversation only"| Source["direct-messages.jsonl view / room messages view"]
  Source -->|"original row"| Child
  Child -->|"snapshot {sender, at, text<=300, image?}"| Row["new row with reply_to"]
  Row -->|"append, fsync"| Log["logs/direct-messages.jsonl or rooms/ID/messages.jsonl"]
  Row -->|"replyNotice(snapshot) + body = one string"| Transport["execution transport.turn / notify"]
  Transport --> Bot["Bot turn"]
  Log -->|"project, reply_to unchanged"| Page["history page / export"]
  Page --> Owner
```

| Datum | Owner / writer | Readers | Lifetime |
| --- | --- | --- | --- |
| `reply_to` request id (+ `reply_quote`) | client; HTTP handler checks the shape | Messenger / RoomMessenger | one request; never stored as a bare id without a snapshot |
| `reply_to` snapshot | the Messenger that accepts the reply, once | history projection, envelope builders, re-dispatch after restart | as long as the row; immutable |
| original row | unchanged (append-only log) | `quoteSource` (read only) | untouched |

The snapshot is the only copy of the quoted text (the whole-message text or the selected part). Nothing resolves an id again at read time, so history never joins across rows and an original that disappears (log repair) cannot break a reply.

## Failure handling

| Situation | Result |
| --- | --- |
| `reply_to` not a valid string | 400 `REPLY_TO_INVALID` before anything is saved |
| `reply_quote` malformed or sent without `reply_to` | 400 `REPLY_QUOTE_INVALID` before anything is saved |
| selected part not found in the original / original unavailable | accepted; `part` and the sent text are saved, `range` only when found ([Quoting a selected part](#quoting-a-selected-part)) |
| original not found / other conversation / not quotable / lookup error | message accepted, `reply_to = {id, available:false}`, Bot told the original was not found |
| lookup slower than the send | resolution reads the store snapshot already used for the send; no extra wait is added |
| process stops after save, before dispatch | re-dispatch rebuilds the envelope from the saved row, same text |
| `BOT_UPDATE_HOLD` / queued delivery | unchanged; the saved snapshot is dispatched later |
| parent without the new `validateDirectLogRecord` receives a direct row with `reply_to` | the append is refused as `DIRECT_LOG_RECORD_INVALID`; prevented by the release order in [Compatibility](#compatibility), not by a guard in the child |

No guard is added: no new refusal, lock or timeout. The only refusal is the malformed field, which protects the log from a non-string id.

## For a265 (implementation) and the lab

Touch only: `src/reply-reference.mjs` (new; `locateQuote` for the selected part), `src/messenger.mjs` (`prepareUserTurn`, `record`, `userEnvelope`/`directEnvelope`), `src/durable-message-receipts.mjs` (`receive` allowed keys, `enqueueUserTurn`), `src/direct-receipt-assembly.mjs` (`dispatch` envelope call), `src/room-messenger.mjs` (`sendRoomMessageInOrder`, `roomEnvelope`), `src/conversation-store.mjs` (`quoteSource`, `messageItem`), `src/room-registry.mjs` / `room-history.mjs` (`quoteSource`), `src/direct-log-record.mjs` (parent-side validator: optional `reply_to`), `src/conversation/requests.mjs`, `src/conversation-facade.mjs`, `src/http-conversation-api.mjs`, `src/http-room-api.mjs`, plus this module's `module.json` source list. Minimal checks, by the diagrams:

1. direct: replies to an Owner row, a Bot row and an interim row save the snapshot, the envelope contains the block, and the history item has `reply_to`.
2. room: same for a member message and a schedule message.
3. unavailable: unknown id and an id of another Bot's/room's conversation save `{id, available:false}` and expose nothing of the other conversation.
4. invalid `reply_to` → 400 `REPLY_TO_INVALID`, no row, no delivery.
5. text cut at 300 code points (astral characters counted once) sets `truncated`.
6. re-dispatch of a saved queued row yields the same envelope.
7. rows without `reply_to`: existing tests unchanged.
8. selected part: found by hint, found by search (first occurrence), not found (no `range`, still saved with `part`), cut at 300 code points with `range` covering the whole selection, astral characters counted once.
9. selected part with an unavailable original saves `{id, available:false, part:true, text}` and the prompt says so.
10. malformed `reply_quote` (no `reply_to`, empty text, bad `start`) → 400 `REPLY_QUOTE_INVALID`, nothing saved.

Client rules for `a269`–`a272`: draw the quote only from `item.reply_to` (its `text` is already the selected part for a part reply; see [What the client draws](#what-the-client-draws)); when `available` is false draw the fixed 「元のメッセージを表示できません」 line; never compute the quote from loaded items; tapping uses `reply_to.id`; send `reply_to` only for a picked item of the open conversation.
