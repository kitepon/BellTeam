# SEC-014 stage 2: implementation in progress

This branch implements the approved staged-A boundary. Stage 1 is already
deployed. This branch is not a deployable stage-2 release yet. It does not change
the running server, credentials, owners, mounts, or container user.

## Integration with the current owners (2026-10-25)

The branch is integrated with main `85a91b218f5cd05bea70a2f292a41755778b6fcc`.
The seat SDK option belongs to `aiterm-client.mjs`, Throughline reads to
`throughline-context.mjs`, and wait-process reads to `aiterm-wait-process.mjs`.
`AitermTransport` selects the target's seat launch options without restoring the
old transport implementation. The existing native interruption and returned
execution-error classification are retained; the seat-side launch result also
retains that typed execution error.

Client listing and pending deletion semantics now belong to `http-bot-api.mjs`.
The registry keeps its separate state path and emits the current schedule-change
notification after saving there. Optional seat commands preserve the current
command cancellation path and accept its caller-provided signal.

This is source integration of the previously accepted components. The branch now wires the seat adapters into bootstrap and application services,
as described below. Complete state migration, the final image/installer and
protected mounts, latest-state rollback, four real CLI integrations and downtime
measurement remain unaccepted.

## First component: fixed SCE maintenance entry

`scripts/install-sce-headers.py` is source for the agreed root-owned host entry
`/home/kite/BellTeam/runtime/server-only/bin/install-sce-headers`.
It must be installed as a root-owned copy, with protected parents, before use.
Executing the developer checkout is not the deployment method.

The CLI takes no arguments. Its fixed destination is
`/home/kite/BellTeam/runtime/server-only/bughub/headers`. The parent must be
root-owned 0711; the existing file must be a single-link regular 0600 file owned
by UID/GID1001. The script opens path components without following symlinks,
then uses directory-relative operations. The deployment will also need to
establish that the ordinary container seat cannot replace any parent or mount.
This component alone does not verify host mount topology or user allocation.

The input contract is one complete `x-bughub-security-token: VALUE` line ending
with LF or CRLF, at most 8192 bytes. Empty, incomplete, extra-header, whitespace
token, and invalid inputs are rejected before opening the destination. The
content/update decision and approved supply path belong to Fragile; this entry
does not fetch, issue, authenticate, log, or hash a credential.

The supplier must close stdin after the complete line. A newline alone does
not complete `read(MAX_INPUT + 1)`; the entry waits for EOF. The future supply
adapter must explicitly end the input stream and await the exit result. It must
not leave a pipe open while waiting for the installer to finish.

The entry writes a newly created private temporary file, sets ownership, syncs
the new file, then atomically renames it within the same directory. Input,
write, ownership, and sync failures before the rename preserve the live file.
A temporary filename is eligible for cleanup only after this invocation has
created it. The rename is the commit point. This is not a guarantee against
power loss, SIGKILL, or a lost acknowledgement after commit. Backup, recovery,
and preserving the latest credential generation on rollback are not implemented
by this component. Do not restore an older credential generation to compensate
for an unknown acknowledgement.

No credential or content hash is emitted. Python is invoked with `-I` so user
site packages, the script directory, and `PYTHON*` variables do not supply
modules to the privileged entry. The interpreter and installed source still
need to be root-owned and protected in the deployment.

## Current execution inventory

The optional `AitermClient({seatProject, command, args})` uses
`seatCommandSpec` to start its stdio MCP through the root-installed
`/usr/local/libexec/bellteam-seat-exec`. No server environment is passed.
The C entry clears the environment and drops real/effective/saved UID and GID
to 1000 with empty supplementary groups before executing Node or seat files.
`run-seat-command.mjs` checks the seat identity, evaluates `env.sh` there, and
starts the command with stdin/stdout preserved. Environment preparation and
the command each have a process group; TERM/INT/HUP are forwarded and a
stopping group receives KILL after 250ms. Exit and failure results are kept.
This is the approved staged-A accident boundary; bell's existing management
sudo capability remains deliberately available.

