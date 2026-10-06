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

test('ナレッジの検索はナレッジと長期記憶の両方から探し、記憶の検索は長期記憶だけを探す', async () => {
  const { memory } = await fixture()
  const note = await memory.recordKnowledge({
    botId: 'bot-a', title: 'SQLiteのWAL', content: 'WALは書き込みの控え。', source: 'https://sqlite.org/wal.html',
  })
  const episode = await memory.remember({ botId: 'bot-a', content: 'WALを消し忘れてDBを戻し直した', kind: 'episode', importance: 7 })
  const outdated = await memory.remember({ botId: 'bot-a', content: 'WALは気にしなくてよい', kind: 'fact' })
  await memory.reviseMemory({ botId: 'bot-a', id: outdated.id, content: '戻す時は横の控えを消す' })
  const other = await memory.remember({ botId: 'bot-b', content: 'WALの話は別の席の記憶', kind: 'fact' })
  const shared = await memory.remember({ botId: 'bot-a', content: 'WALの共通の決まり', kind: 'policy', scope: 'shared' })

  // ナレッジが先、長期記憶が後。改訂前の記憶は返らない。
  const found = await memory.searchKnowledge({ botId: 'bot-a', query: 'WAL' })
  assert.deepEqual(found.items.map(item => [item.id, item.source, item.match]), [
    [note.id, 'https://sqlite.org/wal.html', undefined],
    [episode.id, 'memory', undefined],
  ])
  assert.deepEqual(
    { title: found.items[1].title, kind: found.items[1].kind, importance: found.items[1].importance, excerpt: found.items[1].excerpt },
    { title: '長期記憶（episode）', kind: 'episode', importance: 7, excerpt: 'WALを消し忘れてDBを戻し直した' },
  )

  // 記憶の検索は長期記憶だけ。
  assert.deepEqual((await memory.recallMemory({ botId: 'bot-a', query: 'WAL' })).items.map(item => item.id), [episode.id])

  // 全部の語を含む物が無い時の近い物も、両方から探す。
  const near = await memory.searchKnowledge({ botId: 'bot-a', query: 'DBを戻し直した時の話を知りたい' })
  assert.deepEqual([near.items[0].id, near.items[0].source, near.items[0].match], [episode.id, 'memory', 'partial'])

  // 他の席と共通は、それぞれのナレッジと長期記憶だけ。
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-b', query: 'WAL' })).items.map(item => item.id), [other.id])
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-a', query: 'WAL', scope: 'shared' })).items.map(item => item.id), [shared.id])
})

test('ナレッジは見出しで区切った節ごとに探し、文書ごとにいちばん近い節の場所を返す', async () => {
  const { root, memory } = await fixture()
  const long = await memory.recordKnowledge({
    botId: 'bot-a',
    title: 'SQLiteの運用の覚え書き',
    tags: ['sqlite'],
    content: [
      '公式の文書から要る所を写した。',
      '',
      '## バックアップ',
      '',
      '動いている最中でも、online backup なら壊れない写しが取れる。',
      '',
      '## 戻し方',
      '',
      '### WALの扱い',
      '',
      '戻す時は、横に残った古いWALを消す。残すと本体と組み合わさって壊れる事がある。',
      '',
      '```',
      '# ここは見出しではない',
      '```',
    ].join('\n'),
  })
  await memory.recordKnowledge({ botId: 'bot-a', title: '別の覚え書き', content: '検索は文字の一致で当てる。' })

  // 1つの文書に当たる節が2つあっても、返すのは文書ごとに1件。題名に見出しが付き、抜粋はその節から取る。
  const found = await memory.searchKnowledge({ botId: 'bot-a', query: '古いWALを消す' })
  assert.deepEqual(found.items.map(item => item.id), [long.id])
  assert.equal(found.items[0].title, 'SQLiteの運用の覚え書き > 戻し方 > WALの扱い')
  assert.match(found.items[0].excerpt, /^戻す時は、横に残った古いWALを消す。/u)
  assert.equal(found.items[0].match, undefined)
  // line は、文書のファイルの中で、その節の見出しがある行。
  const lines = (await readFile(join(root, 'bots', 'bot-a', 'rag', found.items[0].path), 'utf8')).split('\n')
  assert.equal(lines[found.items[0].line - 1], '### WALの扱い')

  // 見出しより前の文は、題名だけの節になる。コードの囲みの中の # は見出しにしない。
  const lead = await memory.searchKnowledge({ botId: 'bot-a', query: '公式の文書' })
  assert.deepEqual([lead.items[0].title, lines[lead.items[0].line - 1]], ['SQLiteの運用の覚え書き', '公式の文書から要る所を写した。'])
  const fenced = await memory.searchKnowledge({ botId: 'bot-a', query: 'ここは見出しではない' })
  assert.equal(fenced.items[0].title, 'SQLiteの運用の覚え書き > 戻し方 > WALの扱い')

  // 言い方が違う問いは、近い物として返る。題名とタグの語も当たる。
  const near = await memory.searchKnowledge({ botId: 'bot-a', query: 'バックアップは稼働中でも安全？' })
  assert.deepEqual([near.items[0].title, near.items[0].match], ['SQLiteの運用の覚え書き > バックアップ', 'partial'])
  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: 'sqlite' })).items[0].id, long.id)
})

