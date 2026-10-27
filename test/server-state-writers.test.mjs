import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { stateWriterPlan, stateWriterSources, assertStateWritersStopped } from '../src/server-state-writers.mjs'

const config = { services: { bellteam: { environment: { SECRET: 'synthetic-only' }, volumes: [
  { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' },
  { type: 'bind', source: '/runtime/home', target: '/home/bell' },
  { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
] } }, volumes: { 'cursor-cli': { name: 'fixture_cursor-cli' } } }
const plan = stateWriterPlan(config)
const container = (mounts, extra = {}) => ({ id: 'synthetic-id', running: true, restarting: false, restartPolicy: 'no', mounts, ...extra })
const bind = (Source, RW = true) => ({ Type: 'bind', Source, RW })
const aliases = (containers, volumes = [], target = plan) => stateWriterSources(target, containers, volumes).map(source => ({ source, canonical: source }))
const volumeInfo = (name, mountpoint, extra = {}) => ({ name, mountpoint, driver: 'local', optionCount: 0, type: null, device: null, options: null, ...extra })

test('state writer plan extracts only required normalized mounts, without credentials', () => {
  assert.deepEqual(plan, { roots: ['/runtime/data', '/runtime/home'], volume: 'fixture_cursor-cli' })
  assert.doesNotMatch(JSON.stringify(plan), /SECRET|synthetic-only/)
  for (const mutate of [c => c.services.bellteam.volumes.pop(), c => c.services.bellteam.volumes.push(c.services.bellteam.volumes[0]),
    c => c.services.bellteam.volumes[0].read_only = true, c => c.services.bellteam.volumes[0].source = 'relative']) {
    const broken = structuredClone(config); mutate(broken)
    assert.throws(() => stateWriterPlan(broken), /WRITER_METADATA_INVALID/)
  }
})

test('active or restarting parent/child data and HOME mounts prevent maintenance', () => {
  for (const source of ['/runtime', '/runtime/data', '/runtime/data/state', '/runtime/home', '/']) {
    for (const state of [{}, { running: false, restarting: true }]) {
      const containers = [container([bind(source)], state)]
      assert.throws(() => assertStateWritersStopped(plan, containers, aliases(containers)), error =>
        error.message === 'SERVER_STATE_WRITERS_RUNNING' && error.writers[0] === 'synthetic-id')
    }
  }
})

test('read-only readers, stopped writers and sibling prefixes do not block', () => {
  const containers = [container([bind('/runtime/data', false)]), container([bind('/runtime/home')], { running: false }),
    container([bind('/runtime/data-other')]), container([{ Type: 'tmpfs', RW: true }])]
  assert.deepEqual(assertStateWritersStopped(plan, containers, aliases(containers)), { writers: 0 })
})

test('shared Cursor volume writers block regardless of container mount target', () => {
  const containers = [container([{ Type: 'volume', Name: plan.volume, Source: '/docker/cursor', RW: true }])]
  const volumes = [volumeInfo(plan.volume, '/docker/cursor')]
  assert.throws(() => assertStateWritersStopped(plan, containers, aliases(containers, volumes), volumes), /WRITERS_RUNNING/)
})

test('canonical paths catch a bind through a different symlink alias', () => {
  const containers = [container([bind('/alias')])]
  const canonical = aliases(containers).map(entry => entry.source === '/alias' ? { ...entry, canonical: '/runtime/data/state' } : entry)
  assert.throws(() => assertStateWritersStopped(plan, containers, canonical), /WRITERS_RUNNING/)
})

test('missing or malformed observations and canonical identities do not become no writers', () => {
  const containers = [container([bind('/runtime/data')])]
  for (const broken of [[{ ...containers[0], restarting: undefined }], [container([{ Type: 'bind', Source: '/x' }])],
    [container([bind('/bad\npath')])], [container([{ Type: 'unknown', RW: true }])]]) {
    assert.throws(() => stateWriterSources(plan, broken), /WRITER_METADATA_INVALID/)
  }
  assert.throws(() => assertStateWritersStopped(plan, containers, []), /WRITER_METADATA_INVALID/)
  assert.throws(() => assertStateWritersStopped(plan, containers, [...aliases(containers), aliases(containers)[0]]), /WRITER_METADATA_INVALID/)
})

test('normal image CLI accepts Compose on stdin without echoing environment', async () => {
  const child = spawn(process.execPath, [new URL('../src/server-state-writers.mjs', import.meta.url).pathname, 'plan'])
  const output = [], errors = []
  child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
  const closed = new Promise(resolve => child.once('close', resolve))
  child.stdin.end(JSON.stringify(config))
  assert.equal(await closed, 0)
  assert.deepEqual(JSON.parse(Buffer.concat(output)), plan)
  assert.equal(Buffer.concat(errors).toString(), '')
})

test('named volume backing and local bind devices cannot alias the data/HOME roots unnoticed', () => {
  for (const root of plan.roots) {
    const containers = [container([{ Type: 'volume', Name: 'unrelated-name', Source: root, RW: true }])]
    const direct = [volumeInfo('unrelated-name', root)]
    assert.throws(() => assertStateWritersStopped(plan, containers, aliases(containers, direct), direct), /WRITERS_RUNNING/)
    containers[0].mounts[0].Source = '/docker/unrelated/_data'
    const bound = [volumeInfo('unrelated-name', '/docker/unrelated/_data', { optionCount: 3, type: 'none', device: root, options: 'bind' })]
    assert.throws(() => assertStateWritersStopped(plan, containers, aliases(containers, bound), bound), /WRITERS_RUNNING/)
    const aliased = bound.map(record => ({ ...record, device: '/alias' }))
    const canonical = aliases(containers, aliased).map(entry => entry.source === '/alias' ? { ...entry, canonical: root } : entry)
    assert.throws(() => assertStateWritersStopped(plan, containers, canonical, aliased), /WRITERS_RUNNING/)
  }
})

test('volume metadata absence, unknown drivers/options and inconsistent mountpoints are unavailable', () => {
  const containers = [container([{ Type: 'volume', Name: 'other', Source: '/docker/other', RW: true }])]
  for (const records of [[], [volumeInfo('other', '/docker/other', { driver: 'remote' })],
    [volumeInfo('other', '/docker/other', { optionCount: 1 })],
    [volumeInfo('other', '/docker/other', { optionCount: 3, type: 'nfs', device: '/x', options: 'bind' })]]) {
    assert.throws(() => aliases(containers, records), /WRITER_METADATA_INVALID/)
  }
  const wrong = [volumeInfo('other', '/docker/different')]
  assert.throws(() => assertStateWritersStopped(plan, containers, aliases(containers, wrong), wrong), /WRITER_METADATA_INVALID/)
})

test('proved disjoint local volumes remain allowed; stopped/RO volumes need no backing read', () => {
  const containers = [container([{ Type: 'volume', Name: 'other', Source: '/docker/other', RW: true }])]
  const volumes = [volumeInfo('other', '/docker/other')]
  assert.deepEqual(assertStateWritersStopped(plan, containers, aliases(containers, volumes), volumes), { writers: 0 })
  containers[0].mounts[0].RW = false
  assert.deepEqual(assertStateWritersStopped(plan, containers, aliases(containers)), { writers: 0 })
  containers[0].mounts[0].RW = true; containers[0].running = false
  assert.deepEqual(assertStateWritersStopped(plan, containers, aliases(containers)), { writers: 0 })
})
