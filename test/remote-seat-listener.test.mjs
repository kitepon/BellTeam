import { createSyntheticNotificationsProcess } from './helpers/notifications-process.mjs'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createRemoteSeatListener, remoteSeatPort } from '../src/remote-seat-port.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))

test('remote seat port: its own default, not the diagnostics admin port 4182', () => {
  assert.equal(remoteSeatPort({}), 4183)
  assert.equal(remoteSeatPort({ BELLTEAM_REMOTE_SEAT_PORT: '5001' }), 5001)
})

test('remote seat listener: a taken port fails visibly while it lasts, then the next ensure binds it', { timeout: 10000 }, async t => {
  const blocker = createServer()
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening')
  const port = blocker.address().port
  const root = await mkdtemp(join(tmpdir(), 'bellteam-remote-seat-listener-'))
  await mkdir(join(root, 'logs'), { recursive: true })
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  const runtime = await createApplicationRuntime({ root, appRoot, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0', BELLTEAM_REMOTE_SEAT_PORT: String(port) },
    bootstrap: { createNotificationsProcess: createSyntheticNotificationsProcess, bots, settings, ownerProfile, userRules,
      aiterm: { command: 'synthetic-aiterm', args: ['/synthetic/native.js'] }, refreshGlobalInstructions: async () => {} },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }], _meta: { 'aiterm/seat_turns': { schema: 'aiterm.seat-turns.v1', seats: [] } } } }, async close() {} },
  })
  t.after(async () => { await runtime.close(); blocker.listening && blocker.close(); await rm(root, { recursive: true, force: true }) })
  await runtime.start()
  assert.equal(runtime.server.listening, true)
  assert.equal(runtime.remoteSeatServer.listening, false)
  await assert.rejects(runtime.services.remoteSeatListener.ensure(), { code: 'REMOTE_SEAT_INGRESS_UNAVAILABLE', status: 503 })
  blocker.close(); await once(blocker, 'close')
  await runtime.services.remoteSeatListener.ensure()
  assert.equal(runtime.remoteSeatServer.listening, true)
  await runtime.services.remoteSeatListener.ensure()
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404)
})

test('remote seat listener: a refused launch stays not started, and the first good bind republishes its terminal', async () => {
  let up = false, binds = 0
  const listener = createRemoteSeatListener({ retryMs: 5, now: () => 'T' })
  listener.bind(async () => { binds += 1; if (!up) throw Object.assign(new Error('REMOTE_SEAT_INGRESS_UNAVAILABLE'), { code: 'REMOTE_SEAT_INGRESS_UNAVAILABLE' }) })
  const events = []
  listener.watch(event => events.push(event))
  await assert.rejects(listener.ensureFor('term-1'), { code: 'SEAT_FORWARD_UNAVAILABLE', effect: 'not_started', status: 503 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(binds >= 2) // the non-AI retry keeps trying while the terminal waits
  assert.deepEqual(events, [])
  up = true
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(events, [{ terminalId: 'term-1', reachable: true, observedAt: 'T' }])
  const settled = binds
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(binds, settled) // nothing waits, so no more retries
  listener.close()
})
