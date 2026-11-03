import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageChannelDispatcher } from '../src/usage/channel-dispatcher.mjs'

const bootstrap = { environment: {}, seatRuntime: false, subscription: {} }
const actor = { owner: { kind: 'owner', botId: null }, bot: { kind: 'bot', botId: 'bot-a' }, system: { kind: 'system', botId: null } }
async function disk(root) {
  const rows = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const path = join(entry.parentPath, entry.name), metadata = await stat(path)
    rows.push([path.slice(root.length), await readFile(path, 'utf8'), metadata.mode & 0o777, metadata.mtimeMs])
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]))
}

test('cold staged read-only restart accepts no handoff while hot restore still requires the actual private handoff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-usage-cold-')); t.after(() => rm(root, { recursive: true, force: true }))
  let sequence = 0
  const fixture = generation => {
    const effects = [], rows = []
    const dispatcher = createUsageChannelDispatcher({ root, projection: publication => { rows.push(publication) }, effect: (method, params) => {
      effects.push({ method, params })
      if (method === 'members.read') return [{ id: 'bot-a', name: 'A', harness: 'codex' }]
      if (method === 'auth.call') return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', status: 'waiting', session_id: 'warm-session' } }
      return null
    } })
    const control = (method, params = {}) => dispatcher.control(method, params, { generation, rootId: String(++sequence), actor: actor.system })
    const request = (method, params, kind) => dispatcher.dispatch(method, params, { generation, rootId: String(++sequence), actor: actor[kind] })
    return { effects, rows, control, request, async staged(restore) {
      await control('initialize', { generation, mode: 'settings', bootstrap, restore })
      await control('initialize', { generation, mode: 'subscriptions' })
      await control('initialize', { generation, mode: 'services' })
    } }
  }
  const warm = fixture('warm')
  await warm.staged(false)
  await warm.request('settings.update', { id: 'routing', input: { enabled: true, values: { apiKey: 'synthetic-cold-key' } } }, 'owner')
  await warm.request('auth.start', { harness: 'codex' }, 'owner')
  const item = await warm.request('secrets.create', { toolId: 'synthetic', label: '鍵', message: '入力' }, 'bot')
  const submitted = await warm.request('secrets.submit', { id: item.id, value: 'synthetic-disk-only-value' }, 'owner')
  await warm.control('quiesce'); const { handoff } = await warm.control('export'); await warm.control('exit')
  assert.equal(handoff.sessions[0][1], 'warm-session')
  const before = await disk(root)

  // A cold parent has lost volatile memory; no manufactured handoff is supplied.
  const cold = fixture('cold')
  await cold.staged(true)
  assert.equal((await cold.request('secrets.get', { id: item.id }, 'owner')).notification, 'sent')
  assert.equal((await cold.request('settings.configuration', { id: 'routing' }, 'system')).apiKey, 'synthetic-cold-key')
  assert.equal(await readFile(submitted.path, 'utf8'), 'synthetic-disk-only-value')
  assert.deepEqual(cold.effects.map(row => row.method), ['members.read'])
  assert.deepEqual(await disk(root), before)
  await cold.control('quiesce'); const fresh = (await cold.control('export')).handoff
  assert.deepEqual(fresh.sessions, []); assert.deepEqual(fresh.receipts, []); assert.equal(fresh.onboardingAuth, null)
  await cold.control('exit')

  const missing = fixture('missing')
  for (const params of [{ generation: 'missing', mode: 'restore', bootstrap }, { generation: 'missing', mode: 'restore', bootstrap, handoff: null }]) {
    await assert.rejects(missing.control('initialize', params), { code: 'USAGE_INITIALIZATION_ORDER', status: 409 })
  }
  assert.deepEqual(missing.effects, []); assert.deepEqual(missing.rows, [])
  const hot = fixture('hot')
  await hot.control('initialize', { generation: 'hot', mode: 'restore', bootstrap, handoff })
  await hot.control('quiesce'); assert.equal((await hot.control('export')).handoff.sessions[0][1], 'warm-session')
  await hot.control('exit')
  assert.deepEqual(await disk(root), before)
})
