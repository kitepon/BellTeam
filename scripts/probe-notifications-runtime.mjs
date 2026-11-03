// Runs only in a disposable native root runner prepared by the distribution probe.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createNotificationsParentChannel } from '../src/notifications-ipc.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26)
  throw new Error('NOTIFICATIONS_PROBE_ENVIRONMENT')
const child = spawn('/usr/local/libexec/bellteam-notifications-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
const channel = createNotificationsParentChannel(child)
let timer, finished = false
try {
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NOTIFICATIONS_PROBE_TIMEOUT')), 55000) })
  await Promise.race([(async () => {
    await channel.control('initialize', { configuration: { enabled: false, relayUrl: '' } }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null)
    assert.equal(ready.protocolVersion, 1)
    assert.equal(ready.stateSchema, 1)
    assert.equal(ready.status.configured, false)
    assert.equal(ready.applyError, null)
    await channel.control('resume')
    const status = await channel.request('status', {})
    assert.equal(status.configured, false)
    assert.deepEqual(status.environments, [])
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
if (finished) process.stdout.write('{"schema":"bellteam.notifications.runtime-probe.v1","ok":true,"uid":1001,"protocolVersion":1,"stateSchema":1,"childClosed":true}\n')
else process.stderr.write('NOTIFICATIONS_PROBE_FAILED\n')
