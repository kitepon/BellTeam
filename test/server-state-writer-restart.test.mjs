import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const { assertStateWritersStopped, stateWriterSources } = await import(process.env.WRITER_SOURCE_UNDER_TEST
  || new URL('../src/server-state-writers.mjs', import.meta.url).href)

const cid = 'c'.repeat(64), other = 'd'.repeat(64)
const plan = { roots: ['/runtime/data', '/runtime/home'], volume: 'cursor' }
const bind = source => ({ Type: 'bind', Source: source, RW: true })
const stopped = (restartPolicy, mounts = [bind('/runtime/data')], id = cid) =>
  ({ id, running: false, restarting: false, restartPolicy, mounts })
const canonical = (p, containers, volumes = []) => stateWriterSources(p, containers, volumes)
  .map(source => ({ source, canonical: source === '/alias' ? '/runtime/data/state' : source }))
const check = (p, containers, volumes = []) => assertStateWritersStopped(p, containers, canonical(p, containers, volumes), volumes)

test('writer restart: dormant auto-restart bind and backing-volume writers remain in the denominator', () => {
  for (const policy of ['always', 'on-failure', 'unless-stopped']) {
    for (const source of ['/runtime', '/runtime/data/state', '/runtime/home', '/alias'])
      assert.throws(() => check(plan, [stopped(policy, [bind(source)])]), /WRITERS_RUNNING/)
    const volumes = [{ name: 'other', driver: 'local', mountpoint: '/docker/other', optionCount: 3,
      type: 'none', device: '/alias', options: 'bind' }]
    const containers = [stopped(policy, [{ Type: 'volume', Name: 'other', Source: '/docker/other', RW: true }])]
    assert.throws(() => check(plan, containers, volumes), /WRITERS_RUNNING/)
    assert.deepEqual(check(plan, [stopped(policy, [bind('/unrelated')])]), { writers: 0 })
  }
  assert.deepEqual(check(plan, [stopped('no')]), { writers: 0 })
  for (const policy of [undefined, null, 'unknown'])
    assert.throws(() => check(plan, [stopped(policy)]), /WRITER_METADATA_INVALID/)
})

test('writer restart: only the exact caller-stopped unless-stopped identity is exempt; raw observations stay unchanged', () => {
  const p = { ...plan, stoppedContainer: cid }, containers = [stopped('unless-stopped')]
  const original = structuredClone(containers)
  assert.deepEqual(check(p, containers), { writers: 0 })
  assert.deepEqual(containers, original)
  for (const rows of [[], [stopped('unless-stopped', [bind('/runtime/data')], other)],
    [...containers, ...containers], [{ ...containers[0], running: true }], [{ ...containers[0], restarting: true }]])
    assert.throws(() => check(p, rows), /WRITER_METADATA_INVALID/)
  for (const policy of ['always', 'on-failure'])
    assert.throws(() => check(p, [stopped(policy)]), /WRITERS_RUNNING/)
  assert.throws(() => check(p, [...containers, stopped('unless-stopped', [bind('/alias')], other)]), /WRITERS_RUNNING/)
  assert.throws(() => check({ ...plan, stoppedContainer: 'short' }, containers), /WRITER_METADATA_INVALID/)
})