The branch bootstrap/application services now select the seat option. It is
not deployed, and the final image/installer is unfinished. Combining it with
the old per-launch `{env}` option throws `SEAT_DYNAMIC_ENV_UNWIRED` before
launch: per-target dynamic environment must be loaded under the seat identity,
and cannot be silently copied from server evaluation. A new explicit
`client.launchOptions(targetProject)` selects `{launchProject}` in seat mode.
`wakeNow` uses it without reading the target's env.sh as the server. The target
wrapper loads the environment under UID1000, then `run-seat-aiterm-launch.mjs`
opens a short-lived SDK connection under that identity. Only environment names
are passed as Aiterm `env_vars`; the MCP process reads their values locally.
The server receives only the tool result or original returned-error/launch
receipt classification. Parallel target calls use separate processes and keep
request metadata. The legacy `{env}` combination still fails before launch.

An isolated synthetic MCP verified all four harness selectors, two concurrent
target environments, mode-0600 seat-owned env.sh unreadable by the UID1001
parent, rejected target environments, and startup receipt preservation. This
is not acceptance of four real CLI launches or Aiterm's native launch-config
file path. The installed Aiterm source inspected here exposes agent_launch
through env_vars; no launch-config-file path was established. Supervisor
configuration and all real SDK/native paths remain unaccepted.

The existing short-lived
legacy connection now retains request meta, matching the stop integration
branch's fix. SDK child startup is verified in an isolated UID1001 fixture;
all supervisor/launch/wait/setup/schedule/configuration paths and the four real
CLI integrations still need wiring and acceptance.

`createSeatProcessRunner(project)` now provides a bounded-output command reader
through the same installed entry, with stdin EOF and cancellation that returns
only after the wrapper closes. It rejects a server-evaluated `env` option; it
does not copy that environment or include command output in failure messages.
Throughline count/handoff queries can opt in with `seatCommands: true`, and
`runWaitProcess` can opt in with `seatProject`. Explicit invalid seatProject
values are rejected rather than selecting the legacy reader. The branch now selects these readers in application services; the final
installed UID boundary and every production path still need acceptance. An isolated test
uses a synthetic Throughline executable and wait JSON, not real CLI state.

`restoreBotEnvironments(bots, {seatCommands: true})` now runs setup through
the fixed UID entry. `environment: 'base'` intentionally skips `env.sh` so
setup can repair an environment that is not yet usable. `run-seat-setup.mjs`
creates the environment directory and mode-0600 setup log as UID1000, runs
setup sequentially, and returns only presence/exit metadata to the server.
A failed setup does not prevent the following bot's setup. The setup child
stays in the wrapper's process group for cancellation. The setup helper handles
termination and escalates its immediate child after 150ms so it can reap it
before the outer wrapper's 250ms group fallback. Isolated testing confirmed
the immediate TERM-ignoring child's disappearance before cancellation returned;
this does not certify detached or different-UID descendants.

`runShellCommand(request, {seatProject: request.cwd, signal})` opts a scheduled
command into the configured seat environment. A mismatched or invalid project
does not fall back to server execution. Exit status and bounded stdout/stderr
remain available for the scheduler's existing failure notice. Cancellation
waits for the wrapper to close. For scheduler construction, supply this function
through its existing `runCommand` dependency; no new scheduler or supervisor
mode is enabled by default. Server-evaluated environments remain prohibited.
These options do not migrate pre-existing setup-log ownership; that remains
part of the planned state/seat ownership migration.

`BotRegistry({stateRoot})` can now place authoritative `bot.json`,
`schedule.json`, and `.initialized` in a separate server-owned directory,
while `botsRoot` still locates each seat project, instructions, environment,
memory and artifacts. Fresh state directories use 0700 and new state files
0600. An existing directory's ownership/mode is not changed by this option.
The branch bootstrap now selects state/bots; the deployed installation has not
been migrated and still uses the legacy layout.

Invalid stateRoot values and a new state root overlapping the seat project
root are rejected. If legacy profiles or their initialization marker exist,
the new layout requires explicit completed migration before initialization;
it does not silently reseed over those records. Once migrated, refresh/profile
updates/schedules only use the new authority and ignore old seat copies.
Creating and deleting a bot manage its corresponding state directory as well
as its seat project; other bot artifacts remain in their original projects.

