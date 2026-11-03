import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createModuleUpdateExecutor } from '../src/update-module-executor.mjs'
import { createModuleUpdateAdapters } from '../src/update-module-adapters.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createModuleUpdateCatalog } from '../src/update-module-catalog.mjs'
import { validateUpdateRequest, validateUpdateResponse, updateActionExamples, updateModuleExamples, validateUpdates } from '../src/update-center-contract.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'

const source = 'a'.repeat(40), nextSource = 'b'.repeat(40), digest = 'c'.repeat(64)
const builtin = { version: source, sourceCommit: source, digest: null, origin: 'builtin' }
function selection(id) {
  const url = `https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/${id}-${nextSource}-linux-amd64.tar.gz`
  return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'd'.repeat(64), publishedAt: '2026-11-03T00:00:00Z', expiresAt: '2099-11-04T00:00:00Z',
    publication: { status: 'verified', checkedAt: '2026-11-03T01:00:00Z', error: null },
    release: { componentId: id, sourceCommit: nextSource, versionId: digest, platform: { os: 'linux', arch: 'amd64' }, changes: ['固定公開版'],
      artifact: { kind: 'archive', archive: { url, sha256: digest, bytes: 1000 }, bundle: { url: url + '.sigstore.json', sha256: 'e'.repeat(64), bytes: 100 }, signerCommit: nextSource },
      compatibility: { nodeMajor: 26, parentProtocol: id === 'notifications' ? 2 : 1, stateSchema: id === 'members' ? null : id === 'notifications' ? 2 : 1,
        containerUpdate: null, ...(id === 'members' ? { stateCompatibility: MEMBERS_STATE_COMPATIBILITY } : {}) } } }
}
async function fixture(t, { ids = ['notifications'], apply = null, prepare = null, host = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-module-ledger-')); t.after(() => rm(root, { recursive: true, force: true }))
  const calls = [], current = Object.fromEntries(ids.map(id => [id, structuredClone(builtin)]))
  const catalog = createModuleUpdateCatalog({ client: { catalog: async id => selection(id) } })
  const adapters = Object.fromEntries(ids.map(id => [id, { current: () => structuredClone(current[id]), available: () => true,
    canRollback: target => id !== 'web-gateway' || target.origin !== 'builtin',
    prepare: async step => { await prepare?.(step) }, apply: async step => {
      calls.push(id); if (apply) await apply(step)
      current[id] = { ...step.target, origin: step.target.origin === 'builtin' ? 'builtin' : 'release' }
    } }]))
  const executor = await createModuleUpdateExecutor({ root, catalog, adapters, host })
  const request = plan => ({ planId: plan.planId, requestId: randomUUID(), confirmContainerRestart: false })
  const plan = input => executor.plan(input ?? { scope: 'component', componentId: ids[0] })
  const done = async id => { await executor.close(); return executor.operation(id) }
  return { root, catalog, adapters, executor, current, calls, request, plan, done }
}

test('fixed action schema preserves the old operation body and rejects target/action overrides', () => {
  for (const value of Object.values(updateModuleExamples)) assert.equal(validateUpdates(value).valid, true)
  for (const value of Object.values(updateActionExamples)) validateUpdateRequest('plan', value)
  for (const value of [{ scope: 'component', componentId: 'notifications', action: 'shell' }, { scope: 'all', componentId: 'members' }])
    assert.throws(() => validateUpdateRequest('plan', value), { status: 400 })
  assert.throws(() => validateUpdateRequest('operation', { planId: randomUUID(), requestId: randomUUID(), confirmContainerRestart: false, action: 'rollback' }), { status: 400 })
})

test('durable UUID admission binds one actual worker, retains result across reconstruction and rejects a different plan', async t => {
  let release; const wait = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { apply: () => wait }), plan = await f.plan(), other = await f.plan()
  const input = f.request(plan), accepted = await f.executor.start(input)
  validateUpdateResponse('operation', { operation: accepted }); assert.equal(accepted.admission, 'accepted')
  const saved = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json')))
  assert.equal(saved.operations[0].operation.requestId, input.requestId)
  assert.equal((await stat(join(f.root, 'state/update-ledger/ledger.json'))).mode & 0o777, 0o600)
  assert.equal((await f.executor.start(input)).requestId, input.requestId)
  await assert.rejects(f.executor.start({ ...input, planId: other.planId }), { code: 'UPDATE_REQUEST_CONFLICT' })
  await assert.rejects(f.executor.start(f.request(other)), { status: 409 })
  release(); const result = await f.done(input.requestId)
  assert.equal(result.phase, 'completed'); assert.equal(result.verification, 'succeeded'); assert.deepEqual(f.calls, ['notifications'])
  const recovered = await createModuleUpdateExecutor(f)
  assert.deepEqual(await recovered.operation(input.requestId), result)
  assert.equal((await recovered.start(input)).phase, 'completed'); assert.equal(f.calls.length, 1)
})

