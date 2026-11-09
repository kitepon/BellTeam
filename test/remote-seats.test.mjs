import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteSeats, pieces } from '../src/remote-seats.mjs'
import { AitermTransport } from '../src/aiterm-transport.mjs'

const bot = { id: 'bot-aaaa1111', terminalId: 'mac-1', projectRoot: '/Users/quo/work/app', fastMode: false }
const code = value => Object.assign(new Error(value), { code: value })
const terminal = { ref: 'owner-macbook', target: { host: 'mac', user: 'quo', port: 22 }, trustRevision: 't1', credentialRevision: 'c1' }

function fixture({ targetErrors = [], accountOwner = 'owner', onTarget = () => {} } = {}) {
  const log = [], watchers = new Set(), queued = []
  const terminals = {
    connection: { async target(request) {
      log.push({ op: 'target', request })
      onTarget(request)
      const failure = targetErrors.shift()
      if (failure) throw Object.assign(code(failure), { effect: 'not_started' })
      return { terminal, cwd: request.projectRoot, accountOwner }
    } },
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
  }
  const ingress = { seatCredential: {
    async issue(request) { log.push({ op: 'issue', request }); return { url: 'http://127.0.0.1:4182/api/seat-mcp', credentialRef: { opaque: true } } },
    async revoke(request) { log.push({ op: 'revoke', request }) },
    async reveal(ref) { log.push({ op: 'reveal', ref }); return 'secret-token' },
  } }
  const launchContext = async (botId, request) => { log.push({ op: 'context', botId, request }); return { text: 'RULES', revision: 'r1' } }
  const records = {}
  const seats = new RemoteSeats({ terminals, ingress, launchContext, emitQueue: item => queued.push(item.bot.id), recorded: async name => records[name] ?? null })
  return { seats, log, queued, records, emit: event => { for (const listener of watchers) listener(event) } }
}

const launchArgs = { harness: 'claude-code', cwd: '/srv/bellteam/bots/bot-aaaa1111', session_name: 'bot-aaaa1111-2nd-x1', model: 'opus' }