This is a path-selection component, not the migration/rollback executor. Tests
copy only synthetic records to model a completed migration. Production state
must still be captured consistently, migrated and backed up, and inverse
migration must preserve the newest generation. Server UID allocation, all
state categories, read-only mount topology, old setup-log ownership and full
seat-UID file operations remain unverified. A server-owned stateRoot must not
be inferred from path strings or mkdir permissions alone.

The newly introduced `shared/ai-control.json` stop intent belongs in the
server-owned state migration, backup and latest-generation rollback plan.
Returning to an older code version must not silently ignore a persisted ON.
State migration, independent read-only mounts, backups, rollback and deployment
downtime measurement are not implemented by these entry components.

Cancellation escalation starts when TERM/INT/HUP is received, independently of
the child's close event. The 250ms timer captures that child's group; it is
canceled only when the group is already absent. A leader exiting while its
group remains alive does not let the wrapper exit before escalation. This also
covers an environment descendant retaining the capture pipe.

Only omitted or explicitly null seatProject selects the legacy path. Every
explicit invalid value, including empty/false/undefined, throws the typed
SEAT_PROJECT_INVALID error before an SDK connection or dynamic-env branch.
The project is checked again at connect/call, and no truthiness fallback exists.

| Existing route | Stage-2 work still required |
| --- | --- |
| `aiterm-transport.mjs`: SDK `StdioClientTransport`, wait-process spawn, Throughline reads | Start the MCP process and all CLI-related children as UID1000; verify termination/cancellation and no privileged inherited environment |
| `bot-environment.mjs`: setup.sh, env.sh, cleanup | Evaluate and write seat-owned results as UID1000, never under the server identity |
| `scheduler.mjs`: shell commands | Seat identity and correct cancellation/exit propagation |
| `harness-config.mjs`, `rtk-hooks.mjs`: Throughline install, CLI config/hooks, Codex app-server | Generate seat-owned files through the seat entry, preserve other registered configuration |
| `self-turns.mjs`, `room-routing.mjs`: Throughline subprocesses | Seat identity; supply only the required input/results over stdio |
| `bot-registry.mjs`: git init, project instructions and short-term context | Separate server-owned profile/schedule records from seat-owned projects and generated instruction files |
| `supervisor.mjs`: call-bridge headers and sockets | Confirm retained seat uses before changing ownership; preserve required socket access |
| `model-catalog.mjs`, harness auth | Trace SDK-owned child creation as well as direct spawn calls |
| `bootstrap.mjs`, subscriptions, onboarding, conversation/room/owner/diagnostics state | Move authoritative state consistently and support current-generation inverse migration |
| `memory-service.mjs`, knowledge, assets, secret delivery | Retain project/seat ownership; do not change content-management policy or read real credentials |

State migration, dedicated read-only directory mounts for credentials, fixed
seat execution entry, UID allocation, server process separation, backup/restore,
full four-harness functionality, and measured downtime remain incomplete.
Neither the passing installer tests nor stage-1 acceptance closes SEC-014.

## Verification of this component

- `node --test test/sce-headers-installer.test.mjs`: fault preservation plus
  the next BugHub request seeing the synthetic new generation while actor
  identity remains fixed by the caller.
- `sudo -n /usr/bin/python3 -I test/sce-headers-installer.py`: synthetic-only
  real UID1000 read rejection and UID1001 read success, atomic replacement,
  interrupted/invalid input, partial/failed writes, failed ownership/sync/rename,
  symlink rejection, temporary-file collision and cleanup.

The root test creates only disposable synthetic directories and numeric child
identities. It creates no OS users and reads no production credentials.
The ordinary test run skips the root-only UID case; it is separately executed
for the actual UID boundary. The next-GET test uses a stub endpoint, not BugHub
production. Directory read-only mount protection and actual root-installed CLI
acceptance are still separate integration checks.


### Split-state creation and interrupted deletion

A new split-mode Bot claims its project directory with exclusive mkdir.
An existing directory, file or symlink is rejected with BOT_PROJECT_EXISTS;
its environment, memory and documents are never attached to the new Bot.
A pending deletion also reserves the ID (BOT_DELETE_PENDING).

