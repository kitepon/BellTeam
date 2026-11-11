# Harness accounts: 1st/2nd slots, limit failover and return

Owner: Kiro (execution). Requested by the Owner via Trony, 2026-11-08 20:1x JST. Status: implemented (execution #674); one login per slot designed 2026-11-11 (this revision). Limit-driven only (Owner ruling 2026-11-09 06:3x JST via Trony): there are no preference rules and no 「Fableを2ndアカウントで使う」 switch.
Scope: Claude only. The shape is keyed by harness, so another harness can add slots later without a new contract; nothing Codex-specific is built.

Names in every UI and contract: 「1stアカウント」 (`slot: '1st'`, primary) and 「2ndアカウント」 (`slot: '2nd'`, fallback). No e-mail address is hard-coded. The Owner logs each slot in once from the app.

One login per slot (Trony request 2026-11-11, Owner: 「何度も何度もログインしてる気がするけど何で？」; the Owner's Google password change signed out the host logins on rabbit and the Mac): a slot's only login is its token file, written by the app card. It serves every seat of that slot in the container and on every Owner terminal, 1st and 2nd alike. No host login is needed. A login can be lost at any time; one new login of that slot in the app is enough for every seat (Signed out and renewal below).

## Function map

| Function | Owner | Public contact |
| --- | --- | --- |
| Slot registry: harness × slot → config root, login label, limit state | execution (this doc) | `accounts.list()`, `transport.seatAccount(botId)` |
| Slot directory preparation (shared history, separate credentials, the 1st root's first-run acknowledgement) | execution | inside `accounts.prepare(harness, slot)`; called before login and before a launch |
| MCP registration in each slot's `.claude.json` | execution, reusing `mergeMcpConfig` of harness-config | same writer, one more target path per prepared slot |
| Login per slot | usage (Mika) HarnessAuth → Aiterm `agent_auth` | HarnessAuth `start/input/status/cancel(harness, {slot})`. Every slot (1st and 2nd): Aiterm `agent_auth` with `login: "oauth_token"` + `token_file` = `accounts.prepare(...).tokenFile` = `$BELLTEAM_HOME/.bellteam-accounts/claude/<slot>/oauth-token` (Aiterm ≥ 0.70.20 runs `claude setup-token` and writes that file as the seat user, 0600; #1030; it accepts only this path form). The launch side only reads that file (Login per slot row below) |
| Limit detection | execution | wait result (trigger) + usage reading (reset time) |
| Signed-out detection and renewal | execution | wait result `failure.category:'authentication'` (E6) → slot signed out until its token file changes |
| Slot selection at launch / model change | execution | launch option `claudeLogin` (the slot, every slot, every launch incl. resume and fork); the seat-side launcher puts that slot's token into the CLI env |
| Failover after a limit, return after reset | execution | existing reconfigure (apply at the next turn boundary) + capacity continuation message |
| Account-card data and slot-aware login contacts | usage (Mika) | typed auth/account-card data built from `accounts.list()` |
| Routes, private port injection, SSE, Bot DTO | Molly | `accounts.list` route, `account` in Bot items, SSE topic `settings` |
| Rendering: card rows, banner, member card | Admi (Web), Apple and Windows owners | the data contacts above |
| Per-seat config root on launch, resume and auth | Aiterm (Elegg) | E1–E3 below |

## Data flow

```mermaid
flowchart TD
  Owner[Owner: 設定 → AIの認証 → Claude → 1st/2ndアカウント → ログイン] --> Auth[Mika HarnessAuth slot]
  Auth -->|accounts.prepare → tokenFile of slot| AitermAuth[Aiterm agent_auth login:oauth_token: claude setup-token]
  AitermAuth --> Token[(.bellteam-accounts/claude/slot/oauth-token 0600, seat user — the slot's only login)]
  Token -->|presence + mtime| LoggedIn[loggedIn: token present and not signed out at this mtime; 1st without token = legacy root login]
  LoggedIn --> Select
  Registry[(execution accounts.json: limit state + signed-out slots + seat slots, no secrets)] --> Select
  Bot[Bot model / harness → model scope; launch or model change] --> Select[Select slot among logged-in slots: 1st unless limited → 2nd → earliest reset; none logged in → 1st]
  Select -->|claudeLogin: slot -> seat launcher reads that token, CLAUDE_CODE_OAUTH_TOKEN in the CLI env; same 1st root; container and Owner terminals| Launch[Aiterm launch / resume E7]
  Launch --> Seat[Claude seat]
  Seat --> AuthFail[wait failure.category authentication E6]
  AuthFail --> SignedOut[mark slot signed out at the token's mtime + seat]
  SignedOut --> Registry
  SignedOut --> Failover
  Token -->|new mtime: a new login, seen by list / 10-min re-read| Renew[clear signed-out entry; its seats get a new seat at next idle boundary]
  Seat --> Wait[wait result rate_limited / failure.category rate_limited, incl. E5 rate_limit API-error records + the seat's limit text]
  Wait --> Parse[parse scope and reset time from the limit text]
  Parse --> Mark[mark slot × scope limited until resetAt]
  Parse -->|text has no time| Usage[usage reading with that slot's token, in process: row of the same scope]
  Usage -->|resets_at| Mark
  Mark --> Registry
  Mark --> Failover[failed seat: new seat on the other slot (old seat left as it is; closed only by member DELETE) + continuation message]
  Mark --> Idle[other running seats on that slot whose model is in the scope: new seat at their next idle boundary]
  Clock[timer at resetAt / only when resetAt unknown: usage below limit or a turn in scope succeeds] --> Return[slot × scope available]
  Return --> Back[seats whose effective slot is now the 1st: switch back at next idle boundary]
  Registry --> List[accounts.list / seatAccount] --> UI[settings card, member card, both-limited banner]
```

## Storage

| Item | Place | Notes |
| --- | --- | --- |
| 1st slot root | `$BELLTEAM_HOME/.claude` with `CLAUDE_CONFIG_DIR` unset | the config/history root of every seat; since one login per slot it is not the login of a seat that has a 1st token (its `.credentials.json` stays for the usage reading, the label, and legacy 1st below) |
| 2nd slot root (login card and usage reading only) | `$BELLTEAM_HOME/.bellteam-accounts/claude/2nd/` (0711; `.bellteam-accounts/` and its `claude/` also 0711) | Used by HarnessAuth `?slot=2nd` and the usage reading under `CLAUDE_CONFIG_DIR` set to this path. Seats never run with it since 2026-11-09 (login-only, Login per slot row); it also holds the seats' `oauth-token`. Owned by the seat user; 0711 lets the engine `lstat` known names inside. |
| Credentials | `<root>/.credentials.json` (0600) | written and refreshed only by the official CLI. Only the seat-user helper reads the token, for the usage reading; it returns the usage rows only. The token is never logged, never returned, and never put in env or argv |
| Login per slot | `$BELLTEAM_HOME/.bellteam-accounts/claude/<slot>/oauth-token` (seat user, 0600) for every slot (`1st/` and `2nd/`), a long-lived `claude setup-token` token of that slot's account, written only by that slot's login card (function map row). `1st/` holds only this file; it is not a config root | Only the login passed to the CLI differs (Owner 2026-11-09 09:2x JST, the promise from the start). Every seat runs on the 1st root with the 1st config and gets its slot's `CLAUDE_CODE_OAUTH_TOKEN` in its env, in the container and on every Owner terminal (remote-seat private env; a non-Owner terminal keeps its own login, Owner ruling); nothing else differs: no `CLAUDE_CONFIG_DIR`, no `configuration_root`, no copy, no links. The token is read only by the seat-side launcher (`run-seat-aiterm-launch.mjs`, seat user) through `accountLoginEnvironment`; the engine passes only the slot name. A missing or malformed 2nd token fails that launch (`ACCOUNT_LOGIN_UNAVAILABLE`); selection never picks a slot without its token. Legacy 1st: while `1st/oauth-token` does not exist yet, the 1st launches without the variable (the container root's own login; on a terminal the host's own login, as before) and `loggedIn` is the root's `.credentials.json`. It ends with the Owner's first 1st login in the card; nothing else uses it. At rest the token is also in Aiterm's own resume recipe of that seat (seat user, 0600), the same protection as the CLI's credentials file; E7 replaces it at each resume. |
| 2nd root folder | `$BELLTEAM_HOME/.bellteam-accounts/claude/2nd/` | holds the 2nd `oauth-token`; seats no longer use it as a config root. Its older contents (own `.claude.json`, links from #754, `.credentials.json` of the earlier OAuth login) stay untouched; HarnessAuth/usage may still prepare it, which changes no seat. |
| Registry | `/srv/bellteam/state/harness-accounts.json`, schema `bellteam.harness-accounts.v1` (a `rules` key from before 2026-11-09 is ignored on load and dropped at the next write) | `{ seats:{botId: slot}, limits:[{harness, slot, scope, since, resetAt|null, resetSource:'message'|'usage'|null, text}], signedOut:[{harness, slot, since, stamp, seats:[botId], text}] }`; one entry per limited (slot, scope); an absent entry means available. `logins:{botId: stamp|null}`: the token mtime the seat's last launch or resume carried (null: legacy 1st), written with `seats` by every fresh launch, account switch and E7 resume. `signedOut:[{harness, slot, since, stamp, text}]`: one entry per slot whose token failed authentication at that mtime (a failure is checked against the seat's `logins` stamp: an older one is `stale`). `renew:[botId]`: members whose seat failed on its login and needs a new seat on a logged-in slot; removed by that seat's next recorded launch. `scope` is `'all'` or a model family (`'fable'`, `'opus'`, `'sonnet'`, `'haiku'`). `text` is the limit line the CLI showed (no secrets). No secrets |

### Member DELETE closes every seat of the member (Trony ruling 2026-11-11)

`transport.stop(bot, version, { allSessions: true })`, called only by member deletion (`startMemberRemoval`), closes the current session and then every other live session of the member on every terminal: the 1st seat left by an account move and any earlier `<id>-<slot>-<time>` seat. Sources: remote seats from `execution-runtime-launches.json` entries whose `botId` is the member; local seats from `pty_list` rows named `<id>` or `<id>-…`. Each is closed with `pty_close` through the same routed client (a remote close also revokes that seat's credential). A seat that is already gone, or whose close fails, is logged (`BellTeam delete: seat not closed`) and does not stop the deletion; its exit is Aiterm's idle clock. Account moves, restart and configuration stops keep the 11-09 ruling (current session only).

### Identity (production regression 2026-11-08 22:0x JST)

The execution engine runs in the parent as the server user (`bellteam-server`, uid 1001). `$BELLTEAM_HOME` (`/home/bell`) and every slot root belong to the seat user (`bell`, uid 1000), and `.claude.json` / `.credentials.json` are 0600. So the engine never opens, creates or writes files there itself:

| Need | Who does it |
| --- | --- |
| `prepare` (create the root, chmod 0711, link every 1st entry and the 1st `.claude.json`, move aside what the root made itself; at login and before every launch on that slot) | seat-user helper, op `prepare` |
| `label` (the e-mail of the slot's own login, from the profile endpoint with that slot's token; the token never leaves the helper) | seat-user helper, op `label`; cached per slot until `.credentials.json`'s mtime changes (a new login) |
| usage reading (needs the token) | seat-user helper, op `usage`; returns `[{kind, model, percent, resets_at}]` only |
| `loggedIn` / token stamp | engine `lstat` of `<slot>/oauth-token` (mtimeMs is the stamp; the chain is 0711; legacy 1st: the root's `.credentials.json`, no stamp); when the engine cannot traverse `$BELLTEAM_HOME` (an installed home is 0700: `install.sh` runs with umask 077), seat-user helper op `stamp` (mtimeMs or null; no content). A check that fails both ways is "not logged in", so selection still returns a slot and never refuses a launch (lab 2026-11-11: every Claude launch failed `BOT_LAUNCH_FAILED` before `agent_launch` on EACCES) |
| `history` | engine `lstat`; when it cannot see, `shared` (display only) |

Seat-user helper = `seatFiles` in `src/harness-accounts.mjs`, a self-contained function run as `node -e` through the parent's existing seat runner `ports.seat.waitProcess` (sudo seat-exec, uid 1000; the same path the Aiterm wait process uses), and it prints one JSON result. No new parent port and no body swap. Without `ports.seat` (single-user development and tests), the same function runs in the engine's own process.
A failed `prepare` is `ACCOUNT_ROOT_UNAVAILABLE` (status 503), and the engine logs the underlying code. The module IPC carries the code only. HarnessAuth (usage) renders it as plain Japanese, never a raw errno.

`prepare` creates missing symlinks only and never overwrites an existing non-symlink entry (protection: overwriting existing state). If an entry is a real file, the slot is reported as `history: 'separate'` in `accounts.list()` and the Owner sees it. The slot still works: launch and login proceed, and resume finds only conversations written under that root.

## Limit detection (per slot × model scope; Owner correction 2026-11-08 20:3x JST)

A seat's model scope is the first family name found in its model id (`fable`, `opus`, `sonnet`, `haiku`; for example `claude-fable-5-1` → `fable`, the alias `opus` → `opus`). An unknown family is only affected by `'all'`. A slot is limited for a seat when it has an entry with scope `'all'` or the seat's family.

1. Trigger: a Claude wait result on a seat whose slot is S, either `outcome:'rate_limited'` (screen line in `rate_limit`) or `failure.category:'rate_limited'` (transcript 429, its line in `error`). Both are existing public wait-result fields.
   Production 2026-11-09 06:0x JST (usage credits off): the plain Fable limit is a transcript record `isApiErrorMessage:true, error:'rate_limit', apiError:'model_requires_usage_credits'`, no `apiErrorStatus`, text `You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.`, and Stop still fires. Aiterm 0.64.0 reports that turn `done`, so no limit is recorded from it and the seat stays on S (Kiro's own Fable seat, 19 turns 06:06–06:27 JST). E5 below makes it `failure.category:'rate_limited'`.
2. Scope from the limit text, then from usage:
   - `You've reached your Fable limit …` / `You've hit your Opus limit …`: a named family is that family;
   - `You're out of usage credits … to keep using Fable 5.1 …` (Claude Code's model-limit line, also with credits off): the named model's family;
   - `weekly limit`, `session limit`, `usage limit`, and the screen line `Usage limit reached`: `'all'`.
   If the text does not decide it, the usage reading decides it: `weekly_scoped` rows with `scope.model.display_name` give that family; `session` and `weekly_all` give `'all'`.
3. Reset time, first from the same text, at detection. The observed forms are:
   - `resets 8am (UTC)` and `resets Oct 16, 8am (UTC)`: time zone in parentheses;
   - `continuing automatically at 8am`: no zone, so the seat process's TZ applies;
   - `try again at Aug 8th, 2026 12:35 PM`.
   A time without a date is its next occurrence after the detection time in that zone; `resetSource:'message'`.
   Only when the text has no time (e.g. `You've reached your Fable limit. Run /usage-credits …`), the parent reads the usage endpoint that Claude Code itself uses (`/api/oauth/usage`, as in `scripts/claude-usage.py`) with S's token, and takes `resets_at` of the row of the same scope at 100 %; `resetSource:'usage'`. An unreadable reading leaves `resetAt:null`.
4. Leaving the limited state (the self-exit):
   - With `resetAt` known, the entry is removed at exactly that date and time by one timer, re-armed from the registry after a restart. Nothing else removes it early. If the registry write fails at that moment, the entry stays limited, one stderr line names the code, and the clear is retried every 60 s (never a hot loop).
   - With `resetAt` unknown, the extra exits are: a usage re-read every 10 minutes showing that scope below 100 %, or a turn in that scope on S ending `done`. A usage re-read that finds a `resets_at` for the scope sets `resetAt` and the timer from then on.
5. A parsed time in the past or more than 8 days ahead is a mis-parse (a weekly limit resets within 7 days) and is not trusted: the usage fallback decides, else the reset is unknown. Each recorded limit writes one stderr line with the text, the zone used and the parsed time (Epinel's check), never a token.
6. `accounts.list()` does not read usage; it only reports the registry. No AI is woken and no seat is started for any of this.

## Selection, failover and return

There is no preference rule: every seat prefers the 1st (Owner ruling 2026-11-09). A family is matched on the Bot's model id or the CLI's bare alias (`fable`, `opus`, `sonnet`, `haiku`; the catalog lists Fable 5.1 as `fable`).

Usable slots = the slots that are logged in (token present and not signed out at its current stamp; legacy 1st above). Effective slot = the first usable slot (1st before 2nd) not limited for the seat's scope. If every usable slot is limited for the scope, it is the usable slot whose matching entry has the earliest `resetAt`, and an unknown reset sorts last. If no slot is usable, it is the 1st (the launch then shows the CLI's own login error; the card shows ログイン). So a signed-out 1st never keeps seats while the 2nd is logged in (Trony 2026-11-11). So a Fable-only limit on the 1st moves only Fable seats; Opus and Sonnet seats stay. A launch is never refused for limits: the seat starts, the native CLI shows the limit, and the status surfaces show it plainly.

| Event | Action |
| --- | --- |
| A seat's turn ends rate-limited on S | Record the (S, scope) entry. If another slot is available, start the member's new seat on that slot and send the existing capacity-continuation message to it, without changing harness or model. The old seat on S is left as it is: it cannot use S anyway, and its background processes keep running (Owner ruling 2026-11-09 08:2x JST, "1stは放置"; restart closes only the current session; member DELETE closes it with every other session of the member, see "Member DELETE" below; hibernating it was refused by Aiterm while background processes ran, production 07:49–08:17 JST). This does not need Aiterm's terminal-failure proof (`recoveryFailure`): the limit record alone starts it. If none is available, the existing CapacityContinuation (another harness) runs unchanged, and only with that proof. |
| Running seat whose slot is limited for its scope, idle or between turns | Start its new seat on the effective slot at the next turn boundary (a running turn is never stopped). Every seat in the registry is considered, also one launched by an earlier engine (the session map starts empty after a module exchange). A seat with no running terminal needs nothing: its next launch selects the slot (row below). A switch to the slot the seat already has does nothing. |
| Seat starting while the 1st is limited for its scope | Launch directly on the effective slot. This holds for every launch, the delivery-bound (execution) launch included. A member whose slot became limited while it was not running already has its new account seat name (switch below), so its next delivery launches that seat on the effective slot instead of waking the old seat. |
| Model change in place (`agent_configure`, same CLI) | Select again for the new model; if the slot differs, switch at the next idle boundary (`moveAtBoundary`). So a seat changed to Opus while the 1st is limited only for Fable goes back to the 1st, and a seat changed to Fable goes to the 2nd. |
| An (S, scope) entry ends | Each seat whose effective slot changes because of it (back to the 1st) switches at its next idle boundary. |
| A seat's turn ends `failure.category:'authentication'` (E6) on S with a token | Record `signedOut` for S at the token's current stamp (one stderr line with the text, never a token). S stops being usable at once: the failed seat moves exactly like a limit (new seat on the effective slot + continuation message) when another slot is usable; otherwise it stays and is added to the entry's `seats`. Other running seats on S move at their next idle boundary (same as a limit). Legacy 1st is not marked (no stamp; today's behaviour until the 1st token exists). |
| S's token file gets a new stamp (a new login in the card) | The self-exit of `signedOut`: `accounts.list()` (the card's status call reads it) and the 10-minute re-read compare the stamp; a different stamp removes the entry and saves. Its `seats` then get a new seat on their effective slot at the next idle boundary, also when that slot is S (renewal: a running CLI keeps the old env token, so only a new launch reads the new one). Seats that are not running read the new token at their next launch or resume (E7). |
| Both slots limited for a scope | `accounts.list()` lists that scope in `allLimited:[{scope, earliestResetAt}]`. Mika shows it on the AIの認証 card and in the status banner. Seats keep running as described above. |

The switch starts a new seat; it never stops, hibernates or resumes the old one. The new seat has a new session name, `<botId>-<slot>-<base36 time>`, stored as the Bot's `session` (`updateSession`), and is an ordinary fresh launch (`wakeNow` with that name and `claudeLogin` of the selected slot). Like every fresh launch it gets the Throughline short-term memory of the previous conversation and the Bot's docs, so the work continues; the vendor conversation is a new one, because two CLIs must not write one conversation. A later fresh launch keeps an account seat's name (one that starts with `<botId>-`); any other fresh launch uses the Bot id as before. The old seat keeps its own name and is no longer the Bot's seat: deliveries, stops and observation follow the new name. Aiterm's idle clock hibernates it once its background processes end, so it leaves on its own.

Seat name format (public contract with integration `seat-mcp`, #759): a Bot's seat is `<botId>` or `<botId>-<slot>-<base36>`, slot in `ACCOUNT_SLOTS` (`1st`, `2nd`), base36 `[a-z0-9]+`. The seat's `X-Bellteam-Seat` header is that name (`AITERM_SESSION_ID`); `seat-mcp` resolves the exact name first, then the account form to `<botId>`, and keeps the full name as `launch.session_id`. Any other suffixed name (child seats) stays unresolved. Adding a slot changes the `seat-mcp` pattern in the same release. Without this resolution an account seat has no BellTeam identity (production 2026-11-09 11:5x JST: Trony's and Black's 2nd seats got `BELLTEAM_SEAT_UNRESOLVED` on bellteam and call-bridge).

## Deployment order (one login per slot, cross-cutting, 2026-11-11)

1. Aiterm with E6 and E7, in the body and on every terminal (rabbit, Mac, fox; Elegg). Without E7 a hibernated seat whose recipe lacks the variable gets `AGENT_RESUME_CONFLICT` once the variable is named, and a renewed token would not reach a resumed seat.
2. Body with the launcher change (`run-seat-aiterm-launch.mjs`: `claudeLogin:'1st'` without a token file adds nothing and drops the name from a terminal's private env names).
3. Execution module (selection, signed out, `claudeLogin` for every slot, `prepare().tokenFile`), then usage (Mika: token login for the 1st card).
4. The Owner logs in the 1st once in the card (and the 2nd only if its row shows ログイン). Running seats move to the token login at their next launch or resume; nothing is restarted for it.

## Deployment order (login-only, cross-cutting)

`run-seat-aiterm-launch.mjs` (body-resident, seat user) must know `claudeLogin` before the execution module sends it: an older launcher ignores it and would start the 2nd seat with the 1st login. So: body first, then the execution module (`aiterm-client.mjs`, `aiterm-transport.mjs`, `harness-accounts.mjs`), then restart the seats that run on the 2nd. The #754 order below is superseded for seats (the link prepare is no longer used by any launch).

## Deployment order (#754, cross-cutting)

The link-based `prepare` (execution and usage modules, both ship `src/harness-accounts.mjs`) needs a body that no longer writes into slot roots (`writeHarnessConfig` in `src/harness-config.mjs`, body-resident, in no module payload). An older body's atomic merge into `<2nd root>/.claude.json` replaces the link with a regular file that carries the 1st `oauthAccount` (wrong-account state). So: the body with #754 goes live first, then the execution and usage modules carrying #754. Known payload consumers of `src/harness-accounts.mjs`: execution (`EXECUTION_FILES` in `scripts/web_gateway_artifact.py`, execution module.json) and usage (HarnessAuth / usage prepare). After the modules: restart the seats running on the 2nd so they read the 1st config.

## Implementation map

| Piece | Where |
| --- | --- |
| Registry, prepare, selection, limits, timers, re-read, list | `src/harness-accounts.mjs` `HarnessAccounts`, one per execution engine; `load()` at engine initialize re-arms the timers |
| Limit text parser, model family | `src/claude-limit-text.mjs` |
| Launch with the selected login, seat slot record | `AitermTransport.wakeNow`, the resume of a hibernated seat (`resumePreviouslyActive`, which also records the resumed token's stamp with `setSeat`) and the fork launch: `claudeLogin` = the seat's slot for every slot (`AitermClient.call` forwards it to the seat launcher, or reads the token itself on the local env path; `RemoteSeats.prepare` for an Owner terminal); no `configuration_root` |
| Signed out, renewal | `AitermTransport.recordAccountSignedOut` from the delivery completion (`failure.category:'authentication'`, text = `error`) → `HarnessAccounts.recordSignedOut`; stamp check in `list()` and the re-read → `reviewAccounts` renews the entry's seats |
| Limit signal → registry | `AitermTransport.recordAccountLimit` from the delivery completion (wait outcome `rate_limited` or `failure.category` `rate_limited`; text = `rate_limit` or `error`) |
| Failover | `CapacityContinuation.continue`: an account switch of the same harness first (`transport.switchAccount` = a new seat on the selected slot, above), then the existing harness switch if the account switch is impossible |
| Idle-boundary moves and return | `AitermTransport.reviewAccounts` / `moveAtBoundary` on every registry change and after a model change applied in place (`reconfigureNow`); it waits for the member's running turn to end, never stops it, then calls `switchAccount` (a new seat; nothing for Aiterm to refuse) |
| Successful-turn exit | `AitermTransport.accountTurnDone` on delivery completion |
| Parent Aiterm env | `AitermClient` (parent clients): `AITERM_CLAUDE_CONFIG_ROOTS` in its own env and in the seat launcher's process env, never in `env_vars`. In production the parent connection starts through the seat command (`/usr/bin/env VAR=… aiterm`), which does not carry `this.env`, so the variable is also an `env` argument there (`seatConnectionEnvironment`). Without it Aiterm rejects every 2nd-root call (`agent_auth` status/start: production 2026-11-08 22:3x JST, USAGE_OPERATION_FAILED). Parent-image source: it goes live with a body swap |
| MCP registration and settings of slot roots | nothing to copy: `writeHarnessConfig` writes the 1st `.claude.json`, which the 2nd links to (it no longer writes into slot roots: an atomic rename there would replace the link). A failed `prepare` is logged; the launch goes on with the links already there |
| Facade | `accounts.list/prepare` (dispatch), `transport.seatAccount` (project), `accounts.watch` over the queue stream (topic `accounts`) |

## Public interfaces (execution)

- `accounts.list()` → `{ harnesses:[{ harness:'claude', slots:[{ slot:'1st'|'2nd', loggedIn:boolean|null, label:string|null, history:'shared'|'separate', limits:[{scope, since, resetAt|null, resetSource}], seats:[botId] }], allLimited:[{scope, earliestResetAt|null}] }], rules: [] }`. `rules` is always empty (shortcut: kept for clients that still read it; dropped once Web, Apple and Windows remove the switch). An empty `limits` means available for every model. `label` is the e-mail the CLI itself recorded for that root's login (`oauthAccount.emailAddress` in its `.claude.json`); it is display text, not a credential. `seats` lists the Bots whose last launch used that slot (`seats` in the registry, written after each Claude launch).
- `accounts.prepare(harness, slot)` → `{ configurationRoot, history, tokenFile }`. It is called by HarnessAuth before a login, and returns the root used for E3 and the slot's token file for `agent_auth` `token_file` (an absolute path; HarnessAuth never builds it).
- `accounts.list()` slot rows also carry `signedOutAt: string|null` (the time the slot's token failed; clients may show 「ログインし直してください」; absent on older engines). `loggedIn` is false while signed out.
- `transport.seatAccount(botId)` → `{ harness, slot, preferredSlot } | null`; `preferredSlot` is always `'1st'` (same shortcut as `rules`).
- `accounts.watch(listener)` → unsubscribe; called after every saved registry change (Molly maps it to the SSE type `settings`). Seats that move also appear on the existing `watchQueue` stream.
- Module: `src/harness-accounts.mjs` (`HarnessAccounts`, `readClaudeUsage`, `preparedAccountRoots`) and `src/claude-limit-text.mjs` (`parseLimitText`, `modelScope`).
  Both ship in the execution artifact: `EXECUTION_FILES` in `scripts/web_gateway_artifact.py` lists them (the dispatcher imports the first, which imports the second).

## Public HTTP (fixed 2026-11-08 by the feature owner; Admi's Web shape accepted)

| Path | Contract | Owner of the route |
| --- | --- | --- |
| `GET /api/accounts` | `accounts.list()` verbatim. A 404 means an older body: clients show the old single Claude card. | Molly |
| `POST /api/accounts/rules` | Removed (Owner ruling 2026-11-09). An engine without `setRule` answers `EXECUTION_REQUEST_INVALID`, which the current route already maps to 404; Molly deletes the route with the next body. | Molly |
| `GET /api/harness-auth/claude?slot=2nd` | the existing harness-auth status for that slot. No `slot` means 1st, and the response is unchanged for it. | Mika |
| `POST /api/harness-auth/claude/{start,input,cancel}?slot=2nd` | the existing login flow for that slot; the body is unchanged. No `slot` means 1st. | Mika |
| Bot items (`GET /api/bots` and the Bot detail) | `account: {harness, slot, preferredSlot} \| null` from `transport.seatAccount(botId)`. It is absent on older bodies, and clients tolerate that. | Molly |
| SSE `/api/events` | `type: 'settings'` on every registry change, from `accounts.watch`. The engine's raw queue-stream topic `accounts` is internal and is not forwarded to clients. | Molly |

## What other owners add

- Elegg (Aiterm):
  Agreed by Elegg on 2026-11-08 (Aiterm 0.64.0):
  - E1 (unused by seats since 2026-11-09, login-only): `agent_launch` / `claude_agent` accept `configuration_root`. Two values are allowed:
    - the default root `$HOME/.claude`, where the seat runs with `CLAUDE_CONFIG_DIR` unset;
    - an existing directory whose realpath is a direct child of a parent listed in `AITERM_CLAUDE_CONFIG_ROOTS` (a path-delimited list) in the Aiterm MCP process env.
    BellTeam sets `AITERM_CLAUDE_CONFIG_ROOTS=$HOME/.bellteam-accounts/claude` only in the env of the parent's own Aiterm client process. Bot-side Aiterm processes do not get it, so they can use only the default root. The root is stored in the resume recipe. Anything else gets `AGENT_CONFIGURATION_ROOT_REJECTED` (protection: credentials of an unintended directory). `env_vars` containing `CLAUDE_CONFIG_DIR` together with `configuration_root` gets the same error (two sources for one value). With `remote`, the seat's own Aiterm validates against its own env.
  - E2. A cross-root resume goes only through the existing resume entry: `session_name` of a hibernated seat, or `require_existing_resume`. `configuration_root` is the only setting allowed to differ; a model, effort, cwd or env difference still gives `AGENT_RESUME_CONFLICT`. The transcript must exist at `<new root>/projects/<slug of recipe cwd>/<vendor_session_id>.jsonl`, otherwise resume is unavailable. The new recipe stores the new root, and `CLAUDE_CONFIG_DIR` null for the default. Execution's switch does not use E2 or E4 (Owner ruling 2026-11-09 08:2x JST: the old seat is left as it is and a new seat starts); both remain Aiterm capabilities.
  - E4 (agreed 2026-11-08, Aiterm 0.64.0): `pty_close {session_id, hibernate:true}` on a managed claude agent seat runs the idle-clock stopping → hibernated lifecycle on demand and returns outcome `hibernated`. The conversation, recipe and vendor session id are kept, and `agent_launch` with `session_name` + `require_existing_resume` + `configuration_root` resumes it (E2).
    - `AGENT_BUSY` while a turn, post-startup children or child deliveries run (protection: their work; exit: call again at the turn end).
    - `AGENT_HIBERNATE_UNAVAILABLE` with the reason for other non-hibernatable states; the seat is untouched.
    - Rate-limit exception: allowed when the seat's transcript has a rate-limited API error after its last input, even on the limit footer or menu; the saved recipe is used.
    - Without `hibernate`, `pty_close` is unchanged.
    - `AITERM_CLAUDE_CONFIG_ROOTS` never reaches a seat's environment.
    - `wait.error` carries the full transcript limit line, and `failure.category` matches "You've hit your <word> limit" without a 429.
  - E5 (requested 2026-11-09): a Claude transcript record with `isApiErrorMessage:true` and `error:'rate_limit'` (the CLI's own field; seen with `apiError:'model_requires_usage_credits'` and no `apiErrorStatus`) gives `failure.category:'rate_limited'` with its text in `wait.error`, also when Stop fires after it (the turn is not `done`). E4's rate-limit exception covers this record too.
  - E3. `agent_auth` accepts `configuration_root` on `start`. The auth session keeps it, and `respond`, `cancel` or `status` for that session with a different root get `AGENT_CONFIGURATION_ROOT_REJECTED`. `status` returns `account_label`: the `email` field of `claude auth status --json`, or null when not logged in or absent. No tokens anywhere.
  - No reset-time parsing is needed; execution reads it from usage.
  - E6 (agreed by Elegg 2026-11-11, Aiterm 0.70.23): the real record is `type:'assistant', isApiErrorMessage:true, error:'authentication_failed'` with no `apiErrorStatus`, text `Login expired · Please run /login` or `Not logged in · Please run /login` (CLI 2.1.310/2.1.319). Matcher in order: a rate limit or 429 stays `rate_limited`; then error kind `authentication_failed`, or `apiErrorStatus` 401, or (only for a record with neither) the text `Please run /login` / `OAuth token revoked` / `Invalid API key`. Result `failure.category:'authentication'`, the text in `wait.error`, also when Stop fires after it; `error_kind` stays `http_<status>` or null. The parent-delivery record's `category` gains the value; execution reads categories as plain strings (no closed enum).
  - E7 (agreed by Elegg 2026-11-11, Aiterm 0.70.23, body and terminals): for claude-code, `CLAUDE_CODE_OAUTH_TOKEN` is the login, not a recipe setting. A resume through `agent_launch` (`session_name` of a hibernated seat, with or without `require_existing_resume`) with `env_vars` leaves that name out of the env-name comparison on both sides; any other difference still conflicts. Named with a value: the launch value (private env line first on a terminal, then process env), stored in the new recipe. Named without a value or not named: the new recipe drops it and the seat resumes on the root's own login. `env_vars` omitted: the stored recipe unchanged. Resume values go through the same 0600 launch-env file as a fresh launch (never typed into the pane line).
    - Aiterm's own resume on `pty_send` / dispatch of a hibernated seat uses the stored recipe, so it keeps the older token. Execution's exit for that case is E6: the seat's failure finds its launch stamp older than the token file (`stale`), and only that seat gets a new seat plus the continuation message.
- Mika (usage), one login per slot (requested 2026-11-11): HarnessAuth uses the token login for every Claude slot: `login:'oauth_token'`, `token_file: prepared.tokenFile` (1st too; the 1st fallback without `accounts.prepare` keeps today's CLI login). The 「2つ目のアカウント」 wording of `HARNESS_AUTH_LOGIN_UNSUPPORTED` names the slot instead.
- Mika (usage), agreed 2026-11-08:
  - During an open slot auth session with existing credentials (accounts.list loggedIn=true or the pre-start status authenticated), usage reports waiting (認証中) with the existing account label; blocked means no credentials, and execution seat selection is unchanged.
  - HarnessAuth sessions and receipts are keyed by `(harness, slot)`; no slot means 1st, and non-Claude behavior is unchanged.
  - `slot` stays outside the strict authResponse binding, prompt digest and response object.
  - The selected slot is prepared (`accounts.prepare`) before every `agent_auth` action, and `configuration_root` is passed only privately.
  - Receipts carry `slot` and the nullable native `account_label`.
  - The typed account-card data contact covers both slot rows (login state, label, per-scope limits with reset, seats), and `allLimited`/`earliestResetAt`, all from `accounts.list()`.
- Molly (parent, common HTTP/MCP): the route for `accounts.list` (the `POST /api/accounts/rules` route is removed), private port injection, SSE topic `settings`, and `account: seatAccount(botId)` in Bot items.
- Clients (Admi for Web; the Apple and Windows owners): render the two slot rows 「1stアカウント」/「2ndアカウント」, the both-limited banner, and the seat's slot on the member card. A limit shows its scope: `'all'` as 「上限中 (HH:MMに解除)」, a family as 「Fableのみ上限中 (23:00に解除)」. Times are shown in JST (with the date when it is not today); a null reset shows as 解除時刻不明.

## Live acceptance (Owner's definition 2026-11-09 06:3x JST: a real limit, per model)

A test member (Claude, Fable) is the subject. No quota is burned on purpose and no limit text is faked.

1. Precondition: the 1st is limited for Fable for real, both slots are logged in, and E5 is live.
2. The member's first Fable turn really runs on the 1st: it was launched on the 1st, and its model is changed to Fable in place. The turn ends with the real limit record.
3. Expected: the (1st, fable) entry is recorded with the raw text and `resetAt`. A new seat of the member starts on the 2nd (old 1st seat left running), the continuation message is sent to it, and the same work completes on the 2nd from the Throughline handoff. The member card shows 2ndアカウント.
4. Change the member to Opus: it goes back to the 1st at the next idle boundary and answers there. Change it back to Fable: it goes to the 2nd.
5. At `resetAt` the entry clears, and Fable seats go back to the 1st at their next idle boundary. Record the actual time against `resetAt`.

## Not covered

- The limit text and the usage endpoint are Claude Code's own output, not a documented API. If a new wording or a changed endpoint gives no time, `resetAt` is null, and the 10-minute re-read plus the successful-turn exit still return the slot. The parser keeps the observed forms above as fixtures.
- Legacy 1st is never marked signed out (no stamp): until the Owner's first 1st login in the card, a terminal seat on the 1st still needs the host's own login, as before.
- A token that stops working is seen only when a seat's turn fails (E6); there is no background probe. A slot nobody uses stays shown as logged in until then.
- The label of a token slot is the root's recorded e-mail (`.credentials.json` login), not the token's account: a setup-token cannot read the profile endpoint (403, user:inference only). Display only.
- A slot logged in again under running seats (production 2026-11-09 06:04 JST, 1st changed to another account): the running seats kept answering. Which account a running seat bills until its next launch is not observable without reading tokens, so it is unverified.
- Codex and other harnesses: no slots now. Adding them means one more root kind (`CODEX_HOME`) in `prepare`, E1–E3 for that harness, and its own limit signal.
