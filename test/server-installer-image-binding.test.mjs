import { frozenComposeCases } from './helpers/installer-frozen-compose.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile), oldId = 'sha256:' + 'a'.repeat(64), newId = 'sha256:' + 'b'.repeat(64)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-image-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install'), image = join(root, 'image'), bin = join(root, 'bin')
  for (const path of [install, join(image, 'scripts'), bin]) await mkdir(path, { recursive: true })
  await copyFile(process.env.INSTALLER_UNDER_TEST ? resolve(process.env.INSTALLER_UNDER_TEST)
    : new URL('../distribution/server/install.sh', import.meta.url), join(install, 'install.sh'))
  for (const path of ['scripts/update-cursor.sh', 'scripts/assert-state-writers-stopped.sh', 'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'compose.state-prepare.yaml'])
    await copyFile(path === 'scripts/assert-state-writers-stopped.sh' && process.env.WRITER_CHECK_UNDER_TEST
      ? resolve(process.env.WRITER_CHECK_UNDER_TEST) : new URL('../' + path, import.meta.url), join(image, path))
  const calls = join(root, 'calls'), runs = join(root, 'runs'), inspected = join(root, 'inspected')
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
${frozenComposeCases}
case "$*" in
 'compose config --images')
   if [ "\${TEST_FIXED_TAG:-0}" = 1 ]; then echo fixture:mutable
   else echo "\${BELLTEAM_SERVER_IMAGE:-fixture:mutable}"; fi;;
 'image inspect --format {{.Id}} '*)
   [ "\${TEST_INSPECT_FAIL:-0}" = 0 ] || exit 72
   for image do :; done
   case "$image" in
     fixture:mutable)
       if [ -f "$TEST_INSPECTED" ]; then echo "$TEST_NEW_ID"
       else echo "$TEST_OLD_ID"; : > "$TEST_INSPECTED"; fi;;
     "$TEST_OLD_ID"|"$TEST_NEW_ID") echo "$image";;
   esac;;
 'compose config --format json') echo '{"name":"fixture","services":{"bellteam":{"image":"fixture:mutable"}}}';;
 'compose config --format yaml') printf '%s\\n' 'name: fixture' 'volumes:' '  cursor-cli:' '    name: fixture-cursor';;
 'compose --project-directory '*'/install -f - -f '*'/compose.state-maintenance.json config --format json --no-path-resolution') cat;;
 *'/app/src/server-state-writers.mjs plan') cat >/dev/null; echo '{"roots":[],"volume":"fixture-cursor"}';;
 'run --pull never --rm --network none --read-only --entrypoint /bin/cat '*'/app/'*)
   for path do :; done; cat "$TEST_IMAGE/\${path#/app/}";;
 'compose --project-directory '*'-T state-prepare'|'compose --project-directory '*'-T state-maintenance to-server'|'compose up -d --wait --wait-timeout 120 --pull never')
   printf '%s\\n' "$BELLTEAM_SERVER_IMAGE" >> "$TEST_RUNS";;
 'compose port bellteam 4180') echo 127.0.0.1:18891;;
esac
`)
  await chmod(join(bin, 'docker'), 0o700)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BELLTEAM_SERVER_IMAGE: '',
    TEST_CALLS: calls, TEST_RUNS: runs, TEST_INSPECTED: inspected, TEST_IMAGE: image, TEST_OLD_ID: oldId, TEST_NEW_ID: newId }
  return { calls, runs, run: extra => exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }) }
}

test('installer pins the initially selected image ID for extraction, reader and fixed services despite a mutable tag change', async t => {
  const f = await fixture(t)
  await f.run()
  const calls = (await readFile(f.calls, 'utf8')).trimEnd().split('\n')
  const extracted = calls.filter(call => call.includes('--entrypoint /bin/cat'))
  assert.equal(extracted.length, 5)
  assert.ok(extracted.every(call => call.includes(oldId)))
  const readers = calls.filter(call => call.includes('/app/src/server-state-writers.mjs'))
  assert.ok(readers.length > 0 && readers.every(call => call.includes(oldId)))
  assert.deepEqual((await readFile(f.runs, 'utf8')).trimEnd().split('\n'), [oldId, oldId, oldId])
  assert.ok(calls.indexOf('image inspect --format {{.Id}} fixture:mutable') < calls.indexOf('stop cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'))
  assert.ok(!calls.some(call => call.includes(newId)))
})

test('failure to resolve the initial image ID leaves the normal service untouched', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_INSPECT_FAIL: '1' }), error => error.code === 72)
  assert.doesNotMatch(await readFile(f.calls, 'utf8'), /stop [a-f0-9]|--entrypoint \/bin\/cat|state-prepare|state-maintenance to-server|--no-deps cursor-update|compose up /)
})

test('a fixed normal image tag is captured before it can be reselected', async t => {
  const f = await fixture(t)
  await f.run({ TEST_FIXED_TAG: '1' })
  const calls = await readFile(f.calls, 'utf8')
  assert.match(calls, /stop cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/)
  assert.ok(!calls.includes(newId))
  assert.deepEqual((await readFile(f.runs, 'utf8')).trimEnd().split('\n'), [oldId, oldId, oldId])
})