test('writer restart: real checker shell passes selected CID and actual policy to the image reader without a Docker socket', async t => {
  const root = await mkdtemp(join(tmpdir(), 'writer-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = root + '/runtime', home = root + '/home'
  await mkdir(runtime)
  const config = { services: { bellteam: { volumes: [
    { type: 'bind', source: runtime, target: '/srv/bellteam' },
    { type: 'bind', source: home, target: '/home/bell' },
    { type: 'volume', source: 'cursor', target: '/home/bell/.local' },
  ] } }, volumes: { cursor: { name: 'cursor' } } }
  const source = process.env.WRITER_SOURCE_UNDER_TEST || new URL('../src/server-state-writers.mjs', import.meta.url).pathname
  await writeFile(root + '/docker', '#!' + process.execPath + '\n' + String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),e=process.env;
const out=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
fs.appendFileSync(e.TEST_CALLS,JSON.stringify(a)+'\n');
if(a[0]==='compose'){out(a.includes('--images')?'fixture':JSON.parse(e.TEST_CONFIG));process.exit(0)}
if(a[0]==='image'){out('sha256:'+'a'.repeat(64));process.exit(0)}
if(a[0]==='ps'){out('c'.repeat(64));process.exit(0)}
if(a[0]==='inspect'){
 const c=JSON.parse(e.TEST_CONTAINER);
 if(!a[2].includes('.HostConfig.RestartPolicy.Name'))delete c.restartPolicy;
 out(c);process.exit(0)
}
if(a[0]==='run'){
 const mode=a.at(-1),mount=a[a.indexOf('--mount')+1];let file=e.TEST_SOURCE;
 if(a.includes('--mount')){
  const dir=mount.match(/^type=bind,source=(.+),target=\/check,readonly$/)?.[1];
  if(!dir)throw Error('reader mount must be evidence only');
  file=e.TEST_ROOT+'/reader.mjs';fs.writeFileSync(file,fs.readFileSync(e.TEST_SOURCE,'utf8').replaceAll('/check/',dir+'/'));
 }
 const result=cp.spawnSync(process.execPath,[file,mode],{input:a.includes('-i')?fs.readFileSync(0):undefined,encoding:'utf8'});
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status)
}
throw Error('unexpected Docker call');
`)
  await chmod(root + '/docker', 0o700)
  const exec = promisify(execFile), script = process.env.WRITER_CHECKER_UNDER_TEST || new URL('../scripts/assert-state-writers-stopped.sh', import.meta.url).pathname
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, TEST_ROOT: root,
    TEST_SOURCE: source, TEST_CALLS: root + '/calls', TEST_CONFIG: JSON.stringify(config) }
  // HOME may be absent; the observed writer mount exists in this fixture.
  const selected = stopped('unless-stopped', [bind(runtime)])
  const run = (context, rows = selected) => exec('sh', [script], { env: { ...env,
    BELLTEAM_STOPPED_CONTAINER_ID: context, TEST_CONTAINER: JSON.stringify(rows) } })
  await assert.rejects(run(''), e => e.code === 1 && /WRITERS_RUNNING/.test(e.stderr))
  assert.match((await run(cid)).stdout, /"writers":0/)
  await assert.rejects(run(other), e => e.code === 1 && /WRITER_METADATA_INVALID/.test(e.stderr))
  await assert.rejects(run(cid, { ...selected, restartPolicy: 'always' }), e => e.code === 1 && /WRITERS_RUNNING/.test(e.stderr))
  assert.doesNotMatch(await readFile(root + '/calls', 'utf8'), /docker\.sock|\/home\/bell/)
})


test('writer restart: serialized snapshot cannot acquire the caller-stopped identity exception', async () => {
  const { writerSnapshotPlan, verifyWriterSnapshot } = await import(process.env.WRITER_SNAPSHOT_UNDER_TEST
    || new URL('../distribution/internal/sec014-writer-snapshot.mjs', import.meta.url).href)
  const { createHash } = await import('node:crypto')
  const c = { services: { bellteam: { image: 'sha256:' + 'b'.repeat(64), volumes: [
    { type: 'bind', source: plan.roots[0], target: '/srv/bellteam' },
    { type: 'bind', source: plan.roots[1], target: '/home/bell' },
    { type: 'volume', source: 'cursor', target: '/home/bell/.local' },
  ] } }, volumes: { cursor: { name: 'cursor' } } }
  const p = writerSnapshotPlan(c, 'ghcr.io/kitepon/bellteam-server@sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64))
  const bundle = { list: { argv: p.listArgv, rawUtf8: '', clientPid: 123, clientStartTicks: 456,
    unknown: false, terminal: { kind: 'exit', code: 0 }, stdoutBytes: 0, stdoutSha256: createHash('sha256').update('').digest('hex') },
    containers: null, volumes: [], canonical: plan.roots.map(source => ({ source, canonical: source })) }
  assert.equal(verifyWriterSnapshot(p, bundle).phaseReceiptProduced, false)
  assert.throws(() => verifyWriterSnapshot({ ...p, mounts: { ...p.mounts, stoppedContainer: cid } }, bundle), /SNAPSHOT_UNAVAILABLE/)
})
