import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createBellTeamServer } from '../src/http-server.mjs'
import { createSecretUse } from '../src/secret-use.mjs'
import { usageToolHandlers } from '../src/usage/mcp-tools.mjs'
import { forkWritesProject } from '../src/mcp-tools.mjs'

test('use_secret hands the requester its own submitted value on its seat command stdin and masks it in the reply', async () => {
  const items = { mine: { botId: 'bot-a', status: 'submitted', oneTime: true }, other: { botId: 'bot-b', status: 'submitted' }, open: { botId: 'bot-a', status: 'pending' } }
  const runs = [], resolved = []
  const use = createSecretUse({ secretRequests: { get: id => items[id], resolveValue: async id => { resolved.push(id); return 'tok-123\n' } },
    projectPath: id => `/srv/bots/${id}`,
    runner: project => async (command, args, options) => {
      runs.push({ project, command, args, input: options.input, acceptNonzero: options.acceptNonzero })
      return { stdout: 'got tok-123\n', stderr: 'echo tok-123\n\n', code: 3, signal: null }
    } })
  const result = await use('mine', { botId: 'bot-a', command: '/bin/sh', args: ['-c', 'cat'] })
  assert.deepEqual(runs, [{ project: '/srv/bots/bot-a', command: '/bin/sh', args: ['-c', 'cat'], input: 'tok-123\n', acceptNonzero: true }])
  assert.deepEqual(result, { exitCode: 3, signal: null, stdout: 'got [secret]\n', stderr: 'echo [secret]\n\n', oneTime: true })
  await assert.rejects(use('other', { botId: 'bot-a', command: 'true' }), { code: 'SECRET_REQUEST_NOT_FOUND' })
  await assert.rejects(use('open', { botId: 'bot-a', command: 'true' }), { code: 'SECRET_REQUEST_CLOSED' })
  await assert.rejects(use('mine', { botId: 'bot-a', command: '' }), { code: 'SECRET_USE_COMMAND_INVALID' })
  await assert.rejects(use('mine', { botId: 'bot-a', command: 'true', args: ['a\0'] }), { code: 'SECRET_USE_COMMAND_INVALID' })
  assert.deepEqual(resolved, ['mine'])

  const calls = []
  await usageToolHandlers.use_secret({ args: { requestId: 'mine', command: 'gh' }, from: 'bot-a', useSecret: async (...value) => calls.push(value) })
  assert.deepEqual(calls, [['mine', { command: 'gh', args: [] }]])
  assert.equal(forkWritesProject('use_secret', { requestId: 'mine', command: 'gh' }), true)
})

test('internal /use binds the user to the resolved seat, ignores a spoofed body botId and refuses a fork', async t => {
  const bots = new Map([['bot-a', { id: 'bot-a' }], ['bot-b', { id: 'bot-b' }]])
  const calls = []
  const server = createBellTeamServer({ bots, rooms: new Map(), internal: true, authorize: () => true, store: { timeline: async () => [], watch: async () => () => {} },
    transport: { forkSeat: async name => name === 'bot-a-fork-0123456789ab' ? { botId: 'bot-a', forkId: 'f' } : null },
    secretRequests: { get: () => { throw new Error('unused') }, useValue: async (id, input) => { calls.push([id, input]); return { exitCode: 0 } } } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const use = seat => fetch(`http://127.0.0.1:${server.address().port}/api/secret-requests/0a1b/use`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(seat ? { 'x-bellteam-seat': seat } : {}) }, body: JSON.stringify({ botId: 'bot-b', command: 'true', args: ['x'] }) })
  const own = await use('bot-a')
  assert.equal(own.status, 200)
  assert.deepEqual(calls, [['0a1b', { command: 'true', args: ['x'], botId: 'bot-a' }]])
  const unresolved = await use(null)
  assert.deepEqual([unresolved.status, (await unresolved.json()).error], [403, 'BELLTEAM_SEAT_UNRESOLVED'])
  const fork = await use('bot-a-fork-0123456789ab')
  assert.deepEqual([fork.status, (await fork.json()).error], [403, 'FORK_PROJECT_WRITE_REFUSED'])
  assert.equal(calls.length, 1)
})
