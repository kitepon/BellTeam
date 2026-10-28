import { frozenComposeCases } from './helpers/installer-frozen-compose.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile), pinnedImage = 'sha256:' + '0'.repeat(64)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-prepare-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install'), image = join(root, 'image'), bin = join(root, 'bin')
  for (const path of [install, join(image, 'scripts'), bin]) await mkdir(path, { recursive: true })
  await copyFile(process.env.INSTALLER_UNDER_TEST ? resolve(process.env.INSTALLER_UNDER_TEST)
    : new URL('../distribution/server/install.sh', import.meta.url), join(install, 'install.sh'))
  for (const path of ['scripts/update-cursor.sh', 'scripts/assert-state-writers-stopped.sh', 'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'compose.state-prepare.yaml'])
    await copyFile(new URL('../' + path, import.meta.url), join(image, path))
  const calls = join(root, 'calls'), file = join(root, 'prepare-file'), inputs = join(root, 'prepare-inputs'), partial = join(root, 'partial')
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
${frozenComposeCases}
case "$*" in
 'compose config --images') echo fixture:accepted;;
 'image inspect --format {{.Id}} fixture:accepted') printf 'sha256:%064d\\n' 0;;
 'image inspect --format {{.Id}} sha256:'*) for image do :; done; echo "$image";;
 'compose config --format json') printf '{"name":"%s","services":{"bellteam":{"image":"fixture:accepted"}}}\\n' "\${COMPOSE_PROJECT_NAME:-dotenv-project}";;
 'compose config --format yaml') printf '%s\\n' "name: \${COMPOSE_PROJECT_NAME:-dotenv-project}" 'volumes:' '  cursor-cli:' '    name: fixture-cursor';;
 'compose --project-directory '*'/install -f - -f '*'/compose.state-maintenance.json config --format json --no-path-resolution') cat;;
 *'/app/src/server-state-writers.mjs plan') cat >/dev/null; echo '{"roots":[],"volume":"fixture-cursor"}';;
 'run --pull never --rm --network none --read-only --entrypoint /bin/cat '*'/app/'*)
   for path do :; done
   if [ "$path" = /app/compose.state-prepare.yaml ] && [ "\${TEST_EXTRACT_FAIL:-0}" = 1 ]; then exit 62; fi
   cat "$TEST_IMAGE/\${path#/app/}";;
 'compose --project-directory '*'/install -f '*'/compose.state-prepare.yaml -p '*' run --pull never --rm --no-deps -T state-prepare')
   cat "$5" > "$TEST_FILE"
   printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$7" "$BELLTEAM_SERVER_IMAGE" "$BELLTEAM_STATE_PARENT" "$BELLTEAM_LEGACY_DATA" "$BELLTEAM_MAINTENANCE_BACKUP_PARENT" > "$TEST_INPUTS"
   if [ "\${TEST_PREPARE_FAIL:-0}" = 1 ]; then echo synthetic-unfinished-leaves > "$TEST_PARTIAL"; exit 61; fi;;
 'compose port bellteam 4180') echo 127.0.0.1:18891;;
esac
`)
  await chmod(join(bin, 'docker'), 0o700)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_IMAGE: image, TEST_CALLS: calls,
    TEST_FILE: file, TEST_INPUTS: inputs, TEST_PARTIAL: partial,
    BELLTEAM_STATE_PARENT: '/private/state-parent', BELLTEAM_LEGACY_DATA: '/installation/legacy', BELLTEAM_MAINTENANCE_BACKUP_PARENT: '/private/backups' }
  return { root, install, image, calls, file, inputs, partial,
    run: extra => exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }) }
}

test('installer runs the image-owned prepare alone after writer check and before migration with the same project and input selection', async t => {
  const f = await fixture(t)
  for (const separator of [':', ';', 'dotenv-model']) {
    await writeFile(f.calls, '')
    const project = separator === 'dotenv-model' ? '' : 'existing-project'
    await f.run({ COMPOSE_FILE: separator === 'dotenv-model' ? '' : ['config/base.yaml', 'config/override.yaml'].join(separator),
      COMPOSE_PATH_SEPARATOR: separator === ';' ? ';' : ':', COMPOSE_PROJECT_NAME: project })
    const calls = (await readFile(f.calls, 'utf8')).trimEnd().split('\n')
    const prepare = calls.findIndex(call => call.endsWith('run --pull never --rm --no-deps -T state-prepare'))
    const verify = calls.findIndex(call => call.endsWith('/app/src/server-state-writers.mjs verify'))
    const migration = calls.findIndex(call => call.endsWith('state-maintenance to-server'))
    assert.ok(prepare > verify && verify >= 0 && migration > prepare)
    assert.ok(calls.findIndex(call => call.endsWith('--no-deps cursor-update')) > migration)
    assert.ok(calls.indexOf('compose up -d --wait --wait-timeout 120 --pull never') > migration)
    const model = JSON.parse(await readFile(f.file, 'utf8'))
    assert.deepEqual(Object.keys(model.services), ['state-prepare'])
    assert.equal(model.services['state-prepare'].image, pinnedImage)
    assert.deepEqual((await readFile(f.inputs, 'utf8')).trimEnd().split('\n'),
      [project || 'dotenv-project', pinnedImage, '/private/state-parent', '/installation/legacy', '/private/backups'])
    assert.doesNotMatch(calls[prepare], /-f -|state-prepare .+/)
    assert.doesNotMatch(calls.join('\n'), /compose run .*--user 0:0|chown|mkdir -p/)
  }
})

test('prepare failure is propagated once and its partial result is kept without migration, Cursor update or normal startup', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_PREPARE_FAIL: '1' }), error => error.code === 61)
  const calls = await readFile(f.calls, 'utf8')
  assert.equal(calls.split('\n').filter(call => call.endsWith('-T state-prepare')).length, 1)
  assert.doesNotMatch(calls, /state-maintenance to-server|--no-deps cursor-update|compose up /)
  assert.equal(await readFile(f.partial, 'utf8'), 'synthetic-unfinished-leaves\n')
})

test('prepare file extraction failure stops before changing the running server', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_EXTRACT_FAIL: '1' }), error => error.code === 1)
  assert.doesNotMatch(await readFile(f.calls, 'utf8'), /stop [a-f0-9]|run .* -T state-prepare|state-maintenance to-server|--no-deps cursor-update|compose up /)
})
