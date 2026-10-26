# Security candidate: manual branch source proposal

This is source/plan only. No build, remote push, dispatch, image tag, registry
write, main merge or production action has been authorized by this proposal.
Product3cb Full CI40347076517 (843pass) and Root d6e9c553 acceptance remain valid.
The previous failed Full is preserved; this proposal reruns neither Full nor the
old Native/auth/installer/model/Cursor-update/artifact/helper acceptance groups.

Root owns PR114's ordinary main merge. The proposed merge commit message contains
`[skip ci]`, suppressing the existing main push workflow with its unrelated old
success suites. GitHub's skip instruction applies to push/pull_request, not manual
dispatch. Root must verify repository merge/check requirements and read back the
actual new main SHA/skip result; no check disabling or bypass is implemented here.

After Root reviews this exact source and separately issues one execution instruction:
normal branch push, remote exact CI HEAD/workflow readback, no earlier manual run
for that head, then one dispatch with `inputs.source` set to the exact new main
40hex SHA. The workflow runs only this CI branch/attempt1. The branch's product
source is not used as the release revision: a detached worktree at the input main
feeds the unchanged existing packager. It must be current fetched origin/main,
descend from accepted3cb and have `[skip ci]` in its merge message. The generated
139-file context must match the newly packaged3cb baseline, with distribution.json
sourceCommit alone replaced by that new main SHA. Unexpected product drift stops
before build. No future main hash is invented or silently followed.

Two native hosted VMs (amd64/arm64) run max-parallel1/fail-fast; only if both succeed
is a third short metadata/index VM started. No registry service or main-server.
Initial per-build CI headroom: MemAvailable4GiB/Docker filesystem40GiB. Build is
not a hard-capped daemon/VM; its finite budget is 2100s within a 2700s script and
55min job. Package60s, create30s, probe420s, publish180s within a 240s script,
cleanup uses remaining reserved60s, artifact upload180s. The index script420s/job10min.
Worst workflow ceiling is 55+55+10=120min including job setup/artifacts; if overhead
consumes the deadline, retain partial artifacts rather than treating the run as
complete. Each stage claim is exclusive in that VM; caller enforces one dispatch.
GNU timeout signals only its own fresh-VM client group, not a shared daemon or
product. Timeout/invalid CID latches unknown and issues no subsequent Docker call.
Known failure permits only exact known-stopped self-CID cleanup, no new normal work.
No retry/rerun/force/prune/stop/kill/up/down/daemon tuning is used by this adapter.

Build reuses the unchanged Dockerfile, `docker build --pull --no-cache`, and its
inherent official latest installers/--version checks. No new native behavior/auth
suite is added. No cache export or custom base/CLI pin is substituted. The local
probe uses the resulting content-addressed image ID before any push; it does not
execute supervisor/default startup. Fixed CPU1/RAM=swap2GiB/PIDs512/RO/networknone,
capdropALL/NNP, private64MiB tmpfs, user1000, and one RO bind of public probe/context
hashes and the unchanged new guard3 test. Raw created/exited inspect contains only
the selected public fields, never Config.Env. Start follows exact identity/caps
validation. Missing/unknown representation is retained and refused, not normalized.
One self-CID per arch, removed without force only when created/exited, then absence
checked. Running/unknown is retained for VM disposal and reported unconfirmed.
No production volume/HOME/data/auth is mounted. Local image/build cache remains
with the disposable VM; it is not a demonstrated shared-host cleanup or capacity
recovery. Container-create anonymous resources, if an upstream image unexpectedly
declares volumes, fail the one-mount contract and are not automatically removed.

The probe checks actual139 context files, SDK1.32.2/jose6.2.13/locked non-dev package
versions (platform optional absence explicitly listed), public profile/empty seed/
secret-file absence, real cgroup caps, and only the new MCP input-boundary3 cases.
It inventories every regular file and symlink under app node_modules, all global
node_modules, and baked Cursor .local, plus node/grok/rtk/mcp-lazy binary hashes.
It records package name/version metadata, dpkg package versions and Python pip
installed versions with network version checks disabled. These are complete for
those declared roots/catalogs, not every OS file, system vulnerability reachability,
CLI compatibility or provider behavior. Malformed bundled package metadata is
recorded as such alongside its file hash. Latest upstream version/byte drift is
inventory evidence for Root's next necessary delta decision, not old Native21/full
success transposed to a new artifact. A source-guard success is not all-feature
image acceptance. Peak/events are in-container snapshots, not host/daemon or every
child accounting. CLI client receipts record timeout wrapper PID/exit after wait,
not the production operator's terminal-before-reap/all-descendant proof.

Build/probe use an allowlisted environment, fresh empty HOME/TMP/DOCKER_CONFIG,
no provider/Owner credentials. Only publication steps use GitHub's automatic
short-lived GITHUB_TOKEN with packages:write, through docker/login-action and a
separate RUNNER_TEMP Docker auth directory. The token/config never enters build
context, probe mounts/env, command argv or uploaded artifacts. This necessary
registry credential is not claimed absent; no user/provider secret is supplied.
checkout credentials are not persisted. The default login-action post logout and
GitHub VM disposal are not an independently observed final cleanup guarantee.

Unique candidate tags are `security-<main40>-<runid>-<arch>` and
`security-<main40>-<runid>`, never stable/latest or the old candidate tag. Each arch
is pushed once only after probe success and self-CID absence. Anonymous raw manifest
and config SHA/revision/arch bind to the probed local image ID. The index job checks
both child digest/config/source before a single imagetools-create and checks the
resulting index membership after it. Raw index/child manifests/configs and immutable
repo@digest are saved; partially pushed arch tags remain candidate-only on failure,
not deleted or promoted. No existing remote tag is overwritten by retry. No stable
workflow is invoked, no registry/source/build repeat occurs automatically.

Artifacts: context hashes, build/guard raw logs, complete declared-root runtime
inventory, actual cgroup snapshots, selected raw inspect, command time/exit/claims,
cleanup/residual state, anonymous registry bytes, candidate-binding and SHA index.
The dispatcher verifies API artifact ZIP digest and every file SHA after the one
run. Missing artifacts, unknown commands/resources, malformed binding or guard
failures mean unaccepted. A new production/quiet/host resources/data preservation/
rollback/Owner scope decision remains Root and Emma's separate work.
