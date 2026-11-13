# Web: function map (screens -> functions -> public HTTP)

What the user can do in the Web app, which screen offers it, which view file owns it, and which public HTTP it uses. The paths between screens (states, buttons, failure exits, broken spots) are in [user paths](user-paths.md). Startup, the HTTP/SSE client and asset registration are in the [README](README.md#起動通信公開登録). The Web never calls MCP and never owns server state.

```mermaid
flowchart LR
  subgraph Shell["App shell (app.js, application.js, client.js)"]
    Boot["Boot: session -> settings -> setup -> list -> SSE"]
    Banner["App banner: reconnecting / stopped / app-level errors"]
  end
  subgraph Home["Home"]
    Roster["Roster: members, rooms, search, loading / error / stale / empty<br/>application.js, roster-view.js, roster-search.js, activity-order.js"]
    Header["Header: 設定 / 予定 / ゴール / 相関図 / 工程表 / 追加, 更新 badge<br/>index.html, application.js, update-center.js (badge)"]
  end
  subgraph Chat["Conversation"]
    Timeline["Timeline + cards<br/>conversation-timeline.js, owner-question.js, secret-input.js, message-images.js, image-gallery.js"]
    Composer["Composer, reply targets, stop<br/>conversation-composer.js, chat-input.js, member-stop.js"]
    ChatTools["Header tools: current work, screen, goal chip, … menu<br/>current-work.js, bot-read-views.js, goals.js"]
  end
  subgraph Settings["Settings (home list + pages)"]
    SProfile["プロフィール / チームの決まり<br/>owner-editor.js, avatar-editor.js"]
    SAI["AIの認証<br/>harness-auth.js, harness-accounts.js, auth-flow.js"]
    SSum["仕事の要約を書くAI<br/>background-agent-settings.js"]
    SStop["全体停止<br/>ai-control.js"]
    SExcl["稼働中に数えない処理<br/>running-exclusions.js"]
    SFeat["1Password / 追加機能<br/>onboarding.js (feature renderer)"]
    SNotif["通知<br/>web-push.js, sw.js, notification-*.js"]
    SConn["接続 / 表示 / 利用と購読<br/>owner-editor.js, server-origin.js, view-preferences.js"]
  end
  subgraph Dialogs["Dialogs"]
    Upd["更新センター<br/>update-center.js"]
    Sched["予定: all + per target<br/>schedules-overview.js, schedule-editor.js"]
    Goals["ゴール<br/>goals.js"]
    Graph["相関図<br/>work-graph.js, work-graph-model.js"]
    Member["メンバー編集 / 追加<br/>bot-editor.js, avatar-editor.js, folder-picker.js"]
    Room["ルーム編集 / 作成<br/>room-editor.js"]
    Memory["記憶と知識<br/>memory-view.js"]
    Sheet["キャラクターシート<br/>bot-read-views.js"]
    Term["端末<br/>terminals.js"]
    Onb["初回設定<br/>onboarding.js, auth-flow.js"]
  end
  Boot --> Home
  Boot --> Onb
  Header --> Settings
  Header --> Sched
  Header --> Goals
  Header --> Graph
  Header --> Upd
  Header --> Member
  Header --> Room
  Roster --> Chat
  ChatTools --> Member
  ChatTools --> Room
  ChatTools --> Sched
  ChatTools --> Memory
  ChatTools --> Sheet
  SAI -.same stage function.-> Onb
  Settings --> Term
  Settings --> Upd
  Shell -->|"client.api / fetchImage / watchEvents"| HTTP["integration HTTP/SSE"]
```

| Function | Screen | Reads | Writes | Owner of the data |
| --- | --- | --- | --- | --- |
| Boot, session, setup phase | shell | `GET /api/session`, `GET /api/settings`, `GET /api/setup` | — | integration, onboarding |
| Live updates | shell | `GET /api/events` (SSE) | — | integration |
| Member and room list | roster | `GET /api/bots?avatar=omit`, `GET /api/rooms`, `GET /api/owner`, avatars `GET /api/bots/:id/avatar` | — | members |
| Account limit banner | roster | `GET /api/accounts` | — | execution |
| Conversation history and queue | timeline | `GET /api/{bots,rooms}/:id/messages`, `GET …/queue` | — | conversation |
| Send, stop | composer | — | `POST /api/{bots,rooms}/:id/messages`, `POST /api/bots/:id/stop` | conversation, execution |
| Export | chat … menu | `GET /api/{bots,rooms}/:id/export` | — | conversation |
| Owner question, secret request | cards | `GET /api/secret-requests/:id/onepassword-items` | `POST /api/owner-questions/:id/answer`, `POST /api/secret-requests/:id/{submit,cancel}` | usage |
| Screen panel | chat | `GET /api/bots/:id/screen`, `GET …/screen/approval` | `POST …/screen/key`, `POST …/screen/approval` | execution |
| Goal | chat chip, goals dialog | `GET /api/bots/:id/goal`, `GET /api/goals` | `POST /api/bots/:id/goal` | goals owner |
| Owner profile, rules | settings | `GET /api/owner`, `GET /api/user-rules` | `PATCH /api/owner`, `PUT /api/user-rules` | members (owner), rules |
| AI auth | settings, onboarding | `GET /api/harness-auth[/:h]`, `GET /api/accounts` | `POST /api/harness-auth/:h/{start,input,cancel}[?slot=2nd]`, `POST /api/setup/{harness,start,auth/input}` | usage (HarnessAuth), execution |
| Summary AI | settings | `GET /api/settings`, `GET /api/models` | `PATCH /api/settings/backgroundAgent` | settings |
| Whole stop | settings | `GET /api/ai-control` | `PATCH /api/ai-control` | execution |
| Processes not counted as working (a63) | settings | `GET /api/running-exclusions`, member names from the list read | `DELETE /api/running-exclusions/:id` | execution ([current work](../execution/current-work.md) "Owner read and remove (a62)") |
| Features, 1Password | settings | `GET /api/settings` | `PATCH /api/settings/:id` | settings |
| Notifications | settings | `GET /api/web-push/status`, `POST /api/web-push/status`, `GET /api/notifications` | `POST /api/web-push/subscriptions`, `POST /api/web-push/unregister` | notifications |
| Connection, display | settings | `location.origin`, localStorage | localStorage, a new tab | this browser |
| Updates | update center | `GET /api/updates`, operation GETs, SSE `updates` | `POST /api/updates/catalog-check`, `POST /api/updates/plans`, `POST /api/updates/operations` | runtime, distribution |
| Schedules | schedule dialogs | `GET /api/schedules`, `GET /api/{bots,rooms}/:id/schedules` | `POST`, `PUT …/:sid`, `DELETE …/:sid`, `POST …/:sid/run` | schedules |
| Work graph | 相関図 | `GET /api/work-graph/events` (SSE) | — | work-graph |
| Member edit and add | member editor | `GET /api/bots/:id`, `GET /api/models`, `GET /api/terminals`, `GET /api/terminals/:id/folders` | `POST /api/bots`, `PATCH /api/bots/:id`, `POST …/restart`, `DELETE /api/bots/:id`, `POST /api/terminals/:id/folder` | members |
| Room edit and create | room editor | list | `POST /api/rooms`, `PATCH /api/rooms/:id`, `DELETE /api/rooms/:id` | members |
| Memory and knowledge | memory dialog | `GET /api/bots/:id/{memory,knowledge}` | `POST /api/bots/:id/{memory,knowledge}` | memory |
| Character sheet | sheet dialog | `GET /api/bots/:id/character-sheet` | — | members |
| Terminals | terminals dialog | `GET /api/terminals[/:id]` | `PUT`, `DELETE`, `POST …/check`, `…/keys/{ssh,sudo}`, `…/keys/ssh/authorize` | terminals |

The UI overhaul in [user paths](user-paths.md) changes screens, words, layout and where results appear. It does not add or change any public HTTP except the open points listed there (O1 `required` flag, O4 last-check result), which go to their owners first.
