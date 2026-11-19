import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermTransport } from '../src/aiterm-transport.mjs'

// configuration-delivery.md (a469g): restart-resume of a fast Claude seat that already runs a turn (Aiterm 0.70.81) keeps fast off;
// BellTeam asks for fast again after the turn, and the saved switch is never written.
test('restart-resume found a turn running: fast is set again once Aiterm stops refusing, saved fastMode stays', async t => {
  const project = await mkdtemp(join(tmpdir(), 'refast-resume-'))
  const configures = [], updates = []
  let refused = 1
  const client = {
    launchOptions: async () => ({}),
    async call(name, args) {
      if (name === 'agent_launch') return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: 'bot-a', fast: false,
        startup: { status: 'ready', reason: 'turn_running' }, initial_prompt: { status: 'not_requested' }, fast_error: { code: 'FAST_MODE_UNCONFIRMED' } } }
      if (name === 'agent_configure') {
        configures.push(args)
        if (refused-- > 0) throw Object.assign(new Error('turn running'), { code: 'CONFIGURATION_NOT_APPLIED', effect: 'not_started' })
        return {}
      }
      throw new Error(`unexpected ${name}`)
    },
    close: async () => {},
  }
  const transport = new AitermTransport({ client, handoffContext: async () => '', refastRetry: 1, captureRuntime: async () => ({ generation: null, components: {} }),
    updateFastMode: async (id, value) => updates.push([id, value]) })
  t.after(() => transport.close())
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project, model: 'opus', reasoningEffort: 'high', fastMode: true }
  await transport.resumePreviouslyActive(bot, { harness: 'claude-code', sessionId: 'bot-a', launchId: 'a'.repeat(32) })
  for (let i = 0; i < 200 && configures.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))

  assert.deepEqual(updates, [])
  assert.deepEqual(configures, Array(2).fill({ session_id: 'bot-a', fast: true }))
})
