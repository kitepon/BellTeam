# Preserve a schedule updated during an older delivery

A once schedule due at 11:25 could be changed to 11:45 while the old
delivery was awaiting its result. Completion then loaded the newly saved
definition by ID and disabled it, clearing nextRunAt. Bot and room schedules
shared this behavior. Atomic rename did not serialize competing document
read-modify-write operations.

Each explicit set now advances the existing schedule's revision; legacy
records without one are revision zero. Completion and resume-time skipping
carry the selected revision and only consume that definition. A removed or
updated definition is preserved without delivery replay. A short-lived lock
serializes schedule document mutations for the same owner. Other owners can
proceed independently. Room target cleanup uses that same mutation boundary.
The scheduler also snapshots owner lists for each scan: registry refresh
cannot clear/reinsert an owner and visit it twice within the same pass.

Seven owned-filesystem regressions cover bot/room delayed delivery followed
by future update, identical rearm, an update during completion's pending write,
deletion, concurrent additions/write failure, and an updated request during
resume-time skip. The original source fails these regressions; repaired
related tests: 51 passed; explicit full source gate: 754 passed, zero failure,
cancellation or skip. Initial fixture startup omitted the seed project and
failed before product execution; that log is retained separately.

This is a source repair. No production schedule was edited for reproduction,
no real Bot was sent a prompt and no deployment or recovered future schedule
is claimed. The original reporter restored its own continuation independently.
