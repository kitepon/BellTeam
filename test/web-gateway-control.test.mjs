import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createWebGatewayControl } from '../src/web-gateway-control.mjs'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'

const ids = ['a'.repeat(64), 'b'.repeat(64)]
const appRoot = fileURLToPath(new URL('../', import.meta.url))

test('受付と実行を分け、二重要求/切断/親close/失敗を現在版と区別する', async () => {
  let calls = 0
  const waiting = Promise.withResolvers()
  const gateway = { versionId: ids[0], replace: async () => { calls++; await waiting.promise } }
  const control = createWebGatewayControl({ gateway: () => gateway })
  const cancelled = control.reserve(ids[1])
  assert.equal(calls, 0)
  assert.throws(() => control.reserve(ids[0]), { code: 'WEB_GATEWAY_UPDATE_IN_PROGRESS', status: 409 })
  cancelled.cancel(); cancelled.start()
  assert.equal(control.snapshot().update.status, 'not_started')
  assert.equal(calls, 0)
  const pending = control.reserve(ids[1])
  pending.start(); pending.start(); await immediate()
  assert.equal(calls, 1)
  waiting.reject(new Error('synthetic private path'))
  await immediate()
  assert.deepEqual(control.snapshot(), { currentVersionId: ids[0], update: { versionId: ids[1], status: 'failed', error: 'GATEWAY_UPDATE_FAILED' } })
  const last = control.reserve(ids[1]); control.close(); last.start(); await immediate()
  assert.equal(calls, 1)
  assert.equal(control.snapshot().update.status, 'not_started')
  assert.throws(() => control.reserve(ids[0]), { code: 'WEB_GATEWAY_UNAVAILABLE', status: 503 })
})

test('実公開受付の202後に同port交換し、短い業務drain/保存/旧固定版戻し/内部拒否を保つ', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-control-runtime-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const releases = new Map()
  for (const id of ids) {
    const directory = join(root, id)
    await mkdir(join(directory, 'src'), { recursive: true }); await mkdir(join(directory, 'web'))
    await copyFile(join(appRoot, 'src/http-gateway-entry.mjs'), join(directory, 'src/http-gateway-entry.mjs'))
    await symlink(join(appRoot, 'src/http-gateway.mjs'), join(directory, 'src/http-gateway.mjs'))
    await copyFile(join(appRoot, 'web/assets.mjs'), join(directory, 'web/assets.mjs'))
    await writeFile(join(directory, 'web/index.html'), `<h1>${id}</h1>`)
    releases.set(id, { versionId: id, appRoot: directory, protocolVersion: 1 })
  }
  const adoptionPath = join(root, 'state/web-gateway-release.json')
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(adoptionPath, JSON.stringify({ schema: 'bellteam.web-gateway.adoption.v1', currentVersionId: ids[0], previousVersionId: null }), { mode: 0o600 })
  const entered = Promise.withResolvers(), business = Promise.withResolvers()
  let clientCloses = 0, modelCalls = 0
  const runtime = await createApplicationRuntime({ root, appRoot, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {},
      aiterm: { command: 'synthetic-aiterm', args: [] }, prepareGatewayRelease: async id => releases.get(id),
      models: { list: async () => { modelCalls++; entered.resolve(); return business.promise } } },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientCloses++ } },
  })
  t.after(async () => { business.resolve([]); await runtime.close(); await rm(root, { recursive: true, force: true }) })
  await runtime.start()
  const port = runtime.gateway.address.port, base = `http://127.0.0.1:${port}`
  const request = versionId => fetch(base + '/api/web-gateway-release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId }) })
  if (!runtime.internalServer.listening) await once(runtime.internalServer, 'listening')
  const internal = `http://127.0.0.1:${runtime.internalServer.address().port}/api/web-gateway-release`
  assert.equal((await fetch(internal)).status, 403)
  assert.equal((await fetch(internal, { method: 'POST', body: JSON.stringify({ versionId: ids[1] }) })).status, 403)
  assert.equal((await request('not-a-version')).status, 400)
  assert.equal((await fetch(base + '/api/web-gateway-release', { method: 'POST', body: JSON.stringify({ versionId: ids[1], path: '/untrusted' }) })).status, 400)
  const held = fetch(base + '/api/models')
  await entered.promise
  const startedAt = performance.now()
  const accepted = await request(ids[1])
  assert.equal(accepted.status, 202)
  assert.equal((await accepted.json()).webGatewayRelease.update.status, 'accepted')
  assert.ok(performance.now() - startedAt < 1000, 'ack must not wait for its own drain')
  business.resolve(['synthetic retained business result'])
  assert.deepEqual(await (await held).json(), { models: ['synthetic retained business result'] })
  const finished = async id => {
    for (let i = 0; i < 100 && runtime.gateway.versionId !== id; i++) await delay(10)
    assert.equal(runtime.gateway.versionId, id)
    await immediate()
    const result = await (await fetch(base + '/api/web-gateway-release')).json()
    assert.equal(result.webGatewayRelease.currentVersionId, id)
    assert.equal(result.webGatewayRelease.update.status, 'succeeded')
    assert.equal(runtime.gateway.address.port, port)
  }
  await finished(ids[1])
  assert.equal(JSON.parse(await readFile(adoptionPath, 'utf8')).currentVersionId, ids[1])
  assert.equal(modelCalls, 1)
  assert.equal(clientCloses, 0)
  assert.equal((await request(ids[0])).status, 202)
  await finished(ids[0])
  assert.equal(JSON.parse(await readFile(adoptionPath, 'utf8')).previousVersionId, ids[1])
  assert.equal(clientCloses, 0)
})