test('prepare: the same agent_launch args plus terminal target, folder, context and MCP names; 2nd login only on the Owner terminal', async () => {
  const { seats, log } = fixture()
  const prepared = await seats.prepare(bot, launchArgs, { shortTermMemory: 'prev', context: { membersLease: 'L' }, slot: '2nd', harness: 'claude-code' })
  assert.deepEqual(prepared.args.terminal, terminal)
  assert.equal(prepared.args.cwd, bot.projectRoot)
  assert.equal(prepared.args.session_name, launchArgs.session_name)
  assert.equal(prepared.args.append_system_prompt, 'RULES')
  assert.equal(prepared.args.mcp_config.mcpServers.bellteam.headers.Authorization, 'Bearer ${BELLTEAM_MCP_TOKEN}')
  assert.equal(JSON.stringify(prepared.args).includes('secret-token'), false)
  assert.equal(prepared.claudeLogin, '2nd')
  assert.deepEqual(prepared.privateEnv.names, ['BELLTEAM_MCP_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(log.some(entry => entry.op === 'reveal'), false, 'the value is read only inside the launch call')
  assert.deepEqual(await prepared.privateEnv.resolve(), { BELLTEAM_MCP_TOKEN: 'secret-token' })
  assert.deepEqual(log.find(entry => entry.op === 'context').request, { sessionName: launchArgs.session_name, shortTermMemory: 'prev' })

  const other = fixture({ accountOwner: 'user-b' })
  const theirs = await other.seats.prepare(bot, launchArgs, { slot: '2nd', harness: 'claude-code' })
  assert.equal(theirs.claudeLogin, null)
  assert.deepEqual(theirs.privateEnv.names, ['BELLTEAM_MCP_TOKEN'])
})

test('asleep terminal: not started without a credential, then the availability event drains the same Bot', async () => {
  const { seats, log, queued, emit } = fixture({ targetErrors: ['TERMINAL_UNAVAILABLE'] })
  await assert.rejects(seats.prepare(bot, launchArgs, { slot: '1st' }), error => error.effect === 'not_started')
  assert.equal(log.some(entry => entry.op === 'issue'), false)
  emit({ terminalId: 'mac-1', reachable: false })
  assert.deepEqual(queued, [])
  emit({ terminalId: 'mac-1', reachable: true })
  assert.deepEqual(queued, ['bot-aaaa1111'])
})

test('credential release: a successful pty_close of a remote seat revokes it, also after a body restart; other names stay', async () => {
  const { seats, log, records } = fixture()
  seats.launched(bot, { session_id: launchArgs.session_name, launch_id: 'a'.repeat(32) })
  seats.launched(bot, { session_id: 'bot-aaaa1111-1st-x2', launch_id: 'b'.repeat(32) })
  records['bot-aaaa1111-1st-x9'] = { target: 'mac-1\n/Users/quo/work/app', botId: bot.id, launchId: 'c'.repeat(32) }
  const client = seats.route({ call: async () => ({}) })
  await client.call('pty_close', { session_id: launchArgs.session_name })
  await client.call('pty_close', { session_id: 'bot-local' })
  await client.call('pty_close', { session_id: 'bot-aaaa1111-1st-x9' })
  assert.deepEqual(log.filter(entry => entry.op === 'revoke').map(entry => entry.request.sessionName), [launchArgs.session_name, 'bot-aaaa1111-1st-x9'])
  assert.deepEqual([...seats.seats.keys()], ['bot-aaaa1111-1st-x2'])
})

test('C7: a completed remote turn hands the completed prefix to Throughline; only its ACK cursor stays', async () => {
  const { seats } = fixture()
  const commands = [], reads = []
  let served = 0
  seats.seatCommand = async process => {
    if (process.executable === 'aiterm-transcript-read') {
      reads.push(process.args)
      return served++ < 2 ? { schema: 'aiterm.transcript-read.v1', entries: ['{"a":1}\n', '{"b":2}\n'], cursor: { claudeSessionId: 'c1', offset: 12 } } : { entries: [] }
    }
    const [, script, args, ...parts] = process.args
    assert.ok(script.includes("spawn('throughline'"))
    const input = parts.join('')
    commands.push({ args: JSON.parse(args), input: input ? JSON.parse(input) : null })
    if (commands.length === 1) return { status: 'error', code: 'E_REMOTE_GAP', expectedCursor: { claudeSessionId: 'c1', offset: 0 } }
    return { schema: 'throughline.remote_ingest.v1', status: 'ready', ackedCursor: { claudeSessionId: 'c1', offset: 12 } }
  }
  seats.launched(bot, { session_id: launchArgs.session_name, launch_id: 'a'.repeat(32) })
  const seat = seats.seats.get(launchArgs.session_name)
  const local = async () => ({ outcome: 'done' })
  assert.deepEqual(await seats.waitProcess(local)({ args: ['/x/aiterm-wait.js', '--session', seat.sessionName] }), { outcome: 'done' })
  await new Promise(resolve => setImmediate(resolve))
  while (seat.forwarding) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(commands[0].args, ['remote-ingest', '--json'])
  assert.equal(commands[0].input.launchId, 'a'.repeat(32))
  assert.deepEqual(reads[0], ['--session', seat.sessionName, '--max-bytes', '1048576'])
  assert.deepEqual(seat.cursor, { claudeSessionId: 'c1', offset: 0 }) // the gap stops this pass at Throughline's expected cursor
  await seats.forward(seat)
  assert.deepEqual(reads[1], ['--session', seat.sessionName, '--cursor-session', 'c1', '--offset', '0', '--max-bytes', '1048576'])
  assert.deepEqual(seat.cursor, { claudeSessionId: 'c1', offset: 12 })
  assert.deepEqual(await seats.waitProcess(local)({ args: ['--session', 'bot-local'] }), { outcome: 'done' })
  seats.seatCommand = async () => { throw new Error('missing') }
  assert.equal(await seats.handoffContext(bot.id), '')
})

test('argv pieces: at most 96 KiB UTF-8 bytes each, never inside a code point, joined exactly', () => {
  const text = JSON.stringify({ entries: ['日本語の記録'.repeat(30000), 'a😀'.repeat(40000), 'é'.repeat(70000)] })
  const parts = pieces(text)
  assert.ok(parts.length > 3)
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part) <= 96 * 1024)
    assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part) // no lone surrogate
  }
  assert.equal(parts.join(''), text)
  assert.deepEqual(pieces(''), [])
})

