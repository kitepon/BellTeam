import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createMembersParentChannel, waitMembersChildClose } from '../src/members-ipc.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'

if (process.argv.length !== 2 || process.getuid() !== 0 || Number(process.versions.node.split('.')[0]) !== 26)
  throw new Error('MEMBERS_PROBE_ENVIRONMENT')
const child = spawn('/usr/local/libexec/bellteam-members-start', ['builtin'], {
  uid: 1001, gid: 1001, env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const ended = waitMembersChildClose(child), admission = new MembersAdmission('probe')
let effects = 0, finished = false, timer
const projection = []
const channel = createMembersParentChannel(child, { generation: 'probe', admission,
  onEffect: () => { effects++; throw new Error('MEMBERS_PROBE_EFFECT') },
  onProjection: record => { projection.push(record) },
})
try {
  await Promise.race([(async () => {
    await channel.control('initialize', { generation: 'probe' }, 45000)
    const ready = await channel.ready
    assert.equal(ready.versionId, null); assert.equal(ready.protocolVersion, 1)
    assert.deepEqual(ready.stateCompatibility, MEMBERS_STATE_COMPATIBILITY)
    assert.deepEqual(projection.map(record => record.type), ['snapshot-start', 'snapshot-end'])
    await channel.control('resume')
    await channel.control('quiesce')
    await channel.control('exit')
    assert.deepEqual(await ended, { code: 0, signal: null })
    assert.equal(effects, 0)
    finished = true
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MEMBERS_PROBE_TIMEOUT')), 65000) })])
} catch { process.exitCode = 1 }
finally {
  clearTimeout(timer)
  if (!finished) { child.kill('SIGKILL'); await ended }
  channel.reaped()
}
if (finished) process.stdout.write(JSON.stringify({ schema: 'bellteam.members.runtime-probe.v1', ok: true,
  uid: 1001, protocolVersion: 1, stateCompatibility: MEMBERS_STATE_COMPATIBILITY, childClosed: true }) + '\n')
else process.stderr.write('MEMBERS_PROBE_FAILED\n')
