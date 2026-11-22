# The sessions screen (Apple; the reference for Windows, Linux, Android)

Status: describes what the Apple/Mac app shows today (ServerSessionsViews.swift, built in a485 S2/S3). a529a moves its data to the home part's sessions
(Mika's a529m API) and adds `endSession`; placement and strings below do not change with that. Anis and Neon copy this screen.

## Placement
- Settings > 接続 (the connection page): the section group `ServerSessionsSection`, under the server's own rows.
- A pending login request also shows as a banner above every ready screen (`LoginRequestBanner`), so it is seen from any page.
- 「アプリを追加」 opens a sheet (`AddAppView`).

## Rows and strings (Japanese is the contract)
| Where | Text |
| --- | --- |
| Section 承認待ち (only when a request waits) | 「<kind>が入ろうとしています」 / 「<network>・<time>」 / 「自分で始めたログインだけ許可してください。」 / buttons 「許可」 「拒否」 |
| Button | 「アプリを追加」 |
| Section | 「このサーバーに入っているアプリ」 |
| Row title | kind: Web / iPhone・iPad・Mac / Windows / Linux / Android; badge 「このアプリ」 on this device's own row |
| Row line 1 | 「<origin>・<network>」; origin: 「スマホで承認」 / 「サーバーのコンソールのコード」 / 「「アプリを追加」のコード」; network: 「同じネットワークから」 / 「ネットワークは確認できません」 |
| Row line 2 | 「入った日時 <time>」 + 「・最後に使った日時 <time>」 (when known) |
| Row button | 「取り消す」 (another device) / 「ログアウト」 (this device's own row), destructive, bordered |
| Add-app sheet | title 「アプリを追加」; button 「コードを出す」 / 「作っています…」; the code, 「<time>まで有効」; note 「この画面のコードは1回だけ使えて、10分で切れます。購読していない人は、このコードでブラウザー版に入れます。このコードで入ったものは、このアプリが終わると一緒に終わります。」; button 「閉じる」 |
| Error | one red footnote line under the section (the reason, never a raw code) |

## Rules
- Every row of the user's server appears here, whatever way it entered (code, phone approval, console code). The old 承認した端末 list (the phone's own approvals, login-billing) is a different list and is not this screen.
- 「取り消す」 on another device's row ends that session at once (home part `endSession`); the row leaves the list when the server says so.
- When the app stops something at the operator (stop(passId) or stop all others), it also calls `endSession` for the affected sessions so the stop is felt at once (Mint's answer to the 6 min 30 s measured on the dev server).
- Accessibility identifiers: sessions-add-app, session-revoke-<id>, login-request-approve, login-request-deny, login-request-banner, add-app-issue, add-app-code, add-app-note.
