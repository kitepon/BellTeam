# Fixed c5 helper compatibility, one CI attempt

This branch runs only on one fresh native amd64 GitHub VM. It neither builds nor
publishes an image. The production host, its Cursor volume, HOME/data/auth,
actual Bots/Goals/providers, and existing artifact success suites are excluded.

`contract.json` fixes c5/a878/config, original assets and the private caps
overlay. The two pure validator files are copied unchanged from producer v4.
Raw inspect bytes are saved and passed directly to `validate_inspect_json`;
Cmd null and all other unknown representations are rejected, never normalized.

`accept_helpers.py` creates two RO/network-none cat helpers sequentially, then
one Cursor helper using the original Compose asset plus the fixed caps overlay.
Only a new unique labelled volume and Compose project/default network are used.
Create is followed by raw inspect/HostConfig validation before start. The Cursor
entry/user/init/tmpfs/cap-drop/NNP/network behavior is preserved. Each helper is
CPU1/RAM2GiB/MemorySwap2GiB/PIDs512. No credentials or host paths are mounted.

Initial RAM/free-disk minima are 8/24GiB across three real intervals; every new
Docker command rechecks RAM4/free8GiB, at most16GiB disk loss and freshness3s.
Phase budgets sum950s; script1200s, cleanup90s, job1500s and artifact reserve180s.
These are CI conditions, not a change to main-server14/150GiB or a daemon peak
guarantee. Exclusive claims are never retried. The resource/deadline guard runs
again after claim and receipt I/O, immediately before spawn.

Client timeout/spawn/CID uncertainty latches unknown and prevents all further
Docker calls. It does not stop the client or infer daemon completion. Cleanup
uses exact owned created/exited PID0 containers without force; running, foreign
or unknown objects are retained and the result is incomplete. Volume/network
removal requires known ownership and no container references. No down/prune.

Real client PID/startTicks, raw created/exit inspect, runtime PID/cgroup samples,
OOM/exit and cleanup receipts are retained in output. Fast cat PID/peak absence
is recorded as unobserved; Cursor requires an actual cgroup observation. A lost
terminal cgroup is not substituted with zero. CI cannot prove production mount,
data preservation, quiet, resource readiness, deployment or rollback success.

`test_executor.py` uses only artificial Docker/identity/cgroup responses and
temporary files. It tests the new executor, not real helper compatibility.
Remote push and dispatch require the separate final Root instruction.
