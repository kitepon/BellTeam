import test from 'node:test'
import assert from 'node:assert/strict'
import { refuseRemoteSeatLaunch } from '../src/application-services.mjs'

test('an engine without remote seats cannot launch a terminal-bound member; everything else passes through', async () => {
  const calls = [], records = []
  const native = { call: async (name, args) => { calls.push([name, args.cwd ?? null]); return 'native' }, runtime: () => 'rt' }
  const members = { 'bot-mac': { id: 'bot-mac', terminalId: 'macbook' }, 'bot-local': { id: 'bot-local' } }
  const port = refuseRemoteSeatLaunch({ native, bots: { get: id => members[id] ?? null }, botsRoot: '/srv/bellteam/bots',
    versionId: 'f0534f8b', record: report => records.push(report) })
  await assert.rejects(port.call('agent_launch', { cwd: '/srv/bellteam/bots/bot-mac' }, {}),
    { code: 'REMOTE_SEAT_ENGINE_UNSUPPORTED', effect: 'not_started', message: 'AI実行制御が古く、この席を端末で起こせません' })
  assert.equal(await port.call('agent_launch', { cwd: '/srv/bellteam/bots/bot-local' }), 'native')
  assert.equal(await port.call('pty_send', { cwd: '/srv/bellteam/bots/bot-mac' }), 'native')
  assert.equal(port.runtime(), 'rt')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['agent_launch', '/srv/bellteam/bots/bot-local'], ['pty_send', '/srv/bellteam/bots/bot-mac']])
  assert.deepEqual(records, [{ code: 'REMOTE_SEAT_ENGINE_UNSUPPORTED', module: 'execution', diagnostic_log: 'bot bot-mac execution f0534f8b' }])
})

test('a pinned native keeps the check and its generation, live getters and release', async () => {
  const calls = []
  let released = 0, live = 'sdk-1'
  const pinned = Object.freeze({ generation: 'g1', get client() { return live }, release: () => { released++ },
    call: async (name, args) => { calls.push([name, args.cwd]); return 'pinned' } })
  const native = { call: async () => 'native', pin: () => pinned }
  const port = refuseRemoteSeatLaunch({ native, bots: { get: id => id === 'bot-mac' ? { id, terminalId: 'macbook' } : null },
    botsRoot: '/srv/bellteam/bots' })
  const lease = port.pin()
  await assert.rejects(lease.call('agent_launch', { cwd: '/srv/bellteam/bots/bot-mac' }), { code: 'REMOTE_SEAT_ENGINE_UNSUPPORTED' })
  assert.equal(await lease.call('agent_launch', { cwd: '/srv/bellteam/bots/bot-local' }), 'pinned')
  live = 'sdk-2'
  assert.equal(lease.generation, 'g1'); assert.equal(lease.client, 'sdk-2')
  lease.release(); assert.equal(released, 1)
  assert.deepEqual(calls, [['agent_launch', '/srv/bellteam/bots/bot-local']])
})
