import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'

// Parent wiring only: the module's own behavior is covered by test/work-graph.test.mjs.
async function fixture(t, options = {}) {
  const bots = { refresh: async () => {}, listForClient: async () => [] }
  const transport = { queueItems: async () => [], currentTurn: async () => null }
  const server = createBellTeamServer({ bots, rooms: {}, transport, authorize: req => req.headers.authorization === 'test-owner',
    messenger: {}, store: {}, writeLog() {}, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return (path, init = {}) => fetch(origin + path, { headers: { authorization: 'test-owner' }, ...init })
}

test('the parent mounts work-graph behind the common authorizer', async t => {
  const get = await fixture(t)
  const response = await get('/api/work-graph')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).schema, 'bellteam.work-graph.v1')
  assert.equal((await get('/api/work-graph', { headers: {} })).status, 401)
  assert.equal((await get('/api/work-graph', { method: 'POST' })).status, 405)
})

test('internal seats get the module 403', async t => {
  const get = await fixture(t, { internal: true })
  const response = await get('/api/work-graph')
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'WORK_GRAPH_OWNER_REQUIRED' })
})
