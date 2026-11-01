import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { stateWriterPlan, stateWriterSources, assertStateWritersStopped } from '../src/server-state-writers.mjs'

const declared = JSON.parse(await readFile(new URL('../compose.state-maintenance.json', import.meta.url), 'utf8'))
const service = structuredClone(declared.services['state-maintenance'])
// Artificial normalized Compose input; no daemon is used.
service.volumes[0].source = '/runtime'
const normal = { volumes: [
  { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' },
  { type: 'bind', source: '/runtime/home', target: '/home/bell' },
  { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
] }
const config = { services: { bellteam: normal, 'state-maintenance': service }, volumes: { 'cursor-cli': { name: 'fixture_cursor' } } }
const container = source => ({ id: 'synthetic-writer', running: true, restarting: false, restartPolicy: 'no',
  mounts: [{ Type: 'bind', Source: source, RW: true }] })
const canonical = (plan, containers) => stateWriterSources(plan, containers).map(source => ({ source, canonical: source }))

test('単一runtimeの祖先とprivate state writerも停止確認し、ROと停止済みは許す', () => {
  const plan = stateWriterPlan(config)
  for (const source of ['/', '/runtime', '/runtime/server-only/state-data', '/runtime/server-only/state-data/rooms']) {
    const active = [container(source)]
    assert.throws(() => assertStateWritersStopped(plan, active, canonical(plan, active)), /WRITERS_RUNNING/)
    active[0].mounts[0].RW = false
    assert.deepEqual(assertStateWritersStopped(plan, active, canonical(plan, active)), { writers: 0 })
    active[0].mounts[0].RW = true; active[0].running = false
    assert.deepEqual(assertStateWritersStopped(plan, active, canonical(plan, active)), { writers: 0 })
  }
})

test('通常serviceの新6bindも保護し、別名writerをcanonical照合で拒否する', () => {
  const c = structuredClone(config)
  c.services.bellteam.volumes.push(...['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'].map(name => ({type:'bind',source:'/runtime/server-only/state-data/'+name.split('/').at(-1),target:'/srv/bellteam/'+name})))
  delete c.services['state-maintenance']
  const plan = stateWriterPlan(c), active = [container('/alias')]
  const aliases = canonical(plan, active).map(row => row.source === '/alias' ? { ...row, canonical: '/runtime/server-only/state-data/owner' } : row)
  assert.throws(() => assertStateWritersStopped(plan, active, aliases), /WRITERS_RUNNING/)
})

test('部分6bind・maintenanceの欠測や余分なmount・ROを停止済みへ丸めない', () => {
  for (const mutate of [
    c => c.services.bellteam.volumes.push({type:'bind',source:'/runtime/server-only/state-data/state',target:'/srv/bellteam/state'}),
    c => c.services['state-maintenance'].volumes.pop(),
    c => c.services['state-maintenance'].volumes.push({ type: 'bind', source: '/x', target: '/home/bell' }),
    c => c.services['state-maintenance'].volumes[0].read_only = true,
    c => c.services['state-maintenance'].volumes[0].source = 'relative',
    c => c.services['state-maintenance'].volumes[0].target = '/unexpected',
  ]) {
    const broken = structuredClone(config); mutate(broken)
    assert.throws(() => stateWriterPlan(broken), /WRITER_METADATA_INVALID/)
  }
})

test('固定保守Composeは秘密の通常envを継承せず、単一runtime bindとdirectory flockだけを宣言する', () => {
  const s = declared.services['state-maintenance']
  assert.equal(declared.name, undefined, 'writer確認でnormal Composeと読む時、既存Cursor volumeのproject名を変えない')
  assert.deepEqual(Object.keys(declared.services), ['state-maintenance'])
  assert.deepEqual(s.entrypoint.slice(0,6), ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', '/bin/sh', '-ec', s.entrypoint[5]])
  assert.match(s.entrypoint[5], /flock -x -n -E 75/)
  assert.match(s.entrypoint[5], /server-state-transfer.mjs/)
  assert.deepEqual(s.command, ['to-server'])
  for (const key of ['environment', 'env_file', 'secrets', 'configs', 'ports', 'extends', 'build']) assert.equal(s[key], undefined)
  assert.equal(s.volumes.length, 1)
  assert.equal(s.volumes[0].source, './runtime')
  assert.ok(s.volumes.every(mount => mount.type === 'bind' && mount.bind.create_host_path === false))
  assert.ok(s.volumes.every(mount => !/home|docker.sock/u.test(mount.target)))
  assert.deepEqual(s.cap_drop, ['ALL']); assert.deepEqual(s.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
  assert.equal(s.network_mode, 'none'); assert.equal(s.read_only, true)
})

test('保守planは構成に含む資格情報を出力しない', () => {
  const c = structuredClone(config)
  c.services.bellteam.environment = { SECRET: 'synthetic-secret' }
  assert.doesNotMatch(JSON.stringify(stateWriterPlan(c)), /SECRET|synthetic-secret/)
})

test('writer CLIは保守flag以外をDocker前に拒否し、通常modelへ保守Composeを合成する', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = join(root, 'calls'), fake = join(root, 'docker')
  await writeFile(fake, `#!/bin/sh
printf '%s|%s\\n' "$*" "\${COMPOSE_FILE-}" >> "$TEST_CALLS"
case "$*" in
  'compose config --images') echo fixture;;
  'image inspect --format {{.Id}} fixture') printf 'sha256:%064d\\n' 0;;
  'compose config --format json') echo '{}';;
  'compose --project-directory '*'/compose.state-maintenance.json config --format json --no-path-resolution') exit 47;;
  *) exit 49;;
esac
`); await chmod(fake, 0o700)
  const exec = promisify(execFile), script = new URL('../scripts/assert-state-writers-stopped.sh', import.meta.url).pathname
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_CALLS: calls,
    COMPOSE_FILE: '', COMPOSE_PATH_SEPARATOR: ':' }
  await assert.rejects(exec('sh', [script, '--unknown'], { env }), error => error.code === 1 && error.stderr === 'SERVER_STATE_WRITER_ARGUMENTS_INVALID\n')
  await assert.rejects(readFile(calls), { code: 'ENOENT' })
  await assert.rejects(exec('sh', [script, '--maintenance'], { env }), error => error.code === 47)
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').at(-1),
    `compose --project-directory ${process.cwd()} -f - -f ${new URL('../compose.state-maintenance.json', import.meta.url).pathname} config --format json --no-path-resolution|`)
})

test('maintenance composition keeps the callers explicit normal overlay and project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = join(root, 'calls'), fake = join(root, 'docker')
  await writeFile(fake, `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${COMPOSE_FILE-}" "\${COMPOSE_PROJECT_NAME-}" >> "$TEST_CALLS"
case "$*" in
  'compose config --images') echo fixture;;
  'image inspect --format {{.Id}} fixture') printf 'sha256:%064d\\n' 0;;
  'compose config --format json') echo '{}';;
  'compose --project-directory '*'/compose.state-maintenance.json config --format json --no-path-resolution') exit 47;;
  *) exit 49;;
esac
`); await chmod(fake, 0o700)
  const exec = promisify(execFile), script = new URL('../scripts/assert-state-writers-stopped.sh', import.meta.url).pathname
  for (const separator of [':', ';']) {
    await writeFile(calls, '')
    const normal = ['/normal/base.yaml', '/normal/override.yaml'].join(separator)
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_CALLS: calls,
      COMPOSE_FILE: normal, COMPOSE_PATH_SEPARATOR: separator, COMPOSE_PROJECT_NAME: 'existing-project' }
    await assert.rejects(exec('sh', [script, '--maintenance'], { env }), error => error.code === 47)
    const lines = (await readFile(calls, 'utf8')).trim().split('\n')
    assert.equal(lines.at(-1), `compose --project-directory ${process.cwd()} -f - -f ${new URL('../compose.state-maintenance.json', import.meta.url).pathname} config --format json --no-path-resolution|${normal}|existing-project`)
  }
})
