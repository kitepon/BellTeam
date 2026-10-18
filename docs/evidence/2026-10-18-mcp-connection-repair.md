# MCP connection lifecycle and message acceptance

The shared Aiterm client exposed a newly constructed SDK client before its initialize handshake completed. A second caller could therefore invoke a tool before initialization. A failed initialization or a later child exit also left the wrapper pointing at a disconnected SDK client.

The wrapper now waits for the same pending initialization for every concurrent caller, clears a failed connection, and clears an ended connection. The failed or already accepted operation is not automatically replayed; a later independent request can establish a new connection. Existing per-Bot ordering, strict unsent error classification, receipt validation, and delivery tracking are unchanged.

An isolated executable JSON-RPC fixture uses the real MCP SDK, delays initialization, rejects one initialization, and exits after an accepted request. All four new checks fail on the previous source. The HTTP integration reproduces concurrent requests to two Bots returning 200/500 before the fix and 200/200 after it, with two user records and no failed delivery or HTTP500 diagnostic. The remaining tests verify that callers wait for initialization, all callers receive the same initialization failure, and a later request reconnects after process exit. No real Aiterm instance, seat, credentials, or production fault is used.

The saved 401cb849 dispatch exception and Apple POST500 reports establish failed request acceptance, but lack the specific MCP error needed to attribute those historic events to these lifecycle defects. This repair removes a demonstrated current failure path; it does not establish one root cause for all aggregated events or resolve their registration by itself. Deployment and its normal checks remain separate.
