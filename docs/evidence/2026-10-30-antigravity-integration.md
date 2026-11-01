# Antigravity native harness integration

Base: `e6c9f056b0400e866b636cefad351331fa7ff7af`.

## Published dependency and protocol

Aiterm 0.62.0/source `5e9d5d30c213fbdaf106d108b9149aa4fbd65771` exposes `antigravity-cli` with provider `antigravity`. Root checked the public release, successful three-platform CI 41007539961, npm gitHead, and public tarball: 664814 bytes, SHA256 `3abea73bcd7008455fc41e5ef363ee7c17ac011c052b44d6b1ba3f4952cd86d0`. The producer's three-platform native acceptance remains producer evidence, not another Root native run.

CLI 1.4.10 sends HTTP header environment references literally. Its stdio children inherit the seat and launch environment separately on the three producer platforms. The bridge forwards JSON-RPC through the existing SDK and internal HTTP endpoint, preserving initialization, negotiated protocol, instructions, notifications, progress, results and cancellation. Missing identity fails before HTTP. EOF and signals close the connections; transport failures exit unsuccessfully without retrying.

The global and project instruction locations follow [official Rules](https://antigravity.google/docs/rules/). BellTeam writes its existing global text to `.gemini/AGENTS.md` and retains its existing project `AGENTS.md`. Aiterm's launch-time native hook installation and SessionStart lineage injection remain separate. Root checked that hook installation call in the published package. Root did not test every rule path or precedence against injected instructions in the native CLI.

Docker uses the [official installer](https://antigravity.google/cli/install.sh) with `--dir /usr/local/bin`. Root independently read its 7643 bytes, SHA256 `62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042`, matching the host producer's saved installer. Candidate Docker build and authenticated generation remain separate acceptance work.

## Validation

- SDK stdio/loopback transport and additive harness configuration: 22 passing tests.
- Catalog, authentication, registry, onboarding and Aiterm transport: 90 passing tests; later authentication message checks: 12 passing tests.
- MCP and onboarding callers after updating the old four-harness expectations: 27 passing tests.
- Opaque model IDs and initial authentication without forced relogin: 13 passing tests, including previously covered tests.
- Global instruction generation and related callers: 9 passing tests.
- Final `npm test`: 558 passed, 0 failed/cancelled/skipped. A subsequent focused assertion checks the documented rule-file budget; it and a comment/documentation change do not change runtime behavior.

Counts overlap and are not additive. The initial bridge test expected an HTTP code in the SDK's error message; correcting that assertion did not change bridge code. A global-instruction mock initially returned an object instead of the existing string contract and was corrected. No Swift/Windows native build, real Owner UI, Docker build or Root native inference is claimed.

## Remaining capability boundaries

Fast mode, forced relogin, native goal adapter and Antigravity-parent automatic wake are unsupported. Forced relogin is refused before sending input or touching shared credentials. Aiterm's Ctrl+C observation without a Stop hook remains running, not confirmed completion. Parents retain the existing wait-process and transcript contract.

Throughline 0.16.51 does not capture Antigravity sessions. Reading a project's already captured records does not prove capture of its new Antigravity conversation. Testgate 0.3.24 has no Antigravity adapter. RTK 1.1.0 has an upstream Antigravity plugin, but BellTeam does not bypass the required testgate path by registering that plugin directly. Existing four-harness integrations remain intact.

The vendor limits an individual rule file to 24000 bytes and global plus always-on rules to 20000 tokens. Current shared global text measured 23444 bytes; unbounded user instructions or handoff context are not established. Large rule files may be truncated or demoted by the vendor. No runtime chunking or new size gate is added here.

No live Bot, harness configuration, credential, server stop/restart, signing or public distribution was changed. The active NAS baseline job must reach its actual terminal receipt before any separately Owner-authorized server stop.
