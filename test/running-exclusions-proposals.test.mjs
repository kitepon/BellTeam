import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunningExclusions, readRunningExclusions } from '../src/running-exclusions.mjs'
import { callRunningExclusionTool } from '../src/running-exclusions-mcp.mjs'

// a41 PR 2 (execution current-work.md "proposal"/"answer"): a Bot only proposes; only the Owner's approve writes.
// Like the real factory: a known session_label returns its decision in ANY status; lose=true creates it but loses the answer.
function fakeDecisions() {
  const filed = [], answers = new Map(), byLabel = new Map()
  const self = { filed, answers, byLabel, lose: false,
    file: async params => {
      if (byLabel.has(params.session_label)) return { decisionId: byLabel.get(params.session_label), existing: true }
      filed.push(params); const decisionId = `K-${filed.length}`; byLabel.set(params.session_label, decisionId)
      if (self.lose) throw Object.assign(new Error('lost'), { code: 'RUNNING_EXCLUSION_DECISIONS_UNAVAILABLE' })
      return { decisionId, existing: false } },
    read: async ({ decisionId }) => answers.get(decisionId) ?? { status: 'pending' } }
  return self
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
    assert.match(decisions.filed[0].session_label, /^running-exclusions:[0-9a-f-]{36}$/)
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

const approve = { status: 'answered', answer: { optionId: 'approve' } }
const vite = { kind: 'process', exe: 'node', args: ['vite.js', 'dev'], scope: ['b1'] }
const ask = (list, entry = vite) => list.propose({ action: 'add', entry, reason: 'r', from: 'b1', requester: 'キロ', who: 'キロ' })

test('a new proposal never reuses an old answer: re-add after removal, and after a reject, needs a new decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const decisions = fakeDecisions(), list = createRunningExclusions({ path, decisions })
    assert.equal((await ask(list)).decisionId, 'K-1'); decisions.answers.set('K-1', approve); assert.equal(await list.poll(), 1)
    const [entry] = await readRunningExclusions(path)
    assert.equal((await list.propose({ action: 'remove', id: entry.id, reason: 'r', requester: 'キロ', who: 'キロ' })).decisionId, 'K-2')
    decisions.answers.set('K-2', approve); assert.equal(await list.poll(), 1)
    assert.deepEqual(await ask(list), { status: 'filed', decisionId: 'K-3' }, 'not the old approved K-1')
    assert.equal(await list.poll(), 0); assert.deepEqual(await readRunningExclusions(path), [])
    decisions.answers.set('K-3', { status: 'answered', answer: { optionId: 'reject' } }); assert.equal(await list.poll(), 0)
    assert.deepEqual(await ask(list), { status: 'filed', decisionId: 'K-4' }, 'not the old rejected K-3')
    assert.equal(new Set(decisions.filed.map(item => item.session_label)).size, 4)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('unknown filing outcome: stored before filing, a restarted body files the SAME label and adopts the decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const decisions = fakeDecisions(); decisions.lose = true
    await assert.rejects(ask(createRunningExclusions({ path, decisions })), { code: 'RUNNING_EXCLUSION_DECISIONS_UNAVAILABLE' })
    const stored = JSON.parse(await readFile(path, 'utf8')).pending
    assert.equal(stored.length, 1); assert.equal(stored[0].decisionId, null); assert.equal(stored[0].entry.exe, 'node')
    decisions.lose = false
    const restarted = createRunningExclusions({ path, decisions })
    assert.equal(await restarted.poll(), 0)
    assert.equal(decisions.filed.length, 1, 'no second decision')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pending[0].decisionId, 'K-1')
    assert.deepEqual(await ask(restarted), { status: 'pending', decisionId: 'K-1' })
    decisions.answers.set('K-1', approve); assert.equal(await restarted.poll(), 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('full list: pending duplicate first, approved add waits unapplied until a removal makes room; invalid stores are left as found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const decisions = fakeDecisions(), list = createRunningExclusions({ path, decisions })
    const entries = Array.from({ length: 255 }, (_, i) => ({ id: `e${i}`, kind: 'process', exe: `p${i}`, args: [], scope: 'all' }))
    await writeFile(path, JSON.stringify({ schema: 'bellteam.running-exclusions.v1', entries }))
    assert.equal((await ask(list)).decisionId, 'K-1')
    assert.equal((await ask(list, { ...vite, exe: 'deno' })).decisionId, 'K-2')
    decisions.answers.set('K-1', approve); decisions.answers.set('K-2', approve)
    assert.equal(await list.poll(), 1, 'only one fits')
    assert.equal((await readRunningExclusions(path)).length, 256)
    assert.deepEqual(await ask(list, { ...vite, exe: 'deno' }), { status: 'pending', decisionId: 'K-2' }, 'pending duplicate before the cap refusal')
    assert.equal((await list.list()).pending[0].approved, true)
    decisions.read = async () => { throw new Error('approved items are not read again') }
    assert.equal(await list.poll(), 0)
    decisions.read = async ({ decisionId }) => decisions.answers.get(decisionId) ?? { status: 'pending' }
    assert.equal((await list.propose({ action: 'remove', id: 'e0', reason: 'r', requester: 'キロ', who: 'キロ' })).decisionId, 'K-3')
    decisions.answers.set('K-3', approve)
    assert.equal(await list.poll(), 2, 'removal, then the waiting addition')
    assert.ok((await readRunningExclusions(path)).some(entry => entry.exe === 'deno'))
    assert.equal((await list.list()).pending.length, 0)
    for (const bad of [
      { schema: 'bellteam.running-exclusions.v1', entries: [entries[0], entries[0]] },
      { schema: 'bellteam.running-exclusions.v1', entries: [...entries, ...entries].map((entry, i) => ({ ...entry, id: `d${i}` })) },
      { schema: 'bellteam.running-exclusions.v1', entries: [], pending: [{ label: 'x' }] },
      { schema: 'bellteam.running-exclusions.v1', entries: [], pending: {} }]) {
      await writeFile(path, JSON.stringify(bad))
      await assert.rejects(list.poll(), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })
      await assert.rejects(ask(list), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), bad, 'left as found')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a pending item the poll or a re-filing would misuse makes the store unreadable (503) and is never rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-')), path = join(dir, 'x.json')
  try {
    const decisions = fakeDecisions(), list = createRunningExclusions({ path, decisions })
    await ask(list)
    const good = JSON.parse(await readFile(path, 'utf8'))
    const [item] = good.pending
    for (const bad of [{ approved: 'false' }, { approved: true, decisionId: null }, { key: 'add:other' }, { action: 'remove' },
      { decisionId: '' }, { label: '' }, { decision: { title: item.decision.title, requester: 'キロ' } },
      { decision: { title: item.decision.title, context: item.decision.context } }, { reason: undefined }]) {
      const store = JSON.stringify({ ...good, pending: [{ ...item, ...bad }] })
      await writeFile(path, store)
      decisions.answers.set('K-1', approve)
      await assert.rejects(list.poll(), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE' }, JSON.stringify(bad))
      await assert.rejects(list.list(), { code: 'RUNNING_EXCLUSIONS_UNAVAILABLE' })
      assert.equal(await readFile(path, 'utf8'), store, 'left as found')
    }
    await writeFile(path, JSON.stringify({ ...good, pending: [{ ...item, approved: false }] }))
    assert.equal(await list.poll(), 1, 'a well-formed item still applies')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
