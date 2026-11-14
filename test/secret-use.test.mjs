import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretUse } from '../src/secret-use.mjs'
import { usageToolHandlers } from '../src/usage/mcp-tools.mjs'

test('use_secret hands the requester its own submitted value on its seat command stdin and masks it in the reply', async () => {
  const items = { mine: { botId: 'bot-a', status: 'submitted', oneTime: true }, other: { botId: 'bot-b', status: 'submitted' }, open: { botId: 'bot-a', status: 'pending' } }
  const runs = [], resolved = []
  const use = createSecretUse({ read: async id => items[id], projectPath: id => `/srv/bots/${id}`,
    resolveValue: async id => { resolved.push(id); return 'tok-123\n' },
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
  assert.deepEqual(calls, [['mine', { botId: 'bot-a', command: 'gh', args: [] }]])
})
