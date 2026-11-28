import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteSeats } from '../src/remote-seats.mjs'
import { RemoteRoutes, viewRows } from '../src/remote-route.mjs'

import { BOT_GIT_IDENTITY } from '../src/bot-environment.mjs'
const GIT_NAMES = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] // SEC-111

const bot = { id: 'bot-aaaa1111', terminalId: 'mac-1', projectRoot: '/Users/quo/work/app', fastMode: false }
const terminal = { ref: 'owner-macbook', target: { host: 'mac', user: 'quo', port: 22 }, trustRevision: 't1', credentialRevision: 'c1' }
const remote = { host: 'mac', user: 'quo', port: 22, ssh: { known_hosts_file: '/tmp/k.known_hosts', host_key_alias: 'mac', identity_agent: '/tmp/a.sock', strict_host_key: true } }
const forward = { id: 'owner-macbook', to: { host: '127.0.0.1' } }
const args = { harness: 'claude-code', cwd: '/srv/x', session_name: 'bot-aaaa1111-2nd-x1' }

function fixture({ switched = true, answers = [{ remote, forward, revision: 'r1' }], ensure = async () => ({ structuredContent: { port: 41999, ready_at: 'T' } }), records = {}, stop = null } = {}) {
  const calls = [], asked = []
  const terminals = { connection: {
    async target() { return { terminal, ...(switched ? { remote, forward } : {}), cwd: '/Users/quo/work/app', accountOwner: 'owner' } },
    async remoteFor(id) { asked.push(id); return answers.length > 1 ? answers.shift() : answers[0] },
  }, watch() { return () => {} } }
  const ingress = { seatCredential: { async issue() { return { url: 'http://127.0.0.1:4183/api/seat-mcp', credentialRef: {} } }, async revoke() {}, async reveal() { return 'tok' } } }
  const seats = new RemoteSeats({ terminals, ingress, launchContext: async () => ({ text: 'R' }), recorded: async name => records[name] ?? null })
  const base = { async call(name, a, options) { calls.push([name, a]); if (name === 'ensure_forward') return ensure(a); if (name === 'agent_stop' && stop) return stop(a); return { structuredContent: { ok: true } } } }
  const client = seats.route(base)
  return { seats, calls, asked, client }
}

test('prepare on a switched terminal ensures the forward first, names P in the seat URLs and launches on remote', async () => {
  const { seats, calls } = fixture()
  const prepared = await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  assert.deepEqual(calls[0], ['ensure_forward', { id: 'owner-macbook', remote, to: { host: '127.0.0.1', port: 4183 } }], 'remote rides on every ensure_forward: an id that is not a binding ref (the module agent) is unknown to Aiterm without it')
  assert.deepEqual(prepared.args.remote, remote)
  assert.equal('terminal' in prepared.args, false)
  assert.equal(prepared.args.mcp_config.mcpServers.bellteam.url, 'http://127.0.0.1:41999/api/seat-mcp')
  assert.equal(prepared.args.mcp_config.mcpServers['call-bridge'].url, 'http://127.0.0.1:41999/api/seat-mcp/call-bridge')
  assert.deepEqual(prepared.privateEnv.names, ['BELLTEAM_MCP_TOKEN', ...GIT_NAMES])
  assert.deepEqual(await prepared.privateEnv.resolve(), { BELLTEAM_MCP_TOKEN: 'tok', GIT_AUTHOR_NAME: BOT_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: BOT_GIT_IDENTITY.email, GIT_COMMITTER_NAME: BOT_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: BOT_GIT_IDENTITY.email })
})

test('ensure_forward failing, or a terminal not switched, launches on terminal exactly as before', async () => {
  for (const f of [fixture({ ensure: async () => { throw new Error('down') } }), fixture({ switched: false })]) {
    const prepared = await f.seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
    assert.deepEqual(prepared.args.terminal, terminal)
    assert.equal('remote' in prepared.args, false)
    assert.equal(prepared.args.mcp_config.mcpServers.bellteam.url, 'http://127.0.0.1:4183/api/seat-mcp')
    assert.deepEqual(prepared.privateEnv.names, ['BELLTEAM_MCP_TOKEN', ...GIT_NAMES])
  }
})

test('every call that names a seat launched on remote carries the route; other seats and calls are untouched', async () => {
  const { seats, calls, client } = fixture()
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  calls.length = 0
  await client.call('pty_send', { session_id: args.session_name, text: 'x' })
  await client.call('pty_send', { session_id: 'local-seat', text: 'x' })
  await client.call('pty_list', {})
  assert.deepEqual(calls.map(([name, a]) => [name, a.session_id, a.remote ? 'remote' : null]),
    [['pty_send', args.session_name, 'remote'], ['pty_send', 'local-seat', null], ['pty_list', undefined, null]])
})

test('agent_stop is split by route and the answers are merged', async () => {
  const { seats, calls, client } = fixture({ stop: a => ({ structuredContent: { status: a.remote ? 'sent' : 'idle', targets: a.session_ids.map(id => ({ session_id: id, status: a.remote ? 'sent' : 'idle' })) } }) })
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  calls.length = 0
  const merged = await client.call('agent_stop', { session_ids: [args.session_name, 'local-seat'] })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(([, a]) => [a.session_ids, Boolean(a.remote)]).sort(), [[['bot-aaaa1111-2nd-x1'], true], [['local-seat'], false]].sort())
  assert.equal(merged.structuredContent.status, 'sent')
  assert.equal(merged.structuredContent.targets.length, 2)
  calls.length = 0
  await client.call('agent_stop', { session_ids: [args.session_name] })
  assert.equal(calls.length, 1)
  assert.equal(Boolean(calls[0][1].remote), true)
})

