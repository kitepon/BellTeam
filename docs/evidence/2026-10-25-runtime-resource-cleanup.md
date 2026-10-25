# Runtime resource cleanup

If message-watch startup fails after acquiring earlier watches, the previous
implementation loses their close callbacks. A synthetic failure in rooms.watch
after the real ConversationStore watcher opened left one kernel watch active,
including after stopWatching. Thirty successful start/stop cycles returned to
zero active watches; that successful path did not reproduce a leak.

Message-events now closes every acquired watcher when startup fails, preserves
the original error and reports cleanup errors. Normal shutdown attempts every
close callback even when one fails. Application runtime rolls back its acquired
features and transports when startup fails. Its close operation is shared by
later callers, continues cleanup after an error, and reports collected errors.
An HTTP server which never listened is treated as an already stopped resource.
The new integration test uses real isolated state, a call-bridge socket and a
real ConversationStore watch, then fails rooms-watch acquisition. The original
EMFILE error reaches the caller and the watch, socket and client are released.

During validation, an independent existing command-stop fixture failed at
assert.ok(pid), with pid equal to zero. Its direct write to the ready file
exposes an empty file before the PID bytes are written. The fixture now installs
its signal handler and publishes a complete PID by rename. A test cleanup hook
always aborts and awaits its command, including when a readiness assertion fails.
The stop-confirmation and process-disappearance assertions remain unchanged.

## Validation and limits

- Unmodified main ff2aafa, default-parallel complete suite: 742 passed.
- Focused watcher/runtime tests: 8 passed. Command-stop fixture: 1 passed.
- Complete suite after both repairs, original default parallelism: 746 passed,
  with zero failures, cancellations or skips. No concurrency reduction was used.
- Every isolated runtime test ended with zero live FSWatchers and zero kernel
  watch descriptors. The process kept one inotify FD after first use; repeated
  cycles did not increase that count. FD count alone does not prove an active
  watch leak. The failed-acquisition probe went from one remaining kernel watch
  before repair to zero after repair, without probe cleanup supplying the fix.

The earlier SEC-014 integrated default run failed opening its first store watch
with EMFILE. Its contemporaneous container-wide usage was not captured, so its
precise exhaustion cause remains unproven. Later read-only container sampling
found 109 visible inotify FDs before the baseline, and the baseline sampled
107 at start/peak and 104 at finish. The final repaired full run sampled
104/106/104. These are samples of visible process FDs, not an exact count of
unique kernel instances or processes outside the container. Two processes were
inaccessible in the first snapshot. No other seat was stopped or modified, and
no sysctl or resource limit was raised.

The prior Mac command-test failure lacked an assertion stack. This Linux
assertion and its fixture race are established here; matching them to that
earlier Mac event remains unproven. Source repair and default-parallel success
do not establish production deployment or completion of the SEC-014 UID split.

Original logs, per-test watcher/kernel counts, normal/failure lifecycle probes
and container samples are retained under Trony's
integrations/sec-014-stage2-resume-20261025 directory.
