# AI CLI not installed: wait, notice, continue (a451)

Owner: Kiro (execution). Requested by Trony 2026-11-19 (plan: bot-7b140b27 docs/plan_no-bundled-cli-20261119.md, task a451-launch-not-installed). Owner ruling 2026-11-19 16:2x JST: the image carries no AI CLI; the user installs the latest with a button in AIの認証. Contract with Mika (usage, task a451-install-ai-cli): [usage/harness-cli.md](../usage/harness-cli.md) (a451a, her canonical text). This document is execution's side only.

## Contact used (usage -> execution)

`harnessCli.installed()` -> `{ claude, codex, grok, cursor }`, each `{ state, version, source }`; synchronous, answered from usage's cached probe. `harnessCli.watch(listener)` -> listener({ harness, state, version, source }) on every change, returns an unsubscribe. Keys are the Bot.harness ids. `state`: `installed` | `not_installed` | `installing` | `failed` | `checking` (before usage's first probe ends). Execution never probes the filesystem and never installs.

How it reaches the code:
- Engine: one more injected port key `harnessCli` ({ installed, watch }), passed only to engines that export `EXECUTION_HARNESS_CLI` (older engines reject unknown port keys), mounted by Molly's `application-services`. The seat gate lives in `AitermTransport`.
- Parent: `LiveModelCatalog` (model catalog) and `createBackgroundSummaryRunner` (summary runner) are parent-resident and read the same object from `usageAssembly.harnessCli`.
- Absent window (older usage module, no port): every CLI is treated as installed and nothing changes. An unknown `state` value is treated as installed too: unknown is not a reason to stop.

## Functions

| ID | Function: input -> output | Code |
| --- | --- | --- |
| N1 | `harnessCliWait(port, harness)` -> null (ready or window absent) or `{ state, notice }`; `notice` is null for `checking` | `src/harness-cli-wait.mjs` |
| N2 | Seat launch gate: `wakeNow` of a **local** Bot asks N1 before anything is prepared or launched. Waiting -> error `BOT_AWAITING_USER` (409, `effect: not_started`, `reason: HARNESS_NOT_INSTALLED`), no Aiterm call. Remote terminals are not gated (the CLI is on the user's machine; their path is unchanged) | `AitermTransport.wakeNow` |
| N3 | Notice: `seatLaunch(botId)` returns `{ code: 'HARNESS_NOT_INSTALLED', action: notice, terminalId: null, at }` while a local Bot waits with a notice. Set by N2, cleared by a launch that passes N1 or by N4. Each set/clear emits `{topics:['bots'], botIds:[]}` like the remote notice. Bot DTO key stays `seatLaunch` | `AitermTransport.seatLaunch` |
| N4 | `watch` change for a harness: a Bot waiting on that harness whose state is now ready (`installed`, or a value N1 does not know) -> notice cleared and `emitQueue({ bot: { id } })`, the existing queue edge that drains the saved IDs; a still-waiting change (`installing` -> `failed`) only rewrites the notice text | `AitermTransport.cliChanged` |
| N5 | A local `agent_launch` that Aiterm answered with a failure while the window says `installed` (the user may have removed the CLI behind our back; Aiterm has no "CLI absent" token): `harnessCli.recheck(harness)` once; when it now says not installed, the same wait as N2; otherwise the failure is reported as today | `AitermTransport.wakeNow` catch |
| N6 | Model catalog: `forHarness(harness)` waiting -> `ModelCatalogError('HARNESS_NOT_INSTALLED', harness, notice)`; `list()` returns that harness as `{ efforts: [], models: [], error: { code, message: notice } }` (the existing shape). Not a defect: no filing | `LiveModelCatalog` |
| N7 | Summary runner: waiting -> `BACKGROUND_SUMMARY_CLI_NOT_INSTALLED`, a summary failure is one stderr line and no summary yet (`team-background-summary.mjs` files nothing); a new input after the install enqueues it again (the owner never retries one attempt) | `createBackgroundSummaryRunner` |

Notice sentences (Mika 2026-11-19; the AI name is Claude / Codex / Grok / Cursor):
- `not_installed`: 「<AI名>がまだ入っていません。AIの認証から入れてください」
- `installing`: 「<AI名>を入れています。終わるまでお待ちください」
- `failed`: 「<AI名>を入れられませんでした。AIの認証からもう一度入れてください」
- `checking`: no notice (it ends by itself and `watch` fires).

## Data flow

```mermaid
flowchart TD
  Probe[usage: probe at start, after each install press] --> Cache[(usage cached state per harness)]
  Cache -->|installed() sync| Gate{N2 wakeNow gate, local Bot}
  Gate -->|installed or window absent| Launch[existing launch: agent_launch]
  Gate -->|not ready| Refuse[BOT_AWAITING_USER reason HARNESS_NOT_INSTALLED, not_started, no Aiterm call]
  Refuse --> Queued[durable receipt stays queued, no failed status row, no BugHub filing, assembly skips the Bot]
  Refuse --> Notice[N3 seatLaunch notice on the member, bots topic]
  Cache -->|watch change| Changed[N4 cliChanged]
  Changed -->|ready| Clear[clear notice]
  Clear --> Edge[emitQueue bot id: existing queue edge]
  Edge --> Queued
  Queued -->|drain, same ID| Gate
  Launch -->|not_started, no cause code, state installed| Recheck[N5 recheck once]
  Recheck -->|not installed| Refuse
  Cache -->|installed()| Catalog[N6 model catalog]
  Cache -->|installed()| Summary[N7 summary runner]
```

## Guards

| Guard | Protects | Exit |
| --- | --- | --- |
| N2 refuses a local launch while the CLI is not ready | a launch of a CLI that is not there (it would end as a launch failure and be filed as a defect) and a message typed into nothing | usage's `watch` reports a ready state (the user pressed the install button, the probe saw it), N4 drains the same IDs; the assembly's own 60 s awaiting review is a second exit |

A refused delivery is never a failure: it is queued (not_started), shown to the member, and continues by itself. Nothing is lost; nothing is filed.

## Not covered

Remote terminals (their CLI is on the user's machine; today's path and notice stay). Installing, version, login and the install button (usage, Mika; the place Molly). Aiterm has no "CLI absent" token; this design does not need one.