async function transportFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'remote-seat-'))
  const calls = []
  const client = { call: async (name, args, callOptions) => { calls.push({ name, args, options: callOptions })
    return { content: [], structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name ?? args.session_id, launch_id: 'd'.repeat(32), startup: { status: 'ready' } } } } }
  const membersAdmission = { assertLease() {}, withLease: fn => fn('L'), capture() {}, assertOpen() {} }
  const remote = fixture(options)
  const transport = new AitermTransport({ client, membersAdmission, remoteSeats: remote.seats, runtimeLaunchesPath: join(root, 'launches.json') })
  transport.captureLaunchRuntime = async () => ({ generation: 'g1' })
  const member = { ...bot, harness: 'claude', project: join(root, 'bot'), session: 'bot-aaaa1111' }
  return { root, calls, transport, member, remote }
}

test('one launch path: the same agent_launch with terminal + cwd; the checkpoint reruns after the async preparation', async () => {
  let admitted = true
  const { root, calls, transport, member, remote } = await transportFixture({ onTarget: () => { admitted = false } })
  try {
    await assert.rejects(transport.wakeNow(member, { membersLease: 'L', admissionCheck: () => { if (!admitted) throw code('ADMISSION_CHANGED') } }), { code: 'ADMISSION_CHANGED' })
    assert.equal(calls.some(call => call.name === 'agent_launch'), false)
    assert.ok(remote.log.some(entry => entry.op === 'revoke'), 'the unused credential is revoked')
    admitted = true
    remote.log.length = 0
    const session = await transport.wakeNow(member, { membersLease: 'L', admissionCheck: () => {} })
    const launch = calls.find(call => call.name === 'agent_launch')
    assert.equal(session, 'bot-aaaa1111')
    assert.deepEqual(launch.args.terminal, terminal)
    assert.equal(launch.args.cwd, bot.projectRoot)
    assert.deepEqual(launch.options.privateEnv.names, ['BELLTEAM_MCP_TOKEN'])
    assert.equal(remote.log.some(entry => entry.op === 'revoke'), false)
    assert.equal(remote.seats.seats.get('bot-aaaa1111').launchId, 'd'.repeat(32))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('target revision at the delivery: an idle seat on another target is closed and woken there; a running turn keeps it', async () => {
  const { root, calls, transport, member } = await transportFixture()
  try {
    await transport.wakeNow(member, { membersLease: 'L' })
    await transport.runtimeLaunchQueue
    assert.equal(await transport.seatTargetChanged(member), false)
    assert.equal(await transport.seatTargetChanged({ ...member, terminalId: '', projectRoot: '' }), true, 'remote -> local')
    const woken = [], sent = []
    let state = 'idle'
    transport.observeForDispatch = async () => ({ exists: true, state })
    transport.wake = async target => { woken.push(target.projectRoot); return 'bot-aaaa1111' }
    transport.sendToSession = async session => { sent.push(session); return { content: [], structuredContent: { mode: 'sent' } } }
    const moved = { ...member, projectRoot: '/Users/quo/work/other' }
    await transport.dispatch(member, 'same target', []).catch(() => {})
    assert.deepEqual(woken, [], 'unchanged target: no relaunch')
    state = 'busy'
    await transport.dispatch(moved, 'busy', []).catch(() => {})
    assert.deepEqual(woken, [], 'a running turn is never closed')
    state = 'idle'
    calls.length = 0
    await transport.dispatch(moved, 'moved', []).catch(() => {})
    assert.deepEqual(calls.map(call => call.name), ['pty_close'])
    assert.deepEqual(woken, ['/Users/quo/work/other'])
    assert.equal(sent.length, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('agent_launch terminal codes after a good target: connectivity queues and arms the observer; a missing folder is a visible failure', () => {
  const { seats } = fixture()
  const observed = []
  seats.terminals.connection.observe = terminalId => observed.push(terminalId)
  const unreachable = code('UNREACHABLE')
  seats.launchFailed(bot, unreachable)
  assert.equal(unreachable.effect, 'not_started')
  assert.deepEqual(observed, ['mac-1'])
  const mismatch = code('HOST_KEY_MISMATCH')
  seats.launchFailed(bot, mismatch)
  assert.equal(mismatch.effect, 'not_started')
  assert.deepEqual(observed, ['mac-1'], 'waits for the registry-change edge')
  const folder = code('CWD_UNAVAILABLE')
  seats.launchFailed(bot, folder)
  assert.equal(folder.effect, undefined)
  assert.deepEqual([...seats.waiting.get('mac-1')], ['bot-aaaa1111'])
})

const keyed = { ref: 'owner-macbook', target: terminal.target, trustRevision: 't1', credential: { handle: '11111111-2222-4333-8444-555555555555', revision: 3 } }

function keyFixture({ receipt = request => ({ schema: 'aiterm.credential-load.v1', accepted: true, ref: request.ref, handle: request.handle, revision: request.revision }) } = {}) {
  const base = fixture()
  const loads = [], observed = []
  base.seats.terminals.connection.target = async request => { base.log.push({ op: 'target', request }); return { terminal: keyed, cwd: request.projectRoot, accountOwner: 'owner' } }
  base.seats.terminals.connection.observe = terminalId => observed.push(terminalId)
  base.seats.ingress.seatCredential.loadTerminalKey = async request => { loads.push(request); return receipt(request) }
  return { ...base, loads, observed }
}

test('R13: an app-set key is loaded by the parent before the launch; execution passes only the handle and revision', async () => {
  const { seats, loads } = keyFixture()
  const prepared = await seats.prepare(bot, launchArgs, { slot: '1st', harness: 'claude-code' })
  assert.deepEqual(prepared.args.terminal.credential, keyed.credential)
  assert.deepEqual(loads, [{ terminalId: 'mac-1', memberId: bot.id, ref: 'owner-macbook', handle: keyed.credential.handle, revision: 3 }])

  const native = fixture()
  native.seats.ingress.seatCredential.loadTerminalKey = async () => assert.fail('a native key is never loaded')
  await native.seats.prepare(bot, launchArgs, { slot: '1st', harness: 'claude-code' })
})

test('R13: a refused load is not started, arms the observer and queues the Bot', async () => {
  const { seats, observed, log } = keyFixture({ receipt: () => { throw code('TERMINAL_KEY_LOAD_UNAVAILABLE') } })
  await assert.rejects(seats.prepare(bot, launchArgs, { slot: '1st' }), error => error.code === 'CREDENTIAL_UNAVAILABLE' && error.effect === 'not_started')
  assert.deepEqual(observed, ['mac-1'])
  assert.deepEqual([...seats.waiting.get('mac-1')], [bot.id])
  assert.equal(log.some(entry => entry.op === 'issue'), false)
})

test('R13: CREDENTIAL_NOT_LOADED on a session call loads again and issues the same call once more', async () => {
  const { seats, loads } = keyFixture()
  seats.launched(bot, { session_id: launchArgs.session_name, launch_id: 'a'.repeat(32) })
  const issued = []
  let refuse = 1
  const client = seats.route({ call: async (name, args) => { issued.push(name); if (refuse-- > 0) throw code('CREDENTIAL_NOT_LOADED'); return { ok: true } } })
  assert.deepEqual(await client.call('pty_send', { session_id: launchArgs.session_name, text: 'x' }), { ok: true })
  assert.deepEqual(issued, ['pty_send', 'pty_send'])
  assert.equal(loads.length, 1)
  refuse = 1
  await assert.rejects(client.call('pty_send', { session_id: 'bot-local', text: 'x' }), { code: 'CREDENTIAL_NOT_LOADED' })
})

test('R13: CREDENTIAL_REVISION_STALE on agent_launch loads again and launches once more with the fresh terminal', async () => {
  const { root, calls, transport, member } = await transportFixture()
  try {
    const k = keyFixture()
    transport.remoteSeats = k.seats
    let refuse = 1
    const client = transport.client, original = client.call
    client.call = async (name, args, options) => { if (name === 'agent_launch' && refuse-- > 0) { calls.push({ name, args }); throw code('CREDENTIAL_REVISION_STALE') } return original(name, args, options) }
    assert.equal(await transport.wakeNow(member, { membersLease: 'L' }), 'bot-aaaa1111')
    assert.equal(calls.filter(call => call.name === 'agent_launch').length, 2)
    assert.equal(k.loads.length, 2, 'loaded before the launch and again after the refusal')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('R13: a stop/admission change while the reload is suspended starts no second agent_launch', async () => {
  const { root, calls, transport, member } = await transportFixture()
  try {
    const k = keyFixture()
    transport.remoteSeats = k.seats
    let admitted = true
    const load = k.seats.ingress.seatCredential.loadTerminalKey
    k.seats.ingress.seatCredential.loadTerminalKey = async request => { if (k.loads.length === 1) admitted = false; return load(request) }
    const client = transport.client
    client.call = async (name, args) => { calls.push({ name, args }); if (name === 'agent_launch') throw code('CREDENTIAL_NOT_LOADED'); return {} }
    await assert.rejects(transport.wakeNow(member, { membersLease: 'L', admissionCheck: () => { if (!admitted) throw code('ADMISSION_CHANGED') } }), { code: 'ADMISSION_CHANGED' })
    assert.equal(calls.filter(call => call.name === 'agent_launch').length, 1)
    assert.equal(k.loads.length, 2)
    assert.ok(k.log.some(entry => entry.op === 'revoke'), 'the seat credential of the refused launch is revoked')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('R13: an accountOwner change during the reload launches nothing more and never sends the Owner login elsewhere', async () => {
  const { root, calls, transport, member } = await transportFixture()
  try {
    const k = keyFixture()
    transport.remoteSeats = k.seats
    transport.accounts = { watch: () => () => {}, selection: async () => ({ slot: '2nd' }), setSeat: async () => {} }
    let owner = 'owner'
    k.seats.terminals.connection.target = async request => ({ terminal: keyed, cwd: request.projectRoot, accountOwner: owner })
    const client = transport.client
    client.call = async (name, args, options) => { calls.push({ name, args, options }); if (name === 'agent_launch') { owner = 'user-b'; throw code('CREDENTIAL_NOT_LOADED') } return {} }
    await assert.rejects(transport.wakeNow(member, { membersLease: 'L' }), error => error.code === 'TERMINAL_TARGET_CHANGED' && error.effect === 'not_started')
    const launches = calls.filter(call => call.name === 'agent_launch')
    assert.equal(launches.length, 1)
    assert.equal(launches[0].options.claudeLogin, '2nd', 'the first launch was on the Owner terminal')
    assert.ok(k.log.some(entry => entry.op === 'revoke'))
    assert.deepEqual(k.observed, ['mac-1'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
