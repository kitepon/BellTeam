import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import test from 'node:test'

const adapter = await readFile(new URL('../scripts/deploy-image.sh', import.meta.url), 'utf8')
const bootstrap = adapter.slice(adapter.indexOf('# sec014-actor-bootstrap-start'), adapter.indexOf('# sec014-actor-bootstrap-end'))

test('internal bootstrap refuses an ordinary user before any actor import or native command', { skip: process.getuid?.() === 0 }, async () => {
  const run = promisify(execFile)
  await assert.rejects(run('/bin/sh', ['-c', bootstrap+'\nrepo=/unavailable; saved=/unavailable; sec014_actor preflight\n']),
    error => error.code !== 0 && error.stderr.includes('SEC014_INTERNAL_ROOT_REQUIRED') && !error.stdout)
})

test('canonical adapter passes its saved generation and exact old CID to the phase actor', () => {
  assert.match(bootstrap, /a\.run_actor\('to-server',image,lambda tx:a\._InternalForward\(tx,stopped\),saved_normal=normal\)/u)
  const preflight = adapter.indexOf('\nsec014_actor preflight'), stop = adapter.indexOf('docker stop "$stopped_container"'), run = adapter.indexOf('\nsec014_actor run')
  assert.ok(preflight > 0 && preflight < adapter.indexOf('sh "$staging/scripts/update-cursor.sh"') && preflight < stop && stop < run)
  assert.doesNotMatch(adapter.slice(stop), /assert-state-writers-stopped\.sh|run --pull never|compose up/u)
})
