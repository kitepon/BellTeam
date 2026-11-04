import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotRegistry } from '../src/bot-registry.mjs'
import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'

const calls = []
const client = label => ({
  capabilities: async () => { calls.push([label, 'capabilities']); return { supported: false, reason: 'HOST_UPDATE_UNAVAILABLE', currentRequestId: null, previousRequestId: null } },
  catalog: async id => { calls.push([label, 'catalog', id]); return { schema: 'bellteam.update-catalog.selection.v1', catalogSha256: 'a'.repeat(64), publishedAt: '2026-11-04T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', release: null, publication: { status: 'verified', checkedAt: '2026-11-04T00:00:00Z', error: null } } },
})
let factoryCalls = 0


test('application assembly routes container and module inventory to their clients and retains the injected legacy client', async t => {
  if (!mock.module) { t.skip('requires --experimental-test-module-mocks'); return }
  mock.module(new URL('../src/container-update-client.mjs', import.meta.url).href, { namedExports: {
    createUpdateClients: async () => { factoryCalls++; return { container: client('container'), module: client('module') } },
  } })
  const { createApplicationServices } = await import('../src/application-services.mjs')
  for (const legacy of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'update-client-assembly-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    calls.length = 0
    const seedPath = join(root, 'seed.json')
    await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
    const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
    await bots.initialize()
    const services = await createApplicationServices({ root, bots, environment: {}, settings: {}, olrwManagement: null,
      client: { async close() {} }, refreshGlobalInstructions: async () => {}, createNotificationsProcess: createSyntheticNotificationsProcess,
      ...(legacy ? { hostUpdateClient: client('legacy') } : {}),
    })
    t.after(() => services.notifications.close())
    t.after(() => services.updateCenter.close())
    const snapshot = await services.updateCenter.snapshot()
    assert.equal(snapshot.components.length, 9)
    assert.equal(factoryCalls, 1)
    assert.deepEqual(calls.find(c => c[1] === 'capabilities'), [legacy ? 'legacy' : 'container', 'capabilities'])
    assert.deepEqual(calls.filter(c => c[1] === 'catalog' && c[2] === 'container'), [[legacy ? 'legacy' : 'container', 'catalog', 'container']])
    const modules = calls.filter(c => c[1] === 'catalog' && c[2] !== 'container')
    assert.equal(modules.length, 8)
    assert.ok(modules.every(c => c[0] === (legacy ? 'legacy' : 'module')))
  }
})
