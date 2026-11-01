import { readFile, writeFile, copyFile } from 'node:fs/promises'

// Archive/quiet fixtures isolate the Python actor handoff; actual six-phase
// execution, locks and saved receipts are tested in sec014-internal-forward.py.
export async function copyInternalAdapter(source, target) {
  let text = await readFile(source, 'utf8')
  text = text.replace(/^.*# sec014-root-entry$/mu, ': # explicit root policy fixture')
  const start = text.indexOf('# sec014-actor-bootstrap-start'), end = text.indexOf('# sec014-actor-bootstrap-end')
  if (start < 0 || end < 0) return copyFile(source, target)
  const fixture = `sec014_actor() {
  [ "$1" = run ] || return 0
  BELLTEAM_STOPPED_CONTAINER_ID=$stopped_container sh "$saved/scripts/assert-state-writers-stopped.sh" --maintenance || return $?
  docker compose --project-directory "$PWD" -f "$saved/compose.state-prepare.yaml" -p "$project" run --pull never --rm --no-deps -T state-prepare || return $?
  docker compose --project-directory "$PWD" -f "$saved/compose.state-maintenance.json" -p "$project" run --pull never --rm --no-deps -T state-maintenance to-server || return $?
  docker compose up -d --no-build --pull never
}
`
  await writeFile(target, text.slice(0, start) + fixture + text.slice(end + '# sec014-actor-bootstrap-end'.length))
}
