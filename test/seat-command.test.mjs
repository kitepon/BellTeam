import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermClient } from '../src/aiterm-transport.mjs'
import { seatCommandSpec } from '../src/seat-command.mjs'

test('明示した不正seatProjectは旧経路へ落とさず、構築時にtyped errorで拒否する', () => {
  for (const seatProject of ['', false, 0, {}, [], undefined, 'relative', '/invalid\0path']) {
    assert.throws(() => new AitermClient({ seatProject, command: '/synthetic-must-not-start' }), { code: 'SEAT_PROJECT_INVALID' })
    assert.throws(() => seatCommandSpec('synthetic', [], { project: seatProject }), { code: 'SEAT_PROJECT_INVALID' })
  }
  assert.equal(new AitermClient().seatProject, null)
  assert.equal(new AitermClient({ seatProject: null }).seatProject, null)
})

test('構築後の不正設定もconnect/動的env分岐の前で拒否し、SDK接続を作らない', async () => {
  const client = new AitermClient({ command: '/synthetic-must-not-start' })
  client.seatProject = ''
  await assert.rejects(client.connect(), { code: 'SEAT_PROJECT_INVALID' })
  assert.equal(client.client, null)
  assert.equal(client.transport, null)
  await assert.rejects(client.call('synthetic', {}, { env: { SYNTHETIC_SERVER_ONLY: 'canary' } }), { code: 'SEAT_PROJECT_INVALID' })
  assert.equal(client.client, null)
})

test('席launchは対象projectだけを渡し、server env指定/別tool/不一致を作用前に拒否する', async () => {
  const client = new AitermClient({ seatProject: '/synthetic-control', command: '/must-not-start' })
  assert.deepEqual(await client.launchOptions('/synthetic-target'), { launchProject: '/synthetic-target' })
  for (const project of [undefined, '', false, 'relative'])
    await assert.rejects(client.launchOptions(project), { code: 'SEAT_PROJECT_INVALID' })
  for (const [name, args, options] of [
    ['probe', { cwd: '/synthetic-target' }, { launchProject: '/synthetic-target' }],
    ['agent_launch', { cwd: '/other' }, { launchProject: '/synthetic-target' }],
    ['agent_launch', { cwd: '/synthetic-target' }, { launchProject: '/synthetic-target', env: {} }],
    ['agent_launch', { cwd: '/synthetic-target', env_vars: ['SERVER'] }, { launchProject: '/synthetic-target' }],
  ]) await assert.rejects(client.call(name, args, options), { code: 'SEAT_LAUNCH_ARGUMENTS' })
  await assert.rejects(new AitermClient().call('agent_launch', { cwd: '/synthetic-target' },
    { launchProject: '/synthetic-target' }), { code: 'SEAT_LAUNCH_ARGUMENTS' })
  assert.equal(client.client, null)
})
