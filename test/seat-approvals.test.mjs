import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSeatApprovals, maskSecrets } from '../src/seat-approvals.mjs'
import { createSeatApprovalsApi } from '../src/http-seat-approvals-api.mjs'

const digest = char => `sha256:${char.repeat(64)}`
async function fixture(t, { paired = true, harness = 'claude', fileFails = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seat-approvals-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bot = { id: 'bot-aaaa1111', name: 'テスト', harness }
  const bots = new Map([[bot.id, bot]])
  const seat = { inspect: { status: 'none' }, working: true, responses: [], respondError: null }
  const transport = {
    currentWork: () => ({ state: seat.working ? 'working' : 'idle' }),
    screenApproval: async (_bot, request) => {
      if (request.action === 'inspect') return seat.inspect
      if (seat.respondError) throw seat.respondError
      seat.responses.push(request)
      return { status: 'submitted', decision: request.decision }
    },
  }
  const cards = { filed: [], cancelled: [], answers: new Map() }
  const decisions = {
    file: async params => { if (fileFails) throw new Error('down'); cards.filed.push(params); return { decisionId: 'card-1', existing: false } },
    read: async ({ decisionId }) => cards.answers.get(decisionId) ?? { status: 'pending' },
    cancel: async ({ decisionId, reason }) => { cards.cancelled.push({ decisionId, reason }); return { status: 'cancelled' } },
  }
  const pushes = []
  const make = () => createSeatApprovals({ path: join(dir, 'seat-approvals.json'), bots, transport, decisions,
    daemon: { status: () => ({ daemon: { mode: paired ? 'pc' : 'off' } }) }, push: { seatApproval: item => pushes.push(item) },
    machineStream: { pendingApprovals: () => [{ id: 'r1', tool: 'Bash', command: 'rm -rf /tmp/x TOKEN=abc123456789' }] }, now: () => 1_700_000_000_000 })
  return { seatApprovals: make(), make, seat, cards, pushes, bot }
}
const prompt = (char = 'a') => ({ status: 'approval_required', promptDigest: digest(char), choices: [{ decision: 'approve_once', label: 'Yes' }, { decision: 'deny', label: 'No' }] })

test('secrets in the command are masked before anything is stored or filed', () => {
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abcdefgh12345678" x'), 'curl -H "Authorization: Bearer ***" x')
  assert.equal(maskSecrets('API_TOKEN=abc123 ls'), 'API_TOKEN=*** ls')
  assert.equal(maskSecrets('git push https://x --password hunter2'), 'git push https://x --password ***')
  assert.equal(maskSecrets('echo ghp_abcdefghijklmnop1234'), 'echo ***')
  assert.equal(maskSecrets('rm -rf ./build'), 'rm -rf ./build')
})

test('a blocked seat opens one entry and one card; the same prompt again is the same entry; no push when a card was filed', async t => {
  const { seatApprovals, seat, cards, pushes } = await fixture(t)
  seat.inspect = prompt()
  await seatApprovals.tick(); await seatApprovals.tick()
  const [entry, ...rest] = (await seatApprovals.list())
  assert.equal(rest.length, 0)
  assert.deepEqual({ botName: entry.botName, tool: entry.tool, card: entry.card, choices: entry.choices.map(c => c.decision) },
    { botName: 'テスト', tool: 'Bash', card: 'filed', choices: ['approve_once', 'deny'] })
  assert.ok(entry.command.includes('TOKEN=***') && !entry.command.includes('abc123456789'))
  assert.equal(cards.filed.length, 1)
  assert.match(cards.filed[0].session_label, /^Seat bot-aaaa1111 aaaaaaaaaaaaaaaa \d+$/u)
  assert.deepEqual(cards.filed[0].options.map(o => o.id), ['approve_once', 'deny'])
  assert.equal(pushes.length, 0)
})

test('an unpaired daemon or a failed file() leaves the in-app entry and sends one push', async t => {
  for (const options of [{ paired: false }, { fileFails: true }]) {
    const { seatApprovals, seat, cards, pushes } = await fixture(t, options)
    seat.inspect = prompt()
    await seatApprovals.tick(); await seatApprovals.tick()
    assert.equal((await seatApprovals.list())[0].card, 'none')
    assert.equal(cards.filed.length, 0)
    assert.equal(pushes.length, 1)
  }
})

test('the first answer wins: respond carries the stored digest, the card is withdrawn, a second answer is closed', async t => {
  const { seatApprovals, seat, cards } = await fixture(t)
  seat.inspect = prompt()
  await seatApprovals.tick()
  const [{ id }] = await seatApprovals.list()
  assert.deepEqual(await seatApprovals.answer(id, 'approve_once'), { id, status: 'answered', decision: 'approve_once' })
  assert.deepEqual(seat.responses, [{ action: 'respond', decision: 'approve_once', promptDigest: digest('a') }])
  assert.deepEqual(cards.cancelled, [{ decisionId: 'card-1', reason: 'BellTeamの画面で答えられました。' }])
  await assert.rejects(seatApprovals.answer(id, 'deny'), { code: 'SEAT_APPROVAL_CLOSED', status: 409 })
  await assert.rejects(seatApprovals.answer('sa-nope', 'deny'), { code: 'SEAT_APPROVAL_NOT_FOUND', status: 404 })
  assert.deepEqual(await seatApprovals.list(), [])
})

test('the card answer is applied to the same prompt; free text counts as deny; a stale prompt receives nothing more', async t => {
  const { seatApprovals, seat, cards } = await fixture(t)
  seat.inspect = prompt()
  await seatApprovals.tick()
  cards.answers.set('card-1', { status: 'answered', answer: { optionId: 'approve_once' } })
  await seatApprovals.tick()
  assert.deepEqual(seat.responses.map(r => r.decision), ['approve_once'])
  assert.deepEqual(cards.cancelled, []) // answered on the card: nothing to withdraw
  seat.inspect = prompt('b')
  await seatApprovals.tick()
  cards.answers.set('card-1', { status: 'answered', answer: { text: 'maybe' } })
  seat.respondError = Object.assign(new Error('changed'), { code: 'SCREEN_APPROVAL_CHANGED', status: 409 })
  await seatApprovals.tick()
  assert.deepEqual(seat.responses.map(r => r.decision), ['approve_once']) // the stale respond reached Aiterm's refusal only
  assert.deepEqual(await seatApprovals.list(), [])
})

test('a prompt that is gone, or another digest, closes the entry and withdraws the card; a stopped seat too', async t => {
  const { seatApprovals, seat, cards } = await fixture(t)
  seat.inspect = prompt()
  await seatApprovals.tick()
  seat.inspect = { status: 'none' }
  await seatApprovals.tick()
  assert.deepEqual(await seatApprovals.list(), [])
  assert.equal(cards.cancelled.length, 1)
  seat.inspect = prompt('c')
  await seatApprovals.tick()
  seat.working = false
  await seatApprovals.tick()
  assert.deepEqual(await seatApprovals.list(), [])
  assert.equal(cards.cancelled.length, 2)
})

test('a restart keeps the record and files nothing twice; a Codex prompt carries its own text', async t => {
  const { seatApprovals, make, seat, cards } = await fixture(t, { harness: 'codex' })
  seat.inspect = { ...prompt(), prompt: 'Run: npm test', kind: 'command_approval' }
  await seatApprovals.tick()
  const [before] = await seatApprovals.list()
  assert.equal(before.command, 'Run: npm test')
  assert.equal(before.tool, 'command_approval')
  const again = make()
  assert.deepEqual((await again.list()).map(e => e.id), [before.id])
  await again.tick()
  assert.equal(cards.filed.length, 1)
})

test('the API is Owner only and maps the closed and invalid answers', async t => {
  const { seatApprovals, seat } = await fixture(t)
  seat.inspect = prompt()
  await seatApprovals.tick()
  const [{ id }] = await seatApprovals.list()
  const call = async (internal, method, path, body) => {
    const response = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code }, end(text) { this.body = text } }
    const request = { method, headers: {}, on() {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const handled = await createSeatApprovalsApi({ seatApprovals, internal })(request, response, new URL(`http://x${path}`))
    return { handled, status: response.statusCode, json: response.body ? JSON.parse(response.body) : null }
  }
  assert.equal((await call(true, 'GET', '/api/seat-approvals')).status, 403)
  assert.equal((await call(false, 'GET', '/api/other')).handled, false)
  assert.equal((await call(false, 'GET', '/api/seat-approvals')).json.approvals[0].id, id)
  assert.equal((await call(false, 'POST', `/api/seat-approvals/${id}/answer`, { decision: 'maybe' })).status, 400)
  assert.equal((await call(false, 'POST', `/api/seat-approvals/${id}/answer`, { decision: 'deny' })).json.status, 'answered')
  assert.equal((await call(false, 'POST', `/api/seat-approvals/${id}/answer`, { decision: 'deny' })).status, 409)
})

test('a slow Aiterm never piles ticks up: five tick() calls join one run, and an answer is not queued behind a backlog', async t => {
  let release, inspects = 0
  const gate = new Promise(resolve => { release = resolve })
  const bot = { id: 'bot-aaaa1111', name: 'テスト', harness: 'claude' }
  const slow = createSeatApprovals({ path: '/dev/null', bots: new Map([[bot.id, bot]]),
    transport: { currentWork: () => ({ state: 'working' }), screenApproval: async () => { inspects++; await gate; return { status: 'none' } } } })
  const ticks = Array.from({ length: 5 }, () => slow.tick())
  release()
  await Promise.all(ticks)
  assert.equal(inspects, 1)
  await slow.tick() // the next tick after the run is a new run
  assert.equal(inspects, 2)
})
