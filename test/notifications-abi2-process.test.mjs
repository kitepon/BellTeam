import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNotificationsProcess } from '../src/notifications-process.mjs'
import { writeNotificationsWebFixture } from './fixtures/notifications-web-push-state.mjs'

const fixture = new URL('./fixtures/notifications-abi2-child.mjs', import.meta.url).pathname
const A = 'a'.repeat(64), BAD = 'b'.repeat(64)
const off = () => ({ apns: { enabled: false, relayUrl: '' }, webPush: { enabled: false, subject: '' } })
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }
async function setup(t, { mode = '', diagnostic = async () => {}, prepare = async () => {}, initial = off(), realDispatcher = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'notification-abi2-')); await mkdir(join(root, 'state'))
  const open = fsPromises.open, spawn = childProcess.spawn
  t.mock.method(fsPromises, 'open', async (path, ...args) => path === '/app/distribution.json'
    ? { stat: async () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o644, size: 135 }),
      readFile: async () => JSON.stringify({ schema: 'bellteam.server.distribution.v1', sourceCommit: 'e'.repeat(40) }), close: async () => {} }
    : open(path, ...args))
  const children = [], states = []
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, '/usr/local/libexec/bellteam-notifications-start'); assert.deepEqual(options.env, {})
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'ipc'])
    const argv = realDispatcher ? [new URL('./fixtures/notifications-usage-child.mjs', import.meta.url).pathname, args[0], root, mode]
      : [fixture, args[0], args[0] === BAD ? 'bad-ready' : mode, root]
    const child = spawn(process.execPath, argv, options)
    children.push(child); return child
  })
  syncBuiltinESMExports()
  let config = structuredClone(initial)
  const controller = createNotificationsProcess({ root, configuration: () => config, onDiagnostic: diagnostic, onState: value => states.push(structuredClone(value)),
    prepareRelease: async (id, options) => { const supplied = await prepare(id, options); return { versionId: id,
      appRoot: `/run/bellteam-maintenance/notifications/releases/${id}/payload`, protocolVersion: 2, stateSchema: 2, ...supplied } } })
  t.after(async () => {
    if (realDispatcher) { await writeFile(join(root, 'release'), ''); await writeFile(join(root, 'web-release'), '') }
    await controller.close(); t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true })
  })
  return { root, controller, children, states, config: () => config, save: value => { config = structuredClone(value) } }
}

test('setting saved during ready is applied before parent admission and old ready null cannot clear its newer error', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await setup(t, { mode: 'delay-ready', diagnostic: async () => { entered.resolve(); await release.promise } })
  const starting = f.controller.start(); await entered.promise
  const next = off(); next.webPush = { enabled: true, subject: 'mailto:owner@example.test' }; f.save(next)
  await assert.rejects(f.controller.request('configure', { provider: 'webPush', ...next.webPush }), { outcome: 'not_accepted' })
  assert.equal(f.controller.snapshot().applyError.webPush, 'PUSH_CONFIGURATION_BUSY')
  release.resolve(); await starting
  const final = f.controller.snapshot()
  assert.equal(final.available, true); assert.equal(final.status.webPush.enabled, true)
  assert.equal(final.appliedEpoch.webPush, final.configurationEpoch); assert.equal(final.applyError.webPush, null)
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'last-configuration.json'), 'utf8')), { provider: 'webPush', ...next.webPush })
  assert.ok(f.states.filter(state => state.available).every(state => state.status.webPush.enabled))
})

test('older configure ACK and status cannot clear a newer saved-setting failure; provider errors are independent', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await setup(t, { mode: 'configure-delay', diagnostic: async () => { entered.resolve(); await release.promise } })
  await f.controller.start()
  let config = off(); config.apns.enabled = true; f.save(config)
  const first = f.controller.request('configure', { provider: 'apns', ...config.apns }); await entered.promise
  config = off(); f.save(config)
  await assert.rejects(f.controller.request('configure', { provider: 'apns', ...config.apns }), { status: 409 })
  release.resolve(); await first
  assert.equal(f.controller.snapshot().applyError.apns, 'PUSH_CONFIGURATION_BUSY')
  await f.controller.request('status', { provider: 'apns' })
  assert.equal(f.controller.snapshot().applyError.apns, 'PUSH_CONFIGURATION_BUSY')
  await f.controller.request('configure', { provider: 'apns', ...config.apns })
  assert.equal(f.controller.snapshot().applyError.apns, null)
  const statusBefore = f.controller.snapshot().status.webPush
  await f.controller.request('status', { provider: 'webPush', origin: 'https://owner.example', endpoint: 'https://fcm.googleapis.com/item' })
  assert.deepEqual(f.controller.snapshot().status.webPush, statusBefore)
})

test('failed Web provider remains separately unavailable while APNs/module run, and only matching apply clears it', { timeout: 5000 }, async t => {
  const initial = off(); initial.webPush = { enabled: true, subject: 'mailto:fail@example.test' }
  const f = await setup(t, { initial }); await f.controller.start()
  assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().applyError.webPush, 'WEB_PUSH_KEY_SAVE_FAILED')
  const config = structuredClone(initial); config.apns.enabled = true; f.save(config)
  await f.controller.request('configure', { provider: 'apns', ...config.apns })
  await f.controller.request('status', { provider: 'webPush' })
  assert.equal(f.controller.snapshot().status.apns.configured, true)
  assert.equal(f.controller.snapshot().applyError.webPush, 'WEB_PUSH_KEY_SAVE_FAILED')
  config.webPush = { enabled: false, subject: '' }; f.save(config)
  await f.controller.request('configure', { provider: 'webPush', ...config.webPush })
  assert.equal(f.controller.snapshot().applyError.webPush, null)
})