test('a relaunch of the same name on terminal ends its route', async () => {
  let failing = false
  const { seats, calls, client } = fixture({ ensure: async () => { if (failing) throw new Error('down'); return { structuredContent: { port: 41999 } } } })
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  failing = true
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  calls.length = 0
  await client.call('pty_send', { session_id: args.session_name, text: 'x' })
  assert.equal(calls[0][1].remote, undefined)
})

test('after a body restart the route is rebuilt from the launch record and remoteFor; AGENT_EMPTY is retried, a refusal never falls back to terminal', async () => {
  const records = { 's1': { route: 'remote', target: 'mac-1\n/Users/quo/work/app' }, 's2': { target: 'mac-1\n/x' } }
  const ok = fixture({ records, answers: [{ reason: 'AGENT_EMPTY' }, { remote, forward, revision: 'r1' }] })
  await ok.client.call('pty_read', { session_id: 's1' })
  assert.equal(ok.calls.at(-1)[1].remote, remote)
  assert.equal(ok.asked.length, 2)
  await ok.client.call('pty_read', { session_id: 's2' }) // a seat on the terminal route: no remote
  assert.equal(ok.calls.at(-1)[1].remote, undefined)

  const refused = fixture({ records, answers: [{ reason: 'TRUST_COPY_MISSING' }] })
  await assert.rejects(refused.client.call('pty_read', { session_id: 's1' }), { code: 'REMOTE_ROUTE_UNAVAILABLE' })
  assert.equal(refused.calls.length, 0, 'no call without remote reaches Aiterm')
})

test('the seat view reads one pty_list per machine, converts the rows, and drops a seat the machine no longer lists', async () => {
  const { seats, calls } = fixture()
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  seats.routes.sessions.set('gone', 'mac-1'); seats.routes.sessions.set('dark', 'mac-1')
  calls.length = 0
  seats.routes.client.call = async (name, a) => { calls.push([name, a]); return { structuredContent: { sessions: [
    { session_id: args.session_name, harness: 'claude-code', launch_id: 'L', turn: { state: 'running', turn_id: 't', started_at: '2026-11-23T00:00:00.000Z', event_cursor: 5, interim_from: 'v1:1:b:2' }, own_work: { processes: 0 }, limit_end: null },
    { session_id: 'dark', harness: 'claude-code', launch_id: 'M', turn: null }] } } }
  const view = await seats.routes.views(null)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['pty_list', { remote, include: ['turn', 'own_work'] }])
  assert.deepEqual(view.rows[0].turn, { state: 'running', turn_id: 't', started_at: '2026-11-23T00:00:00.000Z', event_cursor: null, interim_from: 'v1:1:b:2', wait_process: null })
  assert.deepEqual(view.unread, ['dark'])
  assert.equal(view.rows[0].route_since, 'T') // the launch's ensure_forward answer (ready_at) is the row's route_since
  assert.equal(seats.routes.sessions.has('gone'), false)
  assert.deepEqual(viewRows([{ session_id: 'old', turn: undefined }]).unread, ['old'])
})

test('the keeper calls ensure_forward at most once a minute per terminal and takes a changed revision', async () => {
  let clock = 0
  const asked = [], calls = []
  const routes = new RemoteRoutes({ terminals: { connection: { async remoteFor() { asked.push(1); return { remote, forward, revision: asked.length > 1 ? 'r2' : 'r1' } } } }, now: () => clock, port: () => 4183 })
  let ready = 'R1'
  routes.client = { async call(name, a) { calls.push([name, a]); return { structuredContent: { ready_at: ready } } } }
  routes.add('s1', 'mac-1', { remote, forward, revision: 'r1' })
  await routes.keep(); assert.equal(calls.length, 0)
  clock = 61_000; await routes.keep(); await routes.keep()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['ensure_forward', { id: 'owner-macbook', remote, to: { host: '127.0.0.1', port: 4183 } }])
  assert.equal(routes.routes.get('mac-1').revision, 'r1')
  assert.equal(routes.readyAt.get('mac-1'), 'R1')
  clock = 130_000; ready = 'R2'; await routes.keep()
  assert.equal(routes.routes.get('mac-1').revision, 'r2')
  assert.equal(routes.readyAt.get('mac-1'), 'R2') // a rebuilt route has a new ready_at: a new route_since key
  clock = 200_000; ready = null; await routes.keep()
  assert.equal(routes.readyAt.has('mac-1'), false) // not ready: no route_since
})

test('the transcript of a seat on remote is read over its pinned ssh', async () => {
  const { seats } = fixture()
  await seats.prepare(bot, args, { slot: null, harness: 'claude-code' })
  const flags = await seats.routes.transcriptFlags(args.session_name)
  assert.deepEqual(flags, ['--host', 'mac', '--user', 'quo', '--port', '22', '--known-hosts', '/tmp/k.known_hosts', '--host-key-alias', 'mac', '--identity-agent', '/tmp/a.sock'])
  assert.deepEqual(await seats.routes.transcriptFlags('local-seat'), [])
})
