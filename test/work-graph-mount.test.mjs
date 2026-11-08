import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'

// Parent wiring only: the route reaches the injected work-graph facade behind the common authorizer.
async function fixture(t, options = {}) {
  const workGraph = { snapshot: async () => ({ schema: 'bellteam.work-graph.v1' }), subscribe: () => () => {} }
  const server = createBellTeamServer({ bots: { refresh: async () => {} }, rooms: {}, transport: {}, workGraph,
    authorize: req => req.headers.authorization === 'test-owner', messenger: {}, store: {}, writeLog() {}, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return (path, init = {}) => fetch(origin + path, { headers: { authorization: 'test-owner' }, ...init })
}

test('the parent routes work-graph to the injected facade behind the common authorizer', async t => {
  const get = await fixture(t)
  const response = await get('/api/work-graph')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).schema, 'bellteam.work-graph.v1')
  assert.equal((await get('/api/work-graph', { headers: {} })).status, 401)
  assert.equal((await get('/api/work-graph', { method: 'POST' })).status, 405)
})

test('internal seats get the module 403; an unavailable child is 503', async t => {
  const internal = await fixture(t, { internal: true })
  const response = await internal('/api/work-graph')
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'WORK_GRAPH_OWNER_REQUIRED' })
  const down = await fixture(t, { workGraph: { snapshot: async () => { throw Object.assign(new Error('WORK_GRAPH_UNAVAILABLE'), { code: 'WORK_GRAPH_UNAVAILABLE', status: 503 }) }, subscribe: () => () => {} } })
  assert.equal((await down('/api/work-graph')).status, 503)
})