Removal first renames the authoritative state directory, within stateRoot,
to `.deleting/<id>`. Only after this succeeds is the Bot absent from the active
registry. It then removes the project and finally the pending state directory.
If the rename fails, the active profile and project remain unchanged. If either
cleanup fails, BOT_DELETE_PENDING is returned and the persistent pending ID
blocks reuse. Calling remove(id) again resumes cleanup even without an active
profile. initialize() also resumes pending removals before loading profiles;
a remaining cleanup failure blocks startup rather than resurrecting the Bot.
No surviving bot.json inside the pending directory is needed to resume cleanup.

This is file-operation/process-restart recovery, not a claim of power-loss
persistence, multi-process registry locking, symlink-safe parent traversal or
completed state migration. An HTTP 202 still means acceptance. After retirement,
the active registry no longer dispatches the Bot during cleanup. A separate
server-owned `.deleting/<id>.json` listing receipt retains the full profile in
GET /api/bots with deleting:true and online:false until project, retired state
and finally this receipt have all been removed. List disappearance therefore
retains the Apple 54 deletion-completion contract. A failure keeps the Bot in
client lists and prevents the app from declaring completion or discarding drafts.
The receipt is never an execution target. A receipt prepared before a failed
retirement rename is discarded on initialization without deleting the active Bot.
Pending cleanup is retried by registry remove(id) or normal initialization; there is no new public HTTP retry endpoint in this component.


An in-process deletion intent is set and the active Map entry is removed
synchronously before awaiting the retirement rename. A failed rename restores
that active entry; refresh never reactivates an entry with an active intent.
GET list snapshots recheck this intent before passing targets to runningBots
and again immediately before response serialization. A running observation
already issued before retirement may finish, but cannot override the pending
flag or report online:true while the intent remains active. This is local
registry coordination, not a multi-process registry lock or a cancellation
of an already issued observation.


A list read that outlives complete removal must also drop its stale item after
the intent has been released. clientListingState(id) checks the active Map,
in-process intent and deletion-receipt metadata synchronously; only a missing
receipt is treated as absent, while other filesystem errors fail the read.
The HTTP handler uses that state before runningBots and immediately before JSON
serialization, without an intervening await. It drops absent items rather than
returning the old profile or online observation after deletion completes.
The receipt's contents remain validated by listForClient. This retains the
local registry/single-process scope; it does not introduce a distributed lock
or prevent a previously serialized response from arriving late on the network.

## Offline transfer of the global pause intent

`transferAiControlState({legacyRoot, stateRoot, direction})` is an offline
preparation component. `to-server` copies `shared/ai-control.json` below
legacyRoot to `ai-control.json` below stateRoot. `to-legacy` copies the CURRENT
server file back over the obsolete legacy copy. Both writers must be stopped
for the entire operation; this component does not establish that condition.
Never use a pre-migration backup as the rollback source.

The original bytes, including paused and resumedAt, are retained. Older valid
v1 files without resumedAt stay unchanged. A missing/invalid source fails;
it does not create an enabled default. A different existing server file blocks
to-server; an identical file is unchanged. Files are written through a private
0600 temporary file, file sync, rename and destination-directory sync. Newly
created destination directories use 0700. Source/destination file symlinks are
rejected. Parent path replacement, concurrent writers and hardware crash
durability are outside this offline component's acceptance.

The source is retained; no key/owner/settings/project migration, source
retirement, bootstrap path switch, backup restoration or mount is performed.
The transfer is not connected to the deployment migration. The branch
application services now select state/ai-control.json, while the deployed
installation still reads the legacy path. Native interruption/session preservation in
the split deployment remains a separate prerequisite. Other server state and
the complete forward/reverse migration remain unfinished.

## Validation of the integration (2026-10-25)

The owner-module focused set passed 81 tests. The first complete run reported
770 passes and one EMFILE failure opening the application runtime's filesystem
watcher; its own stalled test process was interrupted. The runtime file passed
all four tests in isolation. A subsequent complete run with one test file at a
time passed 771 tests, with zero failures, cancellations or skips. The first
failure is retained as a resource-exhaustion result, not replaced by a claim
that the default parallel run passed. No assertion or production setting was
relaxed. Logs are held in Trony's sec-014-stage2-resume-20261025 integration
evidence directory. Runtime startup-failure cleanup is a separate lifecycle
concern; these results do not establish acceptance of a deployed UID split.

## Seat-owned operations wired in the branch (2026-10-25)

