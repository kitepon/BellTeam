# Owner HTTP to ordinary native CLI goal: partial feature acceptance

BellTeam source `a4b93a0ce11f74de4de8babf14b3c08d271a1f87` includes the accepted main changes. The source used for Aiterm was `1edf5b606f9fb4f2cece327f46133bb432b345d8`, from the unpublished prototype tarball SHA256 `7e8b9fc18942831a7fac85809fa2c8a55cc99254a8ba5e5f33b40f6f9a360c2c`. Its package metadata still says .17; it is not the official .17 release.

The maintainer ran ordinary `agent_launch` and its wait receipt with an isolated HOME/CODEX_HOME/project/state/tmux scope and a loopback artificial provider. The actual BellTeam HTTP server, BotGoals, managed transport, AitermClient and ordinary native MCP process were used. No live Bot, Owner application, provider credentials or upstream inference service was used.

Verified through HTTP:

- Empty native goal differs from unavailable and reports unsupported creation honestly.
- A goal established by the fixture CLI is read from its original launch/thread.
- Whole-application stop closes admission, pauses that goal and sends the existing interruption key. Native trace ordinal26 is paused at 07:14:05.728Z, followed by turn_aborted ordinal28 at 07:14:05.910Z.
- Re-enabling admission does not resume the goal or start another provider request.
- Explicit Owner resume returns confirmed/active with the same binding and starts original CLI continuation. Explicit pause returns confirmed/paused. Ordinary conversation stop remains a key-only operation.
- Owner clear returns confirmed with a native null goal readback.

Both isolated runs ended successfully and closed their own fixture. The initial run covered HTTP read/global pause/clear; the second added actual HTTP resume/pause. Raw scripts, reports, logs and artificial native traces are retained privately under `integrations/goals-composer-20261025/native-http-*`.

**Not complete:** ordinary CLI creation/editing, other CLI adapters and platform coverage remain with the Aiterm maintainer. This candidate reports create/edit=false rather than presenting working controls. The initial fixture uses the CLI itself to establish its artificial goal, so it is not HTTP creation evidence. The web UI's synthetic create/edit checks are separate. No production merge, installed CLI update or release approval is implied by this checkpoint.
