// Separate IPC proof with artificial providers; this is not the fixed-C signed child.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { createNotificationsParentChannel, waitNotificationsChildClose } from '../../src/notifications-ipc.mjs'
import { writeNotificationsWebFixture } from '../fixtures/notifications-web-push-state.mjs'

assert.equal(process.getuid(), 1001)
assert.equal(Number(process.versions.node.split('.')[0]), 26)
const root = await mkdtemp(join(tmpdir(), 'notifications-drain-'))
let child, channel, ended, report, closed = false
try {
  const fixture = await writeNotificationsWebFixture(root)
  const stateFiles = ['push-devices.json', 'web-push-keys.json', 'web-push-subscriptions.json']
  const state = async () => Object.fromEntries(await Promise.all(stateFiles.map(async name => {
    const path = join(root, 'state', name), info = await stat(path)
    assert.equal(info.uid, 1001); assert.equal(info.mode & 0o7777, 0o600)
    return [name, createHash('sha256').update(await readFile(path)).digest('hex')]
  })))
  const before = await state()
  child = spawn(process.execPath, [new URL('../fixtures/notifications-usage-child.mjs', import.meta.url).pathname, 'builtin', root, 'both-providers'],
    { env: {}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  ended = waitNotificationsChildClose(child).then(result => { closed = true; return result })
  channel = createNotificationsParentChannel(child, { onDiagnostic: async report => { throw Error(report.code) } })
  const configuration = structuredClone(fixture.configuration)
  configuration.apns.enabled = configuration.webPush.enabled = true
  await channel.control('initialize', { configuration })
  const ready = await channel.ready
  assert.equal(ready.protocolVersion, 2); assert.equal(ready.stateSchema, 2)
  assert.equal(ready.status.webPush.publicKey, fixture.applicationServerKey)
  await channel.control('resume')
  await channel.request('publish', { type: 'direct', id: 'slow', botId: 'bot-fixture', senderName: 'Fixture' })
  const until = Date.now() + 10000
  for (;;) {
    try {
      const apns = (await readFile(join(root, 'sent.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      const web = (await readFile(join(root, 'web-sent.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      if (apns.length === 1 && web.length === 2) break
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    assert(Date.now() < until, 'artificial providers did not enter'); await delay(10)
  }
  let quiesced = false
  const draining = channel.control('quiesce').then(value => { quiesced = true; return value })
  await assert.rejects(channel.request('status', { provider: 'apns' }), { outcome: 'not_accepted' })
  await writeFile(join(root, 'release'), '')
  await delay(30)
  assert.equal(quiesced, false); assert.equal(closed, false)
  await writeFile(join(root, 'web-release'), '')
  assert.deepEqual(await draining, { quiesced: true })
  assert.deepEqual(await state(), before)
  await channel.control('exit')
  assert.deepEqual(await ended, { code: 0, signal: null })
  report = { accepted: true, uid: process.getuid(), protocolVersion: 2, stateSchema: 2,
    realIpc: true, actualImageDispatcher: true, syntheticProviders: true, signedCChild: false,
    apnsAccepted: 1, webAccepted: 2, quiesceWaitedForWebRelease: true, stateSha256: before, osExit: 0 }
} finally {
  await writeFile(join(root, 'release'), ''); await writeFile(join(root, 'web-release'), '')
  if (child && !closed) child.kill('SIGKILL')
  if (ended) await ended
  channel?.dispose()
  await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ ...report, temporaryRootRemoved: true }))
