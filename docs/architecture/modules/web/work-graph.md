# Web 相関図 (work graph page)

Owner: Admi (Web). Data and motion are not decided here: the data contract is [work-graph](../work-graph/README.md#public-contract) (Arc Ranger Black) and what the user sees is the shared [behavior and visual spec](../work-graph/behavior-spec.md) (main 6b1f2570; layout revised a438f2e2; tap to open a chat 9d94cad6; steady chips 05a6490c). This file maps that spec onto Web code. Requested by the Owner via Trony, 2026-11-08.

## Function map

```mermaid
flowchart TD
  Nav["roster header: 予定 / ゴール / 相関図 buttons<br/>(設定 stays the owner mark)"] -->|open| View["work-graph.js createWorkGraphView<br/>full-screen dialog, canvas, overlays"]
  View -->|"fetch GET /api/work-graph/events (stream reader)"| Stream["stream loop<br/>SSE frames, 35 s silence = drop,<br/>backoff 0,1,2,4,8,15… ±20%"]
  Stream -->|snapshot / change| Model["work-graph-model.js createGraphModel (pure)<br/>epoch+version check, diff, enter/leave/start/end times"]
  Model -->|"false = gap / new epoch"| Stream
  View -->|requestAnimationFrame| Step["model.step(dt, rect)<br/>forces, collision, bounds, heat α"]
  Step --> Draw["draw: edges → nodes → labels<br/>flow dots, blink ring, chips"]
  Model --> A11y["offscreen list: node / edge texts"]
  View --> Pills["status pill: 再接続中… / 一部の情報を取得できていません /<br/>データを読み込めませんでした。再接続中…"]
  View --> Empty["empty: いま動いているメンバーはいません<br/>404: 相関図はこのサーバーではまだ使えません"]
  Draw -->|"Image /api/bots/:id/avatar?v=avatarVersion"| Avatars["browser image cache; empty version = initial on accent"]
  View -->|"tap / click on a node, or Enter/Space on its list button"| Tap["nodeAt(frame, x, y): botId fixed at press<br/>&lt; 10 px, &lt; 500 ms, primary button"]
  A11y -->|"button, hint チャットを開く"| Tap
  Tap -->|"onOpenMember(botId)"| App["application.js: exit browser full screen,<br/>close the 相関図 dialog"]
  App -->|"notifications.open({botId}) (memory only)"| Route["notification route (web-push.md)<br/>EDITOR_OPEN / not found notices, selectBot"]
```

| Function | Input -> output | Owner |
| --- | --- | --- |
| `createGraphModel()` | `snapshot(data, now)` replaces/diffs (throws on unknown schema); `change(batch, now)` -> `true` applied, `false` reconnect; `step(dt, rect, now)`; `frame(now, rect)` -> draw list (positions, opacities, label rects with their wrapped lines) | `web/work-graph-model.js` (pure, no DOM) |
| Edge label chip (main 180ec7ba, b5c4ea64) | `wrapLabel(text, 168, measure)` -> every line, never truncated (breaks at a space when the line has one, else per character); chip `w = min(180, widest line + 12)`, `h = lines × 16 + 6`; the placement tries `t = 0.5 … 0.7` with this grown box against discs + 4 pt and (main b5c4ea64) every chip already placed + 4 pt; chips are placed in edge start order (`startedAt`, then arrival, then id), so a placed chip does not jump when a newer edge arrives; slot keeping and `blocked` per the next row (05a6490c); a chip waiting for a slot is drawn on hover at `t = 0.5` after all other chips (on top) | same file; the view draws each line, no truncation |
| Chip visibility and slot (main 05a6490c) | decided once per edge at the first frame with a non-null `label` whose two ends have finished their enter animation (700 ms; 200 ms with Reduce Motion), so a snapshot edge (open, reconnect) is not judged on fly-in positions (reading sent to Black), kept on the model's edge as `edge.chip {mode, since, t, appearAt, nullAt, lines}`: `brief` if > 10 open edges or the path < 120 px at that frame (3 s from `since`, 400 ms fade, then hover only, never back by itself), else `shown` (fades in over 200 ms when first placed, stays until the edge ends, fading with the line). Text change re-wraps only; `label` back to null fades 300 ms and frees the slot. Placement in edge start order: a chip with no `t` takes the first free slot (else waits undrawn; after a wait it fades in over 200 ms; a brief chip whose window ends first is never drawn); a chip keeps its `t` while free, else moves to the first free one, else stays at its `t` as `blocked` (only allowed overlap). Free = no disc + 4 and no earlier placed chip + 4. `frame()` returns `blocked` (drawn after edges, before nodes) and `labels` (after names; the hovered chip last, on top). A brief chip frees its slot after its fade | `web/work-graph-model.js`; `web/work-graph.js` draws the two lists |
| Edge text (offscreen list, main 173c5aab) | `edgeText(edge, names)` -> `AからBへ依頼: label`; `label` null or empty (summary not arrived yet) -> `AからBへ依頼` without the colon part, and no chip; `edge-update` fills it later | same file |
| Sizes, forces, label placement, blink, curves | numbers exactly as behavior-spec "Sizes", "Layout", "Enter", "Leave", "Blink", "Edges" | same file |
| Layout (main a438f2e2) | forces in `D`-normalized `(u, v)`: `kr = 0.005/n`, spring `0.02`, `L = min(0.7, 1.4/√n)`, span-following gravity per axis toward 0.5 with `nameHeight` 18; collision `S × 2.2` and bounds in px (bounds keep the name width `S × 2.2` inside `D`, so narrow phones fill the x axis a little less than layout-sim.mjs) | same file; checked against `layout-sim.mjs simulate()` in the test |
| `createWorkGraphView(dialog, {fetch, reduceMotion})` | `open()` starts stream + rAF; `close()` aborts stream, cancels rAF and timers | `web/work-graph.js` |
| Stream loop | `fetch('/api/work-graph/events')`; non-OK, bad JSON, unknown schema -> unreadable pill; 404 -> "not on this server" state; socket end/error or 35 s silence -> 再接続中…; every case retries with the backoff while open; hidden tab closes the stream and reconnects on return | same file |
| Hover | hit order node (`nodeAt` area) > unblocked chip > blocked chip > edge path -> that node name / that edge label shown on top; a pointer cursor over a node. Hover never opens anything | same file |
| `nodeAt(frame, x, y)` (main 9d94cad6) | -> `botId` or `null`: a drawn name box, else the avatar square grown to at least 44×44 px (last drawn wins for names and for avatars); leaving nodes still count; edges, chips and empty space -> `null` | `web/work-graph-model.js` |
| Tap / click | `pointerdown` (primary button) records `nodeAt` and the point; `pointerup` of the same pointer within 10 px and 500 ms calls `onOpenMember(botId)` with the botId recorded at press, even if the node left or the graph changed meanwhile; `pointercancel`, a move ≥ 10 px at any time during the press (an excursion that comes back still cancels) or a longer press do nothing | `web/work-graph.js` |
| Offscreen node buttons | each node in the offscreen list is a `<button>` (text `nodeText`, `aria-describedby` hint チャットを開く); Enter/Space -> `onOpenMember(botId)`; a focused button keeps focus across list refreshes | same file |
| Open the chat | `onOpenMember(botId)`: `document.exitFullscreen()` if in browser full screen, close the dialog, then `notifications.open({kind:'member', botId, roomId:null, requestId:null, messageId:null})` -> the existing notification `onRoute` (GET `/api/bots/:id`, `selectBot`). The tap route stays in memory only (no sessionStorage / URL) | `web/application.js`, `web/notification-navigation.js` |

Nav: the header order becomes 予定 / ゴール / 相関図, then search and add. 設定 stays the owner mark at the left of the header (Web has no tab bar).

Drawable rect `D`: the dialog body below its header, minus 24 px on every side. Base avatar side `S0` = 64 px when the viewport is ≥ 1024 px wide (like Mac), else 56 px. Name font 15 px / 700 (list name), label 12 px (list detail).

## Data ownership

The view holds only in-memory drawing state (nodes and edges by id, positions, timers, the last epoch/version). Nothing is stored. The server stays the source; a reconnect always starts from a fresh snapshot.

## Failure handling

| Failure | Shown | Exit |
| --- | --- | --- |
| Socket end / error / 35 s silence | last graph kept, nodes 40 % saturation, no blink, no dots; pill 再接続中… | backoff reconnect, fresh snapshot diffed in |
| HTTP error (503 `WORK_GRAPH_UNAVAILABLE`, 500), bad JSON, unknown schema, version gap | last graph kept; pill データを読み込めませんでした。再接続中… (gap: 再接続中…) | same backoff, never stops while open |
| 404 (older body without the route) | centered 相関図はこのサーバーではまだ使えません | same backoff; the page works again after the body update |
| `degraded` non-empty | live graph; pill 一部の情報を取得できていません | cleared by a batch with empty `degraded` |
| Tap on a deleted Bot / route failure / another dialog open | the notification route's own notice (通知の対象を開けませんでした… / 入力中の画面があります…); the graph adds no error | the notice's 再確認 retries the held route; dismiss clears the notice |

No guard: nothing is refused or stopped; closing the dialog is the only end.

## Tests

`test/web-work-graph.test.mjs`: model (snapshot diff, version/epoch gap -> false, unknown schema throws, sizes, forces keep nodes in `D` and apart, label placement avoids discs, crowded rule, blink phase, a11y texts, `nodeAt` hit area) and the view's stream parser/backoff with a fake fetch.
