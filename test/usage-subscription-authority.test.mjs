import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createUsageChannelDispatcher } from '../src/usage/channel-dispatcher.mjs'
const generation = 'synthetic-parent', context = { actor: { kind: 'owner', botId: null } }
const bootstrap = { environment: {}, seatRuntime: true, subscription: { environment: 'Production', accessMode: 'developer' } }
async function files(root) {
  const result = []
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) if (item.isFile()) {
    const path = join(item.parentPath, item.name), info = await stat(path)
    result.push([path.slice(root.length), await readFile(path, 'utf8'), info.mode, info.mtimeMs])
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]))
}
test('trusted parent subscription authority survives public payload restore without changing public defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-parent-subscription-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload'), data = join(root, 'data'), effects = []
  for (const path of ['src', 'config', 'services', 'package.json']) await cp(new URL('../' + path, import.meta.url), join(payload, path), { recursive: true })
  await cp(new URL('../distribution/server/distribution-profile.mjs', import.meta.url), join(payload, 'src/distribution-profile.mjs'))
  const { createUsageChannelDispatcher: createPublic } = await import(pathToFileURL(join(payload, 'src/usage/channel-dispatcher.mjs')))
  const { Subscriptions: PublicSubscriptions } = await import(pathToFileURL(join(payload, 'src/subscriptions.mjs')))
  assert.throws(() => new PublicSubscriptions({ path: join(root, 'unused'), developerAccessAllowed: 'true' }), { message: 'SUBSCRIPTION_DEVELOPER_ACCESS_INVALID' })
  const ports = { root: data, effect: async method => { effects.push(method); return [] }, projection: async () => {} }
  const old = createUsageChannelDispatcher(ports)
  for (const mode of ['settings', 'subscriptions', 'services']) await old.control('initialize', { generation, mode, ...(mode === 'settings' ? { bootstrap, restore: false } : {}) }, context)
  await old.control('quiesce', {}, context)
  const { handoff } = await old.control('export', {}, context), saved = await files(data)
  const restore = (create, subscription) => create(ports).control('initialize', { generation, mode: 'restore', bootstrap: { ...bootstrap, subscription }, handoff }, context)
  for (const allowed of [undefined, false]) await assert.rejects(restore(createPublic, { ...bootstrap.subscription, ...(allowed === undefined ? {} : { developerAccessAllowed: allowed }) }), { message: 'SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE' })
  await assert.rejects(restore(createUsageChannelDispatcher, { ...bootstrap.subscription, developerAccessAllowed: false }), { message: 'SUBSCRIPTION_DEVELOPER_ACCESS_UNAVAILABLE' })
  for (const value of ['true', 1, null, {}]) await assert.rejects(restore(createPublic, { ...bootstrap.subscription, developerAccessAllowed: value }), { code: 'USAGE_INITIALIZATION_ORDER' })
  await assert.rejects(restore(createPublic, { ...bootstrap.subscription, otherPermission: true }), { code: 'USAGE_INITIALIZATION_ORDER' })
  const next = createPublic(ports)
  await next.control('initialize', { generation, mode: 'restore', bootstrap: { ...bootstrap, subscription: { ...bootstrap.subscription, developerAccessAllowed: true } }, handoff }, context)
  assert.equal((await next.dispatch('subscriptions.status', {}, context)).accessMode, 'developer')
  assert.deepEqual(await files(data), saved)
  assert.ok(effects.every(method => method === 'members.read'))
  await restore(createUsageChannelDispatcher, { ...bootstrap.subscription, developerAccessAllowed: true })
  await restore(createPublic, { environment: 'Production', accessMode: 'subscription' })
  assert.deepEqual(await files(data), saved)
})
