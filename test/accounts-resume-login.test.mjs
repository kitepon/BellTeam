import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'
import { HarnessAccounts, seatFiles } from '../src/harness-accounts.mjs'

// harness-accounts.md (E7): a resume carries the slot's current token, so the seat's login proof must follow it.
test('old stamp -> re-login -> E7 resume records the new stamp -> E6 signs that token out (not stale)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'accounts-resume-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const token = join(home, '.bellteam-accounts/claude/1st/oauth-token')
  await mkdir(join(home, '.bellteam-accounts/claude/1st'), { recursive: true })
  await writeFile(token, 'old'); await utimes(token, 1000, 1000)
  // The API rejects the token (token probe), so the E6 marks the slot.
  const accounts = new HarnessAccounts({ home, statePath: join(home, 'state.json'), log: () => {},
    seat: async (op, ...args) => op === 'probe' ? 'rejected' : seatFiles(op, ...args) })
  const old = (await stat(token)).mtimeMs
  await accounts.setSeat('bot-a', '1st', old)
  await writeFile(token, 'new')
  const fresh = (await stat(token)).mtimeMs
  assert.notEqual(fresh, old)
  const calls = []
  const client = {
    launchOptions: async () => ({}),
    async call(name, args, options) {
      calls.push({ name, claudeLogin: options?.claudeLogin })
      return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: 'bot-a', startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
    },
    close: async () => {},
  }
  const transport = new AitermTransport({ client, handoffContext: async () => '', accounts, captureRuntime: async () => ({ generation: null, components: {} }) })
  t.after(() => transport.close())
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: home }
  await transport.resumePreviouslyActive(bot, { harness: 'claude-code', sessionId: 'bot-a', launchId: 'a'.repeat(32) })
  assert.deepEqual(calls.filter(call => call.name === 'agent_launch').map(call => call.claudeLogin), ['1st'])
  assert.equal(accounts.state.logins['bot-a'], fresh)
  assert.equal(await accounts.recordSignedOut({ harness: 'claude', slot: '1st', botId: 'bot-a', text: 'Login expired · Please run /login' }), 'signed_out')
  assert.equal(await accounts.loggedIn('claude', '1st'), false)
})
