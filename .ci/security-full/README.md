# Security dependency candidate — source-only CI proposal

Product source: `3cb6ffe0f3f5ac93bd293428d0f53fdfcb24a1f3` (PR114),
base `0092766f73259de18194eaa87119e91e85ce93e0`.
This branch replaces the existing manual workflow with a CI-only workflow;
there are no push triggers, image jobs, package writes, Docker or deployment steps.
No remote push or dispatch is authorized by these files.

After Root reviews the exact resulting commit and gives a new execution instruction:
normal branch push, verify remote exact HEAD and workflow bytes, verify no prior
manual run for that head, then dispatch that same ref once. Do not rerun or follow
a new head automatically. Attempt 2 is rejected. A claim is exclusive within the
VM, while the cross-run one-dispatch check remains the dispatcher's responsibility.

One GitHub-hosted native amd64 Ubuntu 24.04 VM, Node 26 (actual version recorded),
contents:read only, checkout credentials not persisted, no secrets inputs/caches.
The test/install environment is rebuilt from an allowlist: separate empty HOME,
TMPDIR, user/global npmrc and npm cache, public npm registry only. TMPDIR is a
new empty 0700 `/tmp/btsf-*` outside the repository, avoiding parent type=module
and leaving room for UNIX socket paths; HOME/npmrc/cache/deny remain isolated as
before. Node heap256MiB is set on the test runner argv and NODE_OPTIONS for
children inheriting this environment. Fixtures that explicitly rebuild env can
omit NODE_OPTIONS; there is no claim of every child heap being observed or
forced, and no wrapper is added. This is not a VM/RSS cap.
No main-server resource thresholds or AFK window are changed. Initial CI headroom
is 2GiB MemAvailable and 4GiB disk. Refuse missing tools, wrong runtime or low space.

The only stages are `npm ci --ignore-scripts --no-audit --no-fund` (240s), then
all sorted `test/*.test.mjs` with `node --max-old-space-size=256 --test
--test-concurrency=1 --test-reporter=tap` (840s). This selects exactly the files in
the product's npm test glob, without adding a Native/Docker/CLI integration suite.
The Node test worker count is 1; test-created ordinary child processes are not a
single-process guarantee. No old c5 artifact/helper/Native acceptance is replayed.
The product file hashes and ancestor/diff checks prevent silently testing a
changed product. Missing/failed/cancelled/skipped/todo TAP totals cannot pass.

GNU timeout bounds each self-owned CI process group; TERM then KILL after 5s on
its timeout, no retry or next stage. Script outer bound1200s, stage elapsed budget
1140s, job25min, artifact upload3min. Job cancellation/outer timeout can leave
incomplete logs/result: retain them as unknown/unaccepted, never infer completion.
Fresh VM disposal belongs to GitHub. No cleanup or signal targets a shared host.

Real docker/ssh/aiterm/cursor-agent/claude/codex/grok commands are denied on the
allowlisted PATH; product tests may prepend their own synthetic command fixtures.
A denied command also prevents acceptance. No provider or production credentials
are available, and no real CLI authentication or Bot/Goal work is requested.
This PATH restriction is not an OS sandbox or proof about arbitrary absolute
executables; the fixed reviewed test source and fresh credential-free VM remain
part of the execution contract. The plan does not claim network isolation.

Artifacts contain stage logs, exact tested file list, argv, runtime/resource
observations, exit codes, TAP totals and SHA256 index. They contain no environment
dump or credentials. CI success proves only this product source's complete Node
suite with this lock/runtime; it does not prove a candidate image, global CLI
internals, host resource behavior, internal mounts/data, quiet/permissions,
production deployment or rollback. A new candidate image binding remains separate.

The first authorized CI40343610417 remains unaccepted (830pass/13fail). The
TMP-only source correction has a narrow long-repo-path versus short-external-path
Node child/socket counterexample; it does not prove all 13 historical causes.
No Full rerun or new dispatch follows this correction without Root's exact-source
review and a new one-time instruction. Short temporary contents belong only to
the disposable CI VM; final VM cleanup is not independently observed.
