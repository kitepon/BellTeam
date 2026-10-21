# SEC-014 stage 2: implementation in progress

This branch implements the approved staged-A boundary. Stage 1 is already
deployed. This branch is not a deployable stage-2 release yet. It does not change
the running server, credentials, owners, mounts, or container user.

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

The option is not supplied by the production supervisor. Combining it with
the old per-launch `{env}` option throws `SEAT_DYNAMIC_ENV_UNWIRED` before
launch: per-target dynamic environment must be loaded under the seat identity,
and cannot be silently copied from server evaluation. The existing short-lived
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
values are rejected rather than selecting the legacy reader. These options
are not enabled in the supervisor; target-specific launch environments,
configuration and all production paths still need wiring. An isolated test
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
