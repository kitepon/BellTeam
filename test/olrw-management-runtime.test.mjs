import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { OwnerQuestions } from '../src/owner-questions.mjs'

test('通常カードの先回答があっても実runtimeの公開/内部受付は起動し認証consumerは生成しない', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'olrw-preanswered-runtime-'))
  const questions = new OwnerQuestions({ root, bots: new Map([['synthetic', { name: 'synthetic' }]]), notify: async () => {} })
  await questions.initialize()
  const item = await questions.create({ botId: 'synthetic', question: 'synthetic start?', options: ['yes', 'no'], allowOther: false })
  await questions.answer(item.id, { choice: 'yes' })
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const nativeCalls = []
  let clientCloses = 0
  const runtime = await createApplicationRuntime({ root, appRoot: fileURLToPath(new URL('../', import.meta.url)), home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, refreshGlobalInstructions: async () => {},
      aiterm: { command: 'synthetic-aiterm', args: [] },
      olrwManagement: { plan: { questionId: item.id, requesterBotId: 'synthetic', question: item.question, options: item.options, answer: 'yes' },
        assertAuthorized: () => assert.fail('preanswered must not read authorization'),
        createConsumer: () => assert.fail('preanswered must not construct consumer') } },
    client: { async call(name) { nativeCalls.push(name); return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientCloses++ } },
  })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  assert.equal(runtime.services.olrwAuthCaller.status, 'already_answered')
  await runtime.start()
  if (!runtime.internalServer.listening) await once(runtime.internalServer, 'listening')
  assert.equal(runtime.internalServer.listening, true)
  const publicResponse = await fetch(`http://127.0.0.1:${runtime.gateway.address.port}/healthz`)
  assert.equal(publicResponse.status, 200)
  assert.ok(nativeCalls.every(name => name === 'pty_list'), JSON.stringify(nativeCalls))
  await runtime.close()
  assert.equal(clientCloses, 1)
})
