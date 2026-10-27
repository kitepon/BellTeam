# Preserve CLI-specific native goal state

PR79 remains a draft. The upstream v2 prototype is not the published Aiterm
0.61.17. It adds Claude's native condition/status without inventing Codex
accounting. Codex v1 snapshots remain unchanged. V2 snapshots retain their
native tagged shape:

```json
{"kind":"claude-code","phase":"active","native":{"type":"goal_status","condition":"Example condition","met":false}}
```

Claude may return native tokens, durationMs, iterations and reported_turns;
missing values stay absent. A current null goal and a prior cleared/achieved
record are separate. HTTP maps upstream native_history to nativeHistory; its
kind, terminal and native fields are retained. A cleared sentinel is not an
achievement. A v2 Codex goal is {kind:"codex-cli", native:<ThreadGoal>}; its
thread must match the same binding.

The HTTP service validates tagged goal fields, native optional numeric fields
and history semantics. MCP isError preserves v1/v2 structured results. Unknown
readback keeps goal absent and returns unconfirmed, without mutation replay.
Native operation capabilities and goal-state restrictions both apply. The
ce49cef upstream prototype supports Claude inspect/clear; creation, editing,
pause/resume and their fields remain unsupported. Whole-application stop
retains a partial result when native pause is unsupported.

The Web view renders each CLI's actual metrics and only supported controls.
It does not claim Claude pause/resume or substitute zero usage. Current null
remains “no goal”; previous cancellation is shown separately.

27 related tests and the explicit full source gate (784 tests) passed with
zero failure/cancellation/skip. A real HTTP/server/service fixture exercised
Claude active inspect, one clear, subsequent null+cleared-history readback,
and one unknown clear returning 202 with goal absent. Its MCP responses were
artificial typed data; no native Claude worker was controlled by this fixture.
The upstream maintainer's normal-MCP proof is separate. Final native exact-tar,
OS, publication and installed-image gates remain incomplete.
