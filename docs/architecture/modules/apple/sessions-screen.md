# The sessions screen (Apple; the reference for Windows, Linux, Android)

Status: wording ruled by Tronie/Mint 2026-11-23. Built in a529a (2026-11-23): on a home server the screen reads `GET /api/home/sessions` (`HomeSessionsModel`, `HomeSessionsSection`, shown when the home has device logins and this app holds a session); rows, wording, summary line, icons (SF Symbols) and the buttons below are shared with the old-login section (`DeviceRowView`). The home list has no origin or network, so row line 1 is left out there (as on Windows); 承認待ち and 「アプリを追加」 stay on the old-login path only. 「締め出す」 shows only on an iPhone with a store pass (the iPad and Mac screens show 「ログアウトさせる」 only). Describes the screen the Apple/Mac app shows today (ServerSessionsViews.swift, built in a485 S2/S3). a529a moves its data to the home part's sessions
(Mika's a529m API) and adds `endSession`; placement and strings below do not change with that. Anis and Neon copy this screen.

## Summary line and icons (Tronie, 2026-11-23: every platform, text-only rows are returned)
- One summary line above the list, under the title 「このサーバーに入っている端末」: 「<n>台が入っています」 (n counts every row including this device); when n = 1: 「この端末だけが入っています」. Muted footnote style, no button.
- No second count line: the summary is one line, the own row is marked by its 「このアプリ」 badge, nothing like 「うち1台はこのアプリ」.
- Console row (a session made by the server's console code, `kind = console`): icon console (terminal glyph), title 「サーバーのコンソールのコード」 (the same string as the origin label; the merged Windows screen #2345 already uses it), same row lines and buttons as the others.
- Every row starts with a generic device glyph (32 pt tile, left of the title), never a brand mark. Mapping by the row's kind: iPhone・iPad (`apple`) → phone (tablet when the device label says iPad; laptop when it says Mac); Android → phone; Windows → desktop; Linux → desktop; Mac → laptop; Web → web (globe); console row → console (terminal). The files are in `sessions-icons/` next to this document: phone.svg, tablet.svg, laptop.svg, desktop.svg, web.svg, console.svg (README there: size, colour). Where a platform has the same generic symbol natively it may draw that instead (e.g. SF Symbols for the Apple screen), but the choice per kind above is the same everywhere. The row title keeps the kind's name next to the icon: iPhone・iPad・Mac / Windows / Linux / Android.

## Placement
- Settings > 接続 (the connection page): the section group `ServerSessionsSection`, under the server's own rows.
- A pending login request also shows as a banner above every ready screen (`LoginRequestBanner`), so it is seen from any page.
- 「アプリを追加」 opens a sheet (`AddAppView`).

## Rows and strings (Japanese is the contract)
| Where | Text |
| --- | --- |
| Section 承認待ち (only when a request waits) | 「<kind>が入ろうとしています」 / 「<network>・<time>」 / 「自分で始めたログインだけ許可してください。」 / buttons 「許可」 「拒否」 |
| Button | 「アプリを追加」 |
| Section title | 「このサーバーに入っている端末」 (ruled by Tronie/Mint for every platform; the rows are devices) |
| Row title | the app kind on the row: Web / iPhone・iPad・Mac (library kind `apple`) / Windows / Linux / Android; badge 「このアプリ」 on this device's own row |
| Row line 1 | 「<origin>・<network>」; origin: 「スマホで承認」 / 「サーバーのコンソールのコード」 / 「「アプリを追加」のコード」; network: 「同じネットワークから」 / 「ネットワークは確認できません」 |
| Row line 2 | 「入った日時 <time>」 + 「・最後に使った日時 <time>」 (when known) |
| Row buttons | own row: 「ログアウト」. Another device's row: 「ログアウトさせる」 (ends that session here at once: `endSession`). Only a phone with a store pass also shows 「締め出す」 (`stop(passId)` at the operator, then `endSession`), after the confirm line 「この端末は、もう一度サインインするまで使えなくなります。」. All destructive, bordered. The words 「取り消す」 and 「終了」 are not used. |
| Add-app sheet | title 「アプリを追加」; button 「コードを出す」 / 「作っています…」; the code, 「<time>まで有効」; note 「この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。」; button 「閉じる」 |
| Error | one red footnote line under the section (the reason, never a raw code) |

## Rules
- Every row of the user's server appears here, whatever way it entered (code, phone approval, console code). The old 承認した端末 list (the phone's own approvals, login-billing) is a different list and is not this screen.
- 「ログアウトさせる」 on another device's row ends that session at once (home part `DELETE /api/home/sessions/{id}`); the row leaves the list when the server says so. 「締め出す」 needs the row's `passId` (account rows only) and a store pass on the caller.
- When the app stops something at the operator (`stop(passId)` or stop all others), it also calls `endSession` for the affected sessions so the stop is felt at once (Mint's answer to the 6 min 30 s measured on the dev server).
- Accessibility identifiers (kept; session-revoke-<id> stays the id of the 「ログアウトさせる」 button): sessions-add-app, session-revoke-<id>, login-request-approve, login-request-deny, login-request-banner, add-app-issue, add-app-code, add-app-note.
