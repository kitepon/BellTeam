import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MachineStream, WINDOW_RECORDS } from '../src/machine-stream.mjs'
import { TimelineIndex, timelinePage } from '../src/timeline-index.mjs'
import { createMessageViews } from '../src/http-messages.mjs'

// heap-oom-n102-machine-stream-window: a window of a few records must give the very pages a Bot that holds its whole log gives.
const bots = new Map([['bot-d', { id: 'bot-d', name: 'ドリリー' }]])
const J = value => JSON.stringify(value)
const defaults = (await import('../src/machine-display-rules.json', { with: { type: 'json' } })).default
const keepAll = { ...defaults, omit: [] }
const Q = [{ header: 'H', question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]
const ask = id => J({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: Q } } })
const tool = id => J({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `echo ${id}` } } })
const call = (id, name = 'Bash') => J({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { command: `run ${id}` } }] } })
const back = id => J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id}` }] } })
const words = text => J({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const thinking = text => J({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } })
const hook = subtype => J({ type: 'system', subtype, hook_name: 'Stop' })
const pending = (...ids) => ({ state: 'blocked', reason: null, pending: ids.map(request_id => ({ request_id, subtype: 'can_use_tool', tool_name: 'x' })) })
const idle = { state: 'busy', reason: null, pending: [] }

// The same 40 turns for every instance: tool runs of every length (one of 30 calls with no words between), cards answered / expired / answered by the seat.
async function story(ms) {
  let cursor = null, n = 0
  const send = async (lines, state = idle) => { const after = `L1:${++n}`; await ms.ingest({ botId: 'bot-d', session: 's', launch_id: 'L1', cursor_from: cursor, cursor_after: after, lines, state }); cursor = after }
  for (let turn = 0; turn < 40; turn++) {
    await send([J({ type: 'system', subtype: 'init', model: 'm' }), hook('hook_started'), thinking(`think ${turn}`), words(`turn ${turn}`)])
    const calls = turn === 13 ? 30 : 1 + (turn % 4)
    for (let c = 0; c < calls; c++) await send([call(`t${turn}-${c}`), hook('hook_response'), back(`t${turn}-${c}`), J({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })])
    if (turn % 7 === 3) { await send([ask(`q${turn}`)], pending(`q${turn}`)); await ms.answer(`q${turn}`, { answers: [{ indexes: [1], other: null }] }) }
    if (turn % 11 === 5) { await send([tool(`a${turn}`)], pending(`a${turn}`)); await send([hook('hook_started')]) } // the seat took it away: expired
    if (turn % 5 === 2) await send([tool(`p${turn}`)]) // not listed by state: answered by the seat itself, a folded line
    await send([J({ type: 'result', subtype: 'success', duration_ms: 1000 })])
  }
}

async function open(t, { window, rules, thinking = true, root = null, load = false }) {
  root ??= await mkdtemp(join(tmpdir(), 'bellteam-machine-window-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let tick = 0
  const ms = new MachineStream({ root, bots, rules, window, showThinking: () => thinking, streamSend: async () => ({ accepted: true }), now: () => new Date(Date.UTC(2026, 10, 20, 0, 0, tick++)).toISOString() })
  await ms.initialize({ readOnly: load })
  return { ms, root }
}

// What the child does with the rows of the machine source (the other sources are empty here).
async function walk(ms, limit) {
  const ids = [], pages = []
  let url = new URL(`http://x/?limit=${limit}`)
  for (;;) {
    const query = Object.fromEntries(['limit', 'before'].map(key => [key, url.searchParams.get(key)]))
    const { rows, skipped } = await ms.page('bot-d', { ...query, hint: url.searchParams.get('before_at') })
    const page = timelinePage([new TimelineIndex(rows)], url, skipped)
    pages.push(page.items.map(item => item.id)) // an empty last page is allowed: skipped counts stored records, an upper bound of rows
    ids.unshift(...page.items)
    if (!page.has_more || !page.items.length) break
    url = new URL(`http://x/?limit=${limit}&before=${page.items[0].id}&before_at=${encodeURIComponent(page.items[0].at)}`)
  }
  return { ids, pages: pages.filter(page => page.length) }
}

