import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { BellTeamMemory } from '../src/memory-service.mjs'

// 実物のobserver-readは、afterCursorへ渡された値をそのまま返し、進んだ位置をthroughCursorへ入れる。
async function fixture(observeTurns = async ({ afterCursor }) => ({
  status: afterCursor ? 'delta' : 'snapshot',
  afterCursor: afterCursor ?? null,
  throughCursor: 'through-empty',
  turns: [],
  page: { complete: true, nextToken: null },
})) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-memory-'))
  const registry = new Map([
    ['bot-a', { id: 'bot-a', project: join(root, 'bots', 'bot-a') }],
    ['bot-b', { id: 'bot-b', project: join(root, 'bots', 'bot-b') }],
  ])
  registry.refresh = async () => registry
  let sequence = 0
  const memory = new BellTeamMemory({
    registry,
    root,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    id: () => `id-${++sequence}`,
    observeTurns,
  })
  await memory.initialize()
  return { root, registry, memory }
}

test('個人長期記憶はBot間で混ざらず、共通記憶も明示検索だけで返る', async () => {
  const { root, memory } = await fixture()
  await memory.remember({ botId: 'bot-a', content: 'A_PRIVATE_MEMORY 調査が好き', kind: 'preference' })
  await memory.remember({ botId: 'bot-b', content: 'B_PRIVATE_MEMORY 実装が好き', kind: 'preference' })
  await memory.remember({ botId: 'bot-a', content: 'SHARED_MEMORY 全員が日本語で話す', kind: 'policy', scope: 'shared' })

  assert.match((await memory.recallMemory({ botId: 'bot-a', query: 'A_PRIVATE_MEMORY' })).items[0].content, /A_PRIVATE_MEMORY/u)
  assert.deepEqual((await memory.recallMemory({ botId: 'bot-b', query: 'A_PRIVATE_MEMORY' })).items, [])
  assert.deepEqual((await memory.recallMemory({ botId: 'bot-a', query: 'SHARED_MEMORY' })).items, [])
  assert.match((await memory.recallMemory({ botId: 'bot-a', query: 'SHARED_MEMORY', scope: 'shared' })).items[0].content, /SHARED_MEMORY/u)

  const personalDb = new DatabaseSync(join(root, 'bots', 'bot-a', 'memory', 'memory.db'))
  assert.equal(personalDb.prepare('SELECT count(*) AS count FROM raw_events').get().count, 1)
  assert.equal(personalDb.prepare('SELECT count(*) AS count FROM assertions').get().count, 1)
  assert.equal(personalDb.prepare('SELECT count(*) AS count FROM evidence').get().count, 1)
  personalDb.close()
})

test('同じ記憶は根拠だけを追加し、更新・固定・成長統合の履歴を残す', async () => {
  const { root, memory } = await fixture()
  const first = await memory.remember({ botId: 'bot-a', content: '利用者と初めて製品を直した', kind: 'episode', importance: 8 })
  const duplicate = await memory.remember({ botId: 'bot-a', content: '利用者と初めて製品を直した', kind: 'episode', importance: 9 })
  const evolving = await memory.remember({ botId: 'bot-a', content: '想像で補ってしまうことがある', kind: 'growth' })
  const revised = await memory.reviseMemory({
    botId: 'bot-a', id: evolving.id, content: '見えていないことを想像で補わず実測する', importance: 9,
  })
  await memory.pinMemory({ botId: 'bot-a', id: first.id })
  const oldEpisode = await memory.remember({ botId: 'bot-a', content: '古い個別の出来事', kind: 'episode' })
  const growth = await memory.consolidateGrowth({
    botId: 'bot-a', memoryIds: [first.id, oldEpisode.id], content: '一緒に直した経験を次の判断へ生かす',
  })

  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.duplicate, true)
  assert.equal(revised.supersedesId, evolving.id)
  assert.equal(growth.kind, 'growth')
  assert.equal((await memory.recallMemory({ botId: 'bot-a', query: '古い個別' })).items.length, 0)
  // 改訂前の記憶は返らない。言い回しが近い改訂後の記憶が、近い物の印つきで返る。
  assert.deepEqual(
    (await memory.recallMemory({ botId: 'bot-a', query: '想像で補ってしまう' })).items.map(item => [item.id, item.match]),
    [[revised.id, 'partial']],
  )
  assert.equal((await memory.recallMemory({ botId: 'bot-a', query: '実測する' })).items[0].id, revised.id)

  const db = new DatabaseSync(join(root, 'bots', 'bot-a', 'memory', 'memory.db'))
  assert.equal(db.prepare('SELECT count(*) AS count FROM assertions WHERE content = ?').get(first.content).count, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM evidence WHERE assertion_id = ?').get(first.id).count, 2)
  assert.equal(db.prepare('SELECT status FROM assertions WHERE id = ?').get(evolving.id).status, 'superseded')
  assert.equal(db.prepare('SELECT status FROM assertions WHERE id = ?').get(oldEpisode.id).status, 'consolidated')
  assert.equal(db.prepare('SELECT status FROM assertions WHERE id = ?').get(first.id).status, 'active')
  db.close()
})