test('replacement captures latest settings during prepare and returns to P2 builtin with current state', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await setup(t, { prepare: async () => { entered.resolve(); await release.promise } })
  await f.controller.start()
  const replacing = f.controller.replace(A); await entered.promise
  const config = off(); config.webPush = { enabled: true, subject: 'mailto:latest@example.test' }; f.save(config)
  await assert.rejects(f.controller.request('configure', { provider: 'webPush', ...config.webPush }), { status: 409 })
  release.resolve(); await replacing
  assert.equal(f.controller.snapshot().status.webPush.enabled, true)
  await f.controller.replace('builtin')
  assert.equal(f.controller.snapshot().protocolVersion, 2); assert.equal(f.controller.snapshot().stateSchema, 2)
  assert.equal(f.controller.snapshot().currentTarget, 'builtin'); assert.equal(f.controller.snapshot().status.webPush.enabled, true)
  assert.equal(f.children.filter(child => child.exitCode === null && child.signalCode === null).length, 1)
})

test('old saved configure request is not reapplied and ready-only null is rejected without clearing old errors', { timeout: 5000 }, async t => {
  const initial = off(); initial.webPush = { enabled: true, subject: 'mailto:fail@example.test' }
  const f = await setup(t, { initial }); await f.controller.start()
  await assert.rejects(f.controller.request('configure', { provider: 'apns', enabled: true, relayUrl: '' }), { code: 'PUSH_CONFIGURATION_STALE', status: 409 })
  await assert.rejects(f.controller.replace(BAD), /NOTIFICATIONS_REPLACE_ROLLED_BACK/)
  assert.equal(f.controller.snapshot().available, true)
  assert.equal(f.controller.snapshot().applyError.webPush, 'WEB_PUSH_KEY_SAVE_FAILED')
  assert.equal(f.children[1].signalCode, 'SIGKILL')
})

test('controller and real ABI2 dispatcher drain both synthetic providers, preserve keys/registrations and return to matching builtin', { timeout: 10000 }, async t => {
  const f = await setup(t, { realDispatcher: true, mode: 'both-providers' })
  const fixture = await writeNotificationsWebFixture(f.root)
  const files = ['push-devices.json', 'web-push-keys.json', 'web-push-subscriptions.json']
  const before = await Promise.all(files.map(name => readFile(join(f.root, 'state', name))))
  await f.controller.start()
  assert.equal(f.controller.snapshot().status.webPush.publicKey, fixture.applicationServerKey)
  const config = structuredClone(fixture.configuration); config.apns.enabled = true; config.webPush.enabled = true; f.save(config)
  await f.controller.request('configure', { provider: 'apns', ...config.apns })
  await f.controller.request('configure', { provider: 'webPush', ...config.webPush })
  await f.controller.request('publish', { type: 'direct', id: 'slow', botId: 'bot-a', senderName: 'Fixture' })
  for (let attempts = 0; ; attempts++) {
    try {
      await readFile(join(f.root, 'sent.jsonl')); await readFile(join(f.root, 'web-sent.jsonl')); break
    } catch (error) {
      if (attempts >= 200) throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  let finished = false
  const updating = f.controller.replace(A).then(() => { finished = true })
  while (f.controller.snapshot().phase !== 'quiescing') await new Promise(resolve => setImmediate(resolve))
  await writeFile(join(f.root, 'release'), '')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false); assert.equal(f.children.length, 1)
  await writeFile(join(f.root, 'web-release'), ''); await updating
  assert.equal(f.children[0].exitCode, 0); assert.equal(f.children.length, 2)
  await f.controller.replace('builtin')
  const after = await Promise.all(files.map(name => readFile(join(f.root, 'state', name))))
  assert.deepEqual(after, before)
  assert.equal(f.controller.snapshot().currentTarget, 'builtin')
  assert.equal((await readFile(join(f.root, 'sent.jsonl'), 'utf8')).trim().split('\n').length, 1)
  assert.equal((await readFile(join(f.root, 'web-sent.jsonl'), 'utf8')).trim().split('\n').length, 2)
})


test('ABI1 adoption is rejected before spawning a child, without rewriting the adoption record', async t => {
  const f = await setup(t, { prepare: async () => ({ protocolVersion: 1, stateSchema: 1 }) })
  const record = JSON.stringify({schema:'bellteam.notifications.adoption.v1',currentVersionId:A,previousVersionId:null})
  const path = join(f.root, 'state/notifications-release.json')
  await writeFile(path, record, {mode:0o600})
  await assert.rejects(f.controller.start(), {code:'NOTIFICATIONS_RELEASE_INVALID'})
  assert.equal(f.children.length, 0); assert.equal(await readFile(path,'utf8'), record)
})

test('catalog compatibility is checked again after quiesce and mismatch resumes the old child', async t => {
  let attempts = 0
  const source = 'c'.repeat(40), platform = {os:'linux',arch:'amd64'}
  const f = await setup(t, { prepare: async () => ({ sourceCommit: ++attempts === 1 ? source : 'd'.repeat(40), platform }) })
  await f.controller.start()
  const expectedRelease = {componentId:'notifications',sourceCommit:source,versionId:A,platform,
    artifact:{kind:'archive',archive:{sha256:A}},changes:[],
    compatibility:{nodeMajor:26,parentProtocol:2,stateSchema:2,containerUpdate:null}}
  await assert.rejects(f.controller.replace(A,{expectedRelease}),{code:'NOTIFICATIONS_CATALOG_INCOMPATIBLE'})
  assert.equal(attempts, 2); assert.equal(f.children.length, 1)
  assert.equal(f.controller.snapshot().available, true); assert.equal(f.controller.snapshot().currentTarget,'builtin')
})
