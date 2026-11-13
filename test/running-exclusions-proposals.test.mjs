import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunningExclusions, readRunningExclusions } from '../src/running-exclusions.mjs'
import { callRunningExclusionTool } from '../src/running-exclusions-mcp.mjs'

// a41 PR 2 (execution current-work.md "proposal"/"answer"): a Bot only proposes; only the Owner's approve writes.
function fakeDecisions() {
  const filed = [], answers = new Map()
  return { filed, answers, file: async params => { filed.push(params); return { decisionId: `K-${filed.length}`, existing: false } },
    read: async ({ decisionId }) => answers.get(decisionId) ?? { status: 'pending' } }
}
const registry = { get: id => ({ b1: { id: 'b1', name: 'キロ' }, b2: { id: 'b2', name: 'エレグ' } })[id] ?? null }

test('add: one decision, deduped while pending, written only on approve; reject drops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'state', 'x.json')
  try {
    const decisions = fakeDecisions(), list = createRunningExclusions({ path, decisions, now: () => '2026-11-13T03:00:00.000Z' })
    const call = args => callRunningExclusionTool({ name: 'propose_running_exclusion', args, from: 'b1', registry, runningExclusions: list })
    assert.deepEqual(await call({ kind: 'process', exe: 'node', args: ['vite.js', 'dev'], reason: '開発用サーバー' }), { status: 'filed', decisionId: 'K-1' })
    assert.match(decisions.filed[0].title, /「node vite\.js dev」を、キロで稼働中に数えないようにしていいですか？/)
    assert.deepEqual(decisions.filed[0].options.map(option => option.id), ['approve', 'reject'])
    assert.match(decisions.filed[0].session_label, /^running-exclusions:[0-9a-f]{32}$/)
    assert.deepEqual(await call({ kind: 'process', exe: 'node', args: ['vite.js', 'dev'], reason: 'again' }), { status: 'pending', decisionId: 'K-1' })
    assert.equal(decisions.filed.length, 1, 'no second decision for the same proposal')
    assert.deepEqual(await readRunningExclusions(path), [], 'nothing listed before the answer')
    assert.equal(await list.poll(), 0)
    decisions.answers.set('K-1', { status: 'answered', answer: { optionId: 'approve' } })
    assert.equal(await list.poll(), 1)
    const [entry] = await readRunningExclusions(path)
    assert.deepEqual({ ...entry, id: 'x' }, { kind: 'process', exe: 'node', args: ['vite.js', 'dev'], scope: ['b1'], id: 'x',
      decisionId: 'K-1', approvedAt: '2026-11-13T03:00:00.000Z', reason: '開発用サーバー' })
    assert.equal((await call({ kind: 'process', exe: 'node', args: ['vite.js', 'dev'], reason: 'x' })).status, 'listed')
    // A reject (or free text) drops the proposal and writes nothing.
    assert.equal((await call({ kind: 'process', exe: 'python', args: [], allBots: true, reason: 'y' })).decisionId, 'K-2')
    assert.match(decisions.filed[1].context, /「python」で動くすべての処理が対象/)
    decisions.answers.set('K-2', { status: 'answered', answer: { text: 'だめ' } })
    assert.equal(await list.poll(), 0)
    assert.equal((await list.list()).pending.length, 0)
    assert.equal((await readRunningExclusions(path)).length, 1)
    // Removal is a decision too.
    assert.deepEqual(await callRunningExclusionTool({ name: 'propose_running_exclusion_removal', args: { id: entry.id, reason: '終わった' }, from: 'b2', registry, runningExclusions: list }),
      { status: 'filed', decisionId: 'K-3' })
    assert.match(decisions.filed[2].context, /エレグからの申請です/)
    decisions.answers.set('K-3', { status: 'answered', answer: { optionId: 'approve' } })
    assert.equal(await list.poll(), 1)
    assert.deepEqual(await readRunningExclusions(path), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('connector down keeps every pending proposal; an unreadable file is never rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const decisions = fakeDecisions(), list = createRunningExclusions({ path, decisions })
    await list.propose({ action: 'add', entry: { kind: 'child', harness: 'codex-cli', session: null, scope: 'all' }, reason: 'r', from: 'b1', requester: 'キロ', who: 'すべての Bot' })
    decisions.read = async () => { throw Object.assign(new Error('down'), { code: 'RUNNING_EXCLUSION_DECISIONS_UNAVAILABLE' }) }
    assert.equal(await list.poll(), 0)
    assert.equal((await list.list()).pending.length, 1)
    await writeFile(path, '{"schema":"broken"')
    await assert.rejects(list.poll(), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })
    assert.equal(await readFile(path, 'utf8'), '{"schema":"broken"', 'left as found')
    await assert.rejects(list.propose({ action: 'add', entry: { kind: 'process', exe: 'a b', args: [], scope: 'all' }, reason: 'r' }), { code: 'RUNNING_EXCLUSION_INVALID' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the writer never exceeds the 256 entries the engine reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const entries = Array.from({ length: 256 }, (_, i) => ({ id: `e${i}`, kind: 'process', exe: `p${i}`, args: [], scope: 'all' }))
    await writeFile(path, JSON.stringify({ schema: 'bellteam.running-exclusions.v1', entries }))
    const list = createRunningExclusions({ path, decisions: fakeDecisions() })
    await assert.rejects(list.propose({ action: 'add', entry: { kind: 'process', exe: 'q', args: [], scope: 'all' }, reason: 'r' }), { code: 'RUNNING_EXCLUSION_INVALID' })
    assert.equal((await readRunningExclusions(path)).length, 256)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