test('plan prerequisites and installed descriptor are checked again before admission; incompatible/current/expired plans have no worker', async t => {
  let unavailable = false
  const f = await fixture(t, { prepare: () => { if (unavailable) throw Object.assign(new Error(), { code: 'RELEASE_NOT_INSTALLED' }) } })
  const plan = await f.plan(); unavailable = true
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'RELEASE_NOT_INSTALLED' }); assert.equal(f.calls.length, 0)
  unavailable = false; f.current.notifications = { ...builtin, sourceCommit: '0'.repeat(40) }
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'UPDATE_CURRENT_CHANGED' })
  f.current.notifications = { ...builtin }
  f.catalog.select = async id => { const value = selection(id); value.release.compatibility.parentProtocol = 1; return value }
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'UPDATE_PLAN_STALE' })
  const expired = await createModuleUpdateExecutor({ ...f, now: () => Date.parse('2100-01-01') })
  await assert.rejects(expired.start(f.request(plan)), { code: 'UPDATE_PLAN_EXPIRED' }); assert.equal(f.calls.length, 0)
})

test('module all follows fixed steps without restarting the container; a failed step stops later steps', async t => {
  const ids = ['web-gateway', 'notifications', 'members']
  const f = await fixture(t, { ids }), plan = await f.plan({ scope: 'all' }), input = f.request(plan)
  assert.equal(plan.impact.containerRestart, false); assert.deepEqual(plan.targets.map(value => value.componentId), ids)
  await f.executor.start(input); assert.equal((await f.done(input.requestId)).phase, 'completed'); assert.deepEqual(f.calls, ids)
  const g = await fixture(t, { ids, apply: step => { if (step.componentId === 'notifications') throw Object.assign(new Error(), { code: 'NOTIFICATIONS_OLD_WRITER_ALIVE' }) } })
  const p = await g.plan({ scope: 'all' }), request = g.request(p); await g.executor.start(request)
  assert.equal((await g.done(request.requestId)).phase, 'failed'); assert.deepEqual(g.calls, ids.slice(0, 2))
})