ProjectFiles owns project creation, git initialization, generated instructions,
startup context and project removal. BotRegistry retains only server profile,
schedule and deletion state. The branch bootstrap supplies SeatRuntime's
project adapter, so the server does not create a seat repository or evaluate
its git configuration itself. The same fixed UID entry performs CLI/hook
configuration, global instruction writes, Claude-copy cleanup and memory/RAG
operations. The existing memory locations and content policy stay unchanged.
Only operation inputs/results cross stdin/stdout; no server environment or
whole feature-settings document is supplied to the child.

Application services now select the seat SDK client, handoff/wait readers,
Throughline turn count/observer reads and change-signature reads, setup and
scheduled-command adapters. Authentication uses that seat client's base
connection without serializing a server environment. The bootstrap's model
catalog uses the same seat SDK entry. Feature changes update CLI configuration
through the seat adapter.

Server-authoritative bots, subscription, onboarding and global-pause files
select state/ paths. Bot message-image assets select state/bots/<id>/messages/
assets, retaining their owner/file URL references and deletion lifecycle. A
private image supplied by a Bot is read as UID1000 and stored as server state;
base64 uploads still use the ordinary byte reader. Existing files require an
explicit migration before this layout is deployable.

Call-bridge credentials remain a SERVER operation. The branch selects
state/call-bridge/headers for initial settings import, normal settings updates
and the seat-MCP relay. Moving the writer to the seat merely because the old
file was UID1000-owned would break the actual ownership contract. Normal CLI
registrations use the per-seat proxy. The private credential migration and
host prepare/issue maintenance paths remain to be implemented and accepted.
The separate socket placement and the outer bridge's read-only directory bind
are coordinated with the bridge owner; actual cross-UID connection and inode
regeneration are not accepted yet.

A network-disabled, read-only isolated fixture ran the real fixed C/sudo entry
from UID1001 into UID/GID1000. It checked server-owned profiles/schedules,
seat-owned git/instructions/startup files, memory and knowledge roundtrips,
private seat files inaccessible to UID1001, private image read/storage and
removal of both roots. Server-only synthetic environment names were absent
in the seat. No credentials, real Bot state, real CLI conversations or host
mount/owner changes were used. The default-parallel Node suite passed 776
tests with zero failures, cancellations or skips for this wiring checkpoint.

This is NOT whole-runtime or release acceptance. The final Docker user/entry,
fresh installation, complete stopped-writer migration and inverse migration,
independent protected mounts, socket/credential maintenance, private character
sheet streaming, scheduled-command cancellation acknowledgement, four real
CLI integrations and measured downtime remain open. The branch stays Draft
and must not be deployed as a completed UID split.

Native Aiterm registration is resolved through the seat entry too. Resolving
localParentWorkerRuntime.scope() as UID1001 would select the server's native
state root/socket instead of the UID1000 CLI hooks. The isolated regression
compares both registrations and requires the installed seat scope to belong
to UID1000. Configuration, memory and cleanup requests carry only id/project
pairs for the registry, avoiding unrelated avatars/profile text on each call.

## Streaming private character sheets and the server image entry (2026-10-25)

The application graph now delegates character-sheet list/open to the seat
identity. The existing CharacterSheets implementation owns filename checks,
NOFOLLOW open and metadata. A short-lived reader sends one JSON metadata line
then streams binary stdout with backpressure. There is no 25 MiB whole-image
buffer limit. Failed metadata/open is returned before HTTP headers; later read
failures abort the response. HTTP consumer close destroys the stream and
terminates the owned reader. Invalid names, missing files and symlinks keep
their existing error semantics.

The image compiles the fixed seat entry and a dedicated non-privileged server
entry, keeps /app root-owned, and selects USER bellteam-server (1001). The
server entry accepts no supplied command, checks UID/GID, clears Node preload
settings, fixes its HOME/PATH and execs the fixed supervisor module. Both
Compose entry points provide the server's private /run/bellteam-server tmpfs.
Public packaging and its build filter include both C sources.

