import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SelfTurns, readObserverTurns, throughlineChanged } from '../src/self-turns.mjs'

const bots = new Map([['bot-r', { id: 'bot-r', project: '/srv/bellteam/bots/bot-r' }]])
const turn = (key, start, assistant, completed) => ({ source_sha256: key, turn_start: start, assistant, completed_at: completed, host: 'claude', truncated: false })

async function feed(pages, { changed = async () => true, state = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'self-turns-'))
  const statePath = join(dir, 'self-turns.json')
  if (state) await writeFile(statePath, JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: state }))
  const reads = []
  const answers = []
  const turns = []
  const reported = []
  const service = new SelfTurns({
    bots, statePath, changed,
    read: async request => { reads.push(request); return pages.shift() },
    appendAnswer: async (...args) => answers.push(args),
    afterTurn: value => turns.push(value),
    report: message => reported.push(message),
    groupId: () => 'g-1',
  })
  await service.initialize()
  return { service, reads, answers, turns, reported, statePath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('初めて見るBotは今の位置から始め、過去のターンを画面へ出さない', async () => {
  const { service, reads, answers, statePath, cleanup } = await feed([
    { status: 'snapshot', throughCursor: 'c1', turns: [turn('a', 'self', '前の報告', 1000)] },
  ])
  await service.poll()
  assert.deepEqual(reads, [{ project: '/srv/bellteam/bots/bot-r' }])
  assert.deepEqual(answers, [])
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(saved.bots['bot-r'], { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 })
  await cleanup()
})

test('自分から始まったターンの回答だけを出し、報告漏れの確認にかける', async () => {
  const { service, reads, answers, turns, statePath, cleanup } = await feed([
    { status: 'delta', throughCursor: 'c2', page: { complete: true }, turns: [
      turn('b', 'prompt', '指揮官への返事', 2000),
      turn('c', 'self', '  導入まで終わりました。  ', 3000),
      turn('d', 'unknown', '見分けられないターン', 4000),
    ] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.deepEqual(reads, [{ project: '/srv/bellteam/bots/bot-r', afterCursor: 'c1', throughCursor: null, pageToken: null }])
  assert.deepEqual(answers, [['bot-r', 'g-1', '導入まで終わりました。']])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].botId, 'bot-r')
  assert.equal(turns[0].context, 'self')
  assert.equal(turns[0].startedAt, new Date(2000).toISOString())
  assert.ok(turns[0].endedAt >= new Date(3000).toISOString())
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(saved.bots['bot-r'].cursor, 'c2')
  assert.deepEqual(saved.bots['bot-r'].seen, ['a', 'b', 'c', 'd'])
  assert.equal(saved.bots['bot-r'].lastCompletedAt, 4000)
  await cleanup()
})

test('ページを続けて読み、/clearのあとに同じターンが届いても1回しか出さない', async () => {
  const { service, reads, answers, cleanup } = await feed([
    { status: 'delta', throughCursor: 'c2', page: { complete: false, nextToken: 'p2' }, turns: [turn('c', 'self', '報告1', 3000)] },
    { status: 'thread_switched', throughCursor: 'c2', page: { complete: true }, turns: [turn('c', 'self', '報告1', 3000), turn('e', 'self', '報告2', 5000)] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: [], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.deepEqual(reads[1], { project: '/srv/bellteam/bots/bot-r', afterCursor: 'c1', throughCursor: 'c2', pageToken: 'p2' })
  assert.deepEqual(answers.map(([, , text]) => text), ['報告1', '報告2'])
  await cleanup()
})

test('書きかけの時は位置を進めず、記録が変わらなくても次の回で読み直す', async () => {
  let changes = [true, false]
  const { service, reads, answers, statePath, cleanup } = await feed([
    { status: 'projection_pending' },
    { status: 'delta', throughCursor: 'c2', page: { complete: true }, turns: [turn('c', 'self', '報告', 3000)] },
  ], { changed: async () => changes.shift() ?? false, state: { 'bot-r': { cursor: 'c1', seen: [], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).bots['bot-r'].cursor, 'c1')
  await service.poll()
  assert.equal(reads.length, 2)
  assert.deepEqual(answers.map(([, , text]) => text), ['報告'])
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).bots['bot-r'].cursor, 'c2')
  await service.poll()
  assert.equal(reads.length, 2)
  await cleanup()
})

test('位置が古くなった時は読み直し、最後に見たターンより新しい分だけを出す', async () => {
  const { service, answers, turns, reads, reported, statePath, cleanup } = await feed([
    { status: 'resync_required' },
    { status: 'snapshot', throughCursor: 'c9', turns: [
      turn('old', 'self', '前に見た報告', 1000),
      turn('older', 'self', '控えから外れていた古い報告', 900),
      turn('p', 'prompt', '配送したターンの回答', 5000),
      turn('x', 'self', '間に終わった報告', 9000),
    ] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: ['old'], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '間に終わった報告']])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].startedAt, new Date(5000).toISOString())
  assert.deepEqual(reads, [
    { project: '/srv/bellteam/bots/bot-r', afterCursor: 'c1', throughCursor: null, pageToken: null },
    { project: '/srv/bellteam/bots/bot-r' },
  ])
  assert.equal(reported.length, 1)
  const saved = JSON.parse(await readFile(statePath, 'utf8')).bots['bot-r']
  assert.equal(saved.cursor, 'c9')
  assert.deepEqual(saved.seen, ['old', 'older', 'p', 'x'])
  assert.equal(saved.lastCompletedAt, 9000)
  await cleanup()
})

test('ターンが増えるたびに位置が無効になる席でも、自分から始まったターンを1回ずつ出す', async () => {
  // Throughline 0.14.3 の、完了ターンの控えが256件を超えたClaudeの席の形。
  const { service, answers, cleanup } = await feed([
    { status: 'resync_required' },
    { status: 'snapshot', throughCursor: 'c2', turns: [turn('a', 'prompt', '回答', 1000), turn('b', 'self', '報告1', 2000)] },
    { status: 'resync_required' },
    { status: 'snapshot', throughCursor: 'c3', turns: [turn('a', 'prompt', '回答', 1000), turn('b', 'self', '報告1', 2000), turn('c', 'self', '報告2', 3000)] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 } } })
  await service.poll()
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '報告1'], ['bot-r', 'g-1', '報告2']])
  await cleanup()
})

