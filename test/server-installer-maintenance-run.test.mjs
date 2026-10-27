import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-maintenance-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install'), image = join(root, 'image'), bin = join(root, 'bin')
  for (const path of [install, join(image, 'scripts'), bin]) await mkdir(path, { recursive: true })
  await copyFile(process.env.INSTALLER_UNDER_TEST ? resolve(process.env.INSTALLER_UNDER_TEST)
    : new URL('../distribution/server/install.sh', import.meta.url), join(install, 'install.sh'))
  for (const path of ['scripts/update-cursor.sh', 'scripts/assert-state-writers-stopped.sh', 'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'compose.state-prepare.yaml'])
    await copyFile(new URL('../' + path, import.meta.url), join(image, path))
  const model = { name: 'selected-project', services: { bellteam: { image: 'fixture:accepted',
    environment: { SECRET: 'synthetic-normal-only' }, volumes: [] } } }
  const modelPath = join(root, 'normal.json')
  await writeFile(modelPath, JSON.stringify(model))
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
 'compose config --images') echo fixture:accepted;;
 'image inspect --format {{.Id}} fixture:accepted') printf 'sha256:%064d\\n' 0;;
 'compose config --format json') cat "$TEST_MODEL";;
 'compose config --format yaml')
   count=0; if [ -f "$TEST_COUNT" ]; then count=$(cat "$TEST_COUNT"); fi
   count=$((count+1)); echo "$count" > "$TEST_COUNT"
   if [ "$count" -eq 1 ] && [ "\${TEST_NORMAL_CONFIG_FAILURE:-0}" = 1 ]; then exit 53; fi
   printf '%s\\n' "name: \${COMPOSE_PROJECT_NAME:-\${TEST_DOTENV_PROJECT:-selected-project}}" 'volumes:' '  cursor-cli:' '    name: fixture-cursor';;
 'compose --project-directory '*'/install -f - -f '*'/compose.state-maintenance.json config --format json --no-path-resolution') cat;;
 *'/app/src/server-state-writers.mjs plan') cat >/dev/null; echo '{"roots":[],"volume":"fixture-cursor"}';;
 *'/app/src/server-state-writers.mjs verify') exit "\${TEST_WRITER_EXIT:-0}";;
 'run --pull never --rm --network none --read-only --entrypoint /bin/cat fixture:accepted /app/'*)
   for path do :; done; cat "$TEST_IMAGE/\${path#/app/}";;
 'compose --project-directory '*'/install -f '*'/compose.state-maintenance.json -p '*' run --pull never --rm --no-deps -T state-maintenance to-server')
   printf '%s\\n%s\\n%s\\n%s\\n' "\${COMPOSE_FILE-}" "\${COMPOSE_PROJECT_NAME-}" "$BELLTEAM_SERVER_IMAGE" "$7" > "$TEST_MAINTENANCE_ENV"
   cat "$5" > "$TEST_MAINTENANCE_FILE"
   if [ "\${TEST_MAINTENANCE_EXIT:-0}" != 0 ]; then echo synthetic-partial-held > "$TEST_PARTIAL"; fi
   exit "\${TEST_MAINTENANCE_EXIT:-0}";;
 'compose port bellteam 4180') echo 127.0.0.1:18891;;
esac
`)
  await chmod(join(bin, 'docker'), 0o700)
  const names = ['calls', 'count', 'maintenance-env', 'maintenance-file', 'partial']
  const files = Object.fromEntries(names.map(name => [name, join(root, name)]))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_MODEL: modelPath, TEST_IMAGE: image,
    TEST_CALLS: files.calls, TEST_COUNT: files.count,
    TEST_MAINTENANCE_ENV: files['maintenance-env'], TEST_MAINTENANCE_FILE: files['maintenance-file'], TEST_PARTIAL: files.partial }
  return { root, install, image, files,
    run: extra => exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }) }
}

test('installer invokes the standalone image-owned fixed service with the normal project and no root normal-service run', async t => {
  const f = await fixture(t)
  for (const mode of [':', ';', 'dotenv-model']) {
    await writeFile(f.files.calls, ''); await writeFile(f.files.count, '0')
    const normal = mode === 'dotenv-model' ? '' : ['/config/base.yaml', '/config/override.yaml'].join(mode)
    const project = mode === 'dotenv-model' ? '' : 'existing-project'
    const { stdout } = await f.run({ COMPOSE_FILE: normal, COMPOSE_PATH_SEPARATOR: mode === ';' ? ';' : ':', COMPOSE_PROJECT_NAME: project, TEST_DOTENV_PROJECT: 'dotenv-project' })
    const calls = (await readFile(f.files.calls, 'utf8')).trimEnd().split('\n')
    const transfer = calls.findIndex(call => call.endsWith('run --pull never --rm --no-deps -T state-maintenance to-server'))
    assert.ok(transfer > calls.findIndex(call => call.endsWith('/app/src/server-state-writers.mjs verify')))
    assert.ok(calls.findIndex(call => call.endsWith('--no-deps cursor-update')) > transfer)
    assert.doesNotMatch(calls.join('\n'), /compose run .*--user 0:0|--entrypoint \/bin\/sh bellteam|bellteam \/app\/src\/server-state-transfer/)
    assert.deepEqual((await readFile(f.files['maintenance-env'], 'utf8')).trimEnd().split('\n'), [normal, project, 'fixture:accepted', project || 'dotenv-project'])
    assert.deepEqual(await readFile(f.files['maintenance-file']), await readFile(join(f.image, 'compose.state-maintenance.json')))
    assert.doesNotMatch(stdout, /synthetic-normal-only/)
  }
})

test('maintenance failure propagates once and retains partial state without Cursor or normal start', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_MAINTENANCE_EXIT: '52' }), error => error.code === 52)
  const calls = await readFile(f.files.calls, 'utf8')
  assert.equal(calls.split('\n').filter(call => call.endsWith('state-maintenance to-server')).length, 1)
  assert.doesNotMatch(calls, /--no-deps cursor-update|compose up /)
  assert.equal(await readFile(f.files.partial, 'utf8'), 'synthetic-partial-held\n')
})

test('normal project read failure after writer check stops before maintenance or subsequent startup', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_NORMAL_CONFIG_FAILURE: '1' }), error => error.code === 53)
  assert.doesNotMatch(await readFile(f.files.calls, 'utf8'), /state-maintenance to-server|compose run .*--user 0:0|--no-deps cursor-update|compose up /)
})

test('writer refusal still blocks the fixed maintenance invocation and normal startup', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_WRITER_EXIT: '54' }), error => error.code === 54)
  assert.doesNotMatch(await readFile(f.files.calls, 'utf8'), /state-maintenance to-server|--no-deps cursor-update|compose up /)
})
