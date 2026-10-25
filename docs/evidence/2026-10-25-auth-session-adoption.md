# Existing official authentication session: source candidate

A directly prepared official login PTY is absent from HarnessAuth.sessions.
Starting login in Settings would create a second flow; the existing input
route rejects an unregistered flow, and a freshly opened Settings view hides
its password input because this view did not initiate login.

The Owner-authenticated outer API adds POST /api/harness-auth/<harness>/adopt
with only {sessionId}. It observes the existing official agent_auth status,
checks harness, session and input-waiting state, refuses a different managed
flow, then registers that same session. It does not start or cancel login.
An adopted session is checked again immediately before input. The usual input
path forwards the value to the PTY without saving it to a secret file. Internal
seat requests cannot use the authentication endpoints. A fresh Settings view
shows the existing password field and hides the new-login button while input
is pending. Receipt URL parsing remains the native adapter's responsibility.

Related tests: 19 passed. Full default suite: 751 passed, no failures,
cancellations or skips. A real Chromium viewport with a synthetic HTTP/native
peer confirmed adoption, a password field on fresh view, no start, one synthetic
input and the authenticated state. Its input and output were artificial;
operations on the real prepared t1 and real credentials were zero. The initial
worktree dependency-preflight failure is retained separately.

This source is not active in the running server. No live adoption or safe Owner
input link has been established. Recreating the current BellTeam container
would destroy the prepared t1, so this source candidate alone does not solve
live activation while preserving that flow. No second login, cancellation,
logout, session restart, secret copy or Owner request has been performed.
The activation/preservation gap needs an explicit implementation and review
before requesting the Owner's authorization code. Native identity and receipt
ownership guarantees must also be accepted at the real receiver boundary.
