import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SelfTurns, readChildResultPreface, readObserverTurns } from '../src/self-turns.mjs'
import { captureRuntime } from '../src/runtime-selection.mjs'

const bots = new Map([['bot-r', { id: 'bot-r', project: '/srv/bellteam/bots/bot-r' }]])
const turn = (key, start, assistant, completed) => ({ source_sha256: key, turn_start: start, assistant, completed_at: completed, host: 'claude', truncated: false })

const PREFACE = 'Aitermの子エージェントからの実行結果です。'
async function feed(pages, { changed = async () => true, state = null, shown = () => null, read = null, childResultPreface = async () => PREFACE } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'self-turns-'))
  const statePath = join(dir, 'self-turns.json')
  if (state) state = Object.fromEntries(Object.entries(state).map(([id, value]) => [id, { project: bots.get(id).project, checkToken: 'tloc1.prior', ...value }]))
  if (state) await writeFile(statePath, JSON.stringify({ schema: 'bellteam.self-turns.v1', bots: state }))
  const reads = []
  const answers = []
  const turns = []
  const reported = []
  let generation = 0
  const service = new SelfTurns({
    bots, statePath, shown,
    check: async request => {
      const change = await changed()
      generation++
      return { schema: 'throughline.observer_check_result.v1', status: 'complete', results: request.projects.map(item => ({
        id: item.id, status: change || item.after === null ? 'changed' : 'unchanged',
        token: change || item.after === null ? `tloc1.fixture${generation}` : item.after,
      })) }
    },
    read: async request => { reads.push(request); return read ? read(request) : pages.shift() },
    appendAnswer: async (...args) => answers.push(args),
    afterTurn: value => turns.push(value),
    report: (message, detail) => reported.push(detail ? { message, ...detail } : message),
    groupId: () => 'g-1', childResultPreface,
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
  assert.deepEqual(saved.bots['bot-r'], { project: bots.get('bot-r').project, checkToken: 'tloc1.fixture1', cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 })
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

test('Aitermの子の結果で始まったターンの回答も出す。配送したターンへ子の結果が差し込まれた時は出さない', async () => {
  // 2026-10-13 22:22、リリーバイスの席の記録の形。Throughlineは改行を空白にして返す。
  const child = 'Aitermの子エージェントからの実行結果です。子の回答として扱ってください。 delivery_id=d-1 session=child harness=codex-cli launch_id=l-1 turn_id=t-1 outcome=done 担当の成果'
  const delivered = '「オーナー」からあなたへ次のメッセージが届いています。 進みを教えて'
  const { service, answers, turns, cleanup } = await feed([
    { status: 'delta', throughCursor: 'c2', page: { complete: true }, turns: [
      { ...turn('b', 'prompt', '担当の成果を受け取ったよ。', 2000), user: child },
      { ...turn('c', 'prompt', '指揮官への返事', 3000), user: `${delivered} ${child}` },
      { ...turn('d', 'prompt', '', 4000), user: child },
    ] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 } } })
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '担当の成果を受け取ったよ。']])
  assert.deepEqual(turns.map(value => [value.context, value.startedAt]), [['self', new Date(1000).toISOString()]])
  await cleanup()
})

test('子の結果の頭はAitermの約束した入口 exports[./child-result] からだけ読み、入口の無い版では理由で断る', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiterm-pkg-'))
  await mkdir(join(root, 'dist'))
  const capture = async () => ({ components: { 'runtime-aiterm-mcp': { root } } })
  await writeFile(join(root, 'package.json'), JSON.stringify({ exports: {} }))
  await assert.rejects(readChildResultPreface({ capture }), { code: 'AITERM_CHILD_RESULT_UNAVAILABLE' })
  await writeFile(join(root, 'dist/record.js'), "export const CHILD_RESULT_PREFACE = '子の頭。'")
  await writeFile(join(root, 'package.json'), JSON.stringify({ exports: { './child-result': './dist/record.js' } }))
  assert.equal(await readChildResultPreface({ capture }), '子の頭。')
  await rm(root, { recursive: true, force: true })
})

test('子の結果の頭は、本物のruntime-selectionが返すAitermの根（root）から読める（bd05）', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'aiterm-prefix-')), root = join(prefix, 'lib/node_modules/aiterm-mcp')
  await mkdir(join(root, 'build'), { recursive: true })
  await writeFile(join(root, 'build/child.js'), "export const CHILD_RESULT_PREFACE = '本物の形の頭。'")
  await writeFile(join(root, 'package.json'), JSON.stringify({ exports: { './child-result': './build/child.js' } }))
  const capture = () => captureRuntime({ root: join(prefix, 'no-selection'), builtin: prefix })
  assert.equal(await readChildResultPreface({ capture }), '本物の形の頭。')
  await rm(prefix, { recursive: true, force: true })
})

