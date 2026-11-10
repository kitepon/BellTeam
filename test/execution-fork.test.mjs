import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { RemoteSeats } from '../src/remote-seats.mjs'

const banned = { session_id: 'bot-aaaa1111', vendor_session_id: 'v1', write_ban: { path: '/p', method: 'landlock' } }
const receiptOf = (args, extra = {}) => ({ schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name, launch_id: 'b'.repeat(32), input_id: 'a'.repeat(32),
  event_cursor: 1, wait_process: { command: 'wait', args: ['--session', args.session_name] }, initial_prompt: { status: 'started' }, fork_of: banned, ...extra })

async function fixture({ launch = args => ({ structuredContent: receiptOf(args) }), wait = async () => ({ outcome: 'done' }), remoteSeats = null, bot = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fork-'))
  const calls = [], tracked = []
  const client = { call: async (name, args, options) => {
    calls.push({ name, args, options })
    if (name === 'agent_launch') return launch(args)
    if (name === 'pty_read') return { structuredContent: { schema: 'aiterm.pty-read-result.v1', mode: 'agent_transcript', text: 'the answer' } }
    return { content: [], structuredContent: {} }
  } }
  const transport = new AitermTransport({ client, waitProcess: wait, remoteSeats, trackCompletion: promise => tracked.push(promise), interimInterval: 60_000 })
  transport.captureLaunchRuntime = async () => null
  const member = { id: 'bot-aaaa1111', name: 'Aaaa', harness: 'claude', project: root, session: 'bot-aaaa1111', ...bot }
  return { root, calls, tracked, transport, member }
}

test('local fork: fork_from launch, registry while running, answer then delivered then turn end, closed after', async () => {
  const { root, calls, tracked, transport, member } = await fixture()
  try {
    const events = []
    const result = await transport.forkInquiry(member, 'question', { forkId: 'f-1', deliveryId: 'd-1',
      onStatus: async status => events.push(status), onAnswer: async text => events.push(`answer:${text}`), onTurnEnd: () => events.push('end') })
    assert.deepEqual(result, { delivery: 'running', forkId: 'f-1' })
    const launch = calls.find(call => call.name === 'agent_launch').args
    assert.match(launch.session_name, /^bot-aaaa1111-fork-[0-9a-f]{12}$/u)
    assert.deepEqual(launch.fork_from, { session_id: 'bot-aaaa1111', fork_id: 'f-1' })
    assert.equal(launch.cwd, root)
    assert.equal(launch.prompt, 'question')
    for (const key of ['write_scope', 'model', 'fast', 'mcp_config', 'require_existing_resume']) assert.equal(Object.hasOwn(launch, key), false, key)
    assert.deepEqual(transport.forkSeat(launch.session_name), { botId: member.id, forkId: 'f-1' })
    const rows = transport.queueItems({ botId: member.id })
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].seat, { kind: 'fork', forkId: 'f-1' })
    assert.equal(rows[0].groupId, 'd-1')
    assert.equal(transport.isIdle(member.id), true, 'the main seat stays idle')
    await Promise.all(tracked)
    assert.deepEqual(events, ['running', 'answer:the answer', 'delivered', 'end'])
    assert.deepEqual(calls.at(-1), { name: 'pty_close', args: { session_id: launch.session_name }, options: undefined })
    assert.equal(transport.forkSeat(launch.session_name), null)
    assert.equal(transport.queueItems({}).length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failure after accept: one failed status with FORK_FAILED, the fork is closed', async () => {
  const { root, calls, tracked, transport, member } = await fixture({ wait: async () => ({ outcome: 'error', error: 'boom' }) })
  try {
    const statuses = []
    await transport.forkInquiry(member, 'question', { forkId: 'f-2', onStatus: async (status, error) => statuses.push([status, error?.code]) })
    await Promise.all(tracked)
    assert.deepEqual(statuses, [['running', undefined], ['failed', 'FORK_FAILED']])
    assert.equal(calls.at(-1).name, 'pty_close')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('READONLY_UNENFORCEABLE and a receipt without write_ban are FORK_UNAVAILABLE; nothing stays registered', async () => {
  for (const launch of [() => { throw Object.assign(new Error('aiterm: READONLY_UNENFORCEABLE: windows'), { effect: 'not_started' }) },
    args => ({ structuredContent: receiptOf(args, { fork_of: undefined }) })]) {
    const { root, calls, transport, member } = await fixture({ launch })
    try {
      await assert.rejects(transport.forkInquiry(member, 'question', { forkId: 'f-3' }), { code: 'FORK_UNAVAILABLE', reason: 'readonly_unenforceable' })
      assert.equal(transport.queueItems({}).length, 0)
      // A launch that did start (receipt without the ban) is closed; a refused one has nothing to close.
      assert.equal(calls.some(call => call.name === 'pty_close'), launch.length === 1)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('remote fork: credential kind fork, same MCP config shape, no launch notice, credential revoked at close', async () => {
  const log = []
  const remoteSeats = new RemoteSeats({
    terminals: { connection: { target: async request => ({ terminal: { ref: 't', target: {} }, cwd: request.projectRoot, accountOwner: 'owner' }) } },
    ingress: { seatCredential: { issue: async request => { log.push(['issue', request]); return { url: 'http://127.0.0.1:4183/api/seat-mcp', credentialRef: {} } },
      revoke: async request => { log.push(['revoke', request]) }, reveal: async () => 'token' } },
    launchContext: async () => ({ text: 'RULES' }),
    seatCommand: async ({ executable, args }) => {
      if (executable === 'aiterm-transcript-read') return log.some(entry => entry[0] === 'ingest') ? { entries: [] } : { entries: ['{}'], cursor: { claudeSessionId: 'c1', offset: 2 } }
      log.push(['ingest', JSON.parse(args[2]), JSON.parse(args.slice(3).join(''))])
      return { status: 'ready', ackedCursor: { claudeSessionId: 'c1', offset: 2 } }
    },
  })
  const { root, calls, tracked, transport, member } = await fixture({ remoteSeats, bot: { terminalId: 'mac-1', projectRoot: '/Users/q/app' } })
  try {
    await transport.forkInquiry(member, 'question', { forkId: 'f-4' })
    await Promise.all(tracked)
    const launch = calls.find(call => call.name === 'agent_launch')
    assert.equal(log[0][1].kind, 'fork')
    assert.equal(log[0][1].sessionName, launch.args.session_name)
    assert.ok(launch.args.mcp_config.mcpServers.bellteam)
    assert.equal(launch.args.cwd, '/Users/q/app')
    assert.deepEqual(launch.options.privateEnv.names, ['BELLTEAM_MCP_TOKEN'])
    // C7: the fork transcript goes once as `--fork` with labels from the receipt, before close and revoke.
    const ingest = log.find(entry => entry[0] === 'ingest')
    assert.deepEqual(ingest[1], ['remote-ingest', '--fork', '--json'])
    assert.equal(ingest[2].sessionKind, 'fork')
    assert.equal(ingest[2].parentSessionId, 'v1')
    assert.equal(ingest[2].forkId, 'f-4')
    assert.equal(ingest[2].sessionName, launch.args.session_name)
    assert.ok(log.indexOf(ingest) < log.findIndex(entry => entry[0] === 'revoke'))
    assert.deepEqual(log.at(-1), ['revoke', { sessionName: launch.args.session_name }])
    assert.equal(remoteSeats.seats.size, 0, 'a fork is not a remote main seat')
  } finally { await rm(root, { recursive: true, force: true }) }
})
