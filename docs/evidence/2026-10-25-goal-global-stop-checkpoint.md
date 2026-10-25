# Goal continuation and whole-application stop: integration checkpoint

PR79 remains a draft. These changes use the proposed Aiterm `agent_stop.pause_goals` contract. The Aiterm changes are still awaiting a fixed source/candidate and native integration acceptance; this checkpoint is not a production or native interruption result.

Only the whole-application stop passes `pause_goals:true` and the authenticated host's existing user-origin metadata. Ordinary conversation stop keeps its existing request. The synchronous admission barrier, per-target stop versions and scheduler command interruption are established before awaiting native results. Re-enabling application admission does not resume a goal.

A key receipt with unknown, unsupported or missing goal pause remains unconfirmed. An older key-only response is preserved as a receipt; it cannot satisfy the new goal-pause condition. The historical execution adapter still sends its ordinary interruption, and reports goal pause as unconfirmed. No close fallback, retry, new daemon or second goal store is introduced.

Focused verification uses real HTTP, AiControl, managed transport and the MCP SDK with artificial native pause/key responses. Four new cases cover admission and barriers during a held pause, explicit resume semantics, ordinary stop, unknown/unsupported pause and an older key-only result. Existing delivery, interruption and scheduler cases are checked alongside them. The first run failed one case because a missing goal field threw away known root attribution; the reader now retains the key receipt while returning partial/unconfirmed. The original failure log remains available.

Final focused command: `node --test test/goal-global-stop.test.mjs test/managed-delivery.test.mjs test/managed-transport.test.mjs test/execution-transport.test.mjs test/ai-control-integration.test.mjs`.

Result: 57 tests passed, zero failures, cancellations or skips. Logs are retained in the maintainer workspace under `integrations/goals-composer-20261025/goal-global-stop-focused{,-v2}.log`. A full suite will run after the remaining native integration work. No real Bot, production service or installed CLI was changed.
