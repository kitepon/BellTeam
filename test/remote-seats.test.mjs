import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteSeats } from '../src/remote-seats.mjs'

const bot = { id: 'bot-aaaa1111', terminalId: 'mac-1', projectRoot: '/Users/quo/work/app', fastMode: false }
const code = value => Object.assign(new Error(value), { code: value })

function fixture({ openErrors = [], exists = false, calls: callErrors = [] } = {}) {
  const log = [], watchers = new Set(), queued = []
  const native = ref => ({
    async callTool(name, args, options) {
      log.push({ op: 'call', ref, name, args, options })
      if (name === 'pty_observe') return { structuredContent: { exists } }
      const failure = callErrors.shift()
      if (failure) throw code(failure)
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { session_id: args.session_name ?? args.session_id } }
    },
    async wait(process) { log.push({ op: 'wait', ref, process }); return { outcome: 'done' } },
  })
  let refs = 0
  const terminals = {
    connection: {
      async open(request) {
        log.push({ op: 'open', request })
        const failure = openErrors.shift()
        if (failure) throw Object.assign(code(failure), { effect: 'not_started' })
        const ref = `c${++refs}`
        return { connectionRef: ref, native: native(ref) }
      },
      async close(ref) { log.push({ op: 'close', ref }); return { closed: true } },
    },
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
  }
  const ingress = { seatCredential: {
    async issue(request) { log.push({ op: 'issue', request }); return { url: 'http://box:4180/api/seat-mcp', credentialRef: { opaque: true } } },
    async revoke(request) { log.push({ op: 'revoke', request }) },
  } }
  const launchContext = async (botId, request) => { log.push({ op: 'context', botId, request }); return { text: 'RULES', revision: 'r1' } }
  const seats = new RemoteSeats({ terminals, ingress, launchContext, emitQueue: item => queued.push(item.bot.id) })
  return { seats, log, queued, emit: event => { for (const listener of watchers) listener(event) } }
}

const launchArgs = { harness: 'claude-code', cwd: '/srv/bellteam/bots/bot-aaaa1111', session_name: 'bot-aaaa1111-2nd-x1', model: 'opus' }

test('remote launch: folder, context, MCP and login names only; the 2nd login is a reference', async () => {
  const { seats, log } = fixture()
  const result = await seats.launch(bot, launchArgs, { shortTermMemory: 'prev', context: { membersLease: 'L' }, slot: '2nd' })
  assert.equal(result.structuredContent.session_id, 'bot-aaaa1111-2nd-x1')
  const launch = log.find(entry => entry.name === 'agent_launch')
  assert.equal(launch.args.cwd, bot.projectRoot)
  assert.equal(launch.options.private.appendSystemPrompt, 'RULES')
  assert.deepEqual(launch.options.private.env, ['BELLTEAM_MCP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(launch.options.private.mcpConfig.mcpServers.bellteam.headers.Authorization, 'Bearer ${BELLTEAM_MCP_TOKEN}')
  const opened = log.filter(entry => entry.op === 'open').at(-1).request
  assert.deepEqual(opened.credentials.CLAUDE_CODE_OAUTH_TOKEN, { harness: 'claude', slot: '2nd' })
  assert.deepEqual(log.find(entry => entry.op === 'context').request, { sessionName: 'bot-aaaa1111-2nd-x1', shortTermMemory: 'prev' })
  assert.ok(seats.seats.has('bot-aaaa1111-2nd-x1'))
})

test('asleep terminal: not started, then the availability event drains the same Bot', async () => {
  const { seats, queued, emit } = fixture({ openErrors: ['TERMINAL_UNAVAILABLE'] })
  await assert.rejects(seats.launch(bot, launchArgs, { slot: '1st' }), error => error.effect === 'not_started')
  emit({ terminalId: 'mac-1', reachable: false })
  assert.deepEqual(queued, [])
  emit({ terminalId: 'mac-1', reachable: true })
  assert.deepEqual(queued, ['bot-aaaa1111'])
})

test('a seat alive on the terminal is taken over, no second launch and no new credential', async () => {
  const { seats, log } = fixture({ exists: true })
  const result = await seats.launch(bot, launchArgs, { slot: '1st' })
  assert.equal(result.structuredContent.adopted, true)
  assert.equal(log.some(entry => entry.name === 'agent_launch' || entry.op === 'issue'), false)
})

test('routing: remote session to its connection, local to the shared client, list merged, wait on the terminal', async () => {
  const { seats, log } = fixture()
  await seats.launch(bot, launchArgs, { slot: '1st' })
  const local = []
  const client = seats.route({ call: async (name, args) => { local.push(name); return name === 'pty_list'
    ? { content: [{ type: 'text', text: 'bot-local\tx' }], structuredContent: { schema: 'aiterm.pty-list-result.v1', sessions: [{ session_id: 'bot-local' }] } } : {} } })
  let checked = false
  await client.call('pty_send', { session_id: 'bot-aaaa1111-2nd-x1', text: 'hi' }, { admissionCheck: () => { checked = true } })
  await client.call('pty_send', { session_id: 'bot-local', text: 'hi' })
  assert.equal(checked, true)
  assert.deepEqual(local, ['pty_send'])
  const list = await client.call('pty_list')
  assert.deepEqual(list.structuredContent.sessions.map(row => row.session_id), ['bot-local', 'bot-aaaa1111-2nd-x1'])
  const wait = seats.waitProcess(async () => 'local')
  assert.equal(await wait({ args: ['--session', 'bot-local'] }), 'local')
  assert.deepEqual(await wait({ args: ['--session', 'bot-aaaa1111-2nd-x1', '--cursor', '3'] }), { outcome: 'done' })
  assert.ok(log.some(entry => entry.op === 'wait'))
})

test('lost connection: refused-before-send reopens once without credentials; in-flight loss is never resent', async () => {
  const { seats, log } = fixture({ calls: [] })
  await seats.launch(bot, launchArgs, { slot: '1st' })
  const seat = seats.seats.get('bot-aaaa1111-2nd-x1')
  const failing = (codes) => { const base = seat.native; seat.native = { ...base, callTool: async (...args) => { const next = codes.shift(); if (next) throw code(next); return base.callTool(...args) } } }
  failing(['TERMINAL_UNAVAILABLE'])
  await seats.call(seat, 'pty_send', { session_id: seat.sessionName, text: 'a' })
  assert.equal(log.filter(entry => entry.op === 'open').at(-1).request.credentials, undefined)
  const sends = () => log.filter(entry => entry.name === 'pty_send').length
  const before = sends()
  failing(['CONNECTION_LOST'])
  await assert.rejects(seats.call(seat, 'pty_send', { session_id: seat.sessionName, text: 'b' }), { code: 'CONNECTION_LOST' })
  assert.equal(sends(), before)
})
