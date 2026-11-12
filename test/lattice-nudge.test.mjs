import assert from 'node:assert/strict'
import test from 'node:test'
import { nudgeSweep, nudgeMessages } from '../src/lattice/nudge.mjs'
import { validateLatticeEffect, validateLatticeEffectResult, validateLatticeRequest, validateLatticeResult } from '../src/lattice-protocol.mjs'

const roster = ids => ids.map(id => ({ id, name: id, color: 'sky', avatarVersion: 'v1', deleting: id === 'bot-del' }))
const task = (id, prompt = `p1/${id}: fire it, or set a stop.`) => ({ plan_key: 'p1', plan_version: 'v1', task_id: id, title: id, done_condition: null,
  fire_actions: [`lattice todo start --plan p1 --task ${id}`], stop_action: `lattice todo block --plan p1 --task ${id} --reason <why it cannot move>`, prompt })

function rig({ charts, turns = {}, deliveries = {}, turnsFail = false }) {
  const runs = [], sent = [], logs = [], reads = []
  const run = async (id, args) => {
    runs.push([id, ...args].join(' '))
    const value = charts[id]
    if (value instanceof Error) throw value
    return { schema: 'lattice.todo_nudge_result.v1', project_id: id, lanes: value, result_digest: 'x' }
  }
  const effect = async (method, params) => {
    if (method === 'turns.read') { reads.push(params.botIds); if (turnsFail) throw new Error('down'); return { turns } }
    assert.equal(method, 'messages.send')
    sent.push(params)
    return { delivery: deliveries[params.target] ?? 'running', deliveryId: 'd' }
  }
  return { runs, sent, logs, reads, go: ids => nudgeSweep(ids, { run, log: line => logs.push(line), roster: roster(['bot-a', 'bot-b', 'bot-c', 'bot-del']), effect }) }
}

test('nudge: every chart is read; prompts go as is to lane Bots that are not working, one message per lane', async () => {
  const x = rig({
    charts: {
      alpha: [{ lane: 'bot-a', tasks: [task('t1'), task('t2')] }, { lane: 'bot-b', tasks: [task('t3')] }, { lane: 'owner', tasks: [task('t4')] }],
      beta: [{ lane: 'bot-a', tasks: [task('t5')] }, { lane: 'bot-c', tasks: [task('t6')] }, { lane: 'bot-del', tasks: [task('t7')] }],
      empty: [],
      broken: Object.assign(new Error('read'), { code: 'LATTICE_CLI_EXIT_1' }),
    },
    turns: { 'bot-a': 'idle', 'bot-b': 'working', 'bot-c': 'unknown' },
  })
  const out = await x.go(['alpha', 'beta', 'empty', 'broken'])
  assert.deepEqual(x.runs, ['alpha todo nudge --json', 'beta todo nudge --json', 'empty todo nudge --json', 'broken todo nudge --json'])
  assert.deepEqual(x.reads, [['bot-a', 'bot-b', 'bot-c']], 'owner and deleting lanes have no seat')
  assert.deepEqual(x.sent.map(item => [item.from, item.target]), [['scheduler', 'bot-a'], ['scheduler', 'bot-c']], 'a working Bot is not prompted')
  assert.equal(x.sent[0].message, 'Lattice nudge, chart alpha (lattice tool, project alpha):\np1/t1: fire it, or set a stop.\n\np1/t2: fire it, or set a stop.'
    + '\n\nLattice nudge, chart beta (lattice tool, project beta):\np1/t5: fire it, or set a stop.')
  assert.deepEqual(out, { charts: 3, prompted: 4, skipped: 1, failed: 1 })
  assert.deepEqual(x.logs, ['lattice-nudge broken LATTICE_CLI_EXIT_1'])
})

test('nudge: a failed turns read prompts every lane; a send not accepted counts failed and the next tick sends again', async () => {
  const x = rig({ charts: { alpha: [{ lane: 'bot-a', tasks: [task('t1')] }, { lane: 'bot-b', tasks: [task('t2')] }] }, turnsFail: true, deliveries: { 'bot-b': 'refused' } })
  assert.deepEqual(await x.go(['alpha']), { charts: 1, prompted: 1, skipped: 0, failed: 1 })
  assert.deepEqual(x.sent.map(item => item.target), ['bot-a', 'bot-b'])
  const quiet = rig({ charts: { alpha: [] } })
  assert.deepEqual(await quiet.go(['alpha']), { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.deepEqual(quiet.reads, [], 'nothing ready: no turn read')
})

test('nudge messages split at prompt boundaries within 4000 chars and repeat the chart header', () => {
  const long = 'x'.repeat(1500)
  const parts = nudgeMessages([{ projectId: 'a', prompt: long }, { projectId: 'a', prompt: long }, { projectId: 'a', prompt: long }])
  assert.equal(parts.length, 2)
  assert.ok(parts.every(part => part.length <= 4000 && part.startsWith('Lattice nudge, chart a ')))
  assert.equal(parts.join('').split(long).length - 1, 3)
})

test('protocol: root nudge and effect turns.read', () => {
  const context = { generation: 'g1' }
  validateLatticeRequest('nudge', {}, context)
  assert.throws(() => validateLatticeRequest('nudge', { x: 1 }, context), { code: 'LATTICE_INVALID' })
  validateLatticeResult('nudge', { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.throws(() => validateLatticeResult('nudge', { charts: 1 }), { code: 'LATTICE_IPC_INVALID' })
  validateLatticeEffect('turns.read', { botIds: ['bot-a'] })
  for (const botIds of [[], ['a', 'a'], [''], 'bot-a']) assert.throws(() => validateLatticeEffect('turns.read', { botIds }), { code: 'LATTICE_INVALID' })
  validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'working', 'bot-b': 'unknown' } })
  assert.throws(() => validateLatticeEffectResult('turns.read', { turns: { 'bot-a': 'busy' } }), { code: 'LATTICE_IPC_INVALID' })
})