test('only the last confirmed individual module code can be rolled back; all/container and unsupported builtin are rejected', async t => {
  const f = await fixture(t), update = await f.plan(), input = f.request(update)
  await assert.rejects(f.plan({ scope: 'component', componentId: 'notifications', action: 'rollback' }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE' })
  await f.executor.start(input)
  // Wait for the actual worker without closing the public executor.
  for (let attempts = 0; attempts < 200 && (await f.executor.operation(input.requestId)).phase !== 'completed'; attempts++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal((await f.executor.operation(input.requestId)).phase, 'completed')
  const rollback = await f.plan({ scope: 'component', componentId: 'notifications', action: 'rollback' })
  assert.equal(rollback.action, 'rollback'); assert.deepEqual(rollback.targets[0].published, builtin)
  const request = f.request(rollback); await f.executor.start(request)
  assert.equal((await f.done(request.requestId)).phase, 'completed'); assert.deepEqual(f.current.notifications, builtin)
  const g = await fixture(t)
  for (const value of [{ scope: 'all', action: 'rollback' }, { scope: 'component', componentId: 'container', action: 'rollback' }])
    await assert.rejects(g.plan(value), { code: 'UPDATE_ROLLBACK_UNSUPPORTED' })
})

test('parent death after durable admission becomes unknown on restart, even if the current target now matches; no replay', async t => {
  const f = await fixture(t)
  const script = `import {createModuleUpdateExecutor} from ${JSON.stringify(new URL('../src/update-module-executor.mjs', import.meta.url).href)};
    const root=${JSON.stringify(f.root)}, current=${JSON.stringify(builtin)}, selected=${JSON.stringify(selection('notifications'))};
    const executor=await createModuleUpdateExecutor({root,catalog:{select:async()=>selected},adapters:{notifications:{current:()=>current,available:()=>true,prepare:async()=>{},apply:async()=>new Promise(()=>{}),canRollback:()=>true}}});
    const plan=await executor.plan({scope:'component',componentId:'notifications'});const requestId=${JSON.stringify(randomUUID())};
    await executor.start({planId:plan.planId,requestId,confirmContainerRestart:false});console.log(requestId);setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  const [output] = await once(child.stdout, 'data'), id = output.toString().trim()
  const ended = once(child, 'close'); child.kill('SIGKILL'); await ended
  f.current.notifications = { version: digest, digest: 'sha256:' + digest, sourceCommit: null, origin: 'release' }
  const recovered = await createModuleUpdateExecutor(f), result = await recovered.operation(id)
  assert.equal(result.phase, 'unknown'); assert.equal(result.error.code, 'UPDATE_PARENT_INTERRUPTED')
  const original = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json'))).plans[0].plan
  assert.equal((await recovered.start({ planId: original.planId, requestId: id, confirmContainerRestart: false })).phase, 'unknown')
  assert.deepEqual(f.calls, [])
})

test('actual controller adapters preserve fixed release metadata, builtin scope, and do not create controllers', async () => {
  let target, options
  const state = { currentVersionId: null, builtinSourceCommit: source, available: true }
  const controller = { snapshot: () => state, replace: async (...args) => { [target, options] = args } }
  const release = selection('notifications').release
  const adapters = createModuleUpdateAdapters({ gateway: () => ({ pid: 42, versionId: null }), notifications: { controller },
    prepare: { notifications: async () => ({ versionId: digest, sourceCommit: nextSource, protocolVersion: 2, stateSchema: 2, platform: release.platform }) } })
  const step = { componentId: 'notifications', from: builtin, target: { version: digest, digest: 'sha256:' + digest, sourceCommit: nextSource, origin: 'published' }, release }
  await adapters.notifications.prepare(step); await adapters.notifications.apply(step)
  assert.equal(target, digest); assert.deepEqual(options.expectedRelease, release)
  assert.equal(adapters['web-gateway'].canRollback(builtin), false)
  await assert.rejects(adapters['web-gateway'].prepare({ target: builtin }), { code: 'UPDATE_ROLLBACK_UNAVAILABLE' })
})

test('center publishes the durable module operation and schema-valid inventory through the existing interface', async t => {
  const f = await fixture(t)
  const center = createUpdateCenter({ moduleCatalog: f.catalog, moduleExecutor: f.executor,
    notifications: { controller: { snapshot: () => ({ builtinSourceCommit: source, available: true, currentVersionId: null, status: { configured: true } }) } } })
  const plan = await center.plan({ scope: 'component', componentId: 'notifications' }), input = f.request(plan)
  await center.start(input); await center.close()
  const value = await center.snapshot(); assert.equal(validateUpdates(value).valid, true)
  assert.equal(value.operation.requestId, input.requestId); assert.equal(value.operation.phase, 'completed')
})

test('all includes a needed container only as its final Host step and resumes by get without issuing again', async t => {
  let starts = 0, queries = 0, completed = false
  const target = { version: 'sha256:' + 'f'.repeat(64), sourceCommit: nextSource, digest: 'sha256:' + 'f'.repeat(64), origin: 'published' }
  const hostPlan = { planId: randomUUID(), scope: 'component', componentId: 'container', expiresAt: '2099-01-01T00:00:00Z', targets: [{ componentId: 'container', current: { ...builtin, origin: 'container' }, published: target }], compatibility: { compatible: true, reason: null }, impact: { containerRestart: true, description: '本体の再起動' }, capability: { supported: true, reason: null } }
  let requestId
  const result = () => ({ requestId, plan: hostPlan, admission: 'accepted', phase: completed ? 'completed' : 'applying', execution: completed ? 'succeeded' : 'pending', verification: completed ? 'succeeded' : 'pending', error: null, reference: requestId })
  const host = { plan: async () => hostPlan, start: async input => { starts++; requestId = input.requestId; return result() }, operation: async id => { assert.equal(id, requestId); queries++; return result() } }
  const f = await fixture(t, { host }), inventory = { components: [{ id: 'container', publication: { catalog: { sha256: 'd'.repeat(64) } }, comparison: { state: 'update_available' }, capability: { supported: true } }] }
  const plan = await f.executor.plan({ scope: 'all' }, inventory), input = f.request(plan)
  assert.equal(plan.impact.containerRestart, true); assert.deepEqual(plan.targets.map(value => value.componentId), ['notifications', 'container'])
  await assert.rejects(f.executor.start(input), { code: 'UPDATE_RESTART_CONFIRMATION_REQUIRED' }); assert.deepEqual(f.calls, [])
  await f.executor.start({ ...input, confirmContainerRestart: true }); await f.executor.close()
  assert.equal(starts, 1); assert.deepEqual(f.calls, ['notifications'])
  const recovered = await createModuleUpdateExecutor({ ...f, host })
  completed = true
  const final = await recovered.operation(input.requestId)
  assert.equal(final.phase, 'completed'); assert.equal(starts, 1); assert.ok(queries >= 2)
  assert.equal((await recovered.start({ ...input, confirmContainerRestart: true })).phase, 'completed')
})

test('the common exchange mutex holds legacy reservations until their actual completion and shutdown waits for release', async t => {
  const f = await fixture(t), plan = await f.plan()
  const release = f.executor.reserveExchange()
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'MODULE_EXCHANGE_BUSY' })
  let closed = false
  const ending = f.executor.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  release(); release(); await ending; assert.equal(closed, true)
})

test('writer or journal corruption is rejected rather than fabricating a fresh history', async t => {
  const f = await fixture(t), plan = await f.plan()
  const path = join(f.root, 'state/update-ledger/ledger.json')
  const value = JSON.parse(await readFile(path)); value.plans[0].plan.targets[0].published.version = 'changed'
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  await assert.rejects(createModuleUpdateExecutor(f), { code: 'UPDATE_LEDGER_INVALID' })
  assert.equal(plan.action, 'update'); assert.deepEqual(f.calls, [])
})

test('real Owner HTTP sends 202 only after durable admission, retains action, and never waits for its own worker', async t => {
  const { createBellTeamServer } = await import('../src/http-server.mjs')
  const waiting = Promise.withResolvers(), f = await fixture(t, { apply: () => waiting.promise })
  t.after(() => waiting.resolve())
  const center = createUpdateCenter({ moduleCatalog: f.catalog, moduleExecutor: f.executor,
    notifications: { controller: { snapshot: () => ({ builtinSourceCommit: source, available: true, currentVersionId: null, status: { configured: true } }) } } })
  const server = createBellTeamServer({ bots: Object.assign(new Map(), { refresh: async () => {} }), store: { watch: async () => () => {} }, transport: {}, updateCenter: center, authorize: async () => true, writeLog() {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { waiting.resolve(); await center.close(); await new Promise(resolve => server.close(resolve)) })
  const request = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api/updates${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
  const planReply = await request('/plans', { scope: 'component', componentId: 'notifications' })
  assert.equal(planReply.status, 200)
  const { plan } = await planReply.json(), input = f.request(plan), accepted = await request('/operations', input)
  assert.equal(accepted.status, 202); assert.equal((await accepted.json()).operation.plan.action, 'update')
  const disk = JSON.parse(await readFile(join(f.root, 'state/update-ledger/ledger.json')))
  assert.equal(disk.operations[0].operation.requestId, input.requestId)
  assert.equal((await request('/operations', { ...input, action: 'rollback' })).status, 400)
  assert.equal((await request('/plans', { scope: 'all', action: 'rollback' })).status, 409)
  assert.equal((await request('/operations/' + input.requestId)).status, 200)
  waiting.resolve()
})

test('admission journal failure creates no worker and cannot be returned as accepted', async t => {
  const { mkdir } = await import('node:fs/promises')
  const f = await fixture(t), plan = await f.plan(), input = f.request(plan)
  const path = join(f.root, 'state/update-ledger/ledger.json')
  await rm(path); await mkdir(path)
  await assert.rejects(f.executor.start(input), { code: 'UPDATE_LEDGER_WRITE_FAILED', status: 503 })
  assert.deepEqual(f.calls, [])
  assert.equal((await f.executor.operation(input.requestId)).admission, 'unknown')
  await assert.rejects(f.executor.start(input), { code: 'UPDATE_LEDGER_WRITE_FAILED' })
})

test('same-version generation changes and shutdown during preflight cannot issue a new exchange', async t => {
  const f = await fixture(t)
  let generation = 1
  f.adapters.notifications.capture = () => ({ generation })
  const plan = await f.plan(); generation++
  await assert.rejects(f.executor.start(f.request(plan)), { code: 'UPDATE_CURRENT_CHANGED' })
  generation--
  const entered = Promise.withResolvers(), waiting = Promise.withResolvers()
  f.adapters.notifications.prepare = async () => { entered.resolve(); await waiting.promise }
  const starting = f.executor.start(f.request(plan)); await entered.promise
  const closing = f.executor.close(); waiting.resolve()
  await assert.rejects(starting, { code: 'UPDATE_PLAN_EXPIRED' }); await closing
  assert.deepEqual(f.calls, [])
})
