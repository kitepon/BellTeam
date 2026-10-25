import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBellTeamServer } from '../src/http-server.mjs'
import { callBellTeamTool } from '../src/mcp-tools.mjs'
import { BellTeamMemory } from '../src/memory-service.mjs'

test('実際の記憶検索をMCPとHTTPへ接続し、応答とBot/scopeの分離を保つ', async t => {
  const root = await mkdtemp(join(tmpdir(), 'memory-search-integration-'))
  const registry = new Map(['bot-a', 'bot-b'].map(id => [id, { id, project: join(root, id) }]))
  registry.refresh = async () => registry
  const memory = new BellTeamMemory({ registry, root })
  await memory.initialize()
  const call = (name, args) => callBellTeamTool({ name, arguments: args, from: 'bot-a', registry, memory })
  const saved = await call('remember', { content: 'K-EXACT 接続確認の記憶', kind: 'fact' })
  const recorded = await call('record_knowledge', { title: '接続手順', content: '## 検索\n\nK-EXACT 接続確認の文書' })
  await call('remember', { content: 'SHAREDONLYQUERY 共通の確認', scope: 'shared' })
  const server = createBellTeamServer({ bots: registry, memory, authorize: () => true, writeLog: () => {} })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}/api/bots`
  const get = async path => {
    const response = await fetch(`${base}/${path}`)
    assert.equal(response.status, 200)
    return response.json()
  }
  const recalled = await call('recall_memory', { query: 'K-EXACT' })
  const searched = await call('search_knowledge', { query: 'K-EXACT' })
  assert.deepEqual(await get('bot-a/memory?query=K-EXACT'), recalled)
  assert.deepEqual(await get('bot-a/knowledge?query=K-EXACT'), searched)
  assert.deepEqual(searched.items.map(item => item.id), [recorded.knowledge.id, saved.memory.id])
  assert.deepEqual(await get('bot-b/knowledge?query=K-EXACT'), { scope: 'personal', items: [] })
  assert.deepEqual(await get('bot-a/memory?query=SHAREDONLYQUERY'), { scope: 'personal', items: [] })
  assert.deepEqual(await get('bot-a/memory?query=SHAREDONLYQUERY&scope=shared'), await call('recall_memory', { query: 'SHAREDONLYQUERY', scope: 'shared' }))
})
