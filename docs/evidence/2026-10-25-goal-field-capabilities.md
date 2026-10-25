# Goal field capabilities checkpoint

The native prototype source is `878fff77449451bfd97758a9c5c4b466af7731c6`; its unpublished tarball SHA-256 is `52e07a864745267d8edba1ab192ca3ac38b98bb6beced921b81c8602b6d2e52b`. This is not the official published 0.61.17 package.

BotGoals validates optional native `field_capabilities` and exposes HTTP `fieldCapabilities` for create/edit: objective, tokenBudget and combined. Missing fields on a legacy response use the operation capability; malformed fields remain unavailable. Operation and goal-state restrictions also limit every field.

The normal Codex CLI can edit a literal objective or a budget separately. The Web form explicitly selects one field when combined is false, sends one mutation, and never automatically splits or retries. Unsupported controls remain absent. Existing binding and response ordering protections remain in place.

Related tests: 29 passed. Full default parallel suite: 776 passed, zero failures/cancellations/skips. Chromium at 1100px and 390px checked objective-only, budget-only and a budget-only capability: three explicit mutations per viewport, no combined requests or page errors. The first browser fixture used the wrong CSS filename and failed before measurement; its log is retained.

A new isolated HTTP → BotGoals → normal MCP → original Codex CLI probe confirmed separate field capabilities, a literal Japanese/multiline objective edit, a budget-only edit retaining the objective, mixed input refusal without effect, and resume reaching the same worker with that objective and stopping at budgetLimited. The provider was a loopback fixture; real Bot operations and upstream inference were zero. The owned fixture was closed. Initial missing dependency setup and an unheld response/readback timing failure are retained separately; they are not product fixes.

Creation remains unsupported on the normal CLI. Other CLI/OS adapters and the formal upstream source/version/tarball, actual server image and deployment acceptance remain incomplete. Apple UI uses a separate fixture and is not proved by these Web/HTTP checks.