test('入口が読めない巡も自分から始まったターンは出し、子の結果は見分けず、理由は1回だけ知らせる', async () => {
  const child = `${PREFACE} delivery_id=d-1 成果`
  let calls = 0
  const { service, answers, reported, cleanup } = await feed([
    { status: 'delta', throughCursor: 'c2', page: { complete: true }, turns: [
      { ...turn('b', 'prompt', '子の成果', 2000), user: child }, { ...turn('c', 'prompt', '子の成果2', 2500), user: child }, turn('d', 'self', '自分の回答', 3000)] },
  ], { state: { 'bot-r': { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 } },
    childResultPreface: async () => { calls++; throw Object.assign(new Error('AITERM_CHILD_RESULT_UNAVAILABLE'), { code: 'AITERM_CHILD_RESULT_UNAVAILABLE' }) } })
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '自分の回答']])
  assert.equal(calls, 1)
  assert.deepEqual(reported.filter(item => item.reason === 'AITERM_CHILD_RESULT_UNAVAILABLE').length, 1)
  await cleanup()
})

const seen = { 'bot-r': { cursor: 'c1', seen: ['a'], lastCompletedAt: 1000 } }
const selfPage = (assistant, completed) => [{ status: 'delta', throughCursor: 'c2', page: { complete: true }, turns: [turn('b', 'self', assistant, completed)] }]

test('合間の言葉として先に出した文が回答の頭に全部並んでいる時は、その分を外して出す', async () => {
  const shown = { words: ['一つ目', '二つ目'], endedAt: 5000 }
  const { service, answers, cleanup } = await feed(selfPage('一つ目\n\n二つ目\n\n終わりました。', 6000), { state: structuredClone(seen), shown: () => shown })
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '終わりました。']])
  // 外した分は、次のターンの回答からもう一度外さない。
  assert.deepEqual(shown.words, [])
  await cleanup()
})

test('追っている途中に記録が先に届いた時も、頭に並んでいる分を外す', async () => {
  const { service, answers, cleanup } = await feed(selfPage('一つ目\n\n終わりました。', 6000), { state: structuredClone(seen), shown: () => ({ words: ['一つ目'], endedAt: null }) })
  await service.poll()
  assert.deepEqual(answers, [['bot-r', 'g-1', '終わりました。']])
  await cleanup()
})

test('出した文が1つでも頭に合わない時、別のターンの分の時、外すと何も残らない時は、回答をそのまま出す', async () => {
  for (const [assistant, shown] of [
    ['一つ目\n\n終わりました。', { words: ['一つ目', '二つ目'], endedAt: 5000 }],
    ['前置き\n\n一つ目\n\n終わりました。', { words: ['一つ目'], endedAt: 5000 }],
    ['一つ目\n\n終わりました。', { words: ['一つ目'], endedAt: 6000 - 60_001 }],
    ['一つ目\n\n二つ目', { words: ['一つ目', '二つ目'], endedAt: 5000 }],
    ['一つ目\n\n終わりました。', { words: [], endedAt: 5000 }],
  ]) {
    const { service, answers, cleanup } = await feed(selfPage(assistant, 6000), { state: structuredClone(seen), shown: () => shown })
    await service.poll()
    assert.deepEqual(answers, [['bot-r', 'g-1', assistant]])
    await cleanup()
  }
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

test('同じ理由で失敗し続けるBotは理由つきで1回だけ報告し、成功した後の失敗はまた報告する', async () => {
  let failing = true
  const { service, reported, cleanup } = await feed([], {
    state: { 'bot-r': { cursor: 'c1', seen: [], lastCompletedAt: 0 } },
    read: () => {
      if (failing) throw Object.assign(new Error('source changed at /private/path'), { code: 'CONVERSATION_OBSERVER_SOURCE_CHANGED' })
      return { status: 'delta', throughCursor: 'c2', turns: [] }
    },
  })
  for (let i = 0; i < 3; i++) await service.poll()
  assert.deepEqual(reported, [{ message: 'BellTeam self turns: bot-r OBSERVER_CONSUME_FAILED', reason: 'CONVERSATION_OBSERVER_SOURCE_CHANGED' }])
  failing = false
  await service.poll()
  failing = true
  await service.poll()
  await service.poll()
  assert.equal(reported.length, 2)
  assert.equal(reported[1].reason, 'CONVERSATION_OBSERVER_SOURCE_CHANGED')
  await cleanup()
})
