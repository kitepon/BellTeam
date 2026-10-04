#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
runtime_home="$repo_dir/runtime/home"
host_codex_home=${CODEX_HOME:-${HOME}/.codex}
host_grok_home=${GROK_HOME:-${HOME}/.grok}

install -d -m 700 "$runtime_home/.codex" "$runtime_home/.grok" "$repo_dir/runtime/data"
install -m 600 "$host_codex_home/auth.json" "$runtime_home/.codex/auth.json"
install -m 600 "$host_grok_home/auth.json" "$runtime_home/.grok/auth.json"
if [[ -f "$host_grok_home/agent_id" ]]; then
  install -m 600 "$host_grok_home/agent_id" "$runtime_home/.grok/agent_id"
fi

echo 'BellTeam用のCodex/Grok認証を投入した（値は表示していない）'
