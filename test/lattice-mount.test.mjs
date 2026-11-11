import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'
import { bellTeamTools, callBellTeamTool, forkWritesProject } from '../src/mcp-tools.mjs'

// Parent wiring only: the route and the seat tool reach the injected lattice facade; the module's own behavior is in test/lattice.test.mjs.
const chart = { schema: 'bellteam.lattice-chart.v1', projectId: 'alpha', epoch: 'e', version: 1 }
async function fixture(t, options = {}) {
  const lattice = { charts: async () => ({ schema: 'bellteam.lattice-charts.v1', charts: [] }), chart: async () => chart, subscribe: () => () => {} }
  const server = createBellTeamServer({ bots: { refresh: async () => {} }, rooms: {}, transport: {}, lattice,
    authorize: req => req.headers.authorization === 'test-owner', messenger: {}, store: {}, writeLog() {}, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  return (path, init = {}) => fetch(origin + path, { headers: { authorization: 'test-owner' }, ...init })
}

test('the parent routes lattice to the injected facade behind the common authorizer', async t => {
  const get = await fixture(t)
  assert.equal((await (await get('/api/lattice/charts')).json()).schema, 'bellteam.lattice-charts.v1')
  assert.deepEqual(await (await get('/api/lattice/charts/alpha')).json(), chart)
  assert.equal((await get('/api/lattice/charts', { headers: {} })).status, 401)
  assert.equal((await get('/api/lattice/charts', { method: 'POST' })).status, 405)
})

test('internal seats get the module 403; an unavailable child is 503', async t => {
  const internal = await fixture(t, { internal: true })
  const response = await internal('/api/lattice/charts')
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'LATTICE_OWNER_REQUIRED' })
  const failed = async () => { throw Object.assign(new Error('LATTICE_UNAVAILABLE'), { code: 'LATTICE_UNAVAILABLE', status: 503 }) }
  const down = await fixture(t, { lattice: { charts: failed, chart: failed, subscribe: () => () => {} } })
  assert.equal((await down('/api/lattice/charts')).status, 503)
})

test('the seat tool is listed, open to forks, and runs as the calling seat', async () => {
  assert.ok(bellTeamTools.some(tool => tool.name === 'lattice'))
  assert.equal(forkWritesProject('lattice', { project: 'alpha', args: ['status'] }), false)
  const registry = new Map([['bot-a', { id: 'bot-a' }]]); registry.refresh = async () => registry
  const runs = []
  const lattice = { run: async value => { runs.push(value); return { exitCode: 0, result: {}, stdout: null, stderr: '' } } }
  const call = args => callBellTeamTool({ name: 'lattice', from: 'bot-a', registry, rooms: null, lattice, arguments: args })
  assert.equal((await call({ project: 'alpha', args: ['status'] })).exitCode, 0)
  assert.deepEqual(runs, [{ from: 'bot-a', projectId: 'alpha', args: ['status'], input: null }])
  await assert.rejects(call({ project: 'alpha', args: ['status'], from: 'bot-b' }))
  await assert.rejects(callBellTeamTool({ name: 'lattice', from: 'bot-a', registry, rooms: null, arguments: { project: 'alpha', args: [] } }), { code: 'LATTICE_UNAVAILABLE' })
})