test('Throughlineの完了ターン候補はBotごとのDBとカーソルで分離される', async () => {
  const calls = []
  const observeTurns = async ({ project, afterCursor }) => {
    calls.push({ project, afterCursor })
    const botId = project.endsWith('bot-a') ? 'bot-a' : 'bot-b'
    return {
      status: afterCursor ? 'delta' : 'snapshot',
      afterCursor: afterCursor ?? null,
      throughCursor: `through-${botId}`,
      turns: afterCursor ? [] : [{
        source_sha256: `sha-${botId}`,
        completed_at: Date.parse('2026-09-01T01:00:00.000Z'),
        user: `${botId.toUpperCase()}_USER`,
        assistant: `${botId.toUpperCase()}_ASSISTANT`,
        truncated: false,
      }],
      page: { complete: true, nextToken: null },
    }
  }
  const { root, memory } = await fixture(observeTurns)
  const a = await memory.listMemoryCandidates({ botId: 'bot-a' })
  const b = await memory.listMemoryCandidates({ botId: 'bot-b' })
  const again = await memory.listMemoryCandidates({ botId: 'bot-a' })

  assert.equal(a.imported, 1)
  assert.match(a.items[0].assistant, /BOT-A_ASSISTANT/u)
  assert.doesNotMatch(JSON.stringify(a), /BOT-B_/u)
  assert.match(b.items[0].assistant, /BOT-B_ASSISTANT/u)
  assert.equal(again.imported, 0)
  assert.equal(calls.at(-1).afterCursor, 'through-bot-a')

  const organized = await memory.organizeMemoryCandidate({
    botId: 'bot-a', candidateId: a.items[0].id,
    memories: [
      { content: 'Aだけの長期記憶', kind: 'episode' },
      { content: '全Bot共通の方針', kind: 'policy', scope: 'shared' },
    ],
  })
  assert.equal(organized.status, 'organized')
  assert.equal((await memory.listMemoryCandidates({ botId: 'bot-a' })).items.length, 0)
  assert.equal((await memory.recallMemory({ botId: 'bot-a', query: 'Aだけの長期記憶' })).items.length, 1)
  assert.equal((await memory.recallMemory({ botId: 'bot-b', query: 'Aだけの長期記憶' })).items.length, 0)
  assert.equal((await memory.recallMemory({ botId: 'bot-b', query: '全Bot共通', scope: 'shared' })).items.length, 1)
  assert.equal((await memory.dismissMemoryCandidate({ botId: 'bot-b', candidateId: b.items[0].id })).status, 'dismissed')
  assert.equal((await memory.listMemoryCandidates({ botId: 'bot-b' })).items.length, 0)

  const aDb = new DatabaseSync(join(root, 'bots', 'bot-a', 'memory', 'memory.db'))
  assert.match(aDb.prepare(`SELECT content FROM raw_events WHERE source_ref = ?`).get(`throughline:sha-bot-a`).content, /BOT-A_USER/u)
  const resolvedCandidate = aDb.prepare(`SELECT user_text, assistant_text FROM conversation_candidates WHERE id = ?`).get(a.items[0].id)
  assert.equal(resolvedCandidate.user_text, '')
  assert.equal(resolvedCandidate.assistant_text, '')
  aDb.close()
})

test('取り込み位置は、続きのページを読み終えた位置まで進み、無効と返された時は取り直す', async () => {
  const calls = []
  const turn = name => ({
    source_sha256: `sha-${name}`, completed_at: Date.parse('2026-09-01T01:00:00.000Z'),
    user: `${name}_USER`, assistant: `${name}_ASSISTANT`, truncated: false,
  })
  const complete = { complete: true, nextToken: null }
  const pages = [
    { status: 'snapshot', throughCursor: 'through-1', turns: [turn('one')], page: complete },
    { status: 'thread_switched', throughCursor: 'through-2', turns: [turn('two')], page: { complete: false, nextToken: 'page-2' } },
    { status: 'thread_switched', throughCursor: 'through-2', turns: [turn('three')], page: complete },
    { status: 'resync_required', throughCursor: null, turns: [], page: complete },
    { status: 'snapshot', throughCursor: 'through-3', turns: [turn('four')], page: complete },
    { status: 'delta', throughCursor: 'through-3', turns: [], page: complete },
  ]
  const observeTurns = async ({ afterCursor, throughCursor, pageToken }) => {
    calls.push({ afterCursor, throughCursor, pageToken })
    return { ...pages[calls.length - 1], afterCursor: afterCursor ?? null }
  }
  const { memory } = await fixture(observeTurns)

  assert.equal((await memory.captureConversation('bot-a')).imported, 1)
  assert.equal((await memory.captureConversation('bot-a')).imported, 2)
  assert.deepEqual(await memory.captureConversation('bot-a'), { status: 'snapshot', imported: 1, resynced: true })
  assert.equal((await memory.captureConversation('bot-a')).imported, 0)
  assert.deepEqual(calls, [
    { afterCursor: null, throughCursor: null, pageToken: null },
    { afterCursor: 'through-1', throughCursor: null, pageToken: null },
    { afterCursor: 'through-1', throughCursor: 'through-2', pageToken: 'page-2' },
    { afterCursor: 'through-2', throughCursor: null, pageToken: null },
    { afterCursor: null, throughCursor: null, pageToken: null },
    { afterCursor: 'through-3', throughCursor: null, pageToken: null },
  ])
})

