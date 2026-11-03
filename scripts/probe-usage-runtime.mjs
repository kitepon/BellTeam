import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createUsageParentChannel } from '../src/usage/channel.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { waitNotificationsChildClose } from '../src/notifications-ipc.mjs'
import { USAGE_STATE_COMPATIBILITY } from '../src/usage/state-compatibility.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26) throw new Error('USAGE_PROBE_ENVIRONMENT')
const child = spawn('/usr/local/libexec/bellteam-usage-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const ended = waitNotificationsChildClose(child), generation = 'usage-probe', admission = new MembersAdmission(generation)
let finished = false, timer, metadataReads = 0
const channel = createUsageParentChannel(child, { generation, admission,
  authorizeActor: () => { throw new Error('USAGE_PROBE_AUTHORITY') },
  onEffect: method => { if (method !== 'members.read') throw new Error('USAGE_PROBE_EFFECT'); metadataReads++; return [] },
})
try {
  await Promise.race([(async () => {
    const bootstrap = { environment: {}, seatRuntime: true, subscription: {} }
    await channel.control('initialize', { generation, mode: 'settings', bootstrap, restore: false }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null); assert.equal(ready.protocolVersion, 1); assert.deepEqual(ready.stateCompatibility, USAGE_STATE_COMPATIBILITY)
    await channel.control('initialize', { generation, mode: 'subscriptions' })
    await channel.control('initialize', { generation, mode: 'services' })
    await channel.control('quiesce'); const exported = await channel.control('export')
    assert.equal(exported.handoff.schema, 'bellteam.usage-volatile.v1')
    await channel.control('resume'); await channel.control('quiesce'); await channel.control('exit')
    assert.deepEqual(await ended, { code: 0, signal: null }); assert.equal(metadataReads, 1); finished = true
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('USAGE_PROBE_TIMEOUT')), 65000) })])
} catch { process.exitCode = 1 }
finally { clearTimeout(timer); if (!finished) { child.kill('SIGKILL'); await ended }; channel.reaped() }
if (finished) process.stdout.write(JSON.stringify({ schema: 'bellteam.usage.runtime-probe.v1', ok: true, uid: 1001, protocolVersion: 1,
  stateCompatibility: USAGE_STATE_COMPATIBILITY, childClosed: true, nativeAuth: false, externalEffects: 0 }) + '\n')
else process.stderr.write('USAGE_PROBE_FAILED\n')
