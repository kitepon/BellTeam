import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { BellTeamMemory } from '../src/memory-service.mjs'

async function fixture(observeTurns = async ({ afterCursor }) => ({
  status: afterCursor ? 'delta' : 'snapshot',
  afterCursor: afterCursor ?? 'cursor-empty',
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
  assert.equal((await memory.recallMemory({ botId: 'bot-a', query: '想像で補ってしまう' })).items.length, 0)
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
      afterCursor: `cursor-${botId}`,
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
  assert.equal(calls.at(-1).afterCursor, 'cursor-bot-a')

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
