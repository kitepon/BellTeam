import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLatticeFacade } from '../src/lattice-facade.mjs'
import { createLatticeReminders } from '../src/lattice/reminders.mjs'
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

test('Owner chart reminders default OFF and survive facade restart; a sweep reads only saved ON charts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lattice-reminders-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'reminders.json'), sweeps = []
  const controller = { request: async (method, { projectId, projectIds }) => {
    if (method === 'nudge') { sweeps.push(projectIds); return }
    assert.equal(method, 'chart')
    if (!['alpha', 'beta', 'gamma'].includes(projectId)) throw Object.assign(new Error('missing'), { code: 'LATTICE_CHART_NOT_FOUND', status: 404 })
    return { ...chart, projectId }
  } }
  const create = () => createLatticeFacade({ controller, reminders: createLatticeReminders(path), nudgeMs: null })
  const route = id => '/api/lattice/charts/' + id + '/reminders'
  const put = (api, id, value, type = 'application/json') => api(route(id), { method: 'PUT',
    headers: { authorization: 'test-owner', 'content-type': type }, body: JSON.stringify(value) })
  const first = create(), api = await fixture(t, { lattice: first })
  const saved = async (api, id) => {
    const response = await api(route(id))
    assert.equal(response.status, 200)
    const { schema, projectId, enabled } = await response.json()
    assert.deepEqual([schema, projectId], ['bellteam.lattice-reminders.v1', id])
    return enabled
  }
  assert.equal(await saved(api, 'alpha'), false)
  await first.nudge()
  assert.deepEqual(sweeps, [[]])
  const responses = await Promise.all([put(api, 'alpha', { enabled: true }), put(api, 'beta', { enabled: true })])
  assert.deepEqual(await Promise.all(responses.map(response => response.json())), ['alpha', 'beta'].map(projectId => ({
    schema: 'bellteam.lattice-reminders.v1', projectId, enabled: true,
  })))
  assert.deepEqual(await Promise.all(['alpha', 'beta'].map(id => saved(api, id))), [true, true])
  assert.equal((await put(api, 'beta', { enabled: false })).status, 200)
  assert.equal((await put(api, 'beta', { enabled: false })).status, 200, 'repeating the desired value is idempotent')
  assert.equal((await api(route('alpha'), { headers: {} })).status, 401)
  assert.equal((await api(route('alpha'), { method: 'POST' })).status, 405)
  assert.equal((await put(api, 'alpha', { enabled: true }, 'text/plain')).status, 415)
  for (const value of [{ enabled: 'true' }, { enabled: true, extra: 1 }, []]) assert.equal((await put(api, 'alpha', value)).status, 400)
  assert.equal((await put(api, 'missing', { enabled: true })).status, 404)
  const internal = await fixture(t, { lattice: first, internal: true })
  assert.equal((await put(internal, 'alpha', { enabled: false })).status, 403)
  const restarted = create(), after = await fixture(t, { lattice: restarted })
  assert.deepEqual(await Promise.all(['alpha', 'beta', 'gamma'].map(id => saved(after, id))), [true, false, false])
  await restarted.nudge()
  assert.deepEqual(sweeps, [[], ['alpha']])
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
