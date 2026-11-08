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
- Label: `label` in a chip (fill canvas 0.92, corner 8 pt, padding 6×3 pt, `listDetailFontSize`, muted, max width 180 pt) near the path midpoint. The whole label is always shown: it wraps onto as many lines as it needs and is never truncated (Owner ruling 2026-11-09). The chip height grows with the lines (line height 16 pt).
- Labels and names never cover a node disc, and label chips never cover each other. Place chips in edge start order (oldest first, so a placed chip does not jump when a newer edge arrives). A chip may not intersect any disc grown by 4 pt nor any chip already placed grown by 4 pt: try path positions `t = 0.5, 0.45, 0.55, 0.4, 0.6, … 0.3, 0.7`; if none is free, the label is hidden (shown on hover/tap, drawn above everything else). A name that would overlap another node's disc moves above its own avatar; if that overlaps too, it is hidden until hover/tap.
- Crowded (more than 10 edges, or the path is shorter than 120 pt): only newly started edges show their label, for 3 s after `edge-start`, then fade out over 400 ms. All other labels show on hover (Mac/Web/Windows) or tap/long-press (iPhone).

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

- Reduce Motion: no fly-in/out (fade 200 ms in place, spawn at a free spot near the center), no blink (static ring at 0.8), flow dots replaced by the static arrow.
- Each node is an accessibility element: `<name>、作業中、<n>分前から` (`linked`: `<name>、依頼の相手`). Each edge: `<from>から<to>へ依頼: <label>`.
- Tap/click on a node: no action in this version.
