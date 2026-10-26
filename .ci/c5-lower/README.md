# Fixed c5 lower-path CI adapter

Only workflow_dispatch on ci/centi-c5-lower-v16-20261026, native GitHub amd64 VM1,
attempt1. No build/tag/push/main deployment, production volume/HOME/data/auth,
Owner/Bot/Goal/provider, quiet, survey or production host preflight is run.
The 11 vendor/asset files in contract.json are byte-pinned from reviewed v16.
The optional c5_preflight import inside unused run_helper is not supplied or faked.

The adapter directly calls the original _run/_inspect, production minimal-env
branch and c5_client_wait. Its Popen/wait subclass delegates real argv/env/pid/
pipes/return codes unchanged. It checks fresh resources and the whole call+reap
budget immediately before spawn, then requires durable same-PID/startTicks/phase
terminal state before the actual wait. Unknown receipts allow only an explicitly
classified unknown reap; they never permit a new Docker command or success.

One cat asset exercises the new lower path. Cursor is created/inspected/removed,
never started or updated. A separate image-pinned Node timer5s/healthcheck fixture
exercises the exact 11-field template and service bellteam config --hash output.
Only the template's target argument is its own CID. Unique project/name remain
raw; fixed production _container semantics are not claimed. Missing health or
hash mismatch is an unaccepted result, not an opportunity to rewrite raw values.

Normal maximum effects: pull1/create3/start2/rm3/volume create+rm1/project1/default
network create+rm1. CPU1/RAM=swap2GiB/PIDs512/RO, running containers serial1. CI
start8GiB/24GiB four frames over3 intervals, each new issue4GiB/8GiB/fresh3s and
initial disk loss<=16GiB. No main-server14/150 change or daemon hardcap claim.
Metadata calls<=20s, pull<=300s, phase budgets810s, script1200s, cleanup90s reserved,
job1500s/artifact180s. Unknown/nonzero from a spawned client stops all further
Docker calls. Known stopped owned CIDs alone can be removed without force;
unconfirmed volume/network identities remain incomplete. No stop/kill/prune/down.

Artifacts contain bounded state/receipts, public projection/hash raw output,
validated helper field projections and exact cleanup/residual indexes. Config.Env,
Health.Log, full raw helper inspect, tokens and runner credentials are excluded.
Container live PID/cgroup/peak are not sampled by this narrow created/short-lived
check; this is missing evidence, never zero. The earlier helper CI cgroup result
and its one-sample limitation remain separate. Real Docker compatibility is still
unmeasured until a separately authorized one-run CI; local ten adapter tests use
ordinary FS and a fake process only. Old artifact7/helper/Native/observer/full
success groups are not rerun.