An isolated image with synthetic files exercised the exact compiled entry
and stream/HTTP path: UID1001 could not read the UID1000 private sheet directly,
but ordinary list/HTTP streamed 27,262,993 bytes successfully. Disconnect closed
all recorded reader processes; invalid/missing/symlink reads were rejected.
The fixture deliberately substituted a small assertion module for the real
supervisor; this proves the fixed entry boundary, not complete bootstrap or
fresh-install acceptance. Wrong UID and an extra command argument both exited
126. The first context upload failed Docker's PAX archive detection; the next
exposed the inherited PATH omission of /usr/sbin. The build uses USTAR and
absolute groupadd/useradd paths; both failed logs are preserved.

The branch remains NOTDEPLOYABLE: complete stopped-writer migration/inverse
migration, independent mounts, fresh installation, current-generation backup
restore, scheduled-command PGID cancellation receipt, four CLI paths, real
supervisor integration and downtime measurement remain necessary.

The independent bc19 review found two additional HTTP boundary failures.
Cancellation is now registered before awaiting seat metadata and reaches the
owned reader through AbortSignal. After metadata, the binary stream keeps its
last byte until the child has succeeded and the length matches, so a delayed
reader failure cannot complete a Content-Length response. This also preserves
zero-byte success only after reader completion. The actual HTTP/SeatRuntime
adapter regressions cover pre-metadata disconnect, delayed failure at lengths
four and zero, and successful empty content. Together with the binary stream
regressions, nine focused tests pass. The final default suite passes 785 tests,
with no failures, cancellations or skips. No whole-file buffer was introduced.

## Offline state-content transfer (2026-10-25)

The stopped-writer transfer moves Bot profiles, schedules and message assets
from seat projects to state/bots, plus subscription/onboarding/AI-control and
call-bridge headers into state. Seat docs/memory/CLI files remain in place.
It validates remaining profiles/schedules first, rejects symlinks, hardlinks,
conflicting destinations and pending registry deletion, and copies a regular
file through a synced temporary destination before retiring its source. Both
directory sides are synced; no whole-image buffer is used. Existing AI-control
validation and current-state return semantics are reused.

The destination .initialized marker is created only after all selected data
is transferred. A stopped failed transfer can resume from source plus already
transferred identical destination files. Recovery after committing the new
marker can remove only the leftover old marker; surviving legacy state is a
conflict. An empty installation is distinct from missing migration metadata.
Returning to legacy reads the CURRENT split state, including changed schedules,
AI pause intent and Bot additions/deletions, instead of restoring old copies.

This is the content-transfer component. It is NOT a stopped-writer proof,
credential backup/restore policy, ownership or mount setup, or an installer.
The privileged offline caller and installer must still wire those conditions
and must not start either generation after a transfer error. The branch stays
Draft and NOTDEPLOYABLE pending that integration and the existing four-CLI/PGID
and downtime acceptance.

The independent ccde review found missing durability for new target ancestor
entries before source retirement, unchecked commit-marker symlinks and a
handle leak on a later acquisition/stat failure. New directories now sync their
parent before use, and all target ancestors inside the data root sync before
source unlink (including AI-control and the final marker). A failed sync leaves
the source recoverable. Both commit markers are validated as regular, single-
link NOFOLLOW files before any recovery deletion. One owned-handle scope closes
on every later acquisition/stat failure and preserves the original exception,
aggregating an additional close error when necessary. Regressions exercise
marker symlinks/hardlinks, an actual-directory-fsync fault preserving source,
and acquisition/stat failures with zero unclosed handles.

Recovery of an existing target marker now fsyncs the validated marker and all
its containing directories through the data root before source-marker
retirement. A failed post-create directory sync is not a committed marker.
A new actual-filesystem fault regression fails before this repair, preserves
both markers across two sync failures, then verifies file/ancestor sync before
old-marker unlink in forward and reverse transfers. Related selection: 31
passed; testgate selection: 336 passed; explicit full gate: 795 passed, no
failures/cancellations/skips. These are content-component results only.

The public installer's maintenance command now follows successful service
stop and explicitly overrides the fixed server entry with the image shell as
UID/GID 0:0. The former argv through the UID1001-only entry was incompatible.
Stop or preparation failure aborts before Cursor update and server startup.
Docker-command fixtures cover those failures; this does not establish actual
writer disappearance or integrate state transfer, protected mounts, ownership
restoration or fresh-install supervisor acceptance. NOTDEPLOYABLE remains.