test('索引は、番号やファイル名や1文字の語でも引け、語の切り方の版が変わったら作り直す', async () => {
  const { root, memory } = await fixture()
  const ruling = await memory.remember({ botId: 'bot-a', content: '裁定 K-Z7ECDC: 長期記憶は起動時に読ませない', kind: 'policy', importance: 9 })
  const file = await memory.remember({ botId: 'bot-a', content: 'throughline.db は共有の置き場へ移した', kind: 'config' })
  const seat = await memory.remember({ botId: 'bot-a', content: '席が起き直した後に数える', kind: 'task' })

  const ids = async query => (await memory.recallMemory({ botId: 'bot-a', query })).items.map(item => [item.id, item.match])
  assert.deepEqual(await ids('K-Z7ECDC'), [[ruling.id, undefined]])
  assert.deepEqual(await ids('throughline.db'), [[file.id, undefined]])
  assert.deepEqual(await ids('席'), [[seat.id, undefined]])
  // 重要度の高い物を先に出すのは、点が同じ時だけ。近い順が先。
  assert.deepEqual(await ids('長期記憶 起動時'), [[ruling.id, undefined]])
  assert.deepEqual(await ids('起動時にロードする案'), [[ruling.id, 'partial']])

  // 版の印を書き換えると、次の検索で索引を作り直す。結果は同じ。
  const dbPath = join(root, 'bots', 'bot-a', 'memory', 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE index_state SET value = 'old' WHERE key = 'version'").run()
  db.exec("DELETE FROM memory_index; INSERT INTO memory_index (rowid, words, pairs) VALUES (999, '古い 切り方', '古い 切り')")
  db.close()
  assert.deepEqual(await ids('K-Z7ECDC'), [[ruling.id, undefined]])
  const rebuilt = new DatabaseSync(dbPath)
  assert.equal(rebuilt.prepare('SELECT count(*) AS count FROM memory_index').get().count, 3)
  assert.notEqual(rebuilt.prepare("SELECT value FROM index_state WHERE key = 'version'").get().value, 'old')
  rebuilt.close()

  // ナレッジの索引は、文書を作り直した時（rebuildKnowledgeIndex）にも入れ直す。
  const note = await memory.recordKnowledge({ botId: 'bot-a', title: '反映の手順', content: '## 確かめ\n\n割り当てを見る。' })
  assert.equal((await memory.searchKnowledge({ botId: 'bot-a', query: '割り当て' })).items[0].title, '反映の手順 > 確かめ')
  await memory.rebuildKnowledgeIndex({ botId: 'bot-a' })
  assert.deepEqual((await memory.searchKnowledge({ botId: 'bot-a', query: '割り当て' })).items.map(item => item.id), [note.id])
})

test('索引へ入れる途中で失敗した時は、入れかけの分を残さない', async () => {
  const { root, memory } = await fixture()
  const first = await memory.recordKnowledge({ botId: 'bot-a', title: '反映の手順', content: '割り当てを見る。' })
  const second = await memory.recordKnowledge({ botId: 'bot-a', title: '戻す手順', content: '割り当てを戻す。' })
  const dbPath = join(root, 'bots', 'bot-a', 'rag', 'index.db')

  // 2つ目の文書のタグを読めない形にして、1つ目を入れた後で失敗させる。
  const broken = new DatabaseSync(dbPath)
  broken.prepare("UPDATE documents SET tags = '{' WHERE id = ?").run(second.id)
  broken.close()
  await assert.rejects(memory.searchKnowledge({ botId: 'bot-a', query: '割り当て' }))
  const half = new DatabaseSync(dbPath)
  assert.equal(half.prepare('SELECT count(*) AS count FROM sections').get().count, 0)
  assert.equal(half.prepare('SELECT count(*) AS count FROM section_index').get().count, 0)
  assert.equal(half.prepare('SELECT count(*) AS count FROM index_state').get().count, 0)
  half.prepare("UPDATE documents SET tags = '[]' WHERE id = ?").run(second.id)
  half.close()

  // 直すと、次の検索で2つとも入る。
  const found = await memory.searchKnowledge({ botId: 'bot-a', query: '割り当て' })
  assert.deepEqual(found.items.map(item => item.id).sort(), [first.id, second.id].sort())
})
