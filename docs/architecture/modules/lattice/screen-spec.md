# Lattice工程表: screen, user path and motion spec

Shared by all three native drawings: Apple first (SwiftUI, Rapi), Web (Flora), Windows (Anis). Data only from the [lattice contract](README.md#public-contract-apps). The visual reference is Flora's design mock (`/srv/bellteam/bots/bot-7e777fe5/docs/lattice-chart-screen.html`, accepted by Trony 2026-11-11). Owner 2026-11-11: the old Web-made chart looked cheap; use each platform's rendering to the full, and never pull the Apple design down to Web limits.

Units: `pt` = SwiftUI points = CSS px = WinUI effective pixels. Times in ms. User-facing text is Japanese and plain: no codes, reasons, ids or paths anywhere on screen (Trony ruling 2026-11-11).

## Screens

| Screen | Content |
| --- | --- |
| **一覧** (chart list) | Cards: chart name (rule below; never the project id), crown + 統括 on coordinator charts (pinned first), mini progress ring `done/total`, active member avatars, 待ち N. A non-tappable card 新しい工程表 says: 工程表はメンバーがLatticeでつくります。権限も参加登録もなく、誰でも開けます。 |
| **工程表** (chart) | Toolbar: chart switcher (chart name, 統括 badge), live pill, progress ring, counters 作業中 / 待ち / 止まり. Left: member rail (avatars; working = rotating accent arc; blocked = red dot; waiting = hourglass with count). Center: swimlanes per producer (lane label = member avatar + name; unassigned lane 担当なし), cards in columns by `depth`, edges as smooth curves. Right (Mac/iPad/Web wide): 待ちの流れ panel. |
| **待ちの流れ** | One row per `waits[]`, oldest first: waiter avatar + 「◯◯が待っている」, the awaited card title, 「つくっている」 producer avatar + name + state (作業中 N分 / 止まり: blockedReason / 未着手: 担当 ◯◯ / 担当なし), wait length. Buttons: 会話を開く, 工程へ移動. A row whose producer is blocked is emphasized. iPhone: these rows come first, as a horizontal card pager above the chart. |
| **詳細** (card detail) | Sheet over the chart: title, state badge + producer, 設計メモ (`designMemo`, Markdown as plain text), 終了条件, 前の工程 / 次の工程 with their states (tappable), 着手 time. No notes in v1. |

Chart name, everywhere a chart is named (list card, switcher, spoken labels): the snapshot/list `name`; if null, 「<作った人の名前>の工程表」 from `createdBy` and the app's own roster name; if that is unknown, 名前のない工程表. The project id is only an API address and never appears on screen or in a spoken label.

Card states (glyph, badge text): 未着手 `pending` (dashed outline, dashed circle), 着手可 `ready` (accent outline + soft glow, play), 作業中 `in-progress` (accent tint, producer avatar with rotating arc, elapsed minutes), 止まり `blocked` (warm red tint #E0533D, octagon exclamation, reason line), 完了 `done` (compact desaturated pill, seal check), 取り下げ `retired` (struck-through grey, archive). Edges: satisfied = thin faint line; waiting = thicker accent gradient from producer card to the waiting card, particles flowing toward the waiter, chip 「◯◯が待っています」.

Colors: BellTheme (Apple `BellTheme`, Web `:root` tokens, Windows theme): member accent by `color` (violet, rose, indigo, sky, mint, amber; unknown -> violet), ink, muted, line, canvas. Dark mode follows the platform.

## User path (state transitions)

Every button leads to exactly one next view; every failure view says what happened, what happens next, and what the user can do, and is left without a code.

| From | User action | Next |
| --- | --- | --- |
| App (Apple nav / Web header button `工程表` / Windows nav) | open | 一覧. If exactly one chart exists, 工程表 of that chart |
| 一覧 | tap a chart card | 工程表 of that chart |
| 一覧 | close (Web dialog ×, Mac window close) | back to the app |
| 工程表 | chart switcher | 一覧 |
| 工程表 | tap a card | 詳細 of that card (card morphs into the sheet) |
| 工程表 | tap a member in the rail | highlight that member's cards and waits, dim the rest; tap again or tap empty canvas -> clear |
| 待ちの流れ row | 会話を開く | the producer's chat (existing chat screen); back returns to this 工程表 |
| 待ちの流れ row | 工程へ移動 | canvas scrolls/zooms to the awaited card and opens its 詳細 |
| 詳細 | tap 前の工程 / 次の工程 item | 詳細 of that card, canvas follows |
| 詳細 | close / swipe down / Esc | 工程表, same scroll position |

Failure and edge views (all leave on their own; the action is optional):

| Condition (data) | Shown (Japanese, plain) | What happens next | Action |
| --- | --- | --- | --- |
| list empty | 工程表はまだありません。メンバーがLatticeで工程をつくると、ここに並びます。 | appears on the next list read | 閉じる |
| `state: unverified` | amber banner: 工程表の記録に食い違いがあります。読める分だけ表示しています。 | 直り次第、自動で最新に戻ります。 | 統括と話す (opens the coordinator's chat) |
| `state: last_verified` | blue-grey banner: いまの記録が読めないため、最後に確認できた状態（verifiedAt, JST）を表示しています。 chart slightly dimmed | 読めるようになると自動で切り替わります。 | 統括と話す |
| `state: unavailable` | empty state with a closed bud: この工程表はまだ読めません。 | 記録が整うと自動で表示します。 | 一覧へ戻る |
| `degraded` contains `lattice-read` | small pill: 最新の記録を読み直しています… (chart stays) | next good read removes it | none |
| `degraded` contains `members` | small pill: メンバー情報を読み直しています… | next read | none |
| producer not in `members` | avatar 「?」, name 名簿にないメンバー | appears once the member exists | none |
| 503 or stream drop (35 s silence) | last drawing dimmed + top pill: 工程表に再接続しています… with spinner | reconnect with backoff 1, 2, 4 … 30 s, forever while open; a new snapshot redraws | close |
| 404 `LATTICE_CHART_NOT_FOUND` | この工程表は見つかりません。 | — | 一覧へ戻る |
| 404 on `/api/lattice/charts` (older server) | このサーバーではまだ工程表を使えません。 | appears after the server update | 閉じる |

## Data handling

1. Open `GET /api/lattice/charts/:id/events`; each `snapshot` replaces the model. Diff against the drawn chart by card `id` / edge `from`+`to` and animate the difference. Existing cards keep their positions while their `depth` and lane do not change.
2. A new `epoch` or a reconnect: same as a fresh snapshot.
3. Avatars: `GET /api/bots/:id/avatar?v=<avatarVersion>` through the app's avatar cache; empty version -> initial on the accent.
4. 一覧 reads `GET /api/lattice/charts` on open and every 10 s while visible.

## Motion

| Moment | Apple | Web / Windows |
| --- | --- | --- |
| card state change | `spring(response: 0.45, dampingFraction: 0.82)` | same curve (cubic approximation) |
| card -> 詳細 | `matchedGeometryEffect` | shared-element / FLIP |
| waiting edge flow | `TimelineView(.animation)` + `Canvas`: one particle per 600 ms, 1.4 s travel toward the waiter | canvas / Win2D, same numbers |
| working arc | one turn per 8 s | same |
| completion | seal check `symbolEffect(.bounce)` + a 5-petal bloom fading in 700 ms | same, CSS / composition |
| blocked | `symbolEffect(.pulse)` | opacity pulse |
| new card | scale 0.92 -> 1 + fade, 300 ms | same |
| Reduce Motion | no particles, no rotation, no bloom; cross-fade only | `prefers-reduced-motion` / system setting |

## Accessibility

Each card is one accessibility element: 「<title>、<state>、つくっている <producer>」. 待ちの流れ rows read 「<waiter>が<title>を待っています。つくっているのは<producer>、<state>」. Colour never carries state alone: glyph + badge text always present.
