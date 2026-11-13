import assert from 'node:assert/strict'
import test from 'node:test'
import { nudgeSweep, nudgeMessage } from '../src/lattice/nudge.mjs'
import { laneResolver } from '../src/lattice/projection.mjs'
import { validateLatticeEffect, validateLatticeEffectResult, validateLatticeRequest, validateLatticeResult } from '../src/lattice-protocol.mjs'

const members = ['bot-a', 'bot-b', 'bot-c', 'bot-del'].map(id => ({ id, name: id === 'bot-c' ? 'Cee' : id, color: 'sky', avatarVersion: 'v1', deleting: id === 'bot-del' }))
const card = (taskId, state, lane) => ({ plan: 'p1', taskId, title: taskId.toUpperCase(), state, lane })

function rig({ charts, turns = {}, deliveries = {}, turnsFail = false }) {
  const sent = [], logs = [], reads = []
  const effect = async (method, params) => {
    if (method === 'turns.read') { reads.push(params.botIds); if (turnsFail) throw new Error('down'); return { turns } }
    assert.equal(method, 'messages.send')
    sent.push(params)
    return { delivery: deliveries[params.target] ?? 'running', deliveryId: 'd' }
  }
  return { sent, logs, reads, go: () => nudgeSweep(charts, { laneOf: laneResolver(members), log: line => logs.push(line), effect }) }
}

test('nudge: in-progress and startable cards, ONE prompt per lane Bot that is not working; no todo nudge, no other condition', async () => {
  const x = rig({
    charts: [
      { projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'in-progress', 'bot-a'), card('t3', 'ready', 'bot-b'), card('t4', 'ready', 'owner'),
        card('t5', 'blocked', 'bot-a'), card('t6', 'pending', 'bot-a'), card('t7', 'done', 'bot-a'), card('t8', 'retired', 'bot-a'), card('t9', 'ready', 'stranger')] },
      { projectId: 'beta', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'in-progress', 'Cee'), card('t3', 'ready', 'bot-del')] },
      { projectId: 'empty', cards: [] },
    ],
    turns: { 'bot-a': 'idle', 'bot-b': 'working', 'bot-c': 'unknown' },
  })
  const out = await x.go()
  assert.deepEqual(x.reads, [['bot-a', 'bot-b', 'bot-c']], 'owner, deleting and non-roster lanes have no seat; a lane by name resolves')
  assert.deepEqual(x.sent.map(item => [item.from, item.target]), [['scheduler', 'bot-a'], ['scheduler', 'bot-c']], 'a working Bot is not prompted')
  const text = x.sent[0].message
  assert.ok(text.startsWith('Lattice: you are not running') && text.includes('Start at least one now.'))
  assert.ok(text.includes('lattice todo dependency connect') && text.includes('lattice todo add') && text.includes('--before <T>') && text.includes('lattice todo retract'))
  assert.ok(!text.includes('todo block') && !/\bstop\b/i.test(text), 'a wait is a prerequisite, never a stop (Owner K-YNBZE7)')
  assert.ok(text.endsWith('\nChart alpha (lattice tool, project alpha):\n- p1/t1 「T1」: can start -> `lattice todo start --plan p1 --task t1`\n- p1/t2 「T2」: in progress'
    + '\nChart beta (lattice tool, project beta):\n- p1/t1 「T1」: can start -> `lattice todo start --plan p1 --task t1`'))
  assert.ok(!text.includes('t5') && !text.includes('t6') && !text.includes('t7') && !text.includes('t8'), 'stopped, waiting on prerequisites and finished cards are not prompted')
  assert.deepEqual(out, { charts: 3, prompted: 2, skipped: 1, failed: 0 })
})

test('nudge: a failed turns read prompts every Bot; a send not accepted counts failed and the next tick sends again', async () => {
  const x = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'ready', 'bot-a'), card('t2', 'ready', 'bot-b')] }], turnsFail: true, deliveries: { 'bot-b': 'refused' } })
  assert.deepEqual(await x.go(), { charts: 1, prompted: 1, skipped: 0, failed: 1 })
  assert.deepEqual(x.sent.map(item => item.target), ['bot-a', 'bot-b'])
  assert.deepEqual(x.logs, ['lattice-nudge-send bot-b not accepted'])
  const quiet = rig({ charts: [{ projectId: 'alpha', cards: [card('t1', 'done', 'bot-a')] }] })
  assert.deepEqual(await quiet.go(), { charts: 1, prompted: 0, skipped: 0, failed: 0 })
  assert.deepEqual(quiet.reads, [], 'nothing actionable: no turn read')
})

test('nudge: a task list over 4000 chars is ONE send per Bot, bounded, the rest counted', async () => {
  const cards = Array.from({ length: 40 }, (_, i) => ({ ...card(`t${i}`, 'ready', 'bot-a'), title: 'x'.repeat(80) }))
  const sends = []
  const effect = async (method, params) => method === 'turns.read' ? { turns: { 'bot-a': 'idle' } } : (sends.push(params), { delivery: 'running' })
  const out = await nudgeSweep([{ projectId: 'a', cards }], { laneOf: lane => lane, log: () => {}, effect })
  assert.equal(sends.length, 1, 'exactly one prompt')
  assert.deepEqual([out.prompted, out.failed], [1, 0])
  const text = sends[0].message
  assert.ok(text.length <= 4000)
  const shown = text.split('「').length - 1
  assert.ok(shown > 0 && shown < 40)
  assert.ok(text.endsWith(`... and ${40 - shown} more of your tasks are in progress or can start: see \`lattice status\` on each chart.`))
  assert.equal(nudgeMessage(cards.slice(0, 2).map(c => ({ projectId: 'a', card: c }))).includes('more of your tasks'), false, 'a short list has no tail')
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
