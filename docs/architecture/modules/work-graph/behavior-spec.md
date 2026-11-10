# 相関図: behavior and visual spec

Shared by all three native drawings so the motion matches: Apple first (SwiftUI, Bell), then Web (Admi) and Windows (Bell). Data comes only from the [work-graph contract](README.md#public-contract). The page owners decide their own code; this file fixes what the user sees.

Units: `pt` = SwiftUI points = CSS px = WinUI effective pixels. Times in milliseconds unless noted.

## Page and navigation

- Name `相関図`. Nav order: 予定 / ゴール / 相関図 / 設定.
- Uses the whole app content area. iPhone/iPad: a full-screen page in the nav. Mac: opens its own window (SwiftUI `WindowGroup(id: "work-graph")` + `openWindow(id:)`), resizable, minimum 480×360 pt.
- Background: the app background (Apple `BellBackground`).

## Data handling

1. Open `GET /api/work-graph/events`. The first `snapshot` replaces the drawn graph.
2. Apply each `change` batch in order when `epoch` matches and `version == last + 1`. Anything else (gap, new epoch, parse error) → reconnect.
3. On a fresh snapshot after a reconnect, diff it against the drawn graph by `botId` / edge `id` and animate the difference like normal changes. Nodes that exist in both keep their positions.
4. Avatars: `GET /api/bots/:id/avatar?v=<avatarVersion>` through the app's existing avatar cache. Empty version → initial letter on the accent color (Apple `AvatarView`).

## Rendering on SwiftUI

- One `TimelineView(.animation)` drives one `Canvas`. Each frame: step the simulation by the real frame `dt` (clamped to 1/30 s), then draw edges, then nodes, then labels.
- Avatars as Canvas symbols: `Canvas { … } symbols: { ForEach(nodes) { AvatarView(…).tag(botId) } }`, drawn with `context.resolveSymbol(id:)`.
- Simulation state lives in one reference model (`@Observable final class`) outside the view body, keyed by `botId`, so a SwiftUI re-render never resets positions.
- Web: one `<canvas>` + `requestAnimationFrame`. Windows: `CompositionTarget.Rendering` or a Win2D canvas. Same numbers below.

## Colors

| Use | Apple `BellTheme` | Hex |
| --- | --- | --- |
| Node accent / ring / edge | `accent(node.color)` | violet #6147D4, rose #E86B94, indigo #4559C2, sky #47A1E3, mint #2EB29E, amber #E89E47 |
| Name text | `ink` | #21293D |
| Edge label, empty state, status pill text | `muted` | #787D91 |
| Edge base line (behind the flow) | `line` | #E6E3F0 |
| Label chip fill | `canvas` at 0.92 | #F8F8FB |
| Status pill fill | `violetLight` | #E8E0FF |

Unknown `color` names fall back to violet.

## Sizes

Revised 2026-11-08 after the Owner watched the Apple drawing (#665): 「ノード同士が近すぎた」「画面いっぱいうまく使った方がいい」「登場人物が増えすぎたら小さくする」.

- Drawable rect `D` (width `W`, height `H`): the full content area from top to bottom, minus safe-area insets, minus the nav/tab bar, minus 24 pt padding on every side. The layout center is the center of `D`, not of the window.
- Base avatar side `S0`: 56 pt (Mac 64 pt). Above 12 nodes `S12 = S0 × sqrt(12 / n)`, else `S12 = S0`.
- Node avatar side `S = max(36, min(S12, sqrt(W × H / n) × 0.3))`, so many members shrink to fit the area. Rounded rect corner `S × 0.31` as `AvatarView`.
- Name under the avatar: 1 line, `listNameFontSize`, ink, truncated at `S × 2.2` width.

## Layout: force-directed, normalized to the drawable rect

Revised 2026-11-08 after the live production Web run (1440×900): with forces scaled by the short side `m`, a wide screen left empty bands left, right and on top (Trony, Admi). The Owner asked 「画面いっぱいうまく使った方がいい」. The layout now fills **both axes** of `D` at any aspect ratio.

Positions are simulated in normalized coordinates `u = (x − D.minX) / W`, `v = (y − D.minY) / H`, both in `[0, 1]`, center `(0.5, 0.5)`. Distances `d` for repulsion and springs are measured in `(u, v)`. Collision and bounds are measured in points. Drawing maps back with `x = D.minX + u × W`, `y = D.minY + v × H`.

Every frame, each node `i`:

| Force | Rule (normalized units) | Parameter |
| --- | --- | --- |
| Repulsion | every pair, `F = kr / d²` along the pair, `d ≥ 0.01` | `kr = 0.005 / n` |
| Spring | each edge, `F = ks × (d − L)` | `ks = 0.02`, `L = min(0.7, 1.4 / √n)` |
| Span-following gravity, per axis | `Fu = gu × (0.5 − u)`, `Fv = gv × (0.5 − v)` | `gu = 0.02 × clamp((spanU / 0.88)^16, 0.001, 50)`, likewise `gv` with `spanV` |
| Collision (points) | if `d < S × 2.2`, push both apart to `S × 2.2` | hard constraint |
| Bounds (points) | clamp so the whole node (disc and name) stays inside `D` | hard constraint |

`spanU = max(u) − min(u) + S / W` and `spanV = max(v) − min(v) + (S + nameHeight) / H`, over all non-leaving nodes, recomputed each frame. Gravity weakens when an axis is under 88 % filled and strengthens when it is over 88 %. So each axis settles near 88 % for any `n` and any aspect ratio, without a fixed center pull or a hard boundary press. `nameHeight` is the name line height (Apple `listNameFontSize` line, 18 pt on iPhone).

Integration: `vu = (vu + Fu × α) × 0.82`, `vv = (vv + Fv × α) × 0.82`, then `u += vu × (dt × 60)`, `v += vv × (dt × 60)`. Cap the speed in points: if `hypot(vu × W, vv × H) > 14`, scale both down to 14 pt per frame-equivalent.

`α` (heat): set to 1 on every applied change batch or window resize, then `α = max(0.04, α × 0.985)` each 1/60 s. The floor 0.04 keeps the layout drifting gently, so it re-arranges by itself and never freezes. Node pairs connected in both directions (A→B and B→A) count as one spring.

### Uncrossing swaps

Added 2026-11-10 after the Owner asked whether lines between members can avoid crossing each other. The forces above do not see crossings, so a layout can settle with edges crossing.

- Every 30 simulation frames (0.5 s), count the crossings of the current edges as straight segments between node centers in points. A→B and B→A count as one segment. Two segments that share a node never count as crossing. Leaving nodes and their (already gone) edges take no part.
- For every pair of non-leaving nodes where at least one has an edge, compute how many crossings would disappear if the two nodes traded places. Only segments touching one of the two nodes change, so count only those (`bestSwap()` in the simulation).
- If some pair removes at least one crossing, swap the simulated positions and velocities of the pair that removes the most (ties: the first pair in node order by `botId`). At most one swap per check. No swap when nothing improves, so a swap never adds a crossing at that moment. `α` is not changed.
- Drawing: each swapped node glides from its current drawn position to its new simulated position over 700 ms with the enter curve `cubic-bezier(0.2, 0.8, 0.2, 1)`, like Enter. Its edges and chips follow the drawn positions. A node that is still in its enter animation keeps its enter interpolation toward the new target.
- Crossings cannot always reach zero (for example, 5 members all connected to each other). The swaps reduce them to what single trades allow. Reference numbers, 5 runs each with `n` random edges among `n` members: Web 1440×900 n=10: 5.8 → 0.2, n=16: 12.2 → 0.4, n=24: 28.4 → 1.2; iPhone portrait n=16: 14.0 → 0.6. Fill of each axis is unchanged (table below). One check with 24 members and 36 edges takes about 5 ms in Node, so it runs on the frame thread.

### Clearance: edges and chips keep off other members

Added 2026-11-10 after Trony judged Apple 123: an edge ran over an unrelated member's avatar (レオナ→モリー over ソラ), and chips sat on member names (「依頼1の確認」 on ケイ). Goal: a request's line and chip stay off every member that is not part of that request, so every name and every request stays readable.

- Node box (points): the avatar disc's square plus the drawn name's text box under it (a hidden name does not count), both grown by `clearGap = 6` pt. Leaving nodes take no part.
- Every frame, for every edge (A→B and B→A once) and every non-leaving node C that is neither end:
  - Line: if the straight segment between the two node centers enters C's box, push C away from the segment's closest point to C's box center with force `kc = 0.003` (normalized units, same scale as the table above). The two ends take the opposite push, split by where the closest point lies (`1 − t` to the start, `t` to the end). If C's box center sits exactly on the line, push along the segment's normal.
  - Chip: if the edge's chip is blocked (see Chip placement) and its box at `t = 0.5`, grown by 4 pt, meets C's box (not grown), push C away from the chip's center with `kc`, the two ends taking half each.
- If a blocked chip's box also meets one of its own ends, push the two ends apart along the edge with `kc`, so the edge lengthens until a slot frees.
- These pushes join the table's forces before integration (`α` scales them like the rest). They do not change collision, bounds or the chip rules.
- The uncrossing swap counts each edge that runs through an unrelated node box (not grown) the same as one crossing, so a swap is also taken when it moves a member off a line.
- Every drawn name gets a 3 pt halo in the canvas color (a stroke behind the text, Web `strokeText` with `lineWidth 3` before `fillText`; SwiftUI the same text drawn offset in the canvas color or `.shadow` with radius 0 in 8 directions). An edge or a blocked chip that is still under a name (drawn below it by the drawing order) can no longer cut through its letters.
- Limit: when the screen has no room (for example 24 members and 24 open requests on an iPhone), some chips stay blocked. They follow the Owner's rulings as before: a drawn chip is never hidden, it stays below nodes and names, and it is read in full on hover or tap.

Reference, `node layout-sim.mjs` (5 runs each, `n` random edges among `n` members; "blocked chips" uses a 120×22 pt chip and the Chip placement slots, own ends included):

| Screen | n | Crossings | Edges through a member | Blocked chips |
| --- | --- | --- | --- | --- |
| Web 1440×900 | 16 | 12.2 → 1.0 | 2.2 → 0.0 | 0.0 → 0.0 |
| Web 1440×900 | 24 | 28.4 → 2.0 | 6.8 → 0.0 | 0.0 → 0.0 |
| iPhone portrait | 10 | 4.8 → 0.0 | 2.4 → 0.0 | 1.2 → 1.2 |
| iPhone portrait | 16 | 14.0 → 0.8 | 9.0 → 0.2 | 3.4 → 3.4 |

"Before" is the layout without uncrossing swaps and clearance; "after" has both. Both use the chip spots of Chip placement and keep chips inside `D` (values updated 2026-11-10 with the spots and the on-screen rule). Fill of each axis moves by at most 0.01.

Expected result, from the reference simulation [layout-sim.mjs](layout-sim.mjs) (`node layout-sim.mjs`; same constants as above, exported as `LAYOUT`):

| Members | Fill of each axis |
| --- | --- |
| 2 | 0.57–0.74 (the pair lies along a diagonal) |
| 3–4 | 0.83–0.86 |
| 8–30 | 0.89–0.94 |

This holds for Web 1440×900, a Mac window, iPhone portrait, iPad portrait and square, within ±0.02 across them. When members cannot fit at `S × 2.2` spacing (about 30 on an iPhone), the graph reaches the edges and the crowded shrink of `S` applies. App builders can port `simulate()` to check their implementation against these numbers.

The earlier values (`kr = 0.00009 × m³ × min(1, 6/n)`, `L = 0.38 × m`, gravity `0.004 × m / W` and `0.004 × m / H`) are replaced.

## Enter (member-enter)

- Spawn point: off screen, angle `θ = (FNV-1a hash of botId mod 360)°` from the canvas center, distance = half diagonal + `S`.
- Fly to its simulated position over 700 ms with `cubic-bezier(0.2, 0.8, 0.2, 1)` (SwiftUI: `.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.7)`); the simulation includes the node from frame one but drawing interpolates from the spawn point by that curve.
- Scale 0.6 → 1, opacity 0 → 1, same curve and duration.

## Leave (member-leave)

- Incident edges are already gone (contract order). Move outward along the ray from the canvas center through the node until off screen, 600 ms, `cubic-bezier(0.4, 0, 1, 1)`. Opacity 1 → 0 over the last 40%.
- The node no longer exerts forces once it starts leaving.

## Blink (state working)

- A ring around the avatar: stroke 3 pt at `S/2 + 5` pt outset, accent color.
- Opacity `0.25 + 0.65 × (0.5 + 0.5 × sin(2π × t / 1.6 s))`, with `t` measured from `activeSince`, so every app shows the same phase for the same member.
- Plus a soft glow: the same ring blurred 6 pt at half that opacity.
- `linked` nodes: no ring, no glow, avatar opacity 0.55, name in muted.

## Edges and the flow effect

- Draw from requester (`from`) to receiver (`to`), border to border of the avatars.
- Straight line; when the opposite edge also exists, bend both into quadratic curves with the control point offset 18% of the length to the left of travel direction, so they separate.
- Base: `line` color, 2 pt. Arrowhead at the receiver end: 10 pt, requester accent.
- Flow: dots of 3.5 pt radius in the requester's accent, spaced every 28 pt along the path, moving from requester to receiver at 90 pt/s (fixed speed, so longer lines take longer). Dots fade in over the first 10% and out over the last 10% of the path.
- `steered` edges: same flow at 0.75 opacity, plus the base line in the requester accent at 0.35.
- Edge start: the base line grows from requester to receiver over 350 ms ease-out, then dots start. Edge end: line and dots fade out over 300 ms.
- Label: when `label` is null there is no chip (the line and flow show alone until the summary arrives by `edge-update`). Otherwise `label` in a chip (fill canvas 0.92, corner 8 pt, padding 6×3 pt, `listDetailFontSize`, muted, max width 180 pt) near the path midpoint. The whole label is always shown: it wraps onto as many lines as it needs and is never truncated (Owner ruling 2026-11-09). The chip height grows with the lines (line height 16 pt).
- Every chip that has obtained a placement slot stays visible for the whole life of its edge, in any graph, crowded ones (more than 10 open edges) and short paths included (Owner 2026-11-09: 「札はずっと出しておこう」). A chip that finds no free slot waits undrawn until one frees; no slot is forced or reserved for it, and its hover/tap peek on the edge line (see Chip placement) is temporary (Owner 2026-11-09: 「札を出す空間がない時は諦める今の仕様でいいよ」). There is no `brief` state and no "3 s, then hover/tap only" chip. Production Web 15:58 showed every chip in a crowded graph vanishing after about 3 s, which the Owner rejected.
- Chip start is decided once per edge and then held, so a chip never blinks on and off (Owner 2026-11-09: 「依頼内容が表示されたり消えたりする」). The layout never stops drifting (α floor 0.04), so no per-frame check may hide a chip. The chip starts at the first frame where the edge has a non-null `label` AND both of its nodes have finished their enter animation (700 ms; Reduce Motion 200 ms; a leaving node counts as finished), so fly-in geometry never places it. Usually this is when the summary arrives, 10–30 s after `edge-start`; for edges in a snapshot, it is when their nodes have landed. Call that frame the latch frame. From then on the chip stays until the edge ends (300 ms fade with the line), whatever crowding or path length becomes.
  - A change of `label` text only re-wraps the chip. `label` back to null (not expected from the contract) removes the chip with a 300 ms fade.
- Chip placement. Obstacles are every node disc grown by 4 pt, every drawn name (its text box) grown by 4 pt, and every earlier chip grown by 4 pt (earlier = older edge start, placed first). A hidden name (see below) is not an obstacle, and neither is the disc or name of a node in its leave animation (Leave, 600 ms): it is already moving off screen and fading. A chip is placed at a slot that covers no obstacle.
  - Slots (revised 2026-11-10, Owner: 「線のある場所なら自由に札を移動でき、線のポイントの上下左右自由な位置に配置できるようにしたい」, goal: chips cover other chips and member icons as little as possible). A slot is a path position `t` and a side. Positions run over the whole drawn path, nearest the middle first: `t = 0.5, 0.45, 0.55, 0.4, 0.6, … 0.1, 0.9` (17). At each position the sides are tried in this order: centered on the path point; above it (the chip's bottom edge on the point); below it (top edge on the point); left of it (right edge on the point); right of it (left edge on the point). Up, down, left and right are screen directions, on straight and curved paths alike. So 85 slots, tried position by position. Before this revision the slots were centered only, at `t = 0.3 … 0.7`.
  - On screen (2026-11-10, Owner approved 「相関図で、画面の端からはみ出す札の置き場所を使わないように直すか」 → 直す, after the iPhone SE 24-member shot showed side chips cut at the screen edge). A chip is always drawn inside the drawable rect `D`. Before a slot is checked against the obstacles, its chip box, grown by 4 pt, is slid inward just enough to lie inside `D`, horizontally and vertically; a slot already inside does not move. The slid box still touches or covers its path point whenever that point is inside `D`. The slid box is then the slot's place for the obstacle check, for "keeps its current slot while free", and for drawing. The same slide applies to a blocked chip at its slot and to the hover/tap peek at `t = 0.5`. Edges, nodes, names and the clearance pushes are unchanged.
  - Reference for the on-screen rule (`node layout-sim.mjs`, same runs as below): chips drawn partly outside `D` → after: iPhone portrait n=10 2.2 → 0.0, n=16 4.4 → 0.0, n=24 5.8 → 0.0; Web 1440×900 0.0 → 0.0. Chips without a clear slot rise (n=10 1.6 → 3.0, n=16 6.0 → 7.6, n=24 16.4 → 21.8) because a cut chip used to count as placed; chips drawn whole and clear rise too (n=10 6.2 → 7.0, n=16 5.6 → 8.4, n=24 1.8 → 2.2). Skipping an outside slot instead of sliding it was measured and loses more chips (n=16 9.6, n=24 23.0 without a clear slot).
  - Only the place changes. Which edges have a chip, the latch frame, the 200 ms fade-in and fade-out, the hover/tap peek at `t = 0.5`, the blocked chip's drawing order and the clearance pushes (which still use the chip box at `t = 0.5`) stay as they are. With more slots a chip waits undrawn less often, so it usually appears at its latch frame.
  - Reference (`node layout-sim.mjs`, 5 runs, `n` random edges among `n` members, 120×22 pt chips, chips placed oldest first with earlier chips as obstacles): chips kept inside `D` (On screen), chips without a clear slot, centered `t = 0.3 … 0.7` → these slots: Web 1440×900 n=24 1.2 → 0.0; iPhone portrait n=10 4.2 → 3.0, n=16 10.8 → 7.6, n=24 22.4 → 21.8. A dense iPhone graph still has chips with no clear slot; they keep the rules below.
  - First slot: from the latch frame, the first free slot. Until one is free, the chip waits undrawn, then appears once with a 200 ms fade-in.
  - A waiting (undrawn) chip shows while its edge line is hovered (Mac/Web/Windows), or after a tap on its edge line until the next tap elsewhere (iPhone). It is drawn at `t = 0.5` above everything else, like any hovered chip, and goes back to waiting when the hover or tap ends (Owner 2026-11-09: 「線をタップしたら札が表示されるからそれでいいよ」).
  - Each frame a drawn chip keeps its current slot while that slot is free. When nodes, names or earlier chips drift into it, it moves to the first free slot.
  - Fallback when no slot is free: the chip stays at its current slot and is marked blocked. A blocked chip is drawn just above the edges and below every node, name and unblocked chip, so it never covers a node or a name; only other blocked chips may overlap it. It becomes unblocked as soon as a free slot exists and then moves there. A drawn chip is never hidden.
  - Hit testing, top first: node (avatar, name, 44×44 pt area, which opens the chat), then unblocked chips, then blocked chips, then edge lines. A chip under hover or tap is drawn above everything else while hovered or tapped, so a blocked chip can be read in full, but a press that starts inside a node's hit area always goes to the node.
- A name that would overlap another node's disc moves above its own avatar; if that overlaps too, it is hidden until hover (Mac/Web/Windows) or long-press on the node (iPhone). A tap on a node opens a chat instead (see below).

## Empty state

No nodes: centered text `いま動いているメンバーはいません` in muted, `listNameFontSize`, plus one soft accent circle (violet 0.08, 220 pt, blur 50) behind it. No animation. When the first member enters, the text fades out over 300 ms.

## Stream drop and recovery

- Drop = socket error/close, or 35 s without any byte (the server sends `: hb` every 15 s).
- Keep the last graph on screen. Stop blinking and flow dots, desaturate nodes to 40%, keep the layout drifting. Show a status pill at top center: `再接続中…` (muted text on violetLight, corner 12 pt).
- Reconnect immediately, then after 1, 2, 4, 8, 15, 15, … s (±20% jitter). Never give up while the page is open.
- On the new snapshot: remove the pill, restore color, and animate the diff (Data handling step 3).
- Non-empty `degraded`: keep the live graph and show the pill `一部の情報を取得できていません` until a batch arrives with empty `degraded`.
- Unreadable response (HTTP error such as 503 `WORK_GRAPH_UNAVAILABLE`, bad JSON, unknown schema): keep the last graph, show the pill `データを読み込めませんでした。再接続中…`, and reconnect with the same backoff. The client never stops retrying while the page is open.
- App backgrounded (iOS) or window hidden: close the stream; on return reconnect and diff.

## Accessibility and motion

- Reduce Motion: no fly-in/out (fade 200 ms in place, spawn at a free spot near the center), an uncrossing swap fades each node out and in at its new place over 200 ms instead of gliding, no blink (static ring at 0.8), flow dots replaced by the static arrow.
- Each node is an accessibility element with the button trait: `<name>、作業中、<n>分前から` (`linked`: `<name>、依頼の相手`), hint `チャットを開く`. Activating it (VoiceOver double-tap, keyboard Enter/Space on Web, Windows) does the same as a tap. Each edge: `<from>から<to>へ依頼: <label>`, or `<from>から<to>へ依頼` when `label` is null.

## Tap or click on a member: open that member's chat

Owner request 2026-11-09: 「相関図のキャラのアイコンをタップしたら、その子のチャットが開くようにしたいな。」

- Target: the avatar disc and the name of any drawn node, `working` and `linked` alike. The hit area is at least 44×44 pt even when `S` shrinks below 44 pt.
- A tap is a press and release that moves less than 10 pt and lasts less than 500 ms (Mac/Web/Windows: a primary click). A longer press on iPhone is a long-press and only shows the hidden name (see Edges). Hover never opens anything.
- The member is fixed at press time: the app records the node's `botId` when the finger or pointer goes down. On release it opens the direct chat with that `botId`, even if the graph changed in between.
- Opening reuses each app's existing route to one member's direct conversation, the same one a tap on that member's message notification uses (Apple `ConversationTarget.bot(botId)`, Web notification route). It is not a new screen. That route's own rules apply, such as Web keeping an unsaved input screen open and showing its notice.
- The chat opens in the same app. iPhone/iPad: the app leaves the full-screen 相関図 page and shows the member's chat, as if it had been opened from the member list; Back or the nav returns to 相関図, which reconnects and diffs (Stream drop and recovery). Web: the same, and if the graph is in browser full screen, exit full screen first. Mac: the 相関図 window stays open as it is. The main window comes to the front (opened if it was closed) with that member's chat selected.
- Member leaving during the tap: a node that is in its leave animation is still drawn and still tappable. If `member-leave` arrives between press and release, the chat still opens. Leaving the graph only means the member stopped working, and its chat still exists. If the Bot itself is gone (deleted), the chat route shows its usual "not found" handling. The graph adds no error of its own.
- Taps on an edge line, a label chip or empty space do not open a chat.