for (const [name, rules] of [['default table (omits background rows)', defaults], ['a table that omits nothing', keepAll]]) {
  for (const hidden of [false, true]) {
    test(`a window of 6 records gives the pages of the whole log: ${name}${hidden ? ', thinking hidden' : ''}`, async t => {
      const whole = await open(t, { window: 1e9, rules, thinking: !hidden })
      await story(whole.ms)
      const bot = whole.ms.state.get('bot-d')
      assert.equal(bot.floor, 0)
      const loaded = await open(t, { window: 6, rules, thinking: !hidden, root: whole.root, load: true }) // read from the file end
      const live = await open(t, { window: 6, rules, thinking: !hidden }) // trims while it ingests
      await story(live.ms)
      const reference = (await walk(whole.ms, 7)).ids
      assert.ok(reference.length > 100, `${reference.length} rows`)
      for (const [label, other] of [['loaded', loaded.ms], ['live', live.ms]]) {
        assert.ok(other.state.get('bot-d').floor > 0, `${label} holds a window`)
        for (const limit of [1, 7, 50, 1000]) {
          const got = await walk(other, limit), expected = await walk(whole.ms, limit)
          const at = expected.ids.findIndex((row, i) => J(row) !== J(got.ids[i]))
          assert.ok(at < 0 && got.ids.length === expected.ids.length, `${label} limit ${limit}: differs at ${at} of ${expected.ids.length}/${got.ids.length}: expected ${J(expected.ids[at])} got ${J(got.ids[at])}`)
          const bad = expected.pages.findIndex((page, i) => J(page) !== J(got.pages[i]))
          assert.ok(bad < 0 && got.pages.length === expected.pages.length, `${label} limit ${limit}: pages differ at ${bad} of ${expected.pages.length}/${got.pages.length}: expected ${J(expected.pages[bad])} got ${J(got.pages[bad])}`)
        }
      }
      // memory is bounded: the window, not the log
      for (const ms of [loaded.ms, live.ms]) {
        const held = ms.state.get('bot-d')
        assert.ok(held.seq - held.floor <= 200, `records in memory ${held.seq - held.floor} of ${held.seq}`) // the window, or the run of lines up to the reset record that starts it
        assert.ok(held.rows.length <= reference.length / 2, `${held.rows.length} rows of ${reference.length}`)
        assert.ok([...held.requests.values()].every(request => request.seq > held.floor || request.status !== 'auto'), 'no auto request below the window')
        assert.ok(held.folds.size <= 24, `${held.folds.size} folds`)
      }
      // the rows after a known row (a refresh) and the newest rows come from the window
      const newest = (await walk(live.ms, 3)).ids.at(-1)
      const refresh = await live.ms.page('bot-d', { limit: 10, after: reference.at(-4).id, hint: reference.at(-4).at })
      assert.deepEqual(refresh.rows.map(r => r.id).slice(-3), reference.slice(-3).map(r => r.id))
      assert.equal(newest.id, reference.at(-1).id)
    })
  }
}

test('line and rowSource read below the window from the file; the answer to an old card keeps its answers and a card pending then reads expired', async t => {
  const whole = await open(t, { window: 1e9, rules: keepAll })
  await story(whole.ms)
  const loaded = await open(t, { window: 6, rules: keepAll, root: whole.root, load: true })
  const bot = loaded.ms.state.get('bot-d')
  const rows = whole.ms.timeline({ botId: 'bot-d' })
  for (const row of rows.filter((_row, i) => i % 9 === 0)) {
    assert.deepEqual(await loaded.ms.line('bot-d', row.machine_event.seq), await whole.ms.line('bot-d', row.machine_event.seq))
    assert.deepEqual(await loaded.ms.rowSource('bot-d', row.id), await whole.ms.rowSource('bot-d', row.id), row.id)
  }
  await assert.rejects(loaded.ms.line('bot-d', 99999), { code: 'MACHINE_EVENT_NOT_FOUND' })
  assert.equal(await loaded.ms.rowSource('bot-d', 'me-999999-0'), null)
  const cards = rows.filter(r => r.machine_event.request && r.machine_event.seq <= bot.floor)
  assert.ok(cards.length >= 3)
  const old = (await walk(loaded.ms, 1000)).ids.filter(r => r.machine_event.request)
  assert.deepEqual(old.map(r => [r.id, r.machine_event.request.status, r.machine_event.request.answers]), rows.filter(r => r.machine_event.request).map(r => [r.id, r.machine_event.request.status, r.machine_event.request.answers]))
  assert.ok(old.some(r => r.machine_event.request.status === 'answered' && r.machine_event.request.answers))
  assert.ok(old.some(r => r.machine_event.request.status === 'expired'))
  // a closed card below the window cannot be answered again
  await assert.rejects(loaded.ms.answer('q3', { answers: [{ indexes: [1], other: null }] }), { code: 'SEAT_REQUEST_CLOSED' })
})

