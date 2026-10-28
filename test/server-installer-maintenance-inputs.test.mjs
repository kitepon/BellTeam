import { frozenComposeCases } from './helpers/installer-frozen-compose.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile), pinnedImage = 'sha256:' + '0'.repeat(64)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-maintenance-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install'), image = join(root, 'image'), bin = join(root, 'bin')
  for (const path of [install, join(image, 'scripts'), bin]) await mkdir(path, { recursive: true })
  const installer = process.env.INSTALLER_UNDER_TEST
    ? resolve(process.env.INSTALLER_UNDER_TEST) : new URL('../distribution/server/install.sh', import.meta.url)
  await copyFile(installer, join(install, 'install.sh'))
  for (const path of ['scripts/update-cursor.sh', 'scripts/assert-state-writers-stopped.sh', 'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'compose.state-prepare.yaml'])
    await copyFile(new URL('../' + path, import.meta.url), join(image, path))
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
${frozenComposeCases}
case "$*" in
 'compose config --images') echo fixture-server;;
 'image inspect --format {{.Id}} fixture-server') printf 'sha256:%064d\\n' 0;;
 'image inspect --format {{.Id}} sha256:'*) for image do :; done; echo "$image";;
 'compose config --format json')
   node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.env.TEST_NORMAL_MODEL));c.name=process.env.COMPOSE_PROJECT_NAME||c.name;console.log(JSON.stringify(c))';;
 'compose --project-directory '*'/install -f - -f '*'/compose.state-maintenance.json config --format json --no-path-resolution')
      cat > "$TEST_MODEL_IN"
      printf '%s\\n%s\\n%s\\n' "$COMPOSE_FILE" "\${COMPOSE_PROJECT_NAME-}" "\${BELLTEAM_SERVER_IMAGE-}" > "$TEST_RENDER"
      for path in BELLTEAM_LEGACY_DATA BELLTEAM_STATE_PARENT BELLTEAM_MAINTENANCE_BACKUP_PARENT; do
        eval 'value=\${'"$path"'-}'
        [ -n "$value" ] || { echo synthetic-required-input-missing >&2; exit 42; }
      done
      file=$7
      cat "$file" > "$TEST_RENDER_JSON"
      # Stop at rendering; this fixture never claims writer verification.
      exit 47;;
 'compose config --format yaml') printf '%s\\n' 'name: fixture' 'volumes:' '  cursor-cli:' '    name: fixture-cursor';;
 'compose port bellteam 4180') echo 127.0.0.1:18891;;
 *'/app/src/server-state-writers.mjs plan') echo '{"roots":[],"volume":"fixture-cursor"}';;
 'run --pull never --rm --network none --read-only --entrypoint /bin/cat '*'/app/'*)
   for path do :; done
   if [ "\${TEST_FAIL_MAINTENANCE_EXTRACT:-0}" = 1 ] && [ "$path" = /app/compose.state-maintenance.json ]; then exit 23; fi
   cat "$TEST_IMAGE/\${path#/app/}";;
esac
`)
  await chmod(join(bin, 'docker'), 0o700)
  const calls = join(root, 'calls'), rendered = join(root, 'rendered'), renderedJson = join(root, 'rendered.json')
  const normalModel = join(root, 'normal-model.json'), modelIn = join(root, 'model-in.json')
  await writeFile(normalModel, JSON.stringify({ name: 'dotenv-project', services: { bellteam: {
    image: 'fixture-server', environment: { KEEP: 'synthetic-normal-setting' },
    volumes: [{ type: 'bind', source: join(root, 'overlay-data'), target: '/srv/bellteam' }],
  } } }))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_IMAGE: image, TEST_CALLS: calls,
    TEST_RENDER: rendered, TEST_RENDER_JSON: renderedJson, TEST_NORMAL_MODEL: normalModel, TEST_MODEL_IN: modelIn, BELLTEAM_SERVER_IMAGE: '',
    BELLTEAM_LEGACY_DATA: join(root, 'legacy'), BELLTEAM_STATE_PARENT: join(root, 'prepared'),
    BELLTEAM_MAINTENANCE_BACKUP_PARENT: join(root, 'backups'), COMPOSE_PROJECT_NAME: 'existing-project' }
  return { root, install, image, calls, rendered, renderedJson, normalModel, modelIn, env,
    run: extra => exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }) }
}

test('installer merges the image-owned maintenance file into the full normal model, including dotenv-selected inputs', async t => {
  const f = await fixture(t)
  for (const mode of [':', ';', 'dotenv-only']) {
    const separator = mode === 'dotenv-only' ? ':' : mode
    const normal = mode === 'dotenv-only' ? '' : [join(f.install, 'base.yaml'), join(f.install, 'override.yaml')].join(separator)
    await writeFile(f.calls, '')
    await assert.rejects(f.run({ COMPOSE_FILE: normal, COMPOSE_PATH_SEPARATOR: separator }), error => error.code === 47)
    const [files, project, image] = (await readFile(f.rendered, 'utf8')).trimEnd().split('\n')
    assert.ok(files.endsWith('/normal.json'))
    assert.equal(project, 'existing-project'); assert.equal(image, pinnedImage)
    const expected = JSON.parse(await readFile(f.normalModel, 'utf8')); expected.name = 'existing-project'; expected.services.bellteam.image = pinnedImage
    assert.deepEqual(JSON.parse(await readFile(f.modelIn, 'utf8')), expected)
    const model = JSON.parse(await readFile(f.renderedJson, 'utf8'))
    assert.deepEqual(Object.keys(model.services), ['state-maintenance'])
    assert.equal(model.services['state-maintenance'].image, pinnedImage)
    const calls = await readFile(f.calls, 'utf8')
    assert.ok(calls.includes(`compose --project-directory ${f.install} -f - -f `))
    assert.match(calls, /stop cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n/)
    assert.doesNotMatch(calls, /compose run |cursor-update$|compose up /m)
  }
})

test('missing legacy, prepared-state or backup input refuses before maintenance run and normal start', async t => {
  const f = await fixture(t)
  for (const key of ['BELLTEAM_LEGACY_DATA', 'BELLTEAM_STATE_PARENT', 'BELLTEAM_MAINTENANCE_BACKUP_PARENT']) {
    await writeFile(f.calls, '')
    await assert.rejects(f.run({ [key]: '', COMPOSE_FILE: 'compose.yaml', COMPOSE_PATH_SEPARATOR: ':' }), error => error.code === 42)
    assert.doesNotMatch(await readFile(f.calls, 'utf8'), /compose run |cursor-update$|compose up /m)
  }
})

test('failure to extract the accepted image maintenance file leaves the normal service untouched', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_FAIL_MAINTENANCE_EXTRACT: '1' }), error => error.code === 1)
  assert.doesNotMatch(await readFile(f.calls, 'utf8'), /(stop [a-f0-9]|compose (run|up) )/)
})
