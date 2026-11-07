import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 共通規範 SECTION git: 本番repoのgitはrootではなく所有者kiteで動かす。
// rootが書いたref/object/作業ファイルは所有者が更新できず、次のfetchごと止まる（2026-11-01、2026-11-06）。
test('deploy git: fetch, dirty check and merge run as the repository owner, never inside the root block', () => {
  const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8')
  const [before, rest] = script.split("<<'REMOTE'\n")
  const [rootBlock, after] = rest.split('\nREMOTE\n')
  // root may only read (rev-parse for the snapshot's source record); every writing git command runs as the owner.
  assert.doesNotMatch(rootBlock, /git (fetch|merge|pull|checkout|reset|status|commit|push)\b|\['(fetch|merge|pull|checkout|reset|status|commit|push)'/, 'no writing git command inside the sudo remote block')
  assert.match(before, /^if ! ssh "\$host" "cd \$dir && git fetch -q origin && test -z .*git status --porcelain --untracked-files=no/m, 'owner fetch and dirty check before the root block')
  assert.match(after, /^ssh "\$host" "cd \$dir && git merge -q --ff-only origin\/main && test .*git rev-parse HEAD.* = \$head/m, 'owner merge after the snapshot, verified against the pushed head')
  assert.ok(after.indexOf('git merge -q --ff-only') < after.indexOf('deploy-host.sh'), 'merge happens before the host-side deploy')
})