test('a page with a cursor that is not a machine row reads the file by the hint time', async t => {
  const whole = await open(t, { window: 1e9, rules: keepAll })
  await story(whole.ms)
  const loaded = await open(t, { window: 6, rules: keepAll, root: whole.root, load: true })
  const rows = whole.ms.timeline({ botId: 'bot-d' }), middle = rows[Math.floor(rows.length / 2)]
  const ask = ms => ms.page('bot-d', { limit: 20, before: 'some-saved-message', hint: middle.at })
  const [a, b] = [await ask(whole.ms), await ask(loaded.ms)]
  const page = rs => timelinePage([new TimelineIndex([{ id: 'some-saved-message', at: middle.at }]), new TimelineIndex(rs.rows)], new URL('http://x/?limit=20&before=some-saved-message'), rs.skipped)
  assert.deepEqual(page(b).items.map(i => i.id), page(a).items.map(i => i.id))
  assert.equal(page(b).has_more, page(a).has_more)
})

test('the Bot page (createMessageViews) serves a machine seat below its window through messagePage', async t => {
  const whole = await open(t, { window: 1e9, rules: defaults })
  await story(whole.ms)
  const loaded = await open(t, { window: 6, rules: defaults, root: whole.root, load: true })
  const pageOf = async ms => {
    const store = { messagePage: async ({ query, cards, skipped }) => {
      const sources = [new TimelineIndex([]), ...cards.map(rows => new TimelineIndex(rows))]
      const url = new URL(`http://x/?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null))}`)
      const page = timelinePage(sources, url, skipped.reduce((a, b) => a + b, 0))
      const seen = new Map(); cards.forEach((rows, i) => rows.forEach((row, index) => seen.set(row.id, { source: i + 1, index })))
      return { ...page, items: page.items.map(item => seen.get(item.id) ?? { source: 0, item }) }
    } }
    const { messagePage } = createMessageViews({ rooms: null, store, secretRequests: null, ownerQuestions: null, machineStream: ms })
    const out = []
    let before = null
    for (;;) {
      const page = await messagePage('bots', 'bot-d', new URL(`http://x/?limit=40${before ? `&before=${before.id}&before_at=${encodeURIComponent(before.at)}` : ''}`))
      out.unshift(...page.items.map(i => i.id))
      if (!page.has_more) return out
      before = page.items[0]
    }
  }
  const expected = await pageOf(whole.ms)
  assert.ok(expected.length > 40)
  assert.deepEqual(await pageOf(loaded.ms), expected)
})

test('the file is read from its end: a log far larger than the window loads only the window', async t => {
  const whole = await open(t, { window: 1e9, rules: defaults })
  await story(whole.ms)
  const total = whole.ms.state.get('bot-d').seq
  const loaded = await open(t, { window: 50, rules: defaults, root: whole.root, load: true })
  const bot = loaded.ms.state.get('bot-d')
  assert.equal(bot.seq, total)
  assert.ok(bot.seq - bot.floor >= 50 && bot.seq - bot.floor < total / 2, `${bot.seq - bot.floor} of ${total} records in memory`)
  assert.deepEqual(loaded.ms.cursor('bot-d'), whole.ms.cursor('bot-d'))
  assert.equal(WINDOW_RECORDS, 2000)
})

test('a torn end of the file (a batch without its cursor, then half a line) is cut as before, with a small window too', async t => {
  const whole = await open(t, { window: 1e9, rules: keepAll })
  await story(whole.ms)
  const bot = whole.ms.state.get('bot-d'), good = { seq: bot.seq, cursor: whole.ms.cursor('bot-d') }
  const { appendFile } = await import('node:fs/promises')
  const path = join(whole.root, 'state/machine-stream/bot-d.jsonl')
  await appendFile(path, [1, 2].map(i => J({ seq: good.seq + i, type: 'line', at: '2026-11-20T01:00:00.000Z', session: 's', launch_id: 'L1', cursor_after: null, line: words('torn') })).join('\n') + '\n{"seq":9999,"type":"line","at":"2026')
  for (const window of [1e9, 6]) {
    const loaded = await open(t, { window, rules: keepAll, root: whole.root, load: true })
    const held = loaded.ms.state.get('bot-d')
    assert.equal(held.seq, good.seq, `window ${window}`)
    assert.deepEqual(loaded.ms.cursor('bot-d'), good.cursor)
    assert.equal(held.rows.at(-1).id, bot.rows.at(-1).id)
  }
})

test('an empty log file and a Bot with no file load without a window', async t => {
  const { root } = await open(t, { window: 6, rules: keepAll })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'state/machine-stream/bot-d.jsonl'), '')
  const { ms } = await open(t, { window: 6, rules: keepAll, root, load: true })
  assert.equal(ms.state.get('bot-d').seq, 0)
  assert.deepEqual(await ms.page('bot-d', { limit: 10 }), { rows: [], skipped: 0 })
  assert.deepEqual(await ms.page('bot-x', { limit: 10 }), { rows: [], skipped: 0 })
})