test('どこまで見たか分からないまま位置が古くなった時は、今の位置から始めて過去のターンを出さない', async () => {
  const { service, answers, statePath, cleanup } = await feed([
    { status: 'resync_required' },
    { status: 'snapshot', throughCursor: 'c9', turns: [turn('x', 'self', '古い報告', 9000)] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: [], lastCompletedAt: null } } })
  await service.poll()
  assert.deepEqual(answers, [])
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).bots['bot-r'].cursor, 'c9')
  await cleanup()
})

test('読み直しが書きかけに当たった時は位置を変えず、記録が変わらなくても次の回で読み直す', async () => {
  let polls = 0
  const { service, answers, statePath, cleanup } = await feed([
    { status: 'resync_required' },
    { status: 'projection_pending' },
    { status: 'resync_required' },
    { status: 'snapshot', throughCursor: 'c9', turns: [turn('x', 'self', '間に終わった報告', 9000)] },
  ], { changed: async () => polls++ === 0, state: { 'bot-r': { cursor: 'c1', seen: [], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.deepEqual(answers, [])
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '間に終わった報告']])
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).bots['bot-r'].cursor, 'c9')
  await cleanup()
})

test('Throughlineへv2で全文を求め、v2でない返事は受け取らない', async () => {
  const calls = []
  const run = async (command, args) => { calls.push([command, args]); return { stdout: JSON.stringify({ schema: 'throughline.observer_read.v2', status: 'delta', turns: [] }) } }
  await readObserverTurns({ project: '/p', afterCursor: 'c1', throughCursor: 'c2', pageToken: 't' }, { run })
  assert.deepEqual(calls, [['throughline', ['observer-read', '--project', '/p', '--wire', 'v2', '--limit', '100', '--json', '--after-cursor', 'c1', '--through-cursor', 'c2', '--page-token', 't']]])
  const old = async () => ({ stdout: JSON.stringify({ schema: 'throughline.observer_read.v1', status: 'delta', turns: [] }) })
  await assert.rejects(readObserverTurns({ project: '/p' }, { run: old }), /THROUGHLINE_OBSERVER_READ_INVALID/)
})

test('ThroughlineのDBが変わった時だけ変わったと答える', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'self-turns-db-'))
  const changed = throughlineChanged(dir)
  assert.equal(await changed(), true)
  assert.equal(await changed(), false)
  await writeFile(join(dir, 'throughline.db-wal'), 'x')
  assert.equal(await changed(), true)
  await rm(dir, { recursive: true, force: true })
})
