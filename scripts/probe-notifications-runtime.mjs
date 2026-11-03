// Runs only in a disposable native root runner prepared by the distribution probe.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createNotificationsParentChannel, waitNotificationsChildClose } from '../src/notifications-ipc.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26)
  throw new Error('NOTIFICATIONS_PROBE_ENVIRONMENT')
const child = spawn('/usr/local/libexec/bellteam-notifications-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const ended = waitNotificationsChildClose(child)
const channel = createNotificationsParentChannel(child)
let timer, finished = false
try {
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NOTIFICATIONS_PROBE_TIMEOUT')), 55000) })
  await Promise.race([(async () => {
    await channel.control('initialize', { configuration: { apns: { enabled: false, relayUrl: '' }, webPush: { enabled: false, subject: '' } } }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null)
    assert.equal(ready.protocolVersion, 2)
    assert.equal(ready.stateSchema, 2)
    assert.equal(ready.status.apns.configured, false)
    assert.deepEqual(ready.applyError, { apns: null, webPush: null })
    assert.equal(ready.status.webPush.enabled, false)
    assert.equal(ready.status.webPush.publicKey, null)
    await channel.control('resume')
    const status = await channel.request('status', { provider: 'apns' })
    assert.equal(status.configured, false)
    assert.deepEqual(status.environments, [])
    const web = await channel.request('status', { provider: 'webPush' })
    assert.deepEqual(web, { enabled: false, configured: false, publicKey: null, error: null })
    await channel.control('quiesce')
    await channel.control('exit')
    assert.deepEqual(await ended, { code: 0, signal: null })
    finished = true
  })(), deadline])
} catch {
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (!finished) { child.kill('SIGKILL'); await ended }
  channel.dispose()
}
if (finished) process.stdout.write('{"schema":"bellteam.notifications.runtime-probe.v1","ok":true,"uid":1001,"protocolVersion":2,"stateSchema":2,"childClosed":true}\n')
else process.stderr.write('NOTIFICATIONS_PROBE_FAILED\n')
