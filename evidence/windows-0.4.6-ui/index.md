# Windows app 0.4.6 — every screen (fox, 2026-11-11 JST)

Rendered by the installed `BellTeam.exe` 0.4.6+2a824d51 through its `--render-*` entries (offscreen WPF render; the seat runs in session 0, so no live desktop capture).
- **prod**: connected to production `http://192.168.1.2:18891/` (GET only). States marked *seam* are set locally by the render over production data, never sent.
- **fixture**: states production cannot show now (login, onboarding, secret cards, limited accounts, old server, offline...), rendered from the repo mock `windows/BellTeam.Tests/fixtures/mac-ui-reference.mjs` (mock counted 0 writes).

| File | Source | Screen |
|---|---|---|
| windows-main-member.png | prod | Main window, member conversation (Anis) |
| windows-main-member-trony.png | prod | Main window, member conversation (Trony) |
| windows-main-room.png | prod | Main window, room conversation (アーク中枢) |
| windows-conversation-member.png | prod | Conversation scene 'member' on Trony |
| windows-conversation-draft.png | prod + seam | Conversation scene 'draft' on Trony |
| windows-conversation-stop-notice.png | prod + seam | Conversation scene 'stop-notice' on Trony |
| windows-conversation-echo.png | prod + seam | Conversation scene 'echo' on Trony |
| windows-conversation-stop-member.png | prod | Conversation scene 'stop-member' on Trony |
| windows-conversation-stack.png | prod | Conversation scene 'stack' on Trony |
| windows-conversation-fork.png | prod | Conversation scene 'fork' on Trony |
| windows-conversation-secret.png | prod | Conversation scene 'secret' on Trony |
| windows-conversation-peer-sheet.png | prod | Conversation scene 'peer-sheet' on Trony |
| windows-conversation-empty.png | prod | Conversation scene 'empty' on Trony |
| windows-conversation-room-room.png | prod | Conversation scene 'room' on room アーク中枢 |
| windows-conversation-room-stop.png | prod | Conversation scene 'stop' on room アーク中枢 |
| windows-conversation-room-states.png | prod | Conversation scene 'states' on room アーク中枢 |
| windows-inspector-member.png | prod | Inspector 'member' on Anis |
| windows-inspector-restart-busy.png | prod + seam | Inspector 'restart-busy' on Anis |
| windows-inspector-restart-success.png | prod + seam | Inspector 'restart-success' on Anis |
| windows-inspector-sheet-small.png | prod | Inspector 'sheet-small' on Anis |
| windows-inspector-sheet-large.png | prod | Inspector 'sheet-large' on Anis |
| windows-inspector-sheet-unsupported.png | prod | Inspector 'sheet-unsupported' on Anis |
| windows-inspector-pending.png | prod + seam | Inspector 'pending' on Anis |
| windows-inspector-pending-sheet.png | prod + seam | Inspector 'pending-sheet' on Anis |
| windows-inspector-room.png | prod | Inspector on room アーク中枢 |
| windows-screen-keys.png | prod + seam | Bot screen 'keys' on Trony |
| windows-screen-digits.png | prod + seam | Bot screen 'digits' on Trony |
| windows-screen-sent.png | prod + seam | Bot screen 'sent' on Trony |
| windows-goals-page.png | prod | Goals page |
| windows-goals-pill-available.png | prod | Goal pill on Epinel (goal available, none set) |
| windows-goals-pill-open-available.png | prod | Goal pill-open on Epinel (goal available, none set) |
| windows-goals-editor-create-available.png | prod | Goal editor-create on Epinel (goal available, none set) |
| windows-goals-editor-edit-available.png | prod | Goal editor-edit on Epinel (goal available, none set) |
| windows-goals-pill-unavailable.png | prod | Goal pill on Anis (goal unavailable) |
| windows-goals-pill-open-unavailable.png | prod | Goal pill-open on Anis (goal unavailable) |
| windows-schedules-page.png | prod | Schedules page |
| windows-schedules-list.png | prod | Schedules 'list' |
| windows-schedules-delete.png | prod + seam | Schedules 'delete' |
| windows-schedules-editor-member.png | prod | Schedules 'editor-member' |
| windows-schedules-editor-room.png | prod | Schedules 'editor-room' |
| windows-schedules-editor-interval.png | prod | Schedules 'editor-interval' |
| windows-settings-top.png | prod | Settings, first page |
| windows-settings-lower.png | prod | Settings, scrolled to bottom |
| windows-settings-profile.png | prod | Settings page profile |
| windows-settings-ai.png | prod | Settings page ai |
| windows-settings-terminals.png | prod | Settings page terminals |
| windows-settings-features.png | prod | Settings page features |
| windows-settings-notifications.png | prod | Settings page notifications |
| windows-settings-connection.png | prod | Settings page connection |
| windows-settings-display.png | prod | Settings page display |
| windows-settings-billing.png | prod | Settings page billing |
| windows-settings-update.png | prod | Settings page update |
| windows-settings-about.png | prod | Settings page about |
| windows-settings-stop.png | prod | Settings page stop |
| windows-settings-onepassword-not-linked.png | prod | 1Password link sheet (not-linked) |
| windows-update-updates.png | prod | Update updates |
| windows-update-updates-narrow.png | prod | Update updates-narrow |
| windows-update-updates-detail-narrow.png | prod + seam | Update updates-detail-narrow |
| windows-update-update-sheet.png | prod | Update update-sheet |
| windows-terminals-list.png | prod | Terminals 'list' |
| windows-terminals-detail-auth-failed.png | prod + seam | Terminals 'detail-auth-failed' |
| windows-terminals-detail-hostkey.png | prod + seam | Terminals 'detail-hostkey' |
| windows-terminals-detail-windows.png | prod + seam | Terminals 'detail-windows' |
| windows-terminals-detail-authorizing.png | prod + seam | Terminals 'detail-authorizing' |
| windows-terminals-detail-this-pc-mismatch.png | prod + seam | Terminals 'detail-this-pc-mismatch' |
| windows-terminals-keys.png | prod + seam | Terminals 'keys' |
| windows-terminals-keys-pending.png | prod + seam | Terminals 'keys-pending' |
| windows-terminals-hostkey-sheet.png | prod + seam | Terminals 'hostkey-sheet' |
| windows-terminals-editor-macos.png | prod | Terminals 'editor-macos' |
| windows-terminals-editor-windows.png | prod | Terminals 'editor-windows' |
| windows-terminals-editor-linux.png | prod | Terminals 'editor-linux' |
| windows-terminals-editor-this-pc.png | prod + seam | Terminals 'editor-this-pc' |
| windows-terminals-editor-this-pc-refused.png | prod + seam | Terminals 'editor-this-pc-refused' |
| windows-editor-member-window.png | prod | Member editor window (Anis) |
| windows-editor-settings-window.png | prod | Settings editor window |
| windows-auth-claude.png | prod | Re-authentication window for claude |
| windows-auth-codex.png | prod | Re-authentication window for codex |
| windows-auth-grok.png | prod | Re-authentication window for grok |
| windows-auth-cursor.png | prod | Re-authentication window for cursor |
| windows-auth-antigravity.png | prod | Re-authentication window for antigravity |
| windows-editors-new-member.png | prod | Editor scene 'new-member' (Anis) |
| windows-editors-new-room.png | prod | Editor scene 'new-room' (Anis) |
| windows-editors-crop.png | prod + seam | Editor scene 'crop' (Anis) |
| windows-editors-member.png | prod | Editor scene 'member' (Anis) |
| windows-editors-member-delete-alert.png | prod + seam | Editor scene 'member-delete-alert' (Anis) |
| windows-editors-member-delete-pending.png | prod + seam | Editor scene 'member-delete-pending' (Anis) |
| windows-editors-member-delete-unconfirmed.png | prod + seam | Editor scene 'member-delete-unconfirmed' (Anis) |
| windows-editors-folder-new.png | prod + seam | Editor scene 'folder-new' (Anis) |
| windows-editors-folder-new-windows.png | prod + seam | Editor scene 'folder-new-windows' (Anis) |
| windows-editors-folder-new-missing.png | prod + seam | Editor scene 'folder-new-missing' (Anis) |
| windows-editors-folder-new-typed.png | prod + seam | Editor scene 'folder-new-typed' (Anis) |
| windows-editors-folder-picker.png | prod | Editor scene 'folder-picker' (Anis) |
| windows-editors-folder-picker-sub.png | prod | Editor scene 'folder-picker-sub' (Anis) |
| windows-editors-room.png | prod | Room editor 'room' (アーク中枢) |
| windows-editors-room-delete-alert.png | prod + seam | Room editor 'room-delete-alert' (アーク中枢) |
| windows-startup-opening.png | prod | Startup 'opening' |
| windows-startup-setup.png | prod | Startup 'setup' |
| windows-startup-guide.png | prod | Startup 'guide' |
| windows-startup-banner.png | prod | Startup 'banner' |
| windows-startup-failure.png | prod + seam | Startup failure (unreachable server) |
| windows-workgraph.png | prod | 相関図 window |
| windows-conversation-room-room-shikenban.png | prod + seam | retry shot (conversation-room-room-shikenban) |
| windows-inspector-restart-success-trony.png | prod + seam | retry shot (inspector-restart-success-trony) |
| windows-accounts-both-limited-fixture.png | fixture | accounts / both-limited |
| windows-accounts-member-card-fixture.png | fixture | accounts / member-card |
| windows-accounts-normal-fixture.png | fixture | accounts / normal |
| windows-accounts-old-server-fixture.png | fixture | accounts / old-server |
| windows-accounts-one-limited-fixture.png | fixture | accounts / one-limited |
| windows-accounts-unlogged-fixture.png | fixture | accounts / unlogged |
| windows-gallery-gallery-fixture.png | fixture | gallery / gallery |
| windows-goals-cards-codex-fixture.png | fixture | goals / cards-codex |
| windows-goals-cards-fixture.png | fixture | goals / cards |
| windows-goals-editor-create-error-fixture.png | fixture | goals / editor-create-error |
| windows-goals-editor-edit-separate-fixture.png | fixture | goals / editor-edit-separate |
| windows-goals-empty-fixture.png | fixture | goals / empty |
| windows-goals-pill-open-active-fixture.png | fixture | goals / pill-open-active |
| windows-goals-pill-open-unset-fixture.png | fixture | goals / pill-open-unset |
| windows-goals-pill-fixture.png | fixture | goals / pill |
| windows-memberfolder-folder-picker-created-fixture.png | fixture | memberfolder / folder-picker-created |
| windows-memberfolder-folder-picker-home-fixture.png | fixture | memberfolder / folder-picker-home |
| windows-memberfolder-folder-picker-offline-fixture.png | fixture | memberfolder / folder-picker-offline |
| windows-memberfolder-folder-picker-subfolder-fixture.png | fixture | memberfolder / folder-picker-subfolder |
| windows-memberfolder-folder-picker-unsupported-fixture.png | fixture | memberfolder / folder-picker-unsupported |
| windows-memberfolder-folder-picker-windows-fixture.png | fixture | memberfolder / folder-picker-windows |
| windows-memberfolder-member-editor-folder-missing-offer-create-fixture.png | fixture | memberfolder / member-editor-folder-missing-offer-create |
| windows-memberfolder-member-editor-old-server-fixture.png | fixture | memberfolder / member-editor-old-server |
| windows-memberfolder-member-editor-terminal-folder-windows-fixture.png | fixture | memberfolder / member-editor-terminal-folder-windows |
| windows-memberfolder-member-editor-terminal-folder-fixture.png | fixture | memberfolder / member-editor-terminal-folder |
| windows-memberfolder-member-editor-typed-path-fixture.png | fixture | memberfolder / member-editor-typed-path |
| windows-onepassword-1password-checking-fixture.png | fixture | onepassword / 1password-checking |
| windows-onepassword-1password-failure-fixture.png | fixture | onepassword / 1password-failure |
| windows-onepassword-1password-not-linked-fixture.png | fixture | onepassword / 1password-not-linked |
| windows-onepassword-1password-success-fixture.png | fixture | onepassword / 1password-success |
| windows-schedules-delete-fixture.png | fixture | schedules / delete |
| windows-schedules-editor-interval-fixture.png | fixture | schedules / editor-interval |
| windows-schedules-editor-member-fixture.png | fixture | schedules / editor-member |
| windows-schedules-editor-room-fixture.png | fixture | schedules / editor-room |
| windows-schedules-editor-weekly-error-fixture.png | fixture | schedules / editor-weekly-error |
| windows-schedules-empty-fixture.png | fixture | schedules / empty |
| windows-schedules-failed-fixture.png | fixture | schedules / failed |
| windows-schedules-list-fixture.png | fixture | schedules / list |
| windows-screen-approval-fixture.png | fixture | screen / approval |
| windows-screen-digits-error-fixture.png | fixture | screen / digits-error |
| windows-screen-empty-fixture.png | fixture | screen / empty |
| windows-screen-keys-fixture.png | fixture | screen / keys |
| windows-screen-offline-fixture.png | fixture | screen / offline |
| windows-screen-read-failed-fixture.png | fixture | screen / read-failed |
| windows-screen-sent-fixture.png | fixture | screen / sent |
| windows-secret-login-fixture.png | fixture | secret / login |
| windows-secret-old-fixture.png | fixture | secret / old |
| windows-secret-onetime-fixture.png | fixture | secret / onetime |
| windows-secret-reference-fixture.png | fixture | secret / reference |
| windows-secret-ssh-search-fixture.png | fixture | secret / ssh-search |
| windows-secret-sudo-list-fixture.png | fixture | secret / sudo-list |
| windows-secret-sudo-vault-fixture.png | fixture | secret / sudo-vault |
| windows-startup-banner-fixture.png | fixture | startup / banner |
| windows-startup-failure-fixture.png | fixture | startup / failure |
| windows-startup-guide-fixture.png | fixture | startup / guide |
| windows-startup-login-fixture.png | fixture | startup / login |
| windows-startup-onboarding-choose-fixture.png | fixture | startup / onboarding-choose |
| windows-startup-onboarding-waiting-fixture.png | fixture | startup / onboarding-waiting |
| windows-startup-opening-fixture.png | fixture | startup / opening |
| windows-startup-server-setup-fixture.png | fixture | startup / server-setup |
| windows-terminals-hostkey-sheet-fixture.png | fixture | terminals / hostkey-sheet |
| windows-terminals-terminal-detail-auth-failed-fixture.png | fixture | terminals / terminal-detail-auth-failed |
| windows-terminals-terminal-detail-authorizing-fixture.png | fixture | terminals / terminal-detail-authorizing |
| windows-terminals-terminal-detail-hostkey-other-ways-fixture.png | fixture | terminals / terminal-detail-hostkey-other-ways |
| windows-terminals-terminal-detail-windows-refused-fixture.png | fixture | terminals / terminal-detail-windows-refused |
| windows-terminals-terminal-editor-os-linux-fixture.png | fixture | terminals / terminal-editor-os-linux |
| windows-terminals-terminal-editor-os-macos-fixture.png | fixture | terminals / terminal-editor-os-macos |
| windows-terminals-terminal-editor-os-windows-fixture.png | fixture | terminals / terminal-editor-os-windows |
| windows-terminals-terminal-keys-pending-and-unset-fixture.png | fixture | terminals / terminal-keys-pending-and-unset |
| windows-terminals-terminal-keys-set-and-unset-fixture.png | fixture | terminals / terminal-keys-set-and-unset |
| windows-terminals-terminal-list-old-server-fixture.png | fixture | terminals / terminal-list-old-server |
| windows-terminals-terminal-list-unavailable-fixture.png | fixture | terminals / terminal-list-unavailable |
| windows-terminals-terminal-list-fixture.png | fixture | terminals / terminal-list |

## Not captured
- prod `conversation-room-peer-sheet`, `schedules-editor-weekly-error`: render seams expect fixture data (a peer message / the fixture schedule); see the fixture shots instead.
- prod gallery: no production conversation checked (Anis, Trony) has images; see `windows-gallery-gallery-fixture.png`.
- prod goal `editor-edit`: no production Bot has a goal set; `goals-editor-edit-available` shows what the render produced, fixture has `goals-editor-edit-separate`.
- Native OS dialogs (MessageBox, toast notifications, folder chooser of the OS) and the tray: no render entry, session 0 has no desktop.
- Terminals page: the 「このPC」 facts (name, addresses) are the render stub, not fox.