test('RAGはMarkdownを正本にして即時検索でき、派生DBを再構築できる', async () => {
  const { root, memory } = await fixture()
  const saved = await memory.recordKnowledge({
    botId: 'bot-a', title: '日本語検索の確認 個人RAG-識別子', content: '記憶基盤はSQLiteとMarkdownで構成する。',
    source: 'BellTeam設計', tags: ['記憶', 'RAG'], confidence: 'high',
  })
  await memory.recordKnowledge({ botId: 'bot-b', title: '別Bot知識', content: 'B_PRIVATE_KNOWLEDGE', confidence: 'medium' })
  await memory.recordKnowledge({ botId: 'bot-a', title: '共通知識', content: 'SHARED_KNOWLEDGE', scope: 'shared' })

  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: '記憶' })).items[0].id, saved.id)
  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: '個人RAG-識別子' })).items[0].id, saved.id)
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-b', query: '記憶' })).items, [])
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-a', query: 'SHARED_KNOWLEDGE' })).items, [])
  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: 'SHARED_KNOWLEDGE', scope: 'shared' })).items.length, 1)

  const markdown = await readFile(join(root, 'bots', 'bot-a', 'rag', saved.path), 'utf8')
  const index = await readFile(join(root, 'bots', 'bot-a', 'rag', 'INDEX.md'), 'utf8')
  assert.match(markdown, /source: "BellTeam設計"/u)
  assert.match(index, new RegExp(saved.id, 'u'))

  await rm(join(root, 'bots', 'bot-a', 'rag', 'index.db'), { force: true })
  assert.deepEqual(await memory.rebuildKnowledgeIndex({ botId: 'bot-a' }), { scope: 'personal', count: 1 })
  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: 'SQLite' })).items[0].id, saved.id)
})

test('全部の語を含む物が無い時は、近い物を印つきで5件まで返す', async () => {
  const { memory } = await fixture()
  const backup = await memory.recordKnowledge({
    botId: 'bot-a', title: 'バックアップの取り方', content: '毎日04:50に2本目のディスクへ取る。残すのは7日分。',
  })
  const restore = await memory.recordKnowledge({
    botId: 'bot-a', title: '戻す時の手順', content: 'DBを戻す時は席を止めてから元の場所へ置き、横のWALを消す。',
  })
  for (let index = 0; index < 6; index += 1) {
    await memory.recordKnowledge({ botId: 'bot-a', title: `検索の覚え書き${index}`, content: `検索は文字の一致で当てる。覚え書きの${index}番。` })
  }

  // 全部の語を含む文書がある時は、今までと同じ結果で、印は付かない。
  const exact = await memory.searchKnowledge({ botId: 'bot-a', query: 'バックアップ ディスク' })
  assert.deepEqual(exact.items.map(item => [item.id, item.match]), [[backup.id, undefined]])

  // 語を並べた検索で、全部はそろわない時。
  const listed = await memory.searchKnowledge({ botId: 'bot-a', query: 'バックアップ スケジュール 保持期間' })
  assert.equal(listed.items[0].id, backup.id)
  assert.equal(listed.items[0].match, 'partial')

  // 文で聞いた時。抜粋は当たった語のまわりを返す。
  const sentence = await memory.searchKnowledge({ botId: 'bot-a', query: 'WALファイルを残したままDBを復元するとどうなる？' })
  assert.equal(sentence.items[0].id, restore.id)
  assert.match(sentence.items[0].excerpt, /WAL/u)

  // 近い物は5件まで。
  const many = await memory.searchKnowledge({ botId: 'bot-a', query: '検索の覚え書きを全部読みたい' })
  assert.equal(many.items.length, 5)
  assert.ok(many.items.every(item => item.match === 'partial'))

  // どの語も当たらない時は0件のまま。
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-a', query: 'Stripe 決済 webhook' })).items, [])
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-b', query: 'バックアップ スケジュール' })).items, [])

  await memory.remember({ botId: 'bot-a', content: '申請は似た話を小分けにせず1件にまとめる', kind: 'policy', importance: 8 })
  const recalled = await memory.recallMemory({ botId: 'bot-a', query: '承認依頼 申請 分割' })
  assert.equal(recalled.items.length, 1)
  assert.equal(recalled.items[0].match, 'partial')
})
