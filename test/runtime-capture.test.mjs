import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { runtimeLaunchEnv } from '../src/aiterm-client.mjs'
import { captureRuntime } from '../src/runtime-selection.mjs'

const runtime = generation => Object.freeze({ generation, components: {
  'runtime-aiterm-mcp': { origin: 'release', bin: { 'aiterm-mcp': '/rt/a/bin/aiterm-mcp' }, root: '/rt/a/lib/node_modules/aiterm-mcp' },
  'runtime-codex': { origin: 'release', bin: { codex: '/rt/c/bin/codex' } },
  'runtime-claude-code': { origin: 'release', bin: { claude: '/rt/k/bin/claude' } },
  'runtime-throughline': { origin: 'release', bin: { throughline: '/rt/t/bin/throughline' } },
} })

test('launch env hands Aiterm the captured CLI paths with captured bin dirs first on PATH', async t => {
  assert.deepEqual(runtimeLaunchEnv(runtime('b'.repeat(64)), '/usr/bin'), { CODEX_BIN: '/rt/c/bin/codex', CLAUDE_BIN: '/rt/k/bin/claude',
    PATH: '/rt/a/bin:/rt/c/bin:/rt/k/bin:/rt/t/bin:/usr/bin', BELLTEAM_RUNTIME_GENERATION: 'b'.repeat(64) })
  // No selection (all builtin) is a true no-op: /usr/local/bin never shadows the Bot's own .local/bin.
  assert.deepEqual(runtimeLaunchEnv(await captureRuntime({ root: '/nonexistent-runtime-root' }), '/p/.local/bin:/usr/bin'), { BELLTEAM_RUNTIME_GENERATION: '' })
  // Mixed: only the release component's bin dir and binary are handed over.
  const mixed = { generation: 'd'.repeat(64), components: { ...runtime(null).components,
    'runtime-claude-code': { origin: 'builtin', bin: { claude: '/usr/local/bin/claude' } },
    'runtime-aiterm-mcp': { origin: 'builtin', bin: { 'aiterm-mcp': '/usr/local/bin/aiterm-mcp' } },
    'runtime-throughline': { origin: 'builtin', bin: { throughline: '/usr/local/bin/throughline' } } } }
  assert.deepEqual(runtimeLaunchEnv(mixed, '/usr/bin'), { CODEX_BIN: '/rt/c/bin/codex', PATH: '/rt/c/bin:/usr/bin', BELLTEAM_RUNTIME_GENERATION: 'd'.repeat(64) })
  const project = await mkdtemp(join(tmpdir(), 'runtime-capture-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const { env, runtime: passed } = await new AitermClient().launchOptions(project, runtime('b'.repeat(64)))
  assert.equal(env.CODEX_BIN, '/rt/c/bin/codex'); assert.equal(env.BELLTEAM_RUNTIME_GENERATION, 'b'.repeat(64))
  assert.ok(env.PATH.startsWith('/rt/a/bin:/rt/c/bin:/rt/k/bin:/rt/t/bin:')); assert.equal(passed.generation, 'b'.repeat(64))
})

test('wake captures once and records D5; resume re-resolves the recorded generation; an unavailable binding refuses only that launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state', 'execution-runtime-launches.json'), captures = [], seen = [], launches = []
  let current = 'a'.repeat(64)
  const client = {
    launchOptions: async (project, value) => { seen.push(value); return {} },
    async call(name, args) {
      launches.push(args)
      return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: 'bot-a',
        startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
    },
    close: async () => {},
  }
  const options = { client, handoffContext: async () => '', runtimeLaunchesPath: path,
    captureRuntime: async ({ generation } = {}) => {
      captures.push(generation)
      if (generation === 'f'.repeat(64)) throw Object.assign(new Error('RUNTIME_BINDING_UNAVAILABLE'), { code: 'RUNTIME_BINDING_UNAVAILABLE' })
      return runtime(generation === undefined ? current : generation)
    } }
  const transport = new AitermTransport(options)
  t.after(() => transport.close())
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }

  assert.equal(await transport.wake(bot), 'bot-a')
  assert.deepEqual(captures, [undefined]); assert.equal(seen[0].generation, 'a'.repeat(64))
  const record = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(record.schema, 'bellteam.runtime-launches.v1'); assert.equal(record.launches['bot-a'].generation, 'a'.repeat(64))

  // A newer selection does not move the resumed launch (fresh transport = after a body restart).
  current = 'c'.repeat(64)
  const restarted = new AitermTransport(options)
  t.after(() => restarted.close())
  const reference = { harness: 'codex-cli', sessionId: 'bot-a', launchId: 'a'.repeat(32) }
  assert.equal((await restarted.resumePreviouslyActive(bot, reference)).sessionId, 'bot-a')
  assert.equal(captures.at(-1), 'a'.repeat(64)); assert.equal(seen.at(-1).generation, 'a'.repeat(64))

  const count = launches.length
  const broken = new AitermTransport({ ...options, runtimeLaunchesPath: null, captureRuntime: async () => { throw Object.assign(new Error('RUNTIME_BINDING_UNAVAILABLE'), { code: 'RUNTIME_BINDING_UNAVAILABLE' }) } })
  t.after(() => broken.close())
  await assert.rejects(broken.wake(bot), { code: 'RUNTIME_BINDING_UNAVAILABLE', effect: 'not_started' })
  assert.equal(launches.length, count)
})
